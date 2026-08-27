import * as mc from "../../utils/mcdata.js";
import * as world from "./world.js";
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import settings from "../../../settings.js";
import { isDeepWater, swimToward } from '../../agent/SwimController.js';

const blockPlaceDelay = settings.block_place_delay == null ? 0 : settings.block_place_delay;
const useDelay = blockPlaceDelay > 0;

// Families of interchangeable items (any member can substitute for another)
const INTERCHANGEABLE = {
    planks: n => !!n && n.endsWith('_planks'),
    log: n => !!n && (n === 'log' || n.endsWith('_log')),
};

/**
 * Raw sprint-jump movement: bypass pathfinder entirely.
 * Faces target, holds sprint+forward+jump, monitors position.
 * Works through water, down cliffs, across terrain — the pathfinder can't.
 * @param {MinecraftBot} bot
 * @param {Vec3|{x,y,z}} target
 * @param {number} closeEnough - distance to consider arrived (default 2)
 * @param {number} timeoutMs - max time (default 15000)
 * @returns {Promise<boolean>} true if reached
 */
export async function sprintJumpToward(bot, target, closeEnough = 2, timeoutMs = 15000) {
    const start = Date.now();
    let lastDist = Infinity;
    let stuckTime = 0;
    let lastPos = bot.entity.position.clone();

    // Face target
    const dx = target.x - bot.entity.position.x;
    const dz = target.z - bot.entity.position.z;
    const yaw = Math.atan2(-dx, -dz);
    bot.look(yaw, 0, false);

    bot.setControlState('sprint', true);
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);

    try {
        while (Date.now() - start < timeoutMs) {
            await new Promise(r => setTimeout(r, 100));
            const pos = bot.entity.position;
            const dist = pos.distanceTo(new Vec3(target.x, target.y ?? pos.y, target.z));

            if (dist <= closeEnough) {
                return true;
            }

            // Re-face target periodically
            const ddx = target.x - pos.x;
            const ddz = target.z - pos.z;
            const yaw2 = Math.atan2(-ddx, -ddz);
            bot.look(yaw2, 0, false);

            // Stuck detection
            if (pos.distanceTo(lastPos) < 0.15) {
                stuckTime += 100;
                if (stuckTime > 2000) {
                    // Try jumping over obstacle
                    bot.setControlState('jump', true);
                    await new Promise(r => setTimeout(r, 400));
                    bot.setControlState('jump', true);
                    stuckTime = 0;
                }
            } else {
                stuckTime = 0;
            }
            lastPos = pos.clone();

            // Y-level adjustment: if target is much higher, jump more
            if (target.y != null && target.y > pos.y + 1.5) {
                bot.setControlState('jump', true);
            }
        }
        return false; // timeout
    } finally {
        bot.setControlState('sprint', false);
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
    }
}

/**
 * Patches a recipe object so its ingredient IDs match items the bot actually has.
 * Mineflayer's bot.recipesAll() may return a recipe requiring e.g. cherry_planks,
 * but the bot only has oak_planks. This rewrites the recipe's inShape ingredient
 * IDs so bot.craft() can find matching items.
 */
function patchRecipeForInventory(recipe, inventory, registry, bot = null) {
    // Build a map: family → item name that's in inventory
    const haveByFamily = {};
    for (const [name, count] of Object.entries(inventory)) {
        if (count <= 0) continue;
        for (const [family, test] of Object.entries(INTERCHANGEABLE)) {
            if (test(name)) {
                if (!haveByFamily[family]) haveByFamily[family] = name;
            }
        }
    }

    // Check if recipe has ingredients we need to patch
    const shape = recipe.inShape;
    if (!shape) return recipe;

    // Find which families need patching
    let needsPatch = false;
    for (const row of shape) {
        for (const slot of row) {
            if (!slot || slot.id < 0) continue;
            const name = registry.items[slot.id]?.name;
            if (!name) continue;
            for (const [family, test] of Object.entries(INTERCHANGEABLE)) {
                if (test(name) && haveByFamily[family] && haveByFamily[family] !== name) {
                    needsPatch = true;
                }
            }
        }
    }

    if (!needsPatch) return recipe;

    // Create a patched copy of the recipe
    const patched = Object.assign({}, recipe);
    patched.inShape = shape.map(row => row.map(slot => {
        if (!slot || slot.id < 0) return slot;
        const name = registry.items[slot.id]?.name;
        if (!name) return slot;
        for (const [family, test] of Object.entries(INTERCHANGEABLE)) {
            if (test(name) && haveByFamily[family] && haveByFamily[family] !== name) {
                const newId = registry.itemsByName[haveByFamily[family]]?.id;
                if (newId != null) {
                    if (bot) log(bot, `[craftRecipe] Patching recipe: ${name} → ${haveByFamily[family]}`);
                    return Object.assign({}, slot, { id: newId });
                }
            }
        }
        return slot;
    }));
    // Also patch shapeless ingredients field
    if (patched.ingredients && Array.isArray(patched.ingredients)) {
        patched.ingredients = patched.ingredients.map(slot => {
            if (!slot || slot.id < 0) return slot;
            const name = registry.items[slot.id]?.name;
            if (!name) return slot;
            for (const [family, test] of Object.entries(INTERCHANGEABLE)) {
                if (test(name) && haveByFamily[family] && haveByFamily[family] !== name) {
                    const newId = registry.itemsByName[haveByFamily[family]]?.id;
                    if (newId != null) {
                        return Object.assign({}, slot, { id: newId });
                    }
                }
            }
            return slot;
        });
    }
    return patched;
}

function pos(bot) {
    const p = bot.entity.position;
    if (!p || typeof p.floored === 'function') return p;
    return new Vec3(p.x, p.y, p.z);
}

export function log(bot, message) {
    bot.output += message + '\n';
}

// Vanilla drops ≠ the block mined (iron_ore→raw_iron, stone→cobblestone,
// grass_block→dirt), so progress must be measured across drop keys too.
const _dropKeysCache = new Map();
export function collectProgressCount(bot, blockType) {
    const inv = world.getInventoryCounts(bot);
    let keys = _dropKeysCache.get(blockType);
    if (!keys) {
        keys = [blockType];
        try {
            const reg = bot.registry;
            const b = reg?.blocksByName?.[blockType];
            const dropIds = Array.isArray(b?.drops) && b.drops.length ? b.drops : (b?.drop != null ? [b.drop] : []);
            for (const id of dropIds) {
                const nm = reg?.items?.[id]?.name;
                if (nm && !keys.includes(nm)) keys.push(nm);
            }
        } catch (_) { /* fall back to exact-key counting */ }
        _dropKeysCache.set(blockType, keys);
    }
    let total = 0;
    for (const k of keys) total += inv[k] || 0;
    return total;
}

// mineflayer-tool isn't installed (bot.tool is undefined), so equipping used
// to throw and get swallowed — she dug wood barehanded / with a pickaxe.
// This is the deterministic replacement: material → tool kind → best tier.
const TOOL_TIER_RANK = { wooden: 1, golden: 2, stone: 3, iron: 4, diamond: 5, netherite: 6 };

export function bestToolInInventory(bot, kind) {
    let best = null, bestRank = 0;
    for (const item of bot.inventory?.items() ?? []) {
        if (!item.name.endsWith(kind)) continue;
        const tier = Object.keys(TOOL_TIER_RANK).find(t => item.name.startsWith(t + '_'));
        const rank = tier ? TOOL_TIER_RANK[tier] : 0;
        if (rank > bestRank) { best = item; bestRank = rank; }
    }
    return best;
}

/**
 * Equip the best inventory tool for breaking `block`. No-op (returns false)
 * when the block needs no tool kind or we own none — hand still works, just
 * slower, and `canHarvest` gates the truly unbreakable cases.
 */
export async function equipBestToolFor(bot, block) {
    try {
        if (!block) return false;
        const material = String(block.material || '');
        // Order matters: 'pickaxe' contains 'axe'.
        let kind = null;
        if (material.includes('pickaxe')) kind = 'pickaxe';
        else if (material.includes('shovel') || material.includes('spade')) kind = 'shovel';
        else if (material.includes('hoe')) kind = 'hoe';
        else if (material.includes('sword')) kind = 'sword';
        else if (material.includes('axe')) kind = 'axe';
        if (!kind) return false;
        const best = bestToolInInventory(bot, kind);
        if (!best) return false;
        if (bot.heldItem?.type === best.type) return true; // already equipped
        await bot.equip(best, 'hand');
        return true;
    } catch (_) {
        return false; // never let tool selection break a dig
    }
}

/**
 * Central Movements factory — every navigation call site should use this.
 *
 * WHY: mineflayer-pathfinder's default liquidCost is 1, meaning water is
 * exactly as cheap as land. Long paths therefore route straight through
 * lakes — the bot kept swimming everywhere and nearly drowning. Raising
 * liquidCost makes water crossings a last resort, not the default route.
 */
export function safeMovements(bot, { destructive = false } = {}) {
    const m = new pf.Movements(bot);
    m.liquidCost = 15;          // strongly prefer land routes over swimming
    m.digCost = destructive ? 1 : 10;
    m.placeCost = destructive ? 1 : 2;
    m.allowSprinting = true;
    m.allowParkour = true;
    m.canSwim = true;           // can still swim when truly required
    try {
        if (!destructive) {
            for (const block of ['glass', 'glass_pane']) {
                const id = mc.getBlockId(block);
                if (id != null) m.blocksCantBreak.add(id);
            }
        }
        m.dontCreateFlow = true;
        m.dontMineUnderFallingBlock = true;
    } catch (_) {}
    return m;
}

async function autoLight(bot) {
    if (world.shouldPlaceTorch(bot)) {
        try {
            const pos = world.getPosition(bot);
            return await placeBlock(bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
        } catch (err) {
            console.warn('[AutoLight]', err.message);
            return false;
        }
    }
    return false;
}

export async function equipHighestAttack(bot) {
    let weapons = bot.inventory.items().filter(item => item.name.includes('sword') || (item.name.includes('axe') && !item.name.includes('pickaxe')));
    if (weapons.length === 0)
        weapons = bot.inventory.items().filter(item => item.name.includes('pickaxe') || item.name.includes('shovel'));
    if (weapons.length === 0)
        return;
    weapons.sort((a, b) => b.attackDamage - a.attackDamage);
    let weapon = weapons[0];
    if (weapon)
        await bot.equip(weapon, 'hand');
}

export async function equipShield(bot) {
    let shield = bot.inventory.findInventoryItem('shield');
    if (shield) {
        await bot.equip(shield, 'off-hand');
    }
}

export async function eatBestFood(bot) {
    // Prefer safe foods; fall back to risky foods ONLY when starving (dying is worse than poison).
    // rotten_flesh counts as risky (80% hunger debuff) — never eaten while healthy.
    const RISKY_FOODS = ['spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'rotten_flesh'];
    const starving = (bot.food ?? 20) <= 6 || (bot.health ?? 20) <= 8;
    const allFoods = bot.inventory.items().filter(i => i.foodPoints > 0)
        .sort((a, b) => b.foodPoints - a.foodPoints);
    let foods = starving
        ? allFoods                                  // emergency: anything edible wins
        : allFoods.filter(i => !RISKY_FOODS.includes(i.name));
    if (foods.length === 0 && starving) {
        log(bot, `Emergency: eating ${foods[0]?.name || allFoods[0]?.name} (no safe food left).`);
    }
    if (foods.length === 0) return false;
    await bot.equip(foods[0], 'hand');
    await bot.consume();
    return true;
}

export async function sprint(bot, sprinting) {
    bot.setControlState('sprint', sprinting);
}

export async function strafeAround(bot, target, durationMs=2000) {
    const start = Date.now();
    let dir = 1;
    while (Date.now() - start < durationMs) {
        if (!target || !target.isValid || target.health <= 0) break;
        bot.setControlState('left', dir === 1);
        bot.setControlState('right', dir === 0);
        bot.setControlState('forward', true);
        if (bot.entity.position.distanceTo(target.position) > 3) {
            bot.setControlState('sprint', true);
        }
        if (bot.entity.position.distanceTo(target.position) < 2) {
            bot.setControlState('forward', false);
            bot.setControlState('back', true);
        }
        dir = 1 - dir;
        await new Promise(r => setTimeout(r, 300));
        if (bot.interrupt_code) break;
    }
    bot.setControlState('left', false);
    bot.setControlState('right', false);
    bot.setControlState('forward', false);
    bot.setControlState('back', false);
}

export async function fightPlayer(bot, target) {
    const { CombatEngine } = await import('../../brain/CombatEngine.js');
    const engine = new CombatEngine(bot);
    await equipHighestAttack(bot);
    await equipShield(bot);

    while (target && target.isValid && target.health > 0 && target.position) {
        if (bot.interrupt_code) { engine.stop(); return; }
        const dist = bot.entity.position.distanceTo(target.position);
        if (dist > 5) {
            const goal = new pf.goals.GoalFollow(target, 3);
            try { await goToGoal(bot, goal); } catch (e) { console.warn('[FightPlayer] path error:', e.message); }
            continue;
        }
        if (dist <= 5) {
            // Use expert combat engine for fighting
            const killed = await engine.expertFight(target, { maxDurationMs: 5000, fleeHealth: 8 });
            if (!killed && bot.health < 8) {
                // Retreat and heal
                engine.stop();
                await sprint(bot, false);
                try {
                    const retreat = new pf.goals.GoalInvert(new pf.goals.GoalFollow(target, 8));
                    await goToGoal(bot, retreat);
                } catch(e) { console.warn('[FightPlayer] retreat error:', e.message); }
                if (bot.food < 18) await eatBestFood(bot);
                await equipHighestAttack(bot);
                await equipShield(bot);
            }
        }
    }
    engine.stop();
    log(bot, `Finished fighting ${target?.name || 'target'}.`);
}

export async function craftRecipe(bot, itemName, num=1) {
    /**
     * Attempt to craft the given item name from a recipe. May craft many items.
     * Uses recipesAll to support wood variant planks (dark_oak_planks, acacia_planks, etc.)
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to craft.
     * @returns {Promise<boolean>} true if the recipe was crafted, false otherwise.
     * @example
     * await skills.craftRecipe(bot, "stick");
     **/
    let placedTable = false;

    if (mc.getItemCraftingRecipes(itemName).length == 0) {
        log(bot, `${itemName} is either not an item, or it does not have a crafting recipe!`);
        return false;
    }

    const itemId = mc.getItemId(itemName);
    const inventory = world.getInventoryCounts(bot);

    // Use recipesAll to get ALL recipe variants (handles wood plank variants)
    // Then filter to recipes we actually have ingredients for
    const allRecipesNoTable = bot.recipesAll(itemId, null, null);
    const allRecipesWithTable = bot.recipesAll(itemId, null, true);

    // Filter recipes by what we can actually craft with current inventory
    // Uses calculateCraftLimit so plank/log variants are interchangeable
    const canCraft = (recipes) => {
        return recipes.filter(recipe => {
            const ingredients = mc.ingredientsFromPrismarineRecipe(recipe);
            return mc.calculateCraftLimit(inventory, ingredients).num > 0;
        });
    };

    let recipes = canCraft(allRecipesNoTable);
    let craftingTable = null;
    const craftingTableRange = 16;

    placeTable: if (!recipes || recipes.length === 0) {
        recipes = canCraft(allRecipesWithTable);
        if (!recipes || recipes.length === 0) break placeTable;

        // Look for crafting table
        craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
        if (craftingTable === null) {
            // Try to place crafting table
            let hasTable = inventory['crafting_table'] > 0;
            if (hasTable) {
                let pos = world.getNearestFreeSpace(bot, 1, 6);
                await placeBlock(bot, 'crafting_table', pos.x, pos.y, pos.z);
                craftingTable = world.getNearestBlock(bot, 'crafting_table', craftingTableRange);
                if (craftingTable) {
                    recipes = canCraft(bot.recipesAll(itemId, null, craftingTable));
                    placedTable = true;
                }
            } else {
                log(bot, `Crafting ${itemName} requires a crafting table.`);
                return false;
            }
        } else {
            recipes = canCraft(bot.recipesAll(itemId, null, craftingTable));
        }
    }
    if (!recipes || recipes.length === 0) {
        log(bot, `You do not have the resources to craft a ${itemName}. It requires: ${Object.entries(mc.getItemCraftingRecipes(itemName)[0][0]).map(([key, value]) => `${key}: ${value}`).join(', ')}.`);
        if (placedTable) {
            await collectBlock(bot, 'crafting_table', 1);
        }
        return false;
    }
    
    if (craftingTable && bot.entity.position.distanceTo(craftingTable.position) > 4) {
        await goToNearestBlock(bot, 'crafting_table', 4, craftingTableRange);
    }

    const recipe = recipes[0];
    //Check that the agent has sufficient items to use the recipe `num` times.
    const requiredIngredients = mc.ingredientsFromPrismarineRecipe(recipe); //Items required to use the recipe once.
    const craftLimit = mc.calculateCraftLimit(inventory, requiredIngredients);

    // Try each recipe variant until one works
    let lastError = null;
    for (let attempt = 0; attempt < recipes.length; attempt++) {
        const tryRecipe = recipes[attempt];
            const patchedRecipe = patchRecipeForInventory(tryRecipe, inventory, bot.registry, bot);
        try {
            await bot.craft(patchedRecipe, Math.min(craftLimit.num, num), craftingTable);
            if(craftLimit.num<num) log(bot, `Not enough ${craftLimit.limitingResource} to craft ${num}, crafted ${craftLimit.num}. You now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
            else log(bot, `Successfully crafted ${itemName}, you now have ${world.getInventoryCounts(bot)[itemName]} ${itemName}.`);
            if (placedTable) { await collectBlock(bot, 'crafting_table', 1); }
            bot.armorManager.equipAll();
            return true;
        } catch (e) {
            lastError = e;
            log(bot, `[craftRecipe] Recipe attempt ${attempt + 1}/${recipes.length} failed: ${e.message}`);
            continue;
        }
    }
    // All recipes failed
    log(bot, `Failed to craft ${itemName}: ${lastError?.message || 'unknown error'}`);
    if (placedTable) { await collectBlock(bot, 'crafting_table', 1); }
    return false;
}

export async function wait(bot, milliseconds) {
    /**
     * Waits for the given number of milliseconds.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} milliseconds, the number of milliseconds to wait.
     * @returns {Promise<boolean>} true if the wait was successful, false otherwise.
     * @example
     * await skills.wait(bot, 1000);
     **/
    // setTimeout is disabled to prevent unawaited code, so this is a safe alternative that enables interrupts
    let timeLeft = milliseconds;
    let startTime = Date.now();
    
    while (timeLeft > 0) {
        if (bot.interrupt_code) return false;
        
        let waitTime = Math.min(2000, timeLeft);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        let elapsed = Date.now() - startTime;
        timeLeft = milliseconds - elapsed;
    }
    return true;
}

export async function smeltItem(bot, itemName, num=1) {
    /**
     * Puts 1 coal in furnace and smelts the given item name, waits until the furnace runs out of fuel or input items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item name to smelt. Ores must contain "raw" like raw_iron.
     * @param {number} num, the number of items to smelt. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was smelted, false otherwise. Fail
     * @example
     * await skills.smeltItem(bot, "raw_iron");
     * await skills.smeltItem(bot, "beef");
     **/

    if (!mc.isSmeltable(itemName)) {
        log(bot, `Cannot smelt ${itemName}. Hint: make sure you are smelting the 'raw' item.`);
        return false;
    }

    let placedFurnace = false;
    let furnaceBlock = undefined;
    const furnaceRange = 16;
    furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
    if (!furnaceBlock){
        // Try to place furnace
        let hasFurnace = world.getInventoryCounts(bot)['furnace'] > 0;
        if (hasFurnace) {
            let pos = world.getNearestFreeSpace(bot, 1, furnaceRange);
            await placeBlock(bot, 'furnace', pos.x, pos.y, pos.z);
            furnaceBlock = world.getNearestBlock(bot, 'furnace', furnaceRange);
            placedFurnace = true;
        }
    }
    if (!furnaceBlock){
        log(bot, `There is no furnace nearby and you have no furnace.`)
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, furnaceRange);
    }
    bot.modes.pause('unstuck');
    await bot.lookAt(furnaceBlock.position);

    log(bot, 'Smelting...');
    const furnace = await bot.openFurnace(furnaceBlock);
    // check if the furnace is already smelting something
    let input_item = furnace.inputItem();
    if (input_item && input_item.type !== mc.getItemId(itemName) && input_item.count > 0) {
        log(bot, `The furnace is currently smelting ${mc.getItemName(input_item.type)}.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }
    // check if the bot has enough items to smelt
    let inv_counts = world.getInventoryCounts(bot);
    if (!inv_counts[itemName] || inv_counts[itemName] < num) {
        log(bot, `You do not have enough ${itemName} to smelt.`);
        if (placedFurnace)
            await collectBlock(bot, 'furnace', 1);
        return false;
    }

    // fuel the furnace
    if (!furnace.fuelItem()) {
        let fuel = mc.getSmeltingFuel(bot);
        if (!fuel) {
            log(bot, `You have no fuel to smelt ${itemName}, you need coal, charcoal, or wood.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        log(bot, `Using ${fuel.name} as fuel.`);

        const put_fuel = Math.ceil(num / mc.getFuelSmeltOutput(fuel.name));

        if (fuel.count < put_fuel) {
            log(bot, `You don't have enough ${fuel.name} to smelt ${num} ${itemName}; you need ${put_fuel}.`);
            if (placedFurnace)
                await collectBlock(bot, 'furnace', 1);
            return false;
        }
        await furnace.putFuel(fuel.type, null, put_fuel);
        log(bot, `Added ${put_fuel} ${mc.getItemName(fuel.type)} to furnace fuel.`);
    }
    // put the items in the furnace
    await furnace.putInput(mc.getItemId(itemName), null, num);
    // wait for the items to smelt
    let total = 0;
    let smelted_item = null;
    await new Promise(resolve => setTimeout(resolve, 200));
    let last_collected = Date.now();
    while (total < num) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (furnace.outputItem()) {
            smelted_item = await furnace.takeOutput();
            if (smelted_item) {
                total += smelted_item.count;
                last_collected = Date.now();
            }
        }
        if (Date.now() - last_collected > 11000) {
            break; // if nothing has been collected in 11 seconds, stop
        }
        if (bot.interrupt_code) {
            break;
        }
    }
    // take all remaining in input/fuel slots
    if (furnace.inputItem()) {
        await furnace.takeInput();
    }
    if (furnace.fuelItem()) {
        await furnace.takeFuel();
    }

    await bot.closeWindow(furnace);

    if (placedFurnace) {
        await collectBlock(bot, 'furnace', 1);
    }
    if (total === 0) {
        log(bot, `Failed to smelt ${itemName}.`);
        return false;
    }
    if (total < num) {
        log(bot, `Only smelted ${total} ${mc.getItemName(smelted_item.type)}.`);
        return false;
    }
    log(bot, `Successfully smelted ${itemName}, got ${total} ${mc.getItemName(smelted_item.type)}.`);
    return true;
}

export async function clearNearestFurnace(bot) {
    /**
     * Clears the nearest furnace of all items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the furnace was cleared, false otherwise.
     * @example
     * await skills.clearNearestFurnace(bot);
     **/
    let furnaceBlock = world.getNearestBlock(bot, 'furnace', 32);
    if (!furnaceBlock) {
        log(bot, `No furnace nearby to clear.`);
        return false;
    }
    if (bot.entity.position.distanceTo(furnaceBlock.position) > 4) {
        await goToNearestBlock(bot, 'furnace', 4, 32);
    }

    log(bot, 'Clearing furnace...');
    const furnace = await bot.openFurnace(furnaceBlock);
    // take the items out of the furnace
    let smelted_item, input_item, fuel_item;
    if (furnace.outputItem())
        smelted_item = await furnace.takeOutput();
    if (furnace.inputItem())
        input_item = await furnace.takeInput();
    if (furnace.fuelItem())
        fuel_item = await furnace.takeFuel();
    let smelted_name = smelted_item ? `${smelted_item.count} ${smelted_item.name}` : `0 smelted items`;
    let input_name = input_item ? `${input_item.count} ${input_item.name}` : `0 input items`;
    let fuel_name = fuel_item ? `${fuel_item.count} ${fuel_item.name}` : `0 fuel items`;
    log(bot, `Cleared furnace, received ${smelted_name}, ${input_name}, and ${fuel_name}.`);
    return true;

}


export async function attackNearest(bot, mobType, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} mobType, the type of mob to attack.
     * @param {boolean} kill, whether or not to continue attacking until the mob is dead. Defaults to true.
     * @returns {Promise<boolean>} true if the mob was attacked, false if the mob type was not found.
     * @example
     * await skills.attackNearest(bot, "zombie", true);
     **/
    bot.modes.pause('cowardice');
    if (mobType === 'drowned' || mobType === 'cod' || mobType === 'salmon' || mobType === 'tropical_fish' || mobType === 'squid')
        bot.modes.pause('self_preservation'); // so it can go underwater. TODO: have an drowning mode so we don't turn off all self_preservation
    const mob = world.getNearbyEntities(bot, 24).find(entity => entity.name === mobType);
    if (mob) {
        return await attackEntity(bot, mob, kill);
    }
    log(bot, 'Could not find any '+mobType+' to attack.');
    return false;
}

export async function attackEntity(bot, entity, kill=true) {
    /**
     * Attack mob of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to attack.
     * @returns {Promise<boolean>} true if the entity was attacked, false if interrupted
     * @example
     * await skills.attackEntity(bot, entity);
     **/

    let pos = entity.position;
    await equipHighestAttack(bot)

    if (!kill) {
        if (bot.entity.position.distanceTo(pos) > 5) {
            await goToPosition(bot, pos.x, pos.y, pos.z);
        }
        await bot.attack(entity);
    }
    else {
        bot.pvp.attack(entity);
        while (world.getNearbyEntities(bot, 24).includes(entity)) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (bot.interrupt_code) {
                bot.pvp.stop();
                return false;
            }
        }
        log(bot, `Successfully killed ${entity.name}.`);
        await pickupNearbyItems(bot);
        return true;
    }
}

export async function defendSelf(bot, range=9) {
    /**
     * Defend yourself from all nearby hostile mobs using expert combat techniques.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} range, the range to look for mobs. Defaults to 9.
     * @returns {Promise<boolean>} true if the bot found any enemies and has killed them, false if no entities were found.
     **/
    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let attacked = false;

    const { CombatEngine } = await import('../../brain/CombatEngine.js');
    const engine = new CombatEngine(bot);

    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
    while (enemy) {
        await equipHighestAttack(bot);
        await equipShield(bot);

        const dist = bot.entity.position.distanceTo(enemy.position);

        // Too far — chase
        if (dist > 4 && enemy.name !== 'creeper' && enemy.name !== 'phantom') {
            try {
                const movements = safeMovements(bot, { destructive: true });
                bot.pathfinder.setMovements(movements);
                await bot.pathfinder.goto(new pf.goals.GoalFollow(enemy, 3.5), true);
            } catch (err) { console.warn(`[defendSelf] chase: ${err.message}`); }
        }

        // In range — use expert combat engine
        if (bot.entity.position.distanceTo(enemy.position) <= 5) {
            const killed = await engine.expertFight(enemy, { maxDurationMs: 10000, fleeHealth: 6 });
            if (!killed && (bot.health ?? 20) <= 8) {
                // Too low — flee
                await engine.flee(enemy, 2500);
                if (bot.food < 18) await eatBestFood(bot);
                await equipHighestAttack(bot);
                await equipShield(bot);
            }
            attacked = true;
        }

        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), range);
        if (bot.interrupt_code) {
            engine.stop();
            return false;
        }
    }
    engine.stop();
    if (attacked)
        log(bot, `Successfully defended self.`);
    else
        log(bot, `No enemies nearby to defend self from.`);
    return attacked;
}



export async function collectBlock(bot, blockType, num=1, exclude=null) {
    /**
     * Collect one of the given block type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to collect.
     * @param {number} num, the number of blocks to collect. Defaults to 1.
     * @param {list} exclude, a list of positions to exclude from the search. Defaults to null.
     * @returns {Promise<boolean>} true if the block was collected, false if the block type was not found.
     * @example
     * await skills.collectBlock(bot, "oak_log");
     **/
    if (num < 1) {
        log(bot, `Invalid number of blocks to collect: ${num}.`);
        return false;
    }
    let blocktypes = [blockType];
    if (blockType === 'coal' || blockType === 'diamond' || blockType === 'emerald' || blockType === 'iron' || blockType === 'gold' || blockType === 'lapis_lazuli' || blockType === 'redstone')
        blocktypes.push(blockType+'_ore');
    if (blockType.endsWith('ore'))
        blocktypes.push('deepslate_'+blockType);
    if (blockType === 'dirt')
        blocktypes.push('grass_block');
    if (blockType === 'cobblestone')
        blocktypes.push('stone');
    const isLiquid = blockType === 'lava' || blockType === 'water';

    let collected = 0;
    let noProgressCount = 0;
    const failedPositions = [];
    const beforeCount = collectProgressCount(bot, blockType);

    const movements = safeMovements(bot, { destructive: true });
    movements.dontMineUnderFallingBlock = false; // mining gravel/sand stacks is normal while collecting
    movements.dontCreateFlow = true;

    for (let i=0; i<num; i++) {
        if (noProgressCount > 3) {
            log(bot, `No progress after ${noProgressCount} attempts — giving up.`);
            break;
        }
        const COLLECT_DBG = process.env.MC_COLLECT_DEBUG === '1' || global.MC_COLLECT_DEBUG;
        let dbgRejections = { noBlock: 0, noPos: 0, badName: 0 };
        // P0 FIX: the matcher here receives position-less Block objects on
        // the Fabric stack, so exclusion checks moved OUT of the predicate
        // into a post-filter (world.getNearestBlocksWhere repairs .position).
        let blocks = world.getNearestBlocksWhere(bot, block => {
            if (!block || !blocktypes.includes(block.name)) {
                return false;
            }
            if (isLiquid) {
                return block.metadata === 0;
            }
            if (block.hardness === undefined || block.hardness < 0) {
                if (COLLECT_DBG) console.log(`[collectDBG] hardness-gate rejected ${block.name} hardness=${block.hardness}`);
                return false;
            }
            return true;
        }, 64, 1);

        const allExcludes = (exclude || []).concat(failedPositions);
        blocks = blocks.filter(b => {
            if (!b.position) return false;
            for (const position of allExcludes) {
                if (!position) continue;
                if (b.position.x === position.x && b.position.y === position.y && b.position.z === position.z) {
                    if (COLLECT_DBG) console.log(`[collectDBG] excluded ${b.name}@${b.position.x},${b.position.y},${b.position.z}`);
                    return false;
                }
            }
            return true;
        });

        if (COLLECT_DBG) {
            const rawAny = bot.findBlocks({ matching: b => b?.name?.endsWith('_log') || b?.name?.includes(blockType), maxDistance: 64, count: 5 }) || [];
            console.log(`[collectDBG] want=${blockType} filtered=${blocks.length} rawNearby=${rawAny.length} firstRaw=${rawAny[0] ? `${bot.blockAt(rawAny[0])?.name}@(${rawAny[0].x},${rawAny[0].y},${rawAny[0].z})` : 'none'} interrupt=${bot.interrupt_code} rejects=${JSON.stringify(dbgRejections)} pos=(${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)})`);
        }

        if (blocks.length === 0) {
            if (collected === 0)
                log(bot, `No ${blockType} nearby to collect.`);
            else
                log(bot, `No more ${blockType} nearby to collect.`);
            break;
        }
        const block = blocks[0];
        await equipBestToolFor(bot, block);
        if (isLiquid) {
            const bucket = bot.inventory.findInventoryItem('bucket');
            if (!bucket) {
                log(bot, `Don't have bucket to harvest ${blockType}.`);
                return false;
            }
            await bot.equip(bucket, 'hand');
        }
        const itemId = bot.heldItem ? bot.heldItem.type : null
        if (!block.canHarvest(itemId)) {
            log(bot, `Don't have right tools to harvest ${blockType}.`);
            return false;
        }
        const invBefore = collectProgressCount(bot, blockType);
        try {
            let success = false;
            if (!block.position) {
                log(bot, `Block at unknown position, skipping.`);
                failedPositions.push(block.position || {});
                continue;
            }
            if (isLiquid) {
                success = await useToolOnBlock(bot, 'bucket', block);
            }
            else if (mc.mustCollectManually(blockType)) {
                await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                await equipBestToolFor(bot, block);
                const digTimeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error(`Strip-mine dig timeout: ${block.name}`)), 15000)
                );
                await Promise.race([bot.dig(block), digTimeout]);
                await pickupNearbyItems(bot);
                success = true;
            }
            else {
                // P0 FIX: if the collectblock plugin is missing (load race /
                // reconnect), fall back to manual dig instead of silently
                // throwing forever inside a swallowed catch.
                if (!bot.collectBlock?.collect) {
                    await goToPosition(bot, block.position.x, block.position.y, block.position.z, 2);
                    await equipBestToolFor(bot, block);
                    const digTimeout = new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Manual dig timeout: ${block.name}`)), 15000));
                    await Promise.race([bot.dig(block), digTimeout]);
                    await pickupNearbyItems(bot);
                    success = true;
                } else {
                    try {
                        await bot.collectBlock.collect(block);
                    } catch (e) {
                        // NEVER swallow silently again — silent failures here
                        // cost an entire debugging session (all collections
                        // no-op'd while looking like "no blocks nearby").
                        log(bot, `collectBlock.collect failed: ${e.message}`);
                        throw e;
                    }
                    await new Promise(r => setTimeout(r, 200));
                    await pickupNearbyItems(bot);
                    success = true;
                }
            }
            const invAfter = collectProgressCount(bot, blockType);
            if (success && invAfter > invBefore) {
                collected++;
                noProgressCount = 0;
            } else {
                noProgressCount++;
            }
            await autoLight(bot);
        }
        catch (err) {
            if (err.name === 'NoChests') {
                log(bot, `Failed to collect ${blockType}: Inventory full, no place to deposit.`);
                break;
            }
            else {
                log(bot, `Failed to collect ${blockType}: ${err}.`);
                noProgressCount++;
                failedPositions.push(block.position);
                if (bot.interrupt_code) break;
                await new Promise(r => setTimeout(r, 100));
                continue;
            }
        }
        
        if (bot.interrupt_code)
            break;  
    }
    const afterCount = collectProgressCount(bot, blockType);
    log(bot, `Collected ${afterCount - beforeCount} ${blockType}.`);
    return (afterCount - beforeCount) > 0;
}

export async function pickupNearbyItems(bot, range = 8) {
    /**
     * Pick up all nearby items.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} [range=8] how far to look for item entities.
     * @returns {Promise<boolean>} true if the items were picked up, false otherwise.
     * @example
     * await skills.pickupNearbyItems(bot);
     **/
    const distance = Math.max(2, range);
    const getNearestItem = bot => {
        if (!bot.entity || !bot.entity.position) return null;
        return bot.nearestEntity(entity => entity.name === 'item' && bot.entity.position.distanceTo(entity.position) < distance);
    };
    let nearestItem = getNearestItem(bot);
    let pickedUp = 0;
    let maxPickupIterations = 10;
    while (nearestItem && pickedUp < maxPickupIterations) {
        let movements = safeMovements(bot, { destructive: true });
        movements.canDig = false;
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalFollow(nearestItem, 1));
        await new Promise(resolve => setTimeout(resolve, 200));
        let prev = nearestItem;
        nearestItem = getNearestItem(bot);
        if (prev === nearestItem) {
            break;
        }
        pickedUp++;
    }
    log(bot, `Picked up ${pickedUp} items.`);
    return true;
}


export async function breakBlockAt(bot, x, y, z) {
    /**
     * Break the block at the given position. Will use the bot's equipped item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate of the block to break.
     * @param {number} y, the y coordinate of the block to break.
     * @param {number} z, the z coordinate of the block to break.
     * @returns {Promise<boolean>} true if the block was broken, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.breakBlockAt(bot, position.x, position.y - 1, position.x);
     **/
    if (x == null || y == null || z == null) throw new Error('Invalid position to break block at.');
    let block = bot.blockAt(Vec3(x, y, z));
    if (block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        if (bot.modes.isOn('cheat')) {
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' air';
            bot.chat(msg);
            log(bot, `Used /setblock to break block at ${x}, ${y}, ${z}.`);
            return true;
        }

        if (bot.entity.position.distanceTo(block.position) > 4.5) {
            let pos = block.position;
            let movements = new pf.Movements(bot);
            movements.canPlaceOn = false;
            movements.allow1by1towers = false;
            bot.pathfinder.setMovements(movements);
            await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
        }
        if (bot.game.gameMode !== 'creative') {
            await equipBestToolFor(bot, block);
            const itemId = bot.heldItem ? bot.heldItem.type : null
            if (!block.canHarvest(itemId)) {
                log(bot, `Don't have right tools to break ${block.name}.`);
                return false;
            }
        }
        const digTimeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Dig timeout: ${block.name} at ${block.position}`)), 15000)
        );
        await Promise.race([bot.dig(block, true), digTimeout]);
        log(bot, `Broke ${block.name} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    else {
        log(bot, `Skipping block at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)} because it is ${block.name}.`);
        return false;
    }
    return true;
}


export async function placeBlock(bot, blockType, x, y, z, placeOn='bottom', dontCheat=false) {
    /**
     * Place the given block type at the given position. It will build off from any adjacent blocks. Will fail if there is a block in the way or nothing to build off of.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to place, which can be a block or item name.
     * @param {number} x, the x coordinate of the block to place.
     * @param {number} y, the y coordinate of the block to place.
     * @param {number} z, the z coordinate of the block to place.
     * @param {string} placeOn, the preferred side of the block to place on. Can be 'top', 'bottom', 'north', 'south', 'east', 'west', or 'side'. Defaults to bottom. Will place on first available side if not possible.
     * @param {boolean} dontCheat, overrides cheat mode to place the block normally. Defaults to false.
     * @returns {Promise<boolean>} true if the block was placed, false otherwise.
     * @example
     * let p = world.getPosition(bot);
     * await skills.placeBlock(bot, "oak_log", p.x + 2, p.y, p.x);
     * await skills.placeBlock(bot, "torch", p.x + 1, p.y, p.x, 'side');
     **/
    const target_dest = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));

    if (blockType === 'air') {
        log(bot, `Placing air (removing block) at ${target_dest}.`);
        return await breakBlockAt(bot, x, y, z);
    }

    if (bot.modes.isOn('cheat') && !dontCheat) {
        if (bot.restrict_to_inventory) {
            let block = bot.inventory.findInventoryItem(blockType);
            if (!block) {
                log(bot, `Cannot place ${blockType}, you are restricted to your current inventory.`);
                return false;
            }
        }

        // invert the facing direction
        let face = placeOn === 'north' ? 'south' : placeOn === 'south' ? 'north' : placeOn === 'east' ? 'west' : 'east';
        if (blockType.includes('torch') && placeOn !== 'bottom') {
            // insert wall_ before torch
            blockType = blockType.replace('torch', 'wall_torch');
            if (placeOn !== 'side' && placeOn !== 'top') {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType.includes('button') || blockType === 'lever') {
            if (placeOn === 'top') {
                blockType += `[face=ceiling]`;
            }
            else if (placeOn === 'bottom') {
                blockType += `[face=floor]`;
            }
            else {
                blockType += `[facing=${face}]`;
            }
        }
        if (blockType === 'ladder' || blockType === 'repeater' || blockType === 'comparator') {
            blockType += `[facing=${face}]`;
        }
        if (blockType.includes('stairs')) {
            blockType += `[facing=${face}]`;
        }
        if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
        let msg = '/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z) + ' ' + blockType;
        bot.chat(msg);
        if (blockType.includes('door'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y+1) + ' ' + Math.floor(z) + ' ' + blockType + '[half=upper]');
        if (blockType.includes('bed'))
            if (useDelay) { await new Promise(resolve => setTimeout(resolve, blockPlaceDelay)); }
            bot.chat('/setblock ' + Math.floor(x) + ' ' + Math.floor(y) + ' ' + Math.floor(z-1) + ' ' + blockType + '[part=head]');
        log(bot, `Used /setblock to place ${blockType} at ${target_dest}.`);
        return true;
    }

    let item_name = blockType;
    if (item_name == "redstone_wire")
        item_name = "redstone";
    else if (item_name === 'water') {
        item_name = 'water_bucket';
    }
    else if (item_name === 'lava') {
        item_name = 'lava_bucket';
    }
    let block_item = bot.inventory.findInventoryItem(item_name);
    if (!block_item && bot.game.gameMode === 'creative' && !bot.restrict_to_inventory) {
        await bot.creative.setInventorySlot(36, mc.makeItem(item_name, 1)); // 36 is first hotbar slot
        block_item = bot.inventory.findInventoryItem(item_name);
    }
    if (!block_item) {
        log(bot, `Don't have any ${item_name} to place.`);
        return false;
    }

    const targetBlock = bot.blockAt(target_dest);
    if (targetBlock.name === blockType || (targetBlock.name === 'grass_block' && blockType === 'dirt')) {
        log(bot, `${blockType} already at ${targetBlock.position}.`);
        return false;
    }
    const empty_blocks = ['air', 'water', 'lava', 'grass', 'short_grass', 'tall_grass', 'snow', 'dead_bush', 'fern'];
    if (!empty_blocks.includes(targetBlock.name)) {
        log(bot, `${targetBlock.name} in the way at ${targetBlock.position}.`);
        const removed = await breakBlockAt(bot, x, y, z);
        if (!removed) {
            log(bot, `Cannot place ${blockType} at ${targetBlock.position}: block in the way.`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 200)); // wait for block to break
    }
    // get the buildoffblock and facevec based on whichever adjacent block is not empty
    let buildOffBlock = null;
    let faceVec = null;
    const dir_map = {
        'top': Vec3(0, 1, 0),
        'bottom': Vec3(0, -1, 0),
        'north': Vec3(0, 0, -1),
        'south': Vec3(0, 0, 1),
        'east': Vec3(1, 0, 0),
        'west': Vec3(-1, 0, 0),
    }
    let dirs = [];
    if (placeOn === 'side') {
        dirs.push(dir_map['north'], dir_map['south'], dir_map['east'], dir_map['west']);
    }
    else if (dir_map[placeOn] !== undefined) {
        dirs.push(dir_map[placeOn]);
    }
    else {
        dirs.push(dir_map['bottom']);
        log(bot, `Unknown placeOn value "${placeOn}". Defaulting to bottom.`);
    }
    dirs.push(...Object.values(dir_map).filter(d => !dirs.includes(d)));

    for (let d of dirs) {
        const block = bot.blockAt(target_dest.plus(d));
        if (!empty_blocks.includes(block.name)) {
            buildOffBlock = block;
            faceVec = new Vec3(-d.x, -d.y, -d.z); // invert
            break;
        }
    }
    if (!buildOffBlock) {
        log(bot, `Cannot place ${blockType} at ${targetBlock.position}: nothing to place on.`);
        return false;
    }

    const pos = bot.entity.position;
    const pos_above = pos.plus(Vec3(0,1,0));
    const dont_move_for = ['torch', 'redstone_torch', 'redstone', 'lever', 'button', 'rail', 'detector_rail', 
        'powered_rail', 'activator_rail', 'tripwire_hook', 'tripwire', 'water_bucket', 'string'];
    if (!dont_move_for.includes(item_name) && (pos.distanceTo(targetBlock.position) < 1.1 || pos_above.distanceTo(targetBlock.position) < 1.1)) {
        // too close — step back
        let goal = new pf.goals.GoalNear(targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
        let inverted_goal = new pf.goals.GoalInvert(goal);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        try {
            await goToGoal(bot, inverted_goal, 10000);
        } catch (err) {
            log(bot, `Could not move back from block: ${err.message}`);
        }
    }
    if (bot.entity.position.distanceTo(targetBlock.position) > 4.5) {
        // too far
        let pos = targetBlock.position;
        let movements = new pf.Movements(bot);
        bot.pathfinder.setMovements(movements);
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }

    // will throw error if an entity is in the way, and sometimes even if the block was placed
    try {
        if (item_name.includes('bucket')) {
            await useToolOnBlock(bot, item_name, buildOffBlock);
        }
        else {
            await bot.equip(block_item, 'hand');
            await bot.lookAt(buildOffBlock.position.offset(0.5, 0.5, 0.5));
            await bot.placeBlock(buildOffBlock, faceVec);
            log(bot, `Placed ${blockType} at ${target_dest}.`);
            await new Promise(resolve => setTimeout(resolve, 200));
            return true;
        }
    } catch (err) {
        log(bot, `Failed to place ${blockType} at ${target_dest}.`);
        return false;
    }
}

export async function equip(bot, itemName) {
    /**
     * Equip the given item to the proper body part, like tools or armor.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to equip.
     * @returns {Promise<boolean>} true if the item was equipped, false otherwise.
     * @example
     * await skills.equip(bot, "iron_pickaxe");
     **/
    if (itemName === 'hand') {
        await bot.unequip('hand');
        log(bot, `Unequipped hand.`);
        return true;
    }
    let item = bot.inventory.slots.find(slot => slot && slot.name === itemName);
    if (!item) {
        if (bot.game.gameMode === "creative") {
            await bot.creative.setInventorySlot(36, mc.makeItem(itemName, 1));
            item = bot.inventory.findInventoryItem(itemName);
        }
        else {
            log(bot, `You do not have any ${itemName} to equip.`);
            return false;
        }
    }
    if (itemName.includes('leggings')) {
        await bot.equip(item, 'legs');
    }
    else if (itemName.includes('boots')) {
        await bot.equip(item, 'feet');
    }
    else if (itemName.includes('helmet')) {
        await bot.equip(item, 'head');
    }
    else if (itemName.includes('chestplate') || itemName.includes('elytra')) {
        await bot.equip(item, 'torso');
    }
    else if (itemName.includes('shield')) {
        await bot.equip(item, 'off-hand');
    }
    else {
        await bot.equip(item, 'hand');
    }
    log(bot, `Equipped ${itemName}.`);
    return true;
}

export async function discard(bot, itemName, num=-1) {
    /**
     * Discard the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to discard.
     * @param {number} num, the number of items to discard. Defaults to -1, which discards all items.
     * @returns {Promise<boolean>} true if the item was discarded, false otherwise.
     * @example
     * await skills.discard(bot, "oak_log");
     **/
    let discarded = 0;
    while (true) {
        let item = bot.inventory.findInventoryItem(itemName);
        if (!item) {
            break;
        }
        let to_discard = num === -1 ? item.count : Math.min(num - discarded, item.count);
        await bot.toss(item.type, null, to_discard);
        discarded += to_discard;
        if (num !== -1 && discarded >= num) {
            break;
        }
    }
    if (discarded === 0) {
        log(bot, `You do not have any ${itemName} to discard.`);
        return false;
    }
    log(bot, `Discarded ${discarded} ${itemName}.`);
    return true;
}

export async function putInChest(bot, itemName, num=-1) {
    /**
     * Put the given item in the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to put in the chest.
     * @param {number} num, the number of items to put in the chest. Defaults to -1, which puts all items.
     * @returns {Promise<boolean>} true if the item was put in the chest, false otherwise.
     * @example
     * await skills.putInChest(bot, "oak_log");
     **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    let item = bot.inventory.findInventoryItem(itemName);
    if (!item) {
        log(bot, `You do not have any ${itemName} to put in the chest.`);
        return false;
    }
    let to_put = num === -1 ? item.count : Math.min(num, item.count);
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    await chestContainer.deposit(item.type, null, to_put);
    await chestContainer.close();
    log(bot, `Successfully put ${to_put} ${itemName} in the chest.`);
    return true;
}

export async function takeFromChest(bot, itemName, num=-1) {
    /**
     * Take the given item from the nearest chest, potentially from multiple slots.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item or block name to take from the chest.
     * @param {number} num, the number of items to take from the chest. Defaults to -1, which takes all items.
     * @returns {Promise<boolean>} true if the item was taken from the chest, false otherwise.
     * @example
     * await skills.takeFromChest(bot, "oak_log");
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    
    // Find all matching items in the chest
    let matchingItems = chestContainer.containerItems().filter(item => item.name === itemName);
    if (matchingItems.length === 0) {
        log(bot, `Could not find any ${itemName} in the chest.`);
        await chestContainer.close();
        return false;
    }
    
    let totalAvailable = matchingItems.reduce((sum, item) => sum + item.count, 0);
    let remaining = num === -1 ? totalAvailable : Math.min(num, totalAvailable);
    let totalTaken = 0;
    
    // Take items from each slot until we've taken enough or run out
    for (const item of matchingItems) {
        if (remaining <= 0) break;
        
        let toTakeFromSlot = Math.min(remaining, item.count);
        await chestContainer.withdraw(item.type, null, toTakeFromSlot);
        
        totalTaken += toTakeFromSlot;
        remaining -= toTakeFromSlot;
    }
    
    await chestContainer.close();
    log(bot, `Successfully took ${totalTaken} ${itemName} from the chest.`);
    return totalTaken > 0;
}

export async function viewChest(bot) {
    /**
     * View the contents of the nearest chest.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the chest was viewed, false otherwise.
     * @example
     * await skills.viewChest(bot);
     * **/
    let chest = world.getNearestBlock(bot, 'chest', 32);
    if (!chest) {
        log(bot, `Could not find a chest nearby.`);
        return false;
    }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const chestContainer = await bot.openContainer(chest);
    let items = chestContainer.containerItems();
    if (items.length === 0) {
        log(bot, `The chest is empty.`);
    }
    else {
        log(bot, `The chest contains:`);
        for (let item of items) {
            log(bot, `${item.count} ${item.name}`);
        }
    }
    await chestContainer.close();
    return true;
}

export async function consume(bot, itemName="") {
    /**
     * Eat/drink the given item.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemName, the item to eat/drink.
     * @returns {Promise<boolean>} true if the item was eaten, false otherwise.
     * @example
     * await skills.eat(bot, "apple");
     **/
    let item, name;
    if (itemName) {
        item = bot.inventory.findInventoryItem(itemName);
        name = itemName;
    }
    if (!item) {
        log(bot, `You do not have any ${name || 'food'} to eat.`);
        return false;
    }
    await bot.equip(item, 'hand');
    const foodBefore = bot.food;
    await bot.consume();
    await new Promise(r => setTimeout(r, 500));
    if (bot.food <= foodBefore && bot.food < 20) {
        log(bot, `Warning: Food did not increase after consume (${foodBefore} -> ${bot.food}). May be in hub/lobby.`);
    }
    log(bot, `Consumed ${item.name}.`);
    return true;
}



export async function giveToPlayer(bot, itemType, username, num=1) {
    /**
     * Give one of the specified item to the specified player
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} itemType, the name of the item to give.
     * @param {string} username, the username of the player to give the item to.
     * @param {number} num, the number of items to give. Defaults to 1.
     * @returns {Promise<boolean>} true if the item was given, false otherwise.
     * @example
     * await skills.giveToPlayer(bot, "oak_log", "player1");
     **/
    if (bot.username === username) {
        log(bot, `You cannot give items to yourself.`);
        return false;
    }
    let player = bot.players[username].entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }
    await goToPlayer(bot, username, 3);
    // if we are 2 below the player
    log(bot, bot.entity.position.y, player.position.y);
    if (bot.entity.position.y < player.position.y - 1) {
        await goToPlayer(bot, username, 1);
    }
    // if we are too close, make some distance
    if (bot.entity.position.distanceTo(player.position) < 2) {
        let too_close = true;
        let start_moving_away = Date.now();
        await moveAwayFromEntity(bot, player, 2);
        while (too_close && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            too_close = bot.entity.position.distanceTo(player.position) < 5;
            if (too_close) {
                await moveAwayFromEntity(bot, player, 5);
            }
            if (Date.now() - start_moving_away > 3000) {
                break;
            }
        }
        if (too_close) {
            log(bot, `Failed to give ${itemType} to ${username}, too close.`);
            return false;
        }
    }

    await bot.lookAt(player.position);
    if (await discard(bot, itemType, num)) {
        let given = false;
        bot.once('playerCollect', (collector, collected) => {
            if (collector.username === username) {
                log(bot, `${username} received ${itemType}.`);
                given = true;
            }
        });
        let start = Date.now();
        while (!given && !bot.interrupt_code) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (given) {
                return true;
            }
            if (Date.now() - start > 3000) {
                break;
            }
        }
    }
    log(bot, `Failed to give ${itemType} to ${username}, it was never received.`);
    return false;
}

const GOTO_TIMEOUT_MS = 30000;

function extractGoalInfo(goal) {
    if (!goal) return { type: 'unknown', pos: null };
    let type = goal.constructor?.name || 'unknown';
    let pos = null;
    let followTarget = null;
    if (goal.x != null && goal.z != null) {
        pos = { x: goal.x, y: goal.y ?? 0, z: goal.z };
    }
    if (goal.target) {
        followTarget = {
            name: goal.target.name || goal.target.username || 'entity',
            pos: goal.target.position ? { x: goal.target.position.x, y: goal.target.position.y, z: goal.target.position.z } : null,
        };
    }
    return { type, pos, followTarget };
}

function computeGoalDistance(bot, goal) {
    try {
        const info = extractGoalInfo(goal);
        const botPos = bot.entity?.position;
        if (!botPos) return null;
        if (info.pos) return Math.round(botPos.distanceTo({ x: info.pos.x, y: info.pos.y, z: info.pos.z }));
        if (info.followTarget?.pos) return Math.round(botPos.distanceTo(info.followTarget.pos));
        return null;
    } catch { return null; }
}

function cancelNavigation(bot) {
    try { bot.pathfinder?.setGoal?.(null); } catch (_) {}
    try { bot.pathfinder?.stop?.(); } catch (_) {}
}

/**
 * Dig upward to escape underground. Pro player technique:
 * Mine blocks above, place them below while jumping.
 * @param {MinecraftBot} bot
 * @param {number} maxBlocks - max blocks to dig up (default 20)
 * @returns {Promise<boolean>} true if reached surface
 */
export async function digUpToSurface(bot, maxBlocks = 20) {
    for (let i = 0; i < maxBlocks; i++) {
        // Check if we can see sky (surface reached)
        const blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
        const blockAbove2 = bot.blockAt(bot.entity.position.offset(0, 2, 0));
        if (blockAbove && blockAbove.name === 'air' && blockAbove2 && blockAbove2.name === 'air') {
            return true;
        }
        // Dig the block above us
        try {
            if (blockAbove && bot.canDigBlock(blockAbove)) {
                await bot.dig(blockAbove);
                // Place a block below if we have one
                const placeBlock = bot.inventory.items().find(i =>
                    i.name === 'cobblestone' || i.name === 'dirt' || i.name === 'stone' || i.name === 'andesite'
                );
                if (placeBlock) {
                    await bot.equip(placeBlock, 'hand');
                    const below = bot.entity.position.offset(0, -0.5, 0);
                    try {
                        await bot.placeBlock(
                            bot.blockAt(below),
                            { x: 0, y: 1, z: 0 }
                        );
                    } catch (_) {}
                }
                // Jump to move up
                bot.setControlState('jump', true);
                await new Promise(r => setTimeout(r, 200));
                bot.setControlState('jump', false);
                await new Promise(r => setTimeout(r, 300));
            } else {
                // Can't dig — try mining in a staircase pattern
                const sideBlock = bot.blockAt(bot.entity.position.offset(1, 0, 0));
                if (sideBlock && bot.canDigBlock(sideBlock)) {
                    await bot.dig(sideBlock);
                    bot.setControlState('jump', true);
                    bot.setControlState('forward', true);
                    await new Promise(r => setTimeout(r, 300));
                    bot.setControlState('jump', false);
                    bot.setControlState('forward', false);
                    await new Promise(r => setTimeout(r, 200));
                }
            }
        } catch (_) {
            await new Promise(r => setTimeout(r, 200));
        }
    }
    return false;
}

export class GotoTimeoutError extends Error {
    constructor({ timeout, goal, distance, elapsed }) {
        const info = goal ? extractGoalInfo(goal) : { type: 'unknown', pos: null };
        const posStr = info.pos ? ` @(${info.pos.x},${info.pos.y},${info.pos.z})` : '';
        const distStr = distance != null ? ` dist=${distance}` : '';
        super(`goto timeout: ${info.type}${posStr}${distStr} timeout=${timeout}ms${elapsed != null ? ` elapsed=${elapsed}ms` : ''}`);
        this.name = 'GotoTimeoutError';
    }
}

export async function goToGoal(bot, goal, timeout = GOTO_TIMEOUT_MS) {
    /**
     * Navigate to the given goal. Use doors and attempt minimally destructive movements.
     * SWIM-AWARE: this pathfinder version cannot swim (it walks lake floors
     * and drowns). When we're in deep water, hand control to SwimController
     * which surface-swims toward the goal until land/pathfinder can resume.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {pf.goals.Goal} goal, the goal to navigate to.
     * @param {number} [timeout=30000] timeout in ms. Use -1 for no timeout.
     **/

    // ── Deep-water takeover: raw-control swimming beats drowning ──
    if (isDeepWater(bot)) {
        const target = extractGoalInfo(goal);
        let sx = null, sy = null, sz = null;
        if (target.pos) { ({ x: sx, y: sy, z: sz } = target.pos); }
        else if (target.followTarget?.position) {
            sx = target.followTarget.position.x; sy = target.followTarget.position.y; sz = target.followTarget.position.z;
        }
        if (sx != null) {
            log(bot, `In deep water — swimming toward the goal.`);
            await swimToward(bot, sx, sy ?? bot.entity.position.y, sz, { timeoutMs: Math.min(timeout < 0 ? 30000 : timeout, 45000) });
            // If we've reached shore, continue below with normal pathfinding
            if (!isDeepWater(bot)) { /* fall through to pathfinder */ }
            else return true; // still mid-water after timeout — best effort
        }
    }

    const nonDestructiveMovements = safeMovements(bot, { destructive: false });
    const info = extractGoalInfo(goal);
    const dist = computeGoalDistance(bot, goal);
    log(bot, `Navigating to ${info.type}${info.pos ? ` @(${info.pos.x},${info.pos.y},${info.pos.z})` : ''}${info.followTarget ? ` -> ${info.followTarget.name}` : ''}${dist != null ? ` [${dist}m]` : ''} timeout=${timeout}ms`);

    const destructiveMovements = safeMovements(bot, { destructive: true });

    let final_movements = destructiveMovements;

    let pathfinderWorked = false;
    const pathfind_timeout = 500;
    if (await bot.pathfinder.getPathTo(nonDestructiveMovements, goal, pathfind_timeout).status === 'success') {
        final_movements = nonDestructiveMovements;
        log(bot, `Found non-destructive path.`);
        pathfinderWorked = true;
    }
    else if (await bot.pathfinder.getPathTo(destructiveMovements, goal, pathfind_timeout).status === 'success') {
        log(bot, `Found destructive path.`);
        pathfinderWorked = true;
    }
    else {
        log(bot, `Path not found — using raw sprint-jump movement.`);
        const targetPos = info.pos || goal?.followTarget?.position;
        if (targetPos) {
            const reached = await sprintJumpToward(bot, targetPos, goal.distance || 2, timeout);
            if (reached) return true;
        }
        throw new GotoTimeoutError({ timeout, goal, distance: computeGoalDistance(bot, goal), elapsed: 0 });
    }

    const doorCheckInterval = startDoorInterval(bot);
    const startTime = Date.now();
    const distance = computeGoalDistance(bot, goal);

    // HUMAN MOTION: sprint long traversals (walk-speed bots read as laggy/AI),
    // and clear sprint afterwards so idle stance doesn't drain hunger.
    const longHaul = distance != null && distance > 5;
    if (longHaul) { try { bot.setControlState('sprint', true); } catch (_) {} }

    bot.pathfinder.setMovements(final_movements);
    let timeoutTimer = null;
    try {
        let gotoPromise = bot.pathfinder.goto(goal);
        if (timeout > 0) {
            gotoPromise = Promise.race([
                gotoPromise,
                new Promise((_, reject) => {
                    timeoutTimer = setTimeout(() => {
                        const elapsed = Date.now() - startTime;
                        cancelNavigation(bot);
                        reject(new GotoTimeoutError({ timeout, goal, distance, elapsed }));
                    }, timeout);
                }),
            ]);
        }
        await gotoPromise;
        clearInterval(doorCheckInterval);
        return true;
    } catch (err) {
        clearInterval(doorCheckInterval);
        cancelNavigation(bot);
        const elapsed = Date.now() - startTime;
        if (err.name === 'GotoTimeoutError') throw err;
        err.message = `${err.message} | goal=${extractGoalInfo(goal).type} dist=${distance ?? '?'} elapsed=${elapsed}ms`;
        throw err;
    } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (longHaul) { try { bot.setControlState('sprint', false); } catch (_) {} }
    }
}

let _doorInterval = null;
function startDoorInterval(bot) {
    /**
     * Start helper interval that opens nearby doors if the bot is stuck.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {number} the interval id.
     **/
    if (_doorInterval) {
        clearInterval(_doorInterval);
    }
    let prev_pos = bot.entity.position.clone();
    let prev_check = Date.now();
    let stuck_time = 0;


    const doorCheckInterval = setInterval(() => {
        const now = Date.now();
        if (bot.entity.position.distanceTo(prev_pos) >= 0.1) {
            stuck_time = 0;
        } else {
            stuck_time += now - prev_check;
        }
        
        if (stuck_time > 1200) {
            // shuffle positions so we're not always opening the same door
            const positions = [
                bot.entity.position.clone(),
                bot.entity.position.offset(0, 0, 1),
                bot.entity.position.offset(0, 0, -1), 
                bot.entity.position.offset(1, 0, 0),
                bot.entity.position.offset(-1, 0, 0),
            ]
            let elevated_positions = positions.map(position => position.offset(0, 1, 0));
            positions.push(...elevated_positions);
            positions.push(bot.entity.position.offset(0, 2, 0)); // above head
            positions.push(bot.entity.position.offset(0, -1, 0)); // below feet
            
            let currentIndex = positions.length;
            while (currentIndex != 0) {
                let randomIndex = Math.floor(Math.random() * currentIndex);
                currentIndex--;
                [positions[currentIndex], positions[randomIndex]] = [
                positions[randomIndex], positions[currentIndex]];
            }
            
            for (let position of positions) {
                let block = bot.blockAt(position);
                if (block && block.name &&
                    !block.name.includes('iron') &&
                    (block.name.includes('door') ||
                     block.name.includes('fence_gate') ||
                     block.name.includes('trapdoor'))) 
                {
                    bot.activateBlock(block);
                    break;
                }
            }
            stuck_time = 0;
        }
        prev_pos = bot.entity.position.clone();
        prev_check = now;
    }, 200);
    _doorInterval = doorCheckInterval;
    return doorCheckInterval;
}

export async function goToPosition(bot, x, y, z, min_distance=2, timeout=null) {
    /**
     * Navigate to the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to navigate to. If null, the bot's current x coordinate will be used.
     * @param {number} y, the y coordinate to navigate to. If null, the bot's current y coordinate will be used.
     * @param {number} z, the z coordinate to navigate to. If null, the bot's current z coordinate will be used.
     * @param {number} distance, the distance to keep from the position. Defaults to 2.
     * @returns {Promise<boolean>} true if the position was reached, false otherwise.
     * @example
     * let position = world.world.getNearestBlock(bot, "oak_log", 64).position;
     * await skills.goToPosition(bot, position.x, position.y, position.x + 20);
     **/
    if (x == null || y == null || z == null) {
        log(bot, `Missing coordinates, given x:${x} y:${y} z:${z}`);
        return false;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
        log(bot, `Teleported to ${x}, ${y}, ${z}.`);
        return true;
    }
    
    const checkDigProgress = () => {
        if (bot.targetDigBlock) {
            const targetBlock = bot.targetDigBlock;
            const itemId = bot.heldItem ? bot.heldItem.type : null;
            if (!targetBlock.canHarvest(itemId)) {
                log(bot, `Pathfinding stopped: Cannot break ${targetBlock.name} with current tools.`);
                bot.pathfinder.stop();
                bot.stopDigging();
            }
        }
    };
    
    const progressInterval = setInterval(checkDigProgress, 1000);

    try {
        await goToGoal(bot, new pf.goals.GoalNear(x, y, z, min_distance), timeout ?? undefined);
        clearInterval(progressInterval);
        const distance = bot.entity.position.distanceTo(new Vec3(x, y, z));
        if (distance <= min_distance+1) {
            log(bot, `You have reached at ${x}, ${y}, ${z}.`);
            return true;
        }
        else {
            log(bot, `Unable to reach ${x}, ${y}, ${z}, you are ${Math.round(distance)} blocks away.`);
            return false;
        }
    } catch (err) {
        log(bot, `Pathfinding stopped: ${err.message}.`);
        clearInterval(progressInterval);
        return false;
    }
}

export async function goToNearestBlock(bot, blockType,  min_distance=2, range=64) {
    /**
     * Navigate to the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the type of block to navigate to.
     * @param {number} min_distance, the distance to keep from the block. Defaults to 2.
     * @param {number} range, the range to look for the block. Defaults to 64.
     * @returns {Promise<boolean>} true if the block was reached, false otherwise.
     * @example
     * await skills.goToNearestBlock(bot, "oak_log", 64, 2);
     * **/
    const MAX_RANGE = 512;
    if (range > MAX_RANGE) {
        log(bot, `Maximum search range capped at ${MAX_RANGE}. `);
        range = MAX_RANGE;
    }
    let block = null;
    if (blockType === 'water' || blockType === 'lava') {
        let blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType && block.metadata === 0, range, 1);
        if (blocks.length === 0) {
            log(bot, `Could not find any source ${blockType} in ${range} blocks, looking for uncollectable flowing instead...`);
            blocks = world.getNearestBlocksWhere(bot, block => block.name === blockType, range, 1);
        }
        block = blocks[0];
    }
    else {
        block = world.getNearestBlock(bot, blockType, range);
    }
    if (!block) {
        log(bot, `Could not find any ${blockType} in ${range} blocks.`);
        return false;
    }
    log(bot, `Found ${blockType} at ${block.position}. Navigating...`);
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, min_distance);
    return true;
}

export async function goToNearestEntity(bot, entityType, min_distance=2, range=64) {
    /**
     * Navigate to the nearest entity of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} entityType, the type of entity to navigate to.
     * @param {number} min_distance, the distance to keep from the entity. Defaults to 2.
     * @param {number} range, the range to look for the entity. Defaults to 64.
     * @returns {Promise<boolean>} true if the entity was reached, false otherwise.
     **/
    let entity = world.getNearestEntityWhere(bot, entity => entity.name === entityType, range);
    if (!entity) {
        log(bot, `Could not find any ${entityType} in ${range} blocks.`);
        return false;
    }
    let distance = bot.entity.position.distanceTo(entity.position);
    log(bot, `Found ${entityType} ${distance} blocks away.`);
    await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, min_distance);
    return true;
}

export async function goToPlayer(bot, username, distance=3) {
    /**
     * Navigate to the given player.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to navigate to.
     * @param {number} distance, the goal distance to the player.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.goToPlayer(bot, "player");
     **/
    if (bot.username === username) {
        log(bot, `You are already at ${username}.`);
        return true;
    }
    if (bot.modes.isOn('cheat')) {
        bot.chat('/tp @s ' + username);
        log(bot, `Teleported to ${username}.`);
        return true;
    }

    bot.modes.pause('self_defense');
    bot.modes.pause('cowardice');
    let player = bot.players[username].entity
    if (!player) {
        log(bot, `Could not find ${username}.`);
        return false;
    }

    distance = Math.max(distance, 0.5);
    const goal = new pf.goals.GoalFollow(player, distance);

    await goToGoal(bot, goal);

    log(bot, `You have reached ${username}.`);
}


export async function followPlayer(bot, username, distance=4) {
    /**
     * Follow the given player endlessly. Will not return until the code is manually stopped.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} username, the username of the player to follow.
     * @returns {Promise<boolean>} true if the player was found, false otherwise.
     * @example
     * await skills.followPlayer(bot, "player");
     **/
    let player = bot.players[username].entity
    if (!player)
        return false;

    const move = new pf.Movements(bot);
    move.digCost = 10;
    bot.pathfinder.setMovements(move);
    let doorCheckInterval = startDoorInterval(bot);

    bot.pathfinder.setGoal(new pf.goals.GoalFollow(player, distance), true);
    log(bot, `You are now actively following player ${username}.`);


    while (!bot.interrupt_code) {
        await new Promise(resolve => setTimeout(resolve, 500));
        // in cheat mode, if the distance is too far, teleport to the player
        const distance_from_player = bot.entity.position.distanceTo(player.position);

        const teleport_distance = 100;
        const ignore_modes_distance = 30; 
        const nearby_distance = distance + 2;

        if (distance_from_player > teleport_distance && bot.modes.isOn('cheat')) {
            // teleport with cheat mode
            await goToPlayer(bot, username);
        }
        else if (distance_from_player > ignore_modes_distance) {
            // these modes slow down the bot, and we want to catch up
            bot.modes.pause('item_collecting');
            bot.modes.pause('hunting');
            bot.modes.pause('torch_placing');
        }
        else if (distance_from_player <= ignore_modes_distance) {
            bot.modes.unpause('item_collecting');
            bot.modes.unpause('hunting');
            bot.modes.unpause('torch_placing');
        }

        if (distance_from_player <= nearby_distance) {
            clearInterval(doorCheckInterval);
            doorCheckInterval = null;
            bot.modes.pause('unstuck');
            bot.modes.pause('elbow_room');
        }
        else {
            if (!doorCheckInterval) {
                doorCheckInterval = startDoorInterval(bot);
            }
            bot.modes.unpause('unstuck');
            bot.modes.unpause('elbow_room');
        }
    }
    clearInterval(doorCheckInterval);
    return true;
}


export async function moveAway(bot, distance) {
    /**
     * Move away from current position in any direction.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.moveAway(bot, 8);
     **/
    const pos = bot.entity.position;
    let goal = new pf.goals.GoalNear(pos.x, pos.y, pos.z, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));

    if (bot.modes.isOn('cheat')) {
        const move = new pf.Movements(bot);
        const path = await bot.pathfinder.getPathTo(move, inverted_goal, 10000);
        let last_move = path.path[path.path.length-1];
        if (last_move) {
            let x = Math.floor(last_move.x);
            let y = Math.floor(last_move.y);
            let z = Math.floor(last_move.z);
            bot.chat('/tp @s ' + x + ' ' + y + ' ' + z);
            return true;
        }
    }

    await goToGoal(bot, inverted_goal);
    let new_pos = bot.entity.position;
    log(bot, `Moved away from ${new Vec3(pos.x, pos.y, pos.z).floored()} to ${new Vec3(new_pos.x, new_pos.y, new_pos.z).floored()}.`);
    return true;
}

export async function moveAwayFromEntity(bot, entity, distance=16) {
    /**
     * Move away from the given entity.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Entity} entity, the entity to move away from.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     **/
    let goal = new pf.goals.GoalFollow(entity, distance);
    let inverted_goal = new pf.goals.GoalInvert(goal);
    bot.pathfinder.setMovements(new pf.Movements(bot));
    try {
        await goToGoal(bot, inverted_goal, 15000);
        return true;
    } catch (err) {
        log(bot, `Could not move away from ${entity.name || 'entity'}: ${err.message}`);
        return false;
    }
}

export async function avoidEnemies(bot, distance=16) {
    /**
     * Move a given distance away from all nearby enemy mobs.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} distance, the distance to move away.
     * @returns {Promise<boolean>} true if the bot moved away, false otherwise.
     * @example
     * await skills.avoidEnemies(bot, 8);
     **/
    bot.modes.pause('self_preservation'); // prevents damage-on-low-health from interrupting the bot
    let enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
    while (enemy) {
        const follow = new pf.goals.GoalFollow(enemy, distance+1); // move a little further away
        const inverted_goal = new pf.goals.GoalInvert(follow);
        bot.pathfinder.setMovements(new pf.Movements(bot));
        bot.pathfinder.setGoal(inverted_goal, true);
        await new Promise(resolve => setTimeout(resolve, 500));
        enemy = world.getNearestEntityWhere(bot, entity => mc.isHostile(entity), distance);
        if (bot.interrupt_code) {
            break;
        }
        if (enemy && bot.entity.position.distanceTo(enemy.position) < 3) {
            await attackEntity(bot, enemy, false);
        }
    }
    bot.pathfinder.stop();
    log(bot, `Moved ${distance} away from enemies.`);
    return true;
}

export async function stay(bot, seconds=30) {
    /**
     * Stay in the current position until interrupted. Disables all modes.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} seconds, the number of seconds to stay. Defaults to 30. -1 for indefinite.
     * @returns {Promise<boolean>} true if the bot stayed, false otherwise.
     * @example
     * await skills.stay(bot);
     **/
    bot.modes.pause('self_preservation');
    bot.modes.pause('unstuck');
    bot.modes.pause('cowardice');
    bot.modes.pause('self_defense');
    bot.modes.pause('hunting');
    bot.modes.pause('torch_placing');
    bot.modes.pause('item_collecting');
    let start = Date.now();
    while (!bot.interrupt_code && (seconds === -1 || Date.now() - start < seconds*1000)) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `Stayed for ${(Date.now() - start)/1000} seconds.`);
    return true;
}

export async function useDoor(bot, door_pos=null) {
    /**
     * Use the door at the given position.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {Vec3} door_pos, the position of the door to use. If null, the nearest door will be used.
     * @returns {Promise<boolean>} true if the door was used, false otherwise.
     * @example
     * let door = world.getNearestBlock(bot, "oak_door", 16).position;
     * await skills.useDoor(bot, door);
     **/
    if (!door_pos) {
        for (let door_type of ['oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                               'mangrove_door', 'cherry_door', 'bamboo_door', 'crimson_door', 'warped_door']) {
            door_pos = world.getNearestBlock(bot, door_type, 16).position;
            if (door_pos) break;
        }
    } else {
        door_pos = Vec3(door_pos.x, door_pos.y, door_pos.z);
    }
    if (!door_pos) {
        log(bot, `Could not find a door to use.`);
        return false;
    }

    log(bot, `Navigating to door @(${door_pos.x}, ${door_pos.y}, ${door_pos.z}).`);
    bot.pathfinder.setGoal(new pf.goals.GoalNear(door_pos.x, door_pos.y, door_pos.z, 1));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    while (bot.pathfinder.isMoving()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    
    let door_block = bot.blockAt(door_pos);
    await bot.lookAt(door_pos);
    if (!door_block._properties.open)
        await bot.activateBlock(door_block);
    
    bot.setControlState("forward", true);
    await new Promise((resolve) => setTimeout(resolve, 600));
    bot.setControlState("forward", false);
    await bot.activateBlock(door_block);

    log(bot, `Used door at ${door_pos}.`);
    return true;
}

export async function goToBed(bot) {
    /**
     * Sleep in the nearest bed.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the bed was found, false otherwise.
     * @example
     * await skills.goToBed(bot);
     **/
    const beds = bot.findBlocks({
        matching: (block) => {
            return block.name.includes('bed');
        },
        maxDistance: 32,
        count: 1
    });
    if (beds.length === 0) {
        log(bot, `Could not find a bed to sleep in.`);
        return false;
    }
    let loc = beds[0];
    await goToPosition(bot, loc.x, loc.y, loc.z);
    const bed = bot.blockAt(loc);
    await bot.sleep(bed);
    if (!bot.isSleeping) {
        log(bot, `Sleep failed — server denied sleep request.`);
        return false;
    }
    log(bot, `You are in bed.`);
    bot.modes.pause('unstuck');
    while (bot.isSleeping) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    log(bot, `You have woken up.`);
    return true;
}

export async function tillAndSow(bot, x, y, z, seedType=null) {
    /**
     * Till the ground at the given position and plant the given seed type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {number} x, the x coordinate to till.
     * @param {number} y, the y coordinate to till.
     * @param {number} z, the z coordinate to till.
     * @param {string} plantType, the type of plant to plant. Defaults to none, which will only till the ground.
     * @returns {Promise<boolean>} true if the ground was tilled, false otherwise.
     * @example
     * let position = world.getPosition(bot);
     * await skills.tillAndSow(bot, position.x, position.y - 1, position.x, "wheat");
     **/
    let pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    let block = bot.blockAt(pos);
    log(bot, `Planting ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);

    if (bot.modes.isOn('cheat')) {
        let to_remove = ['_seed', '_seeds'];
        for (let remove of to_remove) {
            if (seedType.endsWith(remove)) {
                seedType = seedType.replace(remove, '');
            }
        }
        await placeBlock(bot, 'farmland', x, y, z);
        await placeBlock(bot, seedType, x, y+1, z);
        return true;
    }

    if (block.name !== 'grass_block' && block.name !== 'dirt' && block.name !== 'farmland') {
        log(bot, `Cannot till ${block.name}, must be grass_block or dirt.`);
        return false;
    }
    let above = bot.blockAt(new Vec3(x, y+1, z));
    if (above.name !== 'air') {
        if (block.name === 'farmland') {
            log(bot, `Land is already farmed with ${above.name}.`);
            return true;
        }
        let broken = await breakBlockAt(bot, x, y+1, z);
        if (!broken) {
            log(bot, `Cannot cannot break above block to till.`);
            return false;
        }
    }
    // if distance is too far, move to the block
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    if (block.name !== 'farmland') {
        let hoe = bot.inventory.items().find(item => item.name.includes('hoe'));
        let to_equip = hoe?.name || 'diamond_hoe';
        if (!await equip(bot, to_equip)) {
            log(bot, `Cannot till, no hoes.`);
            return false;
        }
        await bot.activateBlock(block);
        log(bot, `Tilled block x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    
    if (seedType) {
        if (seedType.endsWith('seed') && !seedType.endsWith('seeds'))
            seedType += 's'; // fixes common mistake
        let equipped_seeds = await equip(bot, seedType);
        if (!equipped_seeds) {
            log(bot, `No ${seedType} to plant.`);
            return false;
        }

        await bot.activateBlock(block);
        log(bot, `Planted ${seedType} at x:${x.toFixed(1)}, y:${y.toFixed(1)}, z:${z.toFixed(1)}.`);
    }
    return true;
}

export async function activateNearestBlock(bot, type) {
    /**
     * Activate the nearest block of the given type.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} type, the type of block to activate.
     * @returns {Promise<boolean>} true if the block was activated, false otherwise.
     * @example
     * await skills.activateNearestBlock(bot, "lever");
     * **/
    let block = world.getNearestBlock(bot, type, 16);
    if (!block) {
        log(bot, `Could not find any ${type} to activate.`);
        return false;
    }
    if (bot.entity.position.distanceTo(block.position) > 4.5) {
        let pos = block.position;
        bot.pathfinder.setMovements(new pf.Movements(bot));
        await goToGoal(bot, new pf.goals.GoalNear(pos.x, pos.y, pos.z, 4));
    }
    await bot.activateBlock(block);
    log(bot, `Activated ${type} at x:${block.position.x.toFixed(1)}, y:${block.position.y.toFixed(1)}, z:${block.position.z.toFixed(1)}.`);
    return true;
}

/**
 * Helper function to find and navigate to a villager for trading
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager
 * @returns {Promise<Object|null>} the villager entity if found and reachable, null otherwise
 */
async function findAndGoToVillager(bot, id) {
    id = id+"";
    const entity = bot.entities[id];
    
    if (!entity) {
        log(bot, `Cannot find villager with id ${id}`);
        let entities = world.getNearbyEntities(bot, 16);
        let villager_list = "Available villagers:\n";
        for (let entity of entities) {
            if (entity.name === 'villager') {
                if (entity.metadata && entity.metadata[16] === 1) {
                    villager_list += `${entity.id}: baby villager\n`;
                } else {
                    const profession = world.getVillagerProfession(entity);
                    villager_list += `${entity.id}: ${profession}\n`;
                }
            }
        }
        if (villager_list === "Available villagers:\n") {
            log(bot, "No villagers found nearby.");
            return null;
        }
        log(bot, villager_list);
        return null;
    }
    
    if (entity.entityType !== bot.registry.entitiesByName.villager.id) {
        log(bot, 'Entity is not a villager');
        return null;
    }
    
    if (entity.metadata && entity.metadata[16] === 1) {
        log(bot, 'This is either a baby villager or a villager with no job - neither can trade');
        return null;
    }
    
    const distance = bot.entity.position.distanceTo(entity.position);
    if (distance > 4) {
        log(bot, `Villager is ${distance.toFixed(1)} blocks away, moving closer...`);
        try {
            bot.modes.pause('unstuck');
            const goal = new pf.goals.GoalFollow(entity, 2);
            await goToGoal(bot, goal);
            
            
            log(bot, 'Successfully reached villager');
        } catch (err) {
            log(bot, 'Failed to reach villager - pathfinding error or villager moved');
            return null;
        } finally {
            bot.modes.unpause('unstuck');
        }
    }
    
    return entity;
}

/**
 * Show available trades for a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to show trades for
 * @returns {Promise<boolean>} true if trades were shown successfully, false otherwise
 * @example
 * await skills.showVillagerTrades(bot, "123");
 */
export async function showVillagerTrades(bot, id) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        log(bot, `Villager has ${villager.trades.length} available trades:`);
        stringifyTrades(bot, villager.trades).forEach((trade, i) => {
            log(bot, `${i + 1}: ${trade}`);
        });
        
        villager.close();
        return true;
    } catch (err) {
        log(bot, 'Failed to open villager trading interface - they might be sleeping, a baby, or jobless');
        return false;
    }
}

/**
 * Trade with a specified villager
 * @param {MinecraftBot} bot - reference to the minecraft bot
 * @param {number} id - the entity id of the villager to trade with
 * @param {number} index - the index (1-based) of the trade to execute
 * @param {number} count - how many times to execute the trade (optional)
 * @returns {Promise<boolean>} true if trade was successful, false otherwise
 * @example
 * await skills.tradeWithVillager(bot, "123", "1", "2");
 */
export async function tradeWithVillager(bot, id, index, count) {
    const villagerEntity = await findAndGoToVillager(bot, id);
    if (!villagerEntity) {
        return false;
    }
    
    try {
        const villager = await bot.openVillager(villagerEntity);
        
        if (!villager.trades || villager.trades.length === 0) {
            log(bot, 'This villager has no trades available - might be sleeping, a baby, or jobless');
            villager.close();
            return false;
        }
        
        const tradeIndex = parseInt(index) - 1; // Convert to 0-based index
        const trade = villager.trades[tradeIndex];
        
        if (!trade) {
            log(bot, `Trade ${index} not found. This villager has ${villager.trades.length} trades available.`);
            villager.close();
            return false;
        }
        
        if (trade.disabled) {
            log(bot, `Trade ${index} is currently disabled`);
            villager.close();
            return false;
        }

        const item_2 = trade.inputItem2 ? stringifyItem(bot, trade.inputItem2)+' ' : '';
        log(bot, `Trading ${stringifyItem(bot, trade.inputItem1)} ${item_2}for ${stringifyItem(bot, trade.outputItem)}...`);
        
        const maxPossibleTrades = trade.maximumNbTradeUses - trade.nbTradeUses;
        const requestedCount = count;
        const actualCount = Math.min(requestedCount, maxPossibleTrades);
        
        if (actualCount <= 0) {
            log(bot, `Trade ${index} has been used to its maximum limit`);
            villager.close();
            return false;
        }
        
        if (!hasResources(villager.slots, trade, actualCount)) {
            log(bot, `Don't have enough resources to execute trade ${index} ${actualCount} time(s)`);
            villager.close();
            return false;
        }
        
        log(bot, `Executing trade ${index} ${actualCount} time(s)...`);
        
        try {
            await bot.trade(villager, tradeIndex, actualCount);
            log(bot, `Successfully traded ${actualCount} time(s)`);
            villager.close();
            return true;
        } catch (tradeErr) {
            log(bot, `Trade execution error: ${tradeErr.message}`);
            villager.close();
            return false;
        }
    } catch (err) {
        log(bot, `Villager interface error: ${err.message}`);
        return false;
    }
}

function hasResources(window, trade, count) {
    const first = enough(trade.inputItem1, count);
    const second = !trade.inputItem2 || enough(trade.inputItem2, count);
    return first && second;

    function enough(item, count) {
        let c = 0;
        window.forEach((element) => {
            if (element && element.type === item.type && element.metadata === item.metadata) {
                c += element.count;
            }
        });
        return c >= item.count * count;
    }
}

function stringifyTrades(bot, trades) {
    return trades.map((trade) => {
        let text = stringifyItem(bot, trade.inputItem1);
        if (trade.inputItem2) text += ` & ${stringifyItem(bot, trade.inputItem2)}`;
        if (trade.disabled) text += ' x '; else text += ' » ';
        text += stringifyItem(bot, trade.outputItem);
        return `(${trade.nbTradeUses}/${trade.maximumNbTradeUses}) ${text}`;
    });
}

function stringifyItem(bot, item) {
    if (!item) return 'nothing';
    let text = `${item.count} ${item.displayName}`;
    if (item.nbt && item.nbt.value) {
        const ench = item.nbt.value.ench;
        const StoredEnchantments = item.nbt.value.StoredEnchantments;
        const Potion = item.nbt.value.Potion;
        const display = item.nbt.value.display;

        if (Potion) text += ` of ${Potion.value.replace(/_/g, ' ').split(':')[1] || 'unknown type'}`;
        if (display) text += ` named ${display.value.Name.value}`;
        if (ench || StoredEnchantments) {
            const enchants = (ench || StoredEnchantments).value?.value;
            if (Array.isArray(enchants)) {
                text += ` enchanted with ${enchants.map((e) => {
                    const lvl = e.lvl?.value ?? 1;
                    const id = e.id?.value;
                    const enchName = bot.registry?.enchantments?.[id]?.displayName || `enchant_${id}`;
                    return (enchName || 'unknown') + ' ' + lvl;
                }).join(' ')}`;
            }
        }
    }
    return text;
}

export async function digDown(bot, distance = 10) {
    /**
     * Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {int} distance, distance to dig down.
     * @returns {Promise<boolean>} true if successfully dug all the way down.
     * @example
     * await skills.digDown(bot, 10);
     **/

    let start_block_pos = bot.blockAt(bot.entity.position).position;
    for (let i = 1; i <= distance; i++) {
        const targetBlock = bot.blockAt(start_block_pos.offset(0, -i, 0));
        let belowBlock = bot.blockAt(start_block_pos.offset(0, -i-1, 0));

        if (!targetBlock || !belowBlock) {
            log(bot, `Dug down ${i-1} blocks, but reached the end of the world.`);
            return true;
        }

        // Check for lava, water
        if (targetBlock.name === 'lava' || targetBlock.name === 'water' || 
            belowBlock.name === 'lava' || belowBlock.name === 'water') {
            log(bot, `Dug down ${i-1} blocks, but reached ${belowBlock ? belowBlock.name : '(lava/water)'}`)
            return false;
        }

        const MAX_FALL_BLOCKS = 2;
        let num_fall_blocks = 0;
        for (let j = 0; j <= MAX_FALL_BLOCKS; j++) {
            if (!belowBlock || (belowBlock.name !== 'air' && belowBlock.name !== 'cave_air')) {
                break;
            }
            num_fall_blocks++;
            belowBlock = bot.blockAt(belowBlock.position.offset(0, -1, 0));
        }
        if (num_fall_blocks > MAX_FALL_BLOCKS) {
            log(bot, `Dug down ${i-1} blocks, but reached a drop below the next block.`);
            return false;
        }

        if (targetBlock.name === 'air' || targetBlock.name === 'cave_air') {
            log(bot, 'Skipping air block');
            continue;
        }

        let dug = await breakBlockAt(bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z);
        if (!dug) {
            log(bot, 'Failed to dig block at position:' + targetBlock.position);
            return false;
        }
        // Human-like delay between blocks (anti-cheat)
        await new Promise(r => setTimeout(r, 300 + Math.random() * 600));
    }
    log(bot, `Dug down ${distance} blocks.`);
    return true;
}

export async function goToSurface(bot) {
    /**
     * Navigate to the surface (highest non-air block at current x,z).
     * No-ops when already exposed to open sky at the top of the column.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @returns {Promise<boolean>} true if the surface was reached (or we are already there), false otherwise.
     **/
    const pos = bot.entity.position;
    const feetY = Math.floor(pos.y);
    // Find topmost solid block at this column
    for (let y = Math.min(319, Math.max(feetY + 2, 90)); y > -64; y--) {
        const block = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!block || block.name === 'air' || block.name === 'cave_air' || block.name.includes('leaves') || block.name.includes('log') || block.name.includes('snow')) {
            continue;
        }
        const surfaceY = y + 1;
        // Already on/near the open surface → nothing to do (prevents avoid_hazard loops)
        if (Math.abs(surfaceY - feetY) <= 1) {
            return true;
        }
        await goToPosition(bot, block.position.x, surfaceY, block.position.z, 0);
        log(bot, `Going to the surface at y=${surfaceY}.`);
        return true;
    }
    return false;
}

export async function useToolOn(bot, toolName, targetName) {
    /**
     * Equip a tool and use it on the nearest target.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {string} targetName - entity type, block type, or "nothing" for no target
     * @returns {Promise<boolean>} true if action succeeded
     */
    if (!bot.inventory.slots.find(slot => slot && slot.name === toolName) && !bot.game.gameMode === 'creative') {
        log(bot, `You do not have any ${toolName} to use.`);
        return false;
    }

    targetName = targetName.toLowerCase();
    if (targetName === 'nothing') {
        const equipped = await equip(bot, toolName);
        if (!equipped) {
            return false;
        }
        await bot.activateItem();
        log(bot, `Used ${toolName}.`);
    } else if (world.isEntityType(targetName)) {
        const entity = world.getNearestEntityWhere(bot, e => e.name === targetName, 64);
        if (!entity) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z);
        if (toolName === 'hand') {
            await bot.unequip('hand');
        }
        else {
            const equipped = await equip(bot, toolName);
            if (!equipped) return false;
        }
        await bot.useOn(entity);
        log(bot, `Used ${toolName} on ${targetName}.`);
    } else {
        let block = null;
        if (targetName === 'water' || targetName === 'lava') {
            // we want to get liquid source blocks, not flowing blocks
            // so search for blocks with metadata 0 (not flowing)
            let blocks = world.getNearestBlocksWhere(bot, block => block.name === targetName && block.metadata === 0, 64, 1);
            if (blocks.length === 0) {
                log(bot, `Could not find any source ${targetName}.`);
                return false;
            }
            block = blocks[0];
        }
        else {
            block = world.getNearestBlock(bot, targetName, 64);
        }
        if (!block) {
            log(bot, `Could not find any ${targetName}.`);
            return false;
        }
        return await useToolOnBlock(bot, toolName, block);
    }

    return true;
 }

 export async function useToolOnBlock(bot, toolName, block) {
    /**
     * Use a tool on a specific block.
     * @param {MinecraftBot} bot
     * @param {string} toolName - item name of the tool to equip, or "hand" for no tool.
     * @param {Block} block - the block reference to use the tool on.
     * @returns {Promise<boolean>} true if action succeeded
     */

    const distance = toolName === 'water_bucket' && block.name !== 'lava' ? 1.5 : 2;
    await goToPosition(bot, block.position.x, block.position.y, block.position.z, distance);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));

    // if block in view is closer than the target block, it is in our way. try to move closer
    const viewBlocked = () => {
        const blockInView = bot.blockAtCursor(5);
        const headPos = bot.entity.position.offset(0, bot.entity.height, 0);
        return blockInView && 
            !blockInView.position.equals(block.position) && 
            blockInView.position.distanceTo(headPos) < block.position.distanceTo(headPos);
    }
    const blockInView = bot.blockAtCursor(5);
    if (viewBlocked()) {
        log(bot, `Block ${blockInView.name} is in the way, moving closer...`);
        // choose random block next to target block, go to it
        const nearbyPos = block.position.offset(Math.random() * 2 - 1, 0, Math.random() * 2 - 1);
        await goToPosition(bot, nearbyPos.x, nearbyPos.y, nearbyPos.z, 1);
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
        if (viewBlocked()) {
            const blockInView = bot.blockAtCursor(5);
            log(bot, `Block ${blockInView.name} is in the way, not using ${toolName}.`);
            return false;
        }
    }

    const equipped = await equip(bot, toolName);

    if (!equipped) {
        log(bot, `Could not equip ${toolName}.`);
        return false;
    }
    if (toolName.includes('bucket')) {
        await bot.activateItem();
    }
    else {
        await bot.activateBlock(block);
    }
    log(bot, `Used ${toolName} on ${block.name}.`);
    return true;
 }

export async function jumpIntoBlock(bot, blockType, range = 128) {
    /**
     * Find and jump into a hole containing a specific block type (e.g., red_wool).
     * Use when told to "jump into" something.
     * @param {MinecraftBot} bot, reference to the minecraft bot.
     * @param {string} blockType, the block type to jump into.
     * @param {number} range, the range to look for the block. Defaults to 128.
     * @returns {Promise<boolean>} true if the block was found and jumped into, false otherwise.
     * @example
     * await skills.jumpIntoBlock(bot, "red_wool");
     **/
    const block = world.getNearestBlock(bot, blockType, range);
    if (!block) {
        log(bot, `Could not find any ${blockType} within ${range} blocks.`);
        return false;
    }

    const pos = block.position;
    log(bot, `Found ${blockType} at ${pos}.`);

    // Find surface Y above the block column
    let surfaceY = pos.y;
    for (let y = pos.y; y < 320; y++) {
        const checkBlock = bot.blockAt(new Vec3(pos.x, y, pos.z));
        if (!checkBlock || checkBlock.name === 'air' || checkBlock.name === 'cave_air') {
            surfaceY = y;
            break;
        }
    }

    // Find solid ground adjacent to the hole at surface level
    const offsets = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
    let edgePos = null;
    for (const [dx, dz] of offsets) {
        const ground = bot.blockAt(new Vec3(pos.x + dx, surfaceY - 1, pos.z + dz));
        if (ground && ground.name !== 'air' && ground.name !== 'cave_air') {
            edgePos = new Vec3(pos.x + dx, surfaceY, pos.z + dz);
            break;
        }
    }

    if (edgePos) {
        log(bot, `Going to edge of hole at ${edgePos}...`);
        await goToPosition(bot, edgePos.x, edgePos.y, edgePos.z, 1);
    } else {
        log(bot, `Going to surface above ${blockType}...`);
        await goToPosition(bot, pos.x, surfaceY, pos.z, 0.5);
    }

    // Walk forward into the hole
    bot.setControlState("forward", true);
    await new Promise(resolve => setTimeout(resolve, 1500));
    bot.setControlState("forward", false);

    // Let the bot fall
    await new Promise(resolve => setTimeout(resolve, 1000));

    log(bot, `Jumped into ${blockType}!`);
    return true;
}

export async function bowAttack(bot, target) {
    /**
     * Attack target with bow. Proper draw timing: 1s for full power.
     * Power V bow = 15 damage fully drawn, one-shots most mobs.
     * Critical arrow: fully drawn + not on ground = sparkle trail, extra damage.
     **/
    const bow = bot.inventory.findInventoryItem('bow');
    if (!bow) { log(bot, 'No bow.'); return false; }
    await bot.equip(bow, 'hand');
    const arrow = bot.inventory.findInventoryItem('arrow');
    if (!arrow) { log(bot, 'No arrows.'); return false; }

    const SHOTS = 5;
    const DRAW_TIME = 1000; // 1 second for full draw

    for (let i = 0; i < SHOTS; i++) {
        if (!target || !target.isValid || !bot.entity) break;
        if (bot.interrupt_code) break;

        // Look at target (aim for body center, not feet)
        const targetPos = target.position.offset(0, 1.2, 0);
        bot.lookAt(targetPos, true);

        // Start drawing bow (hold right-click)
        bot.activateItem();

        // Wait for full draw (1 second = full power)
        await new Promise(r => setTimeout(r, DRAW_TIME));

        // Release arrow
        bot.deactivateItem();

        // Wait between shots (bow cooldown ~0.25s after release)
        await new Promise(r => setTimeout(r, 300));
    }
    return true;
}

export async function throwPotion(bot, potionType) {
    const potion = bot.inventory.findInventoryItem(potionType || 'splash_potion');
    if (!potion) { log(bot, `No ${potionType || 'splash_potion'}.`); return false; }
    await bot.equip(potion, 'hand');
    await bot.activateItem();
    await new Promise(r => setTimeout(r, 500));
    log(bot, `Threw ${potionType || 'potion'}.`);
    return true;
}

export async function stripMine(bot, length=20, direction=null) {
    if (!direction) direction = bot.entity.yaw;
    const start = pos(bot).floored();
    for (let i = 0; i < length; i++) {
        const forward = new Vec3(-Math.sin(direction), 0, Math.cos(direction));
        const blockPos = start.plus(forward.scaled(i));
        const block = bot.blockAt(blockPos);
        if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'water' && block.name !== 'lava') {
            try { await equipHighestAttack(bot); } catch (e) { console.warn(`[stripMine] equip: ${e.message}`); }
            try { await bot.dig(block); } catch (e) { console.warn(`[stripMine] dig: ${e.message}`); }
            try { await pickupNearbyItems(bot); } catch (e) { console.warn(`[stripMine] pickup: ${e.message}`); }
            // Human-like delay between blocks (anti-cheat)
            await new Promise(r => setTimeout(r, 200 + Math.random() * 400));
        }
        if (bot.interrupt_code) break;
    }
    log(bot, `Strip mined ${length} blocks.`);
    return true;
}

export async function buildShelter(bot, size=5) {
    const here = pos(bot).floored();
    // Build with WHATEVER we hold enough of: any planks species first
    // (all craft from any wood), then stone family, then dirt.
    const inv = bot.inventory;
    const heldCounts = {};
    for (const item of inv.items()) {
        if (/(_planks|_cobblestone|cobblestone|_stone|^stone$|dirt)$/.test(item.name)) {
            heldCounts[item.name] = (heldCounts[item.name] || 0) + item.count;
        }
    }
    const needed = size*size*2 + size*4;
    let mat = Object.entries(heldCounts).find(([name, c]) => c >= needed)?.[0];
    if (!mat) mat = Object.keys(heldCounts)[0] || 'dirt';
    const floor = here.offset(0, -1, 0);
    for (let x = -1; x <= size; x++) {
        for (let z = -1; z <= size; z++) {
            await placeBlock(bot, mat, floor.x + x, floor.y, floor.z + z);
            if (x === -1 || x === size || z === -1 || z === size)
                for (let y = 1; y <= 3; y++)
                    await placeBlock(bot, mat, floor.x + x, floor.y + y, floor.z + z);
            if (bot.interrupt_code) break;
        }
        if (bot.interrupt_code) break;
    }
    for (let x = -1; x <= size; x++)
        for (let z = -1; z <= size; z++)
            await placeBlock(bot, mat, floor.x + x, floor.y + 4, floor.z + z);
    // Door: any wood door matches the material we actually used
    const doorMat = /_planks/.test(mat) ? mat.replace('_planks', '_door') : 'oak_door';
    await placeBlock(bot, doorMat, here.x, here.y, here.z);
    await placeBlock(bot, 'torch', here.x, here.y + 1, here.z);
    log(bot, `Built shelter at ${here}.`);
    return true;
}

export async function plantAndHarvest(bot, seedType=null, radius=4) {
    const here = pos(bot).floored();
    let planted = 0;
    for (let x = -radius; x <= radius; x++) {
        for (let z = -radius; z <= radius; z++) {
            const soil = bot.blockAt(here.offset(x, -1, z));
            if (!soil || soil.name !== 'farmland') continue;
            const above = bot.blockAt(here.offset(x, 0, z));
            if (above && above.name.includes('age')) {
                await breakBlockAt(bot, here.x + x, here.y, here.z + z);
                await pickupNearbyItems(bot);
                planted++;
            }
            if (seedType) {
                const seed = bot.inventory.findInventoryItem(seedType);
                if (!seed) break;
                await bot.equip(seed, 'hand');
                await bot.placeBlock(above || soil, new Vec3(here.x + x, here.y, here.z + z));
            }
            if (bot.interrupt_code) return planted > 0;
        }
    }
    log(bot, `Harvested/planted ${planted} crops.`);
    return planted > 0;
}

export async function breedAnimals(bot, animalType='cow') {
    const wheat = bot.inventory.findInventoryItem('wheat');
    if (!wheat) { log(bot, 'No wheat for breeding.'); return false; }
    const animals = world.getNearbyEntities(bot, 12).filter(e => e.name === animalType);
    if (animals.length < 2) { log(bot, `Not enough ${animalType}s nearby.`); return false; }
    await bot.equip(wheat, 'hand');
    for (const animal of animals.slice(0, 2)) {
        if (bot.entity.position.distanceTo(animal.position) > 3) {
            await goToPosition(bot, animal.position.x, animal.position.y, animal.position.z, 2);
        }
        await bot.useOn(animal);
        await new Promise(r => setTimeout(r, 500));
    }
    log(bot, `Bred 2 ${animalType}s.`);
    return true;
}

export async function organizeInventory(bot, chestType='chest') {
    const chest = world.getNearestBlock(bot, chestType, 8);
    if (!chest) { log(bot, 'No chest nearby.'); return false; }
    await goToPosition(bot, chest.position.x, chest.position.y, chest.position.z, 2);
    const items = bot.inventory.items().filter(i => i.slot < 36);
    for (const item of items) {
        try { await bot.transfer(item, chest, null); } catch(e) { console.warn('[Organize] Transfer failed:', e.message); }
        if (bot.interrupt_code) break;
    }
    log(bot, 'Inventory organized.');
    return true;
}

export async function buildNetherPortal(bot) {
    const count = bot.inventory.count('obsidian');
    if (count < 10) { log(bot, `Need 10 obsidian, have ${count}.`); return false; }
    const lighter = bot.inventory.findInventoryItem('flint_and_steel') || bot.inventory.findInventoryItem('fire_charge');
    if (!lighter) { log(bot, 'Need flint and steel or fire charge.'); return false; }
    const here = pos(bot).floored();
    for (let x = 0; x <= 3; x++) {
        for (let y = 0; y <= 4; y++) {
            if (x === 0 || x === 3 || y === 0 || y === 4)
                await placeBlock(bot, 'obsidian', here.x + x, here.y + y, here.z);
        }
    }
    await bot.equip(lighter, 'hand');
    const inside = bot.blockAt(here.offset(1, 1, 0));
    if (inside) await bot.placeBlock(inside, here.offset(1, 1, 0));
    await bot.activateItem();
    log(bot, 'Nether portal built.');
    return true;
}

export async function mlgWaterBucket(bot) {
    const bucket = bot.inventory.findInventoryItem('water_bucket');
    if (!bucket) { log(bot, 'No water bucket.'); return false; }
    if (bot.entity.velocity.y >= -0.5) return false;
    await bot.equip(bucket, 'hand');
    const below = bot.blockAt(bot.entity.position.offset(0, -2, 0));
    await bot.placeBlock(below || bot.entity.position, bot.entity.position);
    log(bot, 'MLG water bucket!');
    return true;
}

export async function cookAllFood(bot) {
    const furnace = world.getNearestBlock(bot, 'furnace', 8) || world.getNearestBlock(bot, 'blast_furnace', 8);
    if (!furnace) { log(bot, 'No furnace nearby.'); return false; }
    const foods = bot.inventory.items().filter(i => i.name.includes('raw_') || i.name === 'chicken' || i.name === 'beef' || i.name === 'porkchop' || i.name === 'mutton' || i.name === 'rabbit');
    const fuel = bot.inventory.findInventoryItem('coal') || bot.inventory.findInventoryItem('charcoal') || bot.inventory.findInventoryItem('oak_log');
    if (foods.length === 0) { log(bot, 'Nothing to cook.'); return false; }
    if (!fuel) { log(bot, 'No fuel.'); return false; }
    for (const food of foods) {
        try { await bot.openFurnace(furnace); await bot.putInFurnace(food, food.count); await bot.putInFurnace(fuel, 1); } catch(e) { console.warn('[CookAll] error:', e.message); continue; }
        if (bot.interrupt_code) break;
    }
    log(bot, `Cooking ${foods.length} foods.`);
    return true;
}

export async function farmExperience(bot, range=16) {
    const hostile = world.getNearbyEntities(bot, range).filter(e => e.name === 'zombie' || e.name === 'skeleton' || e.name === 'creeper' || e.name === 'spider');
    if (hostile.length === 0) { log(bot, 'No mobs to farm.'); return false; }
    for (const mob of hostile) {
        await equipHighestAttack(bot);
        await attackEntity(bot, mob, true);
        if (bot.interrupt_code) break;
    }
    return true;
}

export async function repairItem(bot, itemName) {
    const anvil = world.getNearestBlock(bot, 'anvil', 8) || world.getNearestBlock(bot, 'chipped_anvil', 8);
    if (!anvil) { log(bot, 'No anvil nearby.'); return false; }
    const item = bot.inventory.findInventoryItem(itemName);
    if (!item) { log(bot, `No ${itemName}.`); return false; }
    await goToPosition(bot, anvil.position.x, anvil.position.y, anvil.position.z, 2);
    try { await bot.openAnvil(anvil); log(bot, 'Anvil opened.'); } catch(e) { log(bot, 'Could not open anvil.'); }
    return true;
}

export async function shearSheep(bot) {
    const shears = bot.inventory.findInventoryItem('shears');
    if (!shears) { log(bot, 'No shears.'); return false; }
    const sheep = world.getNearestEntityWhere(bot, e => e.name === 'sheep' && !e.sheared, 8);
    if (!sheep) { log(bot, 'No unsheared sheep.'); return false; }
    await bot.equip(shears, 'hand');
    if (bot.entity.position.distanceTo(sheep.position) > 3)
        await goToPosition(bot, sheep.position.x, sheep.position.y, sheep.position.z, 2);
    await bot.useOn(sheep);
    log(bot, 'Sheared sheep.');
    return true;
}

export async function milkCow(bot) {
    const bucket = bot.inventory.findInventoryItem('bucket');
    if (!bucket) { log(bot, 'No bucket.'); return false; }
    const cow = world.getNearestEntityWhere(bot, e => e.name === 'cow', 8);
    if (!cow) { log(bot, 'No cow nearby.'); return false; }
    await bot.equip(bucket, 'hand');
    if (bot.entity.position.distanceTo(cow.position) > 3)
        await goToPosition(bot, cow.position.x, cow.position.y, cow.position.z, 2);
    await bot.useOn(cow);
    log(bot, 'Got milk!');
    return true;
}

export async function goFishing(bot, casts=5) {
    const rod = bot.inventory.findInventoryItem('fishing_rod');
    if (!rod) { log(bot, 'No fishing rod.'); return false; }
    await bot.equip(rod, 'hand');
    for (let i = 0; i < casts; i++) {
        try {
            await bot.fish();
            await pickupNearbyItems(bot);
        } catch(e) { console.warn('[Fish] cast error:', e.message); break; }
        if (bot.interrupt_code) break;
    }
    return true;
}

export async function compostItems(bot) {
    const composter = world.getNearestBlock(bot, 'composter', 8);
    if (!composter) { log(bot, 'No composter.'); return false; }
    const compostable = bot.inventory.items().filter(i => i.name.includes('wheat') || i.name.includes('seeds') || i.name.includes('leaves') || i.name.includes('sapling') || i.name.includes('flower') || i.name.includes('grass') || i.name === 'rotten_flesh');
    if (compostable.length === 0) { log(bot, 'Nothing to compost.'); return false; }
    await goToPosition(bot, composter.position.x, composter.position.y, composter.position.z, 2);
    let done = 0;
    for (const item of compostable.slice(0, 10)) {
        try {
            await bot.equip(item, 'hand');
            await bot.placeBlock(composter, composter.position.offset(0, 1, 0));
            done++;
        } catch(e) { console.warn('[Compost] error:', e.message); continue; }
        if (bot.interrupt_code) break;
    }
    log(bot, `Composted ${done} items.`);
    return done > 0;
}

export async function lightSurroundings(bot, radius=8) {
    const torches = bot.inventory.findInventoryItem('torch') || bot.inventory.findInventoryItem('soul_torch');
    if (!torches) { log(bot, 'No torches.'); return false; }
    const here = pos(bot).floored();
    let placed = 0;
    for (let x = -radius; x <= radius; x += 3) {
        for (let z = -radius; z <= radius; z += 3) {
            const check = here.offset(x, 0, z);
            const block = bot.blockAt(check);
            if (block && block.name === 'air' && block.light < 8) {
                const below = bot.blockAt(check.offset(0, -1, 0));
                if (below && below.name !== 'air' && below.name !== 'water' && below.name !== 'lava') {
                    await placeBlock(bot, torches.name, check.x, check.y, check.z);
                    placed++;
                }
            }
            if (bot.interrupt_code) break;
        }
        if (bot.interrupt_code) break;
    }
    log(bot, `Placed ${placed} torches.`);
    return placed > 0;
}

export async function buildBridge(bot, length=10, direction=null) {
    const start = pos(bot).floored();
    if (!direction) direction = bot.entity.yaw;
    const forward = new Vec3(-Math.sin(direction), 0, Math.cos(direction));
    const mat = bot.inventory.items().find(i => i.name.includes('planks') || i.name.includes('stone') || i.name === 'cobblestone');
    if (!mat) { log(bot, 'No building material.'); return false; }
    for (let i = 0; i < length; i++) {
        const bridgePos = start.plus(forward.scaled(i)).offset(0, -1, 0);
        if (bot.blockAt(bridgePos)?.name === 'air') {
            await placeBlock(bot, mat.name, bridgePos.x, bridgePos.y, bridgePos.z);
            if (i > 0 && i < length - 1) {
                const left = bridgePos.plus(new Vec3(forward.z, 0, -forward.x));
                const right = bridgePos.plus(new Vec3(-forward.z, 0, forward.x));
                if (bot.blockAt(left)?.name === 'air') await placeBlock(bot, mat.name, left.x, left.y, left.z);
                if (bot.blockAt(right)?.name === 'air') await placeBlock(bot, mat.name, right.x, right.y, right.z);
            }
        }
        if (bot.interrupt_code) break;
    }
    return true;
}

export async function harvestNearbyTrees(bot, range=16) {
    const logs = world.getNearestBlocks(bot, [bot.registry.blocksByName.log, bot.registry.blocksByName.oak_log, bot.registry.blocksByName.birch_log, bot.registry.blocksByName.spruce_log, bot.registry.blocksByName.jungle_log, bot.registry.blocksByName.acacia_log, bot.registry.blocksByName.dark_oak_log], range).filter(b => bot.entity.position.distanceTo(b.position) < range);
    if (logs.length === 0) { log(bot, 'No trees nearby.'); return false; }
    let chopped = 0;
    for (const log of logs) {
        await goToPosition(bot, log.position.x, log.position.y, log.position.z, 4);
        await breakBlockAt(bot, log.position.x, log.position.y, log.position.z);
        chopped++;
        await pickupNearbyItems(bot);
        if (bot.interrupt_code || chopped > 20) break;
    }
    log(bot, `Chopped ${chopped} logs.`);
    return chopped > 0;
}

export async function plantSaplings(bot, count=5) {
    const sapling = bot.inventory.items().find(i => i.name.includes('sapling'));
    if (!sapling) { log(bot, 'No saplings.'); return false; }
    const here = pos(bot).floored();
    let planted = 0;
    for (let i = 0; i < count; i++) {
        const p = new Vec3(here.x + Math.floor(Math.random()*5-2), here.y, here.z + Math.floor(Math.random()*5-2));
        if (bot.blockAt(p)?.name === 'air' && bot.blockAt(p.offset(0, -1, 0))?.name !== 'air') {
            await placeBlock(bot, sapling.name, p.x, p.y, p.z);
            planted++;
        }
        if (bot.interrupt_code) break;
    }
    log(bot, `Planted ${planted} ${sapling.name}s.`);
    return planted > 0;
}

export async function enchantItem(bot, itemName) {
    const table = world.getNearestBlock(bot, 'enchanting_table', 8);
    if (!table) { log(bot, 'No enchanting table.'); return false; }
    const item = bot.inventory.findInventoryItem(itemName);
    if (!item) { log(bot, `No ${itemName}.`); return false; }
    const lapis = bot.inventory.findInventoryItem('lapis_lazuli');
    if (!lapis) { log(bot, 'No lapis lazuli.'); return false; }
    await goToPosition(bot, table.position.x, table.position.y, table.position.z, 2);
    try { await bot.openEnchantmentTable(table); log(bot, 'Enchanting table opened.'); } catch(e) { log(bot, 'Could not open table.'); return false; }
    return true;
}

export async function cureZombieVillager(bot) {
    const potions = bot.inventory.items().filter(i => i.name.includes('splash_potion') && i.name.includes('weakness'));
    const weakness = potions[0];
    const apple = bot.inventory.findInventoryItem('golden_apple');
    if (!weakness) { log(bot, 'Need weakness splash potion.'); return false; }
    if (!apple) { log(bot, 'Need golden apple.'); return false; }
    const zombie = world.getNearestEntityWhere(bot, e => e.name === 'zombie_villager', 8);
    if (!zombie) { log(bot, 'No zombie villager nearby.'); return false; }
    await bot.equip(weakness, 'hand');
    if (bot.entity.position.distanceTo(zombie.position) > 4)
        await goToPosition(bot, zombie.position.x, zombie.position.y, zombie.position.z, 3);
    await bot.useOn(zombie);
    await new Promise(r => setTimeout(r, 500));
    await bot.equip(apple, 'hand');
    if (bot.entity.position.distanceTo(zombie.position) > 4)
        await goToPosition(bot, zombie.position.x, zombie.position.y, zombie.position.z, 3);
    await bot.useOn(zombie);
    log(bot, 'Cured zombie villager!');
    return true;
}

export async function interactWithEntity(bot, entityName) {
    const target = entityName.toLowerCase();
    const entity = bot.nearestEntity(e =>
        e.name?.toLowerCase() === target ||
        e.username?.toLowerCase() === target ||
        (e.displayName && e.displayName.toLowerCase() === target) ||
        (e.metadata?.[2]?.toString?.().replace(/§./g, '').toLowerCase().trim() === target)
    );
    if (!entity) {
        log(bot, `Can't see ${entityName} nearby.`);
        return { success: false, reason: 'not_found' };
    }
    const dist = bot.entity.position.distanceTo(entity.position);
    if (dist > 4) {
        await goToPosition(bot, entity.position.x, entity.position.y, entity.position.z, 3);
    }
    await bot.lookAt(entity.position.offset(0, 1, 0));
    await bot.waitForTicks(5);
    try {
        bot.activateEntity(entity);
    } catch (e) {
        try {
            await bot.useOn(entity);
        } catch (e2) {
            return { success: false, reason: 'interact_failed', error: e2.message };
        }
    }
    await bot.waitForTicks(5);
    return new Promise(resolve => {
        const timeout = setTimeout(() => {
            resolve({ success: true, window: null, reason: 'interacted_no_gui' });
        }, 1500);
        bot.once('windowOpen', window => {
            clearTimeout(timeout);
            resolve({ success: true, window, reason: 'gui_opened' });
        });
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// EXPERT PLAYER SKILLS — based on speedrunner/pro techniques
// ══════════════════════════════════════════════════════════════════════════════

export async function organizeHotbar(bot) {
    /**
     * Organize hotbar by expert priority slots:
     * Slot 1: Best sword (primary weapon)
     * Slot 2: Best pickaxe (mining, pillar escapes)
     * Slot 3: Axe or shovel (utility)
     * Slot 4: Bow (ranged)
     * Slot 5: Food (cooked)
     * Slot 6: Blocks (64 stack for pillaring/bridging)
     * Slot 7: Water bucket (fall/lava safety)
     * Slot 8: Torches (lighting)
     * Slot 9: Shield or ender pearls
     * Uses creative-mode inventory manipulation (survival slot swapping).
     **/
    const items = bot.inventory.items();
    if (!items.length) return false;

    const HOTBAR_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8]; // hotbar is slots 36-44

    // Priority categorization
    const categorize = (name) => {
        if (/_sword/.test(name)) return 0;      // slot 1
        if (/_pickaxe/.test(name)) return 1;     // slot 2
        if (/_axe/.test(name) || /shovel/.test(name)) return 2; // slot 3
        if (name === 'bow') return 3;            // slot 4
        if (/apple|bread|cooked|steak|pork|potato|carrot|beetroot|golden|mutton|rabbit|fish|beef|chicken|berry|melon|stew|soup|honey|cookie/.test(name)) return 4; // slot 5
        if (/^stone$|^cobblestone$|^dirt$|^grass_block$|^sand$|^gravel$|^netherrack$|^deepslate$|^cobbleslate$/.test(name)) return 5; // slot 6
        if (name === 'water_bucket') return 6;    // slot 7
        if (name === 'torch') return 7;           // slot 8
        if (/shield|ender_pearl/.test(name)) return 8; // slot 9
        return -1;
    };

    // Get best item per category (prefer higher tier)
    const tierOrder = ['netherite_', 'diamond_', 'iron_', 'stone_', 'wooden_'];
    const getBestItem = (category) => {
        const candidates = items.filter(i => categorize(i.name) === category);
        if (!candidates.length) return null;
        // Sort by tier
        candidates.sort((a, b) => {
            const aTier = tierOrder.findIndex(t => a.name.startsWith(t));
            const bTier = tierOrder.findIndex(t => b.name.startsWith(t));
            return (aTier === -1 ? 99 : aTier) - (bTier === -1 ? 99 : bTier);
        });
        return candidates[0];
    };

    let moved = 0;
    for (let slot = 0; slot < 9; slot++) {
        const targetSlot = 36 + slot; // hotbar slots in inventory
        const current = bot.inventory.slots[targetSlot];
        const desired = getBestItem(slot);
        if (!desired) continue;
        if (current && current.name === desired.name) continue; // already there

        try {
            await bot.clickWindow(desired.slot, 0, 0); // pick up
            if (current) {
                await bot.clickWindow(current.slot, 0, 0); // swap
            }
            await bot.clickWindow(targetSlot, 0, 0); // place in hotbar
            moved++;
        } catch (_) {}
    }

    if (moved > 0) log(bot, `Organized hotbar: moved ${moved} items.`);
    return moved > 0;
}

export async function placeTorchNearby(bot, radius = 6) {
    /**
     * Place a torch nearby to prevent mob spawns.
     * Expert players place torches every 13 blocks for spawn-proofing.
     * Light level 8+ prevents hostile spawns (Java 1.18+).
     **/
    const torch = bot.inventory.items().find(i => i.name === 'torch');
    if (!torch) return false;

    // Find a suitable placement spot: wall or floor within radius
    const pos2 = bot.entity.position;
    const directions = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [2, 0], [-2, 0], [0, 2], [0, -2],
    ];

    for (const [dx, dz] of directions) {
        const checkPos = pos2.offset(dx, 0, dz);
        const block = bot.blockAt(checkPos);
        if (!block) continue;

        // Place on wall (side of a solid block)
        const below = bot.blockAt(checkPos.offset(0, -1, 0));
        if (below && below.name !== 'air' && below.name !== 'water' && below.name !== 'lava') {
            // Check light level is low enough to warrant a torch
            if ((block.light || 0) < 8) {
                try {
                    await placeBlock(bot, 'torch', checkPos.x, checkPos.y, checkPos.z);
                    return true;
                } catch (_) {}
            }
        }
    }
    return false;
}

export async function sprintJumpTo(bot, x, y, z, range = 2) {
    /**
     * Sprint-jump to a distant location. Expert players sprint-jump everywhere
     * because it's 20% faster than walking (5.612 m/s vs 4.317 m/s).
     * Sprint-jumping costs hunger but saves time.
     **/
    const p = bot.entity.position;
    const dist = Math.sqrt((x - p.x) ** 2 + (z - p.z) ** 2);

    // Only sprint-jump for long distances (>16 blocks)
    if (dist < 16) {
        return await goToPosition(bot, x, y, z, range);
    }

    // Enable sprint + jump for faster travel
    bot.setControlState('sprint', true);

    // Use pathfinder but with sprint enabled
    try {
        await goToPosition(bot, x, y, z, range);
    } catch (_) {}

    bot.setControlState('sprint', false);
    bot.setControlState('jump', false);
    return true;
}

export async function autoTorchMine(bot, direction, length = 20) {
    /**
     * Strip mine with automatic torch placement every 8 blocks.
     * Expert miners place torches on the RIGHT wall going in
     * (so they always know which way is "out" by keeping torches on left coming back).
     **/
    const start = pos(bot).floored();
    const forward = new Vec3(-Math.sin(direction), 0, Math.cos(direction));
    const right = new Vec3(Math.cos(direction), 0, Math.sin(direction));

    for (let i = 0; i < length; i++) {
        if (bot.interrupt_code) break;

        const target = start.plus(forward.scaled(i));
        const block = bot.blockAt(target);
        if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'water') {
            try { await equipHighestAttack(bot); } catch (_) {}
            try { await bot.dig(block); } catch (_) {}
            try { await pickupNearbyItems(bot); } catch (_) {}
            await new Promise(r => setTimeout(r, 200 + Math.random() * 400));
        }

        // Place torch every 8 blocks on the right wall
        if (i > 0 && i % 8 === 0) {
            const torchPos = target.plus(right);
            const torchBlock = bot.blockAt(torchPos);
            if (torchBlock && torchBlock.name === 'air') {
                const torchItem = bot.inventory.items().find(i => i.name === 'torch');
                if (torchItem) {
                    try { await placeBlock(bot, 'torch', torchPos.x, torchPos.y, torchPos.z); } catch (_) {}
                }
            }
        }

        // Pickup items after mining
        if (i % 5 === 0) {
            try { await pickupNearbyItems(bot); } catch (_) {}
        }
    }

    log(bot, `Strip mined ${length} blocks with torch lighting.`);
    return true;
}

/**
 * Branch mining — the most efficient mining method (pro player standard).
 * Digs a main corridor then branches every 3 blocks.
 * @param {MinecraftBot} bot
 * @param {object} params - { targetY, mainLength, branchLength, direction }
 * @returns {Promise<boolean>}
 */
export async function branchMine(bot, params = {}) {
    const targetY = params.targetY ?? -59;
    const mainLength = params.mainLength ?? 50;
    const branchLength = params.branchLength ?? 20;
    const direction = params.direction ?? bot.entity.yaw;

    log(bot, `Starting branch mine at Y=${targetY}, main=${mainLength}, branches=${branchLength}`);

    // First navigate to target Y level
    const botY = bot.entity.position.y;
    if (Math.abs(botY - targetY) > 3) {
        log(bot, `Navigating to Y=${targetY}...`);
        try {
            // Dig staircase down to target Y
            const diff = botY - targetY;
            const steps = Math.abs(diff);
            for (let i = 0; i < steps; i++) {
                if (bot.interrupt_code) break;
                // Dig 2 blocks forward + 1 up = staircase down
                const forward = bot.entity.position.offset(
                    -Math.sin(direction), 0, -Math.cos(direction)
                );
                const headBlock = bot.blockAt(forward.offset(0, 1, 0));
                const feetBlock = bot.blockAt(forward);
                if (feetBlock && bot.canDigBlock(feetBlock)) await bot.dig(feetBlock);
                if (headBlock && bot.canDigBlock(headBlock)) await bot.dig(headBlock);
                // Dig one more down for staircase step
                const below = bot.entity.position.offset(0, -1, 0);
                const belowBlock = bot.blockAt(below);
                if (belowBlock && bot.canDigBlock(belowBlock)) await bot.dig(belowBlock);
                await new Promise(r => setTimeout(r, 100));
            }
        } catch (_) {}
    }

    // Main corridor
    log(bot, `Digging main corridor at Y=${Math.round(bot.entity.position.y)}`);
    const mainBlocks = await digTunnel(bot, mainLength, direction);

    // Branch tunnels every 3 blocks
    const branches = Math.floor(mainLength / 3);
    for (let b = 0; b < branches; b++) {
        if (bot.interrupt_code) break;

        // Move back to branch start
        const branchStart = bot.entity.position.offset(
            Math.sin(direction) * b * 3, 0, Math.cos(direction) * b * 3
        );
        try { await goToPosition(bot, branchStart.x, branchStart.y, branchStart.z, 1, 3000); } catch (_) {}

        // Dig branch to the left (perpendicular)
        const leftDir = direction + Math.PI / 2;
        await digTunnel(bot, branchLength, leftDir);

        // Return to main corridor
        try { await goToPosition(bot, branchStart.x, branchStart.y, branchStart.z, 1, 3000); } catch (_) {}

        // Dig branch to the right
        const rightDir = direction - Math.PI / 2;
        await digTunnel(bot, branchLength, rightDir);

        // Place torch every branch
        try {
            const torchPos = bot.entity.position.offset(0, 1, 0);
            const torchBlock = bot.blockAt(torchPos);
            if (torchBlock && torchBlock.name === 'air') {
                const torchItem = bot.inventory.items().find(i => i.name === 'torch');
                if (torchItem) {
                    await bot.equip(torchItem, 'hand');
                    await placeBlock(bot, 'torch', torchPos.x, torchPos.y, torchPos.z);
                }
            }
        } catch (_) {}

        // Collect dropped items
        try { await pickupNearbyItems(bot); } catch (_) {}
    }

    log(bot, `Branch mining complete: ${mainBlocks} main + ${branches} branches`);
    return true;
}

/**
 * Dig a straight tunnel in given direction.
 * @returns {number} blocks dug
 */
async function digTunnel(bot, length, direction) {
    let dug = 0;
    for (let i = 0; i < length; i++) {
        if (bot.interrupt_code) break;

        // Dig 1 wide, 2 tall tunnel
        const forward = bot.entity.position.offset(
            -Math.sin(direction) * (i + 1), 0, -Math.cos(direction) * (i + 1)
        );

        // Feet level
        const feetBlock = bot.blockAt(forward);
        if (feetBlock && bot.canDigBlock(feetBlock)) {
            try { await bot.dig(feetBlock); dug++; } catch (_) {}
        }

        // Head level
        const headBlock = bot.blockAt(forward.offset(0, 1, 0));
        if (headBlock && bot.canDigBlock(headBlock)) {
            try { await bot.dig(headBlock); } catch (_) {}
        }

        // Place torch every 12 blocks (pro player standard)
        if (i % 12 === 0 && i > 0) {
            try {
                const torchPos = forward.offset(0, 1, 0);
                const torchBlock = bot.blockAt(torchPos);
                if (torchBlock && torchBlock.name === 'air') {
                    const torchItem = bot.inventory.items().find(i => i.name === 'torch');
                    if (torchItem) {
                        await bot.equip(torchItem, 'hand');
                        await placeBlock(bot, 'torch', torchPos.x, torchPos.y, torchPos.z);
                    }
                }
            } catch (_) {}
        }

        // Collect items every 5 blocks
        if (i % 5 === 0) {
            try { await pickupNearbyItems(bot); } catch (_) {}
        }

        await new Promise(r => setTimeout(r, 50));
    }
    return dug;
}

/**
 * Pillar up — jump and place block under feet (pro player escape technique).
 * @param {MinecraftBot} bot
 * @param {number} height - blocks to pillar up (default 10)
 * @returns {Promise<boolean>}
 */
export async function pillarUp(bot, height = 10) {
    log(bot, `Pillaring up ${height} blocks...`);

    for (let i = 0; i < height; i++) {
        if (bot.interrupt_code) break;

        // Find a block to place (cobblestone, dirt, stone, anything)
        const blockItem = bot.inventory.items().find(item =>
            item.name === 'cobblestone' || item.name === 'dirt' ||
            item.name === 'stone' || item.name === 'andesite' ||
            item.name === 'granite' || item.name === 'diorite'
        );

        if (!blockItem) {
            log(bot, 'No blocks to pillar with!');
            return false;
        }

        await bot.equip(blockItem, 'hand');

        // Jump and place block under us
        bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 100));
        bot.setControlState('jump', false);
        await new Promise(r => setTimeout(r, 150));

        // Place block at feet level
        try {
            const feetBlock = bot.blockAt(bot.entity.position.offset(0, -0.5, 0));
            if (feetBlock) {
                await bot.placeBlock(feetBlock, { x: 0, y: 1, z: 0 });
            }
        } catch (_) {
            // If placement fails, try looking down
            try {
                await bot.look(bot.entity.yaw, Math.PI / 2, false);
                await new Promise(r => setTimeout(r, 100));
                const feetBlock = bot.blockAt(bot.entity.position.offset(0, -0.5, 0));
                if (feetBlock) {
                    await bot.placeBlock(feetBlock, { x: 0, y: 1, z: 0 });
                }
            } catch (_) {}
        }

        await new Promise(r => setTimeout(r, 200));
    }

    log(bot, `Pillared up to Y=${Math.round(bot.entity.position.y)}`);
    return true;
}

/**
 * Staircase up — dig staircase pattern to escape caves (pro player technique).
 * safer than pillar up because you can always climb back down.
 * @param {MinecraftBot} bot
 * @param {number} targetY - target Y level (default: surface ~100)
 * @returns {Promise<boolean>}
 */
export async function staircaseUp(bot, targetY = 100) {
    const botY = bot.entity.position.y;
    if (botY >= targetY) {
        log(bot, `Already at Y=${Math.round(botY)}, no need to staircase up`);
        return true;
    }

    log(bot, `Staircasing up from Y=${Math.round(botY)} to Y=${targetY}`);
    const stepsNeeded = targetY - botY;

    for (let i = 0; i < stepsNeeded; i++) {
        if (bot.interrupt_code) break;

        // Dig 2 blocks forward + 1 up = staircase
        const direction = bot.entity.yaw;
        const forward = bot.entity.position.offset(
            -Math.sin(direction), 0, -Math.cos(direction)
        );

        // Dig feet level
        const feetBlock = bot.blockAt(forward);
        if (feetBlock && bot.canDigBlock(feetBlock)) {
            try { await bot.dig(feetBlock); } catch (_) {}
        }

        // Dig head level
        const headBlock = bot.blockAt(forward.offset(0, 1, 0));
        if (headBlock && bot.canDigBlock(headBlock)) {
            try { await bot.dig(headBlock); } catch (_) {}
        }

        // Dig one more up for headroom
        const aboveBlock = bot.blockAt(forward.offset(0, 2, 0));
        if (aboveBlock && bot.canDigBlock(aboveBlock)) {
            try { await bot.dig(aboveBlock); } catch (_) {}
        }

        // Walk forward onto the step
        bot.setControlState('forward', true);
        await new Promise(r => setTimeout(r, 200));
        bot.setControlState('forward', false);

        // Place torch every 8 steps
        if (i % 8 === 0) {
            try {
                const torchItem = bot.inventory.items().find(i => i.name === 'torch');
                if (torchItem) {
                    await bot.equip(torchItem, 'hand');
                    const torchPos = bot.entity.position.offset(0, 1, 0);
                    await placeBlock(bot, 'torch', torchPos.x, torchPos.y, torchPos.z);
                }
            } catch (_) {}
        }

        await new Promise(r => setTimeout(r, 100));
    }

    log(bot, `Staircased up to Y=${Math.round(bot.entity.position.y)}`);
    return true;
}

/**
 * Escape cave — combines pillar-up + staircase to reach surface.
 * Pro player strategy: pillar up to get bearings, then staircase to surface.
 * @param {MinecraftBot} bot
 * @returns {Promise<boolean>}
 */
export async function escapeCave(bot) {
    log(bot, 'Escaping cave...');

    // Step 1: Check if we can see sky (not underground)
    const skyBlock = bot.blockAt(bot.entity.position.offset(0, 5, 0));
    if (skyBlock && skyBlock.name === 'air') {
        log(bot, 'Sky visible — not trapped underground');
        return true;
    }

    // Step 2: Pillar up 5 blocks to get higher
    await pillarUp(bot, 5);

    // Step 3: Check again
    const skyBlock2 = bot.blockAt(bot.entity.position.offset(0, 5, 0));
    if (skyBlock2 && skyBlock2.name === 'air') {
        log(bot, 'Reached open area after pillaring');
        return true;
    }

    // Step 4: Staircase to surface
    await staircaseUp(bot, 100);

    log(bot, `Escaped cave to Y=${Math.round(bot.entity.position.y)}`);
    return true;
}

// ═══════════════════════════════════════════════════════════════════
// INVENTORY OPTIMIZATION — Pro Player Item Management
// ═══════════════════════════════════════════════════════════════════

const FOOD_TIERS = {
    golden_carrot: 1, suspicious_stew: 1,
    steak: 2, cooked_beef: 2, cooked_porkchop: 2, cooked_mutton: 2,
    cooked_chicken: 3, cooked_rabbit: 3, rabbit_stew: 3,
    bread: 3, baked_potato: 3,
    cooked_salmon: 4, cooked_cod: 4,
    apple: 5, mushroom_stew: 5, beetroot_soup: 5,
    cookie: 6, melon_slice: 6, sweet_berries: 6,
    raw_beef: 7, raw_porkchop: 7, raw_mutton: 7, raw_chicken: 7,
    rotten_flesh: 8, poisonous_potato: 8,
};

const TOOL_TIERS = {
    wooden: 0, stone: 1, iron: 2, golden: 3, diamond: 4, netherite: 5,
};

const BLOCK_MINING_LEVEL = {
    cobblestone: 0, coal_ore: 0, deepslate: 0,
    iron_ore: 1, copper_ore: 1, raw_iron: 1,
    gold_ore: 2, redstone_ore: 2, emerald_ore: 2, lapis_ore: 2, diamond_ore: 2,
    obsidian: 3, ancient_debris: 3, crying_obsidian: 3,
};

const JUNK_STACK_LIMITS = {
    cobblestone: 128, dirt: 64, gravel: 32, andesite: 32, diorite: 32,
    granite: 32, netherrack: 0, tuff: 32, deepslate: 64,
    rotten_flesh: 64, string: 64, feather: 32, flint: 16,
};

const ESSENTIAL_ITEMS = [
    'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'netherite_pickaxe',
    'diamond_sword', 'iron_sword', 'stone_sword', 'netherite_sword',
    'diamond_axe', 'iron_axe', 'netherite_axe',
    'shield', 'bow', 'crossbow', 'trident',
    'water_bucket', 'lava_bucket', 'ender_pearl', 'elytra',
    'totem_of_undying', 'golden_apple', 'enchanted_golden_apple',
    'crafting_table', 'furnace',
];

let _lastDropTime = {};

/**
 * Select best food from inventory by saturation hierarchy.
 * @param {MinecraftBot} bot
 * @returns {Item|null}
 */
export function selectBestFood(bot) {
    const foods = bot.inventory.items().filter(i => FOOD_TIERS[i.name] != null);
    if (foods.length === 0) return null;
    foods.sort((a, b) => (FOOD_TIERS[a.name] || 99) - (FOOD_TIERS[b.name] || 99));
    return foods[0];
}

/**
 * Select best tool for a given block, respecting mining level requirements.
 * @param {MinecraftBot} bot
 * @param {Block} block
 * @returns {Item|null}
 */
export function selectBestTool(bot, block) {
    if (!block) return null;
    const requiredLevel = BLOCK_MINING_LEVEL[block.name] ?? 0;
    const isWood = block.name.includes('log') || block.name.includes('leaves');

    let toolType;
    if (isWood) toolType = 'axe';
    else if (block.name.includes('sand') || block.name.includes('clay') || block.name === 'gravel' || block.name === 'dirt' || block.name === 'grass_block' || block.name === 'farmland' || block.name === 'soul_sand' || block.name === 'soul_soil')
        toolType = 'shovel';
    else toolType = 'pickaxe';

    const candidates = bot.inventory.items().filter(i => i.name.includes(toolType));
    const valid = candidates.filter(i => {
        const tier = Object.entries(TOOL_TIERS).find(([k]) => i.name.includes(k))?.[1] ?? -1;
        return tier >= requiredLevel;
    });

    if (valid.length === 0) {
        return candidates[0] || null;
    }

    valid.sort((a, b) => {
        const tierA = Object.entries(TOOL_TIERS).find(([k]) => a.name.includes(k))?.[1] ?? 0;
        const tierB = Object.entries(TOOL_TIERS).find(([k]) => b.name.includes(k))?.[1] ?? 0;
        if (tierA !== tierB) return tierB - tierA;
        const duraA = a.durabilityLeft != null ? a.durabilityLeft / a.maxDurability : 1;
        const duraB = b.durabilityLeft != null ? b.durabilityLeft / b.maxDurability : 1;
        return duraB - duraA;
    });

    return valid[0];
}

/**
 * Auto-equip best armor for each slot.
 * @param {MinecraftBot} bot
 * @returns {Promise<number>} number of items equipped
 */
export async function autoEquipBestArmor(bot) {
    log(bot, 'Auto-equipping best armor...');
    const armorSlots = ['head', 'torso', 'legs', 'feet'];
    let equipped = 0;

    const tierScore = { netherite: 6, diamond: 5, iron: 4, chainmail: 3, golden: 2, leather: 1 };

    for (const slot of armorSlots) {
        const current = bot.inventory.slots[bot.getEquipmentDestSlot(slot)];
        const currentScore = current ? (tierScore[Object.keys(tierScore).find(k => current.name.includes(k)) || ''] || 0) : -1;

        const candidates = bot.inventory.items().filter(i => {
            if (slot === 'head' && !i.name.includes('helmet')) return false;
            if (slot === 'torso' && !i.name.includes('chestplate')) return false;
            if (slot === 'legs' && !i.name.includes('leggings')) return false;
            if (slot === 'feet' && !i.name.includes('boots')) return false;
            return true;
        });

        let best = null;
        let bestScore = currentScore;

        for (const item of candidates) {
            let score = tierScore[Object.keys(tierScore).find(k => item.name.includes(k)) || ''] || 0;
            if (item.enchantments) {
                for (const ench of Object.values(item.enchantments)) {
                    if (ench.name === 'protection') score += 2;
                    if (ench.name === 'mending') score += 1;
                    if (ench.name === 'unbreaking') score += 0.5;
                }
            }
            if (score > bestScore) {
                bestScore = score;
                best = item;
            }
        }

        if (best) {
            try {
                await bot.equip(best, slot);
                equipped++;
            } catch (_) {}
        }
    }

    log(bot, `Auto-equipped ${equipped} armor pieces.`);
    return equipped;
}

/**
 * Consolidate inventory — merge partial stacks of same item.
 * @param {MinecraftBot} bot
 * @returns {Promise<number>} slots freed
 */
export async function consolidateInventory(bot) {
    log(bot, 'Consolidating inventory stacks...');
    const items = bot.inventory.items();
    const groups = {};

    for (const item of items) {
        if (!groups[item.name]) groups[item.name] = [];
        groups[item.name].push(item);
    }

    let freed = 0;
    for (const [name, group] of Object.entries(groups)) {
        if (group.length < 2) continue;
        const maxStack = group[0].stackSize;
        if (maxStack <= 1) continue;

        let total = group.reduce((sum, i) => sum + i.count, 0);
        const fullStacks = Math.floor(total / maxStack);

        for (let i = 0; i < group.length; i++) {
            if (i < fullStacks) {
                if (group[i].count < maxStack) {
                    const deficit = maxStack - group[i].count;
                    for (let j = group.length - 1; j > i; j--) {
                        if (group[j].count <= 0) continue;
                        const transfer = Math.min(deficit, group[j].count);
                        try {
                            await bot.clickWindow(group[j].slot, 0, 0);
                            await bot.clickWindow(group[i].slot, 0, 0);
                            if (transfer < group[j].count) {
                                await bot.clickWindow(group[j].slot, 0, 0);
                            }
                            freed++;
                        } catch (_) {}
                        break;
                    }
                }
            } else if (i > fullStacks) {
                try {
                    await bot.tossStack(group[i]);
                    freed++;
                } catch (_) {}
            }
        }
    }

    log(bot, `Consolidated inventory, freed ${freed} slots.`);
    return freed;
}

/**
 * Cleanup inventory — drop junk items with cooldown protection.
 * @param {MinecraftBot} bot
 * @returns {Promise<number>} items dropped
 */
export async function cleanupInventory(bot) {
    log(bot, 'Cleaning up inventory...');
    let dropped = 0;
    const now = Date.now();

    for (const item of bot.inventory.items()) {
        if (ESSENTIAL_ITEMS.some(e => item.name.includes(e))) continue;
        if (FOOD_TIERS[item.name] != null && FOOD_TIERS[item.name] < 7) continue;
        if (item.name.includes('sword') || item.name.includes('pickaxe') ||
            item.name.includes('axe') || item.name.includes('shovel') ||
            item.name.includes('helmet') || item.name.includes('chestplate') ||
            item.name.includes('leggings') || item.name.includes('boots')) continue;
        if (item.enchantments && Object.keys(item.enchantments).length > 0) continue;

        const limit = JUNK_STACK_LIMITS[item.name];
        if (limit === undefined) continue;

        const totalCount = bot.inventory.items()
            .filter(i => i.name === item.name)
            .reduce((sum, i) => sum + i.count, 0);

        if (totalCount <= limit) continue;
        if (_lastDropTime[item.name] && now - _lastDropTime[item.name] < 60000) continue;

        try {
            await bot.tossStack(item);
            _lastDropTime[item.name] = now;
            dropped++;
        } catch (_) {}
    }

    log(bot, `Dropped ${dropped} junk items.`);
    return dropped;
}

/**
 * Smart organize — context-aware hotbar + consolidate + cleanup.
 * @param {MinecraftBot} bot
 * @param {string} mode - 'mining', 'combat', 'building', 'farming', 'general'
 * @returns {Promise<boolean>}
 */
export async function smartOrganize(bot, mode = 'general') {
    log(bot, `Smart organizing inventory (mode: ${mode})...`);

    const presets = {
        mining: [
            i => /pickaxe/.test(i.name),
            i => /shovel/.test(i.name),
            i => /axe/.test(i.name),
            i => /sword/.test(i.name),
            i => i.name === 'torch',
            i => FOOD_TIERS[i.name] != null && FOOD_TIERS[i.name] < 7,
            i => /^(cobblestone|dirt|stone|deepslate)$/.test(i.name),
            i => i.name === 'water_bucket',
            i => i.name === 'crafting_table',
        ],
        combat: [
            i => /axe/.test(i.name),
            i => /sword/.test(i.name),
            i => i.name === 'bow' || i.name === 'crossbow',
            i => i.name === 'golden_apple',
            i => FOOD_TIERS[i.name] != null && FOOD_TIERS[i.name] < 7,
            i => i.name === 'ender_pearl',
            i => i.name === 'shield',
            i => /^(cobblestone|dirt|stone|deepslate)$/.test(i.name),
            i => i.name === 'totem_of_undying',
        ],
        building: [
            i => /axe/.test(i.name),
            i => /pickaxe/.test(i.name),
            i => /^(oak_planks|spruce_planks|birch_planks|cobblestone|stone_bricks)$/.test(i.name),
            i => /^(oak_slab|spruce_slab|cobblestone_slab)$/.test(i.name),
            i => /^(oak_stairs|spruce_stairs|cobblestone_stairs)$/.test(i.name),
            i => i.name === 'torch',
            i => FOOD_TIERS[i.name] != null && FOOD_TIERS[i.name] < 7,
            i => /^(cobblestone|dirt)$/.test(i.name),
            i => i.name === 'crafting_table',
        ],
        farming: [
            i => i.name.includes('hoe'),
            i => /axe/.test(i.name),
            i => /shovel/.test(i.name),
            i => i.name === 'bone_meal',
            i => i.name.includes('seed') || i.name.includes('wheat'),
            i => FOOD_TIERS[i.name] != null && FOOD_TIERS[i.name] < 7,
            i => i.name === 'water_bucket',
            i => /^(cobblestone|dirt)$/.test(i.name),
            i => i.name === 'crafting_table',
        ],
        general: [
            i => /sword/.test(i.name),
            i => /pickaxe/.test(i.name),
            i => /axe/.test(i.name),
            i => /shovel/.test(i.name),
            i => FOOD_TIERS[i.name] != null && FOOD_TIERS[i.name] < 7,
            i => i.name === 'torch',
            i => /^(cobblestone|dirt|stone|deepslate)$/.test(i.name),
            i => i.name === 'water_bucket',
            i => i.name === 'crafting_table',
        ],
    };

    const hotbarPredicates = presets[mode] || presets.general;
    const inventory = bot.inventory.items();

    for (let slot = 0; slot < 9; slot++) {
        const current = bot.inventory.slots[slot + 36];
        if (current && hotbarPredicates[slot] && hotbarPredicates[slot](current)) continue;

        const hotbarItems = new Set();
        for (let h = 0; h < 9; h++) {
            const hi = bot.inventory.slots[h + 36];
            if (hi) hotbarItems.add(hi.name);
        }

        const item = inventory.find(i => hotbarPredicates[slot](i) && !hotbarItems.has(i.name));
        if (item) {
            try {
                await bot.clickWindow(item.slot, 0, 0);
                await bot.clickWindow(slot + 36, 0, 0);
            } catch (_) {}
        }
    }

    try { await autoEquipBestArmor(bot); } catch (_) {}
    try { await consolidateInventory(bot); } catch (_) {}
    if (bot.inventory.freeSlots() < 5) {
        try { await cleanupInventory(bot); } catch (_) {}
    }

    log(bot, `Smart organize complete (${mode}).`);
    return true;
}

/**
 * Pre-task inventory check — ensure enough space before starting collection.
 * @param {MinecraftBot} bot
 * @param {number} neededSlots - minimum free slots required
 * @returns {Promise<boolean>}
 */
export async function preTaskInventoryCheck(bot, neededSlots = 4) {
    const free = bot.inventory.freeSlots();
    if (free >= neededSlots) return true;

    log(bot, `Only ${free} free slots, need ${neededSlots}. Running cleanup...`);
    await consolidateInventory(bot);
    if (bot.inventory.freeSlots() >= neededSlots) return true;
    await cleanupInventory(bot);

    const afterCleanup = bot.inventory.freeSlots();
    log(bot, `After cleanup: ${afterCleanup} free slots.`);
    return afterCleanup >= neededSlots;
}

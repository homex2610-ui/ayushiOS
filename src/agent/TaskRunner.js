import * as skills from './library/skills.js';
import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import fs from 'fs';
import path from 'path';
import { SpatialVision } from './SpatialVision.js';
import { isWoodBlockName, countResource } from '../utils/item_families.js';
import { PACE } from './Pacing.js';

const TASKS_DIR = path.join(process.cwd(), 'tasks');
// Re-exported for other agent modules; canonical definition lives in
// src/utils/item_families.js (family matching for EVERY item type).
export { isWoodBlockName };

export class TaskRunner {
    constructor(bot) {
        this.bot = bot;
        this.skills = {};
        // Perception: continuous environment scan + spatial memory
        this.vision = new SpatialVision(bot);
        this.vision.start(3000);
        this._running = false;
        // NOTE: _running is not reset on disconnect — a new TaskRunner instance
        // is created on reconnect (see agent.js boot), so this is safe.
        // If TaskRunner instances are ever reused across connections,
        // _running must be cleared in the disconnect handler.
        this._interruptRequested = false;
        this._registerDefaultSkills();
    }

    isRunning() {
        return this._running;
    }

    requestInterrupt() {
        this._interruptRequested = true;
    }

    clearInterrupt() {
        this._interruptRequested = false;
    }

    registerSkill(name, fn) {
        this.skills[name] = fn;
    }

    _registerDefaultSkills() {
        this.registerSkill('chat', async (params) => {
            console.log(`[TaskRunner] ${params.message}`);
        });

        this.registerSkill('wait', async (params) => {
            const ms = params.ms || params.duration || 1000;
            await skills.wait(this.bot, ms);
        });

        this.registerSkill('move_to', async (params) => {
            const { x, y, z, range = 2 } = params;
            if (x == null && y == null && z == null) {
                const playerName = params.player;
                if (playerName) {
                    await skills.goToPlayer(this.bot, playerName, range);
                    return;
                }
                const blockType = params.block;
                if (blockType) {
                    await skills.goToNearestBlock(this.bot, blockType, range, params.searchRange || 64);
                    return;
                }
                throw new Error('move_to requires x,y,z or player name or block type');
            }
            const maxRetries = PACE.MOVE_RETRIES;
            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                // Bounded timeout: 3 × 30s unreachable-path attempts read as
                // "bot froze for minutes". 15s × 2 keeps recovery snappy.
                const result = await skills.goToPosition(this.bot, x, y, z, range, PACE.MOVE_TIMEOUT_MS);
                if (result) return;
                if (attempt < maxRetries) {
                    console.log(`[TaskRunner] Move retry ${attempt}/${maxRetries} — attempting recovery...`);
                    try {
                        const p = this.bot.entity.position;
                        const above = new Vec3(p.x, p.y + 1, p.z);
                        const blockAbove = this.bot.blockAt(above);
                        if (blockAbove && blockAbove.name === 'air') {
                            await this.bot.jump();
                        }
                    } catch (_) { /* best-effort: jump may fail */ }
                    await skills.wait(this.bot, PACE.MOVE_RETRY_WAIT_MS);
                }
            }
            throw new Error(`Failed to reach ${x}, ${y}, ${z} after ${maxRetries} attempts`);
        });

        this.registerSkill('collect', async (params) => {
            let { item, count = 1 } = params;
            if (!item) throw new Error('collect requires "item" parameter');
            const blockMapping = {
                'wheat': 'wheat',
                'carrot': 'carrots',
                'potato': 'potatoes',
                'iron_ore': 'iron_ore',
                'coal_ore': 'coal_ore',
                'gold_ore': 'gold_ore',
                'diamond_ore': 'diamond_ore',
                'netherite': 'ancient_debris',
            };
            let blockType = blockMapping[item] || item;
            const isLog = isWoodBlockName(blockType);

            // Wood flexibility: ANY log/wood/stem satisfies wood needs. Never
            // hardcode species lists — adopt whatever the world actually offers.
            if (isLog) {
                // 1) Already holding any wood block → use it.
                const invCounts = world.getInventoryCounts(this.bot);
                const held = Object.keys(invCounts).find(k => isWoodBlockName(k) && invCounts[k] > 0);
                if (held) {
                    blockType = held;
                } else {
                    // 2) Otherwise adopt whatever wood block grows nearby.
                    try { this.vision.scan(true); } catch {}
                    const found = world.getNearestBlocksWhere(this.bot, (b) => isWoodBlockName(b?.name), 48, 1);
                    if (found && found.length > 0 && found[0]?.name) {
                        blockType = found[0].name;
                    }
                    // 3) Nothing nearby → keep requested type; collectBlock will
                    //    report and the expedition fallback below hunts remembered trees.
                }
            }

            // Family-aware inventory counting: 'log' counts every wood
            // species, 'iron' counts raw/ore/ingot forms, exact names count
            // themselves. Canonical logic lives in utils/item_families.js.
            const haveTotal = () => {
                const inv = world.getInventoryCounts(this.bot);
                let total = countResource(inv, blockType);
                // Stone-family equivalence: cobblestone request satisfied by stone too
                if (blockType === 'cobblestone') total += (inv.stone || 0);
                if (blockType === 'dirt') total += (inv.grass_block || 0);
                return total;
            };

            const invBefore = haveTotal();

            // ═══ UNDERGROUND FAST-PATH ═══
            // Stone/cobblestone/ores live underground. Skip the slow surface
            // search + expedition loop and go straight to digging.
            const isUnderground = /^(cobblestone|stone|coal_ore|iron_ore|gold_ore|diamond_ore|redstone_ore|lapis_ore|emerald_ore|copper_ore)$/.test(blockType);
            if (isUnderground && haveTotal() < count && !this.bot.interrupt_code) {
                console.log(`[TaskRunner] ${blockType} needs mining — digging down`);
                // Ores spawn deep: coal@Y96, iron@Y64, diamond@Y-64. Dig aggressively.
                const digDepth = /diamond/.test(blockType) ? 20 : /iron|gold/.test(blockType) ? 16 : 12;
                for (let attempt = 0; attempt < 4 && haveTotal() < count && !this.bot.interrupt_code; attempt++) {
                    try { await skills.digDown(this.bot, digDepth); } catch {}
                    this.vision.scan(true);
                    const before = haveTotal();
                    try { await skills.collectBlock(this.bot, blockType, count - haveTotal()); } catch {}
                    const mined = haveTotal() - before;
                    if (mined > 0) console.log(`[TaskRunner] Mined ${mined} ${blockType} on attempt ${attempt + 1}`);
                }
                if (haveTotal() >= count) {
                    console.log(`[TaskRunner] Got ${haveTotal()} ${blockType} — underground mining succeeded`);
                    return; // done, skip everything below
                }
                // If still not enough, fall through to normal flow
            }

            const invBefore2 = haveTotal();
            await skills.collectBlock(this.bot, blockType, count);
            let got = haveTotal() - invBefore2;
            if (got < count) {
                // Vision-guided retry: walk to a REMEMBERED spot of this
                // resource, but trust nothing until arrival proves it.
                // Species/variant re-resolution happens AFTER navigation —
                // resolving before travel searched a radius around the OLD
                // position (bot then stood next to an acacia hunting oak).
                console.log(`[TaskRunner] Only got ${got}/${count} ${blockType} — checking spatial memory...`);
                const isOre = /_ore$/.test(blockType) || /^(coal|iron|diamond|gold|copper|redstone|lapis|emerald)$/.test(blockType);
                const kind = isLog ? 'tree' : (isOre ? 'ore' : null);
                // Escalating expeditions. The last tier is a MIGRATION: when
                // every nearby memory is a ghost/unobtainable (picked-clean
                // spawn areas), commit to one long trek with a generous
                // timeout instead of dying inside a barren zone.
                const radii = [[48, 96], [96, 192], [192, 384], [200, 420]];
                let barrenStrikes = 0; // consecutive exists-but-unobtainable blocks
                for (let w = 0; w < radii.length && got < count; w++) {
                    if (this.bot.interrupt_code) break;
                    let dest = null;
                    let fromMemory = false;
                    // Full forced scan FIRST — early ticks may not have run a
                    // block scan yet, so memory would falsely read empty.
                    this.vision.scan(true);
                    // Migration tier: never trust memories — the whole point
                    // is escaping a zone whose memories proved dead.
                    const migrating = w === radii.length - 1;
                    if (kind === 'tree' && !migrating) {
                        const mem = this.vision.nearest('tree');
                        if (mem) {
                            // Clamp Y to bot's level ±5 to avoid chasing tree-tops
                            const botY = Math.round(this.bot.entity?.position?.y || 64);
                            const memY = Math.abs(mem.pos.y - botY) < 8 ? mem.pos.y : botY;
                            dest = { x: mem.pos.x, y: memY, z: mem.pos.z };
                            fromMemory = true;
                            console.log(`[Vision] Remembered ${mem.name} at (${dest.x}, ${dest.z}) [${mem.dist}m] — heading there`);
                        }
                    } else if (kind === 'ore' && !migrating) {
                        const mem = this.vision.nearest('ore');
                        if (mem) {
                            // Match on the METAL, not the string prefix:
                            // iron_ore must accept deepslate_iron_ore memories
                            // (old split('_')[0] matched 'deepslate' and
                            // rejected valid spots).
                            const metal = blockType.replace('deepslate_', '').replace('_ore', '');
                            if (!mem.name || mem.name.includes(metal)) {
                                dest = { x: mem.pos.x, y: mem.pos.y, z: mem.pos.z };
                                fromMemory = true;
                                console.log(`[Vision] Remembered ${mem.name} at (${dest.x}, ${dest.y}, ${dest.z}) — heading there`);
                            }
                        }
                    }
                    if (!dest) {
                        const [rMin, rMax] = radii[w];
                        const ex = this.vision.explorationTarget(rMin, rMax);
                        dest = { x: ex.tx, y: this.bot.entity.position.y, z: ex.tz };
                        const isMigration = w === radii.length - 1;
                        console.log(`[Vision] No usable memory of ${blockType} — ${isMigration ? 'MIGRATION' : `expedition ${w + 1}`} (${rMin}-${rMax}m) ${ex.fresh ? 'fresh' : 'stale'} area → (${dest.x}, ${dest.z})`);
                    }
                    // Long legs get a proportional timeout (~2.5s per block,
                    // min 30s) so treks aren't murdered mid-route.
                    const legDist = Math.hypot(dest.x - this.bot.entity.position.x, dest.z - this.bot.entity.position.z);
                    const legTimeout = Math.max(30000, Math.round(legDist * 2500));
                    try { await skills.goToPosition(this.bot, dest.x, dest.y, dest.z, 2, legTimeout); } catch {}
                    this.vision.scan(true);

                    // POST-ARRIVAL TRUTH CHECK: what does the world actually
                    // hold here? Chunks only load near the bot, so this is the
                    // first moment a memory can be honestly verified.
                    let hit = null;
                    if (kind) hit = this.vision.validateArrival(dest, kind);
                    if (fromMemory && !hit) {
                        // Ghost memory (chopped tree / mined ore). Blacklist
                        // so planners stop circling back to it.
                        console.log(`[Vision] Ghost memory at (${dest.x | 0}, ${dest.y | 0}, ${dest.z | 0}) — blacklisting`);
                        this.vision.markFailed(dest, kind);
                        continue;
                    }
                    // Adopt whatever species/variant reality offers.
                    if (hit) blockType = hit.name;

                    const before2 = haveTotal();
                    await skills.collectBlock(this.bot, blockType, count);
                    const got2 = haveTotal() - before2;
                    if (got2 > 0) {
                        this.vision.markSuccess(dest);
                        got += got2;
                        break; // found some — good enough this round
                    }
                    if (hit) {
                        // Block EXISTS here but cannot be obtained (floating
                        // trunk, unreachable ledge, protected). Hard-ignore
                        // this EXACT block or we re-chase it forever.
                        console.log(`[Vision] ${hit.name} at (${hit.x}, ${hit.y}, ${hit.z}) exists but unobtainable — blacklisting exact block`);
                        this.vision.markFailed(hit, kind);
                        // Area purge: siblings of a dead trunk are dead too.
                        try { this.vision.markFailedNear(hit, kind, 3); } catch {}
                        barrenStrikes++;
                        if (barrenStrikes >= 3) {
                            // 3+ real-but-unobtainable blocks = barren or
                            // protected area. Skip straight to migration tier.
                            console.log('[Vision] Area looks barren/protected — migrating far');
                            w = radii.length - 2; // w++ lands on last (migration) tier
                        }
                    }
                    this.vision.markFailed(dest, kind || 'unknown');
                }
                if (got < 1) {
                    // Stone-family fallback: cobblestone/stone/ores live
                    // UNDERGROUND. If surface sweep failed, dig down and
                    // try again before declaring the area barren.
                    if (/^(cobblestone|stone)$/.test(blockType) && !this.bot.interrupt_code) {
                        console.log('[TaskRunner] No surface stone — digging down');
                        try { await skills.digDown(this.bot, 4); } catch {}
                        this.vision.scan(true);
                        const before3 = haveTotal();
                        await skills.collectBlock(this.bot, blockType, count - got);
                        const got3 = haveTotal() - before3;
                        if (got3 > 0) { got += got3; }
                    }
                    if (got < 1) {
                        throw new Error(`No obtainable ${blockType} found after full expedition sweep`);
                    }
                }
            }
        });

        this.registerSkill('place_nearby', async (params) => {
            // Place one of our inventory blocks adjacent to us (e.g. set up
            // a crafting_table we just crafted before using it).
            const { block } = params;
            if (!block) throw new Error('place_nearby requires "block" parameter');
            const inv = world.getInventoryCounts(this.bot);
            if ((inv[block] || 0) < 1) return; // nothing to place — skip silently
            const pos = this.bot.entity.position;
            try {
                await skills.placeBlock(this.bot, block, Math.floor(pos.x) + 1, Math.floor(pos.y), Math.floor(pos.z));
                console.log(`[TaskRunner] Placed ${block} nearby.`);
            } catch (e) {
                console.log(`[TaskRunner] Could not place ${block}: ${e.message} — will use nearest instead.`);
            }
        });

        this.registerSkill('craft_planks', async (params) => {
            // Convert whatever wood is in inventory into planks — any species,
            // any form (log/wood/stem/hyphae/bamboo). Used by capability plans
            // that need "any planks"; the species depends on which trees we find.
            const { count = 8 } = params;
            const pickWood = (inv) => Object.entries(inv).find(([name, c]) => isWoodBlockName(name) && c > 0 && name !== 'bamboo_block');
            let logEntry = pickWood(world.getInventoryCounts(this.bot));
            if (!logEntry) {
                console.log('[TaskRunner] No wood for planks — collecting any log first...');
                await this.skills.collect({ item: 'log', count: 4 });
                logEntry = pickWood(world.getInventoryCounts(this.bot));
                if (!logEntry) throw new Error('No trees found — cannot make planks');
            }
            const [logName, logCount] = logEntry;
            // planks item name follows the base block family:
            // oak_log→oak_planks, spruce_wood→spruce_planks, crimson_stem→crimson_planks
            const species = logName.replace(/_(log|wood|stem|hyphae)$/, '');
            const planksName = `${species}_planks`;
            console.log(`[TaskRunner] Converting ${logCount}× ${logName} → ${planksName}`);
            const ok = await skills.craftRecipe(this.bot, planksName, Math.max(1, Math.ceil(count / 4)));
            if (!ok) throw new Error(`Failed to convert ${logName} to ${planksName}`);
        });

        this.registerSkill('craft', async (params) => {
            const { item, count = 1 } = params;
            if (!item) throw new Error('craft requires "item" parameter');
            const recipesInfo = mc.getItemCraftingRecipes(item);
            if (!recipesInfo || recipesInfo.length === 0) {
                throw new Error(`No known recipe for ${item}.`);
            }
            let ok = false;
            let lastErr = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    ok = await skills.craftRecipe(this.bot, item, count);
                } catch (e) {
                    lastErr = e;
                    console.log(`[TaskRunner] craft attempt ${attempt + 1} failed: ${e.message}`);
                }
                if (ok) break;
                await new Promise(r => setTimeout(r, 1000));
            }
            if (!ok) {
                // If the craft skill threw, surface ITS error (table placement,
                // recipe mismatch etc.) — it's more truthful than our guess.
                if (lastErr) {
                    const msg = String(lastErr.message || '');
                    if (/table/i.test(msg)) {
                        // Table needed but none placeable — gather wood → planks → table, then retry once
                        console.log('[TaskRunner] Crafting needs a table — gathering wood to make one...');
                        const LOG_SPECIES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak'];
                        let logType = null;
                        for (const s of LOG_SPECIES) {
                            if ((world.getInventoryCounts(this.bot)[`${s}_log`] || 0) > 0) { logType = `${s}_log`; break; }
                        }
                        if (!logType) {
                            try { await skills.collectBlock(this.bot, 'log', 1); } catch (_) { /* expedition may fail */ }
                            for (const s of LOG_SPECIES) {
                                if ((world.getInventoryCounts(this.bot)[`${s}_log`] || 0) > 0) { logType = `${s}_log`; break; }
                            }
                        }
                        if (logType) {
                            try {
                                await skills.craftRecipe(this.bot, `${logType.split('_')[0]}_planks`, 4);
                                await skills.craftRecipe(this.bot, 'crafting_table', 1);
                                ok = await skills.craftRecipe(this.bot, item, count);
                            } catch (e2) { lastErr = e2; }
                        }
                    }
                    if (!ok) throw new Error(`Failed to craft ${item}: ${lastErr.message}`);
                }
                // Analyze across ALL recipe variants — the old code only checked
                // recipes[0], failing when e.g. spruce planks were in hand but the
                // first listed recipe wanted oak.
                const inv = world.getInventoryCounts(this.bot);
                let bestMissing = null;
                for (const [required] of recipesInfo) {
                    // Use family-normalized check: acacia_planks counts as oak_planks
                    const craftLimit = mc.calculateCraftLimit(inv, required);
                    if (craftLimit.num > 0) {
                        // Ingredients exist for this variant but craft still failed —
                        // most likely a missing crafting table.
                        throw new Error(`Failed to craft ${item} — have ingredients but cannot craft (need a crafting table nearby?).`);
                    }
                    if (!bestMissing || craftLimit.num < bestMissing.num) bestMissing = { num: craftLimit.num, resource: craftLimit.limitingResource };
                }
                throw new Error(`Missing resources to craft ${item}. Need: ${bestMissing?.resource || 'unknown'}`);
            }
        });

        this.registerSkill('smelt', async (params) => {
            const { input, fuel, count = 1 } = params;
            if (!input) throw new Error('smelt requires "input" parameter');
            const inputItem = input;
            if (fuel) {
                const hasFuel = world.getInventoryCounts(this.bot)[fuel] > 0;
                if (!hasFuel) {
                    console.log(`[TaskRunner] No ${fuel}, collecting some...`);
                    await skills.collectBlock(this.bot, fuel, Math.ceil(count / 8) + 1);
                }
            }
            await skills.smeltItem(this.bot, inputItem, count);
        });

        this.registerSkill('combat', async (params) => {
            // Accept both spellings (AyushiOS tasks send entityType)
            const target = params.target ?? params.entityType ?? 'nearest';
            const { range = 24, stopOnHealth = 6, count = 1, duration = 60000 } = params;
            const bot = this.bot;

            let kills = 0;
            let misses = 0;
            const maxAttempts = count * 3;
            const startTime = Date.now();

            for (let attempt = 0; attempt < maxAttempts && kills < count; attempt++) {
                if (Date.now() - startTime > duration) break;
                if (bot.interrupt_code) break;
                if (bot.health < stopOnHealth) {
                    console.log('[TaskRunner] Health too low, retreating!');
                    throw new Error(`Combat aborted: health ${bot.health} below threshold ${stopOnHealth}`);
                }

                let entity = null;
                if (target === 'player' || target === 'players' || target === 'nearest') {
                    entity = world.getNearestEntityWhere(bot, e => e.type === 'player' && e.username !== bot.username, range);
                } else if (target === 'animal' || target === 'passive' || target === 'mob') {
                    entity = world.getNearestEntityWhere(bot, e =>
                        e.type === 'mob' && e.name && !['creeper','zombie','skeleton','spider','enderman','witch'].includes(e.name), range
                    );
                } else {
                    entity = world.getNearestEntityWhere(bot, e =>
                        e.name === target || e.username === target, range
                    );
                }

                if (!entity) {
                    misses++;
                    console.log(`[TaskRunner] No target "${target}" found (attempt ${attempt + 1})`);
                    // No targets in range after a few scans → give up instead of idling
                    if (misses >= 3) {
                        console.log(`[TaskRunner] Combat: no "${target}" anywhere nearby, skipping.`);
                        return `no ${target} found nearby`;
                    }
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }

                console.log(`[TaskRunner] Engaging ${entity.username || entity.name}!`);
                try {
                    await skills.fightPlayer(bot, entity);
                    kills++;
                    console.log(`[TaskRunner] Eliminated target. Kills: ${kills}/${count}`);
                    // Loot: walk to nearby item drops (the kill's drops) and pick them up
                    await new Promise(r => setTimeout(r, 800));
                    this.vision.scan(true);
                    for (let li = 0; li < 4; li++) {
                        const drop = this.vision.nearest('drop', 15000);
                        if (!drop) break;
                        try {
                            await skills.goToPosition(bot, drop.pos.x, drop.pos.y, drop.pos.z);
                            await new Promise(r => setTimeout(r, 400));
                        } catch {}
                        if (this.vision.nearest('drop', 15000) === null) break; // picked up (memory pruned on next scan)
                        this.vision.memory.delete(`drop:${drop.entityId}`);
                    }
                    // Reliable sweep: magnet-walk any remaining item entities within reach
                    try { await skills.pickupNearbyItems(bot, 16); } catch {}
                } catch (e) {
                    console.log(`[TaskRunner] Fight failed: ${e.message}`);
                    await new Promise(r => setTimeout(r, 3000));
                }
            }

            if (kills < count) {
                console.log(`[TaskRunner] Combat partial: ${kills}/${count} kills`);
            }
        });

        this.registerSkill('equip', async (params) => {
            const { item, slot } = params;
            if (!item) throw new Error('equip requires "item" parameter');
            const destMap = {
                'hand': 'hand',
                'head': 'head',
                'helmet': 'head',
                'torso': 'torso',
                'chestplate': 'torso',
                'legs': 'legs',
                'leggings': 'legs',
                'feet': 'feet',
                'boots': 'feet',
                'offhand': 'off-hand',
                'off_hand': 'off-hand',
                'shield': 'off-hand',
            };
            const destination = destMap[slot] || 'hand';
            if (item.includes('helmet') || item.includes('chestplate') || item.includes('leggings') || item.includes('boots')) {
                try { this.bot.armorManager?.equipAll?.(); } catch (_) { /* best-effort: armorManager may not be available */ }
                return;
            }
            await skills.equip(this.bot, item);
        });

        this.registerSkill('eat', async (params) => {
            const minFood = params.minFood ?? params.minFoodLevel ?? 18;
            const food = params.food;
            if (this.bot.food >= minFood) {
                console.log(`[TaskRunner] Food level ${this.bot.food}/${20}, skipping eat.`);
                return;
            }
            if (food) {
                try {
                    await skills.consume(this.bot, food);
                    return;
                } catch (e) {
                    console.log(`[TaskRunner] Could not eat ${food}: ${e.message}`);
                }
            }
            // eatBestFood handles the safe-food-first + starving-emergency
            // fallback chain (eats even rotten flesh when death is imminent).
            const ate = await skills.eatBestFood(this.bot);
            if (!ate) throw new Error('No food in inventory');
        });

        this.registerSkill('chest', async (params) => {
            const { action = 'store', item, count = 64, range = 6 } = params;
            if (!item) throw new Error('chest requires "item" parameter');
            if (action === 'store') {
                await skills.putInChest(this.bot, item, count);
            } else if (action === 'withdraw' || action === 'take') {
                await skills.takeFromChest(this.bot, item, count);
            } else if (action === 'view') {
                await skills.viewChest(this.bot);
            }
        });

        this.registerSkill('interact', async (params) => {
            const { block, action = 'click' } = params;
            if (!block) throw new Error('interact requires "block" parameter');
            if (action === 'sleep') {
                await skills.goToBed(this.bot);
                return;
            }
            const blockType = block;
            const targetBlock = world.getNearestBlock(this.bot, blockType, 8);
            if (!targetBlock) throw new Error(`No ${blockType} found nearby`);
            await skills.goToPosition(this.bot, targetBlock.position.x, targetBlock.position.y, targetBlock.position.z, 2);
            await this.bot.activateBlock(targetBlock);
        });

        this.registerSkill('farm', async (params) => {
            const { crop = 'wheat_seeds', size = 4 } = params;
            await skills.plantAndHarvest(this.bot, crop);
            const pos = this.bot.entity.position;
            const farmX = Math.floor(pos.x) + 5;
            const farmZ = Math.floor(pos.z) + 5;
            const farmY = Math.floor(pos.y);
            const hoe = this.bot.inventory.items().find(i => i.name.includes('hoe'));
            if (!hoe) {
                try {
                    // Species-agnostic provisioning: collect ANY wood, convert
                    // whatever we hold into planks, then stick + hoe.
                    await this.skills.collect({ item: 'log', count: 3 });
                    await this.skills.craft_planks({ count: 4 });
                    await skills.craftRecipe(this.bot, 'stick', 4);
                    await skills.craftRecipe(this.bot, 'wooden_hoe', 1);
                } catch (e) {
                    console.log(`[TaskRunner] Hoe craft skipped: ${e.message}`);
                }
            }
            let planted = 0;
            for (let dx = 0; dx < size; dx++) {
                for (let dz = 0; dz < size; dz++) {
                    if (this.bot.interrupt_code) break;
                    const bx = farmX + dx;
                    const bz = farmZ + dz;
                    const block = this.bot.blockAt(Vec3(bx, farmY, bz));
                    if (!block || block.name.includes('farmland')) continue;
                    try {
                        await skills.tillAndSow(this.bot, bx, farmY, bz, crop);
                        planted++;
                    } catch (e) {
                        console.log(`[TaskRunner] Till fail at ${bx},${farmY},${bz}: ${e.message}`);
                    }
                    await new Promise(r => setTimeout(r, 150));
                }
            }
            console.log(`[TaskRunner] Farmed ${planted} plots.`);
            await new Promise(r => setTimeout(r, 15000));
            try {
                await skills.plantAndHarvest(this.bot, crop);
            } catch (e) {
                console.log(`[TaskRunner] Harvest: ${e.message}`);
            }
        });

        this.registerSkill('dig_down', async (params) => {
            const { distance = 5 } = params;
            await skills.digDown(this.bot, distance);
        });

        this.registerSkill('go_surface', async (params) => {
            await skills.goToSurface(this.bot);
        });

        this.registerSkill('explore', async (params) => {
            // Productive idling: vision-guided walk. Prefers unvisited cells,
            // and detours to grab any item drops seen along the way.
            const { minDist = 40, maxDist = 90 } = params;
            const t = this.vision.explorationTarget(minDist, maxDist);
            const p = this.bot.entity.position;
            console.log(`[TaskRunner] Exploring → (${t.tx}, ${t.tz}) [${Math.hypot(t.tx - p.x, t.tz - p.z) | 0} blocks, ${t.fresh ? 'fresh' : 'revisit'}]`);
            try {
                await skills.goToPosition(this.bot, t.tx, p.y, t.tz);
                console.log('[TaskRunner] Exploration complete.');
                this.vision.scan(true);
                return `explored to ${t.tx}, ${t.tz}`;
            } catch (e) {
                console.log(`[TaskRunner] Exploration ended: ${e.message}`);
                return 'exploration interrupted';
            }
        });

        this.registerSkill('discard', async (params) => {
            const { item, count = -1 } = params;
            await skills.discard(this.bot, item, count);
        });

        this.registerSkill('strip_mine', async (params) => {
            const { length = 20 } = params;
            await skills.stripMine(this.bot, length);
        });

        // ═══════════════════════════════════════════════════════════
        // EXPERT PLAYER SKILLS — from speedrunner/pro research
        // ═══════════════════════════════════════════════════════════

        this.registerSkill('organize_hotbar', async (params) => {
            return await skills.organizeHotbar(this.bot);
        });

        this.registerSkill('cook_food', async (params) => {
            return await skills.cookAllFood(this.bot);
        });

        this.registerSkill('place_torch', async (params) => {
            return await skills.placeTorchNearby(this.bot, params.radius || 6);
        });

        this.registerSkill('sprint_to', async (params) => {
            const { x, y, z, range = 2 } = params;
            return await skills.sprintJumpTo(this.bot, x, y, z, range);
        });

        this.registerSkill('torch_mine', async (params) => {
            const { direction, length = 20 } = params;
            return await skills.autoTorchMine(this.bot, direction || this.bot.entity.yaw, length);
        });

        this.registerSkill('defend', async (params) => {
            const { range = 9 } = params;
            return await skills.defendSelf(this.bot, range);
        });

        this.registerSkill('bow_attack', async (params) => {
            // Find nearest hostile and shoot it
            const hostile = Object.values(this.bot.entities || {})
                .filter(e => e?.isValid && e.position && mc.isHostile(e))
                .sort((a, b) => a.position.distanceTo(this.bot.entity.position) - b.position.distanceTo(this.bot.entity.position))[0];
            if (!hostile) return false;
            return await skills.bowAttack(this.bot, hostile);
        });

        // ═══ PRO PLAYER SKILLS ═══

        this.registerSkill('branch_mine', async (params) => {
            const { targetY = -59, mainLength = 50, branchLength = 20, direction } = params;
            return await skills.branchMine(this.bot, { targetY, mainLength, branchLength, direction });
        });

        this.registerSkill('pillar_up', async (params) => {
            const { height = 10 } = params;
            return await skills.pillarUp(this.bot, height);
        });

        this.registerSkill('staircase_up', async (params) => {
            const { targetY = 100 } = params;
            return await skills.staircaseUp(this.bot, targetY);
        });

        this.registerSkill('escape_cave', async (params) => {
            return await skills.escapeCave(this.bot);
        });

        // ═══ PREVIOUSLY DEAD SKILLS — NOW REGISTERED ═══

        this.registerSkill('strafe', async (params) => {
            const { target, durationMs = 2000 } = params;
            return await skills.strafeAround(this.bot, target, durationMs);
        });

        this.registerSkill('throw_potion', async (params) => {
            const { potionType } = params;
            return await skills.throwPotion(this.bot, potionType);
        });

        this.registerSkill('repair', async (params) => {
            const { item } = params;
            return await skills.repairItem(this.bot, item);
        });

        this.registerSkill('shear_sheep', async (params) => {
            return await skills.shearSheep(this.bot);
        });

        this.registerSkill('milk_cow', async (params) => {
            return await skills.milkCow(this.bot);
        });

        this.registerSkill('compost', async (params) => {
            return await skills.compostItems(this.bot);
        });

        this.registerSkill('plant_saplings', async (params) => {
            const { count = 5 } = params;
            return await skills.plantSaplings(this.bot, count);
        });

        this.registerSkill('activate_block', async (params) => {
            const { type } = params;
            return await skills.activateNearestBlock(this.bot, type);
        });

        this.registerSkill('cure_zombie_villager', async (params) => {
            return await skills.cureZombieVillager(this.bot);
        });

        // ═══ INVENTORY OPTIMIZATION ═══

        this.registerSkill('smart_organize', async (params) => {
            const { mode = 'general' } = params;
            return await skills.smartOrganize(this.bot, mode);
        });

        this.registerSkill('auto_equip_armor', async (params) => {
            return await skills.autoEquipBestArmor(this.bot);
        });

        this.registerSkill('consolidate_inventory', async (params) => {
            return await skills.consolidateInventory(this.bot);
        });

        this.registerSkill('cleanup_inventory', async (params) => {
            return await skills.cleanupInventory(this.bot);
        });

        this.registerSkill('pre_task_check', async (params) => {
            const { neededSlots = 4 } = params;
            return await skills.preTaskInventoryCheck(this.bot, neededSlots);
        });
    }

    async runTask(steps, opts = {}) {
        if (this._running && !opts.force) {
            console.log('[TaskRunner] Already running a task — rejecting concurrent start.');
            return { success: false, reason: 'task_runner_busy' };
        }

        if (this._running && opts.force) {
            console.log('[TaskRunner] Force start — interrupting current task...');
            this.requestInterrupt();
            this.bot.interrupt_code = true;
            try { this.bot.pathfinder?.setGoal?.(null); } catch (_) { /* best-effort: may not have pathfinder */ }
            const waitStart = Date.now();
            while (this._running && Date.now() - waitStart < 5000) {
                await new Promise(r => setTimeout(r, 100));
            }
            if (this._running) {
                console.warn('[TaskRunner] Previous task did not stop in time — taking over.');
                this._running = false;
            }
            this.bot.interrupt_code = false;
        }

        this._running = true;
        this._interruptRequested = false;
        console.log(`[TaskRunner] Starting task with ${steps.length} steps...`);
        for (let i = 0; i < steps.length; i++) {
            if (this._interruptRequested) {
                console.log(`[TaskRunner] Interrupted — aborting at step ${i + 1}/${steps.length}.`);
                try { this.bot.pathfinder?.setGoal?.(null); } catch (_) { /* best-effort: may not have pathfinder */ }
                this.bot.interrupt_code = true;
                this._running = false;
                this._interruptRequested = false;
                return { success: false, reason: 'interrupted', failedStep: i + 1 };
            }

            const step = steps[i];
            console.log(`[TaskRunner] Step ${i + 1}/${steps.length}: ${step.skill} ${JSON.stringify(step.params || {})}`);

            const fn = this.skills[step.skill];
            if (!fn) {
                console.error(`[TaskRunner] Unknown skill: ${step.skill}. Skipping.`);
                continue;
            }

            try {
                const outputBefore = (this.bot.output || '').length;
                await fn(step.params || {});
                if (this.bot.output && this.bot.output.length > outputBefore) {
                    const newOutput = this.bot.output.substring(outputBefore).trim();
                    if (newOutput) console.log(`  [Skill] ${newOutput}`);
                }
            } catch (err) {
                console.error(`[TaskRunner] Step ${i + 1} (${step.skill}) failed: ${err.message}`);
                console.log(`[TaskRunner] Failed step ${i + 1} (${step.skill}): ${err.message}`);
                this._running = false;
                return { success: false, failedStep: i + 1, reason: err.message };
            }
        }
        console.log('[TaskRunner] Task complete!');
        this._running = false;
        return { success: true };
    }

    async runTaskFromFile(taskName) {
        const filePath = path.join(TASKS_DIR, `${taskName}.json`);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Task file not found: ${filePath}`);
        }
        const raw = fs.readFileSync(filePath, 'utf-8');
        const steps = JSON.parse(raw);
        if (!Array.isArray(steps)) {
            throw new Error(`Task file must contain a JSON array of steps`);
        }
        return await this.runTask(steps);
    }

    static getAvailableTasks() {
        if (!fs.existsSync(TASKS_DIR)) return [];
        return fs.readdirSync(TASKS_DIR)
            .filter(f => f.endsWith('.json'))
            .map(f => f.replace('.json', ''));
    }
}

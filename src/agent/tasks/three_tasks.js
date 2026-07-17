import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import settings from '../../../settings.js';
import { HubNavigator } from '../../connection/HubNavigator.js';

const TARGET_KILLS = 3;
const WHEAT_COUNT = 20;
const IRON_COUNT = 24;

function log(bot, message) {
    bot.output += message + '\n';
    console.log(`[ThreeTasks] ${message}`);
}

function getNearbyPlayers(bot) {
    const players = [];
    for (const [name, p] of Object.entries(bot.players)) {
        if (name === bot.username) continue;
        if (!p.entity) continue;
        const dist = bot.entity.position.distanceTo(p.entity.position);
        if (dist < 64) {
            players.push({ name, entity: p.entity, distance: dist });
        }
    }
    players.sort((a, b) => a.distance - b.distance);
    return players;
}

async function findAndKillPlayers(agent, count) {
    const bot = agent.bot;
    let killed = 0;
    const maxAttempts = 10;

    for (let attempt = 0; attempt < maxAttempts && killed < count; attempt++) {
        if (bot.interrupt_code) break;
        if (!bot.entity) { log(bot, 'Bot not spawned, waiting...'); await new Promise(r => setTimeout(r, 2000)); continue; }

        log(bot, `Task 1/3: Finding player to kill (${killed}/${count})...`);

        const players = getNearbyPlayers(bot);
        if (players.length === 0) {
            log(bot, 'No players nearby, waiting 10s...');
            await new Promise(r => setTimeout(r, 10000));
            continue;
        }

        const target = players[0];
        log(bot, `Targeting ${target.name} (${target.distance.toFixed(1)}m away)`);

        try {
            await skills.fightPlayer(bot, target.entity);
            killed++;
            log(bot, `Killed ${target.name}! (${killed}/${count})`);
            await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
            log(bot, `Fight failed: ${err.message}`);
            await new Promise(r => setTimeout(r, 3000));
        }
    }

    if (killed >= count) {
        log(bot, `Task 1 complete: Killed ${killed} players!`);
    } else {
        log(bot, `Task 1 partial: Killed ${killed}/${count} players.`);
    }
    return killed;
}

async function makeWheatFarm(agent) {
    const bot = agent.bot;
    log(bot, 'Task 2/3: Starting wheat farm construction...');

    if (!bot.entity) { log(bot, 'Bot not spawned.'); return false; }

    const pos = bot.entity.position;
    const farmX = Math.floor(pos.x) + 5;
    const farmZ = Math.floor(pos.z) + 5;
    const farmY = Math.floor(pos.y);

    const blocks = bot.inventory.items() || [];
    const hasHoe = blocks.some(i => i.name.includes('hoe'));

    if (!hasHoe) {
        log(bot, 'No hoe found, checking for materials...');
        const sticks = world.getInventoryCounts(bot)['stick'] || 0;
        const planks = world.getInventoryCounts(bot)['oak_planks'] || (world.getInventoryCounts(bot)['spruce_planks'] || 0);

        if (sticks >= 2 && planks >= 2) {
            log(bot, 'Crafting wooden hoe...');
            try { await skills.craftRecipe(bot, 'wooden_hoe', 1); } catch (e) { log(bot, `Craft hoe failed: ${e.message}`); }
        } else {
            log(bot, 'Cannot craft hoe, collecting wood first...');
            try {
                const logs = await skills.collectBlock(bot, 'oak_log', 3);
                if (!logs) await skills.collectBlock(bot, 'spruce_log', 3);
            } catch (e) { log(bot, `Collect wood failed: ${e.message}`); }
            try {
                const planksCount = world.getInventoryCounts(bot)['oak_planks'] || 0;
                if (planksCount < 4) await skills.craftRecipe(bot, 'oak_planks', 4);
                await skills.craftRecipe(bot, 'stick', 4);
                await skills.craftRecipe(bot, 'wooden_hoe', 1);
            } catch (e) { log(bot, `Craft hoe chain failed: ${e.message}`); }
        }
    }

    log(bot, 'Looking for existing wheat to harvest for seeds...');
    try {
        await skills.plantAndHarvest(bot, 'wheat_seeds');
    } catch (e) {
        log(bot, `Harvest existing crops failed: ${e.message}`);
    }

    log(bot, 'Tilling and planting wheat farm...');
    const water = world.getNearestBlock(bot, 'water', 8);
    const waterPos = water ? water.position : null;

    const size = 4;
    let planted = 0;
    for (let dx = 0; dx < size; dx++) {
        for (let dz = 0; dz < size; dz++) {
            if (bot.interrupt_code) { log(bot, 'Interrupted during farming.'); return planted > 0; }
            const bx = farmX + dx;
            const bz = farmZ + dz;
            const block = bot.blockAt({ x: bx, y: farmY, z: bz });
            if (!block || block.name === 'water' || block.name.includes('farmland')) continue;
            try {
                await skills.tillAndSow(bot, bx, farmY, bz, 'wheat_seeds');
                planted++;
            } catch (e) {
                log(bot, `Till fail at ${bx},${farmY},${bz}: ${e.message}`);
            }
            await new Promise(r => setTimeout(r, 200));
        }
    }

    log(bot, `Wheat farm created: ${planted} plots tilled and planted.`);

    log(bot, 'Waiting for wheat to grow, then harvesting...');
    await new Promise(r => setTimeout(r, 30000));
    try {
        await skills.plantAndHarvest(bot, 'wheat_seeds');
    } catch (e) {
        log(bot, `Harvest failed: ${e.message}`);
        try { await skills.collectBlock(bot, 'wheat', WHEAT_COUNT); } catch (e2) { log(bot, `Collect wheat: ${e2.message}`); }
    }

    log(bot, 'Task 2 complete: Wheat farm built and harvested!');
    return true;
}

async function craftIronArmor(agent) {
    const bot = agent.bot;
    log(bot, 'Task 3/3: Crafting iron armor...');

    if (!bot.entity) { log(bot, 'Bot not spawned.'); return false; }

    const armorPieces = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
    const existing = bot.inventory.items().filter(i => armorPieces.includes(i.name));
    if (existing.length >= 4) {
        log(bot, 'Already have full iron armor set!');
        try { await bot.armorManager.equipAll(); } catch (_) {}
        return true;
    }

    log(bot, 'Collecting iron ore...');
    let collected = 0;
    try {
        const result = await skills.collectBlock(bot, 'iron_ore', 6);
        collected = result ? world.getInventoryCounts(bot)['raw_iron'] || 0 : 0;
        if (collected < 4) {
            const deepslateIron = await skills.collectBlock(bot, 'deepslate_iron_ore', 6);
            collected = world.getInventoryCounts(bot)['raw_iron'] || 0;
            if (!deepslateIron && collected < 4) {
                log(bot, `Only got ${collected} raw iron, need at least 4.`);
            }
        }
    } catch (e) {
        log(bot, `Collect iron ore failed: ${e.message}`);
    }

    const rawIron = world.getInventoryCounts(bot)['raw_iron'] || 0;
    log(bot, `Have ${rawIron} raw iron. Smelting...`);

    if (rawIron > 0) {
        try {
            const hasCoal = (world.getInventoryCounts(bot)['coal'] || 0) > 0;
            if (!hasCoal) {
                log(bot, 'No coal, collecting some...');
                await skills.collectBlock(bot, 'coal', 3);
            }
            await skills.smeltItem(bot, 'raw_iron', Math.min(rawIron, 24));
        } catch (e) {
            log(bot, `Smelt failed: ${e.message}`);
        }
    } else {
        log(bot, 'Trying to use existing iron ingots...');
    }

    const ironIngots = world.getInventoryCounts(bot)['iron_ingot'] || 0;
    log(bot, `Have ${ironIngots} iron ingots. Crafting armor...`);

    for (const piece of armorPieces) {
        if (bot.interrupt_code) break;
        if (bot.inventory.items().some(i => i.name === piece)) {
            log(bot, `Already have ${piece}, skipping.`);
            continue;
        }
        log(bot, `Crafting ${piece}...`);
        try {
            await skills.craftRecipe(bot, piece, 1);
        } catch (e) {
            log(bot, `Craft ${piece} failed: ${e.message}`);
        }
    }

    try { await bot.armorManager.equipAll(); } catch (_) {}
    const equipped = bot.inventory.items().filter(i => armorPieces.includes(i.name));
    log(bot, `Task 3 complete: ${equipped.length}/4 iron armor pieces crafted!`);
    return equipped.length >= 4;
}

export async function navigateToSurvival(agent) {
    const bot = agent.bot;
    log(bot, 'Navigating to survival mode...');

    const worldType = agent.serverAnalyzer?.kb?.get('world_type') || agent.bot.game?.dimension;
    if (worldType === 'survival' || worldType === 'overworld') {
        log(bot, 'Already in survival world, skipping navigation.');
        return true;
    }

    try {
        const navigator = new HubNavigator(bot);
        const result = await navigator.navigateToMode('survival');
        navigator.reset();
        if (result) {
            log(bot, 'Successfully navigated to survival mode!');
            return true;
        }
    } catch (e) {
        log(bot, `Navigation failed: ${e.message}`);
    }

    log(bot, 'Navigation not possible, continuing on current world.');
    return false;
}

export async function executeThreeTasks(agent) {
    const bot = agent.bot;
    console.log('=== Starting 3 Tasks: PvP → Farm → Armor ===');

    try { await navigateToSurvival(agent); } catch (e) { log(bot, `Nav error: ${e.message}`); }

    const kills = await findAndKillPlayers(agent, TARGET_KILLS);

    if (kills < TARGET_KILLS) {
        log(bot, `Only got ${kills}/${TARGET_KILLS} kills, proceeding anyway.`);
    }

    const farmResult = await makeWheatFarm(agent);

    const armorResult = await craftIronArmor(agent);

    console.log('=== 3 Tasks Complete ===');
    console.log(`  PvP kills: ${kills}/${TARGET_KILLS}`);
    console.log(`  Wheat farm: ${farmResult ? 'OK' : 'FAILED'}`);
    console.log(`  Iron armor: ${armorResult ? 'OK' : 'FAILED'}`);

    log(bot, `Three tasks done! Killed ${kills} players, made wheat farm, crafted iron armor.`);
    return { kills, farmResult, armorResult };
}

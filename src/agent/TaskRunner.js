import * as skills from './library/skills.js';
import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import pf from 'mineflayer-pathfinder';
import Vec3 from 'vec3';
import fs from 'fs';
import path from 'path';

const TASKS_DIR = path.join(process.cwd(), 'tasks');

export class TaskRunner {
    constructor(bot) {
        this.bot = bot;
        this.skills = {};
        this._registerDefaultSkills();
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
            await skills.goToPosition(this.bot, x, y, z, range);
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
                'log': 'oak_log',
                'cobblestone': 'cobblestone',
                'stone': 'stone',
            };
            const blockType = blockMapping[item] || item;
            await skills.collectBlock(this.bot, blockType, count);
        });

        this.registerSkill('craft', async (params) => {
            const { item, count = 1 } = params;
            if (!item) throw new Error('craft requires "item" parameter');
            await skills.craftRecipe(this.bot, item, count);
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
            const { target, range = 24, stopOnHealth = 6, count = 1, duration = 60000 } = params;
            const bot = this.bot;

            let kills = 0;
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
                } else {
                    entity = world.getNearestEntityWhere(bot, e =>
                        e.name === target || e.username === target, range
                    );
                }

                if (!entity) {
                    console.log(`[TaskRunner] No target "${target}" found (attempt ${attempt + 1})`);
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }

                console.log(`[TaskRunner] Engaging ${entity.username || entity.name}!`);
                try {
                    await skills.fightPlayer(bot, entity);
                    kills++;
                    console.log(`[TaskRunner] Eliminated target. Kills: ${kills}/${count}`);
                    await new Promise(r => setTimeout(r, 2000));
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
                try { bot.armorManager.equipAll(); } catch (_) {}
                return;
            }
            await skills.equip(this.bot, item);
        });

        this.registerSkill('eat', async (params) => {
            const { food, minFood = 18 } = params;
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
            const foodItems = this.bot.inventory.items()
                .filter(i => i.foodPoints > 0 && !['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken'].includes(i.name))
                .sort((a, b) => b.foodPoints - a.foodPoints);
            if (foodItems.length === 0) throw new Error('No food in inventory');
            await skills.consume(this.bot, foodItems[0].name);
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
                    await skills.collectBlock(this.bot, 'oak_log', 3);
                    await skills.craftRecipe(this.bot, 'oak_planks', 4);
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

        this.registerSkill('discard', async (params) => {
            const { item, count = -1 } = params;
            await skills.discard(this.bot, item, count);
        });

        this.registerSkill('strip_mine', async (params) => {
            const { length = 20 } = params;
            await skills.stripMine(this.bot, length);
        });
    }

    async runTask(steps) {
        console.log(`[TaskRunner] Starting task with ${steps.length} steps...`);
        for (let i = 0; i < steps.length; i++) {
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
                return { success: false, failedStep: i + 1, reason: err.message };
            }
        }
        console.log('[TaskRunner] Task complete!');
        console.log('[TaskRunner] All tasks complete!');
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

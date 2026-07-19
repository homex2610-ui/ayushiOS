import * as skills from './library/skills.js';
import * as world from './library/world.js';
import * as mc from '../utils/mcdata.js';
import settings from './settings.js'
import convoManager from './conversation.js';

async function say(agent, message) {
    agent.bot.modes.behavior_log += message + '\n';
    // Don't send public chat — server kicks for "advertising / repeated spam"
    console.log(`[Modes] ${message}`);
}

// a mode is a function that is called every tick to respond immediately to the world
// it has the following fields:
// on: whether 'update' is called every tick
// active: whether an action has been triggered by the mode and hasn't yet finished
// paused: whether the mode is paused by another action that overrides the behavior (eg followplayer implements its own self defense)
// update: the function that is called every tick (if on is true)
// when a mode is active, it will trigger an action to be performed but won't wait for it to return output

// the order of this list matters! first modes will be prioritized
// while update functions are async, they should *not* be awaited longer than ~100ms as it will block the update loop
// to perform longer actions, use the execute function which won't block the update loop
const modes_list = [
    {
        name: 'self_preservation',
        description: 'Respond to drowning, burning, and damage at low health. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        fall_blocks: ['sand', 'gravel', 'concrete_powder'], // includes matching substrings like 'sandstone' and 'red_sand'
        update: async function (agent) {
            const bot = agent.bot;
            let block = bot.blockAt(bot.entity.position);
            let blockAbove = bot.blockAt(bot.entity.position.offset(0, 1, 0));
            if (!block) block = {name: 'air'}; // hacky fix when blocks are not loaded
            if (!blockAbove) blockAbove = {name: 'air'};
            if (blockAbove.name === 'water') {
                // does not call execute so does not interrupt other actions
                if (!bot.pathfinder.goal) {
                    bot.setControlState('jump', true);
                }
            }
            else if (this.fall_blocks.some(name => blockAbove.name.includes(name))) {
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 2);
                });
            }
            else if (block.name === 'lava' || block.name === 'fire' ||
                blockAbove.name === 'lava' || blockAbove.name === 'fire') {
                // human reaction delay 100-400ms
                await new Promise(r => setTimeout(r, 100 + Math.random() * 300));
                say(agent, 'I\'m on fire!');
                // if you have a water bucket, use it
                let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                if (waterBucket) {
                    execute(this, agent, async () => {
                        let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                        if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                    });
                }
                else {
                    execute(this, agent, async () => {
                        let waterBucket = bot.inventory.findInventoryItem('water_bucket');
                        if (waterBucket) {
                            let success = await skills.placeBlock(bot, 'water_bucket', block.position.x, block.position.y, block.position.z);
                            if (success) say(agent, 'Placed some water, ahhhh that\'s better!');
                            return;
                        }
                        let nearestWater = world.getNearestBlock(bot, 'water', 20);
                        if (nearestWater) {
                            const pos = nearestWater.position;
                            let success = await skills.goToPosition(bot, pos.x, pos.y, pos.z, 0.2);
                            if (success) say(agent, 'Found some water, ahhhh that\'s better!');
                            return;
                        }
                        await skills.moveAway(bot, 5);
                    });
                }
            }
            else if (Date.now() - bot.lastDamageTime < 3000 && (bot.health < 5 || bot.lastDamageTaken >= bot.health)) {
                say(agent, 'I\'m dying!');
                execute(this, agent, async () => {
                    await skills.moveAway(bot, 20);
                });
            }
            else if (agent.isIdle()) {
                bot.clearControlStates(); // clear jump if not in danger or doing anything else
            }
        }
    },
    {
        name: 'unstuck',
        description: 'Attempt to get unstuck when in the same place for a while. Interrupts some actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        prev_location: null,
        distance: 2,
        stuck_time: 0,
        last_time: Date.now(),
        max_stuck_time: 20,
        prev_dig_block: null,
        update: async function (agent) {
            if (agent.isIdle()) { 
                this.prev_location = null;
                this.stuck_time = 0;
                return; // don't get stuck when idle
            }
            const bot = agent.bot;
            const cur_dig_block = bot.targetDigBlock;
            if (cur_dig_block && !this.prev_dig_block) {
                this.prev_dig_block = cur_dig_block;
            }
            if (this.prev_location && this.prev_location.distanceTo(bot.entity.position) < this.distance && cur_dig_block == this.prev_dig_block) {
                this.stuck_time += (Date.now() - this.last_time) / 1000;
            }
            else {
                this.prev_location = bot.entity.position.clone();
                this.stuck_time = 0;
                this.prev_dig_block = null;
            }
            const max_stuck_time = cur_dig_block?.name === 'obsidian' ? this.max_stuck_time * 2 : this.max_stuck_time;
            if (this.stuck_time > max_stuck_time) {
                say(agent, 'I\'m stuck!');
                this.stuck_time = 0;
                execute(this, agent, async () => {
                    const crashTimeout = setTimeout(() => { agent.cleanKill("Got stuck and couldn't get unstuck") }, 10000);
                    await skills.moveAway(bot, 5);
                    clearTimeout(crashTimeout);
                    say(agent, 'I\'m free.');
                });
            }
            this.last_time = Date.now();
        },
        unpause: function () {
            this.prev_location = null;
            this.stuck_time = 0;
            this.prev_dig_block = null;
        }
    },
    {
        name: 'cowardice',
        description: 'Run away from enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 16);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                // human reaction delay 200-600ms
                await new Promise(r => setTimeout(r, 200 + Math.random() * 400));
                say(agent, `Aaa! A ${enemy.name.replace("_", " ")}!`);
                execute(this, agent, async () => {
                    await skills.avoidEnemies(agent.bot, 24);
                });
            }
        }
    },
    {
        name: 'self_defense',
        description: 'Attack nearby enemies. Interrupts all actions.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const enemy = world.getNearestEntityWhere(agent.bot, entity => mc.isHostile(entity), 8);
            if (enemy && await world.isClearPath(agent.bot, enemy)) {
                execute(this, agent, async () => {
                    await skills.defendSelf(agent.bot, 8);
                });
            }
        }
    },
    {
        name: 'pvp',
        description: 'God-level PvP retaliation. Strafes, crit-jumps, uses shield, eats mid-fight.',
        interrupts: ['all'],
        on: true,
        active: false,
        update: async function (agent) {
            const attacker = agent.bot.lastAttacker;
            if (!attacker || Date.now() - (agent.bot.lastDamageTime || 0) > 5000) {
                agent.bot.lastAttacker = null;
                return;
            }
            if (attacker && attacker.isValid && attacker.health > 0 && agent.bot.entity.position.distanceTo(attacker.position) < 24) {
                execute(this, agent, async () => {
                    await skills.fightPlayer(agent.bot, attacker);
                });
            }
        }
    },
    {
        name: 'hunting',
        description: 'Hunt nearby animals when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        update: async function (agent) {
            const huntable = world.getNearestEntityWhere(agent.bot, entity => mc.isHuntable(entity), 8);
            if (huntable && await world.isClearPath(agent.bot, huntable)) {
                execute(this, agent, async () => {
                    say(agent, `Hunting ${huntable.name}!`);
                    await skills.attackEntity(agent.bot, huntable);
                });
            }
        }
    },
    {
        name: 'item_collecting',
        description: 'Collect nearby items when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,

        wait: 2, // number of seconds to wait after noticing an item to pick it up
        prev_item: null,
        noticed_at: -1,
        update: async function (agent) {
            let item = world.getNearestEntityWhere(agent.bot, entity => entity.name === 'item', 8);
            let empty_inv_slots = agent.bot.inventory.emptySlotCount();
            if (item && item !== this.prev_item && await world.isClearPath(agent.bot, item) && empty_inv_slots > 1) {
                if (this.noticed_at === -1) {
                    this.noticed_at = Date.now();
                }
                if (Date.now() - this.noticed_at > this.wait * 1000) {
                    say(agent, `Picking up item!`);
                    this.prev_item = item;
                    execute(this, agent, async () => {
                        await skills.pickupNearbyItems(agent.bot);
                    });
                    this.noticed_at = -1;
                }
            }
            else {
                this.noticed_at = -1;
            }
        }
    },
    {
        name: 'torch_placing',
        description: 'Place torches when idle and there are no torches nearby.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        cooldown: 5,
        last_place: Date.now(),
        update: function (agent) {
            if (world.shouldPlaceTorch(agent.bot)) {
                if (Date.now() - this.last_place < this.cooldown * 1000) return;
                execute(this, agent, async () => {
                    const pos = agent.bot.entity.position;
                    await skills.placeBlock(agent.bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
                });
                this.last_place = Date.now();
            }
        }
    },
    {
        name: 'elbow_room',
        description: 'Move away from nearby players when idle.',
        interrupts: ['action:followPlayer'],
        on: true,
        active: false,
        distance: 1.5,
        cooldown: 5000,
        last_trigger: 0,
        update: async function (agent) {
            if (Date.now() - this.last_trigger < this.cooldown) return;
            const player = world.getNearestEntityWhere(agent.bot, entity => entity.type === 'player', this.distance);
            if (player) {
                execute(this, agent, async () => {
                    // wait a random amount of time to avoid identical movements with other bots
                    const wait_time = Math.random() * 1000;
                    await new Promise(resolve => setTimeout(resolve, wait_time));
                    if (player.position.distanceTo(agent.bot.entity.position) < this.distance) {
                        this.last_trigger = Date.now();
                        await skills.moveAwayFromEntity(agent.bot, player, this.distance);
                    }
                });
            }
        }
    },
    {
        name: 'walking_gaze',
        description: 'Look around naturally while walking (humans scan surroundings).',
        interrupts: [],
        on: true,
        active: false,
        next_gaze_shift: Date.now() + 2000 + Math.random() * 4000,
        update: function (agent) {
            if (agent.isIdle()) return;
            if (Date.now() < this.next_gaze_shift) return;
            const entity = agent.bot.nearestEntity();
            if (entity && entity.position.distanceTo(agent.bot.entity.position) < 12 && entity.name !== 'enderman') {
                const jitterX = (Math.random() - 0.5) * 0.5;
                const jitterY = (Math.random() - 0.5) * 0.3;
                agent.bot.lookAt(entity.position.offset(jitterX, entity.height / 2 + jitterY, 0));
            } else {
                const yaw = agent.bot.entity.yaw + (Math.random() - 0.5) * 1.5;
                const pitch = (Math.random() * 0.6) - 0.3;
                agent.bot.look(yaw, pitch, false);
            }
            this.next_gaze_shift = Date.now() + 1500 + Math.random() * 3500;
        }
    },
    {
        name: 'fidget',
        description: 'Random human-like movements when idle: jump, sneak, head turn.',
        interrupts: [],
        on: true,
        active: false,
        next_fidget: Date.now() + 5000 + Math.random() * 15000,
        update: function (agent) {
            if (!agent.isIdle()) return;
            if (Date.now() < this.next_fidget) return;
            const roll = Math.random();
            if (roll < 0.4) {
                // casual jump
                agent.bot.setControlState('jump', true);
                setTimeout(() => agent.bot.setControlState('jump', false), 200 + Math.random() * 300);
            } else if (roll < 0.6) {
                // quick sneak
                agent.bot.setControlState('sneak', true);
                setTimeout(() => agent.bot.setControlState('sneak', false), 300 + Math.random() * 500);
            } else {
                const yaw = Math.random() * Math.PI * 2;
                const pitch = (Math.random() * Math.PI/3) - Math.PI/6;
                agent.bot.look(yaw, pitch, false);
            }
            this.next_fidget = Date.now() + 8000 + Math.random() * 20000;
        }
    },
    {
        name: 'idle_staring',
        description: 'Animation to look around at entities when idle.',
        interrupts: [],
        on: true,
        active: false,

        staring: false,
        last_entity: null,
        next_change: 0,
        update: function (agent) {
            const entity = agent.bot.nearestEntity();
            let entity_in_view = entity && entity.position.distanceTo(agent.bot.entity.position) < 10 && entity.name !== 'enderman';
            if (entity_in_view && entity !== this.last_entity) {
                this.staring = true;
                this.last_entity = entity;
                // randomise look-at height slightly for human imperfection
                this.next_change = Date.now() + Math.random() * 1000 + 2000;
            }
            if (entity_in_view && this.staring) {
                let isbaby = entity.type !== 'player' && entity.metadata[16];
                let height = isbaby ? entity.height/2 : entity.height;
                // add micro-jitter to gaze — humans never stare perfectly still
                const jitterX = (Math.random() - 0.5) * 0.3;
                const jitterY = (Math.random() - 0.5) * 0.15;
                agent.bot.lookAt(entity.position.offset(jitterX, height + jitterY, 0));
            }
            if (!entity_in_view)
                this.last_entity = null;
            if (Date.now() > this.next_change) {
                this.staring = Math.random() < 0.3;
                if (!this.staring) {
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() * Math.PI/2) - Math.PI/4;
                    agent.bot.look(yaw, pitch, false);
                }
                this.next_change = Date.now() + Math.random() * 8000 + 2000;
            }
        }
    },
    {
        name: 'auto_survival',
        description: 'Auto-eat when hungry, equip armor, sleep at night.',
        interrupts: [],
        on: true,
        active: false,
        last_eat: 0,
        last_equip: 0,
        last_sleep_check: 0,
        update: async function (agent) {
            const bot = agent.bot;
            if (!bot || !bot.entity) return;
            const now = Date.now();

            if (bot.food < 10 && now - this.last_eat > 8000) {
                const food = bot.inventory.items().find(item =>
                    item.foodPoints > 0 && !['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken'].includes(item.name)
                );
                if (food && agent.isIdle()) {
                    this.last_eat = now;
                    await bot.equip(food, 'hand');
                    await bot.consume();
                }
            }

            if (now - this.last_equip > 15000 && agent.isIdle()) {
                this.last_equip = now;
                try { bot.armorManager.equipAll(); } catch (_) {}
            }

            if (now - this.last_sleep_check > 30000 && agent.isIdle()) {
                this.last_sleep_check = now;
                const time = bot.time.timeOfDay;
                if (time > 13000 && time < 23000) {
                    const bed = bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 8, count: 1 });
                    if (bed) {
                        try { await bot.sleep(bed); } catch (_) {}
                    }
                }
            }
        }
    },
    {
        name: 'cheat',
        description: 'Use cheats to instantly place blocks and teleport.',
        interrupts: [],
        on: false,
        active: false,
        update: function (agent) { /* do nothing */ }
    }
];

let _lastInterruptedAction = '';
let _lastInterruptTime = 0;

async function execute(mode, agent, func, timeout=-1) {
    if (agent.self_prompter.isActive())
        await agent.self_prompter.stopLoop();
    let interrupted_action = agent.actions.currentActionLabel;
    const now = Date.now();
    if (interrupted_action) {
      agent.brain?.trace?.markInterrupted(`mode:${mode.name} preempted ${interrupted_action}`);
    }
    mode.active = true;
    let code_return = await agent.actions.runAction(`mode:${mode.name}`, async () => {
        await func();
    }, { timeout });
    mode.active = false;

    let should_reprompt = 
        interrupted_action &&
        !agent.actions.resume_func &&
        !agent.self_prompter.isActive() &&
        !code_return.interrupted &&
        !(interrupted_action === _lastInterruptedAction && now - _lastInterruptTime < 30000);

    _lastInterruptedAction = interrupted_action;
    _lastInterruptTime = now;

    if (should_reprompt && !interrupted_action.startsWith('action:!goTo') && !interrupted_action.startsWith('action:!follow')) {
        let role = convoManager.inConversation() ? agent.last_sender : 'system';
        let logs = agent.bot.modes.flushBehaviorLog();
        try {
            await agent.handleMessage(role, `(AUTO MESSAGE)Your previous action '${interrupted_action}' was interrupted by ${mode.name}. Your behavior log: ${logs}\nRespond accordingly.`);
        } catch (err) {
            console.warn('[Mode] Auto-reprompt failed:', err.message);
        }
    }
}

let _agent = null;
const modes_map = {};
for (let mode of modes_list) {
    modes_map[mode.name] = mode;
}

class ModeController {
    /*
    SECURITY WARNING:
    ModesController must be reference isolated. Do not store references to external objects like `agent`.
    This object is accessible by LLM generated code, so any stored references are also accessible.
    This can be used to expose sensitive information by malicious prompters.
    */
    constructor() {
        this.behavior_log = '';
    }

    exists(mode_name) {
        return modes_map[mode_name] != null;
    }

    setOn(mode_name, on) {
        modes_map[mode_name].on = on;
    }

    isOn(mode_name) {
        return modes_map[mode_name].on;
    }

    pause(mode_name) {
        const mode = modes_map[mode_name];
        if (!mode) return;
        mode.paused = true;
    }

    unpause(mode_name) {
        const mode = modes_map[mode_name];
        if (!mode) return;
        if (mode.unpause && mode.paused) {
            mode.unpause();
        }
        mode.paused = false;
    }

    unPauseAll() {
        for (let mode of modes_list) {
            if (mode.paused) console.log(`Unpausing mode ${mode.name}`);
            this.unpause(mode.name);
        }
    }

    getMiniDocs() { // no descriptions
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on})`;
        }
        return res;
    }

    getDocs() {
        let res = 'Agent Modes:';
        for (let mode of modes_list) {
            let on = mode.on ? 'ON' : 'OFF';
            res += `\n- ${mode.name}(${on}): ${mode.description}`;
        }
        return res;
    }

    async update() {
        if (_agent.isIdle()) {
            this.unPauseAll();
        }
        const start = Date.now();
        for (let mode of modes_list) {
            if (Date.now() - start > 100) break;
            let interruptible = mode.interrupts.some(i => i === 'all') || mode.interrupts.some(i => i === _agent.actions.currentActionLabel);
            if (mode.on && !mode.paused && !mode.active && (_agent.isIdle() || interruptible)) {
                try {
                    await mode.update(_agent);
                } catch (e) {
                    console.warn(`[Mode] ${mode.name} update error:`, e.message);
                }
            }
            if (mode.active) break;
        }
    }

    flushBehaviorLog() {
        const log = this.behavior_log;
        this.behavior_log = '';
        return log;
    }

    getJson() {
        let res = {};
        for (let mode of modes_list) {
            res[mode.name] = mode.on;
        }
        return res;
    }

    loadJson(json) {
        for (let mode of modes_list) {
            if (json[mode.name] != undefined) {
                mode.on = json[mode.name];
            }
        }
    }

    registerMode(modeObj) {
        if (!modeObj || !modeObj.name) {
            console.warn('[ModeController] Cannot register mode without name');
            return;
        }
        if (modes_map[modeObj.name]) {
            console.warn(`[ModeController] Mode "${modeObj.name}" already registered, skipping`);
            return;
        }
        const mode = {
            name: modeObj.name,
            description: modeObj.description || modeObj.name,
            interrupts: modeObj.interrupts || [],
            on: modeObj.on !== undefined ? modeObj.on : true,
            active: false,
            paused: false,
            update: async function(agent) {
                if (modeObj.on && !this.paused && !this.active) {
                    try {
                        if (typeof modeObj.update === 'function') {
                            await modeObj.update(agent);
                        }
                    } catch (e) {
                        console.warn(`[ModeController] Mode "${modeObj.name}" update error: ${e.message}`);
                    }
                }
            }
        };
        modes_list.unshift(mode);
        modes_map[modeObj.name] = mode;
    }
}

export function initModes(agent) {
    _agent = agent;
    // the mode controller is added to the bot object so it is accessible from anywhere the bot is used
    agent.bot.modes = new ModeController();
    if (agent.task) {
        agent.bot.restrict_to_inventory = agent.task.restrict_to_inventory;
    }
    let modes_json = agent.prompter.getInitModes();
    if (modes_json) {
        agent.bot.modes.loadJson(modes_json);
    }
}

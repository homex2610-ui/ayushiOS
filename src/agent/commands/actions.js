import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { HubNavigator } from '../../connection/HubNavigator.js';
import { executeThreeTasks } from '../tasks/three_tasks.js';
import { TaskRunner } from '../TaskRunner.js';


function runAsAction (actionFn, resume = false, timeout = -1) {
    let actionLabel = null;  // Will be set on first use
    
    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        const actionFnWithAgent = async () => {
            return await actionFn(agent, ...args);
        };
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
        if (code_return.interrupted && !code_return.timedout)
            return;
        if (!code_return.success)
            return false;
        return code_return.actionResult !== undefined ? code_return.actionResult : code_return.message;
    }

    return wrappedAction;
}

export const actionsList = [
    {
        name: '!newAction',
        description: 'Perform new and unknown custom behaviors that are not available as a command.', 
        params: {
            'prompt': { type: 'string', description: 'A natural language prompt to guide code generation. Make a detailed step-by-step plan.' }
        },
        perform: async function(agent, prompt) {
            // just ignore prompt - it is now in context in chat history
            if (!settings.allow_insecure_coding) { 
                agent.openChat('newAction is disabled. Enable with allow_insecure_coding=true in settings.js');
                return "newAction not allowed! Code writing is disabled in settings. Notify the user.";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(agent.history);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins});
            return result;
        }
    },
    {
        name: '!stop',
        description: 'Force stop all actions and commands that are currently executing.',
        perform: async function (agent) {
            await agent.actions.stop();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            let msg = 'Agent stopped.';
            if (agent.self_prompter.isActive())
                msg += ' Self-prompting still active.';
            return msg;
        }
    },
    {
        name: '!stfu',
        description: 'Stop all chatting and self prompting, but continue current action.',
        perform: async function (agent) {
            agent.openChat('Shutting up.');
            agent.shutUp();
            return;
        }
    },
    {
        name: '!restart',
        description: 'Restart the agent process.',
        perform: async function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: 'Clear the chat history.',
        perform: async function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!goToPlayer',
        description: 'Go to the given player.',
        params: {
            'player_name': {type: 'string', description: 'The name of the player to go to.'},
            'closeness': {type: 'float', description: 'How close to get to the player.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            await skills.goToPlayer(agent.bot, player_name, closeness);
        })
    },
    {
        name: '!followPlayer',
        description: 'Endlessly follow the given player.',
        params: {
            'player_name': {type: 'string', description: 'name of the player to follow.'},
            'follow_dist': {type: 'float', description: 'The distance to follow from.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: 'Go to the given x, y, z location.',
        params: {
            'x': {type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: 'The y coordinate.', domain: [-64, 320]},
            'z': {type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: 'How close to get to the location.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.goToPosition(agent.bot, x, y, z, closeness);
        })
    },
    {
        name: '!jumpIntoBlock',
        description: 'Find and jump into a hole containing a specific block (e.g., red_wool). Use when told to "jump into" something.',
        params: {
            'block_type': { type: 'BlockName', description: 'The block type to find and jump into.' },
            'search_range': { type: 'float', description: 'The range to search for the block (default 128).', domain: [10, 512] }
        },
        perform: runAsAction(async (agent, block_type, search_range) => {
            await skills.jumpIntoBlock(agent.bot, block_type, search_range || 128);
        })
    },
    {
        name: '!searchForBlock',
        description: 'Find and go to the nearest block of a given type in a given range.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the block. Minimum 32.', domain: [10, 512] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!searchForEntity',
        description: 'Find and go to the nearest entity of a given type in a given range.',
        params: {
            'type': { type: 'string', description: 'The type of entity to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the entity.', domain: [32, 512] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: 'Move away from the current location in any direction by a given distance.',
        params: {'distance': { type: 'float', description: 'The distance to move away.', domain: [0, Infinity] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!rememberHere',
        description: 'Save the current location with a given name.',
        params: {'name': { type: 'string', description: 'The name to remember the location as.' }},
        perform: async function (agent, name) {
            const pos = agent.bot.entity.position;
            if (agent.memory_bank) {
                agent.memory_bank.addMemory(`Location ${name}: ${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}`, { type: 'place', importance: 0.7 });
            }
            return `Location saved as "${name}".`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: 'Go to a saved location.',
        params: {'name': { type: 'string', description: 'The name of the location to go to.' }},
        perform: runAsAction(async (agent, name) => {
            const pos = agent.memory_bank.recallPlace(name);
            if (!pos) {
            skills.log(agent.bot, `No location named "${name}" saved.`);
            return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
        })
    },
    {
        name: '!givePlayer',
        description: 'Give the specified item to the given player.',
        params: { 
            'player_name': { type: 'string', description: 'The name of the player to give the item to.' }, 
            'item_name': { type: 'ItemName', description: 'The name of the item to give.' },
            'num': { type: 'int', description: 'The number of items to give.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!consume',
        description: 'Eat/drink the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to consume.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: 'Equip the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to equip.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!putInChest',
        description: 'Put the given item in the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to put in the chest.' },
            'num': { type: 'int', description: 'The number of items to put in the chest.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.putInChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!takeFromChest',
        description: 'Take the given items from the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to take.' },
            'num': { type: 'int', description: 'The number of items to take.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.takeFromChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!viewChest',
        description: 'View the items/counts of the nearest chest.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.viewChest(agent.bot);
        })
    },
    {
        name: '!discard',
        description: 'Discard the given item from the inventory.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to discard.' },
            'num': { type: 'int', description: 'The number of items to discard.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            const start_loc = agent.bot.entity.position;
            await skills.moveAway(agent.bot, 5);
            await skills.discard(agent.bot, item_name, num);
            await skills.goToPosition(agent.bot, start_loc.x, start_loc.y, start_loc.z, 0);
        })
    },
    {
        name: '!collectBlocks',
        description: 'Collect the nearest blocks of a given type.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to collect.' },
            'num': { type: 'int', description: 'The number of blocks to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, type, num) => {
            return await skills.collectBlock(agent.bot, type, num);
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!craftRecipe',
        description: 'Craft the given recipe a given number of times.',
        params: {
            'recipe_name': { type: 'ItemName', description: 'The name of the output item to craft.' },
            'num': { type: 'int', description: 'The number of times to craft the recipe. This is NOT the number of output items, as it may craft many more items depending on the recipe.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, recipe_name, num) => {
            return await skills.craftRecipe(agent.bot, recipe_name, num);
        })
    },
    {
        name: '!smeltItem',
        description: 'Smelt the given item the given number of times.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of times to smelt the item.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            let success = await skills.smeltItem(agent.bot, item_name, num);
            if (success) {
                setTimeout(() => {
                    agent.cleanKill('Safely restarting to update inventory.');
                }, 500);
            }
            return success;
        })
    },
    {
        name: '!clearFurnace',
        description: 'Take all items out of the nearest furnace.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
        {
        name: '!placeHere',
        description: 'Place a given block in the current location. Do NOT use to build structures, only use for single blocks/torches.',
        params: {'type': { type: 'BlockOrItemName', description: 'The block type to place.' }},
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!attack',
        description: 'Attack and kill the nearest entity of a given type.',
        params: {'type': { type: 'string', description: 'The type of entity to attack.'}},
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: 'Attack a specific player until they die or run away. Uses full PvP combat (strafe, shield, crit-jump, eat mid-fight).',
        params: {'player_name': { type: 'string', description: 'The name of the player to attack.'}},
        perform: runAsAction(async (agent, player_name) => {
            let player = agent.bot.players[player_name]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            await skills.fightPlayer(agent.bot, player);
        })
    },
    {
        name: '!pvp',
        description: 'Attack the nearest player (PvP). Uses full combat: strafe, shield, crit-jump, eat mid-fight.',
        params: {},
        perform: runAsAction(async (agent) => {
            let nearest = null, nearestDist = Infinity;
            for (const [name, p] of Object.entries(agent.bot.players)) {
                if (name === agent.name) continue;
                if (!p.entity) continue;
                const d = agent.bot.entity.position.distanceTo(p.entity.position);
                if (d < nearestDist) { nearest = p.entity; nearestDist = d; }
            }
            if (!nearest) {
                skills.log(agent.bot, 'No players nearby to fight.');
                return false;
            }
            return await skills.fightPlayer(agent.bot, nearest);
        })
    },
    {
        name: '!goToBed',
        description: 'Go to the nearest bed and sleep.',
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        })
    },
    {
        name: '!stay',
        description: 'Stay in the current location no matter what. Pauses all modes.',
        params: {'type': { type: 'int', description: 'The number of seconds to stay. -1 for forever.', domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        description: 'Set a mode to on or off. A mode is an automatic behavior that constantly checks and responds to the environment.',
        params: {
            'mode_name': { type: 'string', description: 'The name of the mode to enable.' },
            'on': { type: 'boolean', description: 'Whether to enable or disable the mode.' }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
            return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
            return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!goal',
        description: 'Set a goal prompt to endlessly work towards with continuous self-prompting.',
        params: {
            'selfPrompt': { type: 'string', description: 'The goal prompt.' },
        },
        perform: async function (agent, prompt) {
            if (convoManager.inConversation()) {
                agent.self_prompter.setPromptPaused(prompt);
            }
            else {
                agent.self_prompter.start(prompt);
            }
        }
    },
    {
        name: '!endGoal',
        description: 'Call when you have accomplished your goal. It will stop self-prompting and the current action. ',
        perform: async function (agent) {
            agent.self_prompter.stop();
            return 'Self-prompting stopped.';
        }
    },
    {
        name: '!showVillagerTrades',
        description: 'Show trades of a specified villager.',
        params: {'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' }},
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: 'Trade with a specified villager.',
        params: {
            'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' },
            'index': { type: 'int', description: 'The index of the trade you want executed (1-indexed).', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: 'How many times that trade should be executed.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: 'Start a conversation with a bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to send the message to.' },
            'message': { type: 'string', description: 'The message to send.' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name)) 
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                agent.history.add('system', 'You are already in conversation with ' + player_name + '. Don\'t use this command to talk to them.');
            convoManager.startConversation(player_name, message);
        }
    },
    {
        name: '!endConversation',
        description: 'End the conversation with the given bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to end the conversation with.' }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
    },
    {
        name: '!lookAtPlayer',
        description: 'Look at a player or look in the same direction as the player.',
        params: {
            'player_name': { type: 'string', description: 'Name of the target player' },
            'direction': {
                type: 'string',
                description: 'How to look ("at": look at the player, "with": look in the same direction as the player)',
            }
        },
        perform: async function(agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!lookAtPosition',
        description: 'Look at specified coordinates.',
        params: {
            'x': { type: 'int', description: 'x coordinate' },
            'y': { type: 'int', description: 'y coordinate' },
            'z': { type: 'int', description: 'z coordinate' }
        },
        perform: async function(agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPosition(x, y, z);
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: 'Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.',
        params: {'distance': { type: 'int', description: 'Distance to dig down', domain: [1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, distance) => {
            return await skills.digDown(agent.bot, distance);
        })
    },
    {
        name: '!goToSurface',
        description: 'Moves the bot to the highest block above it (usually the surface).',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!useOn',
        description: 'Use (right click) the given tool on the nearest target of the given type.',
        params: {
            'tool_name': { type: 'string', description: 'Name of the tool to use, or "hand" for no tool.' },
            'target': { type: 'string', description: 'The target as an entity type, block type, or "nothing" for no target.' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
    {
        name: '!bowAttack',
        description: 'Shoot arrows at the nearest player or mob using a bow.',
        params: {'target_name': { type: 'string', description: 'Name of the target player/mob to shoot.' }},
        perform: runAsAction(async (agent, target_name) => {
            const target = agent.bot.players[target_name]?.entity || world.getNearestEntityWhere(agent.bot, e => e.name === target_name, 24);
            if (!target) { skills.log(agent.bot, `Could not find ${target_name}.`); return false; }
            await skills.bowAttack(agent.bot, target);
        })
    },
    {
        name: '!stripMine',
        description: 'Strip mine forward for a set number of blocks.',
        params: {'length': { type: 'int', description: 'How far to mine forward.', domain: [1, 100] }},
        perform: runAsAction(async (agent, length) => {
            await skills.stripMine(agent.bot, length);
        })
    },
    {
        name: '!buildShelter',
        description: 'Build a quick emergency shelter using available materials.',
        params: {'size': { type: 'int', description: 'Size of the shelter (default 5).', domain: [3, 10] }},
        perform: runAsAction(async (agent, size=5) => {
            await skills.buildShelter(agent.bot, size);
        })
    },
    {
        name: '!plantAndHarvest',
        description: 'Harvest mature crops and optionally plant new seeds in a radius.',
        params: {'seed_type': { type: 'string', description: 'Seed type to plant (e.g. wheat_seeds). Optional.' }},
        perform: runAsAction(async (agent, seed_type) => {
            return await skills.plantAndHarvest(agent.bot, seed_type || null);
        })
    },
    {
        name: '!cookAllFood',
        description: 'Cook all raw food in a nearby furnace.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.cookAllFood(agent.bot);
        })
    },
    {
        name: '!organizeInventory',
        description: 'Deposit all inventory items into the nearest chest.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.organizeInventory(agent.bot);
        })
    },
    {
        name: '!lightSurroundings',
        description: 'Place torches in a radius to light up the area.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.lightSurroundings(agent.bot);
        })
    },
    {
        name: '!buildBridge',
        description: 'Build a bridge in the direction you are looking.',
        params: {'length': { type: 'int', description: 'How long the bridge should be.', domain: [1, 50] }},
        perform: runAsAction(async (agent, length) => {
            await skills.buildBridge(agent.bot, length);
        })
    },
    {
        name: '!harvestTrees',
        description: 'Harvest all nearby trees (logs) within range.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.harvestNearbyTrees(agent.bot);
        })
    },
    {
        name: '!farmXP',
        description: 'Kill nearby hostile mobs for experience.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.farmExperience(agent.bot);
        })
    },
    {
        name: '!goFishing',
        description: 'Go fishing a number of times.',
        params: {'casts': { type: 'int', description: 'Number of casts.', domain: [1, 20] }},
        perform: runAsAction(async (agent, casts) => {
            await skills.goFishing(agent.bot, casts);
        })
    },
    {
        name: '!breedAnimals',
        description: 'Breed two animals of the given type.',
        params: {'animal_type': { type: 'string', description: 'Type of animal to breed (cow, sheep, pig, chicken).' }},
        perform: runAsAction(async (agent, animal_type) => {
            await skills.breedAnimals(agent.bot, animal_type);
        })
    },
    {
        name: '!enchantItem',
        description: 'Open an enchanting table with the given item.',
        params: {'item_name': { type: 'string', description: 'Name of the item to enchant.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.enchantItem(agent.bot, item_name);
        })
    },
    {
        name: '!buildPortal',
        description: 'Build a nether portal (need 10 obsidian + flint/steel).',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.buildNetherPortal(agent.bot);
        })
    },
    {
        name: '!goToMode',
        description: 'Navigate to a different game mode on the server (survival, pvp, practice, kitpvp, bedwars, skywars, lifesteal, minigame). Walks to mode NPCs/armor stands or uses commands.',
        params: {
            'mode': { type: 'string', description: 'Target game mode to navigate to.' }
        },
        perform: runAsAction(async (agent, mode) => {
            const navigator = new HubNavigator(agent.bot);
            const result = await navigator.navigateToMode(mode);
            navigator.reset();
            if (result) {
                skills.log(agent.bot, `Successfully navigated to ${mode} mode.`);
                return true;
            }
            skills.log(agent.bot, `Failed to navigate to ${mode} mode.`);
            return false;
        })
    },
    {
        name: '!interactWithNPC',
        description: 'Find and interact (right-click) with the nearest NPC matching the given name (shop, survival, pvp, quest, etc). Returns whether a GUI was opened.',
        params: {
            'name_or_trait': { type: 'string', description: 'NPC name to search for (e.g. "shop", "survival", "pvp", or a specific name).' }
        },
        perform: runAsAction(async (agent, name_or_trait) => {
            const result = await skills.interactWithEntity(agent.bot, name_or_trait);
            if (!result.success) return `Could not interact with "${name_or_trait}": ${result.reason}`;
            if (result.window) return `Interacted with "${name_or_trait}" — GUI opened.`;
            return `Interacted with "${name_or_trait}" — no GUI detected.`;
        })
    },
    {
        name: '!listNPCs',
        description: 'List all detected NPCs on the server with their positions and traits.',
        params: {},
        perform: runAsAction(async (agent) => {
            const analyzer = agent.serverAnalyzer;
            if (!analyzer || !analyzer.npc) return 'NPC analyzer not available.';
            const npcs = analyzer.kb.get('npcs') || [];
            if (npcs.length === 0) return 'No NPCs detected yet. Scan is ongoing.';
            const bot = agent.bot;
            let res = 'DETECTED_NPCS';
            for (const npc of npcs) {
                const dist = bot.entity?.position ? Math.round(bot.entity.position.distanceTo({ x: npc.position.x, y: npc.position.y, z: npc.position.z })) : '?';
                const traits = npc.traits?.length ? `[${npc.traits.join(', ')}]` : '';
                res += `\n- ${npc.name} (${npc.type}) at ${npc.position.x},${npc.position.y},${npc.position.z} (${dist}m away) ${traits}`;
            }
            return res;
        })
    },
    {
        name: '!bt',
        description: 'Toggle behavior tree AI on/off. Usage: !bt [on|off|status]',
        perform: async (agent, arg) => {
            if (arg === 'on' || arg === 'true') {
                settings.bt_enabled = true;
                return 'BT enabled';
            }
            if (arg === 'off' || arg === 'false') {
                settings.bt_enabled = false;
                if (agent.btCurrentTask) {
                    agent.btCurrentTask.reset();
                    agent.btCurrentTask = null;
                }
                agent.requestInterrupt();
                return 'BT disabled';
            }
            return `BT is ${settings.bt_enabled ? 'ON' : 'OFF'} | decisions made: ${agent._btDecisionCount || 0}`;
        },
        params: {
            arg: {
                type: 'string',
                description: '"on", "off", or "status" (default: "status")',
                optional: true,
            }
        }
    },
    {
        name: '!threeTasks',
        description: 'Execute 3 tasks in sequence: (1) kill 3 players (PvP), (2) build wheat farm, (3) craft iron armor set.',
        params: {},
        perform: async function (agent) {
            if (!agent.bot?.entity) return 'Bot not spawned yet.';
            agent.actions.runAction('action:threeTasks', async () => {
                try {
                    const result = await executeThreeTasks(agent);
                    return `Three tasks done! Kills: ${result.kills}/3, Farm: ${result.farmResult ? 'OK' : 'FAIL'}, Armor: ${result.armorResult ? 'OK' : 'FAIL'}`;
                } catch (err) {
                    console.error('[ThreeTasks] Fatal error:', err);
                    return `Three tasks failed: ${err.message}`;
                }
            }).catch(err => console.error('[ThreeTasks] Action error:', err));
        }
    },
    {
        name: '!runTask',
        description: 'Run a JSON-defined task from the tasks/ folder. Example: !runTask("three_tasks") or !runTask("master_survival")',
        params: {
            'taskName': { type: 'string', description: 'Name of the task file (without .json)' }
        },
        perform: async function (agent, taskName) {
            if (!agent.bot?.entity) return 'Bot not spawned yet.';
            const runner = agent.taskRunner || new TaskRunner(agent.bot);
            return await agent.actions.runAction('action:runTask', async () => {
                const result = await runner.runTaskFromFile(taskName);
                if (result.success) return `Task "${taskName}" completed successfully!`;
                return `Task "${taskName}" failed at step ${result.failedStep}: ${result.reason}`;
            });
        }
    },
    {
        name: '!listTasks',
        description: 'List all available JSON task files in the tasks/ folder.',
        params: {},
        perform: async function (agent) {
            const tasks = TaskRunner.getAvailableTasks();
            if (tasks.length === 0) return 'No task files found in tasks/ folder.';
            return `Available tasks:\n${tasks.map(t => `  - ${t}`).join('\n')}\nRun with !runTask("taskName")`;
        }
    },
];

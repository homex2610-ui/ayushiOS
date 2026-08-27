import { 
    getPosition,
    getBiomeName,
    getNearbyPlayerNames,
    getInventoryCounts,
    getNearbyEntityTypes,
    getBlockAtPosition,
    getFirstBlockAboveHead
} from "./world.js";
import convoManager from '../conversation.js';

export function getFullState(agent) {
    const bot = agent.bot;

    // Pre-spawn guard — bot.entity or bot.game not ready yet
    if (!bot?.entity?.position || !bot?.game) {
        return {
            name: agent.name,
            brain: null,
            gameplay: { position: {x:0,y:0,z:0}, dimension: 'unknown', gamemode: 'unknown', health: 0, hunger: 0, biome: 'unknown', weather: 'Clear', timeOfDay: 0, timeLabel: 'Unknown' },
            action: { current: 'Spawning', kind: 'spawning', isIdle: true },
            surroundings: { below: 'air', legs: 'air', head: 'air', firstBlockAboveHead: null },
            inventory: { counts: {}, stacksUsed: 0, totalSlots: 45, equipment: {helmet:null,chestplate:null,leggings:null,boots:null,mainHand:null} },
            nearby: { humanPlayers: [], botPlayers: [], entityTypes: [] },
            modes: { summary: '' }
        };
    }

    const pos = getPosition(bot);
    const position = {
        x: Number(pos.x.toFixed(2)),
        y: Number(pos.y.toFixed(2)),
        z: Number(pos.z.toFixed(2))
    };

    let weather = 'Clear';
    if (bot.thunderState > 0) weather = 'Thunderstorm';
    else if (bot.rainState > 0) weather = 'Rain';

    let timeLabel = 'Night';
    if (bot.time?.timeOfDay < 6000) timeLabel = 'Morning';
    else if (bot.time?.timeOfDay < 12000) timeLabel = 'Afternoon';

    const below = getBlockAtPosition(bot, 0, -1, 0).name;
    const legs = getBlockAtPosition(bot, 0, 0, 0).name;
    const head = getBlockAtPosition(bot, 0, 1, 0).name;

    let players = getNearbyPlayerNames(bot);
    let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
    players = players.filter(p => !bots.includes(p));

    const helmet = bot.inventory.slots[5];
    const chestplate = bot.inventory.slots[6];
    const leggings = bot.inventory.slots[7];
    const boots = bot.inventory.slots[8];

    // Richer activity than a bare "Idle": a bot counts as idle (no action executing) even while
    // chatting, deciding its next move, or stopped. Surface those so the dashboard is meaningful.
    let activity;
    if (!agent.isIdle()) {
        activity = { current: agent.actions.currentActionLabel || 'Acting', kind: 'acting' };
    } else if (convoManager.inConversation()) {
        const who = convoManager.activeConversation?.name;
        activity = { current: who ? `Chatting with ${who}` : 'Chatting', kind: 'chatting' };
    } else if (agent.self_prompter.isStopped()) {
        activity = { current: 'Stopped', kind: 'stopped' };   // self-prompter OFF: won't act on its own
    } else if (agent.self_prompter.isPaused()) {
        activity = { current: 'Chatting', kind: 'chatting' };
    } else if (agent.self_prompter.isActive()) {
        activity = { current: 'Thinking', kind: 'thinking' }; // self-prompting between actions
    } else {
        activity = { current: 'Idle', kind: 'idle' };
    }

    // Brain telemetry for dashboard (best-effort, never throw)
    let brain = null;
    try {
        const ayu = agent.brain;
        if (ayu) {
            const preds = ayu._nnPredictions || null;
            const nn = ayu.neuralNet ? { trainSteps: ayu.neuralNet.trainSteps ?? 0, replay: (ayu._nnReplay?.length ?? 0) } : null;
            const qd = ayu.executive?.quantumMind?.describe?.() || null;
            const am = ayu.actionMemory;
            brain = {
                neural: preds ? { ...preds, ...(nn || {}) } : (nn ? { ...nn, danger: null, hungerRisk: null, readiness: null } : null),
                quantum: qd,
                sensorCount: ayu.sensorArray ? 22 : 0,
                actionMemory: am ? { entries: am.entries.size } : null,
                features: ayu.sensorArray?.lastFeatures?.slice(0, 10) || null,
            };
        }
    } catch (_) { /* dashboard is non-critical */ }

    // Task progress (best-effort)
    let taskProgress = null;
    try {
        const tr = agent.taskRunner;
        if (tr && tr.currentTask) {
            taskProgress = {
                taskFile: tr.currentTask.file || null,
                stepIndex: tr._stepIndex ?? 0,
                stepTotal: tr.currentTask.steps?.length ?? 0,
                currentStep: tr.currentTask.steps?.[tr._stepIndex ?? 0] || null,
                busy: !!tr._busy,
            };
        }
    } catch (_) {}

    const state = {
        name: agent.name,
        brain,
        taskProgress,
        gameplay: {
            position,
            dimension: bot.game.dimension,
            gamemode: bot.game.gameMode,
            health: Math.round(bot.health),
            hunger: Math.round(bot.food),
            biome: getBiomeName(bot),
            weather,
            timeOfDay: bot.time?.timeOfDay ?? 0,
            timeLabel
        },
        action: {
            current: activity.current,
            kind: activity.kind,
            isIdle: agent.isIdle()
        },
        surroundings: {
            below,
            legs,
            head,
            firstBlockAboveHead: getFirstBlockAboveHead(bot, null, 32)
        },
        inventory: {
            counts: getInventoryCounts(bot),
            stacksUsed: bot.inventory.items().length,
            totalSlots: bot.inventory.slots.length,
            equipment: {
                helmet: helmet ? helmet.name : null,
                chestplate: chestplate ? chestplate.name : null,
                leggings: leggings ? leggings.name : null,
                boots: boots ? boots.name : null,
                mainHand: bot.heldItem ? bot.heldItem.name : null
            }
        },
        nearby: {
            humanPlayers: players,
            botPlayers: bots,
            entityTypes: getNearbyEntityTypes(bot).filter(t => t !== 'player' && t !== 'item'),
        },
        modes: {
            summary: bot.modes.getMiniDocs()
        }
    };

    return state;
}
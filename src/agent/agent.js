import { History } from './history.js';
import { Coder } from './coder.js';
import { RuleBrain } from './rule_brain.js';
import { DeterministicBrain } from './deterministic_brain.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import fs from 'fs';
import path from 'path';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import { PACE, humanPause } from './Pacing.js';
import { WorldKnowledge } from './world_knowledge.js';
import { ServerAnalyzer } from '../serverAnalyzer/ServerAnalyzer.js';
import { HubMode } from '../hub/HubMode.js';

import { computeHubScore } from '../hub/HubDetector.js';
import { EnvironmentReporter } from '../environment/EnvironmentReporter.js';
import { ServerCapabilities } from '../capabilities/ServerCapabilities.js';
import { CuriosityEngine } from './curiosity_engine.js';
import { EmotionState } from './emotion_state.js';
import { RelationshipManager } from './relationship_manager.js';
import { KnowledgeGraph } from './knowledge_graph.js';
import { GoalPlanner } from './goal_planner.js';
import { EpisodicReplay } from './episodic_replay.js';
import { ReflectionEngine } from './reflection_engine.js';
import { SkillLearner } from './skill_learner.js';
import { MetaLearner } from './meta_learner.js';
import { connectionManager } from '../connection/ConnectionManager.js';
import { FastReply } from '../intent/FastReply.js';
import { IntentParser, intentParser } from '../intent/IntentParser.js';
import { TaskQueue } from '../intent/TaskQueue.js';
import { Intent, IntentConfidence } from '../intent/IntentTypes.js';
import { EventEmitter } from 'events';
import { startIdleLookRoutine } from './Humanizer.js';
import { AyushiOS } from '../brain/AyushiOS.js';
import { TaskRunner } from './TaskRunner.js';
import { EventBus } from '../core/EventBus.js';
// WorldState removed — redundant with SensoryCortex/WorldModel

// Behavior Tree modules
import { BTMemory } from './bt/memory.js';
import { Perception } from './bt/perception.js';
import { UtilityScorer } from './bt/utility.js';
import { BehaviorTree } from './bt/bt.js';
import { Planner } from './bt/planning.js';
import { ServerIntel } from './bt/serverIntel.js';

export class Agent extends EventEmitter {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;
        this._messageQueue = [];
        this._processingMessage = false;
        this._recentCommands = [];
        this._pendingChats = [];
        this._loopRunning = false;
        this._loopTimeout = null;
        this._lastKeepAliveAck = Date.now();
        this._lastChatTime = 0;
        this.fastReply = new FastReply(this);
        this.taskQueue = null;
        this.taskRunner = null;
        this.brain = null;
        this.brainIsBusy = false;
        this._busySince = 0;

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);

        // ═══ CONSOLE HOOK → VISION BOT ═══
        // Pipe all console output to MindServer so the vision page sees it.
        const _origLog = console.log.bind(console);
        const _origWarn = console.warn.bind(console);
        const _origError = console.error.bind(console);
        const _sendLog = (args) => {
            try {
                const msg = args.map(a => (typeof a === 'string') ? a : JSON.stringify(a)).join(' ');
                sendOutputToServer(this.name, msg);
            } catch (_) {}
        };
        console.log = (...args) => { _origLog(...args); _sendLog(args); };
        console.warn = (...args) => { _origWarn(...args); _sendLog(args); };
        console.error = (...args) => { _origError(...args); _sendLog(args); };
        
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank(this.name || 'ayushi');
        this.memory_bank.setAgent(this);
        this.emotionState = settings.enable_emotions !== false ? new EmotionState() : null;
        this.relationshipManager = settings.enable_relationships !== false ? new RelationshipManager(this) : null;
        this.knowledgeGraph = settings.enable_knowledge_graph !== false ? new KnowledgeGraph() : null;
        this.goalPlanner = settings.enable_goal_planner !== false ? new GoalPlanner(this) : null;
        this.episodicReplay = settings.enable_episodic_replay !== false ? new EpisodicReplay(this) : null;
        this.reflectionEngine = settings.enable_reflection !== false ? new ReflectionEngine(this) : null;
        this.skillLearner = settings.enable_skill_learning !== false ? new SkillLearner(this) : null;
        this.metaLearner = settings.enable_meta_learning !== false ? new MetaLearner(this) : null;

        if (this.relationshipManager) this.memory_bank.setRelationshipManager(this.relationshipManager);
        this.memory_bank.restoreSubsystems(this);
        this.self_prompter = new SelfPrompter(this);
        this.ruleBrain = new RuleBrain(this);   // zero-LLM deterministic brain
        this.deterministicBrain = new DeterministicBrain(this);  // RiveScript + NLP + Markov

        // Behavior Tree subsystems
        this.btMemory = new BTMemory(this.name || 'ayushi');
        this.btServerIntel = new ServerIntel(this.btMemory);
        this.btPerception = new Perception();
        this.btScorer = new UtilityScorer();
        this.btTree = new BehaviorTree();
        this.btPlanner = new Planner();
        this.btCurrentTask = null;
        this._btMutex = null;
        this._btDecisionCount = 0;

        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = (settings.blocked_actions || []).concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);

        this.eventBus = new EventBus(this.bot);
        // WorldState removed — redundant with SensoryCortex/WorldModel

        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Reset all busy flags before exit/reconnect
            this._busySince = 0;
            if (this.brain?.motor) this.brain.motor.isBusy = false;

            const { type } = handleDisconnection(this.name, reason);

            const navOnBot = this.bot && this.bot._navigationInProgress;
            if (navOnBot) {
                console.log('[Agent] Disconnected during hub navigation — grace period before forced restart.');
                // Nothing reconnects in-process (ReconnectManager is dormant) and
                // the outer supervisor only acts on process exit. Without this
                // bound, a dead socket mid-hub-nav leaves a live zombie process.
                if (!this._navGraceTimer) {
                    this._navGraceTimer = setTimeout(() => {
                        console.error('[Agent] Hub-nav disconnect grace expired — forcing exit for restart.');
                        process.exit(1);
                    }, 90000);
                    this._navGraceTimer.unref?.();
                }
                return;
            }

            // Don't crash — allow reconnect manager to handle it
            if (settings.connection_auto_reconnect) {
                console.log('[Agent] Disconnected — restarting for auto-reconnect.');
                // In child-process architecture, exit so run_forever.ps1 restarts quickly
                setTimeout(() => process.exit(1), 500);
                return;
            }
            process.exit(1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        if (this.bot._client) {
            this._onKeepAliveAck = () => { this._lastKeepAliveAck = Date.now(); };
            this.bot._client.on('keep_alive', this._onKeepAliveAck);
        }
        this.bot.on('error', (err) => {
            const msg = String(err);
            if (msg.includes('Duplicate') || msg.includes('ECONNREFUSED') || msg.includes('ECONNRESET')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${msg}`);
                 if (err?.stack) console.error(err.stack.split('\n').slice(0, 8).join('\n'));
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin) {
                try {
                    this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
                } catch (_) {}
            }
        });
		const spawnTimeoutDuration = settings.spawn_timeout ?? 30;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                try {
                    this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);
                } catch (e) {
                    console.warn('Vision interpreter init failed:', e.message);
                    this.vision_interpreter = null;
                }

                this.worldKnowledge = new WorldKnowledge(this);
                this.serverAnalyzer = new ServerAnalyzer(this);
                // Persona proactive reactions (mood chatter, sunset/kill/diamond remarks)
                try { this.deterministicBrain?.persona?.attach(this.bot); } catch (_) {}
                const brainEnabled = settings.enable_brain !== false;
                if (brainEnabled) {
                    this.serverAnalyzer.setPassiveCommandDiscovery(true);
                }
                this.serverAnalyzer.start();
                this.btServerIntel.attach(this.bot);
                // Pro inventory brain — sorting, triage, chest memory, gear care
                try {
                    const { InventoryManager } = await import('./inventory/InventoryManager.js');
                    this.inventoryManager = new InventoryManager(this.bot, { username: this.name });
                    this._invTimer = setInterval(() => {
                        this._inventoryTick().catch(() => {});
                    }, 8000);
                    this._invTimer.unref?.();
                } catch (e) {
                    console.warn('[Agent] InventoryManager init failed:', e.message);
                }

                // ═══ KEEP-ALIVE: prevent server timeout ═══
                // Pro player insight: servers kick idle connections.
                // Jump every 30s to keep the connection alive and prevent timeout.
                this._keepAliveTimer = setInterval(() => {
                    try {
                        if (this.bot?.entity && !this.bot.interrupt_code) {
                            this.bot.setControlState('jump', true);
                            setTimeout(() => {
                                try { this.bot.setControlState('jump', false); } catch (_) {}
                            }, 100);
                        }
                    } catch (_) {}
                }, 30000);
                this._keepAliveTimer.unref?.();
                this.curiosityEngine = new CuriosityEngine(this);
                if (settings.enable_curiosity !== false) {
                    this.curiosityEngine.start({ advisorMode: brainEnabled });
                }
                if (this.goalPlanner && settings.enable_goal_planner !== false) {
                    this.goalPlanner.start({ advisorMode: brainEnabled });
                }

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 2000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();

                // World classification & hub navigation via ConnectionManager
                const worldResult = await connectionManager.handleSpawn(this.bot);
                console.log(`[Agent] Connection ready: world=${worldResult.worldProfile?.type}, server=${worldResult.server?.host || 'unknown'}`);

                // Initialize hub detection system (disabled when AyushiOS brain is active)
                if (settings.enable_brain === false) {
                    this.hubMode = new HubMode(this);
                    this.bot.modes.registerMode({
                        name: 'hub_navigator',
                        description: 'Detect hub/lobby and navigate to survival server',
                        on: true,
                        interrupts: ['all'],
                        update: async (agent) => {
                            if (this.hubMode) {
                                try {
                                    this.hubMode.update(agent);
                                } catch (e) {
                                    console.warn('[HubMode] Error:', e.message);
                                }
                            }
                        }
                    });
                } else {
                    this.hubMode = null;
                }

                // Initialize environment reporter (structured env data)
                this.envReporter = new EnvironmentReporter(this);

                // Initialize server capability detector
                this.serverCapabilities = new ServerCapabilities(this.bot);
                this.serverCapabilities.detect().catch(err => {
                    console.warn('[Agent] Server capability detection failed:', err.message);
                });

                // Initialize intent system and task queue
                this.taskQueue = new TaskQueue(this);
                if (this.taskQueue.resumeTasks(this)) {
                    console.log('[Agent] Resuming pending tasks...');
                }

                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
              
                if (!load_mem) {
                    if (settings.task) {
                        await this.task.initBotTask();
                        await this.task.setAgentGoal();
                    }
                } else {
                    if (settings.task) {
                        await this.task.setAgentGoal();
                    }
                }

                // [AyushiOS] Hub Navigation — detect if we're really in survival or on a hub masquerading as survival
                const stateIsSurvival = connectionManager.state === 'survival';
                const gamemodeIsSurvival = this.bot?.game?.gameMode === 'survival';

                // Check for hub NPCs directly from entities (not serverCapabilities — may not be ready yet)
                const modeNpcNames = ['survival', 'smp', 'lifesteal', 'practice', 'kitpvp', 'bedwars', 'skywars', 'minigame', 'parkour', 'factions', 'advertise'];
                const hasModeNPCs = Object.values(this.bot.entities || {}).some(e => {
                    const entityName = e.username || e.name || e.displayName || '';
                    if (e.type === 'player' && entityName === this.bot.username) return false;
                    if (e.type === 'player' && entityName && this.bot.players?.[entityName]) return false;
                    const name = (e.displayName || e.name || e.username || '').toLowerCase().replace(/§./g, '');
                    const customName = e.metadata?.[2]?.toString?.().replace(/§./g, '').toLowerCase().trim();
                    const matchText = customName || name;
                    return matchText.length > 0 && modeNpcNames.some(k => matchText.includes(k));
                });

                const npcHub = hasModeNPCs && (gamemodeIsSurvival || stateIsSurvival);
                // Already in survival if gamemode and state both say survival — skip hub join
                const alreadySurvival = (gamemodeIsSurvival || stateIsSurvival) && connectionManager.state !== 'hub';

                if (npcHub && !alreadySurvival) {
                    console.log(`[Agent] Hub NPCs detected (gameMode=${this.bot?.game?.gameMode}, state=${connectionManager.state}). Attempting to join survival...`);

                    // Ensure we're authenticated before sending server commands
                    if (settings.auth !== 'offline' && settings.password) {
                        this.bot.chat(`/login ${settings.password}`);
                        await new Promise(r => setTimeout(r, 2000));
                    }

                    // Send survival join commands (no pathfinder — bot can't move on hub platforms)
                    const survivalCmds = ['/server survival', '/survival', '/join survival', '/smp'];
                    const origPos = this.bot.entity?.position ? { x: this.bot.entity.position.x, y: this.bot.entity.position.y, z: this.bot.entity.position.z } : null;
                    let joined = false;
                    for (const cmd of survivalCmds) {
                        this.bot.chat(cmd);
                        console.log(`[Agent] Sent "${cmd}", waiting 6s for position change...`);
                        await new Promise(r => setTimeout(r, 6000));
                        const newPos = this.bot.entity?.position;
                        if (newPos && origPos) {
                            const dx = newPos.x - origPos.x;
                            const dy = newPos.y - origPos.y;
                            const dz = newPos.z - origPos.z;
                            if (Math.sqrt(dx*dx + dy*dy + dz*dz) > 3) {
                                console.log(`[Agent] Joined survival via "${cmd}" (moved ${Math.round(Math.sqrt(dx*dx + dy*dy + dz*dz))}m)`);
                                joined = true;
                                break;
                            }
                        }
                    }
                    if (!joined) {
                        console.warn('[Agent] Could not join survival via commands. Will retry in next cycle.');
                    }
                } else if (alreadySurvival) {
                    console.log(`[Agent] Already in survival (gameMode=${this.bot?.game?.gameMode}, state=${connectionManager.state}) — proceeding directly`);
                }

                await new Promise((resolve) => setTimeout(resolve, 2000));
                this.checkAllPlayersPresent();

                // [AyushiOS] Boot the brain after all systems are online
                if (settings.enable_brain !== false) {
                    try {
                        this.taskRunner = new TaskRunner(this.bot);
                        this.brain = new AyushiOS(this.bot, this.taskRunner, {
                            serverAnalyzer: this.serverAnalyzer,
                            connectionManager,
                        });
                        this.serverAnalyzer?.setPassiveCommandDiscovery?.(true);
                        this.curiosityEngine?.setAdvisorMode?.(true);
                        this.goalPlanner?.setAdvisorMode?.(true);
                        // If a task queue is loaded, pin motor busy to prevent interference
                        if (this.brain && this.brain.motor && settings._taskSteps?.length > 0) {
                            this.brain.motor.pinBusy('grind');
                        }
                        console.log('[AyushiOS] Brain booted — knowledge pipeline + advisors online.');
                    } catch (brainErr) {
                        console.error('[AyushiOS] Failed to boot brain:', brainErr.message);
                        this.brain = null;
                    }
                }

                // Execute diamond_grind task steps via TaskRunner after brain boots
                if (settings._taskSteps && Array.isArray(settings._taskSteps)) {
                    const humanDelay = Math.floor(Math.random() * 1000) + 500;
                    console.log(`[Agent] Will execute ${settings._taskSteps.length} task steps after ${humanDelay}ms delay...`);

                    // Track task file for progress persistence
                    this._currentTaskFile = settings.auto_task_file || 'unknown';
                    this._currentTotalSteps = settings._taskSteps.length;

                    // Check for saved progress to resume after death
                    const savedProgress = this._loadTaskProgress();
                    let startStep = 0;
                    if (savedProgress && savedProgress.taskFile === this._currentTaskFile && savedProgress.stepIndex > 0) {
                        startStep = savedProgress.stepIndex;
                        console.log(`[Agent] Resuming from step ${startStep} after death (saved ${Math.round((Date.now() - savedProgress.timestamp) / 1000)}s ago)`);
                        // Clear the saved progress file now that we're resuming
                        try {
                            fs.unlinkSync(path.join('bots', this.name, 'task_progress.json'));
                        } catch (_) {}
                    }

                    const idleLook = startIdleLookRoutine(this.bot);

                    setTimeout(async () => {
                        if (!this.bot || !this.bot.entity) {
                            console.log('[Agent] Bot disconnected before task could start.');
                            return;
                        }
                        idleLook.stop();

                        // Wait for brain to be ready
                        const brainWaitStart = Date.now();
                        while (!this.taskRunner && Date.now() - brainWaitStart < 20000) {
                            await new Promise(r => setTimeout(r, 500));
                        }

                        if (!this.taskRunner) {
                            console.warn('[Agent] TaskRunner not available — cannot execute steps');
                            return;
                        }

                        console.log(`[Agent] Starting diamond grind: ${settings._taskSteps.length} steps`);
                        if (this.brain && this.brain.motor) {
                            this.brain.motor.pinBusy('grind');
                        }

                        // Pre-grind survival loop — Maslow-style priorities
                        // Based on expert grinding research: shield first, then tools, then food
                        try {
                            const p = this.bot.entity?.position;
                            const { isHostile } = await import('../utils/mcdata.js');
                            const { eatBestFood, digUpToSurface } = await import('./library/skills.js');
                            const walkSkill = this.taskRunner?.skills?.['move_to'];

                            // ═══════════════════════════════════════════════════════════
                            // PHASE 0: SURFACE CHECK — pro players NEVER stay underground
                            // ═══════════════════════════════════════════════════════════
                            // Check if we're underground (no sky visible above)
                            try {
                                const skyCheck = this.bot.blockAt(this.bot.entity.position.offset(0, 2, 0));
                                const skyCheck2 = this.bot.blockAt(this.bot.entity.position.offset(0, 5, 0));
                                const isUnderground = skyCheck && skyCheck.name !== 'air' && skyCheck2 && skyCheck2.name !== 'air';
                                if (isUnderground) {
                                    console.log(`[Agent] Underground at Y=${Math.round(p.y)} — digging to surface`);
                                    const reached = await digUpToSurface(this.bot, 25);
                                    if (reached) {
                                        console.log(`[Agent] Reached surface at Y=${Math.round(this.bot.entity.position.y)}`);
                                    } else {
                                        console.log(`[Agent] Couldn't dig to surface — continuing anyway`);
                                    }
                                }
                            } catch (_) {}

                            // ═══════════════════════════════════════════════════════════
                            // PHASE 1: SURVIVAL — eat food, sleep if night, flee threats
                            // ═══════════════════════════════════════════════════════════

                            const healthCheck = () => (this.bot.health ?? 20) > 0 && this.bot.entity;
                            const invItems = () => this.bot.inventory?.items() || [];

                            // 1a) Eat any available food to regen health
                            try {
                                if (this.bot.food < 18) {
                                    await eatBestFood(this.bot);
                                    await new Promise(r => setTimeout(r, 500));
                                }
                            } catch (_) {}

                            // 1b) EMERGENCY: If no food and low health, FLEE far from everything
                            //     then hunt animals for food before doing anything else.
                            const foodCount = invItems().filter(i => i.foodRecovery > 0).reduce((s,i) => s + i.count, 0);
                            if (foodCount === 0 && (this.bot.health ?? 20) < 16) {
                                console.log(`[Agent] No food + low health (${Math.round(this.bot.health)}) — fleeing to safety`);
                                // Run 60 blocks away from nearest hostile
                                const hostiles = Object.values(this.bot.entities || {})
                                    .filter(e => e?.isValid && e.position && isHostile(e))
                                    .map(e => ({ e, d: e.position.distanceTo(this.bot.entity.position) }))
                                    .sort((a, b) => a.d - b.d);
                                if (hostiles.length > 0 && hostiles[0].d < 20) {
                                    const h = hostiles[0].e;
                                    const dx = this.bot.entity.position.x - h.position.x;
                                    const dz = this.bot.entity.position.z - h.position.z;
                                    const len = Math.sqrt(dx*dx + dz*dz) || 1;
                                    const fleeX = Math.round(this.bot.entity.position.x + (dx/len) * 60);
                                    const fleeZ = Math.round(this.bot.entity.position.z + (dz/len) * 60);
                                    this.bot.setControlState('sprint', true);
                                    try {
                                        await Promise.race([
                                            walkSkill({ x: fleeX, y: Math.round(this.bot.entity.position.y), z: fleeZ, range: 5 }),
                                            new Promise(r => setTimeout(r, 8000))
                                        ]);
                                    } catch (_) {}
                                    this.bot.setControlState('sprint', false);
                                    await new Promise(r => setTimeout(r, 1000));
                                }
                                // Try eating again after fleeing
                                try { await eatBestFood(this.bot); } catch (_) {}
                                // Hunt nearby animals for food
                                const animals = Object.values(this.bot.entities || {})
                                    .filter(e => e?.isValid && e.position && e.name && !isHostile(e) && e.position.distanceTo(this.bot.entity.position) < 16)
                                    .sort((a, b) => a.position.distanceTo(this.bot.entity.position) - b.position.distanceTo(this.bot.entity.position));
                                if (animals.length > 0) {
                                    console.log(`[Agent] Hunting ${animals[0].name} for food`);
                                    try {
                                        const { collectBlock } = await import('./library/skills.js');
                                        await this.bot.pathfinder.goto(new (await import('mineflayer-pathfinder')).GoalNear(
                                            Math.round(animals[0].position.x), Math.round(animals[0].position.y), Math.round(animals[0].position.z), 2
                                        ));
                                        for (let i = 0; i < 5 && animals[0].isValid; i++) {
                                            this.bot.attack(animals[0]);
                                            await new Promise(r => setTimeout(r, 600));
                                        }
                                    } catch (_) {}
                                    try { await eatBestFood(this.bot); } catch (_) {}
                                }
                            }

                            // 1c) Try to sleep if nighttime — but NEVER if hostiles are nearby (pro player rule)
                            try {
                                const time = this.bot.time?.timeOfDay ?? 0;
                                const isNight = time > 12541 && time < 23459;
                                if (isNight) {
                                    // Check for hostiles before sleeping — pillagers will kill us in bed
                                    const nearbyHostiles = Object.values(this.bot.entities || {})
                                        .filter(e => e?.isValid && e.position && isHostile(e))
                                        .some(e => e.position.distanceTo(this.bot.entity.position) < 24);
                                    if (nearbyHostiles) {
                                        console.log(`[Agent] Nighttime but hostiles nearby — skipping sleep, sprinting to safety`);
                                    } else {
                                        const bed = this.bot.findBlock({ matching: [26, 355], maxDistance: 32 });
                                        if (bed) {
                                            console.log(`[Agent] Nighttime — trying to sleep at bed near (${bed.position.x}, ${bed.position.z})`);
                                            try {
                                                const { sprintJumpToward } = await import('./library/skills.js');
                                                await sprintJumpToward(this.bot, bed.position, 2, 8000);
                                            } catch (_) {}
                                            try {
                                                await this.bot.sleep(this.bot.blockAt(bed.position));
                                                let sleepAttempts = 0;
                                                while (this.bot.time?.timeOfDay > 12541 && this.bot.time?.timeOfDay < 23459 && this.bot.entity && sleepAttempts < 30) {
                                                    await new Promise(r => setTimeout(r, 1000));
                                                    sleepAttempts++;
                                                }
                                                try { this.bot.wakeUp(); } catch (_) {}
                                                console.log(`[Agent] Morning! Safe to proceed.`);
                                            } catch (e) {
                                                console.log(`[Agent] Sleep failed: ${e.message} — continuing`);
                                            }
                                        }
                                    }
                                }
                            } catch (_) {}

                            // 1c*) Sprint away from hostiles — let CombatEngine reflex handle fighting
                            if (p) {
                                const threats = Object.values(this.bot.entities || {})
                                    .filter(e => e?.isValid && e.position && isHostile(e))
                                    .map(e => ({ e, d: e.position.distanceTo(this.bot.entity.position) }))
                                    .filter(t => t.d < 24)
                                    .sort((a, b) => a.d - b.d);
                                if (threats.length > 0) {
                                    const threat = threats[0];
                                    const dx = this.bot.entity.position.x - threat.e.position.x;
                                    const dz = this.bot.entity.position.z - threat.e.position.z;
                                    const len = Math.sqrt(dx * dx + dz * dz) || 1;
                                    const fleeX = Math.round(this.bot.entity.position.x + (dx / len) * 50);
                                    const fleeZ = Math.round(this.bot.entity.position.z + (dz / len) * 50);
                                    console.log(`[Agent] Fleeing ${threat.e.name} (dist ${Math.round(threat.d)}) → (${fleeX}, ${fleeZ})`);
                                    try {
                                        const { sprintJumpToward } = await import('./library/skills.js');
                                        await sprintJumpToward(this.bot, { x: fleeX, y: Math.round(this.bot.entity.position.y), z: fleeZ }, 3, 8000);
                                    } catch (_) {
                                        this.bot.setControlState('sprint', true);
                                        try {
                                            await Promise.race([
                                                walkSkill({ x: fleeX, y: Math.round(this.bot.entity.position.y), z: fleeZ, range: 3 }),
                                                new Promise(r => setTimeout(r, 6000))
                                            ]);
                                        } catch (_) {}
                                        this.bot.setControlState('sprint', false);
                                    }
                                    await new Promise(r => setTimeout(r, 200));
                                }
                            }

                            // 1d) Eat again after combat to recover health
                            try {
                                if ((this.bot.health ?? 20) < 14) {
                                    const hasFood = (this.bot.inventory?.items() || []).some(i => i.foodRecovery > 0);
                                    if (hasFood) {
                                        console.log(`[Agent] Low health (${Math.round(this.bot.health)}) — eating to recover`);
                                        await eatBestFood(this.bot);
                                    }
                                }
                            } catch (_) {}

                            if (!healthCheck()) { console.log('[Agent] Bot died during survival phase'); return; }

                            // ═══════════════════════════════════════════════════════════
                            // PHASE 2: TOOLS — crafting table → planks → sword FIRST
                            // ═══════════════════════════════════════════════════════════
                            // Expert grinding research: weapon FIRST for survival,
                            // then pickaxe. Crafting table required before anything else.

                            const inv2 = this.bot.inventory?.items() || [];
                            const logCount = inv2.filter(i => /_log$/.test(i.name)).reduce((s, i) => s + (i.count || 1), 0);
                            const plankCount = inv2.filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + (i.count || 1), 0);
                            const hasTable = inv2.some(i => i.name === 'crafting_table') || this.bot.findBlock({ matching: 58, maxDistance: 4 }) !== null;
                            const hasSword2 = inv2.some(i => /_sword/.test(i.name));
                            const hasPickaxe2 = inv2.some(i => /_pickaxe/.test(i.name));

                            // 2a) If no logs and no planks, gather wood (while fighting back)
                            if (logCount === 0 && plankCount < 4) {
                                console.log(`[Agent] No wood — gathering tree logs`);
                                try {
                                    const { collectBlock, sprintJumpToward } = await import('./library/skills.js');
                                    const { isWoodBlockName } = await import('../utils/item_families.js');
                                    // Find nearest tree at similar Y level first, then any
                                    const botY = Math.round(this.bot.entity?.position?.y || 64);
                                    let allTrees = this.bot.findBlocks({ matching: (b) => isWoodBlockName(b?.name), maxDistance: 48, count: 20 });
                                    // PRO PLAYER RULE: never chase underground trees — they're unreachable
                                    // Prefer trees within 10 Y levels of bot
                                    let trees = allTrees.filter(p => Math.abs(p.y - botY) < 10);
                                    if (trees.length === 0) {
                                        // No reachable trees — sprint to explore and load new chunks
                                        console.log(`[Agent] No reachable trees at Y=${botY} — exploring`);
                                        const { sprintJumpToward } = await import('./library/skills.js');
                                        const angle = Math.random() * 2 * Math.PI;
                                        const rx = this.bot.entity.position.x + Math.cos(angle) * 40;
                                        const rz = this.bot.entity.position.z + Math.sin(angle) * 40;
                                        await sprintJumpToward(this.bot, { x: rx, y: botY, z: rz }, 5, 12000);
                                        // Re-scan after exploring
                                        allTrees = this.bot.findBlocks({ matching: (b) => isWoodBlockName(b?.name), maxDistance: 48, count: 20 });
                                        trees = allTrees.filter(p => Math.abs(p.y - botY) < 10);
                                        if (trees.length === 0) trees = allTrees.slice(0, 3); // last resort: try 3 closest
                                    }
                                    if (trees.length > 0) {
                                        // Sort by 3D distance
                                        trees.sort((a, b) => {
                                            const da = a.distanceTo(this.bot.entity.position);
                                            const db = b.distanceTo(this.bot.entity.position);
                                            return da - db;
                                        });
                                        let chopped = false;
                                        for (const treePos of trees.slice(0, 5)) {
                                            console.log(`[Agent] Sprinting to tree at (${treePos.x}, ${treePos.y}, ${treePos.z})`);
                                            // Use raw sprint-jump movement — no pathfinder
                                            const arrived = await sprintJumpToward(this.bot, treePos, 3, 12000);
                                            if (!arrived) {
                                                console.log(`[Agent] Couldn't reach tree at (${treePos.x}, ${treePos.y}, ${treePos.z}) — trying next`);
                                                continue;
                                            }
                                            try {
                                                await collectBlock(this.bot, 'log', 8);
                                                console.log(`[Agent] Chopped 8 logs`);
                                                chopped = true;
                                                break;
                                            } catch (e) {
                                                console.warn(`[Agent] Tree chop failed: ${e.message}`);
                                            }
                                        }
                                        if (!chopped) {
                                            console.warn(`[Agent] Could not chop any tree — moving to explore`);
                                            // Sprint to random direction to load new chunks
                                            const angle = Math.random() * 2 * Math.PI;
                                            const rx = this.bot.entity.position.x + Math.cos(angle) * 30;
                                            const rz = this.bot.entity.position.z + Math.sin(angle) * 30;
                                            await sprintJumpToward(this.bot, { x: rx, y: this.bot.entity.position.y, z: rz }, 5, 10000);
                                        }
                                    } else {
                                        console.log(`[Agent] No trees found — sprinting to explore`);
                                        const angle = Math.random() * 2 * Math.PI;
                                        const rx = this.bot.entity.position.x + Math.cos(angle) * 30;
                                        const rz = this.bot.entity.position.z + Math.sin(angle) * 30;
                                        await sprintJumpToward(this.bot, { x: rx, y: this.bot.entity.position.y, z: rz }, 5, 10000);
                                    }
                                } catch (e) { console.warn(`[Agent] Wood gathering failed: ${e.message}`); }
                            }

                            // 2b) Convert logs → planks (if we have logs but no planks)
                            // Find which log type we have and craft matching planks
                            const logCount2 = (this.bot.inventory?.items() || []).filter(i => /_log$/.test(i.name)).reduce((s, i) => s + (i.count || 1), 0);
                            const plankCount2 = (this.bot.inventory?.items() || []).filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + (i.count || 1), 0);
                            if (logCount2 > 0 && plankCount2 < 4) {
                                // Find the specific log type in inventory
                                const logItem = (this.bot.inventory?.items() || []).find(i => /_log$/.test(i.name));
                                const logName = logItem?.name || 'oak_log';
                                const plankName = logName.replace('_log', '_planks');
                                console.log(`[Agent] Converting ${logCount2} ${logName} → ${plankName}`);
                                try {
                                    const { craftRecipe } = await import('./library/skills.js');
                                    await craftRecipe(this.bot, plankName, logCount2 * 4);
                                    await new Promise(r => setTimeout(r, 300));
                                } catch (_) {}
                            }

                            // 2c) Craft crafting table (if needed and we have planks)
                            const plankCount3 = (this.bot.inventory?.items() || []).filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + (i.count || 1), 0);
                            const hasTable2 = (this.bot.inventory?.items() || []).some(i => i.name === 'crafting_table');
                            if (!hasTable2 && plankCount3 >= 4) {
                                console.log(`[Agent] Crafting crafting table`);
                                try {
                                    const { craftRecipe } = await import('./library/skills.js');
                                    await craftRecipe(this.bot, 'crafting_table', 1);
                                    await new Promise(r => setTimeout(r, 300));
                                } catch (_) {}
                            }

                            // 2d) Craft wooden sword (defense first!)
                            const hasSword3 = (this.bot.inventory?.items() || []).some(i => /_sword/.test(i.name));
                            const hasTable3 = (this.bot.inventory?.items() || []).some(i => i.name === 'crafting_table');
                            if (!hasSword3 && hasTable3 && plankCount3 >= 1) {
                                console.log(`[Agent] Crafting wooden sword for defense`);
                                try {
                                    const { craftRecipe } = await import('./library/skills.js');
                                    await craftRecipe(this.bot, 'wooden_sword', 1);
                                    await new Promise(r => setTimeout(r, 300));
                                    // Equip sword immediately
                                    const sword = this.bot.inventory?.items()?.find(i => /_sword/.test(i.name));
                                    if (sword) await this.bot.equip(sword, 'hand');
                                } catch (_) {}
                            }

                            // 2e) Craft sticks (needed for pickaxe — pro players know this!)
                            const hasSticks = (this.bot.inventory?.items() || []).some(i => i.name === 'stick');
                            const plankCount4 = (this.bot.inventory?.items() || []).filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + (i.count || 1), 0);
                            if (!hasSticks && hasTable3 && plankCount4 >= 2) {
                                console.log(`[Agent] Crafting sticks from planks`);
                                try {
                                    const { craftRecipe } = await import('./library/skills.js');
                                    await craftRecipe(this.bot, 'stick', 4);
                                } catch (_) {}
                            }

                            // 2f) Craft wooden pickaxe (for stone mining)
                            const hasPickaxe3 = (this.bot.inventory?.items() || []).some(i => /_pickaxe/.test(i.name));
                            const stickCount2 = (this.bot.inventory?.items() || []).filter(i => i.name === 'stick').reduce((s, i) => s + (i.count || 1), 0);
                            const plankCount5 = (this.bot.inventory?.items() || []).filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + (i.count || 1), 0);
                            if (!hasPickaxe3 && hasTable3 && plankCount5 >= 3 && stickCount2 >= 2) {
                                console.log(`[Agent] Crafting wooden pickaxe`);
                                try {
                                    const { craftRecipe } = await import('./library/skills.js');
                                    await craftRecipe(this.bot, 'wooden_pickaxe', 1);
                                } catch (_) {}
                            }

                            // ═══════════════════════════════════════════════════════════
                            // PHASE 3: STONE TOOLS — upgrade to stone ASAP
                            // ═══════════════════════════════════════════════════════════
                            // Research: stone tools are 30% faster, essential for iron mining

                            // Health check between phases — eat if hurt
                            if (!healthCheck()) { console.log('[Agent] Bot died between phases 2→3'); return; }
                            try {
                                if ((this.bot.health ?? 20) < 12) {
                                    console.log(`[Agent] Health ${Math.round(this.bot.health)} between phases — eating`);
                                    await eatBestFood(this.bot);
                                    await new Promise(r => setTimeout(r, 500));
                                }
                            } catch (_) {}

                            const inv3 = this.bot.inventory?.items() || [];
                            const hasCobble = inv3.some(i => i.name === 'cobblestone');
                            const hasStonePick = inv3.some(i => /stone_pickaxe/.test(i.name));
                            const hasStoneSword = inv3.some(i => /stone_sword/.test(i.name));
                            const hasPickaxe4 = inv3.some(i => /_pickaxe/.test(i.name));

                            // Mine cobblestone if we have a pickaxe but no stone tools yet
                            if (hasPickaxe4 && (!hasStonePick || !hasStoneSword)) {
                                // Health check before mining — don't mine while low
                                if ((this.bot.health ?? 20) < 10) {
                                    console.log(`[Agent] Too low on health (${Math.round(this.bot.health)}) to mine — eating first`);
                                    try { await eatBestFood(this.bot); await new Promise(r => setTimeout(r, 500)); } catch (_) {}
                                }
                                console.log(`[Agent] Mining cobblestone for stone tools`);
                                try {
                                    const { collectBlock } = await import('./library/skills.js');
                                    // Mine 8 cobblestone (2 for pickaxe + 2 for sword + extras)
                                    await collectBlock(this.bot, 'stone', 8);
                                    await new Promise(r => setTimeout(r, 500));
                                } catch (_) {}
                            }

                            // Craft stone sword (upgrade defense)
                            const cobbleCount = (this.bot.inventory?.items() || []).filter(i => i.name === 'cobblestone').reduce((s, i) => s + (i.count || 1), 0);
                            const stickCount = (this.bot.inventory?.items() || []).filter(i => i.name === 'stick').reduce((s, i) => s + (i.count || 1), 0);
                            if (!hasStoneSword && cobbleCount >= 2 && stickCount >= 1) {
                                console.log(`[Agent] Crafting stone sword`);
                                try {
                                    const { craftRecipe } = await import('./library/skills.js');
                                    await craftRecipe(this.bot, 'stone_sword', 1);
                                    await new Promise(r => setTimeout(r, 300));
                                    const sword = this.bot.inventory?.items()?.find(i => /stone_sword/.test(i.name));
                                    if (sword) await this.bot.equip(sword, 'hand');
                                } catch (_) {}
                            }

                            // Craft stone pickaxe (upgrade mining)
                            if (!hasStonePick && cobbleCount >= 3 && stickCount >= 2) {
                                console.log(`[Agent] Crafting stone pickaxe`);
                                try {
                                    const { craftRecipe } = await import('./library/skills.js');
                                    await craftRecipe(this.bot, 'stone_pickaxe', 1);
                                    await new Promise(r => setTimeout(r, 300));
                                    const pick = this.bot.inventory?.items()?.find(i => /stone_pickaxe/.test(i.name));
                                    if (pick) await this.bot.equip(pick, 'hand');
                                } catch (_) {}
                            }

                            // ═══════════════════════════════════════════════════════════
                            // PHASE 4: WALK TO SAFE STARTING POSITION
                            // ═══════════════════════════════════════════════════════════

                            if (p) {
                                let walkX, walkZ;
                                try {
                                    const { isWoodBlockName } = await import('../utils/item_families.js');
                                    const blocks = this.bot.findBlocks({ matching: (b) => isWoodBlockName(b?.name), maxDistance: 48, count: 1 });
                                    if (blocks.length > 0) {
                                        const treePos = blocks[0];
                                        walkX = Math.round(treePos.x);
                                        walkZ = Math.round(treePos.z);
                                        console.log(`[Agent] Heading toward tree at (${walkX}, ${walkZ})`);
                                    } else {
                                        throw new Error('no trees found');
                                    }
                                } catch {
                                    const angle = Math.random() * 2 * Math.PI;
                                    walkX = Math.round(p.x + Math.cos(angle) * 30);
                                    walkZ = Math.round(p.z + Math.sin(angle) * 30);
                                    console.log(`[Agent] No trees nearby — random walk to (${walkX}, ${walkZ})`);
                                }
                                try {
                                    const { sprintJumpToward } = await import('./library/skills.js');
                                    await sprintJumpToward(this.bot, { x: walkX, y: Math.round(p.y), z: walkZ }, 3, 12000);
                                } catch (_) {
                                    // Fallback to pathfinder
                                    await walkSkill({ x: walkX, y: Math.round(p.y), z: walkZ, range: 3 });
                                }
                                console.log(`[Agent] Arrived at (${Math.round(this.bot.entity?.position?.x)}, ${Math.round(this.bot.entity?.position?.z)})`);
                            }
                        } catch (walkErr) {
                            console.warn(`[Agent] Pre-grind survival failed: ${walkErr.message}, continuing with grind anyway`);
                        }

                        // Pause unstuck mode during diamond grind
                        if (this.bot.modes) this.bot.modes.pause('unstuck');

                        try {
                            const stepRetries = {};
                            const MAX_STEP_RETRIES = 3;
                            const MAX_REPLANS = 5;
                            let replanCount = 0;

                            for (let i = startStep; i < settings._taskSteps.length; i++) {
                                if (!this.bot?.entity) {
                                    console.error(`[Agent] Bot disconnected — stopping grind at step ${i + 1}`);
                                    break;
                                }

                                // Save progress after each step completion
                                this._currentStepIndex = i;

                                // ═══════════════════════════════════════════════════════════
                                // REACTIVE REPLANNER: when step fails, replan from current state
                                // ═══════════════════════════════════════════════════════════
                                // Research shows: when a step fails, don't skip — replan from
                                // current state to find an alternative path to the goal.

                                const step = settings._taskSteps[i];
                                if (!step || !step.skill) {
                                    console.log(`[Agent] Step ${i + 1}: invalid, skipping`);
                                    continue;
                                }

                                // Check for interrupt (emergency from SpinalCord)
                                if (this.bot.interrupt_code) {
                                    console.log(`[Agent] Step ${i + 1} interrupted — waiting out emergency...`);
                                    let guard = 0;
                                    while ((this.bot.interrupt_code || this.brain?.motor?.isBusy) && guard < 20) {
                                        await new Promise(r => setTimeout(r, 500));
                                        guard++;
                                    }
                                    stepRetries[i] = (stepRetries[i] || 0) + 1;
                                    if (stepRetries[i] <= MAX_STEP_RETRIES) {
                                        this.bot.interrupt_code = false;
                                        i--;
                                        continue;
                                    }
                                    console.warn(`[Agent] Step ${i + 1} interrupted ${stepRetries[i]}x — skipping`);
                                }

                                const outputBefore = (this.bot.output || '').length;
                                console.log(`[Agent] Step ${i + 1}/${settings._taskSteps.length}: ${step.skill}(${JSON.stringify(step.params || {})})`);

                                let stepFailed = false;
                                try {
                                    const SkillFn = this.taskRunner.skills[step.skill];
                                    if (SkillFn) {
                                        const result = await SkillFn(step.params || {});
                                        if (result === false) {
                                            console.warn(`[Agent] Step ${i + 1} returned false (failed)`);
                                            stepFailed = true;
                                        } else if (result === true) {
                                            console.log(`[Agent] Step ${i + 1} succeeded`);
                                            // Save progress after each successful step for death recovery
                                            this._currentStepIndex = i + 1;
                                            this._saveTaskProgress();
                                        }
                                    } else {
                                        console.warn(`[Agent] Unknown skill: ${step.skill}`);
                                        stepFailed = true;
                                    }
                                } catch (stepErr) {
                                    console.warn(`[Agent] Step ${i + 1} threw: ${stepErr.message}`);
                                    stepFailed = true;
                                }

                                // ═══════════════════════════════════════════════════════════
                                // REACTIVE REPLANNER: if step failed, try to replan
                                // ═══════════════════════════════════════════════════════════
                                if (stepFailed && replanCount < MAX_REPLANS) {
                                    console.log(`[Agent] Step ${i + 1} failed — attempting reactive replan (${replanCount + 1}/${MAX_REPLANS})`);
                                    try {
                                        // Get current state from brain
                                        const snapshot = this.brain?.getSnapshot?.();
                                        if (snapshot && this.brain?.executive) {
                                            // Ask executive brain for a new plan based on current state
                                            const newDecision = this.brain.executive.decide(snapshot);
                                            if (newDecision?.steps && newDecision.steps.length > 0) {
                                                console.log(`[Agent] Replan: ${newDecision.task} with ${newDecision.steps.length} steps`);
                                                // Replace remaining steps with new plan
                                                const remainingSteps = newDecision.steps;
                                                settings._taskSteps = [
                                                    ...settings._taskSteps.slice(0, i),
                                                    ...remainingSteps,
                                                    ...settings._taskSteps.slice(i + 1)
                                                ];
                                                replanCount++;
                                                i--; // Re-execute from current position with new steps
                                                continue;
                                            }
                                        }
                                    } catch (replanErr) {
                                        console.warn(`[Agent] Replan failed: ${replanErr.message}`);
                                    }
                                }

                                // Log skill output
                                if (this.bot.output && this.bot.output.length > outputBefore) {
                                    const newOutput = this.bot.output.substring(outputBefore).trim();
                                    if (newOutput) console.log(`  => ${newOutput}`);
                                }

                                // Re-assert busy — idempotent pin, survives reflex cycles
                                if (this.brain && this.brain.motor) {
                                    this.brain.motor.pinBusy('grind');
                                }
                                await humanPause(PACE.ACTION_GAP_MIN, PACE.ACTION_GAP_MAX);
                            }
                            console.log('[Agent] Diamond grind task completed!');
                            this._clearTaskProgress();
                        } catch (e) {
                            console.error(`[Agent] Task execution error: ${e.message}`);
                        } finally {
                            if (this.brain && this.brain.motor) {
                                // Release the claim without cancelling any goal
                                // the brain started in the meantime.
                                this.brain.motor.unpinBusy('grind');
                            }
                            // After diamond grind, continue with productive work
                            console.log('[Agent] Task done. AyushiOS brain will continue autonomous operation.');
                        }
                    }, humanDelay);
                }

            } catch (error) {
                console.error('Error in spawn event:', error);
                // Exit non-zero: AgentProcess only restarts on crashes (code !== 0).
                // A code-0 exit here reads as an intentional stop and strands the bot.
                process.exit(1);
            } finally {
                clearTimeout(spawnTimeout);
            }
        });
    }

    _saveTaskProgress() {
        if (!this._currentTaskFile || this._currentStepIndex === undefined) return;
        try {
            const dir = path.join('bots', this.name);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const data = {
                taskFile: this._currentTaskFile,
                stepIndex: this._currentStepIndex,
                timestamp: Date.now(),
            };
            fs.writeFileSync(path.join(dir, 'task_progress.json'), JSON.stringify(data, null, 2));
            console.log(`[Agent] Saved task progress: step ${this._currentStepIndex}/${this._currentTotalSteps}`);
        } catch (e) {
            console.warn(`[Agent] Failed to save task progress: ${e.message}`);
        }
    }

    _loadTaskProgress() {
        try {
            const file = path.join('bots', this.name, 'task_progress.json');
            if (!fs.existsSync(file)) return null;
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!data.taskFile || data.stepIndex === undefined) return null;
            if (Date.now() - data.timestamp > 3600000) {
                fs.unlinkSync(file);
                return null;
            }
            return data;
        } catch (e) {
            return null;
        }
    }

    _clearTaskProgress() {
        try {
            const file = path.join('bots', this.name, 'task_progress.json');
            if (fs.existsSync(file)) fs.unlinkSync(file);
            this._currentTaskFile = null;
            this._currentStepIndex = undefined;
        } catch (_) {}
    }

    _enqueueMessage(username, message) {
        const key = `${username}:${message}`;
        const now = Date.now();
        this._messageQueue = this._messageQueue.filter(m => now - m.ts < 10000);
        if (this._messageQueue.some(m => m.key === key)) return;
        console.log('[CHAT] queued for generation from', username);
        this._messageQueue.push({ username, message, key, ts: now });
        this._processQueue();
    }
 
    _syncKnowledgeBridge(force = false) {
        this.brain?.knowledgeBridge?.sync?.(force);
    }

    async _processQueue() {
        if (this._processingMessage) return;
        this._processingMessage = true;
        while (this._messageQueue.length > 0) {
            const item = this._messageQueue.shift();
            // Stale messages read as non-sequiturs — the moment passed.
            if (Date.now() - item.ts > 15000) {
                console.log('[CHAT] dropping stale queued message from', item.username);
                continue;
            }
            // Human reaction time — instant replies look robotic.
            await humanPause(PACE.REPLY_MIN, PACE.REPLY_MAX);
            try {
                await this.handleMessage(item.username, item.message);
            } catch (err) {
                console.error('[Agent] Error processing queued message:', err);
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
        }
        this._processingMessage = false;
    }

    _isDuplicateCommand(cmdName) {
        const now = Date.now();
        this._recentCommands = this._recentCommands.filter(c => now - c.ts < 5000);
        const dup = this._recentCommands.find(c => c.name === cmdName);
        if (dup) { dup.ts = now; return true; }
        this._recentCommands.push({ name: cmdName, ts: now });
        return false;
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const MASTER_PLAYER = 'updesh';

        const respondFunc = async (username, message) => {
            if (!message || message === "") return;
            this._lastKeepAliveAck = Date.now();
            if (username === this.name) return;
            const dedupKey = `${username}:${message}`;
            const now = Date.now();
            const lastSeen = this._recentChats?.get(dedupKey);
            if (lastSeen && now - lastSeen < 2000) return;
            if (!this._recentChats) this._recentChats = new Map();
            this._recentChats.set(dedupKey, now);
            // Dedupe entries are only valid for 2s — drop expired ones so the
            // map can't grow unbounded over long uptimes.
            if (this._recentChats.size > 500) {
                for (const [k, t] of this._recentChats) {
                    if (now - t >= 2000) this._recentChats.delete(k);
                }
            }
            console.log('[CHAT] received:', username, '▶', message);
            const usernameLower = username.toLowerCase();
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.some(u => u.toLowerCase() === usernameLower)) return;
            if (ignore_messages.some((m) => message.startsWith(m))) return;

            this.last_sender = username;
            this.shut_up = false;
            // NOTE: _whisperLast is set ONLY by the real whisper listener.
            // Marking public chats here made openChat whisper replies to
            // public messages for 60s — the "two reply styles" bug.

            if (usernameLower === MASTER_PLAYER.toLowerCase()) {
                this.requestInterrupt();
                if (this.self_prompter.isActive()) {
                    this.self_prompter.interrupt = true;
                    this.self_prompter.state = 0;
                    const waitStart = Date.now();
                    while (this.self_prompter.loop_active && Date.now() - waitStart < 5000) {
                        await new Promise(r => setTimeout(r, 200));
                    }
                }
                this.shut_up = false;
            }

            if (convoManager.isOtherAgent(username)) return;

            // [AyushiOS] Fast-path: BrocaArea handles known chat patterns instantly
            const handledByBroca = this.brain?.broca && !message.startsWith('!')
                ? this.brain.broca.handleIncomingChat(username, message)
                : false;

            let translation = await handleEnglishTranslation(message);
            if (this.serverAnalyzer) {
                this.serverAnalyzer.onChatMessage(translation);
                if (username === MASTER_PLAYER) this.serverAnalyzer.setOwner(username);
                this._syncKnowledgeBridge(false);
            }
            if (this.relationshipManager) {
                this.relationshipManager.recordMessage(username, translation);
            }
            // Brain social memory updated via relationshipManager events
            // Fast-path dialogue has already replied; do not also queue an LLM response.
            if (!handledByBroca) this._enqueueMessage(username, translation);
        }

        this.respondFunc = respondFunc;
        this._whisperLast = {};

        this.bot.on('whisper', (username, message) => {
            this._whisperLast[username] = Date.now();
            // Only auto-accept on actual teleport requests
            if (username.toLowerCase() === 'updesh' || username.toLowerCase() === 'updes') {
                const lowerMsg = message.toLowerCase();
                if (lowerMsg.includes('has requested to teleport') || lowerMsg.includes('wants to teleport') || lowerMsg.includes('teleport request') || lowerMsg.includes('/tpa')) {
                    console.log(`[Agent] updesh teleport request via whisper: "${message}" — sending /tpaccept`);
                    this.bot.chat('/tpaccept');
                }
            }
            respondFunc(username, message);
        });
        
        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            respondFunc(username, message);
        });

        // Track raw messages for debug
        const handleRawMessage = (source, raw) => {
            if (typeof raw !== 'string' || !raw) return;
            const plain = raw.replace(/§./g, '').trim();
            if (!plain) return;
            console.log(`[CHAT:${source}] ${plain}`);

            // Auto-accept /tpa from updesh — only on actual teleport requests
            const lower = plain.toLowerCase();
            if (lower.includes('updesh') || lower.includes('updes')) {
                if (lower.includes('has requested to teleport') || lower.includes('wants to teleport') || lower.includes('teleport request from') || lower.includes('sent you a teleport request')) {
                    console.log(`[Agent] Teleport request from updesh detected (${source}) — sending /tpaccept`);
                    this.bot.chat('/tpaccept');
                }
            }

            // Auto-auth: only attempt on auth-required servers
            if (settings.auth !== 'offline' && settings.password) {
                if (this._lastAuthCheck && Date.now() - this._lastAuthCheck < 3000) { /* skip — rate limited */ }
                else {
                    const pw = settings.password;
                    if (lower.includes('login first') || lower.includes('please login') || lower.includes('not logged in') || lower.includes('authenticate') || lower.includes('type /login') || lower.includes('use /login')) {
                        this._lastAuthCheck = Date.now();
                        console.log(`[Agent] Auth prompt detected (${source}). Sending /login...`);
                        this.bot.chat(`/login ${pw}`);
                    } else if (lower.includes('register') || lower.includes('not registered')) {
                        this._lastAuthCheck = Date.now();
                        console.log(`[Agent] Register prompt detected (${source}). Sending /register...`);
                        this.bot.chat(`/register ${pw} ${pw}`);
                    }
                }
            }

            // Try to extract username + message from any format
            let username = null, msg = null;
            // Arrow format: username ▶ message or username → message
            const arrow = plain.match(/^(\w+)\s*[▶➜→:]\s*(.+)$/);
            if (arrow) { username = arrow[1]; msg = arrow[2]; }
            // Bracket whisper: [username -> me] message
            if (!username) {
                const bracket = plain.match(/^\[(\w+).*?[─➜→\-].*?me\].*?[\s:]\s*(.+)$/i);
                if (bracket) { username = bracket[1]; msg = bracket[2]; }
            }
            // "from" whisper: from username: message
            if (!username) {
                const fromMsg = plain.match(/^from\s+(\w+)[\s:]+(.+)$/i);
                if (fromMsg) { username = fromMsg[1]; msg = fromMsg[2]; }
            }
            // Public chat: <username> message
            if (!username) {
                const chat = plain.match(/^<(.+?)>\s(.+)$/);
                if (chat) { username = chat[1]; msg = chat[2]; }
            }

            if (username && msg && username !== this.name) {
                // Track as whisper if it looks like one (not public chat format)
                if (!plain.startsWith('<')) {
                    this._whisperLast[username] = Date.now();
                }
                respondFunc(username, msg);
            }
        };

        this.bot.on('messagestr', (message) => {
            if (this.serverAnalyzer) {
                this.serverAnalyzer.onChatMessage(message);
                this._syncKnowledgeBridge(false);
            }
            handleRawMessage('messagestr', message);
        });
 
        // Mineflayer 4.x systemChat fallback
        this.bot.on('systemChat', (msg) => {
            if (typeof msg === 'string') {
                handleRawMessage('systemChat', msg);
                this.bot.emit('messagestr', msg);
            }
        });
 
        this.bot.on('windowOpen', (window) => {
            if (this.serverAnalyzer) {
                this.serverAnalyzer.onWindowOpen(window);
                this._syncKnowledgeBridge(true);
            }
        });
 
        // [AyushiOS] Raw packet interceptors — catch messages on any protocol version
        if (this.bot._client) {
            // Packet debug logger — disabled by default (was spamming console + burning CPU).
            // Enable via settings.debug_packets = true when diagnosing protocol issues.
            const knownChatPackets = new Set(['chat', 'playerChat', 'systemChat']);
            const highFreq = new Set(['tick', 'position', 'update_attributes', 'entity_metadata', 'entity_velocity', 'entity_position', 'entity_move_look', 'entity_head_rotation', 'rel_entity_move', 'entity_equipment', 'entity_effect', 'remove_entity_effect', 'world_event', 'named_sound_effect', 'sound_effect', 'block_break_animation', 'block_action', 'block_update', 'explosion', 'spawn_entity', 'spawn_entity_living', 'spawn_entity_experience_orb', 'entity_destroy', 'entity_look', 'entity_tracking', 'entity_status', 'entity_teleport', 'animation', 'collect', 'keep_alive', 'time_update', 'set_slot', 'window_items', 'map_chunk', 'light_update', 'update_light', 'unload_chunk', 'multi_block_change', 'block_change', 'server_data', 'tags', 'sync_player_position', 'ping_request', 'pong_response', 'declare_commands', 'select_known_packs', 'custom_payload', 'disconnect', 'login', 'success', 'compress', 'position_look', 'flying', 'look', 'held_item_slot', 'abilities', 'experience', 'health', 'spawn_position', 'rel_entity_move', 'attach_entity', 'change_difficulty', 'tab_complete', 'statistics', 'unlock_recipes', 'advancements', 'craft_progress', 'open_window', 'close_window', 'window_click', 'transaction', 'entity_equipment', 'scoreboard_objective', 'scoreboard_score', 'scoreboard_display_objective', 'teams', 'title', 'sound_or_soundeffect', 'stop_sound', 'boss_bar', 'camera', 'update_view_position', 'update_view_distance', 'chunk_batch_finished', 'chunk_batch_start', 'chunks_biomes', 'forget_level_chunk', 'level_chunk_with_light', 'initialize_border', 'set_border_center', 'set_border_lerp_size', 'set_border_size', 'set_border_warning_delay', 'set_border_warning_distance', 'set_default_spawn_position', 'bundle_delimiter', 'player_info', 'player_remove', 'combat_event', 'damage_event', 'hurt_animation', 'death_combat_event', 'entity_velocity']);
            const debugPackets = settings.debug_packets === true;
            const onAnyPacket = (data, metadata) => {
                if (!debugPackets) return;
                // Fix: original had an operator-precedence bug — `a || b ? c : null`
                // evaluated as `(a || b) ? c : null`, ignoring metadata.name.
                const packetName = metadata?.name || (typeof data === 'object' ? data?.name : null);
                if (!packetName) return;
                if (knownChatPackets.has(packetName)) {
                    const raw = data?.plainMessage || data?.message || data?.formattedMessage || data?.text || '';
                    const str = typeof raw === 'string' ? raw : (raw?.text || JSON.stringify(raw));
                    console.log(`[PACKET:${packetName}] ${(str || '').replace(/§./g, '').substring(0, 200)}`);
                } else if (!highFreq.has(packetName)) {
                    console.log(`[PACKET:${packetName}]`);
                }
            };
            // The protocol-specific listeners below handle chat without logging every packet.
            // 1.19+ systemChat packet (catches overlay/toast messages that mineflayer may skip)
            const onSystemChat = (packet) => {
                if (!packet || !packet.message) return;
                let raw = '';
                const extractText = (comp) => {
                    if (!comp) return '';
                    if (typeof comp === 'string') return comp;
                    if (comp.text) return comp.text;
                    // Handle translate format: {"translate":"chat.type.text","with":[{"text":"updesh"},{"text":"hello"}]}
                    if (comp.translate && comp.with && Array.isArray(comp.with)) {
                        const params = comp.with.map(c => extractText(c)).join(' ');
                        const translateMap = {
                            'chat.type.text': '<%s> %s',
                            'commands.message.display.incoming': '%s whispers: %s',
                            'commands.message.display.outgoing': '[%s -> me] %s',
                            'multiplayer.player.joined': '%s joined the game',
                            'multiplayer.player.left': '%s left the game',
                        };
                        const template = translateMap[comp.translate] || '%s';
                        const parts = template.split(/(%s)/g);
                        let pi = 0;
                        return parts.map(p => p === '%s' ? (comp.with[pi++] ? extractText(comp.with[pi-1]) : '') : p).join('');
                    }
                    if (comp.extra && Array.isArray(comp.extra)) {
                        return comp.extra.map(c => extractText(c)).join('');
                    }
                    if (comp.toString) return comp.toString();
                    return '';
                };
                if (typeof packet.message === 'string') {
                    try { raw = extractText(JSON.parse(packet.message)); } catch { raw = packet.message; }
                } else if (typeof packet.message === 'object') {
                    raw = extractText(packet.message);
                }
                if (!raw) return;
                const plain = raw.replace(/§./g, '').trim();
                if (!plain) return;
                const source = `systemChat[pos=${packet.position}]`;
                console.log(`[CHAT:${source}] ${plain}`);
                handleRawMessage(source, plain);
            };
            try { this.bot._client.on('systemChat', onSystemChat); } catch {}

            // 1.19+ playerChat packet (modern player messages)
            const onPlayerChat = (packet) => {
                if (!packet || !packet.plainMessage) return;
                const plain = packet.plainMessage.replace(/§./g, '').trim();
                if (!plain) return;
                console.log(`[CHAT:playerChat] ${plain}`);
                handleRawMessage('playerChat', plain);
            };
            try { this.bot._client.on('playerChat', onPlayerChat); } catch {}

            // Pre-1.19 chat packet (legacy)
            const onChat = (packet) => {
                if (!packet || !packet.message) return;
                let raw = '';
                if (typeof packet.message === 'string') {
                    raw = packet.message;
                } else if (packet.message?.text) {
                    raw = packet.message.text;
                } else if (packet.message?.toString) {
                    raw = packet.message.toString();
                }
                if (!raw) return;
                console.log(`[CHAT:legacy_chat] ${raw.replace(/§./g, '')}`);
                handleRawMessage('legacy_chat', raw);
            };
            try { this.bot._client.on('chat', onChat); } catch {}
        }

        // Set up auto-eat
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        // silently join otherwise — no attention-drawing "Hello world" on spawn
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.available_agents || this.task.available_agents.length === 0) {
          return;
        }

        const missingPlayers = this.task.available_agents.filter(name => name !== this.name && !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses=null) {
        await this.checkTaskDone();
        if (!source || !message) {
            return false;
        }

        const systemNoise = ['Agent process restarted', 'Your login session has been continued'];
        if (source === 'system' && systemNoise.some(n => message.includes(n))) {
            this.history.add(source, message);
            return true;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? 10 : settings.max_commands;
        }
        if (max_responses === -1) max_responses = 10;
        max_responses = Math.min(max_responses, 10);
        const loopStart = Date.now();

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);
        const MASTER_PLAYER = 'updesh';
        const is_master = source === MASTER_PLAYER;

        // Security gate for direct !commands (H6): external senders may execute
        // commands only if they are the master or listed in settings.only_chat_with
        // (empty list = legacy open behavior). Internal sources ('system' = the
        // bot's own autonomous loop, other bots) keep their existing behavior.
        const allowed_senders = settings.only_chat_with || [];
        const sender_allowed = allowed_senders.length === 0
            || allowed_senders.some(u => u.toLowerCase() === String(source).toLowerCase());
        if (is_master || (sender_allowed && source !== 'system' && !from_other_bot)) {
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) return false;
                if (user_command_name === '!newAction') {
                    this.history.add(source, message);
                }
                if (isAction(user_command_name)) {
                    this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                }
                // Pause autonomous brain during manual command (claim, don't
                // cancel — the running goal resumes when the command finishes)
                if (this.brain && this.brain.motor) this.brain.motor.pinBusy('manual-command');
                try {
                    let execute_res = await executeCommand(this, message);
                    if (execute_res) this.routeResponse(source, execute_res);
                } finally {
                    if (this.brain && this.brain.motor) this.brain.motor.unpinBusy('manual-command');
                }
                return true;
            }
        }

        if (from_other_bot) this.last_sender = source;

        // === Intent Pipeline: Fast Reply → Intent Parser → Task Queue ===
        if (is_master && !self_prompt && settings.enable_intent_pipeline !== false) {
            const fastReplySent = await this.fastReply.sendFastReply(source, message);

            const intent = intentParser.parse(message);
            console.log(`[IntentParser] "${message.substring(0, 50)}" → ${intent.type} (${Math.round(intent.confidence * 100)}%)`);

            if (!intent.needsLLM() && intent.type !== Intent.CHAT) {
                const steps = intentParser.generatePlan(intent.type, intent.params);
                if (steps.length > 0) {
                    if (!fastReplySent) {
                        const intentReply = this.fastReply.getReplyForIntent(intent.type);
                        if (intentReply) this.fastReply.sendFastReplyForIntent(intent.type, source);
                    }

                    this.taskQueue.add(intent.type, message, steps);
                    this.history.add(source, message);
                    this.history.save();

                    setTimeout(() => {
                        this.taskQueue.processNext(this).catch(err => console.error('[TaskQueue] Process error:', err.message));
                    }, 500);

                    return true;
                }
            }

            if (intent.type === Intent.STOP) {
                if (this.taskQueue) this.taskQueue.cancelAll();
                this.actions.stop().catch(() => {});
                this.self_prompter.stop(false);
                this.history.add(source, message);
                this.routeResponse(source, 'alright, stopping');
                return true;
            }

            if (intent.type === Intent.TASK_STATUS && this.taskQueue) {
                this.routeResponse(source, this.taskQueue.statusString());
                return true;
            }

            if (intent.type === Intent.HELP) {
                this.routeResponse(source, "I can follow, build, mine, craft, farm, fight, sleep, and more. Just ask!");
                return true;
            }

            if (intent.type === Intent.INSPECT) {
                if (message.toLowerCase().includes('inventory') || message.toLowerCase().includes('items')) {
                    const inv = this.bot.inventory?.items() || [];
                    const itemList = inv.map(i => `${i.count}x ${i.displayName || i.name}`).join(', ');
                    this.routeResponse(source, `Inventory: ${itemList || 'empty'}`);
                } else {
                    const game = this.bot.game || {};
                    const pos = this.bot.entity?.position;
                    this.routeResponse(source, `HP: ${game.health?.toFixed(1) || '?'}/${game.food?.toFixed(0) || '?'} food | ${pos ? `@ ${pos.x.toFixed(0)}, ${pos.z.toFixed(0)}` : ''}`);
                }
                return true;
            }

            // A fast reply already answered this message — don't let the
            // deterministic brain stack a second reply on top of it.
            if (fastReplySent) return true;
        }

        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            if (behavior_log.length > 500) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - 500);
            }
            await this.history.add('system', 'Recent behaviors log: \n' + behavior_log);
        }

        await this.history.add(source, message);
        this.history.save();

        if (settings.enable_llm === false) {
            if (is_master && !self_prompt) {
                // Deterministic brain: RiveScript + node-nlp + Markov + RuleBrain
                await this.deterministicBrain._initPromise;
                const reply = await this.deterministicBrain.handle(source, message);
                if (reply) this.routeResponse(source, reply);
            }
            return true;
        }

        if (is_master) {
            await this.history.add('system', `[URGENT] ${MASTER_PLAYER} commands you. Do it NOW.`);
            max_responses = Infinity;
        }

        if (!self_prompt && this.self_prompter.isActive())
            max_responses = 1;

        for (let i=0; i<max_responses; i++) {
            if (Date.now() - loopStart > 30000) {
                console.warn('[Agent] Generation loop exceeded 30s, breaking');
                break;
            }
            if (this.shut_up || convoManager.responseScheduledFor(source)) break;
            if (self_prompt && this.self_prompter.shouldInterrupt(true)) break;

            let history = this.history.getHistory();
            console.log('[AI] generation started');
            let res = await this.prompter.promptConvo(history);
            console.log('[AI] generation complete:', res ? res.substring(0, 100) + (res.length > 100 ? '...' : '') : '(empty)');

            if (!res || res.trim().length === 0) {
                if (is_master) continue;
                break;
            }

            let command_name = containsCommand(res);

            if (command_name) {
                res = truncCommandMessage(res);
                this.history.add(this.name, res);

                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    continue;
                }

                if (this.shut_up) break;
                if (!self_prompt && isAction(command_name)) {
                    this.self_prompter.stopLoop();
                }

                if (this._isDuplicateCommand(command_name)) {
                    this.history.add('system', `Already executing ${command_name}, skipping duplicate.`);
                    break;
                }

                let execute_res = await executeCommand(this, res);
                used_command = true;

                if (execute_res) {
                    const stripped = execute_res.replace(/^Action output:\s*/i, '');
                    this.history.add('system', stripped);
                } else {
                    break;
                }
            }
            else {
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                if (is_master) continue;
                break;
            }

            this.history.save();
        }

        return used_command;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up || !message) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            convoManager.sendToBot(to_player, message);
        }
        else {
            this.openChat(message);
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) {
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        message = message.replaceAll('\n', ' ').replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1').trim();
        if (!message) return;

        const now = Date.now();
        if (now - this._lastChatTime < 1500) {
            await new Promise(r => setTimeout(r, 1500 - (now - this._lastChatTime)));
        }
        this._lastChatTime = Date.now();

        const lastWhisper = this.last_sender ? this._whisperLast[this.last_sender] : null;
        const whisperTarget = lastWhisper && (Date.now() - lastWhisper < 60000) ? this.last_sender : null;
        const chatMessage = whisperTarget ? `/msg ${whisperTarget} ${message}` : message;

        console.log('[CHAT] sending reply:', whisperTarget ? `(whisper to ${whisperTarget})` : '(public)', message);
        if (whisperTarget) {
            // Always allow whispers — private messages don't trigger anti-spam
            try {
                this.bot.chat(chatMessage);
            } catch (e) {
                console.warn('[CHAT] whisper FAILED:', e.message);
            }
        } else if (settings.chat_ingame && this.bot?.entity) {
            try {
                this.bot.chat(chatMessage);
                console.log('[CHAT] sent successfully');
            } catch (e) {
                console.warn('[CHAT] send FAILED, queued for retry:', e.message);
                this._pendingChats.push(chatMessage);
            }
        } else if (settings.chat_ingame) {
            console.warn('[CHAT] bot not spawned yet, queued');
            this._pendingChats.push(chatMessage);
        }

        this.emit('speak', to_translate);
        if (settings.speak) {
            speak(to_translate, this.prompter.profile.speak_model);
        }
        sendOutputToServer(this.name, message);
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0) {
                this.bot.emit('sunrise');
                if (this.emotionState) this.emotionState.applyEvent('day');
            } else if (this.bot.time.timeOfDay == 6000)
                this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
                this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000) {
                this.bot.emit('midnight');
                if (this.emotionState) this.emotionState.applyEvent('night');
            }
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
                // track nearest player as potential attacker
                const nearest = this.bot.nearestEntity(e => e.type === 'player' && e.username !== this.bot.username && this.bot.entity.position.distanceTo(e.position) < 16);
                if (nearest) {
                    this.bot.lastAttacker = nearest;
                    const attacker = nearest.username || nearest.name;
                    if (attacker) {
                        this.relationshipManager?.recordEvent(attacker, 'attack');
                        this.brain?.memory?.updatePlayerRelationship(attacker, -1, 'suspected nearby attacker');
                        this.serverAnalyzer?.onPlayerAttack(attacker);
                    }
                }
                if (this.emotionState) this.emotionState.applyEvent('damage');
                if (this.memory_bank) {
                    this.memory_bank.addMemory(`Took ${(prev_health - this.bot.health).toFixed(1)} damage (HP: ${this.bot.health.toFixed(1)})`, { type: 'fact', importance: 0.6 });
                }
            }
            prev_health = this.bot.health;
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop().catch(err => console.error('[Death] stop failed:', err.message));
            if (this.emotionState) this.emotionState.applyEvent('death');
            if (this.serverAnalyzer) {
                this.serverAnalyzer.onDeath('death');
            }
            // Save task progress before dying so we can resume after respawn
            this._saveTaskProgress();
            // Clear stale goal state so we don't resume explore with far-away coords
            if (this.brain?.executive) {
                this.brain.executive.lastInterruptedGoal = null;
                this.brain.executive.lastFailure = null;
            }
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {
            if (jsonMsg && jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name)) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                if (this.memory_bank) {
                    this.memory_bank.addMemory(`Died: ${message}`, { type: 'fact', importance: 0.9 });
                    if (death_pos) {
                        this.memory_bank.addMemory(`Death position: x=${death_pos.x.toFixed(0)} y=${death_pos.y.toFixed(0)} z=${death_pos.z.toFixed(0)}`, { type: 'place', importance: 0.85 });
                    }
                }
                if (this.emotionState) this.emotionState.applyEvent('death');
                if (this.relationshipManager && jsonMsg.translate) {
                    // check if another player killed the bot
                    const killer = jsonMsg.with?.find(w => typeof w === 'object' && w.text)?.text;
                    if (killer) {
                        this.relationshipManager.recordEvent(killer, 'attack');
                    }
                }
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                await this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop();
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction().catch(err => console.error('[Idle] resumeAction failed:', err.message));
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        const INTERVAL = 300;
        let last = Date.now();
        this._loopRunning = true;
        const runLoop = async () => {
            while (this._loopRunning) {
                try {
                    let start = Date.now();
                    await this.update(start - last);
                    let remaining = INTERVAL - (Date.now() - start);
                    if (remaining > 0) {
                        await new Promise((resolve) => setTimeout(resolve, remaining));
                    }
                    last = start;
                } catch (err) {
                    console.error('[UpdateLoop] Error in update cycle:', err.message);
                    console.error(err.stack);
                    await new Promise((resolve) => setTimeout(resolve, INTERVAL));
                }
            }
        };
        this._loopTimeout = setTimeout(() => { runLoop().catch(err => console.error('[UpdateLoop] Fatal:', err)); }, INTERVAL);

        this.bot.emit('idle');
    }

    _btTick() {
        if (this._btMutex) return;
        if (this.actions.executing) return;
        if (!settings.bt_enabled) return;
        // [AyushiOS coexistence] Skip BT if brain's motor cortex is running an autonomous task
        // ...or if TaskRunner is mid-task (expeditions etc.) — otherwise BT reflexes
        // keep stealing the pathfinder and cancelling the task's navigation.
        const taskRunnerBusy = this.taskRunner?.isRunning?.() ?? false;
        if (this.brain && this.brain.motor && (this.brain.motor.isBusy || taskRunnerBusy)) {
            const now = Date.now();
            if (!this._busySince) this._busySince = now;
            const isTaskBusy = settings._taskSteps?.length > 0;
            const maxBusy = isTaskBusy ? 1200000 : 300000;
            if (now - this._busySince > maxBusy) {
                console.warn(`[Watchdog] motor.isBusy stale for ${((now - this._busySince)/1000).toFixed(0)}s — force-clearing`);
                this.brain.motor.releaseAllBusyPins('watchdog stale-busy force-clear');
                this.brain.motor.isBusy = false;
                this._busySince = 0;
            } else {
                return;
            }
        } else {
            this._busySince = 0;
        }

        const state = this.btPerception.buildState(this.bot, this.btMemory, this.btServerIntel);
        if (!state) return;

        const interrupt = this.btTree.checkHardInterrupts(state);
        if (interrupt) {
            // Cooldown per interrupt action to prevent log spam
            const now = Date.now();
            if (this._lastInterruptTime && this._lastInterruptTime[interrupt.action] && now - this._lastInterruptTime[interrupt.action] < 5000) {
                return;
            }
            if (!this._lastInterruptTime) this._lastInterruptTime = {};
            this._lastInterruptTime[interrupt.action] = now;
            if (this.btCurrentTask) {
                this.requestInterrupt();
                this.btCurrentTask.reset();
                this.btCurrentTask = null;
            }
            const msg = `[BT] Hard interrupt: ${interrupt.action}`;
            console.log(msg);
            this.btCurrentTask = this.btTree.build(interrupt, state);
            if (this.btCurrentTask) {
                const ctx = { bot: this.bot, state, _btGen: this.btTree._generation, agent: this };
                const status = this.btCurrentTask.tick(ctx);
                if (status === 'SUCCESS' || status === 'FAILURE') {
                    this.btCurrentTask = null;
                }
            }
            return;
        }

        if (!this.btCurrentTask) {
            const ranked = this.btScorer.scoreActions(state, this.btMemory);
            if (ranked.length > 0) {
                const pick = ranked[0];
                if (settings.bt_log) console.log(`[BT] Task: ${pick.action} score=${pick.score.toFixed(1)}${pick.target ? ' target=' + pick.target : ''}`);
                this._btDecisionCount++;
                this.btCurrentTask = this.btTree.build(pick, state);
            }
        }

        if (this.btCurrentTask) {
            const ctx = { bot: this.bot, state, _btGen: this.btTree._generation, agent: this };
            const status = this.btCurrentTask.tick(ctx);
            if (status === 'SUCCESS' || status === 'FAILURE') {
                if (settings.bt_log) console.log(`[BT] Task finished: ${status}`);
                this.btCurrentTask = null;
            }
        } else if (settings.bt_log) {
            console.log('[BT] No action selected');
        }
    }

    async update(delta) {
        if (this.bot?.entity && Date.now() - this._lastKeepAliveAck > 60000) {
            const staleFor = Math.round((Date.now() - this._lastKeepAliveAck) / 1000);
            log(this.name, `No keep-alive from server for ${staleFor}s — connection appears dead, restarting...`);
            process.exit(1);
        }

        if (this._pendingChats.length > 0 && this.bot?.entity && settings.chat_ingame) {
            const msgs = this._pendingChats.splice(0);
            for (const msg of msgs) {
                try { this.bot.chat(msg); } catch {}
            }
        }

        await this.bot.modes.update();

        if (settings.bt_enabled) {
            // P0-4: legacy path. BT strategic scoring is retired while the
            // AyushiOS brain is active — two strategists = two steering wheels.
            if (this.brain?.executive) {
                console.warn('[Agent] bt_enabled ignored — AyushiOS brain is active (single-authority rule)');
            } else {
                this._btTick();
            }
            await this.checkTaskDone();
        } else {
            this.self_prompter.update(delta);
            await this.checkTaskDone();

            if (this.goalPlanner && !this.brain?.executive) {
                // GoalPlanner advisor ticks are brain-owned when the brain runs.
                await this.goalPlanner.tick();
            }
        }

        if (this.taskQueue && this.isIdle() && this.taskQueue.hasPending && !this.taskQueue.active) {
            this.taskQueue.processNext(this).catch(err => console.error('[TaskQueue] Auto-process error:', err.message));
        }

        if (this.worldKnowledge) {
            await this.worldKnowledge.refresh();
        }
        if (this.curiosityEngine) {
            await this.curiosityEngine.tick();
        }
        if (this.emotionState) {
            this.emotionState.tick(delta);
            if (this.bot.entity?.velocity && (Math.abs(this.bot.entity.velocity.x) > 0.01 || Math.abs(this.bot.entity.velocity.z) > 0.01)) {
                this.emotionState.applyEvent('move');
            } else if (this.isIdle()) {
                this.emotionState.applyEvent('idle');
            }
        }
        if (this.episodicReplay) {
            await this.episodicReplay.tick();
        }
        if (this.reflectionEngine) {
            await this.reflectionEngine.tick();
        }
        if (this.metaLearner) {
            await this.metaLearner.tick();
        }
        if (this.skillLearner) {
            this.skillLearner.save();
        }
        if (this.memory_bank) {
            this.memory_bank.save();
        }

        // Update emotions from world knowledge
        if (this.emotionState && this.worldKnowledge) {
            const wk = this.worldKnowledge.cached || '';
            if (wk.includes('zombie') || wk.includes('skeleton') || wk.includes('creeper')) {
                this.emotionState.applyEvent('damage');
            }
        }
    }

    isIdle() {
        if (this.actions.executing) return false;
        if (this.brain && this.brain.motor && this.brain.motor.isBusy) return false;
        return true;
    }

    /**
     * Periodic inventory maintenance (every ~8s):
     *  - auto-equip better armor / swap dying gear
     *  - remember chests we walk past
     *  - sort + compact when fragmented
     *  - drop junk when nearly full (never tools/food/torches)
     * Runs ONLY while idle so it never fights an active task.
     */
    async _inventoryTick() {
        const im = this.inventoryManager;
        if (!im || !this.bot?.entity) return;
        // Never fight active motor work
        if (this.actions.executing) return;
        if (this.brain?.motor?.isBusy || this.taskRunner?.isRunning?.()) return;

        await im.maintainGear();

        // Remember any chest within 24 blocks (free spatial knowledge)
        try {
            const chest = this.bot.findBlock({ matching: b => b.name === 'chest' || b.name === 'barrel', maxDistance: 24 });
            if (chest && !im.chests.some(c => c.key === `${chest.position.x},${chest.position.y},${chest.position.z}`)) {
                im.rememberChest(chest.position, null);
            }
        } catch (_) {}

        const needs = im.needs();
        if (needs.full || needs.nearlyFull) {
            await im.makeRoom(2);
        }
        // Occasional tidy-up (max once per 3 min)
        if (Date.now() - (im._lastSortAt || 0) > 180000 && !needs.full) {
            await im.compact({ sort: true });
            await im.ensureHotbarLoadout();
        }

        // ── SELF-CARE: proactive eating — a starving bot looks dumb no
        // matter how good its planner is. Eat when food ≤ 14 while idle.
        try {
            const bot = this.bot;
            if ((bot.food ?? 20) <= 14) {
                const { eatBestFood } = await import('./library/skills.js');
                await eatBestFood(bot);
            }
        } catch (_) {}
    }
    

    async cleanKill(msg='Killing agent process...', code=1) {
        this._loopRunning = false;
        if (this._loopTimeout) clearTimeout(this._loopTimeout);
        if (code < 1) code = 1;
        await this.history.add('system', msg);
        if (this.bot?.entity) {
            console.log(`[Agent] ${code > 1 ? 'Restarting.' : 'Exiting.'}`);
        }
        await this.history.save();
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        this._loopRunning = false;
        if (this._loopTimeout) clearTimeout(this._loopTimeout);
        serverProxy.shutdown();
    }
}

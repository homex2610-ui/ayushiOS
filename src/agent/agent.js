import { History } from './history.js';
import { Coder } from './coder.js';
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
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
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
        this._lastHeartbeat = Date.now();
        this._lastChatTime = 0;
        this.fastReply = new FastReply(this);
        this.taskQueue = null;
        this.taskRunner = null;
        this.brain = null;
        this.brainIsBusy = false;

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);
        
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
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            const { type } = handleDisconnection(this.name, reason);

            const navOnBot = this.bot && this.bot._navigationInProgress;
            const navOnManager = connectionManager.hubNavigator && connectionManager.hubNavigator.isNavigating;
            const wasNavigating = navOnBot || navOnManager;
            if (wasNavigating) {
                console.log('[Agent] Disconnected during hub navigation — allowing reconnect for fallback.');
                return;
            }

            // Don't crash — allow reconnect manager to handle it
            if (settings.connection_auto_reconnect) {
                console.log('[Agent] Disconnected — auto-reconnect will handle reconnection.');
                return;
            }
            process.exit(1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
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
                this.serverAnalyzer.start();
                this.btServerIntel.attach(this.bot);
                this.curiosityEngine = new CuriosityEngine(this);
                if (settings.enable_curiosity !== false) this.curiosityEngine.start();
                if (this.goalPlanner && settings.enable_goal_planner !== false) this.goalPlanner.start();

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
                this.fastReply = new FastReply(this);

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
                // Position-based hub check: hub platform at y≈131, survival spawn at y≈99
                const posY = this.bot.entity?.position?.y;
                const atHubY = posY && posY > 120;
                const alreadySurvival = !npcHub && !atHubY && (gamemodeIsSurvival || stateIsSurvival) && connectionManager.state !== 'hub';

                if (npcHub || (!alreadySurvival && settings.enable_brain !== false && this.bot?.entity)) {
                    console.log(`[Agent] ${npcHub ? 'Hub NPCs detected' : 'Not in survival'} (gameMode=${this.bot?.game?.gameMode}, state=${connectionManager.state}). Attempting to join survival...`);

                    // Ensure we're authenticated before sending server commands
                    const pw = settings.password || 'KryonSecurePass1234';
                    this.bot.chat(`/login ${pw}`);
                    await new Promise(r => setTimeout(r, 2000));

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

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

                // Walk away from spawn protection BEFORE brain boots
                try {
                    const p = this.bot.entity?.position;
                    if (p) {
                        console.log(`[Agent] At (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}). Trying to join survival via commands...`);
                        const cmds = ['/survival', '/server survival', '/join survival', '/smp'];
                        const origPos = { x: p.x, y: p.y, z: p.z };
                        for (const cmd of cmds) {
                            this.bot.chat(cmd);
                            await new Promise(r => setTimeout(r, 4000));
                            const cp = this.bot.entity?.position;
                            if (cp) {
                                const dx = cp.x - origPos.x;
                                const dy = cp.y - origPos.y;
                                const dz = cp.z - origPos.z;
                                const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
                                if (dist > 3) {
                                    console.log(`[Agent] Joined survival via "${cmd}" (moved ${Math.round(dist)}m)`);
                                    break;
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.warn('[Agent] Spawn escape error:', e.message);
                }

                // [AyushiOS] Boot the brain after all systems are online
                if (settings.enable_brain !== false) {
                    try {
                        this.taskRunner = new TaskRunner(this.bot);
                        this.brain = new AyushiOS(this.bot, this.taskRunner);
                        // Immediately mark motor as busy to prevent brain tasks from interfering with diamond grind
                        if (this.brain && this.brain.motor) {
                            this.brain.motor.isBusy = true;
                        }
                        console.log('[AyushiOS] Brain booted — autonomous loop running (motor busy).');
                    } catch (brainErr) {
                        console.error('[AyushiOS] Failed to boot brain:', brainErr.message);
                        this.brain = null;
                    }
                }

                // Execute diamond_grind task steps via TaskRunner after brain boots
                if (settings._taskSteps && Array.isArray(settings._taskSteps)) {
                    const humanDelay = Math.floor(Math.random() * 5000) + 5000;
                    console.log(`[Agent] Will execute ${settings._taskSteps.length} task steps after ${humanDelay}ms delay...`);

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
                            this.brain.motor.isBusy = true;
                        }

                        // Pre-grind: walk away from spawn if still near it
                        try {
                            const p = this.bot.entity?.position;
                            if (p && Math.abs(p.x) + Math.abs(p.z) < 40) {
                                console.log(`[Agent] Near spawn (${Math.round(p.x)}, ${Math.round(p.z)}), walking away to find resources...`);
                                const walkSkill = this.taskRunner?.skills?.['move_to'];
                                if (walkSkill) {
                                    await walkSkill({ x: 100, z: 100, range: 5 });
                                    console.log(`[Agent] Arrived at (${Math.round(this.bot.entity?.position?.x)}, ${Math.round(this.bot.entity?.position?.z)})`);
                                }
                            } else {
                                console.log(`[Agent] Already away from spawn (${Math.round(p?.x)}, ${Math.round(p?.z)}), proceeding with grind`);
                            }
                        } catch (walkErr) {
                            console.warn(`[Agent] Walk-away failed: ${walkErr.message}, continuing with grind anyway`);
                        }

                        // Pause unstuck mode during diamond grind
                        if (this.bot.modes) this.bot.modes.pause('unstuck');

                        try {
                            for (let i = 0; i < settings._taskSteps.length; i++) {
                                const step = settings._taskSteps[i];
                                if (!step || !step.skill) {
                                    console.log(`[Agent] Step ${i + 1}: invalid, skipping`);
                                    continue;
                                }
                                if (this.bot.interrupt_code) {
                                    console.log('[Agent] Task interrupted');
                                    break;
                                }
                                const outputBefore = (this.bot.output || '').length;
                                console.log(`[Agent] Step ${i + 1}/${settings._taskSteps.length}: ${step.skill}(${JSON.stringify(step.params || {})})`);
                                try {
                                    const SkillFn = this.taskRunner.skills[step.skill];
                                    if (SkillFn) {
                                        await SkillFn(step.params || {});
                                    } else {
                                        console.warn(`[Agent] Unknown skill: ${step.skill}`);
                                    }
                                } catch (stepErr) {
                                    console.warn(`[Agent] Step ${i + 1} failed: ${stepErr.message}`);
                                }
                                // Log skill output
                                if (this.bot.output && this.bot.output.length > outputBefore) {
                                    const newOutput = this.bot.output.substring(outputBefore).trim();
                                    if (newOutput) console.log(`  => ${newOutput}`);
                                }
                                // Re-assert busy — reflexes may have cleared it
                                if (this.brain && this.brain.motor) {
                                    this.brain.motor.isBusy = true;
                                }
                                // Human-like delay between steps
                                await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
                            }
                            console.log('[Agent] Diamond grind task completed!');
                        } catch (e) {
                            console.error(`[Agent] Task execution error: ${e.message}`);
                        } finally {
                            if (this.brain && this.brain.motor) {
                                this.brain.motor.isBusy = false;
                            }
                            // After diamond grind, continue with productive work
                            console.log('[Agent] Task done. AyushiOS brain will continue autonomous operation.');
                        }
                    }, humanDelay);
                }

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            } finally {
                clearTimeout(spawnTimeout);
            }
        });
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

    async _processQueue() {
        if (this._processingMessage) return;
        this._processingMessage = true;
        while (this._messageQueue.length > 0) {
            const item = this._messageQueue.shift();
            try {
                await this.handleMessage(item.username, item.message);
            } catch (err) {
                console.error('[Agent] Error processing queued message:', err);
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            await new Promise(r => setTimeout(r, 100));
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

    _cannedResponse(message) {
        const m = message.toLowerCase();
        const greetings = ['hi', 'hello', 'hey', 'yo', 'sup', 'whats up', 'heyy'];
        if (greetings.some(g => m.includes(g))) return 'yo';
        if (m.includes('come') || m.includes('follow')) return 'coming';
        if (m.includes('stop') || m.includes('stay') || m.includes('wait')) return 'alright';
        if (m.includes('go') || m.includes('move')) return 'moving';
        if (m.includes('here') || m.includes('this way')) return 'on my way';
        if (m.includes('inventory') || m.includes('what do you have')) {
            const inv = this.bot?.inventory?.items() || [];
            const items = inv.map(i => `${i.count}x ${i.displayName || i.name}`).join(', ');
            return items ? `got ${items}` : 'nothing on me';
        }
        if (m.includes('hp') || m.includes('health') || m.includes('status')) {
            const hp = this.bot?.health?.toFixed(1) || '?';
            const food = this.bot?.food?.toFixed(0) || '?';
            return `hp ${hp} food ${food}`;
        }
        if (m.includes('where') || m.includes('pos') || m.includes('location')) {
            const p = this.bot?.entity?.position;
            return p ? `at ${p.x.toFixed(0)} ${p.y.toFixed(0)} ${p.z.toFixed(0)}` : 'dunno';
        }
        if (m.includes('thanks') || m.includes('ty') || m.includes('thx')) return 'np';
        if (m.includes('bye') || m.includes('cya')) return 'cya';
        if (m.includes('mine') || m.includes('dig') || m.includes('collect')) return 'on it';
        if (m.includes('build') || m.includes('place')) return 'building';
        if (m.includes('attack') || m.includes('kill') || m.includes('fight')) return 'fighting';
        if (m.includes('farm') || m.includes('plant')) return 'farming';
        if (m.includes('craft') || m.includes('make')) return 'crafting';
        if (m.includes('sleep') || m.includes('bed')) return 'sleeping';
        return `got it`;
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
            this._lastHeartbeat = Date.now();
            console.log('[CHAT] received:', username, '▶', message);
            if (username === this.name) return;
            const usernameLower = username.toLowerCase();
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.some(u => u.toLowerCase() === usernameLower)) return;
            if (ignore_messages.some((m) => message.startsWith(m))) return;

            this.last_sender = username;
            this.shut_up = false;
            // Track as whisper target so openChat replies via /msg even if whisper event never fires
            this._whisperLast[username] = Date.now();

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
            if (this.brain && this.brain.broca && !message.startsWith('!')) {
                this.brain.broca.handleIncomingChat(username, message);
            }

            let translation = await handleEnglishTranslation(message);
            if (this.serverAnalyzer) {
                this.serverAnalyzer.onChatMessage(translation);
                if (username === MASTER_PLAYER) this.serverAnalyzer.setOwner(username);
            }
            if (this.relationshipManager) {
                this.relationshipManager.recordMessage(username, translation);
            }
            if (this.knowledgeGraph) {
                this.knowledgeGraph.learnTriple(username, 'chatted_with', this.name);
            }
            this._enqueueMessage(username, translation);
        }

        this.respondFunc = respondFunc;
        this._whisperLast = {};

        this.bot.on('whisper', (username, message) => {
            this._whisperLast[username] = Date.now();
            // Auto-accept /tpa from updesh on any whisper (teleport request may be toast, but catch it here too)
            if (username.toLowerCase() === 'updesh' || username.toLowerCase() === 'updes') {
                console.log(`[Agent] updesh whispered: "${message}" — sending /tpaccept`);
                this.bot.chat('/tpaccept');
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

            // Auto-accept /tpa from updesh
            const lower = plain.toLowerCase();
            if ((lower.includes('teleport') || lower.includes('tpa') || lower.includes('/tpaccept') || lower.includes('updesh') || lower.includes('updes'))) {
                if (lower.includes('updesh') || lower.includes('updes')) {
                    console.log(`[Agent] Auto-accepting teleport from updesh (${source})`);
                    this.bot.chat('/tpaccept');
                }
            }

            // Auto-auth: catch login/register prompts that AuthHandler's bot.on('message') might miss
            if (this._lastAuthCheck && Date.now() - this._lastAuthCheck < 3000) { /* skip — rate limited */ }
            else {
                const pw = settings.password || 'KryonSecurePass1234';
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
            if (this.serverAnalyzer) this.serverAnalyzer.onChatMessage(message);
            handleRawMessage('messagestr', message);
        });

        // Mineflayer 4.x systemChat fallback
        this.bot.on('systemChat', (msg) => {
            if (typeof msg === 'string') {
                handleRawMessage('systemChat', msg);
                this.bot.emit('messagestr', msg);
            }
        });

        // [AyushiOS] Raw packet interceptors — catch messages on any protocol version
        if (this.bot._client) {
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
        this.bot.interrupt_code = false;
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

        if (is_master || (source !== 'system' && !from_other_bot)) {
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) return false;
                if (user_command_name === '!newAction') {
                    this.history.add(source, message);
                }
                if (isAction(user_command_name)) {
                    this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                }
                // Pause autonomous brain during manual command
                if (this.brain && this.brain.motor) this.brain.motor.isBusy = true;
                try {
                    let execute_res = await executeCommand(this, message);
                    if (execute_res) this.routeResponse(source, execute_res);
                } finally {
                    if (this.brain && this.brain.motor) this.brain.motor.isBusy = false;
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
                this.routeResponse(source, this._cannedResponse(message));
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
                if (nearest) this.bot.lastAttacker = nearest;
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
                    if (killer) this.relationshipManager.recordEvent(killer, 'attack');
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
        if (this.brain && this.brain.motor && this.brain.motor.isBusy) return;

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
                const ctx = { bot: this.bot, state, _btGen: this.btTree._generation };
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
            const ctx = { bot: this.bot, state, _btGen: this.btTree._generation };
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
        if (this.bot?.entity && Date.now() - this._lastHeartbeat > 300000) {
            try { this.bot.chat(''); } catch {
                log(this.name, 'Connection appears dead, reconnecting...');
                process.exit(1);
            }
        }

        if (this._pendingChats.length > 0 && this.bot?.entity && settings.chat_ingame) {
            const msgs = this._pendingChats.splice(0);
            for (const msg of msgs) {
                try { this.bot.chat(msg); } catch {}
            }
        }

        await this.bot.modes.update();

        if (settings.bt_enabled) {
            this._btTick();
            await this.checkTaskDone();
        } else {
            this.self_prompter.update(delta);
            await this.checkTaskDone();

            if (this.goalPlanner) {
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

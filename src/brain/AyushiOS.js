// AyushiOS.js
// ─────────────────────────────────────────────────────────────
// THE BRAIN, ASSEMBLED.
// Boot order mirrors how a nervous system actually comes online:
// senses first, then memory/instinct, then the slower conscious
// loop last. Nothing in here does the "thinking" itself — that
// lives in ExecutiveBrain, MemoryMatrix, PersonalityEngine, etc.
// This file's only job is wiring + the master clock.
 // ─────────────────────────────────────────────────────────────

import { EventBus } from './EventBus.js';
import { SurvivalSupervisor } from '../safety/SurvivalSupervisor.js';
import { WorldModel } from '../perception/WorldModel.js';
import { SensoryCortex } from './SensoryCortex.js';
import { MemoryMatrix } from './MemoryMatrix.js';
import { PersonalityEngine } from './PersonalityEngine.js';
import { SpinalCord } from './SpinalCord.js';
import { ExecutiveBrain } from './ExecutiveBrain.js';
import { MotorCortex } from './MotorCortex.js';
import { BrocaArea } from './BrocaArea.js';
import { TheoryOfMind } from './TheoryOfMind.js';
import { BeliefState } from './BeliefState.js';
import { Knowledge } from './Knowledge.js';
import { DecisionTrace } from './DecisionTrace.js';
import { ServerKnowledgeBridge } from './ServerKnowledgeBridge.js';
import { TaskContext } from './TaskContext.js';
import { LearningEngine } from '../learning/LearningEngine.js';
import { THRESHOLDS, FEATURES } from './config.js';
import { SensorArray, NN_FEATURE_COUNT } from './SensorArray.js';
import { TinyBrain, ActionMemory } from './NeuralNet.js';
import { SocialModule } from '../agent/SocialModule.js';
import fs from 'fs';
import path from 'path';

/**
 * Neural cortex architecture — 6 layers:
 * [22 sensor inputs] → 32 → 16 → 8 → 4 → [3 outputs]
 * outputs: [danger, hungerRisk, grindReadiness], each sigmoid 0..1.
 */
const NEURAL_ARCH = [NN_FEATURE_COUNT, 32, 16, 8, 4, 3];

// ── NN tuning knobs (single source of truth) ──────────────────
const NN_OUTCOME_WINDOW_MS = 8000;   // label sample after this delay
const NN_REPLAY_CAP        = 200;    // max verified training samples
const NN_TRAIN_INTERVAL_MS = 10000;  // min ms between train batches
const NN_TRAIN_BATCH       = 16;     // samples per mini-batch
const NN_TRAIN_LR          = 0.05;   // learning rate
const NN_SAVE_INTERVAL_MS  = 300000; // persist weights every 5 min
const NN_DEFER_THROTTLE_MS = 15000;  // min ms between danger vetoes
const NN_LOG_EVERY         = 25;     // console.log every N train steps

export class AyushiOS {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {{runTask: (steps: any[]) => Promise<void>}} taskRunner
   * @param {object} [opts]
   * @param {object} [opts.serverAnalyzer]
   * @param {object} [opts.anthropicClient]
   */
  constructor(bot, taskRunner, opts = {}) {
    this.bot = bot;
    this.bus = new EventBus();
    this._suggestions = [];
    this._lastEmergencyTime = 0;

    // --- Layer boot order: senses -> world model -> memory/beliefs -> personality -> executive -> motor -> language
    this.senses = new SensoryCortex(bot, this.bus);
    // P0-6: canonical world model — single threat/vitality contracts.
    this.memory = new MemoryMatrix(bot.username, this.bus);
    this.beliefs = new BeliefState();
    this.worldModel = new WorldModel({ bot, beliefs: this.beliefs, memory: this.memory });
    this.knowledge = new Knowledge({ bot, beliefs: this.beliefs, memory: this.memory });
    this.trace = new DecisionTrace({ bus: this.bus, username: bot.username });
    this.personality = new PersonalityEngine(this.bus);
    this.tom = FEATURES.enableTheoryOfMind ? new TheoryOfMind(this.memory) : null;
    this.executive = new ExecutiveBrain(this.memory, this.personality, this.tom, this.bus, {
      knowledge: this.knowledge,
      trace: this.trace,
      getSuggestions: () => this.drainSuggestions(),
      getPlannerHints: (goal, state) => this.learning?.getPlannerHints(goal, state) || {},
      getActionMemory: () => this.actionMemory,
      getSensorArray: () => this.sensorArray,
    });
    this.motor = new MotorCortex(bot, taskRunner, this.bus);
    this.spinalCord = new SpinalCord(bot, this.bus, { masterName: 'updesh' });
    this.broca = new BrocaArea(bot, this);
    // P0-5: emergency POLICY lives in the supervisor, not the orchestrator.
    this.supervisor = new SurvivalSupervisor({ bus: this.bus });

    this.knowledgeBridge = null;
    if (opts.serverAnalyzer) {
      this.knowledgeBridge = new ServerKnowledgeBridge(opts.serverAnalyzer, this.memory, {
        beliefs: this.beliefs,
        intervalMs: 15000,
      });
      this.knowledgeBridge.start();
    }

    this.learning = new LearningEngine({
      bus: this.bus,
      knowledge: this.knowledge,
      memory: this.memory,
      beliefs: this.beliefs,
      motorCortex: this.motor,
      trace: this.trace,
      username: bot.username,
    });

    // --- Neural cortex: sensors → TinyBrain → online learning ---
    // Learns from outcomes (took damage / got hungry / stayed safe) and
    // predicts near-term risk so the executive can steer early.
    this.sensorArray = new SensorArray(bot);
    this.neuralNetPath = path.join(process.cwd(), 'bots', bot.username, 'neural_net.json');
    this.neuralNet = this._loadNeuralNet();
    this._nnPending = [];     // samples awaiting outcome verification
    this._nnReplay = [];      // verified {x, y} training buffer
    this._nnPredictions = null;
    this._nnLastTrain = 0;
    this._nnLastSave = Date.now();
    this._nnLastDefer = 0;

    // Action-outcome memory: learns which actions work in which contexts.
    this.actionMemory = this._loadActionMemory();
    this._lastActionFeatures = null;  // features when last action started
    this._lastActionName = null;      // name of last action started
    this._actionMemoryDecayAt = 0;

    // Social module: multiplayer communication (English + Hindi/Hinglish)
    this.social = new SocialModule(bot, this.personality);
    this._setupSocialEvents();

    // P1: normalized connection events → BeliefState (cognition stays out
    // of the connection layer; it only hears about state changes).
    try {
      const cm = opts.connectionManager;
      if (cm?.onConnectionChanged) {
        cm.onConnectionChanged((state, from) => {
          this.beliefs?.update({
            connectionState: state,
            previousConnectionState: from,
            connectionChangedAt: Date.now(),
          }, 'connection');
          this.bus.emit('connection.changed', { state, from, time: Date.now() });
          console.log(`[Ayushi OS] 🔌 ${from} → ${state}`);
        });
      }
    } catch (_) {}

    this._wireCrossModuleEffects();
    this._startCognitiveLoop();

    console.log(`[Ayushi OS] \u2705 All systems online. ${bot.username} is awake.`);
  }

  /** Advisor suggestions (Curiosity / GoalPlanner) — never execute themselves. */
  proposeSuggestion(suggestion) {
    if (!suggestion || typeof suggestion !== 'object') return;
    const entry = {
      type: suggestion.type || 'generic',
      goal: suggestion.goal || suggestion.name || null,
      reason: suggestion.reason || '',
      priority: typeof suggestion.priority === 'number' ? suggestion.priority : 0.3,
      steps: suggestion.steps || null,
      source: suggestion.source || 'advisor',
      time: Date.now(),
    };
    this._suggestions.push(entry);
    if (this._suggestions.length > 20) this._suggestions.shift();
    this.bus.emit('advisor_suggestion', entry);
  }

  drainSuggestions() {
    const now = Date.now();
    const fresh = this._suggestions.filter(s => now - s.time < 60000);
    this._suggestions = [];
    return fresh;
  }

  peekSuggestions() {
    const now = Date.now();
    return this._suggestions.filter(s => now - s.time < 60000);
  }

  _wireCrossModuleEffects() {
    this.bus.on('sleep_started', () => this.memory.dreamAndConsolidate());

    this.bus.on('reflex_fired', ({ reflexType }) => {
      this.memory.recordEvent(`Reflex triggered: ${reflexType}`, 2);
      this.trace.markInterrupted(`reflex:${reflexType}`);
    });

    this.bus.on('mood_changed', ({ from, to }) => {
      this.memory.recordEvent(`Mood shifted ${from} -> ${to}`, 1);
    });

    this.bus.on('task_failed', ({ taskName, error }) => {
      this.memory.recordEvent(`Task failed: ${taskName} (${error})`, 2);
      this.trace.markInterrupted(`task_failed:${taskName}`);
      this.trace.recordResult(
        { taskName },
        { status: 'failed', error: String(error) }
      );
      // Action-outcome memory: record failure
      if (this._lastActionFeatures && this._lastActionName === taskName) {
        this.actionMemory.record(this._lastActionFeatures, taskName, 0);
      }
      // Backoff: don't let the planner re-pick a failing task immediately.
      // Cooldown doubles per consecutive failure (30s → 60s → ... → 10min cap).
      this._taskCooldowns ??= new Map();
      const prev = this._taskCooldowns.get(taskName) || { strikes: 0, until: 0 };
      const strikes = prev.strikes + 1;
      const cooldownMs = Math.min(20 * 1000, 5000 * Math.pow(2, strikes - 1));
      this._taskCooldowns.set(taskName, { strikes, until: Date.now() + cooldownMs });
      console.log(`[Ayushi OS] "${taskName}" failed ${strikes}x — deferring for ${(cooldownMs / 1000).toFixed(0)}s`);
    });

    this.bus.on('task_interrupted', ({ taskName }) => {
      this.trace.markInterrupted(`task_interrupted:${taskName}`);
      this.trace.recordResult(
        { taskName },
        { status: 'interrupted' }
      );
    });

    this.bus.on('task_completed', ({ taskName }) => {
      if (taskName) {
        // Success clears the failure backoff
        if (this._taskCooldowns?.has(taskName)) this._taskCooldowns.delete(taskName);
        this.trace.markResumed(taskName);
        this.trace.recordResult(
          { taskName },
          { status: 'completed' }
        );
        // Action-outcome memory: record success
        if (this._lastActionFeatures && this._lastActionName === taskName) {
          this.actionMemory.record(this._lastActionFeatures, taskName, 1);
        }
        // A finished avoidance marks those hazards handled for a while —
        // otherwise the same recorded hazard re-triggers every cooldown cycle.
        if (taskName === 'avoid_hazard') {
          const avoided = this.memory.markHazardsAvoided(this.bot.entity?.position, 30);
          if (avoided > 0) console.log(`[Ayushi OS] ${avoided} hazard(s) marked avoided (60s grace)`);
        }
      }
    });

    this.bus.on('emergency_stop', () => {
      console.warn('[Ayushi OS] Emergency stop — cleaning up trace + stopping cognitive loop');
      this.trace.markInterrupted('emergency_stop');
      this.stop();
    });
  }

  _startCognitiveLoop() {
    this._tickCount = 0;
    this._ticking = false;
    // .catch on the async tick: one throw must not silently kill every
    // future cycle as an unhandled rejection.
    this._tickHandle = setInterval(() => {
      this._tick().catch(e => console.error('[Ayushi OS] tick failed:', e?.message || e));
    }, THRESHOLDS.cognitiveTickMs);
  }

  /** Restart the cognitive loop after emergency_stop()/stop(). */
  resumeLoop() {
    if (this._tickHandle) return; // already running
    console.log('[Ayushi OS] Resuming cognitive loop');
    this._startCognitiveLoop();
  }

  stop() {
    clearInterval(this._tickHandle);
    this._tickHandle = null;
    this.knowledgeBridge?.stop();
    // Persist learned weights + release sensor listeners
    this._saveNeuralNet();
    this._saveActionMemory();
    this.sensorArray?.detach();
  }

  // ── Neural cortex: sense → predict → verify → learn ─────────

  _loadNeuralNet() {
    try {
      if (fs.existsSync(this.neuralNetPath)) {
        const brain = TinyBrain.fromJSON(JSON.parse(fs.readFileSync(this.neuralNetPath, 'utf-8')));
        if (brain.inputSize === NN_FEATURE_COUNT) {
          console.log(`[Ayushi OS] 🧠 Neural net loaded (${brain.sizes.join('→')}, ${brain.trainSteps} training steps)`);
          return brain;
        }
        console.log('[Ayushi OS] 🧠 Sensor layout changed — retraining neural net from scratch');
      }
    } catch (e) {
      console.warn('[Ayushi OS] Neural net load failed:', e.message);
    }
    return new TinyBrain(NEURAL_ARCH);
  }

  _saveNeuralNet() {
    try {
      fs.mkdirSync(path.dirname(this.neuralNetPath), { recursive: true });
      const tmp = `${this.neuralNetPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.neuralNet.toJSON()));
      fs.renameSync(tmp, this.neuralNetPath);
    } catch (e) {
      console.warn('[Ayushi OS] Neural net save failed:', e.message);
    }
  }

  _loadActionMemory() {
    try {
      const memPath = this.neuralNetPath.replace('neural_net.json', 'action_memory.json');
      if (fs.existsSync(memPath)) {
        const mem = ActionMemory.fromJSON(JSON.parse(fs.readFileSync(memPath, 'utf-8')));
        console.log(`[Ayushi OS] Action memory loaded (${mem.entries.size} entries)`);
        return mem;
      }
    } catch (e) {
      console.warn('[Ayushi OS] Action memory load failed:', e.message);
    }
    return new ActionMemory();
  }

  _saveActionMemory() {
    try {
      const memPath = this.neuralNetPath.replace('neural_net.json', 'action_memory.json');
      fs.mkdirSync(path.dirname(memPath), { recursive: true });
      const tmp = `${memPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.actionMemory.toJSON()));
      fs.renameSync(tmp, memPath);
    } catch (e) {
      console.warn('[Ayushi OS] Action memory save failed:', e.message);
    }
  }

  /**
   * One cognitive-tick worth of neural work. Cheap by design:
   * feature read + forward pass every tick; labeling/training throttled.
   */
  _neuralStep(snapshot) {
    const now = Date.now();
    const x = this.sensorArray.readFeatures(snapshot);
    this.sensorArray.observeVitals(
      snapshot?.vitality?.health ?? this.sensorArray.lastHealth ?? 20,
      snapshot?.vitality?.food ?? this.sensorArray.lastFood ?? 20,
      now
    );

    const out = this.neuralNet.predict(x);
    this._nnPredictions = { danger: out[0], hungerRisk: out[1], readiness: out[2] };
    this.bus.emit('nn_prediction', { ...this._nnPredictions, time: now });

    // Queue sample; label it once the outcome window has elapsed.
    this._nnPending.push({
      x,
      t: now,
      h: snapshot?.vitality?.health ?? this.sensorArray.lastHealth ?? 20,
      f: snapshot?.vitality?.food ?? this.sensorArray.lastFood ?? 20,
    });
    while (this._nnPending.length && now - this._nnPending[0].t > NN_OUTCOME_WINDOW_MS) {
      const s = this._nnPending.shift();
      const hNow = this.sensorArray.lastHealth ?? s.h;
      const fNow = this.sensorArray.lastFood ?? s.f;
      const tookDamage = hNow < s.h;
      const gotHungry = fNow < s.f;
      this._nnReplay.push({
        x: s.x,
        y: [
          tookDamage ? 1 : 0,
          gotHungry ? 1 : 0,
          (!tookDamage && !gotHungry && hNow >= 10 && fNow >= 6) ? 1 : 0,
        ],
      });
      if (this._nnReplay.length > NN_REPLAY_CAP) this._nnReplay.shift();
    }

    // Train in small batches, at most every ~10s.
    if (now - this._nnLastTrain > NN_TRAIN_INTERVAL_MS && this._nnReplay.length >= 4) {
      const loss = this.neuralNet.trainBatch(this._nnReplay.slice(-NN_TRAIN_BATCH), NN_TRAIN_LR);
      this._nnLastTrain = now;
      if (this.neuralNet.trainSteps % NN_LOG_EVERY === 1) {
        console.log(`[Ayushi OS] 🧠 train step ${this.neuralNet.trainSteps} — loss ${loss.toFixed(4)}, replay ${this._nnReplay.length}`);
      }
    }
    if (now - this._nnLastSave > NN_SAVE_INTERVAL_MS) {
      this._saveNeuralNet();
      this._nnLastSave = now;
    }
    // Action memory: decay stale entries and save periodically (every 5 min)
    if (now - this._actionMemoryDecayAt > 300000) {
      this.actionMemory.decay();
      this._saveActionMemory();
      this._actionMemoryDecayAt = now;
    }
  }

  _requestEmergencyInterrupt(reason = 'unspecified') {
    if (this.motor.activeContext && this.motor.activeContext.status === 'running') {
      this.motor.activeContext.pause();
    }
    this.motor.taskRunner?.requestInterrupt?.();
    this.bot.interrupt_code = true;
    this.bot.pathfinder?.setGoal?.(null);
    this.trace.markInterrupted(`emergency:${reason}`);
  }

  _refreshBeliefsFromSenses(snapshot) {
    const pos = snapshot?.environment?.position || null;
    let biome = this.beliefs.biome;
    if (this.bot?.entity?.position && this.bot.blockAt) {
      try {
        biome = this.bot.blockAt(this.bot.entity.position)?.biome?.name || biome;
      } catch (_) {
        // blockAt may throw if position is in unloaded chunks
      }
    }

    this.beliefs.update({
      position: pos,
      dimension: this.bot?.game?.dimension || this.beliefs.dimension,
      biome,
      vitality: {
        health: snapshot?.vitality?.health ?? this.beliefs.vitality.health,
        food: snapshot?.vitality?.food ?? this.beliefs.vitality.food,
        hasFood: !!snapshot?.vitality?.hasFood,
      },
      threats: snapshot?.threats || [],
      nearbyPlayers: snapshot?.social?.nearbyPlayers || [],
    });
  }

  async _tick() {
    if (this._ticking) return;
    this._ticking = true;
    this._tickCount++;
    if (this._tickCount % 50 === 0) {
      const motorBusy = this.motor.isBusy;
      const taskRunnerBusy = this.motor.taskRunner?.isRunning?.() || false;
      console.log(`[AyushiOS DIAG] tick=${this._tickCount} motorBusy=${motorBusy} taskRunnerBusy=${taskRunnerBusy} motorCtx=${this.motor.activeContext?.status || 'none'}`);
    }
    try {
      // 0. Begin cognitive trace for this cycle
      this.trace.beginTrace();

      // 1. Perceive
      const snapshot = this.senses.getSnapshot();
      // Null across respawn/death windows — sit this cycle out.
      if (!snapshot) return;
      this.trace.recordPerception(
        { environment: snapshot.environment, threats: snapshot.threats, social: snapshot.social },
        { threats: (snapshot.threats || []).length, players: (snapshot.social?.nearbyPlayers || []).length, health: snapshot.vitality?.health }
      );

      // P0-6: normalize through the canonical WorldModel. The normalized
      // view rides along as `snapshot.world` — consumers migrate gradually.
      snapshot.world = this.worldModel.update(snapshot);
      if ((this._tickCount % 100) === 0) {
        console.log(`[WorldModel] ${this.worldModel.describe()}`);
      }

      this._refreshBeliefsFromSenses(snapshot);
      this.beliefs.expire();
      this.knowledgeBridge?.sync(false);

      // 1b. Neural prediction — sense → predict → learn from outcomes.
      try { this._neuralStep(snapshot); } catch (e) {
        console.warn('[Ayushi OS] neural step failed:', e.message);
      }
      // Inject NN predictions into snapshot so executive can steer task selection.
      snapshot._nnPredictions = this._nnPredictions;
      // Inject current features for action memory context queries.
      snapshot._lastFeatures = this.sensorArray.lastFeatures;

      // 2. Feel
      this.personality.evaluateMood(snapshot);

      // 3. Busy → survival supervisor decides whether to preempt (P0-5).
      //    Policy lives in src/safety/SurvivalSupervisor.js; this is pure
      //    dispatch. Preempted objectives resume via MotorCortex's
      //    reflex-resume protocol or ExecutiveBrain bookkeeping.
      const taskRunnerBusy = this.motor.taskRunner && this.motor.taskRunner.isRunning();
      const motorBusy = this.motor.isBusy;
      const isBusy = taskRunnerBusy || motorBusy;

      if (isBusy) {
        // Don't interrupt survival-critical tasks (pre-grind, eat, retreat, defend)
        const SAFE_TASKS = ['eat', 'sleep', 'defend', 'flee', 'emergency_retreat', 'emergency_eat', 'emergency_survive', 'grind'];
        const currentTask = this.motor.taskRunner?.currentGoal || '';
        const isSurvivalTask = SAFE_TASKS.some(t => currentTask.includes(t));

        if (!isSurvivalTask) {
          const emerg = this.supervisor.assess(snapshot);
          if (!emerg) return;
          this.trace.recordInterrupted?.(emerg.reason, emerg.kind);
          this._requestEmergencyInterrupt(emerg.reason);

          // Cap consecutive retreats to prevent infinite loop
          this._consecutiveRetreats = (this._consecutiveRetreats || 0) + 1;
          if (this._consecutiveRetreats > 5) {
            console.log('[Ayushi OS] Too many consecutive retreats — eating + sprinting away');
            this._consecutiveRetreats = 0;
            // Pro player: if stuck in retreat loop, just eat and run far away
            const angle = Math.random() * 2 * Math.PI;
            const botPos = this.bot.entity.position;
            await this.motor.runGoal('emergency_survive', [
              { skill: 'eat', params: {} },
              { skill: 'sprint_to', params: { x: botPos.x + Math.cos(angle) * 50, y: botPos.y, z: botPos.z + Math.sin(angle) * 50 } },
              { skill: 'wait', params: { ms: 2000 } }
            ], { force: true });
          } else if (emerg.kind === 'retreat') {
            // Pro player retreat: eat first, then SPRINT AWAY from the threat
            // Don't just "go surface + wait" — actually flee to create distance
            const hasFood = snapshot?.vitality?.hasFood;

            // Find nearest hostile to determine flee direction
            const HOSTILE_NAMES = ['creeper','skeleton','spider','zombie','enderman','blaze','ghast','pillager','vindicator','witch','drowned','phantom','slime','magma_cube'];
            const hostiles = Object.values(this.bot?.entities || {})
                .filter(e => e?.isValid && e.position && HOSTILE_NAMES.some(h => (e.name || '').toLowerCase().includes(h)))
                .sort((a, b) => a.position.distanceTo(this.bot.entity.position) - b.position.distanceTo(this.bot.entity.position));
            const threat = hostiles[0];

            // Calculate flee position: opposite direction from threat, 30 blocks away
            const botPos = this.bot.entity.position;
            let fleeX = botPos.x, fleeZ = botPos.z;
            if (threat) {
                const dx = botPos.x - threat.position.x;
                const dz = botPos.z - threat.position.z;
                const len = Math.sqrt(dx * dx + dz * dz) || 1;
                fleeX = botPos.x + (dx / len) * 30;
                fleeZ = botPos.z + (dz / len) * 30;
            } else {
                // No visible threat — sprint in random direction
                const angle = Math.random() * 2 * Math.PI;
                fleeX = botPos.x + Math.cos(angle) * 30;
                fleeZ = botPos.z + Math.sin(angle) * 30;
            }

            const steps = [];
            if (hasFood) steps.push({ skill: 'eat', params: {} });
            steps.push({ skill: 'sprint_to', params: { x: fleeX, y: botPos.y, z: fleeZ } });
            steps.push({ skill: 'wait', params: { ms: 1500 } });
            await this.motor.runGoal('emergency_retreat', steps, { force: true });
          } else {
            await this.motor.runGoal('emergency_eat', [
              { skill: 'eat', params: { minFoodLevel: THRESHOLDS.foodComfortable } }
            ], { force: true });
          }

          // Reset consecutive count when health recovers
          if ((snapshot?.vitality?.health ?? 0) >= THRESHOLDS.healthLow) {
            this._consecutiveRetreats = 0;
          }
        }
        return;
      }

      // 4. Decide (weighted need arbitration + advisor suggestions)
      // Skip tasks currently in failure-backoff (unless nothing else is available)
      const decision = this.executive.decide(snapshot);
      let goal = decision;

      // 4a. Neural hooks — the network's risk predictions steer behavior.
      const nn = this._nnPredictions;
      if (nn) {
        // Hunger predicted to bite soon + we have food → suggest eating early
        if (nn.hungerRisk > 0.7 && snapshot.vitality?.hasFood && (snapshot.vitality?.food ?? 20) < 15) {
          this.proposeSuggestion({
            type: 'goal', goal: 'eat', priority: 0.7, source: 'neural',
            steps: [{ skill: 'eat', params: {} }],
            reason: `NN hungerRisk ${nn.hungerRisk.toFixed(2)}`,
          });
        }
        // High predicted danger → veto risky autonomy for one cycle
        // (self-limiting: at most once per 15s, safe goals never deferred)
        const SAFE_TASKS = ['eat', 'sleep', 'defend', 'flee', 'emergency_retreat'];
        if (nn.danger > 0.8 && !SAFE_TASKS.includes(goal?.task) &&
            Date.now() - this._nnLastDefer > NN_DEFER_THROTTLE_MS) {
          this._nnLastDefer = Date.now();
          console.log(`[Ayushi OS] 🧠 danger=${nn.danger.toFixed(2)} — deferring "${goal?.task}" one cycle`);
          this.trace.recordAction({ taskName: goal?.task }, 'nn_danger_defer');
          return;
        }
      }

      // Don't bother hunting/eating when already well fed
      const comfortableFood = Math.min(THRESHOLDS.foodComfortable ?? 18, 19);
      if (goal?.task === 'eat' && (snapshot.vitality?.food ?? 20) >= comfortableFood) {
        return; // nothing to do, avoid burning cycles hunting at full hunger
      }

      // Throttled backoff notice (once per task per 30s instead of every tick)
      if (goal?.task && this._taskCooldowns) {
        const cd = this._taskCooldowns.get(goal.task);
        if (cd && Date.now() < cd.until) {
          // All-goal-idle detection: if the picked goal is in backoff AND no
          // other useful need is pressing, explore instead of standing frozen.
          const now2 = Date.now();
          this._lastExploreAt ??= 0;
          const allInBackoff = ['eat', 'sleep', 'craft_gear', 'build_base', 'advance_capability']
            .every(t => { const c = this._taskCooldowns.get(t); return c && now2 < c.until; });
          if (allInBackoff && now2 - this._lastExploreAt > 45000) {
            this._lastExploreAt = now2;
            console.log('[Ayushi OS] All goals resting — exploring new terrain.');
            try {
              await this.motor.runGoal('explore_wander', [{ skill: 'explore', params: {} }], { force: true });
            } catch (e) {
              console.log(`[Ayushi OS] Explore failed: ${e.message}`);
            }
            return;
          }
          if (!this._backoffLogAt) this._backoffLogAt = new Map();
          const last = this._backoffLogAt.get(goal.task) || 0;
          if (Date.now() - last > 30000) {
            this._backoffLogAt.set(goal.task, Date.now());
            console.log(`[Ayushi OS] "${goal.task}" in backoff (${((cd.until - Date.now()) / 1000).toFixed(0)}s left) — idling`);
          }
          this.trace.recordAction({ taskName: goal.task, skipped: true }, 'skipped_backoff');
          return; // finally{} clears _ticking
        }
      }

      // 5. Speak, if the chosen goal is social
      if (goal.task === 'chat_greet') {
        this.bot.chat(this.personality.getDialogueTone());
      }

      // 6. Act (with TaskContext for resumability)
      this.trace.recordAction({ taskName: goal.task, steps: goal.steps }, 'started');
      // Capture features at action start for action-outcome memory
      try {
        this._lastActionFeatures = this.sensorArray.readFeatures(snapshot);
        this._lastActionName = goal.task;
      } catch (_) {}
      const actionStart = Date.now();
      await this.motor.runGoal(goal.task, goal.steps, {
        context: goal.context ? new TaskContext(goal.context.goal, goal.context) : undefined,
        priority: goal.context?.priority,
        assumptions: goal.context?.assumptions,
        blockers: goal.context?.blockers,
        metadata: goal.context?.metadata,
        resume: true,
      });
      this.trace.recordAction({ taskName: goal.task }, 'completed', Date.now() - actionStart);
    } finally {
      this._ticking = false;
    }
  }

  // ─── SOCIAL EVENTS SETUP ────────────────────────────────────

  _setupSocialEvents() {
    const bot = this.bot;

    // Greet nearby players periodically
    setInterval(() => {
      if (this.social?.canChat()) {
        this.social.greetNearbyPlayers();
      }
    }, 60000); // Check every minute

    // Respond to chat messages
    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      this.social?.respondToChat(username, message);
    });

    // Announce player join/leave
    bot.on('playerJoined', (player) => {
      if (player.username !== bot.username) {
        this.social?.onEvent('player_joined', { playerName: player.username });
      }
    });

    bot.on('playerLeft', (player) => {
      if (player.username !== bot.username) {
        this.social?.onEvent('player_left', { playerName: player.username });
      }
    });

    // React to death messages
    bot.on('death', () => {
      this.social?.onEvent('death', {});
    });

    // React to entity spawns (hostile warnings)
    bot.on('entitySpawn', (entity) => {
      if (entity.kind === 'Hostile mobs' || entity.name === 'creeper' ||
          entity.name === 'zombie' || entity.name === 'skeleton') {
        const dist = entity.position?.distanceTo(bot.entity?.position) || 999;
        if (dist < 16) {
          this.social?.onEvent('mob_nearby', { mobName: entity.name, distance: dist });
        }
      }
    });

    // React to health changes
    bot.on('health', () => {
      if (bot.health < 6) {
        this.social?.onEvent('low_health', { health: bot.health });
      }
    });

    // React to time of day
    bot.on('time', () => {
      const time = bot.time?.timeOfDay;
      if (time > 12541 && time < 12600) { // Just turned night
        this.social?.onEvent('nightfall', {});
      }
    });
  }
}

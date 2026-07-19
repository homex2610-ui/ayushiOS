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

    // --- Layer boot order: senses -> memory/beliefs -> personality -> executive -> motor -> language
    this.senses = new SensoryCortex(bot, this.bus);
    this.memory = new MemoryMatrix(bot.username, this.bus);
    this.beliefs = new BeliefState();
    this.knowledge = new Knowledge({ bot, beliefs: this.beliefs, memory: this.memory });
    this.trace = new DecisionTrace({ bus: this.bus, username: bot.username });
    this.personality = new PersonalityEngine(this.bus);
    this.tom = FEATURES.enableTheoryOfMind ? new TheoryOfMind(this.memory) : null;
    this.executive = new ExecutiveBrain(this.memory, this.personality, this.tom, this.bus, {
      knowledge: this.knowledge,
      trace: this.trace,
      getSuggestions: () => this.drainSuggestions(),
      getPlannerHints: (goal, state) => this.learning?.getPlannerHints(goal, state) || {},
    });
    this.motor = new MotorCortex(bot, taskRunner, this.bus);
    this.spinalCord = new SpinalCord(bot, this.bus, { masterName: 'updesh' });
    this.broca = new BrocaArea(bot, this);

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
        this.trace.markResumed(taskName);
        this.trace.recordResult(
          { taskName },
          { status: 'completed' }
        );
      }
    });

    this.bus.on('emergency_stop', () => {
      console.warn('[Ayushi OS] Emergency stop — cleaning up trace + stopping cognitive loop');
      this.trace.markInterrupted('emergency_stop');
      clearInterval(this._tickHandle);
    });
  }

  _startCognitiveLoop() {
    this._tickCount = 0;
    this._tickHandle = setInterval(() => this._tick(), THRESHOLDS.cognitiveTickMs);
    this._ticking = false;
  }

  stop() {
    clearInterval(this._tickHandle);
    this.knowledgeBridge?.stop();
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
      this.trace.recordPerception(
        { environment: snapshot.environment, threats: snapshot.threats, social: snapshot.social },
        { threats: (snapshot.threats || []).length, players: (snapshot.social?.nearbyPlayers || []).length, health: snapshot.vitality?.health }
      );

      this._refreshBeliefsFromSenses(snapshot);
      this.beliefs.expire();
      this.knowledgeBridge?.sync(false);

      // 2. Feel
      this.personality.evaluateMood(snapshot);

      // 3. Busy / emergency preempt (with minimum interval to avoid thrash)
      const taskRunnerBusy = this.motor.taskRunner && this.motor.taskRunner.isRunning();
      const motorBusy = this.motor.isBusy;
      const isBusy = taskRunnerBusy || motorBusy;

      if (isBusy) {
        const EMERGENCY_COOLDOWN = 10000;
        const now = Date.now();
        if (!this._lastEmergencyTime) this._lastEmergencyTime = 0;
        if (now - this._lastEmergencyTime < EMERGENCY_COOLDOWN) return;

        const creeperNear = (snapshot.threats || []).some(t =>
          (t.name || t.type || '').toLowerCase().includes('creeper')
        );
        if (snapshot.vitality.health < THRESHOLDS.healthCritical || creeperNear) {
          this._lastEmergencyTime = now;
          console.log('[Ayushi OS] Emergency interrupt — health/creeper!');
          this._requestEmergencyInterrupt('health_critical');
          await this.motor.runGoal('emergency_retreat', [
            { skill: 'go_surface', params: {} },
            { skill: 'wait', params: { ms: 2000 } }
          ], { force: true });
        } else if (snapshot.vitality.food < THRESHOLDS.foodCritical && snapshot.vitality.hasFood) {
          this._lastEmergencyTime = now;
          console.log('[Ayushi OS] Emergency interrupt — starving!');
          this._requestEmergencyInterrupt('food_critical');
          await this.motor.runGoal('emergency_eat', [
            { skill: 'eat', params: { minFoodLevel: THRESHOLDS.foodComfortable } }
          ], { force: true });
        }
        return;
      }

      // 4. Decide (weighted need arbitration + advisor suggestions)
      const decision = this.executive.decide(snapshot);
      const goal = decision;

      // 5. Speak, if the chosen goal is social
      if (goal.task === 'chat_greet') {
        this.bot.chat(this.personality.getDialogueTone());
      }

      // 6. Act (with TaskContext for resumability)
      this.trace.recordAction({ taskName: goal.task, steps: goal.steps }, 'started');
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
}

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
import { THRESHOLDS, FEATURES } from './config.js';

export class AyushiOS {
  /**
   * @param {import('mineflayer').Bot} bot
   * @param {{runTask: (steps: any[]) => Promise<void>}} taskRunner  your existing skill engine
   * @param {object} [opts]
   * @param {object} [opts.anthropicClient]  optional injected Anthropic client for LLM dialogue
   */
  constructor(bot, taskRunner, opts = {}) {
    this.bot = bot;
    this.bus = new EventBus();

    // --- Layer boot order: senses -> memory/instinct -> personality -> executive -> motor -> language
    this.senses = new SensoryCortex(bot, this.bus);
    this.memory = new MemoryMatrix(bot.username, this.bus);
    this.personality = new PersonalityEngine(this.bus);
    this.tom = FEATURES.enableTheoryOfMind ? new TheoryOfMind(this.memory) : null;
    this.executive = new ExecutiveBrain(this.memory, this.personality, this.tom, this.bus);
    this.motor = new MotorCortex(bot, taskRunner, this.bus);
    this.spinalCord = new SpinalCord(bot, this.bus); // wires itself to bus + bot events
    this.broca = new BrocaArea(this.bus, opts.anthropicClient ?? null);

    this._wireCrossModuleEffects();
    this._startCognitiveLoop();

    console.log(`[Ayushi OS] \u2705 All systems online. ${bot.username} is awake.`);
  }

  _wireCrossModuleEffects() {
    // Sleeping -> dream
    this.bus.on('sleep_started', () => this.memory.dreamAndConsolidate());

    // Understood speech -> reply (template by default, LLM if enabled) + relationship nudge
    this.bus.on('speech_understood', async ({ username, message, intent }) => {
      if (intent === 'thanks' || intent === 'command_follow') {
        this.memory.updatePlayerRelationship(username, +1, `helped/thanked: "${message}"`);
      }
      if (intent === 'insult') {
        this.memory.updatePlayerRelationship(username, -1, `insulted: "${message}"`);
      }
      this.tom?.observe(username, intent === 'insult' ? 'threatened' : 'neutral');

      const line = await this.broca.generateSpeech({
        username, message, intent, mood: this.personality.currentMood
      });
      if (line) this.bot.chat(line);
    });

    // Any reflex firing is itself a memorable event
    this.bus.on('reflex_fired', ({ reflexType }) => {
      this.memory.recordEvent(`Reflex triggered: ${reflexType}`, 2);
    });

    this.bus.on('mood_changed', ({ from, to }) => {
      this.memory.recordEvent(`Mood shifted ${from} -> ${to}`, 1);
    });
  }

  _startCognitiveLoop() {
    this._tickHandle = setInterval(() => this._tick(), THRESHOLDS.cognitiveTickMs);
  }

  stop() {
    clearInterval(this._tickHandle);
  }

  async _tick() {
    // 1. Perceive
    const snapshot = this.senses.getSnapshot();

    // 2. Feel (mood depends on what was just perceived)
    this.personality.evaluateMood(snapshot);

    // 3. If a conscious task is already running, only interrupt for real emergencies —
    //    reflexes already handle true emergencies instantly, so this is just a starvation guard.
    if (this.motor.isBusy) {
      if (snapshot.vitality.food < THRESHOLDS.foodCritical) {
        await this.motor.runGoal('emergency_eat', [
          { skill: 'eat', params: { minFoodLevel: THRESHOLDS.foodComfortable } }
        ]);
      }
      return;
    }

    // 4. Decide (weighted need arbitration)
    const goal = this.executive.decide(snapshot);

    // 5. Speak, if the chosen goal is social
    if (goal.task === 'chat_greet') {
      this.bot.chat(this.personality.getDialogueTone());
    }

    // 6. Act
    await this.motor.runGoal(goal.task, goal.steps);
  }
}

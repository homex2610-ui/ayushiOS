// MotorCortex.js
// ─────────────────────────────────────────────────────────────
// MOTOR CORTEX — turns decisions into movement.
// This is a thin, disciplined wrapper around YOUR existing
// TaskRunner (the JSON atomic-skill engine you already built).
// The brain never touches bot.* movement calls directly except
// for reflexes — everything conscious goes through here so
// busy-state and interrupts stay consistent.
// ─────────────────────────────────────────────────────────────

import { REFLEX_ACTIONS } from './SpinalCord.js';

export class MotorCortex {
  constructor(bot, taskRunner, bus) {
    this.bot = bot;
    this.taskRunner = taskRunner;
    this.bus = bus;
    this.isBusy = false;
    this.activeTaskName = null;

    bus.on('reflex_fired', ({ reflexType }) => this.handleReflex(reflexType));
  }

  async handleReflex(reflexType) {
    // Run the reflex action but don't clear isBusy — conscious task continues after reflex
    this.bot.pathfinder?.setGoal(null);
    const action = REFLEX_ACTIONS[reflexType];
    if (action) {
      try { await action(this.bot); }
      catch (e) { console.error(`[MotorCortex] Reflex action ${reflexType} failed:`, e); }
    }
  }

  async runGoal(taskName, steps) {
    if (this.isBusy) return; // Executive Brain already checks this, but stay defensive
    if (!steps || steps.length === 0) return; // some goals (like 'socialize') are speech-only

    this.isBusy = true;
    this.activeTaskName = taskName;
    this.bus.emit('task_started', { taskName, steps });
    console.log(`[Ayushi OS] \u{1F9E0} Executive Brain initiated task: ${taskName}`);

    try {
      await this.taskRunner.runTask(steps);
      this.bus.emit('task_completed', { taskName });
    } catch (e) {
      console.error(`[Ayushi OS] Task ${taskName} failed:`, e);
      this.bus.emit('task_failed', { taskName, error: String(e) });
    } finally {
      this.isBusy = false;
      this.activeTaskName = null;
    }
  }
}

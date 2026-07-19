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
import { TaskContext } from './TaskContext.js';

export class MotorCortex {
  constructor(bot, taskRunner, bus) {
    this.bot = bot;
    this.taskRunner = taskRunner;
    this.bus = bus;
    this.isBusy = false;
    this.activeTaskName = null;
    this.activeContext = null;

    bus.on('reflex_fired', ({ reflexType }) => this.handleReflex(reflexType));
    bus.on('emergency_stop', () => this.emergencyStop());
  }

  /** Hard-stop every ongoing action and clear internal state. */
  emergencyStop() {
    this.isBusy = false;
    this.activeTaskName = null;
    this.activeContext = null;
    try { this.taskRunner?.requestInterrupt?.(); } catch (_) {}
    this.bus.emit('task_failed', { taskName: 'emergency_stop', error: 'Kill switch triggered' });
  }

  async handleReflex(reflexType) {
    this.bot.pathfinder?.setGoal(null);
    const action = REFLEX_ACTIONS[reflexType];
    if (action) {
      try { await action(this.bot); }
      catch (e) { console.error(`[MotorCortex] Reflex action ${reflexType} failed:`, e); }
    }
  }

  /**
   * Set or update the active TaskContext for the current goal.
   * @param {TaskContext} ctx
   */
  setContext(ctx) {
    this.activeContext = ctx;
  }

  /**
   * Get the paused context for a goal if available.
   * @param {string} goalName
   * @returns {TaskContext|null}
   */
  getPausedContext(goalName) {
    if (!this.activeContext) return null;
    if (this.activeContext.goal === goalName && this.activeContext.status === 'paused') {
      return this.activeContext;
    }
    return null;
  }

  /**
   * Clear the active context (after completion, failure, or explicit cancel).
   */
  clearContext() {
    this.activeContext = null;
  }

  async runGoal(taskName, steps, opts = {}) {
    console.log(`[MotorCortex DIAG] runGoal called: task=${taskName} steps=${steps?.length} force=${!!opts.force} busy=${this.isBusy}`);
    if (this.isBusy && !opts.force) {
      console.log(`[MotorCortex DIAG] runGoal SKIPPED — busy and not forced`);
      return;
    }
    if (!steps || steps.length === 0) {
      console.log(`[MotorCortex DIAG] runGoal SKIPPED — no steps`);
      return;
    }

    if (opts.force && this.isBusy) {
      // Before forcing an interrupt, pause the current context so it can resume
      if (this.activeContext) {
        this.activeContext.pause();
      }
      this.taskRunner?.requestInterrupt?.();
      this.bot.interrupt_code = true;
      this.bot.pathfinder?.setGoal?.(null);
      await new Promise(r => setTimeout(r, 600));
    }

    // If we have a paused context for this goal, resume it instead of starting fresh
    const pausedCtx = this.getPausedContext(taskName);
    if (pausedCtx && opts.resume !== false) {
      const remaining = pausedCtx.remainingSteps();
      if (remaining.length > 0) {
        this.isBusy = true;
        this.activeTaskName = taskName;
        pausedCtx.start();
        this.bus.emit('task_resumed', { taskName, context: pausedCtx, remainingSteps: remaining });
        console.log(`[MotorCortex] Resuming paused task: ${taskName} (step ${pausedCtx.currentStepIndex + 1}/${pausedCtx.steps.length})`);
        try {
          this.bot.interrupt_code = false;
          const result = await this.taskRunner.runTask(remaining, { force: true });
          if (result && result.success === false) {
            pausedCtx.fail(result.reason || 'unknown');
            const event = result.reason === 'interrupted' ? 'task_interrupted' : 'task_failed';
            this.bus.emit(event, { taskName, error: result.reason || 'unknown', failedStep: result.failedStep });
            if (event !== 'task_interrupted') console.error(`[Ayushi OS] Task ${taskName} failed: ${result.reason || 'unknown'}`);
          } else {
            pausedCtx.complete();
            this.bus.emit('task_completed', { taskName });
          }
        } catch (e) {
          pausedCtx.fail(e);
          this.bus.emit('task_failed', { taskName, error: String(e) });
        } finally {
          this.isBusy = false;
          this.activeTaskName = null;
        }
        return;
      }
    }

    // Create or update context from opts
    if (opts.context) {
      this.activeContext = opts.context;
      this.activeContext.steps = steps;
      this.activeContext.currentStepIndex = 0;
      this.activeContext.start();
    } else if (!this.activeContext || this.activeContext.goal !== taskName) {
      this.activeContext = new TaskContext(taskName, {
        steps,
        priority: opts.priority ?? 0.5,
        assumptions: opts.assumptions || [],
        requiredResources: opts.requiredResources || [],
        blockers: opts.blockers || [],
        metadata: opts.metadata || {},
      });
      this.activeContext.start();
    } else {
      this.activeContext.steps = steps;
      this.activeContext.currentStepIndex = 0;
      this.activeContext.status = 'running';
      this.activeContext.lastActiveAt = Date.now();
    }

    this.isBusy = true;
    this.activeTaskName = taskName;
    this.bus.emit('task_started', { taskName, steps, context: this.activeContext });
    console.log(`[Ayushi OS] \u{1F9E0} Executive Brain initiated task: ${taskName}`);

    try {
      this.bot.interrupt_code = false;
      const result = await this.taskRunner.runTask(steps, { force: !!opts.force });
      if (result && result.success === false) {
        this.activeContext.fail(result.reason || 'unknown');
        const event = result.reason === 'interrupted' ? 'task_interrupted' : 'task_failed';
        this.bus.emit(event, { taskName, error: result.reason || 'unknown', failedStep: result.failedStep });
        if (event !== 'task_interrupted') console.error(`[Ayushi OS] Task ${taskName} failed: ${result.reason || 'unknown'}`);
      } else {
        this.activeContext.complete();
        this.bus.emit('task_completed', { taskName });
      }
    } catch (e) {
      this.activeContext.fail(e);
      console.error(`[Ayushi OS] Task ${taskName} failed:`, e);
      this.bus.emit('task_failed', { taskName, error: String(e) });
    } finally {
      this.isBusy = false;
      this.activeTaskName = null;
    }
  }
}

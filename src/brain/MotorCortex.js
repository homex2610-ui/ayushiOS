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
import { TaskManager, TaskStatus } from '../core/TaskManager.js';

export class MotorCortex {
  // Reflexes that justify pausing the current task. After they finish and
  // a short stabilization window, the interrupted objective RESUMES.
  static CRITICAL_REFLEXES = new Set([
    'FIRE_ESCAPE', 'VOID_FALL_PANIC', 'FALL_MLG', 'SURFACE_FOR_AIR',
    'CREEPER_FLEE', 'HOSTILE_CLOSE_QUARTERS', 'EMERGENCY_HEAL_AND_SHIELD',
  ]);

  constructor(bot, taskRunner, bus) {
    this.bot = bot;
    this.taskRunner = taskRunner;
    this.bus = bus;
    // P0-2: single task authority. isBusy/activeTaskName become DERIVED
    // reads over TaskManager state (kept as getters below for compat).
    this.taskManager = new TaskManager(bus);
    this.activeContext = null;
    this._activeHandle = null;
    this._legacyTaskName = null;   // display name of active goal
    this._reflexPreempting = false;
    this._busyPins = new Set();    // named claims that hold isBusy true without owning a task

    bus.on('reflex_preempt', ({ reflexType }) => this._preemptForReflex(reflexType));
    bus.on('reflex_fired', ({ reflexType }) => this.handleReflex(reflexType));
    bus.on('reflex_resolved', ({ reflexType }) => {
      // Two stabilization attempts: soon, and once more in case the
      // interrupted skill took a while to settle.
      setTimeout(() => this._resumeAfterReflex(reflexType), 2500);
      setTimeout(() => this._resumeAfterReflex(reflexType), 9000);
    });
    bus.on('emergency_stop', () => this.emergencyStop());
  }

  // ── P0-2 derived state: TaskManager is authoritative ──────
  get isBusy() { return this.taskManager.busy || this._busyPins.size > 0; }
  set isBusy(v) {
    // Legacy ad-hoc writes (disconnect cleanup, stale-busy watchdog) only
    // cancel manager-owned tasks. To hold busy WITHOUT a task — e.g. the
    // agent.js grind loop or pausing autonomy for a manual command — use
    // pinBusy(token)/unpinBusy(token); `= true` writes are no-ops here.
    if (!v && this.taskManager.busy) {
      const t = this.taskManager.activeTask;
      this.taskManager.cancel(t.id, 'external_busy_clear');
      this.taskManager.finalizeCancel(t.id, 'external_busy_clear');
    }
  }

  /**
   * Claim busy-ness by name while driving the bot outside runGoal
   * (auto-task grind loops, manual command pause). Idempotent per token.
   */
  pinBusy(token) {
    if (token) this._busyPins.add(token);
  }

  unpinBusy(token) {
    this._busyPins.delete(token);
  }

  releaseAllBusyPins(reason = 'released') {
    if (this._busyPins.size > 0) {
      console.log(`[MotorCortex] Releasing ${this._busyPins.size} busy pin(s): ${reason}`);
      this._busyPins.clear();
    }
  }
  get activeTaskName() { return this._legacyTaskName ?? this.taskManager.activeTask?.goal ?? null; }
  set activeTaskName(v) { this._legacyTaskName = v; }

  /** Resume a reflex-preempted objective once the motor is idle again. */
  _resumeAfterReflex() {
    this._reflexPreempting = false; // future preempts allowed regardless of outcome
    if (this.isBusy) return;
    const ctx = this.activeContext;
    if (!ctx || ctx.status !== 'paused') return;
    const remaining = ctx.remainingSteps?.() || [];
    if (remaining.length === 0) return;
    console.log(`[MotorCortex] ▶ Resuming "${ctx.goal}" after reflex (${remaining.length} steps left)`);
    this.runGoal(ctx.goal, remaining, { force: true }).catch(() => {});
  }

  /** Hard-stop every ongoing action and clear internal state. */
  emergencyStop() {
    // P0-2: route through the TaskManager — the only cancellation writer.
    const t = this.taskManager.activeTask;
    if (t) {
      this.taskManager.cancel(t.id, 'kill_switch');
      this.taskManager.finalizeCancel(t.id, 'kill_switch');
    }
    this._legacyTaskName = null;
    try { this.taskRunner?.requestInterrupt?.(); } catch (_) {}
    this.bot.interrupt_code = true;
    this.bus.emit('task_failed', { taskName: 'emergency_stop', error: 'Kill switch triggered' });
  }

  async handleReflex(reflexType) {
    // FIX: old version cleared the pathfinder goal for EVERY reflex —
    // SURFACE_FOR_AIR / CREEPER_FLEE would cancel whatever task was
    // navigating, producing endless "goal was changed" churn. Movement
    // reflexes now layer raw control states instead; only FIRE_ESCAPE
    // (inside its own handler) clears navigation.
    const action = REFLEX_ACTIONS[reflexType];
    if (action) {
      try { await action(this.bot); }
      catch (e) { console.error(`[MotorCortex] Reflex action ${reflexType} failed:`, e); }
      // Signal stabilization so listeners can resume preempted objectives.
      if (MotorCortex.CRITICAL_REFLEXES.has(reflexType)) {
        this.bus.emit('reflex_resolved', { reflexType, time: Date.now() });
      }
    }
  }

  /**
   * P0-1 preemption: a CRITICAL reflex arrives while a task is running →
   * pause its TaskContext, interrupt the runner, let the reflex execute,
   * then RESUME the original objective after a short stabilization window.
   */
  async _preemptForReflex(reflexType) {
    if (!MotorCortex.CRITICAL_REFLEXES.has(reflexType)) return;
    if (!this.isBusy || !this.activeContext || this._reflexPreempting) return;
    if (this.activeContext.status !== 'running') return;

    const preempted = this.activeTaskName;
    this._reflexPreempting = true;
    try {
      console.log(`[MotorCortex] ⚡ ${reflexType} preempting "${preempted}" — will resume after`);
      this.activeContext.pause();
      // P0-2: cancellation via manager; interrupt flag synced by the manager.
      this.taskManager.requestCancelActive(`reflex:${reflexType}`);
      this.taskManager.syncInterruptFlag(this.bot);
      this.taskRunner?.requestInterrupt?.();
      this.bus.emit('task_interrupted', { taskName: preempted, error: `reflex:${reflexType}` });
      // Give the running skill a moment to observe the interrupt flag.
      await new Promise(r => setTimeout(r, 700));
    } catch (e) {
      console.error('[MotorCortex] Preempt error:', e);
      this._reflexPreempting = false;
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
      // P0-2: cancellation goes through the TaskManager handle protocol.
      const prev = this.taskManager.activeTask;
      if (prev) {
        if (this.activeContext) this.activeContext.pause();
        this.taskManager.cancel(prev.id, `preempted_by:${taskName}`);
        this.taskManager.finalizeCancel(prev.id, `preempted_by:${taskName}`);
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
        // P0-2: register with the TaskManager as the running authority.
        const handle = this.taskManager.create({ goal: taskName, owner: 'motor:resume', steps: remaining, priority: opts.priority ?? 0.5 });
        this._activeHandle = handle;
        this.taskManager.transition(handle.id, TaskStatus.RUNNING);
        this.taskManager.syncInterruptFlag(this.bot);
        this._legacyTaskName = taskName;
        pausedCtx.start();
        this.bus.emit('task_resumed', { taskName, context: pausedCtx, remainingSteps: remaining });
        console.log(`[MotorCortex] Resuming paused task: ${taskName} (step ${pausedCtx.currentStepIndex + 1}/${pausedCtx.steps.length})`);
        try {
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
          // P0-2: terminal transition through the manager clears active state.
          if (this._activeHandle) {
            const cancelled = this._activeHandle.cancelled;
            this.taskManager.transition(this._activeHandle.id,
              cancelled ? TaskStatus.CANCELLED
                : (pausedCtx.status === 'failed' ? TaskStatus.FAILED : TaskStatus.COMPLETED));
            this.taskManager.syncInterruptFlag(this.bot);
            this._activeHandle = null;
          }
          if (!this.taskManager.busy) this._legacyTaskName = null;
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

    // P0-2: register as THE running task
    const handle = this.taskManager.create({ goal: taskName, owner: 'motor', steps, priority: opts.priority ?? 0.5 });
    this._activeHandle = handle;
    this.taskManager.transition(handle.id, TaskStatus.RUNNING);
    this.taskManager.syncInterruptFlag(this.bot);
    this._legacyTaskName = taskName;
    this.bus.emit('task_started', { taskName, steps, context: this.activeContext });
    console.log(`[Ayushi OS] \u{1F9E0} Executive Brain initiated task: ${taskName}`);

    try {
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
      // P0-2: terminal transition through the manager clears active state.
      if (this._activeHandle) {
        const cancelled = this._activeHandle.cancelled;
        this.taskManager.transition(this._activeHandle.id,
          cancelled ? TaskStatus.CANCELLED
            : (this.activeContext?.status === 'failed' ? TaskStatus.FAILED : TaskStatus.COMPLETED));
        this.taskManager.syncInterruptFlag(this.bot);
        this._activeHandle = null;
      }
      if (!this.taskManager.busy) this._legacyTaskName = null;
    }
  }
}

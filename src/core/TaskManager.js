// TaskManager.js — P0-2
// ─────────────────────────────────────────────────────────────
// THE single task authority. Replaces the ~15 scattered boolean flags
// (motor.isBusy ad-hoc writes, taskRunner._running, bot.interrupt_code
// free-for-all) with ONE owned state machine + handle-based cancellation.
//
// States: queued → planning → running → {paused ⇄ running} →
//         completed | failed | cancelled, plus blocked/recovering.
//
// OWNERSHIP RULES:
//  • Only the TaskManager mutates task.status and writes bot.interrupt_code.
//  • Everyone else requests transitions via handles/API. Booleans elsewhere
//    become DERIVED reads (getters), never authoritative writes.
//  • Every cancel carries a reason; every transition is emitted on the bus.
// ─────────────────────────────────────────────────────────────

export const TaskStatus = Object.freeze({
    QUEUED: 'queued',
    PLANNING: 'planning',
    RUNNING: 'running',
    PAUSED: 'paused',
    BLOCKED: 'blocked',
    RECOVERING: 'recovering',
    COMPLETED: 'completed',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

const TERMINAL = new Set([TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED]);

let _nextId = 1;

class TaskHandle {
    constructor(task, mgr) {
        this._task = task;
        this._mgr = mgr;
    }
    get id() { return this._task.id; }
    get status() { return this._task.status; }
    /** Request cancellation with a reason (async-safe, idempotent). */
    cancel(reason = 'cancelled') {
        return this._mgr.cancel(this._task.id, reason);
    }
    /** Derived convenience flag — NOT an independent authority. */
    get cancelled() { return this._task.status === TaskStatus.CANCELLED || !!this._task.cancelRequested; }
}

export class TaskManager {
    constructor(bus = null) {
        this.bus = bus;
        this.tasks = new Map();          // id -> task record
        this.activeId = null;            // the ONE currently-running task
        this._cancelRequested = false;   // derived interrupt signal for the active task
        this._cancelReason = null;
    }

    // ── Creation / lifecycle ───────────────────────────────────

    create({ goal, owner = 'unknown', steps = [], priority = 0.5, deadlineMs = null,
             maxAttempts = 3, attempt = 1, interruptible = true, resumable = true, meta = {} }) {
        const now = Date.now();
        const task = {
            id: `t${_nextId++}`,
            goal,
            owner,
            status: TaskStatus.QUEUED,
            createdAt: now,
            startedAt: null,
            deadline: deadlineMs ? now + deadlineMs : null,
            currentStep: 0,
            stepCount: Array.isArray(steps) ? steps.length : 0,
            attempt,
            maxAttempts,
            failureClass: null,
            recoveryPlan: null,
            interruptible,
            resumable,
            cancelRequested: false,
            cancelReason: null,
            meta,
        };
        this.tasks.set(task.id, task);
        this._emit('task_created', task);
        return new TaskHandle(task, this);
    }

    transition(id, toStatus, extra = {}) {
        const t = this.tasks.get(id);
        if (!t) return null;
        if (TERMINAL.has(t.status)) return t; // terminal states are final
        const from = t.status;
        t.status = toStatus;
        if (toStatus === TaskStatus.RUNNING && !t.startedAt) t.startedAt = Date.now();
        if (extra.failureClass !== undefined) t.failureClass = extra.failureClass;
        if (extra.recoveryPlan !== undefined) t.recoveryPlan = extra.recoveryPlan;
        if (extra.currentStep !== undefined) t.currentStep = extra.currentStep;
        if (toStatus === TaskStatus.RUNNING && this.activeId !== id) {
            // Enforce single-runner invariant
            if (this.activeId && this.activeId !== id) {
                const prev = this.tasks.get(this.activeId);
                if (prev && !TERMINAL.has(prev.status)) {
                    prev.status = TaskStatus.PAUSED;
                    this._emit('task_paused', prev);
                }
            }
            this.activeId = id;
        }
        if (TERMINAL.has(toStatus) && this.activeId === id) {
            this.activeId = null;
            this._cancelRequested = false;
            this._cancelReason = null;
        }
        this._emit(`task_${toStatus}`, t, from);
        return t;
    }

    // ── Cancellation protocol (the ONLY writer of interrupt signals) ──

    requestCancelActive(reason = 'interrupt') {
        if (!this.activeId) return false;
        return this.cancel(this.activeId, reason);
    }

    cancel(id, reason = 'cancelled') {
        const t = this.tasks.get(id);
        if (!t || TERMINAL.has(t.status)) return false;
        t.cancelRequested = true;
        t.cancelReason = reason;
        if (id === this.activeId) {
            this._cancelRequested = true;
            this._cancelReason = reason;
        }
        this._emit('task_cancel_requested', t);
        return true;
    }

    /** Terminal cancellation — called once execution has actually stopped. */
    finalizeCancel(id, reason) {
        const t = this.tasks.get(id);
        if (!t || TERMINAL.has(t.status)) return;
        t.status = TaskStatus.CANCELLED;
        t.cancelReason = reason ?? t.cancelReason;
        if (this.activeId === id) {
            this.activeId = null;
            this._cancelRequested = false;
            this._cancelReason = null;
        }
        this._emit('task_cancelled', t);
    }

    /**
     * DERIVED legacy signal. The mineflayer-wide `bot.interrupt_code` flag is
     * written HERE and nowhere else. Callers poll this each tick/skill loop.
     */
    syncInterruptFlag(bot) {
        try {
            const want = this._cancelRequested;
            if (bot.interrupt_code !== want) bot.interrupt_code = want;
        } catch (_) {}
        return this._cancelRequested;
    }

    consumeCancellation() {
        const r = this._cancelRequested ? this._cancelReason : null;
        this._cancelRequested = false;
        this._cancelReason = null;
        return r;
    }

    // ── Derived queries (replace scattered booleans) ──────────

    get busy() { return !!this.activeId; }
    get activeTask() { return this.tasks.get(this.activeId) || null; }
    get cancelRequested() { return this._cancelRequested; }

    snapshot() {
        return [...this.tasks.values()].slice(-25).map(t => ({
            id: t.id, goal: t.goal, owner: t.owner, status: t.status,
            currentStep: t.currentStep, stepCount: t.stepCount,
            attempt: t.attempt, maxAttempts: t.maxAttempts,
            failureClass: t.failureClass, startedAt: t.startedAt,
        }));
    }

    _emit(event, task, from = null) {
        try {
            this.bus?.emit(event, {
                taskId: task.id, goal: task.goal, owner: task.owner,
                status: task.status, from, reason: task.cancelReason,
                failureClass: task.failureClass, time: Date.now(),
            });
        } catch (_) {}
    }
}

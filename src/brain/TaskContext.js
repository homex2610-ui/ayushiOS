// TaskContext.js
// ─────────────────────────────────────────────────────────────
// Explicit task state for hierarchical planning support.
// Every active task carries context: assumptions, blockers,
// progress, resource requirements, and resumption state.
// This makes interruptions (eat, flee, help player) resumable
// without reconstructing state from memory.
// ─────────────────────────────────────────────────────────────

export class TaskContext {
  constructor(goal, opts = {}) {
    this.id = opts.id || `${goal}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.goal = goal;
    this.parentTask = opts.parentTask || null;
    this.priority = opts.priority ?? 0.5;
    this.assumptions = opts.assumptions || [];
    this.requiredResources = opts.requiredResources || [];
    this.blockers = opts.blockers || [];
    this.progress = opts.progress ?? 0;
    this.resumable = opts.resumable ?? true;
    this.steps = opts.steps || [];
    this.currentStepIndex = opts.currentStepIndex ?? 0;
    this.startedAt = Date.now();
    this.lastActiveAt = Date.now();
    this.status = opts.status || 'pending';
    this.metadata = opts.metadata || {};
    this.result = null;
  }

  start() {
    this.status = 'running';
    this.lastActiveAt = Date.now();
  }

  pause() {
    this.status = 'paused';
    this.lastActiveAt = Date.now();
  }

  complete(result) {
    this.status = 'completed';
    this.progress = 1;
    this.result = result || null;
    this.lastActiveAt = Date.now();
  }

  fail(error) {
    this.status = 'failed';
    this.result = { error: String(error) };
    this.lastActiveAt = Date.now();
  }

  isExpired(timeoutMs = 300000) {
    if (this.status === 'completed' || this.status === 'failed') return true;
    return Date.now() - this.lastActiveAt > timeoutMs;
  }

  advanceStep() {
    this.currentStepIndex++;
    this.progress = this.steps.length > 0
      ? Math.min(1, this.currentStepIndex / this.steps.length)
      : 0;
    this.lastActiveAt = Date.now();
  }

  remainingSteps() {
    return this.steps.slice(this.currentStepIndex);
  }

  toJSON() {
    return {
      id: this.id,
      goal: this.goal,
      parentTask: this.parentTask,
      priority: this.priority,
      assumptions: this.assumptions,
      requiredResources: this.requiredResources,
      blockers: this.blockers,
      progress: this.progress,
      resumable: this.resumable,
      steps: this.steps,
      currentStepIndex: this.currentStepIndex,
      startedAt: this.startedAt,
      lastActiveAt: this.lastActiveAt,
      status: this.status,
      metadata: this.metadata,
      result: this.result,
    };
  }
}

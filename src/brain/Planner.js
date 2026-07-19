// Planner.js
// ─────────────────────────────────────────────────────────────
// Generic planner interface.
// All planners implement plan(), resume(), replan(), validate().
// ExecutiveBrain calls through this interface — swapping
// implementations does not require changes to the brain.
// ─────────────────────────────────────────────────────────────

export class TaskNode {
  constructor(id, operator, opts = {}) {
    this.id = id;
    this.operator = operator;
    this.parent = opts.parent || null;
    this.children = opts.children || [];
    this.status = opts.status || 'pending';
    this.preconditions = opts.preconditions || [];
    this.effects = opts.effects || [];
    this.priority = opts.priority ?? 0.5;
    this.params = opts.params || {};
    this.failureReason = null;
    this.depth = opts.depth ?? 0;
  }

  isPrimitive() {
    return this.children.length === 0;
  }

  isCompound() {
    return this.children.length > 0;
  }

  toJSON() {
    return {
      id: this.id,
      operator: this.operator,
      status: this.status,
      preconditions: this.preconditions,
      effects: this.effects,
      priority: this.priority,
      params: this.params,
      failureReason: this.failureReason,
      depth: this.depth,
      children: this.children.map(c => c.toJSON()),
    };
  }
}

export class Planner {
  /**
   * Generate a plan for a goal given the current world state.
   * @param {string} goal — goal name (e.g. 'craft_gear')
   * @param {object} state — current world state snapshot
   * @param {object} context — TaskContext for resumption
   * @returns {{ steps: TaskNode[], context: object }}
   */
  plan(goal, state, context) {
    throw new Error('Planner.plan() must be implemented by subclass');
  }

  /**
   * Resume a paused task from its context.
   * @param {object} context — paused TaskContext
   * @param {object} state — current world state
   * @returns {{ steps: TaskNode[], context: object }}
   */
  resume(context, state) {
    throw new Error('Planner.resume() must be implemented by subclass');
  }

  /**
   * Replan after a failure.
   * @param {object} failedStep — the TaskNode that failed
   * @param {string} reason — classification of failure
   * @param {object} state — current world state
   * @param {object} context — current TaskContext
   * @returns {{ steps: TaskNode[], context: object }}
   */
  replan(failedStep, reason, state, context) {
    throw new Error('Planner.replan() must be implemented by subclass');
  }

  /**
   * Validate a plan against the current state.
   * @param {TaskNode[]} steps
   * @param {object} state
   * @returns {{ valid: boolean, issues: string[] }}
   */
  validate(steps, state) {
    return { valid: true, issues: [] };
  }
}

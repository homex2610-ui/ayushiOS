// Experience.js
// Every completed task produces one Experience.
// Learning consumes Experiences — never raw execution state.
// Version metadata enables comparison across codebase revisions.
// Version constants are maintained centrally in Version.js — never hardcode here.

import { VERSIONS } from './Version.js';

let _idCounter = 0;

const DEFAULT_VERSION = { ...VERSIONS };

export class Experience {
  constructor(opts = {}) {
    _idCounter++;
    this.id = opts.id || `exp_${Date.now()}_${_idCounter}`;
    this.serverId = opts.serverId || null;
    this.serverType = opts.serverType || 'unknown';
    this.timestamp = opts.timestamp || Date.now();
    this.goal = opts.goal || null;
    this.taskGraph = opts.taskGraph || [];
    this.contextSnapshot = opts.contextSnapshot || {};
    this.beliefsSnapshot = opts.beliefsSnapshot || {};
    this.actions = opts.actions || [];
    this.interruptions = opts.interruptions || [];
    this.result = opts.result || 'unknown';
    this.reward = opts.reward ?? 0;
    this.duration = opts.duration ?? 0;
    this.failureReason = opts.failureReason || null;
    this.confidence = opts.confidence ?? 1.0;
    this.lessonsLearned = opts.lessonsLearned || [];
    this.version = opts.version || { ...DEFAULT_VERSION };
  }

  isSuccess() {
    return this.result === 'completed';
  }

  isFailure() {
    return this.result === 'failed';
  }

  wasInterrupted() {
    return this.interruptions.length > 0 || this.result === 'interrupted';
  }

  effectiveDuration() {
    if (this.duration > 0) return this.duration;
    if (this.actions.length > 0) {
      return this.actions.reduce((sum, a) => sum + (a.duration || 0), 0);
    }
    return 0;
  }

  primaryAction() {
    if (this.actions.length === 0) return null;
    return this.actions.reduce((a, b) => ((a.duration || 0) > (b.duration || 0) ? a : b));
  }

  toJSON() {
    return {
      id: this.id,
      serverId: this.serverId,
      serverType: this.serverType,
      timestamp: this.timestamp,
      goal: this.goal,
      taskGraph: this.taskGraph,
      contextSnapshot: this.contextSnapshot,
      beliefsSnapshot: {
        health: this.beliefsSnapshot.health,
        food: this.beliefsSnapshot.food,
        threats: (this.beliefsSnapshot.threats || []).length,
      },
      actions: this.actions.map(a => ({
        skill: a.skill,
        params: a.params,
        duration: a.duration,
        status: a.status,
      })),
      interruptions: this.interruptions,
      result: this.result,
      reward: this.reward,
      duration: this.duration,
      failureReason: this.failureReason,
      confidence: this.confidence,
      lessonsLearned: this.lessonsLearned,
      version: this.version,
    };
  }
}

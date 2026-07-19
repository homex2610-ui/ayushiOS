// DecisionTrace.js
// ─────────────────────────────────────────────────────────────
// Cognitive trace — full audit trail of the decision pipeline.
//
// Stages:
//   Perception   →   Belief Update   →   Planning   →
//   Task Selection   →   Action   →   Result   →   Learning
//
// Each stage records: timestamp, inputs, outputs, reasoning, duration.
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';

const DEFAULT_CAPACITY = 50;

export class DecisionTrace {
  /**
   * @param {{ capacity?: number, bus?: { emit: Function }, username?: string }} [opts]
   */
  constructor(opts = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.bus = opts.bus || null;
    this._entries = [];
    this._current = null;
    this._trace = null;
    this.filePath = opts.username ? path.join(process.cwd(), 'bots', opts.username, 'decision_trace.log') : null;
  }

  _writeToLog(text) {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, text + '\n', 'utf-8');
    } catch (err) {
      console.warn('[DecisionTrace] Failed to write log:', err.message);
    }
  }

  // ─── Cognitive trace stages ─────────────────────────────────

  /**
   * Begin a new cognitive trace for the current tick cycle.
   * Returns the trace object for in-place mutation.
   */
  beginTrace() {
    this._trace = {
      perception: null,
      beliefUpdate: null,
      planning: null,
      taskSelection: null,
      action: null,
      result: null,
      learning: null,
    };
    return this._trace;
  }

  /**
   * Record the perception stage.
   * @param {{ threats?: Array, vitality?: object, environment?: object, social?: object }} inputs
   * @param {object} output — the perceived snapshot summary
   */
  recordPerception(inputs = {}, output = {}) {
    if (!this._trace) this.beginTrace();
    this._trace.perception = {
      timestamp: Date.now(),
      inputs: this._summarize(inputs),
      output: this._summarize(output),
    };
  }

  /**
   * Record the belief update stage.
   * @param {{ beliefs?: object, snapshot?: object }} inputs
   * @param {object} output — enriched beliefs
   * @param {string} [reasoning]
   */
  recordBeliefUpdate(inputs = {}, output = {}, reasoning = '') {
    if (!this._trace) this.beginTrace();
    this._trace.beliefUpdate = {
      timestamp: Date.now(),
      inputs: this._summarize(inputs),
      output: this._summarize(output),
      reasoning,
    };
  }

  /**
   * Record the planning stage (need scoring, advisor boost, mood veto).
   * @param {{ needs?: Array, suggestions?: Array, personality?: object }} inputs
   * @param {object} output — { scored: Array, selected: string, vetoed: string|null }
   * @param {string} [reasoning]
   * @param {number} [durationMs]
   */
  recordPlanning(inputs = {}, output = {}, reasoning = '', durationMs = 0) {
    if (!this._trace) this.beginTrace();
    this._trace.planning = {
      timestamp: Date.now(),
      inputs: this._summarize(inputs),
      output: this._summarize(output),
      reasoning,
      durationMs,
    };
  }

  /**
   * Record the task selection stage.
   * @param {{ goal: object, planState: object }} inputs
   * @param {object} output — { task: string, steps: Array }
   */
  recordTaskSelection(inputs = {}, output = {}) {
    if (!this._trace) this.beginTrace();
    this._trace.taskSelection = {
      timestamp: Date.now(),
      inputs: this._summarize(inputs),
      output: this._summarize(output),
    };
  }

  /**
   * Record the action execution stage.
   * @param {{ taskName: string, steps: Array }} inputs
   * @param {string} output — 'started' | 'completed' | 'failed'
   * @param {number} [durationMs]
   */
  recordAction(inputs = {}, output = '', durationMs = 0) {
    if (!this._trace) this.beginTrace();
    this._trace.action = {
      timestamp: Date.now(),
      inputs: this._summarize(inputs),
      output,
      durationMs,
    };
  }

  /**
   * Record the result stage.
   * @param {{ taskName: string }} inputs
   * @param {object} output — { status: string, error?: string }
   */
  recordResult(inputs = {}, output = {}) {
    if (!this._trace) this.beginTrace();
    this._trace.result = {
      timestamp: Date.now(),
      inputs: this._summarize(inputs),
      output: this._summarize(output),
    };
  }

  /**
   * Record the learning stage.
   * @param {{ taskName?: string, outcome?: string }} inputs
   * @param {object} output — { adjustment?: object, episodes?: Array }
   * @param {string} [reasoning]
   */
  recordLearning(inputs = {}, output = {}, reasoning = '') {
    if (!this._trace) this.beginTrace();
    this._trace.learning = {
      timestamp: Date.now(),
      inputs: this._summarize(inputs),
      output: this._summarize(output),
      reasoning,
    };
  }

  // ─── Compatibility: original record() builds a full entry ───

  /**
   * Record a complete decision entry.
   * Preserves the original interface while extending with trace data.
   * Returns the entry (also kept as current).
   */
  record(partial = {}) {
    const entry = {
      time: Date.now(),
      goal: partial.goal || null,
      reason: partial.reason || null,
      knowledgeUsed: partial.knowledgeUsed || {},
      chosenTask: partial.chosenTask || partial.goal || null,
      steps: partial.steps || [],
      suggestionsConsidered: partial.suggestionsConsidered || [],
      interrupted: null,
      resumed: null,
      need: partial.need || null,
      score: partial.score ?? null,
      trace: this._trace ? { ...this._trace } : null,
    };
    this._entries.push(entry);
    if (this._entries.length > this.capacity) {
      this._entries.shift();
    }
    this._current = entry;
    this._trace = null; // reset for next cycle
    this.bus?.emit('decision_traced', entry);

    this._writeLogBlock(entry);

    return entry;
  }

  _summarize(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) {
      return obj.length > 5 ? `[${obj.length} items]` : obj;
    }
    const keys = Object.keys(obj);
    if (keys.length > 8) {
      const summary = {};
      for (const k of keys.slice(0, 8)) summary[k] = obj[k];
      summary['...'] = `+${keys.length - 8} more fields`;
      return summary;
    }
    const out = {};
    for (const k of keys) {
      const v = obj[k];
      if (Array.isArray(v)) {
        out[k] = v.length > 5 ? `[${v.length} items]` : v;
      } else if (v && typeof v === 'object' && v.constructor === Object) {
        const subKeys = Object.keys(v);
        if (subKeys.length > 6) {
          out[k] = `{${subKeys.slice(0, 6).join(', ')}, ...}`;
        } else {
          out[k] = v;
        }
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  _writeLogBlock(entry) {
    if (!this.filePath) return;
    const dateStr = new Date(entry.time).toISOString();
    const lines = [
      '============================================================',
      `TRACE AT: ${dateStr}`,
      `Goal: ${entry.goal} | Need: ${entry.need} (${entry.score !== null ? entry.score.toFixed(2) : 'N/A'})`,
      `Reason: ${entry.reason || 'N/A'}`,
    ];

    // Cognitive trace stages
    if (entry.trace) {
      const t = entry.trace;

      if (t.perception) {
        lines.push('');
        lines.push('─── Perception ───');
        lines.push(`  Inputs: ${JSON.stringify(t.perception.inputs)}`);
        lines.push(`  Output: ${JSON.stringify(t.perception.output)}`);
      }

      if (t.beliefUpdate) {
        lines.push('');
        lines.push('─── Belief Update ───');
        lines.push(`  Inputs: ${JSON.stringify(t.beliefUpdate.inputs)}`);
        lines.push(`  Output: ${JSON.stringify(t.beliefUpdate.output)}`);
        if (t.beliefUpdate.reasoning) lines.push(`  Reasoning: ${t.beliefUpdate.reasoning}`);
      }

      if (t.planning) {
        lines.push('');
        lines.push('─── Planning ───');
        lines.push(`  Inputs: ${JSON.stringify(t.planning.inputs)}`);
        lines.push(`  Output: ${JSON.stringify(t.planning.output)}`);
        if (t.planning.reasoning) lines.push(`  Reasoning: ${t.planning.reasoning}`);
        if (t.planning.durationMs) lines.push(`  Duration: ${t.planning.durationMs}ms`);
      }

      if (t.taskSelection) {
        lines.push('');
        lines.push('─── Task Selection ───');
        lines.push(`  Inputs: ${JSON.stringify(t.taskSelection.inputs)}`);
        lines.push(`  Output: ${JSON.stringify(t.taskSelection.output)}`);
      }

      if (t.action) {
        lines.push('');
        lines.push('─── Action ───');
        lines.push(`  Inputs: ${JSON.stringify(t.action.inputs)}`);
        lines.push(`  Output: ${t.action.output}`);
        if (t.action.durationMs) lines.push(`  Duration: ${t.action.durationMs}ms`);
      }

      if (t.result) {
        lines.push('');
        lines.push('─── Result ───');
        lines.push(`  Inputs: ${JSON.stringify(t.result.inputs)}`);
        lines.push(`  Output: ${JSON.stringify(t.result.output)}`);
      }

      if (t.learning) {
        lines.push('');
        lines.push('─── Learning ───');
        lines.push(`  Inputs: ${JSON.stringify(t.learning.inputs)}`);
        lines.push(`  Output: ${JSON.stringify(t.learning.output)}`);
        if (t.learning.reasoning) lines.push(`  Reasoning: ${t.learning.reasoning}`);
      }
    }

    // Original summary fields
    lines.push('');
    lines.push('Knowledge used:');
    const knowledgeStr = Object.entries(entry.knowledgeUsed)
      .map(([k, v]) => `  - ${k}: ${v}`)
      .join('\n');
    lines.push(knowledgeStr || '  - none');
    lines.push(`Chosen task: ${entry.chosenTask}`);
    lines.push('Steps:');
    const stepsStr = (entry.steps || [])
      .map((s, idx) => `  ${idx + 1}. ${s.skill}(${JSON.stringify(s.params || {})})`)
      .join('\n');
    lines.push(stepsStr || '  - none');
    lines.push('Suggestions considered:');
    const suggestionsStr = (entry.suggestionsConsidered || [])
      .map(s => `  - ${s.type || s.goal || 'unknown'} (pri: ${s.priority}) from ${s.source || 'advisor'}`)
      .join('\n');
    lines.push(suggestionsStr || '  - none');
    lines.push('============================================================');

    this._writeToLog(lines.join('\n'));
  }

  markInterrupted(reason) {
    if (!this._current) return null;
    this._current.interrupted = { reason: reason || 'unknown', time: Date.now() };
    this.bus?.emit('decision_interrupted', this._current);

    const dateStr = new Date(this._current.interrupted.time).toISOString();
    const logLine = `>>> INTERRUPTED AT: ${dateStr} | Goal: ${this._current.goal} | Trigger: ${reason || 'unknown'}`;
    this._writeToLog(logLine);

    return this._current;
  }

  markResumed(goal = null) {
    if (!this._current) return null;
    this._current.resumed = {
      goal: goal || this._current.goal,
      time: Date.now(),
    };
    this.bus?.emit('decision_resumed', this._current);

    const dateStr = new Date(this._current.resumed.time).toISOString();
    const logLine = `<<< RESUMED/COMPLETED AT: ${dateStr} | Goal: ${this._current.goal} | Task: ${goal || this._current.goal}`;
    this._writeToLog(logLine);

    return this._current;
  }

  latest() {
    return this._current;
  }

  recent(n = 10) {
    return this._entries.slice(-Math.max(1, n));
  }

  clear() {
    this._entries = [];
    this._current = null;
    this._trace = null;
  }
}

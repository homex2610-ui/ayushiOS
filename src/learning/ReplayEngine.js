// ReplayEngine.js
// Offline analysis of recorded Experiences.
// Immutable — never modifies input data.
// Input: path to an ExperienceStore JSON file.
// Output: structured report with per-goal + global summaries.
//
// ReplayEngine v1 scope:
//   - Load existing experiences (consumes stored reward values)
//   - Group by goal
//   - Report runs, success/failure, avg duration, avg reward,
//     common failures, planner info
//   - Basic filtering (serverType, result, goalPrefix)
//   - No reward recomputation, no planner re-execution

import { readFileSync, existsSync } from 'fs';
import { Experience } from './Experience.js';

export class ReplayEngine {
  constructor(fp) {
    this.fp = fp;
    this._experiences = [];
  }

  load() {
    if (!existsSync(this.fp)) {
      throw new Error(`ReplayEngine: file not found — ${this.fp}`);
    }
    const raw = JSON.parse(readFileSync(this.fp, 'utf8'));
    this._experiences = (raw || []).map(e => new Experience(e));
    return this;
  }

  filter(opts = {}) {
    let filtered = this._experiences;
    if (opts.serverType) {
      filtered = filtered.filter(e => e.serverType === opts.serverType);
    }
    if (opts.result) {
      filtered = filtered.filter(e => e.result === opts.result);
    }
    if (opts.goalPrefix) {
      filtered = filtered.filter(e => e.goal && e.goal.startsWith(opts.goalPrefix));
    }
    return filtered;
  }

  goalReport(experiences) {
    const groups = new Map();
    for (const exp of experiences) {
      const goal = exp.goal || 'ungrouped';
      if (!groups.has(goal)) groups.set(goal, []);
      groups.get(goal).push(exp);
    }

    const goalSummaries = [];
    for (const [goal, exps] of groups) {
      const total = exps.length;
      const successes = exps.filter(e => e.isSuccess()).length;
      const failures = exps.filter(e => e.isFailure()).length;
      const interrupted = exps.filter(e => e.wasInterrupted()).length;
      const successRate = total > 0 ? ((successes / total) * 100).toFixed(1) : '0.0';
      const avgDuration = total > 0 ? (exps.reduce((s, e) => s + e.effectiveDuration(), 0) / total) : 0;
      const avgReward = total > 0 ? (exps.reduce((s, e) => s + (e.reward || 0), 0) / total) : 0;

      const failureCounts = new Map();
      for (const exp of exps) {
        if (exp.failureReason) {
          failureCounts.set(exp.failureReason, (failureCounts.get(exp.failureReason) || 0) + 1);
        }
      }
      const commonFailures = [...failureCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([reason, count]) => ({ reason, count }));

      const plannerHintCount = exps.filter(e =>
        e.contextSnapshot && e.contextSnapshot.assumptions &&
        Array.isArray(e.contextSnapshot.assumptions) &&
        e.contextSnapshot.assumptions.some(a => typeof a === 'string' && a.startsWith('hint:'))
      ).length;

      goalSummaries.push({
        goal,
        runs: total,
        successes,
        failures,
        interrupted,
        successRate: parseFloat(successRate),
        avgDuration: Math.round(avgDuration),
        avgReward: Math.round(avgReward * 10) / 10,
        commonFailures,
        plannerHintRuns: plannerHintCount,
      });
    }

    goalSummaries.sort((a, b) => b.runs - a.runs);
    return goalSummaries;
  }

  globalSummary(experiences) {
    const total = experiences.length;
    const completed = experiences.filter(e => e.isSuccess()).length;
    const failed = experiences.filter(e => e.isFailure()).length;
    const interrupted = experiences.filter(e => e.wasInterrupted()).length;
    const totalReward = experiences.reduce((s, e) => s + (e.reward || 0), 0);
    const avgReward = total > 0 ? totalReward / total : 0;
    const totalDuration = experiences.reduce((s, e) => s + e.effectiveDuration(), 0);
    const avgDuration = total > 0 ? totalDuration / total : 0;

    const failureCounts = new Map();
    for (const exp of experiences) {
      if (exp.failureReason) {
        failureCounts.set(exp.failureReason, (failureCounts.get(exp.failureReason) || 0) + 1);
      }
    }
    const topFailures = [...failureCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count }));

    const byGoal = this.goalReport(experiences);
    const bestGoal = byGoal.length > 0 ? byGoal.reduce((a, b) => a.successRate > b.successRate ? a : b) : null;
    const worstGoal = byGoal.length > 0 ? byGoal.reduce((a, b) => a.successRate < b.successRate ? a : b) : null;
    const mostInterrupted = byGoal.length > 0 ? byGoal.reduce((a, b) => a.interrupted > b.interrupted ? a : b) : null;
    const mostCommon = byGoal.length > 0 ? byGoal.reduce((a, b) => a.runs > b.runs ? a : b) : null;

    return {
      total,
      completed,
      failed,
      interrupted,
      completionRate: total > 0 ? ((completed / total) * 100).toFixed(1) : '0.0',
      totalReward: Math.round(totalReward),
      avgReward: Math.round(avgReward * 10) / 10,
      avgDuration: Math.round(avgDuration),
      topFailures,
      bestGoal: bestGoal ? { goal: bestGoal.goal, successRate: bestGoal.successRate } : null,
      worstGoal: worstGoal ? { goal: worstGoal.goal, successRate: worstGoal.successRate } : null,
      mostInterruptedGoal: mostInterrupted ? { goal: mostInterrupted.goal, interrupted: mostInterrupted.interrupted } : null,
      mostCommonGoal: mostCommon ? { goal: mostCommon.goal, runs: mostCommon.runs } : null,
    };
  }

  report(experiences, metadata = {}) {
    const byGoal = this.goalReport(experiences);
    const global = this.globalSummary(experiences);

    let out = '';
    out += '='.repeat(60) + '\n';
    out += '  ReplayEngine v1 — Experience Analysis Report\n';
    out += '='.repeat(60) + '\n\n';

    if (metadata.sessionId) out += `Session ID:    ${metadata.sessionId}\n`;
    if (metadata.server) out += `Server:        ${metadata.server}\n`;
    if (metadata.mcVersion) out += `MC Version:    ${metadata.mcVersion}\n`;
    if (metadata.botVersion) out += `Bot Version:   ${metadata.botVersion}\n`;
    if (metadata.plannerVersion) out += `Planner:       ${metadata.plannerVersion}\n`;
    if (metadata.rewardModel) out += `Reward Model:  ${metadata.rewardModel}\n`;
    if (metadata.duration) out += `Run Duration:  ${metadata.duration}\n`;
    out += `File:          ${this.fp}\n`;
    out += `Reported:      ${new Date().toISOString()}\n\n`;
    out += `Total experiences: ${global.total}\n\n`;

    out += '─'.repeat(40) + '\n';
    out += '  Global Summary\n';
    out += '─'.repeat(40) + '\n\n';
    out += `  Completed:      ${global.completed}\n`;
    out += `  Failed:         ${global.failed}\n`;
    out += `  Interrupted:    ${global.interrupted}\n`;
    out += `  Completion:     ${global.completionRate}%\n`;
    out += `  Total reward:   ${global.totalReward}\n`;
    out += `  Avg reward:     ${global.avgReward}\n`;
    out += `  Avg duration:   ${global.avgDuration}s\n\n`;

    if (global.topFailures.length > 0) {
      out += '  Top failures:\n';
      for (const f of global.topFailures) {
        out += `    ${f.reason} (${f.count}x)\n`;
      }
      out += '\n';
    }

    if (global.bestGoal) out += `  Most successful:  ${global.bestGoal.goal} (${global.bestGoal.successRate}%)\n`;
    if (global.worstGoal) out += `  Least successful: ${global.worstGoal.goal} (${global.worstGoal.successRate}%)\n`;
    if (global.mostInterruptedGoal) out += `  Most interrupted: ${global.mostInterruptedGoal.goal} (${global.mostInterruptedGoal.interrupted}x)\n`;
    if (global.mostCommonGoal) out += `  Most attempted:   ${global.mostCommonGoal.goal} (${global.mostCommonGoal.runs}x)\n`;

    out += '\n';
    out += '─'.repeat(40) + '\n';
    out += '  Per-Goal Summary\n';
    out += '─'.repeat(40) + '\n\n';

    for (const g of byGoal) {
      out += `  ${g.goal}\n`;
      out += `    Runs:          ${g.runs}\n`;
      out += `    Success:       ${g.successes}\n`;
      out += `    Failure:       ${g.failures}\n`;
      out += `    Interrupted:   ${g.interrupted}\n`;
      out += `    Success rate:  ${g.successRate}%\n`;
      out += `    Avg duration:  ${g.avgDuration}s\n`;
      out += `    Avg reward:    ${g.avgReward}\n`;
      if (g.commonFailures.length > 0) {
        out += `    Common failures:\n`;
        for (const f of g.commonFailures) {
          out += `      - ${f.reason} (${f.count}x)\n`;
        }
      }
      out += `    Planner hints: ${g.plannerHintRuns}/${g.runs} runs\n`;
      out += '\n';
    }

    out += '='.repeat(60) + '\n';
    return out;
  }

  runFilteredReport(opts = {}) {
    const { metadata, ...filters } = opts;
    const filtered = this.filter(filters);
    return this.report(filtered, metadata);
  }
}

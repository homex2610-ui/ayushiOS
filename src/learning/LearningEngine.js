// LearningEngine.js
// Central orchestrator for Phase 3 learning.
// Hooks into task lifecycle events to build experiences, derive skills,
// and update planner heuristics. Never writes to MemoryMatrix directly —
// only updates confidence on existing facts.

import { Experience } from './Experience.js';
import { RewardModel } from './RewardModel.js';
import { ExperienceStore } from './ExperienceStore.js';
import { SkillRepository } from './SkillRepository.js';
import { VERSIONS } from './Version.js';

export class LearningEngine {
  constructor({ bus, knowledge, memory, beliefs, motorCortex, trace, username }) {
    this.bus = bus;
    this.knowledge = knowledge;
    this.memory = memory;
    this.beliefs = beliefs;
    this.motor = motorCortex;
    this.trace = trace;

    this.rewardModel = new RewardModel();
    this.experienceStore = new ExperienceStore(username);
    this.skills = new SkillRepository(username);

    this._taskStartTime = null;
    this._currentTaskName = null;
    this._lastExperiences = [];

    this._wireEvents();
  }

  _wireEvents() {
    this.bus?.on('task_started', ({ taskName, context }) => {
      this._taskStartTime = Date.now();
      this._currentTaskName = taskName;
    });

    this.bus?.on('task_completed', ({ taskName }) => {
      this._onTaskEnd(taskName, 'completed', null);
    });

    this.bus?.on('task_failed', ({ taskName, error }) => {
      this._onTaskEnd(taskName, 'failed', error);
    });

    this.bus?.on('task_resumed', ({ taskName }) => {
      this._taskStartTime = Date.now();
      this._currentTaskName = taskName;
    });

    this.bus?.on('decision_interrupted', () => {
      // Interruptions are captured via task_failed
    });
  }

  _onTaskEnd(taskName, result, error) {
    if (!taskName) return;

    const duration = this._taskStartTime ? Date.now() - this._taskStartTime : 0;
    const serverType = this.knowledge?.getServerType?.()?.type || 'unknown';
    const serverId = this.knowledge?.getCurrentServer?.()?.name || null;

    const ctx = this.motor?.activeContext;
    const latestTrace = this.trace?.latest();
    const beliefsSnapshot = {
      health: this.beliefs?.vitality?.health || 20,
      food: this.beliefs?.vitality?.food || 20,
      threats: this.beliefs?.threats || [],
      position: this.beliefs?.position || null,
    };

    const taskGraph = (ctx?.steps || []).map((s, i) => ({
      skill: s.skill,
      params: s.params,
      status: i < (ctx?.currentStepIndex || 0) ? 'completed' : (i === (ctx?.currentStepIndex || 0) ? 'active' : 'pending'),
    }));

    const actions = taskGraph.filter(s => s.status === 'completed' || s.status === 'active').map(s => ({
      skill: s.skill,
      params: s.params,
      duration: Math.round(duration / Math.max(1, taskGraph.filter(t => t.status === 'completed' || t.status === 'active').length)),
      status: s.status === 'active' ? (result === 'completed' ? 'completed' : 'failed') : s.status,
    }));

    const interruptions = [];
    if (latestTrace?.interrupted) {
      interruptions.push({
        reason: latestTrace.interrupted.reason,
        at: latestTrace.interrupted.time,
      });
    }

    const failureReason = result === 'failed' ? (error || 'unknown') : null;

    const lessonsLearned = this._deriveLessons(taskName, result, failureReason, duration);

    const experience = new Experience({
      serverId,
      serverType,
      goal: taskName,
      taskGraph,
      contextSnapshot: {
        assumptions: ctx?.assumptions || [],
        blockers: ctx?.blockers || [],
        priority: ctx?.priority || 0.5,
        stepsCompleted: ctx?.currentStepIndex || 0,
        totalSteps: ctx?.steps?.length || 0,
      },
      beliefsSnapshot,
      actions,
      interruptions,
      result,
      duration,
      failureReason,
      lessonsLearned,
      version: { ...VERSIONS },
    });

    const reward = this.rewardModel.calculate(experience);
    experience.reward = this.rewardModel.normalize(reward);

    this.experienceStore.add(experience);
    const skillBefore = this.skills.allSkills().length;
    this.skills.updateFromExperience(experience);
    const skillAfter = this.skills.allSkills().length;

    // Reward-attribution log: which experience drove which skill change
    const skillUpdateDetail = [];
    const affectedSkills = this.skills.getSkillsForGoal(taskName);
    for (const sk of affectedSkills) {
      const st = sk.serverTypes?.[serverType];
      if (st) {
        skillUpdateDetail.push({
          skill: sk.id,
          serverType,
          attempts: st.attempts,
          successes: st.successes,
          avgReward: sk.optimal.avgReward,
          successRate: sk.optimal.successRate,
        });
        this.trace?.recordLearning(
          { experienceId: experience.id, reward },
          {
            skillUpdate: { skill: sk.id, attempts: st.attempts, successRate: sk.optimal.successRate, avgReward: sk.optimal.avgReward },
          },
          `Reward: ${reward} → skill "${sk.id}": rate=${(sk.optimal.successRate * 100).toFixed(0)}%, avgReward=${sk.optimal.avgReward}`
        );
      }
    }

    this._lastExperiences.push(experience);
    if (this._lastExperiences.length > 50) this._lastExperiences.shift();

    this.bus?.emit('experience_created', {
      experience: experience.toJSON(),
      skills: skillAfter,
      totalExperiences: this.experienceStore.totalExperiences(),
      rewardAttribution: skillUpdateDetail,
    });

    this._taskStartTime = null;
    this._currentTaskName = null;
  }

  _deriveLessons(taskName, result, failureReason, duration) {
    const lessons = [];

    if (result === 'completed') {
      if (duration < 10000) lessons.push('fast execution');
      if (duration > 60000) lessons.push('slow execution — consider optimizing');
      lessons.push(`task ${taskName} achievable`);
    }

    if (result === 'failed' && failureReason) {
      const fr = failureReason.toLowerCase();
      if (/missing resource|need|require|have|not found/i.test(fr)) lessons.push('gather resources before attempting');
      if (/danger|hostile|creeper|threat|hurt/i.test(fr)) lessons.push('ensure area is safe before task');
      if (/blocked|no access|denied|permission|claim/i.test(fr)) lessons.push('check permissions or find alternative approach');
      if (/timeout|interrupt/i.test(fr)) lessons.push('task may need shorter subtasks for interrupt-safe execution');
      lessons.push(`failure cause: ${failureReason}`);
    }

    return lessons;
  }

  getRecentExperiences(n = 10) {
    return this.experienceStore.getRecent(n).map(e => e.toJSON());
  }

  getStats() {
    const store = this.experienceStore;
    const total = store.totalExperiences();
    const goals = new Set(store.getAll().map(e => e.goal));

    const goalStats = {};
    for (const goal of goals) {
      goalStats[goal] = {
        attempts: store.getByGoal(goal).length,
        successRate: store.successRate(goal),
        avgDuration: this.skills.averageDuration(goal),
        commonFailures: this.skills.commonFailureReasons(goal),
      };
    }

    return {
      totalExperiences: total,
      goalsTracked: goals.size,
      skillsLearned: this.skills.allSkills().length,
      goals: goalStats,
    };
  }

  getPlannerHints(goal, state) {
    const hints = {
      avgDuration: this.skills.averageDuration(goal),
      successRate: this.skills.successRate(goal),
      commonFailures: this.skills.commonFailureReasons(goal),
      bestStrategy: this.skills.getBestSkill(goal),
      serverSpecificSkill: null,
    };
    const serverType = state?.serverSemantics?.type || state?.serverKnowledge?.type || 'unknown';
    hints.serverSpecificSkill = this.skills.getSkillForServer(goal, serverType);
    return hints;
  }

  reset() {
    this.experienceStore.clear();
    this.skills.clear();
    this._lastExperiences = [];
    this._taskStartTime = null;
    this._currentTaskName = null;
  }
}

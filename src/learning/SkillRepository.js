/* global process */
// SkillRepository.js
// Statistical aggregates derived from Experiences.
// Skills are strategies the planner can choose from.
// Memory stores facts; Skills store statistics.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';

export class SkillRepository {
  constructor(username) {
    this.filePath = path.join(process.cwd(), 'bots', username, 'skills.json');
    this._skills = {};
    this._dirty = false;
    this._load();
  }

  _load() {
    try {
      if (existsSync(this.filePath)) {
        this._skills = JSON.parse(readFileSync(this.filePath, 'utf8'));
      }
    } catch (_) {
      // File not found or invalid — start fresh
    }
  }

  _save() {
    if (!this._dirty) return;
    try {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this._skills, null, 2), 'utf8');
      this._dirty = false;
    } catch (_) {
      // Write failed — will retry on next save
    }
  }

  updateFromExperience(experience) {
    if (!experience || !experience.goal) return;
    const goal = experience.goal;
    const actionKey = experience.primaryAction();
    const skillName = actionKey ? `${goal}__${actionKey.skill}` : goal;
    const serverType = experience.serverType || 'unknown';

    if (!this._skills[skillName]) {
      this._skills[skillName] = {
        id: skillName,
        goal,
        primarySkill: actionKey?.skill || null,
        serverTypes: {},
        statistics: {
          attempts: 0,
          successes: 0,
          failures: 0,
          interruptions: 0,
          totalDuration: 0,
          totalReward: 0,
          failureReasons: {},
        },
        optimal: {
          avgDuration: 0,
          avgReward: 0,
          successRate: 0,
        },
        lastUsed: 0,
        confidence: 0.3,
      };
    }

    const skill = this._skills[skillName];
    skill.statistics.attempts++;
    skill.lastUsed = experience.timestamp;

    if (!skill.serverTypes[serverType]) {
      skill.serverTypes[serverType] = { attempts: 0, successes: 0 };
    }
    skill.serverTypes[serverType].attempts++;

    if (experience.isSuccess()) {
      skill.statistics.successes++;
      skill.serverTypes[serverType].successes++;
    } else if (experience.isFailure()) {
      skill.statistics.failures++;
      if (experience.failureReason) {
        const reason = experience.failureReason;
        skill.statistics.failureReasons[reason] = (skill.statistics.failureReasons[reason] || 0) + 1;
      }
    }

    if (experience.wasInterrupted()) {
      skill.statistics.interruptions++;
    }

    skill.statistics.totalDuration += experience.effectiveDuration();
    skill.statistics.totalReward += experience.reward;

    const stats = skill.statistics;
    skill.optimal = {
      avgDuration: stats.attempts > 0 ? Math.round(stats.totalDuration / stats.attempts) : 0,
      avgReward: stats.attempts > 0 ? Math.round(stats.totalReward / stats.attempts) : 0,
      successRate: stats.attempts > 0 ? stats.successes / stats.attempts : 0,
    };

    skill.confidence = Math.min(1, 0.3 + stats.attempts * 0.05);

    this._dirty = true;
    this._save();
  }

  getSkill(name) {
    return this._skills[name] || null;
  }

  getSkillsForGoal(goal) {
    return Object.entries(this._skills)
      .filter(([, s]) => s.goal === goal)
      .map(([, s]) => s)
      .sort((a, b) => b.confidence - a.confidence);
  }

  getBestSkill(goal) {
    const skills = this.getSkillsForGoal(goal);
    if (skills.length === 0) return null;
    return skills.reduce((best, s) =>
      (s.optimal.successRate > best.optimal.successRate || (s.optimal.successRate === best.optimal.successRate && s.confidence > best.confidence))
        ? s : best
    );
  }

  getSkillForServer(goal, serverType) {
    const skills = this.getSkillsForGoal(goal);
    const matching = skills.filter(s => s.serverTypes[serverType]);
    if (matching.length === 0) return null;
    return matching.reduce((best, s) =>
      ((s.serverTypes[serverType]?.successes || 0) > (best.serverTypes[serverType]?.successes || 0)) ? s : best
    );
  }

  averageDuration(goal) {
    const skills = this.getSkillsForGoal(goal);
    if (skills.length === 0) return null;
    const total = skills.reduce((sum, s) => sum + s.optimal.avgDuration, 0);
    return Math.round(total / skills.length);
  }

  successRate(goal) {
    const skills = this.getSkillsForGoal(goal);
    if (skills.length === 0) return 0;
    const total = skills.reduce((sum, s) => sum + s.optimal.successRate * s.statistics.attempts, 0);
    const attempts = skills.reduce((sum, s) => sum + s.statistics.attempts, 0);
    return attempts > 0 ? total / attempts : 0;
  }

  commonFailureReasons(goal) {
    const reasons = {};
    const skills = this.getSkillsForGoal(goal);
    for (const skill of skills) {
      for (const [reason, count] of Object.entries(skill.statistics.failureReasons)) {
        reasons[reason] = (reasons[reason] || 0) + count;
      }
    }
    return Object.entries(reasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));
  }

  allSkills() {
    return Object.values(this._skills).sort((a, b) => b.statistics.attempts - a.statistics.attempts);
  }

  clear() {
    this._skills = {};
    this._dirty = true;
    this._save();
  }
}

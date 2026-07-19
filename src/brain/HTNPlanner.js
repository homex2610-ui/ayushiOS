// HTNPlanner.js
// ─────────────────────────────────────────────────────────────
// Hierarchical Task Network planner — lite.
//
// Given a goal, expands it through task definitions until all
// leaves are primitive operators. Outputs a flat ordered step
// array compatible with TaskRunner + BT execution.
//
// Design principles:
//   • Data-driven — task definitions live in domain/tasks.js
//   • Capability-based — operators are abstract (Acquire, Travel…)
//   • BT-agnostic — the planner composes; BT executes
//   • Resumable — uses TaskContext for interruption handling
//   • Fallback-safe — _planGoal() remains for un-migrated goals
// ─────────────────────────────────────────────────────────────

import { TaskNode, Planner } from './Planner.js';
import { getTask } from '../domain/tasks.js';
import { getOperator } from '../domain/operators.js';
import * as P from '../domain/predicates.js';

const FAILURE_REASONS = {
  MISSING_RESOURCE: 'missing_resource',
  BLOCKED: 'blocked',
  DANGER: 'danger',
  PLUGIN_RESTRICTION: 'plugin_restriction',
  NETWORK: 'network',
  UNKNOWN: 'unknown',
};

export class HTNPlanner extends Planner {
  constructor() {
    super();
    this._taskIdCounter = 0;
  }

  _nextId() {
    this._taskIdCounter++;
    return `n${this._taskIdCounter}`;
  }

  _buildStateView(state) {
    return {
      inventory: state.resources?.inventory || [],
      equipment: state.equipment || {},
      environment: state.environment || {},
      food: state.vitality?.food ?? 20,
      health: state.vitality?.health ?? 20,
      threats: state.threats || [],
      hazardsNearby: state.hazardsNearby || state.beliefs?.hazardsNearby || false,
      hasSafeBase: state.hasSafeBase || state.beliefs?.hasSafeBase || false,
      nearestSafeBase: state.nearestSafeBase || state.beliefs?.nearestSafeBase || null,
      nearestWarp: state.nearestWarp || state.beliefs?.nearestWarp || null,
      knownWarpCount: state.knownWarpCount || state.beliefs?.knownWarpCount || 0,
      knownWarps: state.knownWarps || state.beliefs?.knownWarps || [],
      knownLocations: state.knownLocations || {},
      position: state.environment?.position || state.beliefs?.position || null,
      isNight: state.environment?.isNight || false,
      planning: state.planning || {},
    };
  }

  /**
   * Plan for a goal given current state and optional context.
   */
  plan(goal, state, context = null) {
    this._taskIdCounter = 0;

    // If context has a paused task, resume it
    if (context && context.status === 'paused' && context.goal === goal) {
      return this.resume(context, state);
    }

    const sv = this._buildStateView(state);
    const taskDef = getTask(goal);

    if (!taskDef) {
      return { steps: [], context: null };
    }

    const root = new TaskNode(this._nextId(), goal, {
      priority: taskDef.priority,
      preconditions: taskDef.preconditions,
      effects: taskDef.effects,
      depth: 0,
    });

    const expanded = this._expandTask(taskDef, sv, root, 0);
    const ordered = this._flatten(expanded || root);

    // Build context metadata
    const planContext = {
      goal,
      priority: taskDef.priority,
      steps: ordered.map(n => ({
        skill: this._operatorToSkill(n.operator, n.params),
        params: n.params,
      })),
      assumptions: taskDef.preconditions,
      requiredResources: [],
      blockers: this._findBlockers(ordered, sv),
      metadata: { taskCount: ordered.length },
    };

    return { steps: ordered, context: planContext };
  }

  /**
   * Resume a paused task from its context.
   */
  resume(context, state) {
    const sv = this._buildStateView(state);
    const steps = (context.steps || []).slice(context.currentStepIndex || 0);
    const nodes = steps.map((s, i) => {
      const node = new TaskNode(this._nextId(), this._skillToOperator(s.skill), {
        params: s.params || {},
        depth: 0,
        status: 'pending',
      });
      return node;
    });

    return {
      steps: nodes,
      context: {
        ...context,
        steps,
        currentStepIndex: context.currentStepIndex || 0,
      },
    };
  }

  /**
   * Replan after a failure with failure classification.
   */
  replan(failedStep, reason, state, context) {
    const sv = this._buildStateView(state);
    const classification = this._classifyFailure(failedStep, reason, sv);

    if (classification === FAILURE_REASONS.DANGER) {
      const safetyGoal = getTask('seek_safety');
      if (safetyGoal) {
        const root = new TaskNode(this._nextId(), 'seek_safety', { priority: 0.95 });
        const expanded = this._expandTask(safetyGoal, sv, root, 0);
        const ordered = this._flatten(expanded || root);
        return {
          steps: ordered,
          context: {
            goal: 'seek_safety',
            priority: 0.95,
            steps: ordered.map(n => ({
              skill: this._operatorToSkill(n.operator, n.params),
              params: n.params,
            })),
            blockers: ['danger'],
            metadata: { replanReason: classification },
          },
        };
      }
    }

    // Default: re-plan the original goal, marking the failed step's resource as blocker
    const updatedContext = {
      ...context,
      blockers: [...(context?.blockers || []), classification],
    };
    return this.plan(context?.goal || failedStep?.operator || 'explore_unknown', state, updatedContext);
  }

  /**
   * Validate a plan's preconditions against state.
   */
  validate(steps, state) {
    const sv = this._buildStateView(state);
    const issues = [];

    for (const step of steps) {
      for (const pre of step.preconditions) {
        if (!this._checkPredicate(pre, step.params, sv)) {
          issues.push(`Step "${step.operator}": precondition "${pre}" not met`);
        }
      }
    }

    return { valid: issues.length === 0, issues };
  }

  // ─── Private: expansion ─────────────────────────────────────

  _expandTask(taskDef, state, parentNode, depth) {
    if (depth > 20) return parentNode; // safety limit

    let expansion;
    try {
      expansion = taskDef.expand(state);
    } catch (err) {
      console.warn(`[HTN] Task "${taskDef.id}" expansion failed:`, err.message);
      return parentNode;
    }

    if (!expansion || !expansion.steps || expansion.steps.length === 0) {
      return parentNode;
    }

    for (const stepDef of expansion.steps) {
      const childId = this._nextId();
      const operatorDef = getOperator(stepDef.operator);

      if (!operatorDef) {
        console.warn(`[HTN] Unknown operator "${stepDef.operator}" — skipping`);
        continue;
      }

      const child = new TaskNode(childId, stepDef.operator, {
        parent: parentNode.id,
        preconditions: operatorDef.preconditions || [],
        effects: operatorDef.effects || [],
        params: stepDef.params || {},
        depth: depth + 1,
      });

      // Check if this operator expands into a sub-task
      const subTask = getTask(stepDef.operator);
      if (subTask) {
        this._expandTask(subTask, state, child, depth + 1);
      }

      parentNode.children.push(child);
    }

    return parentNode;
  }

  _flatten(node) {
    if (node.isPrimitive()) {
      return [node];
    }
    const result = [];
    for (const child of node.children) {
      result.push(...this._flatten(child));
    }
    return result;
  }

  // ─── Private: mapping ───────────────────────────────────────

  _operatorToSkill(operator, params) {
    const skillMap = {
      Acquire: 'collect',
      Travel: 'move_to',
      Interact: 'interact',
      Craft: 'craft',
      Smelt: 'smelt',
      Farm: 'farm',
      Use: 'eat',
      Equip: 'equip',
      Combat: 'combat',
      Escape: 'go_surface',
      Observe: 'interact',
      Wait: 'wait',
      Collect: 'collect',
    };
    return skillMap[operator] || operator?.toLowerCase() || 'wait';
  }

  _skillToOperator(skill) {
    const opMap = {
      collect: 'Collect',
      move_to: 'Travel',
      interact: 'Interact',
      craft: 'Craft',
      smelt: 'Smelt',
      farm: 'Farm',
      eat: 'Use',
      equip: 'Equip',
      combat: 'Combat',
      go_surface: 'Escape',
      wait: 'Wait',
    };
    return opMap[skill] || skill;
  }

  // ─── Private: precondition checking ─────────────────────────

  _checkPredicate(predicate, params, state) {
    switch (predicate) {
      case 'hasFood': return P.hasFood(state);
      case 'isHungry': return P.isHungry(state);
      case 'enemyNearby': return P.enemyNearby(state);
      case 'isNight': return P.isNight(state);
      case 'knowsWarp': return P.knowsWarp(state);
      case 'hasBase': return P.hasBase(state);
      case 'canReach': return true;
      case 'knowsPosition': return true;
      case 'hasMaterials':
      case 'hasItem':
        return P.hasItem(state, params?.resource || params?.item);
      case 'hasWorkstation':
        return P.hasWorkstation(state, params?.workstation || 'crafting_table');
      case 'hasFuel':
        return P.hasItem(state, 'coal');
      case 'hasFurnace':
        return P.hasWorkstation(state, 'furnace');
      case 'hasSeeds':
        return P.hasItem(state, 'seeds');
      case 'hasFarmland':
        return true;
      case 'hasPickaxe':
        return P.hasTool(state, 'any_pickaxe');
      case 'blockReachable':
        return true;
      case 'hasWeapon':
        return P.hasTool(state, 'any_weapon');
      case 'targetReachable':
        return true;
      default:
        return true;
    }
  }

  _findBlockers(steps, state) {
    const blockers = [];
    for (const step of steps) {
      for (const pre of step.preconditions) {
        if (!this._checkPredicate(pre, step.params, state)) {
          blockers.push(`${step.operator}:${pre}`);
        }
      }
    }
    return blockers;
  }

  _classifyFailure(failedStep, reason, state) {
    if (!reason) return FAILURE_REASONS.UNKNOWN;
    const r = reason.toLowerCase();
    if (/danger|threat|hostile|creeper|hurt/i.test(r)) return FAILURE_REASONS.DANGER;
    if (/missing|need|require|resource|have/i.test(r)) return FAILURE_REASONS.MISSING_RESOURCE;
    if (/blocked|cannot|can't|denied|no access|claim/i.test(r)) return FAILURE_REASONS.PLUGIN_RESTRICTION;
    if (/timeout|disconnect|network/i.test(r)) return FAILURE_REASONS.NETWORK;
    if (/blocked|stuck|obstructed/i.test(r)) return FAILURE_REASONS.BLOCKED;
    return FAILURE_REASONS.UNKNOWN;
  }
}

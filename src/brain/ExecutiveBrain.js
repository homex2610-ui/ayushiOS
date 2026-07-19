// ExecutiveBrain.js
// ─────────────────────────────────────────────────────────────
// PREFRONTAL CORTEX — conscious decision-making.
// This module now combines utility-based need arbitration with
// hierarchical goal decomposition. High-level needs still
// compete for attention, but each chosen goal is expanded into
// concrete subgoals and primitive actions before execution.
// ─────────────────────────────────────────────────────────────

import { THRESHOLDS } from './config.js';
import { HTNPlanner } from './HTNPlanner.js';
import { taskNames } from '../domain/tasks.js';
import { resolveCapability, getRelevantCapabilities } from './capabilities.js';

const NEEDS = [
  {
    name: 'avoid_hazard',
    score: (s, m, p, tom, lastInterruptedGoal, learning) => {
      if (!s.beliefs?.hazardsNearby) return 0;
      const base = Math.min(1, 0.5 + (s.beliefs.hazardCount || 1) * 0.15 + (s.beliefs.nearestSafeBaseConfidence || 0) * 0.1);
      return Math.min(1, base + (learning?.hazardAlert || 0));
    },
    goal: (s) => ({ name: 'avoid_hazard', task: 'avoid_hazard', params: {} })
  },
  {
    name: 'seek_safety',
    score: (s) => {
      if (s.vitality.health < THRESHOLDS.healthLow || s.threats.length > 0) {
        return Math.min(1, 0.7 + (s.threats.length * 0.1));
      }
      return 0;
    },
    goal: (s) => ({ name: 'seek_safety', task: 'seek_safety', params: {} })
  },
  {
    name: 'eat',
    score: (s) => {
      if (s.vitality.food < THRESHOLDS.foodCritical) return 1;
      if (s.vitality.food < THRESHOLDS.foodLow) return 0.8;
      if (!s.vitality.hasFood) return 0.5;
      return 0;
    },
    goal: () => ({ name: 'eat', task: 'eat', params: {} })
  },
  {
    name: 'resume_task',
    score: (s, m, p, tom, lastInterruptedGoal) => {
      if (!lastInterruptedGoal) return 0;
      if (s.threats.length > 0 || s.beliefs?.hazardsNearby) return 0;
      if (s.vitality.food < THRESHOLDS.foodLow) return 0;
      return 0.75;
    },
    goal: (s, m, p, tom, lastInterruptedGoal) => lastInterruptedGoal || { name: 'idle', task: 'idle', params: {} }
  },
  {
    name: 'craft_gear',
    score: (s) => {
      const relevant = getRelevantCapabilities(s);
      const inv = s.resources?.inventory || [];
      const env = s.environment || {};
      const placedBlocks = [];
      if (env.nearestChest) placedBlocks.push('chest');
      if (env.nearestWorkstation?.name === 'crafting_table') placedBlocks.push('crafting_table');
      if (env.nearestWorkstation?.name === 'furnace') placedBlocks.push('furnace');
      if (env.nearestBed) placedBlocks.push('bed');

      let maxScore = 0;
      for (const capName of relevant) {
        const result = resolveCapability(inv, capName, placedBlocks);
        if (!result.satisfied) {
          const isStone = capName === 'canMineStone';
          const isFight = capName === 'canFight';
          const isIron = capName === 'canMineIron';
          if (isStone && result.steps.length <= 4) maxScore = Math.max(maxScore, 0.5);
          if (isFight && result.steps.length <= 4) maxScore = Math.max(maxScore, 0.4);
          if (isIron) maxScore = Math.max(maxScore, 0.35);
        }
      }
      return maxScore;
    },
    goal: () => ({ name: 'craft_gear', task: 'craft_gear', params: {} })
  },
  {
    name: 'advance_capability',
    score: (s, m, p, tom, lastInterruptedGoal, learning) => {
      if (s.threats.length > 0 || s.vitality.health < THRESHOLDS.healthLow) return 0;
      if (s.vitality.food < THRESHOLDS.foodLow) return 0;
      const relevant = getRelevantCapabilities(s);
      const inv = s.resources?.inventory || [];
      const env = s.environment || {};
      const placedBlocks = [];
      if (env.nearestChest) placedBlocks.push('chest');
      if (env.nearestWorkstation?.name === 'crafting_table') placedBlocks.push('crafting_table');
      if (env.nearestWorkstation?.name === 'furnace') placedBlocks.push('furnace');
      let unsatisfiedCount = 0;
      for (const capName of relevant) {
        const result = resolveCapability(inv, capName, placedBlocks);
        if (!result.satisfied) unsatisfiedCount++;
      }
      if (unsatisfiedCount === 0) return 0;
      return Math.min(0.65, 0.25 + unsatisfiedCount * 0.15 - (learning?.failureCaution || 0));
    },
    goal: () => ({ name: 'advance_capability', task: 'advance_capability', params: {} })
  },
  {
    name: 'build_base',
    score: (s) => {
      const hasBase = s.environment.nearestChest && s.environment.nearestBed && s.environment.nearestWorkstation;
      if (hasBase || s.beliefs?.hasSafeBase) return 0;
      const hasMaterials = s.resources.hasCraftingTable;
      return hasMaterials ? 0.45 : 0.2;
    },
    goal: () => ({ name: 'build_base', task: 'build_base', params: {} })
  },
  {
    name: 'visit_known_warp',
    score: (s, m, p, tom, lastInterruptedGoal, learning) => {
      if (!s.beliefs?.nearestWarp) return 0;
      if (s.vitality.food < THRESHOLDS.foodLow) return 0;
      if (s.threats.length > 0) return 0;
      return Math.max(0, 0.35 - (learning?.failureCaution || 0));
    },
    goal: () => ({ name: 'visit_known_warp', task: 'visit_known_warp', params: {} })
  },
  {
    name: 'farm_food',
    score: (s) => {
      if (!s.vitality.hasFood && s.resources.hasOre('wheat_seeds')) return 0.6;
      return 0;
    },
    goal: () => ({ name: 'farm_food', task: 'farm_food', params: {} })
  },
  {
    name: 'socialize',
    score: (s, m, p) => (s.social.nearbyPlayers.length > 0 && p.traits.sociability > 0.5) ? 0.2 : 0,
    goal: () => ({ name: 'socialize', task: 'chat_greet', params: {} })
  },
  {
    name: 'explore_unknown',
    score: (s, m, p, tom, lastInterruptedGoal, learning) => {
      if (s.threats.length > 0 || s.vitality.food < THRESHOLDS.foodLow) return 0;
      return Math.max(0, 0.1 + p.traits.curiosity * 0.15 - (learning?.failureCaution || 0));
    },
    goal: () => ({ name: 'explore_unknown', task: 'explore_unknown', params: {} })
  }
];

export class ExecutiveBrain {
  constructor(memory, personality, tom, bus, opts = {}) {
    this.memory = memory;
    this.personality = personality;
    this.tom = tom;
    this.bus = bus;
    this.knowledge = opts.knowledge || null;
    this.trace = opts.trace || null;
    this.getSuggestions = opts.getSuggestions || (() => []);
    this.getPlannerHints = opts.getPlannerHints || (() => ({}));
    this.lastInterruptedGoal = null;
    this.lastSelectedNeed = null;
    this.currentGoal = null;
    this.lastFailure = null;
    this._goalTimestamps = {};
    this.htnPlanner = new HTNPlanner();
    this._htnTasks = new Set(taskNames());
    this._htnTasks.delete('eat');
    this._htnTasks.delete('socialize');
    this._lastPlanContext = null;
    this._lastDecisions = [];
    this._decisionCount = {};

    this.bus?.on('task_started', ({ taskName, steps, context }) => {
      this.currentGoal = { name: taskName, task: taskName, steps, context: context || null };
    });
    this.bus?.on('task_failed', ({ taskName, error }) => {
      if (this.currentGoal) {
        this.lastInterruptedGoal = this.currentGoal;
      }
      this.lastFailure = { taskName, error, time: Date.now() };
      this.memory?.recordFailure?.(taskName, error);
    });
    this.bus?.on('task_interrupted', ({ taskName }) => {
      if (this.currentGoal) {
        this.lastInterruptedGoal = this.currentGoal;
      }
      this.lastFailure = { taskName, error: 'interrupted', time: Date.now() };
    });
    this.bus?.on('task_completed', () => {
      this.lastInterruptedGoal = null;
      this.lastFailure = null;
    });
    this.bus?.on('task_resumed', ({ taskName, context }) => {
      this.currentGoal = { name: taskName, task: taskName, steps: context?.steps || [], context };
      this.lastInterruptedGoal = null;
    });
  }

  _buildBeliefs(snapshot) {
    if (!snapshot || !snapshot.environment?.position) return {};
    const position = snapshot.environment.position;
    const beliefs = this.memory?.getBeliefs?.(position) || {};
    let foodItem = 'carrot';
    if (beliefs.nearestFoodSource?.name) {
      const name = beliefs.nearestFoodSource.name.toLowerCase();
      if (name.includes('potato')) foodItem = 'potato';
      else if (name.includes('carrot')) foodItem = 'carrot';
      else if (name.includes('wheat')) foodItem = 'wheat';
      else if (name.includes('berry')) foodItem = 'sweet_berries';
      else if (name.includes('farm')) foodItem = 'carrot';
    }
    return {
      ...beliefs,
      foodItem,
      safeBaseAvailable: !!beliefs.nearestSafeBase,
      hasKnownWarp: beliefs.knownWarpCount > 0,
      recentEpisodes: beliefs.recentEpisodes || [],
      recentHazardWarnings: (beliefs.recentEpisodes || []).filter(e => /hazard|death|failure/i.test(e.text)),
    };
  }

  _deriveLearningAdjustment(snapshot) {
    const hazardWarnings = snapshot.beliefs?.recentHazardWarnings?.length || 0;
    const failureCount = snapshot.beliefs?.recentEpisodes?.filter(e => /failure|task failed|death recorded/i.test(e.text)).length || 0;
    return {
      hazardAlert: Math.min(0.3, hazardWarnings * 0.08),
      failureCaution: Math.min(0.25, failureCount * 0.05),
    };
  }

  _normalizeInventory(inventory) {
    const counts = {};
    for (const item of inventory || []) {
      const name = item.name?.toLowerCase();
      if (!name) continue;
      counts[name] = (counts[name] || 0) + (item.count || 1);
    }
    return counts;
  }

  _buildPlanState(snapshot) {
    const inventoryCounts = this._normalizeInventory(snapshot.resources?.inventory || []);
    const beliefs = snapshot.beliefs || {};
    const position = snapshot.environment?.position;
    const nearestSafeBase = beliefs.nearestSafeBase;
    const isAtSafeBase = nearestSafeBase && position && Math.sqrt(
      (nearestSafeBase.position.x - position.x) ** 2 +
      (nearestSafeBase.position.y - position.y) ** 2 +
      (nearestSafeBase.position.z - position.z) ** 2
    ) <= 6;

    return {
      ...snapshot,
      beliefs,
      planning: {
        inventoryCounts,
        foodCount: Object.entries(inventoryCounts).reduce((sum, [name, cnt]) => {
          if (/apple|bread|cooked|potato|carrot|beetroot|mutton|rabbit|fish|beef|chicken|berry|melon|stew|soup|honey/.test(name)) {
            return sum + cnt;
          }
          return sum;
        }, 0),
        rawIronCount: Object.entries(inventoryCounts).filter(([name]) => /raw_iron|iron_ore/.test(name)).reduce((sum,[,cnt]) => sum+cnt,0),
        ironIngotCount: inventoryCounts['iron_ingot'] || 0,
        coalCount: inventoryCounts['coal'] || 0,
        hasCraftingTable: snapshot.resources?.hasCraftingTable,
        hasFurnace: snapshot.resources?.hasFurnace,
        hasBed: snapshot.resources?.hasBed,
        hasShield: snapshot.equipment?.hasShield,
        hasWaterBucket: snapshot.equipment?.hasWaterBucket,
        isAtSafeBase,
      }
    };
  }

  _planGoal(goal, state) {
    switch (goal.name) {
      case 'avoid_hazard': return this._planAvoidHazard(state);
      case 'seek_safety': return this._planSeekSafety(state);
      case 'eat': return this._planEat(state);
      case 'craft_gear': return this._planCraftGear(state);
      case 'advance_capability': return this._planAdvanceCapability(state);
      case 'build_base': return this._planBuildBase(state);
      case 'visit_known_warp': return this._planVisitWarp(state);
      case 'farm_food': return this._planFarmFood(state);
      case 'socialize': return this._planSocialize(state);
      case 'explore_unknown': return this._planExplore(state);
      default: return goal.steps || [];
    }
  }

  _planAvoidHazard(state) {
    const safeBase = state.beliefs?.nearestSafeBase;
    if (safeBase) {
      return [
        { skill: 'move_to', params: { x: safeBase.position.x, y: safeBase.position.y, z: safeBase.position.z, range: 3 } },
        { skill: 'wait', params: { ms: 4000 } }
      ];
    }
    return [{ skill: 'go_surface', params: {} }];
  }

  _planSeekSafety(state) {
    return this._planAvoidHazard(state);
  }

  _planEat(state) {
    if (state.resources?.hasFood) {
      return [{ skill: 'eat', params: { minFoodLevel: THRESHOLDS.foodComfortable } }];
    }
    if (state.planning.foodCount > 0) {
      return [{ skill: 'eat', params: { minFoodLevel: THRESHOLDS.foodComfortable } }];
    }
    if (state.beliefs?.nearestFoodSource) {
      const source = state.beliefs.nearestFoodSource;
      return [
        { skill: 'move_to', params: { x: source.position.x, y: source.position.y, z: source.position.z, range: 4 } },
        { skill: 'collect', params: { item: state.beliefs.foodItem, count: 4 } },
        { skill: 'eat', params: { minFoodLevel: THRESHOLDS.foodComfortable } }
      ];
    }
    // Hunt animals first (more reliable than unknown crops)
    return [
      { skill: 'combat', params: { entityType: 'animal', range: 20, count: 2, stopOnHealth: 3 } },
      { skill: 'eat', params: { minFoodLevel: THRESHOLDS.foodComfortable } }
    ];
  }

  _planCraftGear(state) {
    const inv = state.resources?.inventory || [];
    const env = state.environment || {};
    const placedBlocks = [];
    if (env.nearestChest) placedBlocks.push('chest');
    if (env.nearestWorkstation?.name === 'crafting_table') placedBlocks.push('crafting_table');
    if (env.nearestWorkstation?.name === 'furnace') placedBlocks.push('furnace');

    for (const capName of getRelevantCapabilities(state)) {
      const result = resolveCapability(inv, capName, placedBlocks);
      if (!result.satisfied && result.steps.length > 0) {
        return result.steps;
      }
    }
    return [];
  }

  _planAdvanceCapability(state) {
    return this._planCraftGear(state);
  }

  _planBuildBase(state) {
    if (state.beliefs?.nearestSafeBase) {
      return [
        { skill: 'move_to', params: { x: state.beliefs.nearestSafeBase.position.x, y: state.beliefs.nearestSafeBase.position.y, z: state.beliefs.nearestSafeBase.position.z, range: 4 } },
        { skill: 'wait', params: { ms: 3000 } }
      ];
    }
    if (state.planning.hasCraftingTable || state.planning.hasFurnace) {
      return [
        { skill: 'collect', params: { item: 'oak_log', count: 8 } },
        { skill: 'craft', params: { item: 'oak_planks', count: 16 } },
        { skill: 'craft', params: { item: 'crafting_table', count: 1 } },
        { skill: 'craft', params: { item: 'bed', count: 1 } }
      ];
    }
    return [
      { skill: 'collect', params: { item: 'oak_log', count: 12 } },
      { skill: 'craft', params: { item: 'oak_planks', count: 16 } },
      { skill: 'craft', params: { item: 'crafting_table', count: 1 } },
      { skill: 'craft', params: { item: 'bed', count: 1 } }
    ];
  }

  _planVisitWarp(state) {
    const warp = state.beliefs?.nearestWarp;
    if (warp && warp.position) {
      return [
        { skill: 'move_to', params: { x: warp.position.x, y: warp.position.y, z: warp.position.z, range: 4 } },
        { skill: 'wait', params: { ms: 5000 } }
      ];
    }
    return this._planExplore(state);
  }

  _planFarmFood(state) {
    if (state.planning.foodCount > 0) {
      return [{ skill: 'eat', params: { minFoodLevel: THRESHOLDS.foodComfortable } }];
    }
    return [{ skill: 'farm', params: { crop: 'wheat_seeds', size: 8 } }];
  }

  _planSocialize(state) {
    return [{ skill: 'chat', params: { message: this.personality.getDialogueTone?.() || 'hi' } }];
  }

  _planExplore(state) {
    const waypoints = (state.beliefs?.nearbyFoodSources || [])
      .concat(state.beliefs?.knownNPCs || [])
      .filter(Boolean);
    if (waypoints.length > 0) {
      const target = waypoints[0];
      if (target.position) {
        return [
          { skill: 'move_to', params: { x: target.position.x, y: target.position.y, z: target.position.z, range: 5 } },
          { skill: 'wait', params: { ms: 4000 } }
        ];
      }
    }
    if (state.beliefs?.nearestSafeBase) {
      return [
        { skill: 'move_to', params: { x: state.beliefs.nearestSafeBase.position.x + 10, y: state.beliefs.nearestSafeBase.position.y, z: state.beliefs.nearestSafeBase.position.z + 10, range: 5 } },
        { skill: 'wait', params: { ms: 3000 } }
      ];
    }
    return [
      { skill: 'move_to', params: { x: state.environment.position.x + 12, y: state.environment.position.y, z: state.environment.position.z + 12, range: 5 } },
      { skill: 'wait', params: { ms: 4000 } }
    ];
  }

  decide(snapshot) {
    const extendedSnapshot = { ...snapshot, beliefs: this._buildBeliefs(snapshot) };
    const learning = this._deriveLearningAdjustment(extendedSnapshot);
    const planState = this._buildPlanState(extendedSnapshot);
    const suggestions = this.getSuggestions?.() || [];

    const COOLDOWN_MS = { avoid_hazard: 12000, seek_safety: 8000, eat: 15000, build_base: 30000 };
    const FAILURE_PENALTY_MS = 30000;
    const FAILURE_PENALTY_SCORE = 0.7;
    const _isInCooldown = (name) => {
      const last = this._goalTimestamps[name];
      return last && (Date.now() - last) < (COOLDOWN_MS[name] || 0);
    };
    const _hasRecentFailure = (name) => {
      if (!this.lastFailure || this.lastFailure.taskName !== name) return false;
      return (Date.now() - this.lastFailure.time) < FAILURE_PENALTY_MS;
    };

    let scored = NEEDS.map(n => {
      const advisorBoost = 0;
      let score = Math.min(1, n.score(extendedSnapshot, this.memory, this.personality, this.tom, this.lastInterruptedGoal, learning)
        + advisorBoost);
      if (_hasRecentFailure(n.name)) {
        score = Math.max(0, score - FAILURE_PENALTY_SCORE);
      }
      return {
        need: n.name,
        score,
        make: n.goal,
        advisorBoost,
      };
    }).sort((a, b) => b.score - a.score);

    // Cooldown: skip tasks that ran recently
    const cooldownSkipped = scored.filter(s => _isInCooldown(s.need));
    if (cooldownSkipped.length > 0) {
      const nonCooldown = scored.filter(s => !_isInCooldown(s.need));
      if (nonCooldown.length > 0) scored = nonCooldown;
    }

    // Repetition guard: if same need wins 4+ times in a row, add extra penalty
    const REPETITION_PENALTY_THRESHOLD = 4;
    const REPETITION_PENALTY = 0.3;
    for (const s of scored) {
      const consecutiveWins = this._decisionCount[s.need] || 0;
      if (consecutiveWins >= REPETITION_PENALTY_THRESHOLD) {
        s.score = Math.max(0, s.score - REPETITION_PENALTY);
      }
    }
    scored.sort((a, b) => b.score - a.score);

    const top = scored[0];
    if (!this.personality.allowsRiskyTasks() && ['explore_unknown', 'socialize', 'visit_known_warp'].includes(top.need)) {
      const safer = scored.find(s => s.need === 'seek_safety') || scored[1] || top;
      this.bus?.emit('goal_selected', { need: safer.need, score: safer.score, vetoed: top.need });
      const goal = safer.make(extendedSnapshot, this.memory, this.personality, this.tom, this.lastInterruptedGoal);
      for (const n of NEEDS) this._decisionCount[n.name] = (n.name === safer.need) ? (this._decisionCount[n.name] || 0) + 1 : 0;
      this.lastSelectedNeed = safer.need;
      this._goalTimestamps[safer.need] = Date.now();
      const steps = this._planGoal(goal, planState);
      this.bus?.emit('plan_composed', { goal: goal.name, steps });
      return { task: goal.task || goal.name, steps };
    }

    const goal = top.make(extendedSnapshot, this.memory, this.personality, this.tom, this.lastInterruptedGoal);
    for (const n of NEEDS) this._decisionCount[n.name] = (n.name === top.need) ? (this._decisionCount[n.name] || 0) + 1 : 0;
    this.lastSelectedNeed = top.need;
    this._goalTimestamps[top.need] = Date.now();
    const steps = this._planGoal(goal, planState);
    this.bus?.emit('goal_selected', { need: top.need, score: top.score });
    this.bus?.emit('plan_composed', { goal: goal.name, steps });
    return { task: goal.task || goal.name, steps };
  }
}

// ExecutiveBrain.js
// ─────────────────────────────────────────────────────────────
// PREFRONTAL CORTEX — conscious decision-making.
// Maslow-style survival priority system: dynamic, context-aware
// prioritization that adapts to the bot's current state.
//
// Priority tiers (highest to lowest):
//   1. SURVIVAL: immediate threats, critical hunger, death risk
//   2. SAFETY: nighttime, no shelter, low health
//   3. TOOLS: weapon, pickaxe, armor progression
//   4. FOOD: sustainable food source
//   5. SHELTER: bed, furnace, crafting table
//   6. PROGRESSION: iron gear, diamond, exploration
// ─────────────────────────────────────────────────────────────

import { THRESHOLDS } from './config.js';
import { HTNPlanner } from './HTNPlanner.js';
import { taskNames } from '../domain/tasks.js';
import { resolveCapability, getRelevantCapabilities } from './capabilities.js';
import { QuantumMind } from './QuantumMind.js';
import { ActionMemory } from './NeuralNet.js';

// Helper: detect if it's nighttime (Java Edition)
function _isNighttime(s) {
  const time = s.environment?.timeOfDay ?? 0;
  // Night: 12541–23459 (Java Edition)
  return time > 12541 && time < 23459;
}

// Helper: check if bot has a weapon (sword or axe)
function _hasWeapon(s) {
  const inv = s.resources?.inventory || [];
  return inv.some(i => /_sword|_axe/.test(i.name));
}

// Helper: check if bot has any food
function _hasFood(s) {
  const inv = s.resources?.inventory || [];
  return inv.some(i => /apple|bread|cooked|potato|carrot|mutton|fish|beef|chicken|berry|melon|stew|soup|honey|rotten_flesh/.test(i.name));
}

// Helper: count food items
function _foodCount(s) {
  const inv = s.resources?.inventory || [];
  return inv.filter(i => /apple|bread|cooked|potato|carrot|mutton|fish|beef|chicken|berry|melon|stew|soup|honey|rotten_flesh/.test(i.name))
    .reduce((sum, i) => sum + (i.count || 1), 0);
}

const NEEDS = [
  // ─── TIER 1: SURVIVAL (immediate threats) ──────────────────
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
      const threats = s.threats || [];
      if (threats.length === 0) return 0;
      const nearest = Math.min(...threats.map(t => t.distance ?? 999));
      const hurt = s.vitality.health < THRESHOLDS.healthLow;
      // Immediate danger: close threat, hurt, or swarmed
      if (nearest <= 6 || hurt || threats.length >= 3) {
        return Math.min(1, 0.7 + threats.length * 0.1);
      }
      // Nighttime + threats = higher urgency (can't see well, more spawns)
      if (_isNighttime(s) && nearest <= 12) {
        return Math.min(1, 0.5 + threats.length * 0.08);
      }
      return 0;
    },
    goal: (s) => ({ name: 'seek_safety', task: 'seek_safety', params: {} })
  },

  // ─── TIER 2: SUSTAINED SURVIVAL (food, health) ────────────
  {
    name: 'eat',
    score: (s) => {
      if (s.vitality.food < THRESHOLDS.foodCritical) return 1;
      if (s.vitality.food < THRESHOLDS.foodLow) return 0.8;
      if (!s.vitality.hasFood && s.vitality.food < 16) return 0.5;
      return 0;
    },
    goal: () => ({ name: 'eat', task: 'eat', params: {} })
  },

  // ─── TIER 3: SAFETY (nighttime, shelter) ───────────────────
  {
    name: 'find_shelter',
    score: (s) => {
      const nighttime = _isNighttime(s);
      const noBed = !s.environment?.nearestBed;
      const noBase = !s.beliefs?.nearestSafeBase;
      const hasFood = _hasFood(s);
      // Nighttime without shelter = high urgency
      if (nighttime && noBed && noBase) return 0.85;
      // Nighttime with some food but no bed = medium urgency
      if (nighttime && noBed) return 0.65;
      // Always good to have a bed
      if (noBed && !nighttime) return 0.3;
      return 0;
    },
    goal: () => ({ name: 'find_shelter', task: 'build_base', params: {} })
  },

  // ─── TIER 4: TOOLS (weapon, pickaxe) ───────────────────────
  {
    name: 'get_weapon',
    score: (s) => {
      const hasWeapon = _hasWeapon(s);
      const threats = s.threats || [];
      const nighttime = _isNighttime(s);
      // No weapon + threats nearby = high urgency
      if (!hasWeapon && threats.length > 0) return 0.9;
      // No weapon + nighttime = medium-high urgency
      if (!hasWeapon && nighttime) return 0.7;
      // No weapon + always good to have
      if (!hasWeapon) return 0.4;
      return 0;
    },
    goal: () => ({ name: 'get_weapon', task: 'advance_capability', params: {} })
  },
  {
    name: 'get_tools',
    score: (s) => {
      const inv = s.resources?.inventory || [];
      const hasPickaxe = inv.some(i => /_pickaxe/.test(i.name));
      const hasAxe = inv.some(i => /_axe/.test(i.name));
      // No pickaxe = can't mine = can't progress
      if (!hasPickaxe) return 0.6;
      // No axe = slower wood gathering
      if (!hasAxe) return 0.35;
      return 0;
    },
    goal: () => ({ name: 'get_tools', task: 'advance_capability', params: {} })
  },

  // ─── TIER 5: FOOD PRODUCTION ───────────────────────────────
  {
    name: 'farm_food',
    score: (s) => {
      const foodCnt = _foodCount(s);
      const hasFood = _hasFood(s);
      // Critically low food
      if (s.vitality.food < THRESHOLDS.foodCritical) {
        return hasFood ? 0.9 : 0.6; // eat first, then farm
      }
      // Low food + no储备
      if (s.vitality.food < THRESHOLDS.foodLow && foodCnt < 4) {
        return 0.55;
      }
      // Always good to have backup food
      if (!hasFood && foodCnt === 0) return 0.4;
      return 0;
    },
    goal: (s) => {
      if (_hasFood(s)) {
        return { name: 'farm_food', task: 'eat', params: {} };
      }
      return { name: 'farm_food', task: 'farm_food', params: {} };
    }
  },

  // ─── TIER 6: PROGRESSION ───────────────────────────────────
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
    name: 'socialize',
    score: (s, m, p) => {
      if (s.social.nearbyPlayers.length === 0 || p.traits.sociability <= 0.5) return 0;
      const now = Date.now();
      const last = (s.goalTimestamps?.chat_greet || 0);
      if (now - last < 15000) return 0;
      return 0.2;
    },
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
    this.getActionMemory = opts.getActionMemory || (() => null);
    this.getSensorArray = opts.getSensorArray || (() => null);
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
    // Quantum-cognition arbiter: amplitudes + Born rule + interference
    // replace greedy argmax for need selection (see QuantumMind.js).
    this.quantumMind = new QuantumMind(NEEDS.map(n => n.name));

    this.bus?.on('task_started', ({ taskName, steps, context }) => {
      this.currentGoal = { name: taskName, task: taskName, steps, context: context || null };
    });
    this.bus?.on('task_failed', ({ taskName, error }) => {
      if (this.currentGoal) {
        this.lastInterruptedGoal = this.currentGoal;
      }
      this.lastFailure = { taskName, error, time: Date.now() };
      this.memory?.recordFailure?.(taskName, error);
      // Destructive interference — punished states fall out of superposition.
      this.quantumMind?.observe(taskName, -1);
    });
    this.bus?.on('task_interrupted', ({ taskName }) => {
      if (this.currentGoal) {
        this.lastInterruptedGoal = this.currentGoal;
      }
      this.lastFailure = { taskName, error: 'interrupted', time: Date.now() };
    });
    this.bus?.on('task_completed', ({ taskName }) => {
          this.lastInterruptedGoal = null;
          this.lastFailure = null;
          // Constructive interference — rewarded states gain amplitude.
          this.quantumMind?.observe(taskName, +1);
          if (taskName === 'chat_greet') {
            this._goalTimestamps.chat_greet = Date.now();
          }
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
    // P0-3 HTN-FIRST: src/domain/tasks.js is the canonical plan expansion.
    // The hand-written switch below survives only as fallback for goals not
    // yet ported into the domain (chat_greet, resume_task, idle…).
    const taskName = goal.task || goal.name;
    if (this.htnPlanner && this._htnTasks?.has(taskName)) {
      try {
        const plan = this.htnPlanner.plan(taskName, state);
        const steps = plan?.context?.steps;
        if (steps && steps.length > 0) {
          if (this.lastPlanSource !== 'htn') {
            console.log(`[ExecutiveBrain] Plan via HTN: ${taskName} → ${steps.length} steps`);
          }
          this.lastPlanSource = 'htn';
          return steps;
        }
        // Empty plan = preconditions unmet in a way the domain can't expand;
        // fall through to legacy for resilience.
      } catch (e) {
        console.warn(`[ExecutiveBrain] HTN plan failed for ${taskName}: ${e.message} — legacy fallback`);
      }
    }
    this.lastPlanSource = 'legacy';
    switch (goal.name) {
      case 'avoid_hazard': return this._planAvoidHazard(state);
      case 'seek_safety': return this._planSeekSafety(state);
      case 'eat': return this._planEat(state);
      case 'find_shelter': return this._planFindShelter(state);
      case 'get_weapon': return this._planGetWeapon(state);
      case 'get_tools': return this._planGetTools(state);
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

  _planFindShelter(state) {
    // If we already have a base, go there
    if (state.beliefs?.nearestSafeBase) {
      return [
        { skill: 'move_to', params: { x: state.beliefs.nearestSafeBase.position.x, y: state.beliefs.nearestSafeBase.position.y, z: state.beliefs.nearestSafeBase.position.z, range: 4 } },
        { skill: 'wait', params: { ms: 3000 } }
      ];
    }
    // No base yet — build emergency shelter
    // Collect wood, craft planks, make bed, dig into hillside
    return [
      { skill: 'collect', params: { item: 'log', count: 8 } },
      { skill: 'craft_planks', params: { count: 16 } },
      { skill: 'craft', params: { item: 'crafting_table', count: 1 } },
      { skill: 'craft', params: { item: 'bed', count: 1 } },
      { skill: 'craft', params: { item: 'wooden_door', count: 1 } }
    ];
  }

  _planGetWeapon(state) {
    const inv = state.resources?.inventory || [];
    const hasPickaxe = inv.some(i => /_pickaxe/.test(i.name));
    const hasSword = inv.some(i => /_sword/.test(i.name));
    const hasAxe = inv.some(i => /_axe/.test(i.name));
    const hasCraftingTable = !!state.environment?.nearestWorkstation;

    // If we have no pickaxe, get wood tools first
    if (!hasPickaxe) {
      return [
        { skill: 'collect', params: { item: 'log', count: 6 } },
        { skill: 'craft_planks', params: { count: 12 } },
        { skill: 'craft', params: { item: 'stick', count: 4 } },
        { skill: 'craft', params: { item: 'crafting_table', count: 1 } },
        { skill: 'craft', params: { item: 'wooden_pickaxe', count: 1 } },
        { skill: 'craft', params: { item: 'wooden_sword', count: 1 } },
        { skill: 'equip', params: { item: 'wooden_sword', slot: 'hand' } }
      ];
    }
    // Has pickaxe but no sword — craft stone sword (better than wood)
    if (!hasSword) {
      return [
        { skill: 'collect', params: { item: 'cobblestone', count: 8 } },
        { skill: 'craft', params: { item: 'stone_sword', count: 1 } },
        { skill: 'equip', params: { item: 'stone_sword', slot: 'hand' } }
      ];
    }
    // Has sword but no axe — craft stone axe
    if (!hasAxe) {
      return [
        { skill: 'collect', params: { item: 'cobblestone', count: 6 } },
        { skill: 'craft', params: { item: 'stone_axe', count: 1 } }
      ];
    }
    return [];
  }

  _planGetTools(state) {
    const inv = state.resources?.inventory || [];
    const hasPickaxe = inv.some(i => /_pickaxe/.test(i.name));
    const hasAxe = inv.some(i => /_axe/.test(i.name));

    if (!hasPickaxe) {
      return [
        { skill: 'collect', params: { item: 'log', count: 4 } },
        { skill: 'craft_planks', params: { count: 8 } },
        { skill: 'craft', params: { item: 'stick', count: 4 } },
        { skill: 'craft', params: { item: 'crafting_table', count: 1 } },
        { skill: 'craft', params: { item: 'wooden_pickaxe', count: 1 } },
        { skill: 'equip', params: { item: 'wooden_pickaxe', slot: 'hand' } }
      ];
    }
    // Upgrade to stone if we have cobblestone
    const hasStone = inv.some(i => i.name === 'cobblestone');
    if (hasStone && !inv.some(i => /stone_pickaxe/.test(i.name))) {
      return [
        { skill: 'craft', params: { item: 'stone_pickaxe', count: 1 } },
        { skill: 'equip', params: { item: 'stone_pickaxe', slot: 'hand' } }
      ];
    }
    return [];
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
    // Wood-generic plan: collect logs, convert to planks (species-agnostic),
    // then table + bed. Old version hard-coded oak and failed in spruce forests.
    const collectCount = state.planning.hasCraftingTable || state.planning.hasFurnace ? 8 : 12;
    return [
      { skill: 'collect', params: { item: 'log', count: Math.ceil(collectCount / 4) } },
      { skill: 'craft_planks', params: { count: collectCount } },
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
    const extendedSnapshot = { ...snapshot, beliefs: this._buildBeliefs(snapshot), goalTimestamps: this._goalTimestamps };
    const learning = this._deriveLearningAdjustment(extendedSnapshot);
    const planState = this._buildPlanState(extendedSnapshot);
    const suggestions = this.getSuggestions?.() || [];

    const COOLDOWN_MS = { avoid_hazard: 3000, seek_safety: 2000, eat: 5000, build_base: 10000 };
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
      // P1: learning feedback loop CLOSED — SkillRepository statistics now
      // modulate goal scoring. Goals with proven success get a boost; goals
      // with a history of failure get damped (bounded, so novelty still wins).
      let advisorBoost = 0;
      try {
        const hints = this.getPlannerHints?.(n.name) || {};
        const sr = Number.isFinite(hints.successRate) ? hints.successRate : null;
        if (sr !== null && (hints.bestStrategy || hints.serverSpecificSkill)) {
          // successRate 0..1 → boost −0.08..+0.10; only when we actually
          // have data for this goal (bestStrategy non-null = attempts exist).
          advisorBoost = Math.max(-0.08, Math.min(0.10, (sr - 0.5) * 0.2));
        }
      } catch (_) {}
      // Action-outcome memory: boost/damp based on past results in similar context
      let actionBoost = 0;
      try {
        const am = this.getActionMemory?.();
        const sa = this.getSensorArray?.();
        if (am && sa && this._lastFeatures) {
          actionBoost = am.adjustment(this._lastFeatures, n.name);
        }
      } catch (_) {}
      let score = Math.min(1, n.score(extendedSnapshot, this.memory, this.personality, this.tom, this.lastInterruptedGoal, learning)
        + advisorBoost + actionBoost);
      if (_hasRecentFailure(n.name)) {
        score = Math.max(0, score - FAILURE_PENALTY_SCORE);
      }
      return {
        need: n.name,
        score,
        make: n.goal,
        advisorBoost,
        actionBoost,
      };
    }).sort((a, b) => b.score - a.score);

    // ── Neural cortex steer: predictions modulate need scores ──
    // danger > 0.6  → boost survival goals, damp progression
    // hungerRisk > 0.6 → boost eat/farm_food
    // readiness > 0.7 → boost craft_gear/advance (good state to progress)
    const nn = snapshot._nnPredictions || this._nnPredictions;
    if (nn) {
      const SURVIVAL_TASKS = ['avoid_hazard', 'seek_safety', 'eat'];
      const PROGRESS_TASKS = ['craft_gear', 'advance_capability', 'build_base'];
      if (nn.danger > 0.6) {
        for (const s of scored) {
          if (SURVIVAL_TASKS.includes(s.need)) s.score = Math.min(1, s.score + (nn.danger - 0.5) * 0.6);
          else if (PROGRESS_TASKS.includes(s.need)) s.score = Math.max(0, s.score - (nn.danger - 0.5) * 0.4);
        }
      }
      if (nn.hungerRisk > 0.6) {
        for (const s of scored) {
          if (s.need === 'eat' || s.need === 'farm_food') {
            s.score = Math.min(1, s.score + (nn.hungerRisk - 0.5) * 0.5);
          }
        }
      }
      if (nn.readiness > 0.7) {
        for (const s of scored) {
          if (PROGRESS_TASKS.includes(s.need)) {
            s.score = Math.min(1, s.score + (nn.readiness - 0.6) * 0.3);
          }
        }
      }
      scored.sort((a, b) => b.score - a.score);
    }

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

    // Quantum-cognition arbitration: Born-rule sampling over amplitudes
    // (interference + annealing + tunneling) instead of greedy argmax.
    // Utility scores still set the target magnitudes — the wave function
    // only decides HOW we choose among them.
    const pick = this.quantumMind.arbitrate(scored, this.lastSelectedNeed);
    const top = scored.find(s => s.need === pick.need) || scored[0];
    this.bus?.emit('quantum_decision', { via: pick.via, need: top.need, ...this.quantumMind.describe() });

    // P1: DecisionTrace Planning stage — the full WHY-THIS / WHY-NOT ranking
    // (this was previously never recorded; the dashboard needs it too).
    try {
      const tPlan0 = Date.now();
      this.trace?.recordPlanning?.(
        { topCandidates: scored.slice(0, 5).map(s => ({ need: s.need, score: +s.score.toFixed(3), advisorBoost: +s.advisorBoost.toFixed(3) })) },
        { winner: top.need, via: pick.via },
        `quantum arbitration: ${scored.length} needs; entropy=${this.quantumMind.lastEntropy.toFixed(2)} temp=${this.quantumMind.temperature.toFixed(2)}`,
        Date.now() - tPlan0,
      );
      this.bus?.emit('goal_scores', { scores: scored.map(s => ({ need: s.need, score: +s.score.toFixed(3) })), time: Date.now() });
    } catch (_) {}

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

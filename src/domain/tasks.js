// tasks.js
// ─────────────────────────────────────────────────────────────
// Hierarchical task definitions.
// Maps executive goals → capability-based task decompositions.
// Each task is a compound: it decomposes into sub-tasks/operators.
// The planner expands these until all leaves are operators.
// ─────────────────────────────────────────────────────────────

import { RESOURCES } from './resources.js';

const R = RESOURCES;

export const TASKS = {
  // ─── Survival ──────────────────────────────────────────────

  eat: {
    id: 'eat',
    description: 'Eat food to restore hunger',
    priority: 0.8,
    preconditions: ['hasFood'],
    effects: ['foodRestored'],
    expand: (state) => {
      const steps = [{ operator: 'Use', params: { item: 'food', action: 'eat' } }];
      return { steps };
    },
  },

  seek_safety: {
    id: 'seek_safety',
    description: 'Move to a safe location',
    priority: 0.9,
    preconditions: [],
    effects: ['safe'],
    expand: (state) => {
      if (state.nearestSafeBase) {
        return {
          steps: [
            { operator: 'Travel', params: { target: state.nearestSafeBase.position, range: 3 } },
            { operator: 'Wait', params: { ms: 4000 } },
          ],
        };
      }
      if (state.position) {
        return {
          steps: [
            { operator: 'Escape', params: { destination: 'surface' } },
            { operator: 'Wait', params: { ms: 2000 } },
          ],
        };
      }
      return { steps: [{ operator: 'Escape', params: {} }] };
    },
  },

  avoid_hazard: {
    id: 'avoid_hazard',
    description: 'Avoid environmental hazards',
    priority: 0.95,
    preconditions: [],
    effects: ['safe'],
    expand: (state) => TASKS.seek_safety.expand(state),
  },

  // ─── Food production ───────────────────────────────────────

  farm_food: {
    id: 'farm_food',
    description: 'Establish and harvest a food source',
    priority: 0.6,
    preconditions: [],
    effects: ['hasFood'],
    expand: (state) => {
      const steps = [
        { operator: 'Acquire', params: { resource: 'seeds', count: 3 } },
        { operator: 'Farm', params: { crop: 'wheat_seeds', size: 8 } },
      ];
      return { steps };
    },
  },

  // ─── Gear progression ──────────────────────────────────────

  craft_gear: {
    id: 'craft_gear',
    description: 'Progress equipment to the next tier',
    priority: 0.5,
    preconditions: [],
    effects: ['hasBetterArmor'],
    expand: (state) => {
      const equipped = state.equipment || {};
      const inv = state.inventory || [];

      if (!equipped.hasDiamondArmor && state.equipment?.hasIronArmor && inv.some(i => i.name?.includes('diamond'))) {
        return _expandDiamondGear(state);
      }
      if (state.equipment?.hasDiamondArmor) {
        return { steps: [] };
      }
      return _expandIronGear(state);
    },
  },

  advance_capability: {
    id: 'advance_capability',
    description: 'Climb the tool tier ladder toward iron gear (wood → stone → iron → armor)',
    priority: 0.55,
    preconditions: [],
    effects: ['hasBetterTools'],
    expand: (state) => {
      // Species-agnostic throughout: 'log' collects ANY wood, CraftPlanks
      // converts whatever we hold. Mirrors capabilities.js semantics.
      const sv = state; // already a _buildStateView product
      const inv = Array.isArray(sv.inventory) ? sv.inventory : [];
      const has = (n) => inv.some(i => i?.name === n);
      const hasAny = (pred) => inv.some(i => i?.name && pred(i.name));
      const pickaxeOf = (tier) => inv.some(i => i?.name === `${tier}_pickaxe`);
      const planning = sv.planning || {};
      const steps = [];

      // Tier 0 — bootstrap wood tools
      if (!hasAny(n => n.endsWith('_pickaxe'))) {
        steps.push({ operator: 'Collect', params: { item: 'log', count: 4 } });
        steps.push({ operator: 'CraftPlanks', params: { count: 8 } });
        steps.push({ operator: 'Craft', params: { item: 'stick', count: 4 } });
        steps.push({ operator: 'Craft', params: { item: 'crafting_table', count: 1 } });
        steps.push({ operator: 'Craft', params: { item: 'wooden_pickaxe', count: 1 } });
        steps.push({ operator: 'Equip', params: { item: 'wooden_pickaxe', slot: 'hand' } });
        return { steps };
      }

      // Tier 1 — stone kit + furnace
      if (!pickaxeOf('stone')) {
        steps.push({ operator: 'Collect', params: { item: 'cobblestone', count: 16 } });
        steps.push({ operator: 'Craft', params: { item: 'stone_pickaxe', count: 1 } });
        if (!planning.hasFurnace) {
          steps.push({ operator: 'Craft', params: { item: 'furnace', count: 1 } });
        }
        steps.push({ operator: 'Equip', params: { item: 'stone_pickaxe', slot: 'hand' } });
        return { steps };
      }

      // Tier 2 — iron pipeline
      const ironReady = planning.ironIngotCount > 0 || has('iron_ingot');
      if (!ironReady) {
        if ((planning.coalCount ?? 0) < 6 && !has('coal')) {
          steps.push({ operator: 'Collect', params: { item: 'coal', count: 8 } });
        }
        steps.push({ operator: 'Collect', params: { item: 'iron_ore', count: 12 } });
        steps.push({ operator: 'Smelt', params: { input: 'raw_iron', fuel: 'coal', count: 12 } });
        return { steps };
      }

      // Tier 3 — iron pickaxe then armor pieces
      if (!pickaxeOf('iron')) {
        steps.push({ operator: 'Craft', params: { item: 'iron_pickaxe', count: 1 } });
        steps.push({ operator: 'Equip', params: { item: 'iron_pickaxe', slot: 'hand' } });
        return { steps };
      }
      for (const [piece, slot] of [['iron_sword', 'hand'], ['iron_helmet', 'head'], ['iron_chestplate', 'torso'], ['iron_leggings', 'legs'], ['iron_boots', 'feet']]) {
        if (!has(piece)) {
          steps.push({ operator: 'Craft', params: { item: piece, count: 1 } });
          steps.push({ operator: 'Equip', params: { item: piece, slot } });
          return { steps };
        }
      }

      // Fully geared — nothing to advance
      return { steps: [] };
    },
  },

  // ─── Base building ─────────────────────────────────────────

  build_base: {
    id: 'build_base',
    description: 'Establish a safe base with essentials',
    priority: 0.45,
    preconditions: [],
    effects: ['hasBase'],
    expand: (state) => {
      const env = state.environment || {};
      const hasTable = env.nearestWorkstation || state.inventory?.some(i => i.name === 'crafting_table');
      const hasChest = env.nearestChest || state.inventory?.some(i => i.name === 'chest' || i.name === 'trapped_chest');

      if (state.nearestSafeBase) {
        return {
          steps: [
            { operator: 'Travel', params: { target: state.nearestSafeBase.position, range: 4 } },
            { operator: 'Wait', params: { ms: 3000 } },
          ],
        };
      }

      const steps = [];
      // Collect enough logs for everything once, craft planks once.
      // Generic 'log' = ANY wood species; CraftPlanks converts whatever we hold.
      // table needs 4 planks (1 log), chest needs 8 planks (2 logs)
      if (!hasTable || !hasChest) {
        steps.push({ operator: 'Collect', params: { item: 'log', count: 12 } });
        steps.push({ operator: 'CraftPlanks', params: { count: 16 } });
      }
      if (!hasTable) {
        steps.push({ operator: 'Craft', params: { item: 'crafting_table', count: 1 } });
      }
      if (!hasChest) {
        steps.push({ operator: 'Craft', params: { item: 'chest', count: 1 } });
      }
      if (steps.length === 0) {
        // Already has table and chest — just reinforce
        steps.push({ operator: 'Collect', params: { item: 'log', count: 8 } });
      }
      steps.push({ operator: 'Wait', params: { ms: 1000 } });
      return { steps };
    },
  },

  // ─── Exploration ───────────────────────────────────────────

  visit_known_warp: {
    id: 'visit_known_warp',
    description: 'Travel to a known warp point',
    priority: 0.35,
    preconditions: ['knowsWarp'],
    effects: ['visitedWarp'],
    expand: (state) => {
      const warp = state.nearestWarp;
      if (warp?.position) {
        return {
          steps: [
            { operator: 'Travel', params: { target: warp.position, range: 4 } },
            { operator: 'Wait', params: { ms: 5000 } },
          ],
        };
      }
      return TASKS.explore_unknown.expand(state);
    },
  },

  explore_unknown: {
    id: 'explore_unknown',
    description: 'Explore uncharted territory',
    priority: 0.1,
    preconditions: [],
    effects: ['discovered'],
    expand: (state) => {
      const pos = state.position;
      if (!pos) return { steps: [{ operator: 'Wait', params: { ms: 3000 } }] };
      return {
        steps: [
          { operator: 'Travel', params: { x: pos.x + 12, y: pos.y, z: pos.z + 12, range: 5 } },
          { operator: 'Wait', params: { ms: 4000 } },
        ],
      };
    },
  },

  // ─── Social ────────────────────────────────────────────────

  socialize: {
    id: 'socialize',
    description: 'Greet or engage nearby players',
    priority: 0.2,
    preconditions: [],
    effects: ['socialized'],
    expand: (state) => {
      return {
        steps: [
          { operator: 'Use', params: { item: 'chat', action: 'greet' } },
        ],
      };
    },
  },
};

// ─── Private expansion helpers ─────────────────────────────────

function _expandIronGear(state) {
  const steps = [];
  const inv = state.inventory || [];
  const planning = state.planning || {};

  const hasIronIngots = inv.some(i => i.name === 'iron_ingot');
  const hasRawIron = inv.some(i => i.name === 'raw_iron' || i.name === 'iron_ore');
  const hasFurnace = inv.some(i => i.name === 'furnace') || !!state.environment?.nearestWorkstation;
  const hasCraftingTable = inv.some(i => i.name === 'crafting_table') || !!state.environment?.nearestWorkstation;
  const hasIronPick = inv.some(i => i.name?.includes('iron') && i.name?.includes('pickaxe'));
  const hasPickaxe = inv.some(i => i.name?.includes('pickaxe'));

  // Tool progression: if we lack a pickaxe, craft a wooden one first.
  // Generic wood: 'log' collects any species; CraftPlanks converts what we hold.
  if (!hasPickaxe) {
    steps.push({ operator: 'Collect', params: { item: 'log', count: 4 } });
    steps.push({ operator: 'CraftPlanks', params: { count: 8 } });
    steps.push({ operator: 'Craft', params: { item: 'stick', count: 4 } });
    steps.push({ operator: 'Craft', params: { item: 'wooden_pickaxe', count: 1 } });
    steps.push({ operator: 'Equip', params: { item: 'wooden_pickaxe', slot: 'hand' } });
    return { steps };
  }

  if (state.equipment?.hasIronArmor) {
    steps.push({ operator: 'Equip', params: { item: 'iron_chestplate', slot: 'torso' } });
    return { steps };
  }

  if (planning.ironIngotCount >= 8) {
    if (hasCraftingTable) {
      steps.push({ operator: 'Craft', params: { item: 'iron_chestplate', count: 1 } });
      steps.push({ operator: 'Craft', params: { item: 'iron_leggings', count: 1 } });
    } else {
      steps.push({ operator: 'Acquire', params: { resource: 'crafting_table', count: 1 } });
      steps.push({ operator: 'Craft', params: { item: 'iron_chestplate', count: 1 } });
      steps.push({ operator: 'Craft', params: { item: 'iron_leggings', count: 1 } });
    }
    steps.push({ operator: 'Equip', params: { item: 'iron_chestplate', slot: 'torso' } });
    return { steps };
  }

  if (hasRawIron && hasFurnace) {
    steps.push({ operator: 'Smelt', params: { input: 'raw_iron', count: Math.min(8, planning.rawIronCount || 0), fuel: 'coal' } });
    if (hasCraftingTable) {
      steps.push({ operator: 'Craft', params: { item: 'iron_chestplate', count: 1 } });
    } else {
      steps.push({ operator: 'Acquire', params: { resource: 'crafting_table', count: 1 } });
      steps.push({ operator: 'Craft', params: { item: 'iron_chestplate', count: 1 } });
    }
    steps.push({ operator: 'Equip', params: { item: 'iron_chestplate', slot: 'torso' } });
    return { steps };
  }

  if (hasRawIron && state.nearestSafeBase) {
    steps.push({ operator: 'Travel', params: { target: state.nearestSafeBase.position, range: 4 } });
    steps.push({ operator: 'Smelt', params: { input: 'raw_iron', count: Math.min(8, planning.rawIronCount || 0), fuel: 'coal' } });
    if (!hasCraftingTable) steps.push({ operator: 'Acquire', params: { resource: 'crafting_table', count: 1 } });
    steps.push({ operator: 'Craft', params: { item: 'iron_chestplate', count: 1 } });
    steps.push({ operator: 'Equip', params: { item: 'iron_chestplate', slot: 'torso' } });
    return { steps };
  }

  steps.push({ operator: 'Collect', params: { item: 'raw_iron', count: 8 } });
  if (!hasFurnace) {
    steps.push({ operator: 'Collect', params: { item: 'cobblestone', count: 8 } });
    steps.push({ operator: 'Craft', params: { item: 'furnace', count: 1 } });
  }
  steps.push({ operator: 'Smelt', params: { input: 'raw_iron', count: 8, fuel: 'coal' } });
  if (!hasCraftingTable) {
    steps.push({ operator: 'Acquire', params: { resource: 'crafting_table', count: 1 } });
  }
  steps.push({ operator: 'Craft', params: { item: 'iron_chestplate', count: 1 } });
  return { steps };
}

function _expandDiamondGear(state) {
  const steps = [];
  const inv = state.inventory || [];
  const hasCraftingTable = inv.some(i => i.name === 'crafting_table') || !!state.environment?.nearestWorkstation;

  steps.push({ operator: 'Collect', params: { item: 'diamond', count: 3 } });
  if (!hasCraftingTable) steps.push({ operator: 'Acquire', params: { resource: 'crafting_table', count: 1 } });
  steps.push({ operator: 'Craft', params: { item: 'diamond_chestplate', count: 1 } });
  return { steps };
}

export function getTask(id) {
  return TASKS[id] || null;
}

export function taskNames() {
  return Object.keys(TASKS);
}

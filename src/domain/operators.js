// operators.js
// ─────────────────────────────────────────────────────────────
// Capability-based operator definitions.
// Each operator represents a capability the bot can perform.
// Preconditions must hold before execution; effects hold after.
// The Behavior Tree handles actual execution — the planner
// only composes operators into task graphs.
// ─────────────────────────────────────────────────────────────

export const OPERATORS = {
  Acquire: {
    id: 'Acquire',
    description: 'Obtain a resource (mine, loot, trade, collect)',
    preconditions: ['canReach'],
    effects: ['hasItem'],
    btSkills: ['collect', 'interact'],
    params: { resource: null, count: 1 },
  },

  Travel: {
    id: 'Travel',
    description: 'Move to a position, warp, player, or NPC',
    preconditions: ['knowsPosition'],
    effects: ['atPosition'],
    btSkills: ['move_to', 'warp'],
    params: { target: null, range: 4 },
  },

  Interact: {
    id: 'Interact',
    description: 'Interact with a block or entity',
    preconditions: ['canReach'],
    effects: ['interacted'],
    btSkills: ['interact'],
    params: { target: null, action: 'use' },
  },

  Craft: {
    id: 'Craft',
    description: 'Craft an item at a workstation',
    preconditions: ['hasMaterials', 'hasWorkstation'],
    effects: ['hasItem'],
    btSkills: ['craft'],
    params: { item: null, count: 1 },
  },

  CraftPlanks: {
    id: 'CraftPlanks',
    description: 'Convert ANY held wood (log/wood/stem/hyphae) into its planks — species-agnostic',
    preconditions: ['hasItem'],
    effects: ['hasPlanks'],
    btSkills: ['craft_planks'],
    params: { count: 8 },
  },

  Smelt: {
    id: 'Smelt',
    description: 'Smelt an item in a furnace',
    preconditions: ['hasFuel', 'hasFurnace'],
    effects: ['hasSmeltedItem'],
    btSkills: ['smelt'],
    params: { input: null, output: null, count: 1, fuel: 'coal' },
  },

  Farm: {
    id: 'Farm',
    description: 'Farm a crop',
    preconditions: ['hasSeeds', 'hasFarmland'],
    effects: ['hasHarvest'],
    btSkills: ['farm'],
    params: { crop: null, size: 8 },
  },

  Use: {
    id: 'Use',
    description: 'Use/consume an item',
    preconditions: ['hasItem'],
    effects: ['itemUsed'],
    btSkills: ['eat', 'equip'],
    params: { item: null, action: null },
  },

  Equip: {
    id: 'Equip',
    description: 'Equip an item to a slot',
    preconditions: ['hasItem'],
    effects: ['equipped'],
    btSkills: ['equip'],
    params: { item: null, slot: null },
  },

  Combat: {
    id: 'Combat',
    description: 'Engage a threat',
    preconditions: ['hasWeapon', 'targetReachable'],
    effects: ['threatEliminated'],
    btSkills: ['combat'],
    params: { target: null },
  },

  Escape: {
    id: 'Escape',
    description: 'Flee from danger',
    preconditions: [],
    effects: ['safe'],
    btSkills: ['go_surface', 'move_to'],
    params: { destination: null },
  },

  Observe: {
    id: 'Observe',
    description: 'Scan environment, check GUI, read chat',
    preconditions: [],
    effects: ['knowsAbout'],
    btSkills: ['scan'],
    params: { target: null },
  },

  Wait: {
    id: 'Wait',
    description: 'Wait for a duration or condition',
    preconditions: [],
    effects: ['timePassed'],
    btSkills: ['wait'],
    params: { ms: 1000, until: null },
  },

  Collect: {
    id: 'Collect',
    description: 'Gather a specific block from the environment',
    preconditions: ['blockReachable', 'hasPickaxe'],
    effects: ['hasItem'],
    btSkills: ['collect', 'dig_down', 'strip_mine'],
    params: { item: null, count: 1 },
  },
};

export function getOperator(name) {
  return OPERATORS[name] || null;
}

export function operatorNames() {
  return Object.keys(OPERATORS);
}

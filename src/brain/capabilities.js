// capabilities.js
// ─────────────────────────────────────────────────────────────
// Capability resolution: "what can the bot do, and what's the
// cheapest path to unlock what it can't?"
//
// FIXES vs old version:
//  - No longer oak-locked. Any log/planks species satisfies wood
//    requirements (spruce_log crafts spruce_planks; sticks accept
//    ANY planks — matching vanilla crafting rules).
//  - Ingredient planning uses generic categories resolved against
//    the ACTUAL inventory at plan time.
// ─────────────────────────────────────────────────────────────

const CAPABILITIES = {
  canChopWood:     { satisfiedBy: ['wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe'] },
  canMineStone:    { satisfiedBy: ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'] },
  canMineIron:     { satisfiedBy: ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'] },
  canMineDiamond:  { satisfiedBy: ['iron_pickaxe', 'diamond_pickaxe'] },
  canFight:        { satisfiedBy: ['wooden_sword', 'stone_sword', 'iron_sword', 'diamond_sword'] },
  canSmelt:        { satisfiedBy: ['furnace'], requiresPlaced: true },
  canStoreItems:   { satisfiedBy: ['chest'], requiresPlaced: true },
};

const WOOD_SPECIES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'];

function planksOfAnySpecies() {
  return WOOD_SPECIES.map(s => `${s}_planks`);
}
function logsOfAnySpecies() {
  return WOOD_SPECIES.map(s => `${s}_log`);
}

/**
 * Which craftable item does `itemName` depend on?
 * Returns a list of acceptable ingredient item names.
 */
function acceptableIngredients(itemName) {
  switch (itemName) {
    case 'crafting_table':
    case 'chest':
      return planksOfAnySpecies();          // any planks work
    case 'stick':
      return planksOfAnySpecies();
    case 'wooden_pickaxe':
    case 'wooden_axe':
    case 'wooden_sword':
    case 'wooden_shovel':
    case 'wooden_hoe':
      return planksOfAnySpecies();
    case 'stone_pickaxe':
    case 'stone_axe':
    case 'stone_sword':
    case 'stone_shovel':
    case 'furnace':
      return ['cobblestone'];
    default:
      return null;
  }
}

/** Recipe dependency table for items we plan around (generic wood-aware). */
const RECIPE_DEPS = {
  wooden_pickaxe: { needs: { any_planks: 3, stick: 2 }, requiresTable: true },
  wooden_axe:     { needs: { any_planks: 3, stick: 2 }, requiresTable: true },
  wooden_sword:   { needs: { any_planks: 2, stick: 1 }, requiresTable: true },
  stone_pickaxe:  { needs: { cobblestone: 3, stick: 2 }, requiresTable: true },
  stone_axe:      { needs: { cobblestone: 3, stick: 2 }, requiresTable: true },
  stone_sword:    { needs: { cobblestone: 2, stick: 1 }, requiresTable: true },
  iron_pickaxe:   { needs: { iron_ingot: 3, stick: 2 }, requiresTable: true },
  iron_sword:     { needs: { iron_ingot: 2, stick: 1 }, requiresTable: true },
  iron_axe:       { needs: { iron_ingot: 3, stick: 2 }, requiresTable: true },
  furnace:        { needs: { cobblestone: 8 }, requiresTable: true },
  chest:          { needs: { any_planks: 8 }, requiresTable: true },
  crafting_table: { needs: { any_planks: 4 }, requiresTable: false },
  stick:          { needs: { any_planks: 2 }, requiresTable: false },
  iron_ingot:     { needs: { raw_iron: 1 }, requiresSmelting: true },
};

function countInInventory(inventory, itemName) {
  if (!inventory || !Array.isArray(inventory)) return 0;
  if (typeof itemName === 'string' && itemName.startsWith('any_')) {
    const kind = itemName.slice(4); // 'planks' | 'log'
    return inventory.reduce((sum, item) => {
      if (!item) return sum;
      const name = typeof item === 'string' ? item : (item.name || '');
      return name.endsWith('_' + kind) ? sum + (item.count || 1) : sum;
    }, 0);
  }
  return inventory.reduce((sum, item) => {
    if (!item) return sum;
    const name = typeof item === 'string' ? item : (item.name || item.itemId || '');
    const count = typeof item === 'object' ? (item.count || 1) : 1;
    return name === itemName ? sum + count : sum;
  }, 0);
}

/** Pick which concrete log/planks species we already hold most of (for concrete crafts). */
function pickConcreteSpecies(inventory, kind) {
  // Prefer a species we already hold some of, else oak, else first known.
  for (const s of WOOD_SPECIES) {
    if (countInInventory(inventory, `${s}_${kind}`) > 0) return s;
  }
  return 'oak';
}

function findCheapest(satisfiedBy, inventory, placedBlocks, requiresPlaced) {
  const tierOrder = ['wooden', 'stone', 'iron', 'diamond'];
  let best = null;
  let bestTier = Infinity;
  for (const item of satisfiedBy) {
    const hasIt = countInInventory(inventory, item) > 0;
    const hasPlaced = placedBlocks && placedBlocks.includes(item);
    if (requiresPlaced) {
      if (hasPlaced) return { item, satisfied: true };
    } else {
      if (hasIt) return { item, satisfied: true };
    }
    const tier = tierOrder.findIndex(t => item.startsWith(t));
    const tierIdx = tier >= 0 ? tier : tierOrder.length;
    if (tierIdx < bestTier) {
      bestTier = tierIdx;
      best = item;
    }
  }
  return { item: best, satisfied: false };
}

function inventoryHas(inventory, itemName, count = 1) {
  return countInInventory(inventory, itemName) >= count;
}

function isCollectableBaseResource(itemName) {
  // Any species of log/wood/stem is directly collectable from trees.
  if (itemName === 'any_log') return true;
  if (itemName === 'log' || /(^|_)(log|wood|stem|hyphae)$/.test(itemName)) return true;
  const baseResources = ['cobblestone', 'raw_iron', 'coal', 'stone', 'dirt', 'gravel', 'sand'];
  return baseResources.includes(itemName);
}

/**
 * Handle generic wood categories (any_planks / any_log).
 * Returns null when itemName is not a category.
 * FIX: old code leaked 'any_planks' into collect steps — planks don't
 * exist as world blocks, so the bot wandered on pointless expeditions.
 */
function resolveCategory(itemName, inventory, placedBlocks, visited) {
  if (itemName !== 'any_planks' && itemName !== 'any_log') return null;

  const kind = itemName.slice(4); // 'planks' | 'log'
  if (inventoryHas(inventory, itemName, 1)) return { satisfied: true, steps: [] };

  if (kind === 'log') {
    // Logs are directly collectable from trees; TaskRunner resolves
    // item:'log' to whichever species actually grows nearby.
    return {
      satisfied: false,
      steps: [{ skill: 'collect', params: { item: 'log', count: 4 } }],
      reason: 'need wood (any species)',
    };
  }

  // planks: never collectable — must be crafted from logs.
  const logResult = resolveCategory('any_log', inventory, placedBlocks, visited);
  return {
    satisfied: false,
    // craft_planks converts whatever log species we collected into planks.
    steps: [...logResult.steps, { skill: 'craft_planks', params: { count: 8 } }],
    reason: 'need planks (will craft from collected logs)',
  };
}

function resolveItem(itemName, inventory, placedBlocks, visited = new Set()) {
  if (visited.has(itemName)) return { satisfied: false, steps: [], reason: 'circular_dependency' };
  visited.add(itemName);

  // Generic wood categories (any_planks / any_log) have their own resolver
  const catResult = resolveCategory(itemName, inventory, placedBlocks, visited);
  if (catResult) return catResult;

  // Base resources are collectable directly
  if (isCollectableBaseResource(itemName)) {
    if (inventoryHas(inventory, itemName, 1)) {
      return { satisfied: true, steps: [] };
    }
    return { satisfied: false, steps: [{ skill: 'collect', params: { item: itemName, count: 4 } }], reason: `need ${itemName}` };
  }

  // Check if already in inventory
  if (inventoryHas(inventory, itemName, 1)) {
    return { satisfied: true, steps: [] };
  }

  const recipe = RECIPE_DEPS[itemName];
  if (!recipe) {
    // Unknown item — try collecting it
    return { satisfied: false, steps: [{ skill: 'collect', params: { item: itemName, count: 1 } }], reason: `unknown item ${itemName}` };
  }

  const allSteps = [];

  // Prerequisite: a crafting table. FIX: old code RETURNED the table plan,
  // silently dropping the tool craft from the same plan. Now we prepend
  // table acquisition and keep planning the item itself.
  if (recipe.requiresTable && !inventoryHas(inventory, 'crafting_table', 1) && !(placedBlocks && placedBlocks.includes('crafting_table'))) {
    const tableResult = resolveItem('crafting_table', inventory, placedBlocks, new Set(visited));
    if (!tableResult.satisfied) {
      allSteps.push(...tableResult.steps);
    } else {
      allSteps.push({ skill: 'place_nearby', params: { block: 'crafting_table' } });
    }
  }

  // Prerequisite: smelting fuel
  if (recipe.requiresSmelting) {
    const fuelResult = resolveItem('coal', inventory, placedBlocks, new Set(visited));
    if (!fuelResult.satisfied) allSteps.push(...fuelResult.steps);
  }

  // Resolve all ingredient needs
  for (const [ingredient, neededCount] of Object.entries(recipe.needs)) {
    const haveCount = countInInventory(inventory, ingredient);
    if (haveCount >= neededCount) continue;

    const ingResult = resolveItem(ingredient, inventory, placedBlocks, new Set(visited));
    if (!ingResult.satisfied) {
      allSteps.push(...ingResult.steps);
    }
  }

  // Add the craft step for the item itself
  allSteps.push({ skill: 'craft', params: { item: itemName, count: 1 } });
  return { satisfied: false, steps: allSteps, reason: `need to craft ${itemName}` };
}

export function resolveCapability(inventory, capabilityName, placedBlocks = []) {
  const cap = CAPABILITIES[capabilityName];
  if (!cap) return { satisfied: false, steps: [], reason: `unknown capability: ${capabilityName}` };

  const cheapest = findCheapest(cap.satisfiedBy, inventory, placedBlocks, cap.requiresPlaced);
  if (cheapest.satisfied) return { satisfied: true, steps: [] };

  if (!cheapest.item) return { satisfied: false, steps: [], reason: `no valid item path for ${capabilityName}` };

  const result = resolveItem(cheapest.item, inventory, placedBlocks);
  if (result.satisfied) return { satisfied: true, steps: [] };

  const normalized = normalizeSteps(result.steps);

  return { satisfied: false, steps: normalized, reason: result.reason || `need ${cheapest.item}` };
}

/**
 * Clean up a plan:
 *  - merge repeated wood collects into one bigger collect up front
 *  - keep only the first plank-conversion step
 * Without this, plans looked like: collect log → convert → craft →
 * collect log → collect log → craft … (the resolver re-derives the
 * log→planks chain independently for every ingredient).
 */
function normalizeSteps(steps) {
  const out = [];
  let logCollectDone = false;
  let planksConvertSeen = false;
  let totalLogs = 0;
  // First pass: sum log needs, detect structure
  for (const s of steps) {
    if (s.skill === 'collect' && s.params?.item === 'log') totalLogs += s.params.count || 4;
  }
  for (const s of steps) {
    if (s.skill === 'collect' && s.params?.item === 'log') {
      if (logCollectDone) continue;
      logCollectDone = true;
      out.push({ skill: 'collect', params: { item: 'log', count: Math.max(totalLogs, 4) } });
      continue;
    }
    if (s.skill === 'craft_planks') {
      if (planksConvertSeen) continue;
      planksConvertSeen = true;
      out.push(s);
      continue;
    }
    // Skip exact back-to-back duplicates
    const prev = out[out.length - 1];
    if (prev && prev.skill === s.skill && JSON.stringify(prev.params) === JSON.stringify(s.params)) continue;
    out.push(s);
  }
  return out;
}

export function getRelevantCapabilities(state) {
  const relevant = [];
  const inv = state.resources?.inventory || [];

  relevant.push('canMineStone');
  relevant.push('canFight');
  relevant.push('canChopWood');

  if (countInInventory(inv, 'raw_iron') > 0 || countInInventory(inv, 'iron_ingot') > 0) {
    relevant.push('canMineIron');
  }

  // Smelting relevant if we have furnace materials or raw ore
  const hasFurnaceInInventory = countInInventory(inv, 'furnace') > 0;
  const hasCobbleForFurnace = countInInventory(inv, 'cobblestone') >= 8;
  if (hasFurnaceInInventory || hasCobbleForFurnace || countInInventory(inv, 'raw_iron') > 0) {
    relevant.push('canSmelt');
  }

  return relevant;
}

export { countInInventory, acceptableIngredients, WOOD_SPECIES };

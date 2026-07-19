const CAPABILITIES = {
  canChopWood:     { satisfiedBy: ['wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe'] },
  canMineStone:    { satisfiedBy: ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'] },
  canMineIron:     { satisfiedBy: ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'] },
  canMineDiamond:  { satisfiedBy: ['iron_pickaxe', 'diamond_pickaxe'] },
  canFight:        { satisfiedBy: ['wooden_sword', 'stone_sword', 'iron_sword', 'diamond_sword'] },
  canSmelt:        { satisfiedBy: ['furnace'], requiresPlaced: true },
  canStoreItems:   { satisfiedBy: ['chest'], requiresPlaced: true },
};

const RECIPE_DEPS = {
  wooden_pickaxe: { needs: { oak_planks: 3, stick: 2 }, requiresTable: true },
  wooden_axe:     { needs: { oak_planks: 3, stick: 2 }, requiresTable: true },
  wooden_sword:   { needs: { oak_planks: 2, stick: 1 }, requiresTable: true },
  stone_pickaxe:  { needs: { cobblestone: 3, stick: 2 }, requiresTable: true },
  stone_axe:      { needs: { cobblestone: 3, stick: 2 }, requiresTable: true },
  stone_sword:    { needs: { cobblestone: 2, stick: 1 }, requiresTable: true },
  iron_pickaxe:   { needs: { iron_ingot: 3, stick: 2 }, requiresTable: true },
  iron_sword:     { needs: { iron_ingot: 2, stick: 1 }, requiresTable: true },
  iron_axe:       { needs: { iron_ingot: 3, stick: 2 }, requiresTable: true },
  furnace:        { needs: { cobblestone: 8 }, requiresTable: false },
  chest:          { needs: { oak_planks: 8 }, requiresTable: false },
  crafting_table: { needs: { oak_planks: 4 }, requiresTable: false },
  stick:          { needs: { oak_planks: 2 }, requiresTable: false },
  oak_planks:     { needs: { oak_log: 1 }, requiresTable: false },
  iron_ingot:     { needs: { raw_iron: 1 }, requiresSmelting: true },
};

function countInInventory(inventory, itemName) {
  if (!inventory || !Array.isArray(inventory)) return 0;
  return inventory.reduce((sum, item) => {
    if (!item) return sum;
    const name = typeof item === 'string' ? item : (item.name || item.itemId || '');
    const count = typeof item === 'object' ? (item.count || 1) : 1;
    return name === itemName ? sum + count : sum;
  }, 0);
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
  const baseResources = ['oak_log', 'cobblestone', 'raw_iron', 'coal', 'stone', 'dirt', 'gravel', 'sand'];
  return baseResources.includes(itemName);
}

function resolveItem(itemName, inventory, placedBlocks, visited = new Set()) {
  if (visited.has(itemName)) return { satisfied: false, steps: [], reason: 'circular_dependency' };
  visited.add(itemName);

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

  // Check if craftable
  const recipe = RECIPE_DEPS[itemName];
  if (!recipe) {
    // Unknown item — try collecting it
    return { satisfied: false, steps: [{ skill: 'collect', params: { item: itemName, count: 1 } }], reason: `unknown item ${itemName}` };
  }

  // Check for placed prerequisite
  if (recipe.requiresTable && !inventoryHas(inventory, 'crafting_table', 1) && !(placedBlocks && placedBlocks.includes('crafting_table'))) {
    const tableResult = resolveItem('crafting_table', inventory, placedBlocks, visited);
    if (!tableResult.satisfied) return tableResult;
  }

  // Smelting prerequisite
  if (recipe.requiresSmelting) {
    const fuelResult = resolveItem('coal', inventory, placedBlocks, visited);
    if (!fuelResult.satisfied) return fuelResult;
  }

  // Resolve all ingredient needs
  const allSteps = [];
  for (const [ingredient, neededCount] of Object.entries(recipe.needs)) {
    const haveCount = countInInventory(inventory, ingredient);
    if (haveCount >= neededCount) continue;

    const needed = neededCount - haveCount;
    const ingResult = resolveItem(ingredient, inventory, placedBlocks, visited);
    if (!ingResult.satisfied) {
      for (const step of ingResult.steps) {
        allSteps.push(step);
      }
    }
  }

  // Re-check inventory after ingredients resolved
  if (inventoryHas(inventory, itemName, 1)) {
    return { satisfied: true, steps: allSteps };
  }

  // Add the craft step
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

  // Deduplicate adjacent steps (same skill + item)
  const deduplicated = [];
  for (const step of result.steps) {
    const last = deduplicated[deduplicated.length - 1];
    if (last && last.skill === step.skill && JSON.stringify(last.params) === JSON.stringify(step.params)) continue;
    deduplicated.push(step);
  }

  return { satisfied: false, steps: deduplicated, reason: result.reason || `need ${cheapest.item}` };
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

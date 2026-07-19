// predicates.js
// ─────────────────────────────────────────────────────────────
// Predicate functions — the planner reasons over these.
// Each predicate returns a boolean given the current world state.
// ─────────────────────────────────────────────────────────────

import { RESOURCES, resourceTypes } from './resources.js';

export function hasItem(state, resourceId) {
  const types = resourceTypes(resourceId);
  if (!types || types.length === 0) return false;
  const inventory = state.inventory || [];
  return types.some(t => inventory.some(i => i.name === t || i.name?.includes(t)));
}

export function hasItemCount(state, resourceId, minCount = 1) {
  const types = resourceTypes(resourceId);
  if (!types) return false;
  const inventory = state.inventory || [];
  let total = 0;
  for (const item of inventory) {
    if (types.some(t => item.name === t || item.name?.includes(t))) {
      total += item.count || 1;
    }
  }
  return total >= minCount;
}

export function hasFood(state) {
  const foodTypes = [...(RESOURCES.FOOD_VEGETABLE?.types || []), ...(RESOURCES.FOOD_BREAD?.types || []), ...(RESOURCES.FOOD_MEAT?.types || [])];
  return (state.inventory || []).some(i => foodTypes.some(t => i.name === t || i.name?.includes(t)));
}

export function isHungry(state) {
  return (state.food ?? 20) < 16;
}

export function isStarving(state) {
  return (state.food ?? 20) < 8;
}

export function isSafe(state) {
  return !(state.threats?.length > 0) && !(state.hazardsNearby);
}

export function knowsWarp(state) {
  return (state.knownWarpCount || 0) > 0;
}

export function isNight(state) {
  return !!state.isNight;
}

export function enemyNearby(state) {
  return (state.threats?.length || 0) > 0;
}

export function hasBase(state) {
  return !!state.hasSafeBase || (state.nearestSafeBase != null);
}

export function hasTool(state, toolType) {
  const inv = state.inventory || [];
  if (toolType === 'any_pickaxe') return inv.some(i => i.name?.includes('pickaxe'));
  if (toolType === 'iron_pickaxe') return inv.some(i => i.name?.includes('iron') && i.name?.includes('pickaxe'));
  if (toolType === 'stone_pickaxe') return inv.some(i => i.name?.includes('stone') && i.name?.includes('pickaxe'));
  if (toolType === 'any_weapon') return inv.some(i => i.name?.includes('sword') || i.name?.includes('axe'));
  return false;
}

export function hasWorkstation(state, workstationType) {
  const inv = state.inventory || [];
  if (workstationType === 'crafting_table') return inv.some(i => i.name === 'crafting_table') || !!state.environment?.nearestWorkstation;
  if (workstationType === 'furnace') return inv.some(i => i.name === 'furnace') || !!state.environment?.nearestWorkstation;
  return false;
}

export function hasArmor(state, tier = 'any') {
  const inv = state.inventory || [];
  if (tier === 'any') return inv.some(i => i.name?.includes('chestplate') || i.name?.includes('leggings') || i.name?.includes('boots') || i.name?.includes('helmet'));
  if (tier === 'iron') return inv.some(i => i.name?.includes('iron') && (i.name?.includes('chestplate') || i.name?.includes('leggings') || i.name?.includes('boots')));
  if (tier === 'diamond') return inv.some(i => i.name?.includes('diamond') && (i.name?.includes('chestplate') || i.name?.includes('leggings') || i.name?.includes('boots')));
  return false;
}

export function hasFullyEquipped(state) {
  return (state.equipment?.armorSlots || 0) >= 3;
}

export function knowsPosition(state, posName) {
  return !!(state.knownWarps || []).some(w => w.name === posName) || !!(state.knownLocations || {})[posName];
}

export function canReach(state, distance = 10) {
  return true;
}

export function hungerCritical(state) {
  return (state.food ?? 20) < 8;
}

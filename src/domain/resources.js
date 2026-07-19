// resources.js
// ─────────────────────────────────────────────────────────────
// Centralized resource definitions.
// Avoids scattered string literals across the planner.
// ─────────────────────────────────────────────────────────────

export const RESOURCES = {
  WOOD:            { id: 'wood',            name: 'Wood',            types: ['oak_log', 'spruce_log', 'birch_log', 'jungle_log'], category: 'material' },
  PLANKS:          { id: 'planks',          name: 'Planks',          types: ['oak_planks'], category: 'material' },
  STICK:           { id: 'stick',           name: 'Stick',           types: ['stick'], category: 'material' },
  STONE:           { id: 'stone',           name: 'Stone',           types: ['cobblestone', 'stone'], category: 'material' },
  COAL:            { id: 'coal',            name: 'Coal',            types: ['coal', 'charcoal'], category: 'fuel' },
  IRON:            { id: 'iron',            name: 'Iron',            types: ['iron_ingot', 'raw_iron', 'iron_ore'], category: 'metal' },
  GOLD:            { id: 'gold',            name: 'Gold',            types: ['gold_ingot', 'raw_gold', 'gold_ore'], category: 'metal' },
  DIAMOND:         { id: 'diamond',         name: 'Diamond',         types: ['diamond', 'diamond_ore'], category: 'gem' },
  FOOD_VEGETABLE:  { id: 'food_vegetable',  name: 'Vegetable Food',  types: ['carrot', 'potato', 'beetroot'], category: 'food' },
  FOOD_BREAD:      { id: 'food_bread',      name: 'Bread',           types: ['bread', 'cooked_beef', 'cooked_porkchop'], category: 'food' },
  FOOD_MEAT:       { id: 'food_meat',       name: 'Meat Food',       types: ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken'], category: 'food' },
  SEEDS:           { id: 'seeds',           name: 'Seeds',           types: ['wheat_seeds'], category: 'material' },
  TORCH:           { id: 'torch',           name: 'Torch',           types: ['torch'], category: 'tool' },
  CRAFTING_TABLE:  { id: 'crafting_table',  name: 'Crafting Table',  types: ['crafting_table'], category: 'block' },
  FURNACE:         { id: 'furnace',         name: 'Furnace',         types: ['furnace'], category: 'block' },
  CHEST:           { id: 'chest',           name: 'Chest',           types: ['chest', 'trapped_chest'], category: 'block' },
  BED:             { id: 'bed',             name: 'Bed',             types: ['red_bed', 'white_bed'], category: 'block' },
  WOODEN_PICKAXE:  { id: 'wooden_pickaxe',  name: 'Wooden Pickaxe',  types: ['wooden_pickaxe'], category: 'tool' },
  STONE_PICKAXE:   { id: 'stone_pickaxe',   name: 'Stone Pickaxe',   types: ['stone_pickaxe'], category: 'tool' },
  IRON_PICKAXE:    { id: 'iron_pickaxe',    name: 'Iron Pickaxe',    types: ['iron_pickaxe'], category: 'tool' },
  DIAMOND_PICKAXE: { id: 'diamond_pickaxe', name: 'Diamond Pickaxe', types: ['diamond_pickaxe'], category: 'tool' },
  IRON_SWORD:      { id: 'iron_sword',      name: 'Iron Sword',      types: ['iron_sword'], category: 'tool' },
  DIAMOND_SWORD:   { id: 'diamond_sword',   name: 'Diamond Sword',   types: ['diamond_sword'], category: 'tool' },
  IRON_CHESTPLATE: { id: 'iron_chestplate', name: 'Iron Chestplate', types: ['iron_chestplate'], category: 'armor' },
  IRON_LEGGINGS:   { id: 'iron_leggings',   name: 'Iron Leggings',   types: ['iron_leggings'], category: 'armor' },
  IRON_BOOTS:      { id: 'iron_boots',      name: 'Iron Boots',      types: ['iron_boots'], category: 'armor' },
  DIAMOND_CHESTPLATE: { id: 'diamond_chestplate', name: 'Diamond Chestplate', types: ['diamond_chestplate'], category: 'armor' },
  DIAMOND_LEGGINGS:   { id: 'diamond_leggings',   name: 'Diamond Leggings',   types: ['diamond_leggings'], category: 'armor' },
  DIAMOND_BOOTS:      { id: 'diamond_boots',      name: 'Diamond Boots',      types: ['diamond_boots'], category: 'armor' },
};

export function getResourceByType(mcItemName) {
  const key = Object.values(RESOURCES).find(r => r.types.includes(mcItemName));
  return key || null;
}

export function resourceTypes(resourceId) {
  return RESOURCES[resourceId]?.types || [];
}

export function resourceCategory(resourceId) {
  return RESOURCES[resourceId]?.category || null;
}

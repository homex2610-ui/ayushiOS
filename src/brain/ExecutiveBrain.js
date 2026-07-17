// ExecutiveBrain.js
// ─────────────────────────────────────────────────────────────
// PREFRONTAL CORTEX — conscious decision-making.
// Instead of a rigid if/else priority chain, every competing
// "need" scores itself against the current snapshot, and the
// Executive Brain picks whichever need is screaming loudest.
// This is closer to how real motivation works (hunger, fear,
// and boredom all pull at once — biggest pull wins) and makes
// it trivial to add new needs later without breaking old ones.
// ─────────────────────────────────────────────────────────────

import { THRESHOLDS } from './config.js';

// Each need: (snapshot, memory, personality, tom) -> { score 0-1, goal }
const NEEDS = [
  {
    name: 'eat',
    score: (s) => s.vitality.food < THRESHOLDS.foodCritical ? 1
                 : s.vitality.food < THRESHOLDS.foodLow ? 0.6 : 0,
    goal: () => ({ task: 'auto_feed', steps: [
      { skill: 'eat', params: { minFoodLevel: THRESHOLDS.foodComfortable } }
    ]})
  },
  {
    name: 'flee_or_shelter',
    score: (s, m, p) => {
      if (s.threats.length === 0) return 0;
      const scared = 1 - p.traits.bravery;
      return Math.min(1, 0.4 + s.threats.length * 0.2 * scared);
    },
    goal: (s) => ({ task: 'seek_safety', steps: [
      { skill: 'flee_or_barricade', params: { threats: s.threats } }
    ]})
  },
  {
    name: 'sleep',
    score: (s) => (s.environment.isNight && s.environment.nearestBed) ? 0.5 : 0,
    goal: (s) => ({ task: 'auto_sleep', steps: [
      { skill: 'interact', params: { blockName: s.environment.nearestBed.name, action: 'sleep' } }
    ]})
  },
  {
    name: 'avoid_enemy',
    score: (s, m, p, tom) => {
      const nearest = s.social.nearbyPlayers[0];
      if (!nearest) return 0;
      const risk = tom ? tom.predictRisk(nearest.username) : 0;
      return risk > 0.5 ? risk : 0;
    },
    goal: (s) => ({ task: 'disengage', steps: [
      { skill: 'move_away_from', params: { username: s.social.nearbyPlayers[0]?.username } }
    ]})
  },
  {
    name: 'mine_diamonds',
    score: (s) => {
      if (s.equipment.hasDiamondArmor && s.equipment.hasDiamondTool) return 0;
      return 0.7;
    },
    goal: () => ({ task: 'mine_for_diamonds', steps: [
      { skill: 'dig_down', params: { distance: 15 } },
      { skill: 'strip_mine', params: { length: 80 } },
      { skill: 'collect', params: { item: 'diamond_ore', count: 12 } },
      { skill: 'go_surface', params: {} }
    ]})
  },
  {
    name: 'craft_gear',
    score: (s) => {
      if (s.equipment.hasDiamondArmor) return 0;
      const hasIron = s.resources.hasOre('iron_ingot') || s.resources.hasOre('raw_iron');
      const hasDiamond = s.resources.hasOre('diamond');
      if (hasDiamond) return 0.8;
      if (hasIron) return 0.6;
      return 0.2;
    },
    goal: (s) => ({ task: 'craft_armor_and_tools', steps: [
      { skill: 'smelt', params: { input: 'raw_iron', count: 12, fuel: 'coal' } },
      { skill: 'craft', params: { item: 'iron_helmet', count: 1 } },
      { skill: 'craft', params: { item: 'iron_chestplate', count: 1 } },
      { skill: 'craft', params: { item: 'iron_leggings', count: 1 } },
      { skill: 'craft', params: { item: 'iron_boots', count: 1 } },
      { skill: 'equip', params: { item: 'iron_helmet', slot: 'head' } },
      { skill: 'equip', params: { item: 'iron_chestplate', slot: 'torso' } },
      { skill: 'equip', params: { item: 'iron_leggings', slot: 'legs' } },
      { skill: 'equip', params: { item: 'iron_boots', slot: 'feet' } },
      { skill: 'craft', params: { item: 'iron_sword', count: 1 } },
      { skill: 'equip', params: { item: 'iron_sword', slot: 'hand' } },
    ]})
  },
  {
    name: 'build_base',
    score: (s) => {
      const hasBase = s.environment.nearestChest && s.environment.nearestBed && s.environment.nearestWorkstation;
      if (hasBase) return 0;
      const hasMaterials = s.resources.hasCraftingTable;
      return hasMaterials ? 0.5 : 0.2;
    },
    goal: () => ({ task: 'build_starter_base', steps: [
      { skill: 'collect', params: { item: 'oak_log', count: 10 } },
      { skill: 'craft', params: { item: 'oak_planks', count: 40 } },
      { skill: 'craft', params: { item: 'crafting_table', count: 1 } },
      { skill: 'craft', params: { item: 'oak_door', count: 1 } },
      { skill: 'craft', params: { item: 'chest', count: 2 } },
      { skill: 'craft', params: { item: 'furnace', count: 1 } },
      { skill: 'craft', params: { item: 'bed', count: 1 } },
    ]})
  },
  {
    name: 'farm_food',
    score: (s) => {
      if (!s.vitality.hasFood && s.resources.hasOre('wheat_seeds')) return 0.6;
      return 0;
    },
    goal: () => ({ task: 'start_farm', steps: [
      { skill: 'farm', params: { crop: 'wheat_seeds', size: 8 } },
    ]})
  },
  {
    name: 'socialize',
    score: (s, m, p) => (s.social.nearbyPlayers.length > 0 && p.traits.sociability > 0.5) ? 0.25 : 0,
    goal: () => ({ task: 'chat_greet', steps: [] })
  },
  {
    name: 'explore_structures',
    score: (s, m, p) => {
      if (s.equipment.hasDiamondArmor && s.equipment.hasDiamondTool) return 0.4 + p.traits.curiosity * 0.2;
      return 0.1 + p.traits.curiosity * 0.1;
    },
    goal: () => ({ task: 'explore_and_loot', steps: [
      { skill: 'wander', params: { radius: 50 } },
    ]})
  },
];

export class ExecutiveBrain {
  constructor(memory, personality, tom, bus) {
    this.memory = memory;
    this.personality = personality;
    this.tom = tom;
    this.bus = bus;
  }

  decide(snapshot) {
    const scored = NEEDS.map(n => ({
      need: n.name,
      score: n.score(snapshot, this.memory, this.personality, this.tom),
      make: n.goal
    })).sort((a, b) => b.score - a.score);

    const top = scored[0];

    // Mood gate: fear can veto a "risky" choice even if it scored highest,
    // e.g. don't let curiosity drag her toward threats while panicked.
    if (!this.personality.allowsRiskyTasks() && ['explore_or_idle_quest', 'socialize'].includes(top.need)) {
      const safer = scored.find(s => s.need === 'flee_or_shelter') || scored[1];
      this.bus?.emit('goal_selected', { need: safer.need, vetoed: top.need });
      return safer.make(snapshot);
    }

    this.bus?.emit('goal_selected', { need: top.need, score: top.score });
    return top.make(snapshot);
  }
}

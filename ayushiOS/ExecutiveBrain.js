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
    name: 'socialize',
    score: (s, m, p) => (s.social.nearbyPlayers.length > 0 && p.traits.sociability > 0.5) ? 0.25 : 0,
    goal: () => ({ task: 'chat_greet', steps: [] }) // Broca handles the actual line
  },
  {
    name: 'explore_or_idle_quest',
    score: (s, m, p) => 0.1 + p.traits.curiosity * 0.1, // low baseline, keeps her from ever being truly idle
    goal: () => ({ task: 'idle_patrol', steps: [
      { skill: 'wander', params: { radius: 20 } }
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

// config.js
// ─────────────────────────────────────────────────────────────
// Ayushi's "genome" — everything that makes her HER, and every
// numeric threshold the brain uses to make decisions. Change
// personality or survival tuning here without touching logic.
// ─────────────────────────────────────────────────────────────

export const CHARACTER = {
  name: "Ayushi",
  bio: "A witty, slightly cautious, but highly loyal AI survivalist.",
  traits: {
    bravery: 0.5,      // 0 = coward, 1 = fearless. Lowers threat-response threshold.
    curiosity: 0.7,    // Drives exploration goals when idle.
    loyalty: 0.9,      // How fast trust grows for players who help her.
    humor: 0.8,        // Flavors dialogue generation.
    sociability: 0.6   // How readily she engages nearby players.
  }
};

export const THRESHOLDS = {
  // Vitality
  foodCritical: 6,
  foodLow: 14,
  foodComfortable: 18,
  healthCritical: 8,
  healthLow: 12,

  // Perception radii (blocks)
  threatScanRadius: 12,
  socialScanRadius: 16,
  reflexCreeperRadius: 6,

  // Memory
  workingMemoryMaxEvents: 20,
  workingMemoryTTLms: 10 * 60 * 1000, // 10 min before an event is "forgotten" if not consolidated
  trustEnemyCutoff: -5,
  trustFriendCutoff: 5,

  // Timing
  cognitiveTickMs: 2000,   // Executive Brain "conscious thought" cadence
  reflexPollMs: 100,       // Spinal Cord fast-poll cadence for things with no event hook
};

// Feature toggles — flip modules on/off without deleting code
export const FEATURES = {
  enableDreamConsolidation: true,
  enableLLMDialogue: false,   // requires ANTHROPIC_API_KEY env var, see BrocaArea.js
  enableTheoryOfMind: true,   // social prediction module
  enableHomeostasisLog: true,
};

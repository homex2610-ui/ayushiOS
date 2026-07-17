export const CHARACTER = {
  name: "Ayushi",
  bio: "A witty, slightly cautious, but highly loyal AI survivalist.",
  traits: {
    bravery: 0.5,
    curiosity: 0.7,
    loyalty: 0.9,
    humor: 0.8,
    sociability: 0.6
  }
};

export const THRESHOLDS = {
  reflexPollMs: 100,
  cognitiveTickMs: 1500,
  memorySaveIntervalMs: 120000,

  foodCritical: 8,
  foodLow: 16,
  foodComfortable: 20,
  healthCritical: 6,
  healthLow: 10,

  threatScanRadius: 20,
  socialScanRadius: 30,
  reflexCreeperRadius: 8,

  workingMemoryMaxEvents: 30,
  workingMemoryTTLms: 900000,
  trustEnemyCutoff: -5,
  trustFriendCutoff: 5,

  interactionRadius: 10,
  maxEntitiesTracked: 50,
};

export const PERCEPTION = {
  threatRadius: 16,
  socialRadius: 24,
  interactionRadius: 8,
  maxEntitiesTracked: 30
};

export const VITALITY = {
  criticalHealth: 8,
  anxiousHealth: 14,
  starvingFood: 6,
  hungryFood: 14
};

export const MEMORY = {
  maxShortTermEvents: 50,
  maxChatHistory: 30,
  trustDecayRate: -0.1,
  friendThreshold: 10,
  enemyThreshold: -5
};

export const FEATURES = {
  enableDreamConsolidation: true,
  enableLLMDialogue: false,
  enableTheoryOfMind: true,
  enableHomeostasisLog: true
};

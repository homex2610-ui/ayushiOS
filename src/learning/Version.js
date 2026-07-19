// Version.js
// Central source of truth for all version metadata.
// Every consumer must import from here — no literals elsewhere.
// When a model changes, update only this file.
//
// IMPORTANT: These constants are manually maintained.
// There is no automated git-hash or CI-based provenance yet.
// If you add a new version field, update this file AND every
// Experience constructor call site that spreads { ...VERSIONS }.
// Automated provenance (e.g., git-describe at build time) is
// deferred until the replay pipeline justifies the investment.

export const VERSIONS = {
  /** Planner algorithm version string */
  planner: 'htn-lite-v1',
  /** RewardModel scoring function version — increment on any reward formula change */
  rewardModel: 1,
  /** ServerSemanticLayer classification version — increment on any type/role change */
  semanticModel: 1,
  /** SkillRepository aggregation version — increment on any stats formula change */
  skillRepository: 1,
};

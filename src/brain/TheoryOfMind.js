// TheoryOfMind.js
// ─────────────────────────────────────────────────────────────
// SUGGESTED ADDITION #3
// Real social intelligence isn't just "trust go up/down" — it's
// predicting what someone is LIKELY to do next based on their
// pattern of behavior. This module watches a player's recent
// actions (via events you feed it) and produces a lightweight
// prediction Ayushi's Executive Brain can factor in, e.g.
// "this player tends to attack after following her into caves."
// Intentionally simple: a frequency-based pattern matcher, not
// a real ML model — cheap enough to run per-tick.
// ─────────────────────────────────────────────────────────────

export class TheoryOfMind {
  constructor(memoryMatrix) {
    this.memory = memoryMatrix;
    this.behaviorLog = {}; // username -> [ 'followed', 'attacked', 'gave_item', ... ]
  }

  observe(username, actionTag) {
    if (!this.behaviorLog[username]) this.behaviorLog[username] = [];
    const log = this.behaviorLog[username];
    log.push(actionTag);
    if (log.length > 30) log.shift();
  }

  // Returns a rough risk score 0-1 for "will this player turn hostile soon"
  predictRisk(username) {
    const log = this.behaviorLog[username] || [];
    if (log.length === 0) return 0.1; // unknown = mild caution, not zero trust

    const hostileActs = log.filter(a => a === 'attacked' || a === 'threatened').length;
    const friendlyActs = log.filter(a => a === 'gave_item' || a === 'helped').length;
    const relTrust = this.memory.getRelationship(username).trust;

    let risk = (hostileActs / log.length) * 0.7 - (friendlyActs / log.length) * 0.3;
    risk -= relTrust * 0.02; // established trust dampens perceived risk
    return Math.max(0, Math.min(1, risk));
  }
}

// BeliefState.js
// ─────────────────────────────────────────────────────────────
// Transient / current world facts. NOT persisted to memory.json.
// MemoryMatrix holds durable knowledge; BeliefState holds "now".
//
// Each belief carries:
//   id          — unique identifier
//   key         — belief name (e.g. 'danger', 'player_visible')
//   value       — the belief value (any type)
//   confidence  — [0,1] certainty at time of observation
//   source      — who provided this observation
//   timestamp   — when the observation was made
//   ttl         — time-to-live in ms (null = never expires)
//   expiresAt   — timestamp when this belief expires
//   persistent  — if true, never auto-expires
//   metadata    — additional context
//
// Call expire() each cognitive tick to prune stale entries.
// ─────────────────────────────────────────────────────────────

export class Belief {
  constructor(key, value, opts = {}) {
    this.id = opts.id || `${key}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.key = key;
    this.value = value;
    this.confidence = typeof opts.confidence === 'number' ? opts.confidence : 1.0;
    this.source = opts.source || 'internal';
    this.timestamp = Date.now();
    this.ttl = opts.ttl || null;
    this.expiresAt = this.ttl ? Date.now() + this.ttl : null;
    this.persistent = opts.persistent ?? false;
    this.metadata = opts.metadata || {};
  }

  isExpired() {
    if (this.persistent) return false;
    return this.expiresAt !== null && Date.now() > this.expiresAt;
  }

  touch() {
    this.timestamp = Date.now();
    if (this.ttl) this.expiresAt = Date.now() + this.ttl;
  }

  toJSON() {
    return {
      id: this.id,
      key: this.key,
      value: this.value,
      confidence: this.confidence,
      source: this.source,
      timestamp: this.timestamp,
      ttl: this.ttl,
      expiresAt: this.expiresAt,
      persistent: this.persistent,
      metadata: this.metadata,
    };
  }
}

// Default TTL per observation type (milliseconds)
const TTL = {
  threats:       5_000,   // hostile mobs vanish from beliefs after 5s
  nearbyNPCs:   30_000,   // NPC positions stale after 30s
  nearbyHazards: 15_000,  // environmental hazards stale after 15s
  nearbyPlayers: 10_000,  // player positions stale after 10s
  openGui:        8_000,  // GUI state stale after 8s if not refreshed
  danger:        10_000,  // danger assessment stale after 10s
  explosion:      5_000,  // explosion heard stale after 5s
  projectile:     5_000,  // projectile seen stale after 5s
  fire:          10_000,  // fire observed stale after 10s
  playerSeen:    10_000,  // player visible stale after 10s
};

export class BeliefState {
  constructor() {
    this._beliefMap = new Map();
    this.reset();
  }

  reset() {
    this._beliefMap.clear();
    this.dimension = null;
    this.biome = null;
    this.position = null;
    this.vitality = { health: 20, food: 20, hasFood: false };
    // Transient arrays — each entry includes _observedAt, confidence, source
    this.threats = [];
    this.nearbyNPCs = [];
    this.nearbyHazards = [];
    this.nearbyPlayers = [];
    this.interestingBlocks = [];
    // Server-level transient facts (refreshed by ServerKnowledgeBridge)
    this.currentServer = { name: null, motd: null, version: null, pvp: false, claimSystem: null, spawn: null };
    this.scoreboard = { title: null, lines: [] };
    this.openGui = null;
    this._openGuiObservedAt = 0;
    this.economySnapshot = { enabled: false, currency: null, symbols: [] };
    this.lastUpdatedAt = 0;
  }

  /**
   * Set a dynamic belief.
   * @param {string} key
   * @param {*} value
   * @param {{ confidence?: number, source?: string, ttl?: number, persistent?: boolean, metadata?: object }} [opts]
   * @returns {Belief}
   */
  setBelief(key, value, opts = {}) {
    const ttl = opts.ttl ?? (TTL[key] || null);
    const belief = new Belief(key, value, {
      ...opts,
      ttl,
      source: opts.source || 'internal',
      confidence: typeof opts.confidence === 'number' ? opts.confidence : 1.0,
    });
    this._beliefMap.set(key, belief);
    return belief;
  }

  /**
   * Get a dynamic belief by key.
   * Returns null if expired or not found.
   * @param {string} key
   * @returns {Belief|null}
   */
  getBelief(key) {
    const belief = this._beliefMap.get(key);
    if (!belief) return null;
    if (belief.isExpired()) {
      this._beliefMap.delete(key);
      return null;
    }
    return belief;
  }

  /**
   * Remove a dynamic belief by key.
   * @param {string} key
   */
  removeBelief(key) {
    this._beliefMap.delete(key);
  }

  /**
   * Get all active (non-expired) dynamic beliefs as an array of Belief objects.
   * @returns {Belief[]}
   */
  getAllBeliefs() {
    this.clearExpiredBeliefs();
    return Array.from(this._beliefMap.values());
  }

  /**
   * Remove all expired entries from the belief map.
   */
  clearExpiredBeliefs() {
    for (const [key, belief] of this._beliefMap) {
      if (belief.isExpired()) this._beliefMap.delete(key);
    }
  }

  /**
   * Merge a partial patch of current facts.
   * Arrays should contain plain objects; this method stamps each
   * entry with _observedAt + default confidence if not already set.
   */
  update(patch = {}) {
    const now = Date.now();

    if (patch.dimension != null) {
      this.dimension = patch.dimension;
      this.setBelief('dimension', patch.dimension, { confidence: 1.0, source: 'sensory', persistent: true });
    }
    if (patch.biome != null) {
      this.biome = patch.biome;
      this.setBelief('biome', patch.biome, { confidence: 0.9, source: 'sensory', ttl: 30000 });
    }
    if (patch.position) {
      this.position = { ...patch.position };
      this.setBelief('position', { ...patch.position }, { confidence: 1.0, source: 'sensory', persistent: true });
    }
    if (patch.vitality) {
      this.vitality = { ...this.vitality, ...patch.vitality };
      this.setBelief('vitality', { ...this.vitality }, { confidence: 1.0, source: 'sensory', ttl: 3000 });
    }

    if (patch.currentServer) {
      this.currentServer = { ...this.currentServer, ...patch.currentServer };
      this.setBelief('currentServer', { ...this.currentServer }, { confidence: 0.9, source: 'serverAnalyzer', persistent: true });
    }
    if (patch.scoreboard) {
      this.scoreboard = { ...this.scoreboard, ...patch.scoreboard };
      this.setBelief('scoreboard', { ...this.scoreboard }, { confidence: 0.8, source: 'serverAnalyzer', ttl: 30000 });
    }

    if (patch.openGui !== undefined) {
      this.openGui = patch.openGui;
      this._openGuiObservedAt = now;
      if (patch.openGui) {
        this.setBelief('openGui', patch.openGui, { confidence: 1.0, source: 'serverAnalyzer', ttl: TTL.openGui });
      } else {
        this.removeBelief('openGui');
      }
    }

    if (patch.economySnapshot) {
      this.economySnapshot = { ...this.economySnapshot, ...patch.economySnapshot };
      this.setBelief('economy', { ...this.economySnapshot }, { confidence: 0.8, source: 'serverAnalyzer', persistent: true });
    }
    if (Array.isArray(patch.interestingBlocks)) this.interestingBlocks = patch.interestingBlocks;

    // Stamp transient arrays with observation metadata
    if (Array.isArray(patch.threats)) {
      this.threats = patch.threats.map(t => ({
        confidence: 0.95,
        source: 'sensory',
        ...t,
        _observedAt: now,
      }));
      if (this.threats.length > 0) {
        const maxThreat = this.threats.reduce((a, b) => (a.distance || 999) < (b.distance || 999) ? a : b);
        this.setBelief('threat', {
          type: maxThreat.type || maxThreat.name,
          distance: maxThreat.distance,
          count: this.threats.length,
        }, { confidence: 0.95, source: 'sensory', ttl: TTL.threats });
      } else {
        this.removeBelief('threat');
      }
    }
    if (Array.isArray(patch.nearbyNPCs)) {
      this.nearbyNPCs = patch.nearbyNPCs.map(n => ({
        confidence: n.confidence ?? 0.75,
        source: 'serverAnalyzer',
        ...n,
        _observedAt: now,
      }));
      if (this.nearbyNPCs.length > 0) {
        this.setBelief('npc_nearby', { count: this.nearbyNPCs.length }, { confidence: 0.75, source: 'serverAnalyzer', ttl: TTL.nearbyNPCs });
      } else {
        this.removeBelief('npc_nearby');
      }
    }
    if (Array.isArray(patch.nearbyHazards)) {
      this.nearbyHazards = patch.nearbyHazards.map(h => ({
        confidence: h.confidence ?? 0.80,
        source: 'serverAnalyzer',
        ...h,
        _observedAt: now,
      }));
      if (this.nearbyHazards.length > 0) {
        this.setBelief('hazard_nearby', { count: this.nearbyHazards.length }, { confidence: 0.80, source: 'serverAnalyzer', ttl: TTL.nearbyHazards });
      } else {
        this.removeBelief('hazard_nearby');
      }
    }
    if (Array.isArray(patch.nearbyPlayers)) {
      this.nearbyPlayers = patch.nearbyPlayers.map(p => ({
        confidence: 1.0,
        source: 'sensory',
        ...p,
        _observedAt: now,
      }));
      if (this.nearbyPlayers.length > 0) {
        this.setBelief('player_nearby', { count: this.nearbyPlayers.length }, { confidence: 1.0, source: 'sensory', ttl: TTL.playerSeen });
      } else {
        this.removeBelief('player_nearby');
      }
    }

    this.lastUpdatedAt = now;
  }

  /**
   * Prune observations whose TTL has expired.
   * Call this once per cognitive tick (from AyushiOS._tick).
   */
  expire() {
    const now = Date.now();
    this.threats       = this.threats.filter(t => now - (t._observedAt || 0) < TTL.threats);
    this.nearbyNPCs    = this.nearbyNPCs.filter(n => now - (n._observedAt || 0) < TTL.nearbyNPCs);
    this.nearbyHazards = this.nearbyHazards.filter(h => now - (h._observedAt || 0) < TTL.nearbyHazards);
    this.nearbyPlayers = this.nearbyPlayers.filter(p => now - (p._observedAt || 0) < TTL.nearbyPlayers);
    // Expire openGui if stale
    if (this.openGui && (now - this._openGuiObservedAt) > TTL.openGui) {
      this.openGui = null;
      this.removeBelief('openGui');
    }
    // Expire dynamic belief map entries
    this.clearExpiredBeliefs();
  }

  /**
   * True if any transient observation exceeds the given confidence threshold.
   */
  hasHighConfidenceThreat(minConfidence = 0.8) {
    return this.threats.some(t => (t.confidence ?? 0) >= minConfidence);
  }

  hasHighConfidenceHazard(minConfidence = 0.8) {
    return this.nearbyHazards.some(h => (h.confidence ?? 0) >= minConfidence);
  }

  /**
   * Evaluate a dynamic belief with confidence-based reasoning.
   * Returns the value if the belief exists and meets confidence threshold, else null.
   */
  evaluateBelief(key, minConfidence = 0.0) {
    const belief = this.getBelief(key);
    if (!belief) return null;
    if (belief.confidence < minConfidence) return null;
    return belief.value;
  }

  /** Snapshot — strips internal metadata fields (_observedAt) from output, includes dynamic beliefs */
  snapshot() {
    const strip = (arr) => arr.map(({ _observedAt, ...rest }) => rest);
    const beliefs = {};
    for (const [key, belief] of this._beliefMap) {
      if (!belief.isExpired()) {
        beliefs[key] = belief.toJSON();
      }
    }
    return {
      dimension: this.dimension,
      biome: this.biome,
      position: this.position ? { ...this.position } : null,
      vitality: { ...this.vitality },
      threats: strip(this.threats),
      currentServer: { ...this.currentServer },
      scoreboard: { ...this.scoreboard, lines: [...(this.scoreboard.lines || [])] },
      openGui: this.openGui,
      nearbyNPCs: strip(this.nearbyNPCs),
      nearbyPlayers: strip(this.nearbyPlayers),
      nearbyHazards: strip(this.nearbyHazards),
      economySnapshot: { ...this.economySnapshot },
      interestingBlocks: [...this.interestingBlocks],
      beliefs,
      lastUpdatedAt: this.lastUpdatedAt,
    };
  }
}

// Knowledge.js
// ─────────────────────────────────────────────────────────────
// Canonical READ-ONLY knowledge API.
// Live questions → BeliefState; durable facts → MemoryMatrix.
 // ─────────────────────────────────────────────────────────────

const EMPTY_BELIEFS = Object.freeze({
  hasSafeBase: false,
  nearestSafeBase: null,
  nearestFoodSource: null,
  nearbyFoodSources: [],
  nearestWarp: null,
  hazardsNearby: false,
  hazardCount: 0,
  knownWarpCount: 0,
  knownWarps: [],
  knownNPCs: [],
  knownCommands: [],
  connectedLocations: [],
  knownFoodSourceCount: 0,
  recentEpisodes: [],
  serverProfile: null,
  serverKnowledge: {
    commandCount: 0,
    plugins: [],
    name: null,
    economy: null,
    dimension: null,
    type: null,
    capabilities: [],
  },
  dimension: null,
  biome: null,
  position: null,
  vitality: { health: 20, food: 20, saturation: 20, hasFood: false, armorSlots: 0 },
  threats: [],
  nearbyNPCs: [],
  nearbyPlayers: [],
  nearbyHazards: [],
  interestingBlocks: [],
  openGui: null,
  scoreboard: { title: null, lines: [] },
  currentServer: { name: null, motd: null, version: null, pvp: false, claimSystem: null, spawn: null, dimension: null },
  economy: { enabled: false, currency: null, symbols: [] },
  serverSemantics: {
    type: null,
    typeConfidence: 0,
    mechanics: null,
    capabilities: [],
    npcClassifications: [],
    guiClassifications: [],
    lastAnalysis: null,
  },
  beliefUpdatedAt: 0,
});

export class Knowledge {
  /**
   * @param {{ bot?: object, beliefs: import('./BeliefState.js').BeliefState, memory: import('./MemoryMatrix.js').MemoryMatrix }} deps
   */
  constructor({ bot = null, beliefs, memory }) {
    this.bot = bot;
    this.beliefs = beliefs;
    this.memory = memory;
    this._cachedSnapshot = null;
  }

  setBot(bot) {
    this.bot = bot;
  }

  getBiome() {
    if (this.beliefs.biome) return this.beliefs.biome;
    const pos = this.bot?.entity?.position;
    if (pos && this.bot?.blockAt) {
      const block = this.bot.blockAt(pos);
      return block?.biome?.name || null;
    }
    return null;
  }

  getDimension() {
    if (this.beliefs.dimension) return this.beliefs.dimension;
    return this.bot?.game?.dimension || this.memory?.longTerm?.semantic?.serverProfile?.dimension || null;
  }

  getNearbyNPCs(maxDistance = 32) {
    const live = this.beliefs.nearbyNPCs || [];
    if (live.length > 0) return live;
    const position = this.beliefs.position || this._botPosition();
    const known = this.memory?.findKnownNPCs?.() || [];
    if (!position) return known;
    return known
      .map(npc => ({
        ...npc,
        distance: npc.position
          ? Math.hypot(npc.position.x - position.x, npc.position.y - position.y, npc.position.z - position.z)
          : null,
      }))
      .filter(npc => npc.distance == null || npc.distance <= maxDistance)
      .sort((a, b) => (a.distance ?? 999) - (b.distance ?? 999));
  }

  getWarps() {
    return Object.values(this.memory?.longTerm?.semantic?.warps || {});
  }

  getEconomy() {
    const live = this.beliefs.economySnapshot;
    if (live?.enabled || live?.currency || (live?.symbols || []).length) return { ...live };
    const profile = this.memory?.longTerm?.semantic?.serverProfile?.economy;
    return profile ? { ...profile } : { enabled: false, currency: null, symbols: [] };
  }

  getPlayerTrust(player) {
    if (!player) return { trust: 0, interactions: 0, notes: [] };
    return this.memory?.getRelationship?.(player) || { trust: 0, interactions: 0, notes: [] };
  }

  getCurrentServer() {
    const live = this.beliefs.currentServer || {};
    const stored = this.memory?.longTerm?.semantic?.serverProfile || {};
    return {
      name: live.name || stored.name || null,
      motd: live.motd || stored.motd || null,
      version: live.version || stored.version || null,
      pvp: live.pvp ?? stored.pvp ?? false,
      claimSystem: live.claimSystem || stored.claimSystem || null,
      spawn: live.spawn || stored.spawn || null,
      dimension: this.getDimension(),
    };
  }

  getSafeArea(position = null) {
    const pos = position || this.beliefs.position || this._botPosition();
    return this.memory?.findNearestSafeBase?.(pos) || this.memory?.getSafeWaypoint?.(pos) || null;
  }

  getHazardsNearby(maxDistance = 30) {
    const live = this.beliefs.nearbyHazards || [];
    if (live.length > 0) return live;
    const pos = this.beliefs.position || this._botPosition();
    return this.memory?.getHazardsNear?.(pos, maxDistance) || [];
  }

  /**
   * Merged view for ExecutiveBrain — current facts + durable beliefs.
   * Graceful fallback chain: live snapshot → cached snapshot → empty snapshot.
   */
  snapshot(position = null) {
    try {
      const pos = position || this.beliefs.position || this._botPosition();
      const persistent = this.memory?.getBeliefs?.(pos) || {};
      const hazards = this.getHazardsNearby(30);
      const nearbyNPCs = this.getNearbyNPCs();
      const server = this.getCurrentServer();
      const economy = this.getEconomy();

      const serverType = this.getServerType();
      const capabilities = this.getServerCapabilities();

      const snapshot = {
        ...persistent,
        dimension: this.getDimension(),
        biome: this.getBiome(),
        position: pos,
        vitality: { ...this.beliefs.vitality },
        threats: [...(this.beliefs.threats || [])],
        nearbyNPCs,
        nearbyPlayers: [...(this.beliefs.nearbyPlayers || [])],
        nearbyHazards: hazards,
        hazardsNearby: hazards.length > 0,
        hazardCount: hazards.length,
        openGui: this.beliefs.openGui,
        scoreboard: { ...this.beliefs.scoreboard },
        interestingBlocks: [...(this.beliefs.interestingBlocks || [])],
        currentServer: server,
        economy,
        serverKnowledge: {
          ...(persistent.serverKnowledge || {}),
          commandCount: persistent.knownCommands?.length || persistent.serverKnowledge?.commandCount || 0,
          plugins: this.memory?.longTerm?.semantic?.serverProfile?.plugins || [],
          name: server.name,
          economy,
          type: serverType.type,
          capabilities,
        },
        serverSemantics: {
          ...this.beliefs.serverSemantics,
          type: serverType.type,
          typeConfidence: serverType.confidence,
          capabilities,
        },
        beliefUpdatedAt: this.beliefs.lastUpdatedAt,
      };
      this._cachedSnapshot = snapshot;
      return snapshot;
    } catch (err) {
      console.warn('[Knowledge] snapshot() failed, using fallback:', err.message);
      if (this._cachedSnapshot) return this._cachedSnapshot;
      return this._emptySnapshot(position);
    }
  }

  _emptySnapshot(position) {
    return {
      ...EMPTY_BELIEFS,
      position: position || this.beliefs?.position || this._botPosition() || null,
      vitality: { ...EMPTY_BELIEFS.vitality },
      currentServer: { ...EMPTY_BELIEFS.currentServer },
      economy: { ...EMPTY_BELIEFS.economy },
      serverKnowledge: { ...EMPTY_BELIEFS.serverKnowledge },
    };
  }

  /** @deprecated use snapshot() */
  getBeliefs(position) {
    return this.snapshot(position);
  }

  getServerType() {
    const live = this.beliefs.serverSemantics?.type;
    if (live) return { type: live, confidence: this.beliefs.serverSemantics.typeConfidence || 0 };
    const profile = this.memory?.longTerm?.semantic?.serverProfile;
    if (profile?.semanticType) {
      return { type: profile.semanticType, confidence: profile.semanticConfidence || 0 };
    }
    return { type: 'unknown', confidence: 0 };
  }

  getServerMechanics() {
    const live = this.beliefs.serverSemantics?.mechanics;
    if (live) return live;
    const profile = this.memory?.longTerm?.semantic?.serverProfile;
    if (profile?.mechanics) return profile.mechanics;
    return null;
  }

  getServerCapabilities() {
    const live = this.beliefs.serverSemantics?.capabilities;
    if (live && live.length > 0) return [...live];
    const profile = this.memory?.longTerm?.semantic?.serverProfile;
    if (profile?.mechanics?.capabilities) return [...profile.mechanics.capabilities];
    return [];
  }

  hasServerCapability(name) {
    return this.getServerCapabilities().includes(name);
  }

  getSemanticNPCs() {
    const live = this.beliefs.serverSemantics?.npcClassifications;
    if (live && live.length > 0) return live;
    return [];
  }

  getNPCRole(npcName) {
    const classified = this.getSemanticNPCs().find(n => n.name === npcName);
    if (classified) return { role: classified.role, confidence: classified.confidence };
    return { role: 'unknown', confidence: 0 };
  }

  getGUIClassifications() {
    const live = this.beliefs.serverSemantics?.guiClassifications;
    if (live && live.length > 0) return live;
    return [];
  }

  _updateSemanticFields(analysis) {
    if (!analysis) return;
    const beliefs = this.beliefs;
    beliefs.serverSemantics = {
      type: analysis.identity?.type || null,
      typeConfidence: analysis.identity?.confidence || 0,
      mechanics: analysis.mechanics || null,
      capabilities: analysis.mechanics?.capabilities || [],
      npcClassifications: analysis.npcs || [],
      guiClassifications: analysis.guis || [],
      lastAnalysis: analysis.compiledAt || Date.now(),
    };
  }

  _botPosition() {
    const p = this.bot?.entity?.position;
    if (!p) return null;
    return { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) };
  }
}

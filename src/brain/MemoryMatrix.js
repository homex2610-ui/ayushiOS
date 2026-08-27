// MemoryMatrix.js
// ─────────────────────────────────────────────────────────────
// THE HIPPOCAMPUS
// Four memory systems, like a real brain:
//   • Working memory   — what's happening right now (seconds-minutes, volatile)
//   • Episodic memory  — "what happened" log, timestamped, decays unless important
//   • Semantic memory  — "what I know to be true" facts about the world (home, bases, resources)
//   • Social memory     — relationships: trust, history, labels (friend/enemy/stranger)
// Dreaming (REM) is the only place memories move between these tiers.
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { THRESHOLDS, FEATURES } from './config.js';

export class MemoryMatrix {
  constructor(username, bus) {
    this.bus = bus;
    this.filePath = path.join(process.cwd(), 'bots', username, 'memory.json');

    this.working = { recentEvents: [] }; // volatile
    this._lastDecay = 0;
    this.longTerm = {
      episodic: [],          // [{time, text, importance}]
      semantic: {            // facts: home, known bases, resource locations
        homePos: null,
        knownLocations: {},  // name -> {x,y,z,note}
        waypoints: {},       // id -> waypoint metadata
        worldGraph: { nodes: {}, edges: [] },
        warps: {},           // name -> {position, note, discoveredAt}
        serverCommands: {},  // command -> metadata
        discoveredNPCs: {},  // name -> metadata
        hazards: [],         // [{id,type,position,reason,severity,radius,lastObserved}]
        regionNotes: {},     // regionKey -> notes
        serverProfile: null, // durable server identity / economy / plugins
      },
      social: {              // relationships
        friends: {},         // username -> {trust, interactions, lastSeen, notes:[]}
        enemies: {},
      }
    };

    this.load();

    if (bus) {
      bus.on('task_completed', ({ taskName }) => this.recordEvent(`Completed task: ${taskName}`, 1));
      bus.on('death_reported', (death) => this.recordDeath(death));
    }
  }

  _normalizePosition(pos) {
    if (!pos) return null;
    return {
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      z: Math.round(pos.z),
    };
  }

  _makeNodeId({ id, name, type, position }) {
    if (id) return String(id);
    const sanitized = name ? String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') : null;
    if (sanitized) return `${type || 'node'}_${sanitized}`;
    if (position) return `${type || 'node'}_${position.x}_${position.y}_${position.z}`;
    return `node_${Date.now()}`;
  }

  _mergeMemory(base, disk) {
    const result = { ...base };
    for (const key of Object.keys(disk)) {
      if (disk[key] && typeof disk[key] === 'object' && !Array.isArray(disk[key])) {
        result[key] = this._mergeMemory(base[key] ?? {}, disk[key]);
      } else if (Array.isArray(disk[key])) {
        result[key] = disk[key];
      } else {
        result[key] = disk[key];
      }
    }
    return result;
  }

  load() {
    if (fs.existsSync(this.filePath)) {
      try {
        const disk = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        this.longTerm = this._mergeMemory(this.longTerm, disk);
      } catch (e) {
        // Corrupt file (often truncated by a mid-write crash): preserve it
        // for inspection instead of silently overwriting with defaults.
        console.error('[Memory] Error loading memory:', e);
        try {
          const backup = `${this.filePath}.corrupt-${Date.now()}`;
          fs.copyFileSync(this.filePath, backup);
          console.error(`[Memory] Corrupt memory preserved at ${backup}`);
        } catch (_) { /* best-effort preservation */ }
      }
    }
  }

  /**
   * worldGraph grows on every waypoint/NPC/hazard observation. Prune the
   * stalest unreferenced data so the file can't balloon unbounded.
   */
  _pruneWorldGraph() {
    const g = this.longTerm.semantic.worldGraph;
    const MAX_EDGES = 2000;
    const MAX_NODES = 1200;

    if (g.edges.length > MAX_EDGES) {
      const ts = e => e.lastTraversed || e.lastSeen || 0;
      g.edges.sort((a, b) => ts(b) - ts(a));
      g.edges.length = MAX_EDGES;
    }

    const nodeCount = Object.keys(g.nodes).length;
    if (nodeCount > MAX_NODES) {
      const referenced = new Set();
      for (const e of g.edges) { referenced.add(e.fromId); referenced.add(e.toId); }
      const isProtected = n =>
        n.tags?.includes('safe') || n.tags?.includes('bed') || (n.importance ?? 0) >= 3;
      const droppable = Object.values(g.nodes)
        .filter(n => !referenced.has(n.id) && !isProtected(n))
        .sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
      let excess = nodeCount - MAX_NODES;
      for (const n of droppable) {
        if (excess <= 0) break;
        delete g.nodes[n.id];
        if (this.longTerm.semantic.waypoints) delete this.longTerm.semantic.waypoints[n.id];
        excess--;
      }
    }
  }

  save() {
    // Atomic write: crash mid-save must never truncate memory.json — that
    // used to wipe ALL long-term memory on next boot.
    try {
      this._pruneWorldGraph();
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.longTerm, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      console.error('[Memory] Error saving memory:', e?.message || e);
    }
  }

  // ---- Working memory ----
  recordEvent(text, importance = 1) {
    const entry = { time: Date.now(), text, importance };
    this.working.recentEvents.push(entry);
    const now = Date.now();
    this.working.recentEvents = this.working.recentEvents
      .filter(ev => now - ev.time <= THRESHOLDS.workingMemoryTTLms);
    if (this.working.recentEvents.length > THRESHOLDS.workingMemoryMaxEvents) {
      this.working.recentEvents.shift();
    }
    this.bus?.emit('memory_recorded', entry);
  }

  // ---- Semantic memory ----
  rememberServerProfile(profile = {}) {
    const existing = this.longTerm.semantic.serverProfile || {};
    const plugins = Array.isArray(profile.plugins)
      ? profile.plugins
      : (Array.isArray(existing.plugins) ? existing.plugins : []);
    const economy = {
      ...(existing.economy || {}),
      ...(profile.economy || {}),
    };
    this.longTerm.semantic.serverProfile = {
      ...existing,
      name: profile.name ?? existing.name ?? null,
      motd: profile.motd ?? existing.motd ?? null,
      version: profile.version ?? existing.version ?? null,
      spawn: profile.spawn ?? existing.spawn ?? null,
      dimension: profile.dimension ?? existing.dimension ?? null,
      pvp: profile.pvp ?? existing.pvp ?? false,
      claimSystem: profile.claimSystem ?? existing.claimSystem ?? null,
      economy,
      plugins,
      scoreboardTitle: profile.scoreboardTitle ?? existing.scoreboardTitle ?? null,
      source: profile.source || existing.source || 'unknown',
      updatedAt: Date.now(),
    };
    this.save();
    this.bus?.emit('server_profile_recorded', this.longTerm.semantic.serverProfile);
    return this.longTerm.semantic.serverProfile;
  }

  getServerProfile() {
    return this.longTerm.semantic.serverProfile || null;
  }

  setHome(pos) {
    this.longTerm.semantic.homePos = pos;
    this.save();
  }

  learnLocation(name, pos, note = '') {
    this.longTerm.semantic.knownLocations[name] = { ...pos, note };
    this.save();
  }

  rememberWaypoint({ id = null, name = null, type = 'generic', position, tags = [], note = '', source = 'sensor', importance = 1, confidence = 0.6 }) {
    if (!position) return null;
    position = this._normalizePosition(position);
    const nodeId = this._makeNodeId({ id, name, type, position });
    const existing = this.longTerm.semantic.worldGraph.nodes[nodeId] || {};
    const now = Date.now();
    const firstSeen = existing.firstSeen || now;
    const visitCount = existing.visitCount || 0;
    const incrementedVisitCount = existing.lastSeen && now - existing.lastSeen < 30000 ? visitCount : visitCount + 1;
    const tagsSet = new Set([...(existing.tags || []), ...tags]);
    if (type === 'home' || type === 'shelter' || tagsSet.has('bed')) {
      tagsSet.add('safe');
    }
    const updated = {
      id: nodeId,
      name: name || existing.name || `${type}_${position.x}_${position.y}_${position.z}`,
      type,
      position,
      tags: Array.from(tagsSet),
      source: existing.source || source,
      importance: Math.max(existing.importance || 0, importance),
      confidence: Math.min(1, Math.max((existing.confidence || 0.4) + 0.1, confidence)),
      firstSeen,
      lastSeen: now,
      visitCount: incrementedVisitCount,
      notes: Array.from(new Set([...(existing.notes || []), note].filter(Boolean))),
    };
    this.longTerm.semantic.worldGraph.nodes[nodeId] = updated;
    this.longTerm.semantic.waypoints[nodeId] = updated;
    this.save();
    this.bus?.emit('waypoint_recorded', updated);

    const neighbors = this.findWaypoints({ position, maxDistance: 12 });
    for (const neighbor of neighbors) {
      if (neighbor.id === nodeId) continue;
      this.connectWaypoints(nodeId, neighbor.id, { type: 'connected_to' });
      this.connectWaypoints(neighbor.id, nodeId, { type: 'connected_to' });
    }

    return updated;
  }

  connectWaypoints(fromId, toId, { relation = 'connected_to', type = 'path', cost = null } = {}) {
    const from = this.longTerm.semantic.worldGraph.nodes[fromId];
    const to = this.longTerm.semantic.worldGraph.nodes[toId];
    if (!from || !to) return null;
    const distance = cost ?? Math.sqrt(
      (from.position.x - to.position.x) ** 2 +
      (from.position.y - to.position.y) ** 2 +
      (from.position.z - to.position.z) ** 2
    );
    const edge = { fromId, toId, relation, type, cost: Number(distance.toFixed(2)), lastTraversed: Date.now() };
    const existingIndex = this.longTerm.semantic.worldGraph.edges.findIndex(e => e.fromId === fromId && e.toId === toId && e.relation === relation && e.type === type);
    if (existingIndex >= 0) {
      this.longTerm.semantic.worldGraph.edges[existingIndex] = { ...this.longTerm.semantic.worldGraph.edges[existingIndex], ...edge };
    } else {
      this.longTerm.semantic.worldGraph.edges.push(edge);
    }
    this.save();
    return edge;
  }

  rememberRelationship(subjectId, relation, objectId, { confidence = 0.5, note = '' } = {}) {
    if (!subjectId || !relation || !objectId) return null;
    const subject = this.longTerm.semantic.worldGraph.nodes[subjectId];
    const object = this.longTerm.semantic.worldGraph.nodes[objectId];
    if (!subject || !object) return null;
    const edge = {
      fromId: subjectId,
      toId: objectId,
      relation,
      type: 'relation',
      confidence: Math.min(1, Math.max(0.1, confidence)),
      note,
      lastSeen: Date.now(),
    };
    const existing = this.longTerm.semantic.worldGraph.edges.find(e => e.fromId === subjectId && e.toId === objectId && e.relation === relation && e.type === 'relation');
    if (existing) {
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.note = note || existing.note;
      existing.lastSeen = Date.now();
      return existing;
    }
    this.longTerm.semantic.worldGraph.edges.push(edge);
    this.save();
    return edge;
  }

  queryRelationships(subjectId, relation = null) {
    return this.longTerm.semantic.worldGraph.edges.filter(e => e.fromId === subjectId && (!relation || e.relation === relation));
  }

  findConnectedNodes(subjectId, relation = null) {
    return this.queryRelationships(subjectId, relation).map(edge => ({
      ...this.longTerm.semantic.worldGraph.nodes[edge.toId],
      relation: edge.relation,
      edgeConfidence: edge.confidence,
    })).filter(Boolean);
  }

  findWaypoints({ type = null, tag = null, maxDistance = null, position = null } = {}) {
    return Object.values(this.longTerm.semantic.worldGraph.nodes)
      .filter(node => {
        if (!node || !node.position) return false;
        if (type && node.type !== type) return false;
        if (tag && !node.tags.includes(tag)) return false;
        return true;
      })
      .map(node => ({
        ...node,
        distance: position ? Math.sqrt(
          (node.position.x - position.x) ** 2 +
          (node.position.y - position.y) ** 2 +
          (node.position.z - position.z) ** 2
        ) : null,
      }))
      .filter(node => maxDistance == null || (node.distance != null && node.distance <= maxDistance))
      .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
  }

  findNearestWaypoint(position, options = {}) {
    const normalized = this._normalizePosition(position);
    if (!normalized) return null;
    const waypoints = this.findWaypoints({ ...options, position: normalized, maxDistance: options.maxDistance ?? Infinity });
    return waypoints[0] || null;
  }

  _distanceToNode(node, position) {
    const normalized = this._normalizePosition(position);
    if (!normalized || !node?.position) return null;
    return Math.sqrt(
      (node.position.x - normalized.x) ** 2 +
      (node.position.y - normalized.y) ** 2 +
      (node.position.z - normalized.z) ** 2
    );
  }

  findNodesByTag(tag, position = null, maxDistance = null) {
    const nodes = Object.values(this.longTerm.semantic.worldGraph.nodes).filter(node => node.tags?.includes(tag));
    return nodes
      .map(node => ({ ...node, distance: position ? this._distanceToNode(node, position) : null }))
      .filter(node => maxDistance == null || node.distance != null && node.distance <= maxDistance)
      .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
  }

  findNodesByType(type, position = null, maxDistance = null) {
    const nodes = Object.values(this.longTerm.semantic.worldGraph.nodes).filter(node => node.type === type);
    return nodes
      .map(node => ({ ...node, distance: position ? this._distanceToNode(node, position) : null }))
      .filter(node => maxDistance == null || node.distance != null && node.distance <= maxDistance)
      .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
  }
 
  findBestFoodSources(position, maxDistance = 120) {
    const sources = this.findNearbyFoodSources(position, maxDistance);
    return sources
      .filter(source => source.confidence == null || source.confidence >= 0.25)
      .sort((a, b) => {
        const scoreA = (a.confidence || 0.4) - ((a.distance || 0) / maxDistance) * 0.2;
        const scoreB = (b.confidence || 0.4) - ((b.distance || 0) / maxDistance) * 0.2;
        return scoreB - scoreA;
      });
  }
 
  findKnownNPCs() {
    return Object.values(this.longTerm.semantic.discoveredNPCs || {}).map(npc => ({
      id: this._makeNodeId({ name: npc.name, type: 'npc', position: npc.position }),
      ...npc
    }));
  }
 
  findPathBetween(startId, goalId) {
    if (!startId || !goalId) return [];
    const nodes = this.longTerm.semantic.worldGraph.nodes;
    const edges = this.longTerm.semantic.worldGraph.edges.filter(e => e.relation === 'connected_to' || e.type === 'path');
    const frontier = [{ id: startId, path: [startId], cost: 0 }];
    const visited = new Set([startId]);
    while (frontier.length > 0) {
      frontier.sort((a, b) => a.cost - b.cost);
      const current = frontier.shift();
      if (current.id === goalId) return current.path.map(nodeId => nodes[nodeId]).filter(Boolean);
      for (const edge of edges.filter(e => e.fromId === current.id)) {
        if (visited.has(edge.toId)) continue;
        visited.add(edge.toId);
        frontier.push({ id: edge.toId, path: [...current.path, edge.toId], cost: current.cost + (edge.cost || 1) });
      }
    }
    return [];
  }
 
  findNearestWarp(position) {
    if (!position) return null;
    const normalized = this._normalizePosition(position);
    const warps = Object.values(this.longTerm.semantic.warps)
      .filter(w => w.position)
      .map(warp => ({
        ...warp,
        distance: this._distanceToNode({ position: warp.position }, normalized)
      }))
      .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    return warps[0] || null;
  }

  findNearbyFoodSources(position, maxDistance = 120) {
    const normalized = this._normalizePosition(position);
    if (!normalized) return [];
    const results = [];
    const add = (node) => {
      if (!node || !node.id) return;
      if (results.some(r => r.id === node.id)) return;
      results.push(node);
    };

    const tags = ['food', 'farm', 'market', 'shop', 'village', 'barn'];
    for (const tag of tags) {
      this.findNodesByTag(tag, normalized, maxDistance).forEach(add);
    }
    for (const type of ['farm', 'market', 'shop']) {
      this.findNodesByType(type, normalized, maxDistance).forEach(add);
    }

    Object.values(this.longTerm.semantic.warps).forEach(warp => {
      if (!warp.position) return;
      if (!/(farm|food|market|shop|village|barn)/i.test(warp.name)) return;
      add({
        id: `warp_${warp.name}`,
        name: warp.name,
        type: 'warp',
        position: warp.position,
        tags: ['warp', 'food'],
        distance: this._distanceToNode({ position: warp.position }, normalized),
      });
    });

    return results
      .filter(node => node.distance != null && node.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance);
  }

  findNearestSafeBase(position, maxDistance = 150) {
    const normalized = this._normalizePosition(position);
    if (!normalized) return null;
    const candidates = [
      ...this.findWaypoints({ type: 'home', position: normalized, maxDistance }),
      ...this.findWaypoints({ type: 'shelter', position: normalized, maxDistance }),
      ...this.findNodesByTag('safe', position, maxDistance),
    ];
    return candidates.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))[0] || null;
  }

  getBeliefs(position) {
    const normalized = this._normalizePosition(position);
    if (!normalized) return {
      hasSafeBase: false,
      nearestFoodSource: null,
      nearestWarp: null,
      hazardsNearby: false,
      hazardCount: 0,
      knownWarpCount: Object.keys(this.longTerm.semantic.warps).length,
      recentEpisodes: [],
    };

    this.decaySemanticMemory();

    const nearestFoodSource = this.findBestFoodSources(normalized, 120)[0] || null;
    const nearbyFoodSources = this.findBestFoodSources(normalized, 120).slice(0, 5);
    const nearestSafeBase = this.findNearestSafeBase(normalized, 150);
    const nearestWarp = this.findNearestWarp(normalized);
    const hazards = this.getHazardsNear(normalized, 30);
    const knownNPCs = this.findKnownNPCs();
    const knownCommands = Object.entries(this.longTerm.semantic.serverCommands || {}).map(([cmd, data]) => ({ command: cmd, confidence: data.confidence, source: data.meta?.source || 'unknown' }));
    const connectedLocations = nearestSafeBase ? this.findConnectedNodes(nearestSafeBase.id, 'connected_to').map(node => node.name) : [];
    const recentEpisodes = this.getRecentEpisodes({ limit: 4, minImportance: 1 });
    const serverProfile = this.longTerm.semantic.serverProfile || null;
    const pluginSummary = Array.isArray(serverProfile?.plugins) ? serverProfile.plugins : [];

    return {
      hasSafeBase: !!nearestSafeBase,
      nearestSafeBase,
      nearestFoodSource,
      nearbyFoodSources,
      nearestWarp,
      hazardsNearby: hazards.length > 0,
      hazardCount: hazards.length,
      nearestFoodSourceConfidence: nearestFoodSource?.confidence ?? 0,
      nearestSafeBaseConfidence: nearestSafeBase?.confidence ?? 0,
      nearestWarpConfidence: nearestWarp?.confidence ?? 0,
      knownWarps: Object.values(this.longTerm.semantic.warps).map(warp => ({
        name: warp.name,
        position: warp.position,
        discoveredAt: warp.discoveredAt,
        confidence: warp.confidence,
      })),
      knownWarpCount: Object.keys(this.longTerm.semantic.warps).length,
      knownLocationSummary: Object.keys(this.longTerm.semantic.knownLocations).slice(0, 10),
      knownNPCs: knownNPCs.map(npc => ({ name: npc.name, profession: npc.profession, confidence: npc.confidence, position: npc.position })),
      knownCommands,
      connectedLocations,
      knownFoodSourceCount: nearbyFoodSources.length,
      recentEpisodes,
      serverProfile,
      serverKnowledge: {
        commandCount: knownCommands.length,
        plugins: pluginSummary,
        name: serverProfile?.name || null,
        economy: serverProfile?.economy || null,
        dimension: serverProfile?.dimension || null,
      }
    };
  }

  rememberEpisode(text, importance = 1, tags = []) {
    const episode = {
      time: Date.now(),
      text,
      importance,
      tags: Array.isArray(tags) ? Array.from(new Set(tags)) : [],
    };
    this.longTerm.episodic.push(episode);
    this.longTerm.episodic = this.longTerm.episodic
      .sort((a, b) => b.importance - a.importance || b.time - a.time)
      .slice(0, 300);
    this.save();
    this.bus?.emit('episode_recorded', episode);
    return episode;
  }

  queryEpisodes({ sinceMs = 24 * 60 * 60 * 1000, minImportance = 1, tags = [] } = {}) {
    const cutoff = Date.now() - sinceMs;
    return this.longTerm.episodic
      .filter(ep => ep.time >= cutoff && ep.importance >= minImportance)
      .filter(ep => !tags.length || tags.some(tag => ep.tags.includes(tag)))
      .sort((a, b) => b.time - a.time);
  }

  getRecentEpisodes({ limit = 8, minImportance = 1 } = {}) {
    return this.longTerm.episodic
      .filter(ep => ep.importance >= minImportance)
      .sort((a, b) => b.time - a.time)
      .slice(0, limit)
      .map(ep => ({ ...ep }));
  }

  recordFailure(taskName, reason) {
    const text = `Failure: ${taskName}${reason ? ` - ${reason}` : ''}`;
    this.recordEvent(text, 2);
    this.rememberEpisode(text, 2, ['failure', taskName]);
    return text;
  }

  decaySemanticMemory() {
    const now = Date.now();
    if (now - this._lastDecay < 20 * 1000) return;
    this._lastDecay = now;
    let changed = false;
    const decayNode = (node, halfLifeMs = 30 * 60 * 1000) => {
      if (!node.lastSeen || typeof node.confidence !== 'number') return;
      const ageMs = now - node.lastSeen;
      if (ageMs <= 0) return;
      const decayFactor = Math.exp(-ageMs / halfLifeMs);
      const newConfidence = Math.max(0.2, node.confidence * decayFactor);
      if (newConfidence !== node.confidence) {
        node.confidence = newConfidence;
        changed = true;
      }
    };

    Object.values(this.longTerm.semantic.worldGraph.nodes).forEach(node => decayNode(node, 30 * 60 * 1000));
    Object.values(this.longTerm.semantic.warps).forEach(warp => {
      if (warp.lastSeen) {
        const ageMs = now - warp.lastSeen;
        if (ageMs <= 0) return;
        const decayFactor = Math.exp(-ageMs / (60 * 60 * 1000));
        const newConfidence = Math.max(0.2, (warp.confidence || 0.4) * decayFactor);
        if (newConfidence !== warp.confidence) {
          warp.confidence = newConfidence;
          changed = true;
        }
      }
    });
    this.longTerm.semantic.hazards.forEach(hazard => {
      if (hazard.lastObserved) {
        const ageMs = now - hazard.lastObserved;
        if (ageMs <= 0) return;
        const decayFactor = Math.exp(-ageMs / (20 * 60 * 1000));
        const newConfidence = Math.max(0.2, (hazard.confidence || 0.4) * decayFactor);
        if (newConfidence !== hazard.confidence) {
          hazard.confidence = newConfidence;
          changed = true;
        }
      }
    });
    if (changed) this.save();
  }

  rememberWarp(name, position, note = '', confidence = 0.6) {
    if (!name) return null;
    const warp = this.longTerm.semantic.warps[name] || {};
    const normalized = position ? this._normalizePosition(position) : warp.position || null;
    const updated = {
      name,
      position: normalized,
      note: note || warp.note || '',
      confidence: Math.min(1, Math.max((warp.confidence || 0.4) + 0.1, confidence)),
      discoveredAt: warp.discoveredAt || Date.now(),
      lastSeen: Date.now(),
    };
    this.longTerm.semantic.warps[name] = updated;
    if (updated.position) {
      const waypoint = this.rememberWaypoint({ name, type: 'warp', position: updated.position, tags: ['warp'], note: updated.note, source: 'warp_listener', importance: 2, confidence: updated.confidence });
      const nearby = this.findNearestWaypoint(updated.position, { maxDistance: 20 });
      if (nearby && nearby.id !== waypoint.id) {
        this.rememberRelationship(nearby.id, 'has_warp', waypoint.id, { confidence: 0.7, note: 'Warp near known location' });
      }
    }
    this.save();
    this.rememberEpisode(`Warp discovered: ${name}`, 1, ['warp']);
    this.bus?.emit('warp_recorded', updated);
    return updated;
  }
  
  rememberServerCommand(command, meta = {}) {
    if (!command) return null;
    const key = command.toString().trim().toLowerCase();
    const existing = this.longTerm.semantic.serverCommands[key] || {};
    const now = Date.now();
    const mergedMeta = { ...existing.meta, ...meta };
    const confidence = Math.min(1, Math.max(existing.confidence || 0.4, meta.confidence || 0.6));
    this.longTerm.semantic.serverCommands[key] = {
      command: key,
      meta: mergedMeta,
      discoveredAt: existing.discoveredAt || now,
      lastSeen: now,
      confidence,
    };
    const nodeId = this._makeNodeId({ name: key, type: 'server_command' });
    const existingNode = this.longTerm.semantic.worldGraph.nodes[nodeId] || {};
    this.longTerm.semantic.worldGraph.nodes[nodeId] = {
      id: nodeId,
      name: key,
      type: 'server_command',
      tags: ['command'],
      note: existingNode.note || (meta.source ? `Seen in ${meta.source}` : 'Discovered server command'),
      confidence: Math.min(1, Math.max(existingNode.confidence || 0.4, confidence)),
      firstSeen: existingNode.firstSeen || now,
      lastSeen: now,
      position: meta.position ? this._normalizePosition(meta.position) : existingNode.position,
    };
    this.rememberEpisode(`Server command discovered: ${key}`, 1, ['server_command']);
    if (meta.source === 'chat' && meta.username) {
      const currentLocation = this.findNearestWaypoint(meta.position || this.longTerm.semantic.homePos, { maxDistance: 40 });
      if (currentLocation) {
        this.rememberRelationship(currentLocation.id, 'offers_command', nodeId, { confidence: 0.4, note: `Command heard from ${meta.username}` });
      }
    }
    this.save();
    this.bus?.emit('server_command_recorded', { command: key, meta });
    return this.longTerm.semantic.serverCommands[key];
  }
 
  rememberNPC(name, position, profession = 'unknown', note = '', confidence = 0.5) {
    if (!name) return null;
    const normalized = position ? this._normalizePosition(position) : null;
    const nodeId = this._makeNodeId({ name, type: 'npc', position: normalized });
    const existing = this.longTerm.semantic.worldGraph.nodes[nodeId] || {};
    const updated = {
      id: nodeId,
      name,
      type: 'npc',
      tags: ['npc', profession],
      position: normalized || existing.position,
      profession,
      note: note || existing.note || 'Discovered NPC',
      confidence: Math.min(1, Math.max((existing.confidence || 0.4) + 0.1, confidence)),
      firstSeen: existing.firstSeen || Date.now(),
      lastSeen: Date.now(),
    };
    this.longTerm.semantic.worldGraph.nodes[nodeId] = updated;
    this.longTerm.semantic.discoveredNPCs[name] = updated;
    if (normalized) {
      const nearest = this.findNearestWaypoint(normalized, { maxDistance: 15 });
      if (nearest && nearest.id !== nodeId) {
        this.rememberRelationship(nearest.id, 'hosts_npc', nodeId, { confidence: 0.5, note: `NPC near ${nearest.name}` });
      }
    }
    this.save();
    this.rememberEpisode(`Discovered NPC: ${name} (${profession})`, 1, ['npc']);
    this.bus?.emit('npc_recorded', updated);
    return updated;
  }
  
  getServerCommand(command) {
    if (!command) return null;
    return this.longTerm.semantic.serverCommands[command.toString().trim().toLowerCase()] || null;
  }

  recordHazard({ position, type = 'unknown', reason = '', severity = 1, radius = 4, confidence = 0.6 }) {
    if (!position) return null;
    const normalized = this._normalizePosition(position);
    const existing = this.longTerm.semantic.hazards.find(h => h.type === type && h.position.x === normalized.x && h.position.y === normalized.y && h.position.z === normalized.z);
    if (existing) {
      existing.reason = reason || existing.reason;
      existing.severity = Math.max(existing.severity, severity);
      existing.radius = Math.max(existing.radius, radius);
      existing.lastObserved = Date.now();
      existing.confidence = Math.min(1, Math.max((existing.confidence || 0.4) + 0.1, confidence));
      this.save();
      this.bus?.emit('hazard_recorded', existing);
      return existing;
    }

    const hazard = {
      id: `hazard_${Math.round(normalized.x)}_${Math.round(normalized.y)}_${Math.round(normalized.z)}_${Date.now()}`,
      position: normalized,
      type,
      reason,
      severity,
      radius,
      confidence: Math.min(1, Math.max(0.1, confidence)),
      lastObserved: Date.now(),
    };
    this.longTerm.semantic.hazards.push(hazard);
    this.save();
    this.recordFailure('hazard_detected', hazard.reason || hazard.type);
    this.bus?.emit('hazard_recorded', hazard);
    return hazard;
  }

  /**
   * Mark nearby hazards as just-avoided so they stop re-triggering
   * avoid_hazard every cooldown cycle. Re-armed after AVOID_REARM_MS.
   */
  markHazardsAvoided(position, maxDistance = 30) {
    if (!position) return 0;
    const normalized = this._normalizePosition(position);
    const now = Date.now();
    let count = 0;
    for (const h of this.longTerm.semantic.hazards) {
      const distance = Math.sqrt(
        (normalized.x - h.position.x) ** 2 +
        (normalized.y - h.position.y) ** 2 +
        (normalized.z - h.position.z) ** 2
      );
      if (distance <= maxDistance + (h.radius || 0)) {
        h.lastAvoided = now;
        count++;
      }
    }
    return count;
  }

  getHazardsNear(position, maxDistance = 20) {
    if (!position) return [];
    const normalized = this._normalizePosition(position);
    const now = Date.now();
    const AVOID_REARM_MS = 60000; // hazard stays "handled" this long after avoiding it
    return this.longTerm.semantic.hazards.filter(h => {
      if (h.lastAvoided && now - h.lastAvoided < AVOID_REARM_MS) return false;
      const distance = Math.sqrt(
        (normalized.x - h.position.x) ** 2 +
        (normalized.y - h.position.y) ** 2 +
        (normalized.z - h.position.z) ** 2
      );
      return distance <= maxDistance + (h.radius || 0);
    });
  }

  recordDeath({ reason = 'unknown', position = null, context = {} } = {}) {
    const deathPosition = position ? this._normalizePosition(position) : null;
    const text = `Death recorded: ${reason}${deathPosition ? ` at ${deathPosition.x},${deathPosition.y},${deathPosition.z}` : ''}`;
    this.recordEvent(text, 3);
    if (deathPosition) {
      this.rememberEpisode(`Death recorded: ${reason} at ${deathPosition.x},${deathPosition.y},${deathPosition.z}`, 3, ['death']);
      this.recordHazard({ position: deathPosition, type: 'death', reason, severity: 2, radius: 3 });
    }
    if (context?.locationName) {
      this.learnLocation(context.locationName, deathPosition, `Death site for ${reason}`);
    }
  }

  findKnownLocation(name) {
    return this.longTerm.semantic.knownLocations[name] || null;
  }

  getSafeWaypoint(position) {
    return this.findNearestWaypoint(position, { type: 'shelter' })
      || this.findNearestWaypoint(position, { type: 'home' })
      || this.findNearestWaypoint(position, { tag: 'safe' });
  }

  // ---- Social memory ----
  updatePlayerRelationship(username, change, note = null) {
    const rec = this.longTerm.social.friends[username]
      || (this.longTerm.social.friends[username] = { trust: 0, interactions: 0, notes: [] });
    rec.trust += change;
    rec.interactions++;
    rec.lastSeen = Date.now();
    if (note) rec.notes.push(note);
    this.save();
    return rec.trust;
  }

  getRelationship(username) {
    return this.longTerm.social.friends[username]
      ?? { trust: 0, interactions: 0, notes: [] };
  }

  isEnemy(username) {
    return !!this.longTerm.social.enemies[username];
  }

  // ---- REM SLEEP: the only bridge between working and long-term memory ----
  dreamAndConsolidate() {
    if (!FEATURES.enableDreamConsolidation) return;
    console.log('[Ayushi OS] \u{1F4A4} Entering REM sleep... consolidating memories.');

    // 1. Promote important working-memory events into the episodic log.
    for (const ev of this.working.recentEvents) {
      if (ev.importance >= 2) {
        this.longTerm.episodic.push(ev);
      }
    }
    // Cap episodic log so it doesn't grow forever — keep the most important/recent
    this.longTerm.episodic = this.longTerm.episodic
      .sort((a, b) => b.importance - a.importance || b.time - a.time)
      .slice(0, 200);

    // 2. Clear the volatile buffer — like forgetting the mundane parts of the day.
    this.working.recentEvents = [];

    // 3. Re-classify relationships based on trust drift.
    for (const [user, data] of Object.entries(this.longTerm.social.friends)) {
      if (data.trust <= THRESHOLDS.trustEnemyCutoff) {
        this.longTerm.social.enemies[user] = true;
        console.log(`[Memory] Labeled ${user} as an ENEMY (trust ${data.trust}).`);
      } else if (this.longTerm.social.enemies[user] && data.trust > THRESHOLDS.trustEnemyCutoff) {
        delete this.longTerm.social.enemies[user]; // redemption arc allowed
      }
    }

    this.save();
    this.bus?.emit('dream_complete', { episodicCount: this.longTerm.episodic.length });
    console.log('[Ayushi OS] \u2600\uFE0F Waking up with refreshed cognitive pathways!');
  }
}


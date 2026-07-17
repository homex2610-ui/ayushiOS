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
    this.longTerm = {
      episodic: [],          // [{time, text, importance}]
      semantic: {            // facts: home, known bases, resource locations
        homePos: null,
        knownLocations: {},  // name -> {x,y,z,note}
        waypoints: {},       // id -> {id,name,type,position,tags,source,importance,firstSeen,lastSeen,visitCount,notes}
        worldGraph: { nodes: {}, edges: [] },
        warps: {},           // name -> {position, note, discoveredAt}
        serverCommands: {},  // command -> metadata
        discoveredNPCs: {},  // name -> metadata
        hazards: [],         // [{id,type,position,reason,severity,radius,lastObserved}]
        regionNotes: {},     // regionKey -> notes
      },
      social: {              // relationships
        friends: {},         // username -> {trust, interactions, lastSeen, notes:[]}
        enemies: {},
      }
    };

    this.load();

    if (bus) {
      bus.on('heard_speech', (e) => this.recordEvent(`${e.username} said: "${e.message}"`, 1));
      bus.on('landmark_spotted', (landmark) => this.rememberWaypoint(landmark));
      bus.on('warp_spotted', (warp) => this.rememberWarp(warp.name, warp.position, warp.note));
      bus.on('server_command_seen', (cmd) => this.rememberServerCommand(cmd.command, cmd));
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
        console.error('[Memory] Error loading memory:', e);
      }
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.longTerm, null, 2));
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

  rememberWaypoint({ id = null, name = null, type = 'generic', position, tags = [], note = '', source = 'sensor', importance = 1 }) {
    if (!position) return null;
    position = this._normalizePosition(position);
    const nodeId = this._makeNodeId({ id, name, type, position });
    const existing = this.longTerm.semantic.worldGraph.nodes[nodeId] || {};
    const firstSeen = existing.firstSeen || Date.now();
    const now = Date.now();
    const visitCount = existing.visitCount || 0;
    const incrementedVisitCount = existing.lastSeen && now - existing.lastSeen < 30000 ? visitCount : visitCount + 1;
    const updated = {
      id: nodeId,
      name: name || existing.name || `${type}_${position.x}_${position.y}_${position.z}`,
      type,
      position,
      tags: Array.from(new Set([...(existing.tags || []), ...tags])),
      source: existing.source || source,
      importance: Math.max(existing.importance || 0, importance),
      firstSeen,
      lastSeen: now,
      visitCount: incrementedVisitCount,
      notes: Array.from(new Set([...(existing.notes || []), note].filter(Boolean))),
    };
    this.longTerm.semantic.worldGraph.nodes[nodeId] = updated;
    this.longTerm.semantic.waypoints[nodeId] = updated;
    this.save();
    this.bus?.emit('waypoint_recorded', updated);
    return updated;
  }

  connectWaypoints(fromId, toId, { type = 'path', cost = null } = {}) {
    const from = this.longTerm.semantic.worldGraph.nodes[fromId];
    const to = this.longTerm.semantic.worldGraph.nodes[toId];
    if (!from || !to) return null;
    const distance = cost ?? Math.sqrt(
      (from.position.x - to.position.x) ** 2 +
      (from.position.y - to.position.y) ** 2 +
      (from.position.z - to.position.z) ** 2
    );
    const edge = { fromId, toId, type, cost: Number(distance.toFixed(2)), lastTraversed: Date.now() };
    const existingIndex = this.longTerm.semantic.worldGraph.edges.findIndex(e => e.fromId === fromId && e.toId === toId && e.type === type);
    if (existingIndex >= 0) {
      this.longTerm.semantic.worldGraph.edges[existingIndex] = { ...this.longTerm.semantic.worldGraph.edges[existingIndex], ...edge };
    } else {
      this.longTerm.semantic.worldGraph.edges.push(edge);
    }
    this.save();
    return edge;
  }

  findWaypoints({ type = null, tag = null, maxDistance = null, position = null } = {}) {
    return Object.values(this.longTerm.semantic.worldGraph.nodes)
      .filter(node => {
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

  rememberWarp(name, position, note = '') {
    if (!name) return null;
    const warp = {
      name,
      position: position ? this._normalizePosition(position) : null,
      note,
      discoveredAt: Date.now(),
    };
    this.longTerm.semantic.warps[name] = warp;
    if (warp.position) {
      this.rememberWaypoint({ name, type: 'warp', position: warp.position, tags: ['warp'], note, source: 'warp_listener', importance: 2 });
    }
    this.save();
    this.bus?.emit('warp_recorded', warp);
    return warp;
  }

  rememberServerCommand(command, meta = {}) {
    if (!command) return null;
    const key = command.toString().trim().toLowerCase();
    this.longTerm.semantic.serverCommands[key] = { command: key, meta, discoveredAt: Date.now() };
    this.save();
    this.bus?.emit('server_command_recorded', { command: key, meta });
    return this.longTerm.semantic.serverCommands[key];
  }

  getServerCommand(command) {
    if (!command) return null;
    return this.longTerm.semantic.serverCommands[command.toString().trim().toLowerCase()] || null;
  }

  recordHazard({ position, type = 'unknown', reason = '', severity = 1, radius = 4 }) {
    if (!position) return null;
    const hazard = {
      id: `hazard_${Math.round(position.x)}_${Math.round(position.y)}_${Math.round(position.z)}_${Date.now()}`,
      position: this._normalizePosition(position),
      type,
      reason,
      severity,
      radius,
      lastObserved: Date.now(),
    };
    this.longTerm.semantic.hazards.push(hazard);
    this.save();
    this.bus?.emit('hazard_recorded', hazard);
    return hazard;
  }

  getHazardsNear(position, maxDistance = 20) {
    if (!position) return [];
    const normalized = this._normalizePosition(position);
    return this.longTerm.semantic.hazards.filter(h => {
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

  // ---- Semantic memory ----
  setHome(pos) {
    this.longTerm.semantic.homePos = pos;
    this.save();
  }

  learnLocation(name, pos, note = '') {
    this.longTerm.semantic.knownLocations[name] = { ...pos, note };
    this.save();
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

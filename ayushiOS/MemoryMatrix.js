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
      },
      social: {              // relationships
        friends: {},         // username -> {trust, interactions, lastSeen, notes:[]}
        enemies: {},
      }
    };

    this.load();

    if (bus) {
      bus.on('heard_speech', (e) => this.recordEvent(`${e.username} said: "${e.message}"`, 1));
    }
  }

  load() {
    if (fs.existsSync(this.filePath)) {
      try {
        const disk = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        this.longTerm = { ...this.longTerm, ...disk };
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
    if (this.working.recentEvents.length > THRESHOLDS.workingMemoryMaxEvents) {
      this.working.recentEvents.shift();
    }
    this.bus?.emit('memory_recorded', entry);
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

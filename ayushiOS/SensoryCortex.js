// SensoryCortex.js
// ─────────────────────────────────────────────────────────────
// EYES, EARS, SKIN, AND INNER EAR (balance/proprioception).
// Every tick, this module takes the raw, messy Mineflayer world
// state and distills it into one clean "snapshot" object that
// the rest of the brain can reason about. Nothing here makes
// decisions — pure perception, no judgment.
// ─────────────────────────────────────────────────────────────

import { THRESHOLDS } from './config.js';

const HOSTILE_MOBS = ['creeper', 'zombie', 'skeleton', 'spider', 'enderman',
                       'witch', 'drowned', 'phantom', 'pillager', 'husk'];

export class SensoryCortex {
  constructor(bot, bus) {
    this.bot = bot;
    this.bus = bus;
    this.recentChat = []; // auditory short buffer, filled by hooking chat events
    this._hookAuditory();
  }

  _hookAuditory() {
    this.bot.on('chat', (username, message) => {
      if (username === this.bot.username) return;
      const entry = { username, message, time: Date.now() };
      this.recentChat.push(entry);
      if (this.recentChat.length > 15) this.recentChat.shift();
      this.bus.emit('heard_speech', entry);
    });
  }

  getSnapshot() {
    const time = this.bot.time;
    const pos = this.bot.entity.position;

    // --- Threats (amygdala's raw material) ---
    const hostiles = Object.values(this.bot.entities).filter(e => {
      if (!e || e.id === this.bot.entity.id) return false;
      const isMob = HOSTILE_MOBS.includes(e.name?.toLowerCase());
      const dist = e.position?.distanceTo(pos) ?? 999;
      return isMob && dist < THRESHOLDS.threatScanRadius;
    });

    // --- Social field ---
    const nearbyPlayers = Object.values(this.bot.players || {})
      .filter(p => p.entity && p.username !== this.bot.username)
      .map(p => ({
        username: p.username,
        distance: +p.entity.position.distanceTo(pos).toFixed(1)
      }))
      .filter(p => p.distance < THRESHOLDS.socialScanRadius)
      .sort((a, b) => a.distance - b.distance);

    // --- Proprioception: what am I carrying / wearing? ---
    const inventory = this.bot.inventory ? this.bot.inventory.items().map(i => ({
      name: i.name, count: i.count
    })) : [];
    const equipped = {
      hand: this.bot.heldItem?.name ?? null,
      offhand: this.bot.inventory?.slots?.[45]?.name ?? null,
    };

    // --- Points of interest nearby (spatial awareness) ---
    let nearestBed = null;
    try {
      const bed = this.bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 10 });
      if (bed) nearestBed = { name: bed.name, position: bed.position };
    } catch (_) { /* pathfinder/world not loaded yet */ }

    const snapshot = {
      timestamp: Date.now(),
      vitality: {
        health: this.bot.health,
        food: this.bot.food,
        saturation: this.bot.foodSaturation,
        oxygen: this.bot.oxygenLevel ?? 20,
      },
      environment: {
        isNight: time.isNight || time.isThunderDay,
        isRaining: this.bot.isRaining ?? false,
        position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
        dimension: this.bot.game?.dimension,
        nearestBed,
      },
      threats: hostiles.map(h => ({
        type: h.name,
        distance: +h.position.distanceTo(pos).toFixed(1)
      })),
      social: { nearbyPlayers },
      body: { inventory, equipped },
      recentChat: [...this.recentChat],
    };

    this.bus.emit('perception', snapshot);
    return snapshot;
  }
}

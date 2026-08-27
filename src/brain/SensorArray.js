// SensorArray.js
// ─────────────────────────────────────────────────────────────
// EXTENDED SENSES — proprioception, motion, hearing, damage.
// SensoryCortex answers "what do I see?" — this answers "what
// is happening to me right now?" and compresses it into a fixed,
// normalized feature vector for the TinyBrain network.
// All reads are O(small) — no world scans, no event-loop risk.
// ─────────────────────────────────────────────────────────────

const clamp01 = (v) => Math.max(0, Math.min(1, v));

const DANGER_SOUNDS = ['creeper.primed', 'zombie', 'skeleton', 'mob.attack', 'bow.hit'];

// Tuning constants — everything normalized into [0,1] for the network.
const SOUND_TTL_MS = 12000;        // how long a heard sound stays in the buffer
const DAMAGE_WINDOW_MS = 8000;     // recent-damage accumulation window
const THREAT_RANGE = 16;           // blocks: full threat proximity at 0m, zero at 16m
const PLAYER_RANGE = 32;           // blocks: same curve for social proximity
const DANGER_SOUND_RANGE = 10;     // blocks: danger sounds closer than this count
const SPRINT_SPEED = 4.3;          // blocks/s: sprint ≈ 1.0 feature value
const FALL_NORMALIZER = 8;         // blocks fallen → feature 1.0

export const NN_FEATURE_COUNT = 22;

export class SensorArray {
  constructor(bot) {
    this.bot = bot;
    // Auditory ring buffer (soundEffectHeard events)
    this.sounds = [];
    this._lastPos = null;
    this._lastPosT = 0;
    this.speed = 0;
    // Damage tracking via health deltas observed between reads
    this.lastHealth = null;
    this.lastFood = null;
    this.damageEvents = []; // {t, amount}

    this._onSound = (soundName, position, category, entityId) => {
      try {
        if (!soundName) return;
        const dist = position && this.bot.entity?.position
          ? this.bot.entity.position.distanceTo(position)
          : null;
        this.sounds.push({ name: String(soundName), t: Date.now(), dist });
        if (this.sounds.length > 30) this.sounds.shift();
      } catch (_) { /* never let a sensor kill the tick */ }
    };
    if (bot) bot.on('soundEffectHeard', this._onSound);
  }

  detach() {
    if (this.bot && this._onSound) this.bot.removeListener('soundEffectHeard', this._onSound);
  }

  _prune(now) {
    this.sounds = this.sounds.filter(s => now - s.t < SOUND_TTL_MS);
    this.damageEvents = this.damageEvents.filter(d => now - d.t < DAMAGE_WINDOW_MS);
  }

  /** Feed latest vitals; returns accumulated recent damage since last call. */
  observeVitals(health, food, t) {
    let newDamage = 0;
    if (this.lastHealth != null && health < this.lastHealth) {
      newDamage = this.lastHealth - health;
      this.damageEvents.push({ t, amount: newDamage });
    }
    this.lastHealth = health;
    if (food != null) this.lastFood = food;
    return newDamage;
  }

  /**
   * @param {object} snapshot — SensoryCortex.getSnapshot() output (may be null)
   * @returns {number[]} normalized feature vector, fixed length NN_FEATURE_COUNT
   */
  readFeatures(snapshot) {
    const now = Date.now();
    this._prune(now);
    const b = this.bot;

    // Motion: horizontal speed from consecutive reads
    const pos = b.entity?.position ?? null;
    if (pos) {
      if (this._lastPos && now > this._lastPosT) {
        const dt = Math.max(1, (now - this._lastPosT) / 1000);
        const dx = pos.x - this._lastPos.x;
        const dz = pos.z - this._lastPos.z;
        this.speed = Math.min(Math.sqrt(dx * dx + dz * dz) / dt, 8);
      }
      this._lastPos = { x: pos.x, y: pos.y, z: pos.z };
      this._lastPosT = now;
    }

    const vital = snapshot?.vitality ?? {};
    const env = snapshot?.environment ?? {};
    const threats = snapshot?.threats ?? [];
    const players = snapshot?.social?.nearbyPlayers ?? [];
    const inv = snapshot?.body?.inventory ?? [];

    const nearestHostile = threats.length ? Math.min(...threats.map(t => t.distance ?? 999)) : 999;
    const nearestPlayer = players.length ? Math.min(...players.map(p => p.distance ?? 999)) : 999;
    const usedSlots = inv.length;
    const heldName = snapshot?.body?.equipped?.hand ?? '';
    const heldClass = /sword/.test(heldName) ? 1 : /pickaxe|axe|shovel|hoe/.test(heldName) ? 0.5 : 0;
    const dangerSound = this.sounds.some(s =>
      DANGER_SOUNDS.some(d => s.name.includes(d)) && (s.dist == null || s.dist < DANGER_SOUND_RANGE));
    const recentDamage = this.damageEvents.reduce((a, d) => a + d.amount, 0);

    const features = [
      clamp01((vital.health ?? 20) / 20),                    // 0 health
      clamp01((vital.food ?? 20) / 20),                      // 1 food
      clamp01((vital.saturation ?? 0) / 5),                  // 2 saturation
      clamp01((vital.oxygen ?? 20) / 20),                    // 3 oxygen
      clamp01((vital.armorSlots ?? 0) / 4),                  // 4 armor
      clamp01(usedSlots / 36),                               // 5 inventory fullness
      clamp01(1 - nearestHostile / THREAT_RANGE),            // 6 threat proximity
      clamp01(threats.length / 6),                           // 7 hostile count
      clamp01(1 - nearestPlayer / PLAYER_RANGE),             // 8 player proximity
      clamp01(players.length / 4),                           // 9 player count
      clamp01((env.lightLevel ?? 15) / 15),                  // 10 light
      env.isNight ? 1 : 0,                                   // 11 night
      env.isRaining ? 1 : 0,                                 // 12 rain
      clamp01(((env.position?.y ?? 64) + 64) / 384),         // 13 altitude (-64..320)
      b.entity?.isInWater ? 1 : 0,                           // 14 in water
      clamp01((b.entity?.metadata?.[0]?.fallDistance ?? b.fallDistance ?? 0) / FALL_NORMALIZER), // 15 falling
      clamp01(this.speed / SPRINT_SPEED),                    // 16 speed (sprint ≈ 1.0)
      clamp01(recentDamage / FALL_NORMALIZER),               // 17 recent damage (8 HP → 1.0)
      dangerSound ? 1 : 0,                                   // 18 danger sound
      ((b.time?.timeOfDay ?? 6000) % 24000) / 24000,         // 19 day phase
      vital.hasFood ? 1 : 0,                                 // 20 has food
      heldClass,                                             // 21 held item class
    ];
    this.lastFeatures = features;
    return features;
  }
}

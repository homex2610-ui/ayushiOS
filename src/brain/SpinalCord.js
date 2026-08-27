// SpinalCord.js
// ─────────────────────────────────────────────────────────────
// REFLEX ARC — bypasses the brain entirely.
//
// REWRITE NOTES (bug-fix pass):
//  1. physicsTick fires 20×/sec — old version ran blockAt() lookups on
//     EVERY tick for 3 separate listeners (CPU burn + reflex storms).
//     Now all per-tick checks are coalesced into one throttled handler.
//  2. EMERGENCY_HEAL_AND_SHIELD used to call bot.activateItem() with
//     nothing useful held — did literally nothing. Now eats best
//     available food (regen needs hunger) + equips shield if present.
//  3. SURFACE_FOR_AIR fired even when the bot was merely low on
//     residual oxygen AFTER surfacing (O2 refills slowly), causing an
//     endless jump loop. Now only triggers while the HEAD is actually
//     submerged, and holds jump until surfaced or timeout.
//  4. Reflexes used to hard-clear the pathfinder goal, fighting every
//     other motor system ("goal was changed" spam). Movement reflexes
//     now use raw control states that layer ON TOP of pathfinding,
//     and only lava/fire clears navigation.
// ─────────────────────────────────────────────────────────────

import * as mc from '../utils/mcdata.js';
import { CombatEngine } from './CombatEngine.js';

export class SpinalCord {
  // Reflexes severe enough to PREEMPT a running task (and resume it after).
  constructor(bot, bus, { onInterrupt, masterName } = {}) {
    this.bot = bot;
    this.bus = bus;
    this.onInterrupt = onInterrupt || (() => {});
    this._masterName = masterName || null;
    this._lastFired = {};
    this._tickCount = 0;
    this._surfacing = false;
    this._fallPeakY = null;
    this._wire();
    // Persist reflex state across reconnects of the same process? No —
    // a new SpinalCord is constructed per connection; GC handles the old.
  }

  static CRITICAL = new Set([
    'FIRE_ESCAPE', 'VOID_FALL_PANIC', 'FALL_MLG', 'SURFACE_FOR_AIR',
    'CREEPER_FLEE', 'HOSTILE_CLOSE_QUARTERS', 'EMERGENCY_HEAL_AND_SHIELD',
  ]);

  _hostileNear(range) {
    const bot = this.bot;
    let best = null, bestD = Infinity;
    try {
      for (const e of Object.values(bot.entities)) {
        if (!e || !e.isValid || !e.position) continue;
        if (e.kind !== 'Hostile mobs' && !mc.isHostile(e)) continue;
        const d = e.position.distanceTo(bot.entity.position);
        if (d < range && d < bestD) { bestD = d; best = e; }
      }
    } catch (_) {}
    return best ? { entity: best, dist: Math.round(bestD), name: best.name } : null;
  }

  _wire() {
    const bot = this.bot;

    // 1. Creeper hiss reflex (event-driven, cheap)
    bot.on('soundEffectHeard', (soundName, position) => {
      if (soundName?.includes('creeper.primed')) {
        if (!bot.entity?.position) return; // can vanish during respawn windows
        const dist = bot.entity.position.distanceTo(position);
        if (dist < 6) this._fire('CREEPER_FLEE', { dist });
      }
    });

    // 2. Critical damage reflex (event-driven)
    bot.on('entityHurt', (entity) => {
      if (bot.entity && entity.id === bot.entity.id && bot.health < 10) {
        this._fire('EMERGENCY_HEAL_AND_SHIELD', { health: bot.health });
      }
    });

    // 3+4+5. Per-tick checks — THROTTLED to every 4th tick (~200ms),
    // coalesced into ONE listener doing at most one block lookup.
    bot.on('physicsTick', () => {
      if ((++this._tickCount & 3) !== 0) return;
      try { this._slowChecks(); } catch (_) {}
    });

    // 6. Sleep -> dream trigger (handed off to MemoryMatrix by AyushiOS)
    bot.on('sleep', () => this.bus.emit('sleep_started', {}));

    // 7. Death reporting for hazard learning.
    bot.on('death', () => {
      this.bus.emit('death_reported', {
        reason: 'death',
        position: bot.entity?.position,
        context: { locationName: 'last_death_position' },
      });
    });

    // 8. Emergency kill switch via in-game whisper.
    bot.on('whisper', (username, message) => {
      if (!this._masterName || username.toLowerCase() !== this._masterName.toLowerCase()) return;
      const cmd = (message || '').trim().toLowerCase();
      if (cmd === '!panic' || cmd === '!shutdown') {
        console.warn(`[SPINAL CORD] \u{1F6A8} Emergency kill switch triggered by ${username}`);
        this.emergencyStop();
      }
    });
  }

  _slowChecks() {
    const bot = this.bot;

    // Fire / lava reflex — check feet block + onFire flag
    if (bot.entity?.onFire) {
      this._fire('FIRE_ESCAPE', {});
    } else {
      const feet = bot.blockAt(bot.entity.position);
      const below = bot.blockAt(bot.entity.position.offset(0, -0.1, 0));
      if (feet?.name === 'lava' || below?.name === 'lava') {
        this._fire('FIRE_ESCAPE', { lava: true });
      }
    }

    // Drowning reflex — ONLY while head is actually submerged.
    // oxygenLevel <= 4 alone kept firing after surfacing because O2
    // refills gradually (the old infinite-jump bug).
    const o2 = bot.oxygenLevel ?? 20;
    if (o2 <= 6 && !this._surfacing) {
      let headInWater = false;
      try {
        const eye = bot.entity.position.offset(0, 1.62, 0);
        headInWater = bot.blockAt(eye)?.name === 'water';
      } catch (_) {}
      if (!headInWater) return; // not drowning — skip
      this._surfacing = true;
      this._fire('SURFACE_FOR_AIR', { o2 });
      // Clear the flag once oxygen has substantially refilled (or after 8s max)
      const start = Date.now();
      const watch = setInterval(() => {
        const done = (bot.oxygenLevel ?? 20) >= 16 || Date.now() - start > 8000;
        if (done || !bot.entity) {
          clearInterval(watch);
          this._surfacing = false;
          try { bot.setControlState('jump', false); } catch (_) {}
        }
      }, 500);
      watch.unref?.();
    }

    // Void / fall panic — falling fast toward the void
    const vy = bot.entity.velocity?.y ?? 0;
    if (vy < -0.9 && bot.entity.position.y < 10) {
      this._fire('VOID_FALL_PANIC', { vy });
      return;
    }

    // Long-fall MLG (migrated from BT hard-interrupts): any fall >7 blocks
    // with a water bucket aboard → attempt MLG, not just void-adjacent falls.
    const groundY = bot.entity.position.y;
    if (this._fallPeakY === null || groundY > this._fallPeakY) this._fallPeakY = groundY;
    if (vy < -0.85) {
      const fallen = this._fallPeakY - groundY;
      if (fallen > 7) {
        const hasBucket = bot.inventory?.items()?.some(i => i.name === 'water_bucket');
        if (hasBucket) { this._fire('FALL_MLG', { fallen: Math.round(fallen) }); return; }
      }
    } else if (bot.entity.onGround) {
      this._fallPeakY = null;
    }

    // Immediate combat danger (migrated from BT hard-interrupts): hostile
    // inside melee range. Low health flees; healthy equips + strikes once.
    const threat = this._hostileNear(bot.health <= 8 ? 6 : 4.5);
    if (threat) {
      this._fire('HOSTILE_CLOSE_QUARTERS', { name: threat.name, dist: threat.dist });
      return;
    }

    // Ranged attacker detection (pillagers, skeletons, blazes): detect early
    // so we can dodge arrows/projectiles before they hit. Pro players always
    // strafe when they see a pillager/skeleton.
    const rangedThreat = this._hostileNear(20);
    if (rangedThreat && ['pillager', 'skeleton', 'blaze', 'witch'].includes(rangedThreat.name)) {
      this._fire('HOSTILE_CLOSE_QUARTERS', { name: rangedThreat.name, dist: rangedThreat.dist });
      return;
    }

    // Arrow/projectile dodge: if an arrow is within 6 blocks, strafe hard
    const incomingArrow = Object.values(bot.entities || {})
      .filter(e => e?.isValid && e.name === 'arrow' && e.position)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
    if (incomingArrow && incomingArrow.position.distanceTo(bot.entity.position) < 6) {
      // Dodge immediately — strafe + jump
      const dodgeDir = Math.random() > 0.5 ? 'left' : 'right';
      bot.setControlState(dodgeDir, true);
      bot.setControlState('jump', true);
      setTimeout(() => {
        try { bot.setControlState(dodgeDir, false); bot.setControlState('jump', false); } catch (_) {}
      }, 500);
    }

    // Critical hunger (starvation damage is imminent at food ≤ 1)
    if ((bot.food ?? 20) <= 1) {
      this._fire('CRITICAL_HUNGER', { food: bot.food });
    }
  }

  /**
   * IMMEDIATE HARD STOP — bypasses all normal control flow.
   */
  emergencyStop() {
    try {
      this.bot.pathfinder?.setGoal?.(null);
      this.bot.pathfinder?.stop?.();
    } catch (_) {}
    try {
      this.bot.stopDigging();
    } catch (_) {}
    try {
      this.bot.clearControlStates();
    } catch (_) {}
    try {
      this.bot.pvp?.stop?.();
    } catch (_) {}
    try {
      this.bot.collectBlock?.cancelTask?.();
    } catch (_) {}
    // Broadcast so MotorCortex and AyushiOS know to stop immediately
    this.bus.emit('emergency_stop', { time: Date.now() });
    console.warn('[SPINAL CORD] Bot hard-stopped — awaiting reconnect or manual restart.');
  }

  _fire(reflexType, meta) {
    // Rate limit per reflex type to prevent log spam + thrash.
    // Emergency types get short windows; informational ones longer.
    const now = Date.now();
    if (!this._lastFired) this._lastFired = {};
    const window = reflexType === 'EMERGENCY_HEAL_AND_SHIELD' ? 2000 : (reflexType === 'HOSTILE_CLOSE_QUARTERS' ? 1000 : 2500);
    if (this._lastFired[reflexType] && now - this._lastFired[reflexType] < window) return;
    this._lastFired[reflexType] = now;

    const critical = SpinalCord.CRITICAL?.has(reflexType);
    console.warn(`[SPINAL CORD] ⚠️ Reflex fired: ${reflexType}${critical ? ' (CRITICAL)' : ''}`, meta);
    // Critical reflexes announce BEFORE the motor runs so MotorCortex can
    // preempt the active task and resume the objective afterwards.
    if (critical) this.bus.emit('reflex_preempt', { reflexType, meta, time: now });
    this.bus.emit('reflex_fired', { reflexType, meta });
    this.onInterrupt(reflexType, meta);
  }
}

// Shared MLG implementation for VOID_FALL_PANIC and FALL_MLG.
async function mlgWaterBucket(bot) {
  try {
    const bucket = bot.inventory.findInventoryItem('water_bucket');
    if (bucket && (bot.entity.velocity?.y ?? 0) < -0.85) {
      await bot.equip(bucket, 'hand');
      await bot.lookAt(bot.entity.position.offset(0, -1, 0), true);
      await bot.activateItem();
      setTimeout(() => { try { bot.deactivateItem(); } catch (_) {} }, 300);
    }
  } catch (_) {}
}

// The actual motor response for each reflex lives in MotorCortex,
// since "how do I move my body" is a motor concern, not a spinal one —
// the spinal cord only decides THAT something must happen NOW.
export const REFLEX_ACTIONS = {
  CREEPER_FLEE(bot) {
    // Sprint away using raw controls layered on top of whatever the
    // brain was doing (no setGoal(null)) — clearing goals caused thrash.
    bot.setControlState('sprint', true);
    bot.setControlState('back', true);
    setTimeout(() => { try { bot.setControlState('back', false); } catch(_){} }, 1500);
  },
  async EMERGENCY_HEAL_AND_SHIELD(bot) {
    // Equip shield AND activate it (sneak to block), then eat food to regen.
    try {
      const shield = bot.inventory.items().find(i => i.name.includes('shield'));
      if (shield && bot.inventory.slots?.[45]?.name !== 'shield') {
        await bot.equip(shield, 'off-hand');
      }
      // Activate shield (sneak blocks damage)
      if (bot.inventory.slots?.[45]?.name?.includes('shield')) {
        bot.activateItem(true); // true = off-hand
        bot.setControlState('sneak', true);
        setTimeout(() => { try { bot.setControlState('sneak', false); } catch(_){} }, 2000);
      }
    } catch (_) {}
    try {
      const { eatBestFood } = await import('../agent/library/skills.js');
      await eatBestFood(bot);
    } catch (_) {}
  },
  FIRE_ESCAPE(bot) {
    // Lava/fire: this one DOES justify stopping navigation.
    try { bot.pathfinder?.setGoal?.(null); } catch (_) {}
    bot.clearControlStates();
    bot.setControlState('jump', true);
    bot.setControlState('forward', true); // move forward+jump out of fire pools
    setTimeout(() => {
      try { bot.setControlState('forward', false); bot.setControlState('jump', false); } catch (_) {}
    }, 1200);
  },
  SURFACE_FOR_AIR(bot) {
    // OLD BUG: just held jump — in a deep lake that meant bobbing at the
    // surface until O2 ran out again. Now: actively swim to the nearest
    // shore; jump-hold only as an instant stopgap while shore lookup runs.
    bot.setControlState('jump', true);
    (async () => {
      try {
        const { isInWater, swimToward, nearestShore } = await import('../agent/SwimController.js');
        if (!isInWater(bot)) return;
        const shore = nearestShore(bot, 48);
        if (shore) {
          await swimToward(bot, shore.x, bot.entity.position.y, shore.z, { timeoutMs: 15000 });
        } else {
          // No loaded shore — hold jump + push forward for 3s, then re-check
          bot.setControlState('forward', true);
          setTimeout(() => {
            try { bot.setControlState('forward', false); bot.setControlState('jump', false); } catch (_) {}
          }, 3000);
        }
      } catch (_) {
        try { bot.setControlState('jump', false); } catch (_) {}
      }
    })();
  },
  async VOID_FALL_PANIC(bot) {
    await mlgWaterBucket(bot);
  },
  async FALL_MLG(bot) {
    await mlgWaterBucket(bot);
  },
  HOSTILE_CLOSE_QUARTERS(bot) {
    // Pro player combat: NEVER fight unarmed. Run, place cover, eat.
    (async () => {
      try {
        const hostile = Object.values(bot.entities || {})
          .filter(e => e?.isValid && e.position && (e.kind === 'Hostile mobs' || mc.isHostile(e)))
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
        if (!hostile) return;

        const health = bot.health ?? 20;
        const hasWeapon = bot.inventory?.items()?.some(i => /_sword|_axe/.test(i.name));
        const hasShield = bot.inventory?.items()?.some(i => i.name === 'shield');
        const isRanged = ['pillager', 'skeleton', 'blaze', 'witch'].includes(hostile.name);

        // CRITICAL HEALTH (≤6): flee with zigzag — no fighting, ever
        if (health <= 6) {
          const engine = new CombatEngine(bot);
          await engine.flee(hostile, 4000);
          // Eat after fleeing
          try {
            const { eatBestFood } = await import('../agent/library/skills.js');
            await eatBestFood(bot);
          } catch (_) {}
          return;
        }

        // UNARMED: NEVER fight. Sprint away + place blocks as cover.
        if (!hasWeapon) {
          const engine = new CombatEngine(bot);
          // Place blocks between us and the mob (pro player move)
          if (isRanged) {
            try {
              const block = bot.blockAt(bot.entity.position.offset(
                Math.sign(hostile.position.x - bot.entity.position.x) * -1.5,
                0,
                Math.sign(hostile.position.z - bot.entity.position.z) * -1.5
              ));
              if (block && bot.canPlaceBlock(block)) {
                const cobble = bot.inventory.items().find(i => i.name === 'cobblestone' || i.name === 'dirt');
                if (cobble) {
                  await bot.equip(cobble, 'hand');
                  await bot.placeBlock(block, { x: 0, y: 1, z: 0 });
                }
              }
            } catch (_) {}
          }
          await engine.flee(hostile, 5000);
          return;
        }

        // ARMED but ranged attacker: close distance fast, then fight
        if (isRanged) {
          const engine = new CombatEngine(bot);
          // Sprint toward ranged attacker to close gap
          bot.setControlState('sprint', true);
          bot.setControlState('forward', true);
          await new Promise(r => setTimeout(r, 1000));
          bot.setControlState('forward', false);
          const killed = await engine.expertFight(hostile, { maxDurationMs: 5000, fleeHealth: 8 });
          if (!killed && health <= 10) {
            await engine.flee(hostile, 3000);
          }
          return;
        }

        // ARMED + melee: use expert combat engine
        const engine = new CombatEngine(bot);
        const killed = await engine.expertFight(hostile, { maxDurationMs: 5000, fleeHealth: 8 });

        if (!killed && health <= 10) {
          await engine.flee(hostile, 3000);
        }
      } catch (_) {}
    })();
  },
  async CRITICAL_HUNGER(bot) {
    // Starvation imminent — eat anything, even rotten flesh.
    try {
      const { eatBestFood } = await import('../agent/library/skills.js');
      await eatBestFood(bot);
    } catch (_) {}
  },
  EMERGENCY_STOP(bot) {
    try { bot.pathfinder?.setGoal?.(null); bot.pathfinder?.stop?.(); } catch (_) {}
    try { bot.stopDigging(); } catch (_) {}
    try { bot.clearControlStates(); } catch (_) {}
    try { bot.pvp?.stop?.(); } catch (_) {}
    try { bot.collectBlock?.cancelTask?.(); } catch (_) {}
    console.warn('[REFLEX] EMERGENCY_STOP executed');
  }
};

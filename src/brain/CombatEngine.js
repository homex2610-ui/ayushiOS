// CombatEngine.js
// ─────────────────────────────────────────────────────────────
// Expert combat engine implementing Java 1.9+ mechanics:
// - Attack cooldown timing (sword: 625ms, axe: 1000ms)
// - Critical hits (jump + attack while falling = 1.5x damage)
// - Sprint-knockback (sprint forward → hit → extra knockback)
// - Shield blocking (activate between hits)
// - Strafing (circle-strafe to dodge attacks)
// - Sweep attacks (sword, grounded, non-crit = AoE)
//
// Based on expert/speedrun combat research.
// ─────────────────────────────────────────────────────────────

import * as mc from '../utils/mcdata.js';

const WEAPON_STATS = {
  'netherite_sword': { damage: 8, speed: 1.6, cooldown: 625 },
  'diamond_sword':   { damage: 7, speed: 1.6, cooldown: 625 },
  'iron_sword':      { damage: 6, speed: 1.6, cooldown: 625 },
  'stone_sword':     { damage: 5, speed: 1.6, cooldown: 625 },
  'wooden_sword':    { damage: 4, speed: 1.6, cooldown: 625 },
  'netherite_axe':   { damage: 10, speed: 1.0, cooldown: 1000 },
  'diamond_axe':     { damage: 9, speed: 1.0, cooldown: 1000 },
  'iron_axe':        { damage: 9, speed: 1.0, cooldown: 1000 },
  'stone_axe':       { damage: 7, speed: 1.0, cooldown: 1000 },
  'wooden_axe':      { damage: 6, speed: 1.0, cooldown: 1000 },
};

const WEAPON_ORDER = [
  'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe',
  'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe',
];

export class CombatEngine {
  constructor(bot) {
    this.bot = bot;
    this._combatActive = false;
    this._lastAttackTime = 0;
  }

  /**
   * Get the best weapon from inventory and its stats.
   */
  getBestWeapon() {
    const items = this.bot.inventory?.items() || [];
    for (const name of WEAPON_ORDER) {
      const item = items.find(i => i.name === name);
      if (item) return { item, stats: WEAPON_STATS[name] || { damage: 1, speed: 4, cooldown: 625 } };
    }
    return { item: null, stats: { damage: 1, speed: 4, cooldown: 625 } };
  }

  /**
   * Wait for full attack cooldown. This is THE key difference between
   * expert play (100% damage) and novice play (25-40% damage).
   */
  async waitForCooldown() {
    const now = Date.now();
    const elapsed = now - this._lastAttackTime;
    const { stats } = this.getBestWeapon();
    const wait = Math.max(0, stats.cooldown - elapsed);
    if (wait > 0) {
      await new Promise(r => setTimeout(r, wait));
    }
  }

  /**
   * Perform a critical hit: jump, wait for falling, then attack.
   * Conditions: cooldown ≥84.8%, player is falling, not on ground, not sprinting.
   * Damage bonus: +50% base damage.
   */
  async criticalHit(target) {
    const bot = this.bot;
    if (!target?.isValid || !bot.entity) return false;

    // Must be on ground to jump
    if (!bot.entity.onGround) return false;

    // Stop sprinting (sprint cancels crit)
    bot.setControlState('sprint', false);

    // Jump
    bot.setControlState('jump', true);
    await new Promise(r => setTimeout(r, 150)); // time to leave ground
    bot.setControlState('jump', false);

    // Wait for apex + start falling (the sweet spot for crit)
    await new Promise(r => setTimeout(r, 100));

    // Attack on downswing = critical hit
    try {
      bot.lookAt(target.position.offset(0, 1.6, 0), true);
      await bot.attack(target);
      this._lastAttackTime = Date.now();
      return true;
    } catch (_) { return false; }
  }

  /**
   * Perform a sweep attack: grounded sword hit (non-crit) that damages
   * nearby mobs. Conditions: cooldown ≥84.8%, standing/walking, not sprinting.
   */
  async sweepAttack(target) {
    const bot = this.bot;
    if (!target?.isValid || !bot.entity) return false;

    const { item } = this.getBestWeapon();
    if (!item?.name?.includes('sword')) return false; // sweep is sword-only

    // Must be on ground and not sprinting
    bot.setControlState('sprint', false);

    try {
      bot.lookAt(target.position.offset(0, 1.6, 0), true);
      await bot.attack(target);
      this._lastAttackTime = Date.now();
      return true;
    } catch (_) { return false; }
  }

  /**
   * Sprint-knockback hit: sprint forward → hit for extra knockback.
   * Great for creating distance from mobs.
   */
  async sprintKnockback(target) {
    const bot = this.bot;
    if (!target?.isValid || !bot.entity) return false;

    const dist = bot.entity.position.distanceTo(target.position);
    if (dist > 4) return false;

    // Sprint toward target
    bot.setControlState('sprint', true);
    await new Promise(r => setTimeout(r, 100));

    // Hit while sprinting = extra knockback
    try {
      bot.lookAt(target.position.offset(0, 1.6, 0), true);
      await bot.attack(target);
      this._lastAttackTime = Date.now();
      this._lastAttackWasSprint = true;
    } catch (_) {}

    // Stop sprint after hit
    bot.setControlState('sprint', false);

    // Back up to safe distance
    bot.setControlState('back', true);
    await new Promise(r => setTimeout(r, 200));
    bot.setControlState('back', false);

    return true;
  }

  /**
   * Activate shield to block incoming damage.
   * Shield blocks 100% of frontal melee/arrow/explosion damage.
   */
  async activateShield() {
    const bot = this.bot;
    const shield = bot.inventory.items().find(i => i.name.includes('shield'));
    if (shield && bot.inventory.slots?.[45]?.name !== 'shield') {
      try { await bot.equip(shield, 'off-hand'); } catch (_) {}
    }
    // Activate shield (right-click)
    try {
      bot.setControlState('sneak', true); // sneak activates shield in some contexts
      await bot.activateItem(); // this activates the held item, including shield in offhand
    } catch (_) {}
  }

  /**
   * Deactivate shield so we can attack.
   */
  deactivateShield() {
    try {
      this.bot.deactivateItem();
      this.bot.setControlState('sneak', false);
    } catch (_) {}
  }

  /**
   * Circle-strafe around a target: move A/D while keeping crosshair on target.
   * Makes the bot harder to hit by ranged and melee mobs.
   */
  async strafe(target, durationMs = 1500) {
    const bot = this.bot;
    if (!target?.isValid || !bot.entity) return;

    const startTime = Date.now();
    let goingLeft = Math.random() > 0.5;

    while (Date.now() - startTime < durationMs && target.isValid && bot.entity) {
      // Look at target
      try { bot.lookAt(target.position.offset(0, 1.6, 0), true); } catch (_) {}

      // Alternate left/right
      bot.setControlState('left', goingLeft);
      bot.setControlState('right', !goingLeft);
      goingLeft = !goingLeft;

      await new Promise(r => setTimeout(r, 400));
    }

    bot.setControlState('left', false);
    bot.setControlState('right', false);
  }

  /**
   * Full expert combat loop against a single target.
   * Implements the optimal combat pattern:
   * 1. Sprint-knockback (create distance)
   * 2. Back up
   * 3. Wait for cooldown
   * 4. Jump-crit (1.5x damage)
   * 5. Wait for cooldown
   * 6. Sweep (if mobs nearby)
   * 7. Strafe while waiting
   * Repeat until dead.
   */
  async expertFight(target, opts = {}) {
    const bot = this.bot;
    const { maxDurationMs = 15000, fleeHealth = 6 } = opts;
    if (!target?.isValid || !bot.entity) return false;

    this._combatActive = true;
    const startTime = Date.now();
    const { stats } = this.getBestWeapon();

    // Equip best weapon
    const { item: weapon } = this.getBestWeapon();
    if (weapon) try { await bot.equip(weapon, 'hand'); } catch (_) {}

    // Equip shield
    const shield = bot.inventory.items().find(i => i.name.includes('shield'));
    if (shield && bot.inventory.slots?.[45]?.name !== 'shield') {
      try { await bot.equip(shield, 'off-hand'); } catch (_) {}
    }

    let hits = 0;
    while (target.isValid && bot.entity && this._combatActive) {
      // Time limit
      if (Date.now() - startTime > maxDurationMs) break;

      // Health check — flee if too low
      if ((bot.health ?? 20) <= fleeHealth) {
        this._combatActive = false;
        return false; // signal to caller to flee
      }

      const dist = bot.entity.position.distanceTo(target.position);

      // Too far — chase
      if (dist > 4) {
        try {
          const { GoalFollow } = await import('mineflayer-pathfinder');
          bot.pathfinder.setGoal(new GoalFollow(target, 2), true);
        } catch (_) {}
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      // In range — execute combat pattern
      // 1. Sprint-knockback
      await this.sprintKnockback(target);
      await this.waitForCooldown();

      // 2. Jump-crit
      if (target.isValid && (bot.health ?? 20) > fleeHealth) {
        await this.criticalHit(target);
        hits++;
        await this.waitForCooldown();
      }

      // 3. Sweep if other hostiles nearby (sword only)
      const nearbyHostiles = Object.values(bot.entities || {})
        .filter(e => e?.isValid && e !== target && e.position && mc.isHostile(e))
        .filter(e => e.position.distanceTo(bot.entity.position) < 4);
      if (nearbyHostiles.length > 0 && target.isValid) {
        await this.sweepAttack(target);
        hits++;
        await this.waitForCooldown();
      }

      // 4. Dodge arrows from ranged attackers (pillager/skeleton/blaze)
      // Pro players always strafe when being shot at
      const isRanged = ['pillager', 'skeleton', 'blaze', 'witch'].includes(target?.name);
      if (isRanged && target.isValid) {
        // Check for incoming projectiles
        const projectiles = Object.values(bot.entities || {})
          .filter(e => e?.isValid && e.name === 'arrow' && e.position)
          .filter(e => e.position.distanceTo(bot.entity.position) < 8);
        if (projectiles.length > 0) {
          // Strafe hard to dodge
          const dodgeDir = Math.random() > 0.5 ? 'left' : 'right';
          bot.setControlState(dodgeDir, true);
          bot.setControlState('jump', true);
          await new Promise(r => setTimeout(r, 400));
          bot.setControlState(dodgeDir, false);
          bot.setControlState('jump', false);
        }
        // Close distance if too far
        const dist = target.position.distanceTo(bot.entity.position);
        if (dist > 3) {
          bot.setControlState('sprint', true);
          bot.setControlState('forward', true);
          await new Promise(r => setTimeout(r, 300));
          bot.setControlState('forward', false);
        }
      }

      // 5. Strafe while waiting for next cooldown
      if (target.isValid) {
        await this.strafe(target, stats.cooldown);
      }
    }

    this._combatActive = false;
    return hits > 0;
  }

  /**
   * Flee from a hostile with zigzag movement.
   */
  async flee(target, durationMs = 3000) {
    const bot = this.bot;
    bot.setControlState('sprint', true);
    bot.setControlState('jump', true);
    bot.setControlState('back', true);

    let goingLeft = Math.random() > 0.5;
    const zigzag = setInterval(() => {
      try {
        bot.setControlState('left', goingLeft);
        bot.setControlState('right', !goingLeft);
        goingLeft = !goingLeft;
      } catch (_) {}
    }, 500);

    await new Promise(r => setTimeout(r, durationMs));

    clearInterval(zigzag);
    // Only clear combat-related states, not ALL states
    bot.setControlState('sprint', false);
    bot.setControlState('back', false);
    bot.setControlState('left', false);
    bot.setControlState('right', false);
    bot.setControlState('jump', false);
  }

  stop() {
    this._combatActive = false;
    try { this.bot.clearControlStates(); } catch (_) {}
  }
}

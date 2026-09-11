// CombatEngine.js
// ─────────────────────────────────────────────────────────────
// EXPERT COMBAT ENGINE — Pro Minecraft Player Mechanics
// Implements ALL advanced combat techniques:
// - Attack cooldown timing (sword: 625ms, axe: 1000ms)
// - Critical hits (jump + attack while falling = 1.5x damage)
// - Sprint-knockback (sprint forward → hit → extra knockback)
// - Shield blocking (activate between hits)
// - Strafing (circle-strafe to dodge attacks)
// - Sweep attacks (sword, grounded, non-crit = AoE)
// - ENHANCED: Prediction, gap-closing, readiness detection
//
// Based on expert/speedrun combat research + pro player techniques.
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
    this._lastTargetPos = null;
    this._targetVelocity = { x: 0, y: 0, z: 0 };
    this._predictionHistory = [];
    this._readiness = 1.0; // 0-1, how ready we are to fight
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
   * Predict where target will be in N milliseconds.
   * Pro players lead their shots based on target velocity.
   */
  predictTargetPosition(target, msAhead = 200) {
    if (!target?.position || !this._lastTargetPos) return target.position;
    
    // Calculate velocity from position change
    const dx = target.position.x - this._lastTargetPos.x;
    const dy = target.position.y - this._lastTargetPos.y;
    const dz = target.position.z - this._lastTargetPos.z;
    
    // Smooth velocity estimate (exponential moving average)
    this._targetVelocity.x = this._targetVelocity.x * 0.7 + dx * 0.3;
    this._targetVelocity.y = this._targetVelocity.y * 0.7 + dy * 0.3;
    this._targetVelocity.z = this._targetVelocity.z * 0.7 + dz * 0.3;
    
    this._lastTargetPos = target.position.clone?.() || { ...target.position };
    
    // Predict position
    const factor = msAhead / 50; // assume 50ms per tick
    return {
      x: target.position.x + this._targetVelocity.x * factor,
      y: target.position.y + this._targetVelocity.y * factor,
      z: target.position.z + this._targetVelocity.z * factor,
    };
  }

  /**
   * Calculate readiness (0-1) based on health, cooldown status, armor.
   * Pro players know when they're in a good position to fight.
   */
  updateReadiness() {
    const now = Date.now();
    const cooldownPercent = Math.max(0, 1 - (now - this._lastAttackTime) / 625);
    const { stats } = this.getBestWeapon();
    const health = this.bot.health ?? 20;
    const maxHealth = 20;
    
    // Health factor: 100% at full, drops to 30% at half-health
    const healthFactor = Math.max(0.3, health / maxHealth);
    
    // Weapon readiness: high when cooldown is done
    const weaponReady = 1 - cooldownPercent;
    
    // Armor factor: check for protection
    const armor = this.bot.inventory?.items()?.filter(i => i.name?.includes('armor')) || [];
    const armorFactor = Math.min(1, armor.length / 4); // 0 to 1 based on armor pieces
    
    // Combined readiness
    this._readiness = (healthFactor * 0.4 + weaponReady * 0.35 + armorFactor * 0.25);
    return this._readiness;
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
   * Calculate optimal attack distance based on weapon type and target.
   * Axes have knockback, swords need positioning.
   */
  getOptimalDistance(target) {
    const { item } = this.getBestWeapon();
    const isAxe = item?.name?.includes('axe');
    const isSword = item?.name?.includes('sword');
    
    // Axes: stay slightly farther for knockback advantage
    if (isAxe) return Math.random() > 0.5 ? 3.5 : 4.0;
    
    // Swords: stay close for crits, dodge incoming attacks
    if (isSword) return 2.5 + Math.random() * 0.5;
    
    // Default
    return 3.0;
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

    // Predict where target will be
    const predictedPos = this.predictTargetPosition(target, 100);
    
    // Attack on downswing = critical hit
    try {
      bot.lookAt({ ...predictedPos, y: predictedPos.y + 1.6 }, true);
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

    const predictedPos = this.predictTargetPosition(target, 50);
    
    try {
      bot.lookAt({ ...predictedPos, y: predictedPos.y + 1.6 }, true);
      await bot.attack(target);
      this._lastAttackTime = Date.now();
      return true;
    } catch (_) { return false; }
  }

  /**
   * Sprint-knockback hit: sprint forward → hit for extra knockback.
   * Great for creating distance from mobs. PRO TECHNIQUE: gap closing.
   */
  async sprintKnockback(target) {
    const bot = this.bot;
    if (!target?.isValid || !bot.entity) return false;

    const dist = bot.entity.position.distanceTo(target.position);
    if (dist > 4) return false;

    // Sprint toward target
    bot.setControlState('sprint', true);
    await new Promise(r => setTimeout(r, 100));

    const predictedPos = this.predictTargetPosition(target, 100);
    
    // Hit while sprinting = extra knockback
    try {
      bot.lookAt({ ...predictedPos, y: predictedPos.y + 1.6 }, true);
      await bot.attack(target);
      this._lastAttackTime = Date.now();
      this._lastAttackWasSprint = true;
    } catch (_) {}

    // Stop sprint after hit
    bot.setControlState('sprint', false);

    // Back up to safe distance (pro players maintain distance)
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
      bot.setControlState('sneak', true);
      await bot.activateItem();
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
   * ENHANCED: Adaptive direction based on threat position.
   * Makes the bot harder to hit by ranged and melee mobs.
   */
  async strafe(target, durationMs = 1500, adaptiveDir = null) {
    const bot = this.bot;
    if (!target?.isValid || !bot.entity) return;

    const startTime = Date.now();
    
    // Choose strafe direction: random or adaptive
    let goingLeft = adaptiveDir !== null ? adaptiveDir : (Math.random() > 0.5);
    
    // If we have multiple threats, strafe away from the largest
    if (!adaptiveDir) {
      const threats = Object.values(bot.entities || {})
        .filter(e => e?.isValid && e !== target && mc.isHostile(e))
        .filter(e => e.position.distanceTo(bot.entity.position) < 6);
      
      if (threats.length > 0) {
        // Calculate average threat direction
        const avgThreatX = threats.reduce((sum, t) => sum + t.position.x, 0) / threats.length;
        const avgThreatZ = threats.reduce((sum, t) => sum + t.position.z, 0) / threats.length;
        
        // Strafe perpendicular to threat vector
        const threatAngle = Math.atan2(avgThreatZ - bot.entity.position.z, avgThreatX - bot.entity.position.x);
        goingLeft = Math.sin(threatAngle) > 0;
      }
    }

    while (Date.now() - startTime < durationMs && target.isValid && bot.entity) {
      // Predict and look at target
      const predictedPos = this.predictTargetPosition(target, 100);
      try { bot.lookAt({ ...predictedPos, y: predictedPos.y + 1.6 }, true); } catch (_) {}

      // Alternate left/right with adaptive direction
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
   * 1. Gap close if needed
   * 2. Sprint-knockback (create distance)
   * 3. Back up
   * 4. Wait for cooldown
   * 5. Jump-crit (1.5x damage)
   * 6. Wait for cooldown
   * 7. Sweep (if mobs nearby)
   * 8. Strafe while waiting (adaptive direction)
   * 9. Repeat until dead.
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
    const optimalDist = this.getOptimalDistance(target);
    
    while (target.isValid && bot.entity && this._combatActive) {
      // Update readiness constantly
      this.updateReadiness();
      
      // Time limit
      if (Date.now() - startTime > maxDurationMs) break;

      // Health check — flee if too low
      if ((bot.health ?? 20) <= fleeHealth) {
        this._combatActive = false;
        return false; // signal to caller to flee
      }

      const dist = bot.entity.position.distanceTo(target.position);

      // ── GAP CLOSING: Pro technique ──
      // If we're far but readiness is high, close in aggressively
      if (dist > optimalDist + 2 && this._readiness > 0.6) {
        try {
          const { GoalFollow } = await import('mineflayer-pathfinder');
          bot.pathfinder.setGoal(new GoalFollow(target, Math.max(2, optimalDist - 0.5)), true);
        } catch (_) {}
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      // Too far — chase cautiously
      if (dist > optimalDist + 1) {
        try {
          const { GoalFollow } = await import('mineflayer-pathfinder');
          bot.pathfinder.setGoal(new GoalFollow(target, optimalDist), true);
        } catch (_) {}
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      // In range — execute combat pattern
      // 1. Sprint-knockback (only if readiness high)
      if (this._readiness > 0.65 && target.isValid) {
        await this.sprintKnockback(target);
        await this.waitForCooldown();
      }

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
      const isRanged = ['pillager', 'skeleton', 'blaze', 'witch'].includes(target?.name);
      if (isRanged && target.isValid) {
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
        const currentDist = target.position.distanceTo(bot.entity.position);
        if (currentDist > 3) {
          bot.setControlState('sprint', true);
          bot.setControlState('forward', true);
          await new Promise(r => setTimeout(r, 300));
          bot.setControlState('forward', false);
        }
      }

      // 5. Strafe while waiting for next cooldown (adaptive direction)
      if (target.isValid) {
        const strafeDir = nearbyHostiles.length > 0; // true = go left if multiple threats
        await this.strafe(target, stats.cooldown, strafeDir);
      }
    }

    this._combatActive = false;
    return hits > 0;
  }

  /**
   * Flee from a hostile with zigzag movement.
   * PRO TECHNIQUE: Use knockback resistance and water to escape.
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

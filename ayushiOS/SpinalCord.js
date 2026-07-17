// SpinalCord.js
// ─────────────────────────────────────────────────────────────
// REFLEX ARC — bypasses the brain entirely.
// The Executive Brain only "thinks" every ~2 seconds. A creeper
// hiss or a fall into lava can kill in far less time than that.
// This module hooks raw Mineflayer events directly and reacts
// instantly, aborting whatever the Motor Cortex was doing.
// ─────────────────────────────────────────────────────────────

export class SpinalCord {
  constructor(bot, bus, { onInterrupt } = {}) {
    this.bot = bot;
    this.bus = bus;
    this.onInterrupt = onInterrupt || (() => {});
    this._wire();
  }

  _wire() {
    // 1. Creeper hiss reflex
    this.bot.on('soundEffectHeard', (soundName, position) => {
      if (soundName?.includes('creeper.primed')) {
        const dist = this.bot.entity.position.distanceTo(position);
        if (dist < 6) this._fire('CREEPER_FLEE', { dist });
      }
    });

    // 2. Critical damage reflex
    this.bot.on('entityHurt', (entity) => {
      if (entity.id === this.bot.entity.id && this.bot.health < 10) {
        this._fire('EMERGENCY_HEAL_AND_SHIELD', { health: this.bot.health });
      }
    });

    // 3. Fire / lava reflex
    this.bot.on('physicsTick', () => {
      const block = this.bot.blockAt(this.bot.entity.position);
      if (this.bot.entity.onFire || block?.name === 'lava') {
        this._fire('FIRE_ESCAPE', {});
      }
    });

    // 4. Drowning reflex — surface for air
    this.bot.on('physicsTick', () => {
      if ((this.bot.oxygenLevel ?? 20) <= 4) {
        this._fire('SURFACE_FOR_AIR', {});
      }
    });

    // 5. Void / fall edge reflex (cheap heuristic: falling fast, no ground soon)
    this.bot.on('physicsTick', () => {
      const vy = this.bot.entity.velocity?.y ?? 0;
      if (vy < -0.9 && this.bot.entity.position.y < 10) {
        this._fire('VOID_FALL_PANIC', { vy });
      }
    });

    // 6. Sleep -> dream trigger (handed off to MemoryMatrix by AyushiOS)
    this.bot.on('sleep', () => this.bus.emit('sleep_started', {}));

    // 7. Death reporting for memory and hazard learning.
    this.bot.on('death', () => {
      this.bus.emit('death_reported', {
        reason: 'death',
        position: this.bot.entity?.position,
      });
    });
  }

  _fire(reflexType, meta) {
    console.warn(`[SPINAL CORD] \u26A0\uFE0F Reflex fired: ${reflexType}`, meta);
    this.bus.emit('reflex_fired', { reflexType, meta });
    this.onInterrupt(reflexType, meta);
  }
}

// The actual motor response for each reflex lives in MotorCortex,
// since "how do I move my body" is a motor concern, not a spinal one —
// the spinal cord only decides THAT something must happen NOW.
export const REFLEX_ACTIONS = {
  async CREEPER_FLEE(bot) {
    bot.setControlState('sprint', true);
    bot.setControlState('jump', true);
    bot.setControlState('back', true);
    setTimeout(() => bot.clearControlStates(), 2000);
  },
  async EMERGENCY_HEAL_AND_SHIELD(bot) {
    const shield = bot.inventory.items().find(i => i.name.includes('shield'));
    if (shield) await bot.equip(shield, 'off-hand');
    bot.activateItem();
  },
  async FIRE_ESCAPE(bot) {
    bot.setControlState('jump', true);
    bot.setControlState('back', true);
    setTimeout(() => bot.clearControlStates(), 1000);
  },
  async SURFACE_FOR_AIR(bot) {
    bot.setControlState('jump', true);
    setTimeout(() => bot.setControlState('jump', false), 1500);
  },
  async VOID_FALL_PANIC(bot) {
    // Try to place a block beneath if possible (best-effort, needs pathfinder/scaffolding logic)
    bot.setControlState('jump', false);
  }
};

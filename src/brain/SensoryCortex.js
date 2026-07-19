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
    this.recentChat = []; // auditory short buffer
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
      head: this.bot.inventory?.slots?.[5]?.name ?? null,
      torso: this.bot.inventory?.slots?.[6]?.name ?? null,
      legs: this.bot.inventory?.slots?.[7]?.name ?? null,
      feet: this.bot.inventory?.slots?.[8]?.name ?? null,
    };

    // --- Equipment analysis ---
    const armorSlots = [equipped.head, equipped.torso, equipped.legs, equipped.feet].filter(Boolean);
    const hasDiamondArmor = armorSlots.some(a => a.includes('diamond'));
    const hasIronArmor = armorSlots.some(a => a.includes('iron'));
    const hasTool = (type) => inventory.some(i => i.name.includes(type) && (i.name.includes('pickaxe') || i.name.includes('axe') || i.name.includes('shovel') || i.name.includes('sword') || i.name.includes('hoe')));
    const hasDiamondTool = inventory.some(i => i.name.includes('diamond') && (i.name.includes('pickaxe') || i.name.includes('axe') || i.name.includes('sword')));
    const hasFood = inventory.some(i => i.name.includes('apple') || i.name.includes('bread') || i.name.includes('cooked') || i.name.includes('steak') || i.name.includes('pork') || i.name.includes('potato') || i.name.includes('carrot') || i.name.includes('beetroot') || i.name.includes('golden') || i.name.includes('mutton') || i.name.includes('rabbit') || i.name.includes('fish') || i.name.includes('beef') || i.name.includes('chicken') || i.name.includes('cookie') || i.name.includes('cake') || i.name.includes('pie') || i.name.includes('berry') || i.name.includes('melon') || i.name.includes('stew') || i.name.includes('soup') || i.name.includes('honey'));
    const hasOre = (ore) => inventory.some(i => i.name.includes(ore));
    const hasTorch = inventory.some(i => i.name === 'torch');
    const hasShield = inventory.some(i => i.name === 'shield');
    const hasWaterBucket = inventory.some(i => i.name === 'water_bucket');

    // --- Points of interest nearby (spatial awareness) ---
    let nearestBed = null;
    let nearestChest = null;
    let nearestWorkstation = null;
    try {
      const bed = this.bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 10 });
      if (bed) nearestBed = { name: bed.name, position: bed.position };
      const chest = this.bot.findBlock({ matching: b => b.name === 'chest' || b.name === 'trapped_chest' || b.name === 'barrel', maxDistance: 10 });
      if (chest) nearestChest = { name: chest.name, position: chest.position };
      const table = this.bot.findBlock({ matching: b => b.name === 'crafting_table' || b.name === 'furnace' || b.name === 'anvil' || b.name === 'enchanting_table', maxDistance: 10 });
      if (table) nearestWorkstation = { name: table.name, position: table.position };
    } catch (_) { /* pathfinder/world not loaded yet */ }

    // Check both inventory and placed blocks nearby (placing removes from inventory)
    const hasCraftingTable = inventory.some(i => i.name === 'crafting_table') || nearestWorkstation?.name === 'crafting_table';
    const hasFurnace = inventory.some(i => i.name === 'furnace') || nearestWorkstation?.name === 'furnace';
    const hasChest = inventory.some(i => i.name === 'chest') || nearestChest !== null;
    const hasBed = inventory.some(i => i.name.includes('bed')) || nearestBed !== null;

    const currentPos = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
    const snapshot = {
      timestamp: Date.now(),
      vitality: {
        health: this.bot.health,
        food: this.bot.food,
        saturation: this.bot.foodSaturation,
        oxygen: this.bot.oxygenLevel ?? 20,
        armorSlots: armorSlots.length,
        hasFood,
      },
      equipment: {
        hasDiamondArmor,
        hasIronArmor,
        hasDiamondTool,
        hasTool,
        hasShield,
        hasTorch,
        hasWaterBucket,
        armorSlots: armorSlots.length,
      },
      resources: {
        hasCraftingTable,
        hasFurnace,
        hasChest,
        hasBed,
        hasOre,
        hasFood,
        inventory,
      },
      environment: {
        isNight: time.isNight || time.isThunderDay,
        isRaining: this.bot.isRaining ?? false,
        position: currentPos,
        dimension: this.bot.game?.dimension,
        nearestBed,
        nearestChest,
        nearestWorkstation,
        lightLevel: pos ? (this.bot.blockAt(pos)?.light ?? 15) : 15,
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

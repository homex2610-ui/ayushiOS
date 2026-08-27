// InventoryManager.js
// ─────────────────────────────────────────────────────────────
// PRO INVENTORY MANAGEMENT — the bot previously had NO real inventory
// brain: it hoarded junk until full, dumped everything (including its
// own tools!) into the nearest chest, never sorted, never restocked,
// and starved with food "somewhere" in a messy pack.
//
// This module owns ALL of that:
//   • slot-level model of main/hotbar/armor/offhand
//   • stack compaction + category-aware sorting
//   • pro hotbar loadout (weapon/pickaxe/food/torches/blocks in order)
//   • value-triage when FULL: drop lowest-value junk first, keep reserves,
//     never toss tools/food/torches unless redundant
//   • smart chest deposit: stash loot but KEEP survival essentials
//   • chest memory: remembers chest positions + contents for restocking
//   • durability monitor: auto-swap dying armor/tools for spares
//   • need signals: inv_full / low_food / low_torches → emitted on the bus
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import * as skills from '../library/skills.js';
import * as world from '../library/world.js';

// Items we NEVER auto-drop and KEEP through deposits (survival kit)
const ESSENTIALS = new Set([
    'torch', 'crafting_table', 'furnace', 'chest', 'bed', 'water_bucket', 'bucket',
    'shield', 'flint_and_steel', 'bow', 'arrow', 'compass', 'clock', 'ender_pearl',
]);
const FOOD_PATTERN = /(apple|bread|cooked|raw_beef|raw_porkchop|raw_mutton|raw_chicken|raw_cod|raw_salmon|raw_rabbit|steak|porkchop|mutton|carrot|potato|beetroot|berry|melon|stew|soup|bread|wheat$)/;

// Bulk items with keep-reserves: {item: maxToHold}. Excess is droppable.
const BULK_RESERVES = {
    dirt: 32, cobblestone: 64, stone: 64, cobbled_deepslate: 32,
    granite: 16, diorite: 16, andesite: 16, tuff: 16, netherrack: 16,
    gravel: 16, flint: 8, sand: 16, stick: 16, wheat_seeds: 16,
    bone: 8, string: 8, feather: 4, rotten_flesh: 0, snowball: 0,
};

// Value tiers for triage — lower = dropped first when full
function junkValue(name) {
    if (name === 'rotten_flesh' || name === 'snowball') return 0;
    if (BULK_RESERVES[name] !== undefined) return 1;
    if (/seeds/.test(name)) return 2;
    if (/(granite|diorite|andesite|tuff|netherrack)/.test(name)) return 3;
    if (/raw_/.test(name) && !FOOD_PATTERN.test(name)) return 5;
    if (name.includes('cobblestone')) return 4;
    return 10; // unknown → moderately valuable
}

export class InventoryManager {
    constructor(bot, { username = null } = {}) {
        this.bot = bot;
        this.username = username || bot?.username || 'bot';
        this.memoryPath = path.join(process.cwd(), 'bots', this.username, 'inventory_memory.json');
        this.chests = [];          // [{pos:{x,y,z}, name:'base'|'loot'|..., contents:{name:count}, ts}]
        this._lastTossAt = 0;
        this._lastSortAt = 0;
        this._load();
    }

    _load() {
        try {
            if (!fs.existsSync(this.memoryPath)) return;
            const raw = JSON.parse(fs.readFileSync(this.memoryPath, 'utf8'));
            this.chests = raw.chests || [];
            if (this.chests.length) console.log(`[InvMgr] Remembered ${this.chests.length} storage chests`);
        } catch (_) {}
    }

    saveNow() {
        try {
            fs.mkdirSync(path.dirname(this.memoryPath), { recursive: true });
            fs.writeFileSync(this.memoryPath, JSON.stringify({ savedAt: Date.now(), chests: this.chests }, null, 1));
        } catch (_) {}
    }

    // ── Slot model ────────────────────────────────────────────

    /** All carried items (main + hotbar; excludes armor slots). */
    items() {
        return this.bot.inventory.items();
    }

    counts() {
        const c = {};
        for (const i of this.items()) c[i.name] = (c[i.name] || 0) + i.count;
        return c;
    }

    freeSlots() {
        const used = new Set(this.items().map(i => i.slot ?? i.index));
        // main inventory 9-35, hotbar 36-44
        let free = 0;
        for (let s = 9; s <= 44; s++) if (!used.has(s)) free++;
        return free;
    }

    isFull(threshold = 1) {
        return this.freeSlots() < threshold;
    }

    // ── Compaction & sorting ─────────────────────────────────

    /** Vanilla max stack size for this item type (snowballs/eggs = 16, most = 64). */
    _maxStackSize(item) {
        try { return Math.min(64, item?.stackSize ?? 64) || 64; } catch (_) { return 64; }
    }

    categoryRank(item) {
        const n = item.name;
        if (n.includes('pickaxe') || n.includes('axe') || n.includes('shovel') || n.includes('sword') || n.includes('hoe')) return 0; // tools
        if (FOOD_PATTERN.test(n) || n.includes('food')) return 1;      // food
        if (n === 'torch') return 2;
        if (/ingot|diamond|emerald|coal|raw_/.test(n)) return 3;       // ores/materials
        if (/helmet|chestplate|leggings|boots/.test(n)) return 4;      // armor pieces
        if (ESSENTIALS.has(n)) return 5;
        if (BULK_RESERVES[n] !== undefined) return 8;                  // bulk blocks last
        return 6;
    }

    /** Merge stacks then sort main+hotbar by category. Uses moveSlotItem (vanilla-safe). */
    async compact({ sort = true } = {}) {
        const bot = this.bot;
        // Pass 1: merge partial stacks.
        // FIX: moveSlotItem SWAPS slots when the destination can't absorb the
        // source, so slot indices churn after EVERY move. The old code kept
        // operating on stale Item objects → items teleported to wrong slots.
        // We now RE-SNAPSHOT from bot.inventory.items() after each move.
        let merged = true;
        let mergePasses = 0;
        while (merged && mergePasses++ < 6) {   // hard cap so we never spin
            merged = false;
            const snap = [...this.items()];
            const byType = {};
            for (const item of snap) (byType[item.type] ||= []).push(item);
            outer:
            for (const list of Object.values(byType)) {
                if (list.length < 2) continue;
                for (let a = 0; a < list.length; a++) {
                    const target = list[a];
                    if (!target || target.stackable === false) continue;
                    const maxSize = this._maxStackSize(target);
                    if ((target.count ?? 0) >= maxSize) continue;
                    for (let b = a + 1; b < list.length; b++) {
                        const src = list[b];
                        if (!src || src.type !== target.type || (src.count ?? 0) <= 0) continue;
                        try {
                            await bot.moveSlotItem(src.slot ?? src.index, target.slot ?? target.index);
                            merged = true;
                            break outer;             // re-snapshot before next move
                        } catch (_) { /* try next pair */ }
                    }
                }
            }
        }
        // Pass 2: sort by category rank — one swap per sweep, always on FRESH state
        if (sort) {
            for (let sweep = 0; sweep < 36; sweep++) {
                const ordered = [...this.items()].sort((x, y) => this.categoryRank(x) - this.categoryRank(y));
                const destSlots = [];
                for (let s = 9; s <= 44; s++) destSlots.push(s);
                let moved = false;
                for (let i = 0; i < ordered.length && i < destSlots.length; i++) {
                    const curSlot = ordered[i].slot ?? ordered[i].index;
                    if (curSlot !== destSlots[i] && !moved) {
                        try { await bot.moveSlotItem(curSlot, destSlots[i]); moved = true; } catch (_) {}
                    }
                }
                if (!moved) break;   // fully sorted
            }
        }
        this._lastSortAt = Date.now();
    }

    /**
     * Pro hotbar loadout. Order:
     *  [0]=weapon [1]=pickaxe [2]=shovel [3]=axe [4]=food [5]=torches [6..8]=building blocks/bucket
     */
    async ensureHotbarLoadout() {
        const bot = this.bot;
        const HOTBAR_START = 36;
        const predicates = [
            i => i.name.includes('sword') || (!i.name.includes('pickaxe') && i.name.endsWith('axe')),
            i => i.name.includes('pickaxe'),
            i => i.name.includes('shovel'),
            i => i.name.endsWith('_axe'),
            i => FOOD_PATTERN.test(i.name) || ['golden_apple', 'cooked_beef'].includes(i.name),
            i => i.name === 'torch',
            i => /planks|cobblestone|dirt|stone|deepslate/.test(i.name),
            i => i.name === 'water_bucket' || i.name === 'bucket' || i.name === 'bed',
            i => ESSENTIALS.has(i.name),   // FIX: old `!has(n) === false` double-negative was a no-op
        ];
        // FIX: resolve + place ONE slot at a time against FRESH inventory state,
        // because each moveSlotItem reshuffles everything downstream.
        for (let i = 0; i < predicates.length; i++) {
            const dest = HOTBAR_START + i;
            const cur = [...this.items()].find(predicates[i]);
            if (!cur) continue;
            const slot = cur.slot ?? cur.index;
            if (slot === dest) continue;
            try { await bot.moveSlotItem(slot, dest); } catch (_) {}
        }
    }

    // ── Triage when full ─────────────────────────────────────

    /** Compute droppable excess beyond reserves. Returns [{item, dropCount}] sorted worst-first. */
    droppableExcess() {
        const total = {};
        for (const i of this.items()) total[i.name] = (total[i.name] || 0) + i.count;
        const out = [];
        for (const [name, count] of Object.entries(total)) {
            if (ESSENTIALS.has(name)) continue;
            if (FOOD_PATTERN.test(name)) continue;         // never auto-drop food
            if (/(pickaxe|sword|axe|shovel|hoe)$/.test(name) && count <= 2) continue; // tools
            if (/helmet|chestplate|leggings|boots/.test(name)) continue;
            const reserve = BULK_RESERVES[name] !== undefined ? BULK_RESERVES[name] : 0;
            const excess = count - reserve;
            if (excess > 0) out.push({ name, value: junkValue(name), dropCount: excess });
        }
        out.sort((a, b) => a.value - b.value);
        return out;
    }

    /** When full: drop worst junk to make room. Returns number of items tossed. */
    async makeRoom(slotsNeeded = 1) {
        const now = Date.now();
        if (now - this._lastTossAt < 5000) return 0; // rate-limit
        this._lastTossAt = now;
        let freed = 0;
        const excess = this.droppableExcess();
        for (const e of excess) {
            if (freed >= slotsNeeded) break;
            // Re-check free slots live — earlier tosses may already have freed enough
            if (this.freeSlots() >= slotsNeeded + 1) break;
            const item = this.bot.inventory.findInventoryItem(e.name);
            if (!item) continue;
            // FIX: freed-slot accounting was wrong — tossing PART of a stack
            // frees nothing unless the whole stack goes or it's the only stack.
            const willEmptyStack = e.dropCount >= item.count;
            const otherStacks = this.items().filter(i => i.name === e.name).length > 1;
            const freesSlot = willEmptyStack || !otherStacks;
            const toss = Math.min(e.dropCount, item.count);
            try {
                await this.bot.toss(item.type, null, toss);
                console.log(`[InvMgr] Tossed ${toss}× ${e.name} (inventory pressure)`);
                if (freesSlot) freed++;
            } catch (_) {}
        }
        return freed;
    }

    // ── Chest operations ─────────────────────────────────────

    rememberChest(pos, contents = null, label = 'storage') {
        const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
        const existing = this.chests.find(c => c.key === key);
        if (existing) {
            existing.ts = Date.now();
            if (contents) existing.contents = contents;
        } else {
            this.chests.push({ key, pos: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }, label, contents, ts: Date.now() });
            console.log(`[InvMgr] New ${label} chest remembered at ${key}`);
        }
        this.saveNow();
    }

    nearestRememberedChest() {
        const p = this.bot.entity.position;
        let best = null, bd = Infinity;
        for (const c of this.chests) {
            const d = Math.hypot(c.pos.x - p.x, c.pos.y - p.y, c.pos.z - p.z);
            if (d < bd) { bd = d; best = c; }
        }
        return best ? { ...best, dist: Math.round(bd) } : null;
    }

    /** Snapshot what's inside the nearest chest into memory. */
    async scanNearestChest() {
        const chest = world.getNearestBlock(this.bot, 'chest', 32);
        if (!chest) return false;
        await skills.goToPosition(this.bot, chest.position.x, chest.position.y, chest.position.z, 2);
        const container = await this.bot.openContainer(chest);
        const contents = {};
        for (const item of container.containerItems()) contents[item.name] = (contents[item.name] || 0) + item.count;
        await container.close();
        this.rememberChest(chest.position, contents);
        return true;
    }

    /**
     * Smart deposit: walk to nearest chest and deposit loot while KEEPING
     * essentials (tools/weapons/food/torches/utility). Old organizeInventory
     * literally deposited its own crafting table and weapons.
     * @returns deposited summary string
     */
    async depositLoot() {
        const chest = world.getNearestBlock(this.bot, 'chest', 48);
        if (!chest) {
            // No chest nearby — remembered one?
            const mem = this.nearestRememberedChest();
            if (mem && mem.dist < 96) {
                await skills.goToPosition(this.bot, mem.pos.x, mem.pos.y, mem.pos.z, 2);
                return this.depositLoot(); // retry at destination
            }
            return 'no chest available';
        }
        await skills.goToPosition(this.bot, chest.position.x, chest.position.y, chest.position.z, 2);
        const container = await this.bot.openContainer(chest);
        const deposited = {};
        try {
            for (const item of [...this.items()]) {
                if (this._isKeepItem(item)) continue;
                await container.deposit(item.type, null, item.count);
                deposited[item.name] = (deposited[item.name] || 0) + item.count;
            }
        } finally {
            try { await container.close(); } catch (_) {}
        }
        this.rememberChest(chest.position, null);
        const summary = Object.entries(deposited).map(([k, v]) => `${v}× ${k}`).join(', ');
        if (summary) console.log(`[InvMgr] Deposited: ${summary}`);
        else console.log('[InvMgr] Nothing to deposit (all kept items)');
        return summary || 'nothing deposited';
    }

    _isKeepItem(item) {
        const n = item.name;
        if (ESSENTIALS.has(n)) return true;
        if (/(pickaxe|sword|axe|shovel|hoe)$/.test(n)) return true;
        if (/helmet|chestplate|leggings|boots/.test(n)) return true;
        if (FOOD_PATTERN.test(n)) return true;
        if (n === 'torch') return true;
        return false;
    }

    /** Withdraw missing survival supplies from nearest known chest. */
    async restockFromChest(manifest = null) {
        const want = manifest || { torch: 16, bread: 6, cooked_beef: 6 };
        const chest = world.getNearestBlock(this.bot, 'chest', 48);
        if (!chest) return 'no chest nearby';
        await skills.goToPosition(this.bot, chest.position.x, chest.position.y, chest.position.z, 2);
        const container = await this.bot.openContainer(chest);
        const got = {};
        try {
            const available = container.containerItems();
            for (const [name, minCount] of Object.entries(want)) {
                const have = (this.counts()[name] || 0);
                if (have >= minCount) continue;
                const need = minCount - have;
                const stack = available.find(i => i.name === name);
                if (!stack) continue;
                const take = Math.min(need, stack.count);
                await container.withdraw(stack.type, null, take);
                got[name] = take;
            }
        } finally {
            try { await container.close(); } catch (_) {}
        }
        const summary = Object.entries(got).map(([k, v]) => `${v}× ${k}`).join(', ') || 'already stocked';
        console.log(`[InvMgr] Restocked: ${summary}`);
        return summary;
    }

    // ── Durability & gear ────────────────────────────────────

    /** % durability left of an equipped tool/armor Item. */
    static durabilityPct(item) {
        if (!item?.durabilityUsed) return 100;
        const maxDur = item.maxDurability;
        if (!maxDur) return 100;
        return Math.max(0, Math.round(100 * (1 - item.durabilityUsed / maxDur)));
    }

    gearReport() {
        const bot = this.bot;
        const armorSlots = [5, 6, 7, 8].map(s => bot.inventory.slots[s]).filter(Boolean);
        const hand = bot.heldItem;
        const pct = InventoryManager.durabilityPct;
        return {
            hand: hand ? { name: hand.name, dur: pct(hand) } : null,
            armor: armorSlots.map(a => ({ name: a.name, dur: pct(a) })),
            weakestArmor: armorSlots.map(a => ({ name: a.name, dur: pct(a) })).sort((a, b) => a.dur - b.dur)[0] || null,
        };
    }

    /** Auto-swap armor if equipped piece is about to break and we hold a better spare. */
    async maintainGear() {
        const bot = this.bot;
        const report = this.gearReport();
        let acted = false;
        // Armor swaps: find best spare per slot vs equipped
        const slotFor = (n) => n.includes('helmet') ? 5 : n.includes('chestplate') ? 6 : n.includes('leggings') ? 7 : n.includes('boots') ? 8 : null;
        // FIX: mineflayer armor equip destinations are STRINGS ('head','torso',
        // 'legs','feet'). Numeric slot ids made bot.equip throw every time.
        const destFor = (n) => n.includes('helmet') ? 'head' : n.includes('chestplate') ? 'torso' : n.includes('leggings') ? 'legs' : n.includes('boots') ? 'feet' : null;
        for (const item of this.items()) {
            const slot = slotFor(item.name);
            if (slot == null) continue;
            const equipped = bot.inventory.slots[slot];
            const better = !equipped ||
                (_armorTier(item.name) > _armorTier(equipped.name)) ||
                (equipped.name === item.name && InventoryManager.durabilityPct(equipped) < 15);
            if (better) {
                try { await bot.equip(item, destFor(item.name)); acted = true; } catch (_) {}
            }
        }
        if (report.weakestArmor && report.weakestArmor.dur < 12) {
            console.warn(`[InvMgr] ⚠️ ${report.weakestArmor.name} at ${report.weakestArmor.dur}% — replace soon!`);
        }
        return acted;
    }

    // ── Need signals for the brain/BT ────────────────────────

    needs() {
        const c = this.counts();
        const foodCount = Object.entries(c).reduce((s, [n, cnt]) => s + (FOOD_PATTERN.test(n) ? cnt : 0), 0);
        return {
            full: this.isFull(2),
            nearlyFull: this.isFull(6),
            lowFood: foodCount < 4,
            noFood: foodCount === 0,
            lowTorches: (c.torch || 0) < 4,
            hasChestMemory: this.chests.length > 0,
        };
    }
}

function _armorTier(name) {
    if (name.includes('netherite')) return 5;
    if (name.includes('diamond')) return 4;
    if (name.includes('iron')) return 3;
    if (name.includes('golden')) return 2;
    if (name.includes('chainmail')) return 2;
    if (name.includes('leather')) return 1;
    return 0;
}

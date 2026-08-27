// spatial_vision.js
// ─────────────────────────────────────────────────────────────
// Deterministic "eyes" for the bot: scans the loaded world around
// her and returns WHERE things are (trees, water, animals, ores,
// loot, hostiles) with directions + distances. No LLM, no images
// — pure block/entity queries on mineflayer's already-loaded
// chunks. Feeds SensoryCortex and guides wandering.
// ─────────────────────────────────────────────────────────────

import { Vec3 } from 'vec3';

const TREE_LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log',
    'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log'];
const ORES = ['coal_ore', 'iron_ore', 'copper_ore', 'gold_ore', 'diamond_ore',
    'redstone_ore', 'lapis_ore', 'emerald_ore', 'deepslate_coal_ore',
    'deepslate_iron_ore', 'deepslate_gold_ore', 'deepslate_diamond_ore'];
const WORKSTATIONS = ['crafting_table', 'furnace', 'anvil'];

export class SpatialVision {
    constructor(bot) {
        this.bot = bot;
        this._lastScan = 0;
        this._cache = null;      // 1s cache so multiple callers share one scan
        this._cacheMs = 1000;
        // Direction names by yaw quadrant (mineflayer: yaw 0 = +Z south)
        this.DIRS = ['south', 'south-west', 'west', 'north-west',
            'north', 'north-east', 'east', 'south-east'];
    }

    _dirOf(dx, dz) {
        const yaw = Math.atan2(-dx, dz);       // matches mineflayer convention
        const oct = Math.round(yaw / (Math.PI / 4)) & 7;
        return this.DIRS[(oct + 8) % 8];
    }

    /**
     * One full scan of the visible world.
     * @returns {object} { trees[], animals[], hostileCount, loot[], ores[],
     *                    waterDir, lavaNear, workstations, playerCount }
     */
    scan(radius = 48) {
        const bot = this.bot;
        if (!bot?.entity) return { empty: true };
        const now = Date.now();
        if (this._cache && now - this._lastScan < this._cacheMs) return this._cache;

        const pos = bot.entity.position;
        const out = {
            pos: `${pos.x.toFixed(0)} ${pos.y.toFixed(0)} ${pos.z.toFixed(0)}`,
            trees: [], animals: [], loot: [], ores: [],
            hostileCount: 0, nearestHostile: null,
            waterDir: null, waterDist: null, lavaNear: false,
            workstations: [], playerCount: 0, empty: false,
        };

        const addTree = (b) => {
            const d = b.position.distanceTo(pos);
            if (d > radius) return;
            const dir = this._dirOf(b.position.x - pos.x, b.position.z - pos.z);
            let t = out.trees.find(t => t.dir === t2dir(t.raw, dir));
            function t2dir(a, b2) { return a.dir === b2 ? a.dir : b2; }
            // group by direction
            let g = out.trees.find(g => g.dir === dir);
            if (!g) { g = { dir, dist: Math.round(d), count: 0 }; out.trees.push(g); }
            g.count++;
            if (d < g.dist || g.dist === undefined) g.dist = Math.round(d);
        };

        try {
            // ---- Block field (findBlocks over loaded chunks) ----
            const found = bot.findBlocks({
                matching: (b) => b &&
                    (TREE_LOGS.includes(b.name) || ORES.includes(b.name) ||
                        b.name.includes('water') || b.name.includes('lava') ||
                        WORKSTATIONS.includes(b.name)),
                maxDistance: radius,
                count: 400,
            });
            for (const p of found) {
                const b = bot.blockAt(p);
                if (!b) continue;
                const dx = p.x - pos.x, dz = p.z - pos.z;
                const dist = Math.sqrt(dx * dx + dz * dz);
                const dir = this._dirOf(dx, dz);
                if (TREE_LOGS.includes(b.name)) {
                    let g = out.trees.find(g => g.dir === dir);
                    if (!g) { g = { dir, dist: Math.round(dist), count: 0 }; out.trees.push(g); }
                    g.count++;
                    if (dist < g.dist) g.dist = Math.round(dist);
                } else if (ORES.includes(b.name)) {
                    out.ores.push({ name: b.name.replace('deepslate_', ''), dir, dist: Math.round(dist) });
                } else if (b.name.includes('water')) {
                    if (out.waterDist === null || dist < out.waterDist) {
                        out.waterDir = dir; out.waterDist = Math.round(dist);
                    }
                } else if (b.name.includes('lava')) {
                    if (dist < 12) out.lavaNear = true;
                } else if (WORKSTATIONS.includes(b.name)) {
                    out.workstations.push({ name: b.name, dir, dist: Math.round(dist) });
                }
            }

            // Sort for readability
            out.trees.sort((a, b) => a.count - b.count);
            out.ores = out.ores.slice(0, 5);

            // ---- Entity field ----
            let nearestAnimal = null;
            for (const e of Object.values(bot.entities)) {
                if (!e || e.id === bot.entity.id) continue;
                const d = e.position.distanceTo(pos);
                if (d > radius) continue;
                if (e.type === 'mob') {
                    const n = (e.name || '').toLowerCase();
                    const hostile = ['zombie','skeleton','creeper','spider','enderman','witch','drowned','husk','phantom','pillager'].includes(n);
                    if (hostile) {
                        out.hostileCount++;
                        if (!out.nearestHostile || d < out.nearestHostile.distance) {
                            out.nearestHostile = { type: n, distance: Math.round(d), dir: this._dirOf(e.position.x - pos.x, e.position.z - pos.z) };
                        }
                    } else if (n && !['armor_stand','item_frame','painting'].includes(n)) {
                        if (!nearestAnimal || d < nearestAnimal.distance) {
                            nearestAnimal = { kind: n, distance: Math.round(d), dir: this._dirOf(e.position.x - pos.x, e.position.z - pos.z) };
                        }
                        out.animals.push({ kind: n, distance: Math.round(d), dir: this._dirOf(e.position.x - pos.x, e.position.z - pos.z) });
                    }
                } else if (e.type === 'player' && e.username !== bot.username) {
                    out.playerCount++;
                } else if (e.type === 'object' && e.metadata?.[8] === 1) {
                    // dropped item entity (metadata index varies; fallback below)
                    out.loot.push({ item: e.displayName || 'item', distance: Math.round(d), dir: this._dirOf(e.position.x - pos.x, e.position.z - pos.z) });
                }
            }
            // Dropped items: simpler & reliable — anything whose displayName is an item name
            for (const e of Object.values(bot.entities)) {
                if (!e || e.id === bot.entity.id) continue;
                const d = e.position.distanceTo(pos);
                if (d > 32) continue;
                if ((e.name === 'item' || e.displayName === 'Item') && !out.loot.some(l => l.distance === Math.round(d))) {
                    out.loot.push({ item: 'drop', distance: Math.round(d), dir: this._dirOf(e.position.x - pos.x, e.position.z - pos.z) });
                }
            }
            if (nearestAnimal) out.nearestAnimal = nearestAnimal;
            out.animals = out.animals.slice(0, 6);
            out.loot = out.loot.slice(0, 8);
            out.playerCount = Object.values(bot.players || {}).filter(p => p.entity && p.username !== bot.username).length;
        } catch (e) {
            out.error = e.message;
        }

        this._cache = out;
        this._lastScan = now;
        return out;
    }

    /** Human/brain-readable sentence summary of the scene */
    describe() {
        const s = this.scan();
        if (s.empty) return 'no world data yet';
        const parts = [];
        if (s.trees.length) parts.push(`trees: ${s.trees.map(t => `${t.count} to the ${t.dir} (~${t.dist}m)`).join(', ')}`);
        else parts.push('no trees in sight');
        if (s.nearestAnimal) parts.push(`animal nearby: ${s.nearestAnimal.kind} ~${s.nearestAnimal.distance}m ${s.nearestAnimal.dir}`);
        if (s.hostileCount) parts.push(`⚠ ${s.hostileCount} hostile(s), nearest ${s.nearestHostile.type} ~${s.nearestHostile.distance}m ${s.nearestHostile.dir}`);
        if (s.waterDir) parts.push(`water ~${s.waterDist}m ${s.waterDir}`);
        if (s.lavaNear) parts.push('⚠ lava close');
        if (s.ores.length) parts.push(`ores: ${s.ores.map(o => `${o.name} ~${o.dist}m ${o.dir}`).join(', ')}`);
        if (s.workstations.length) parts.push(`workstation: ${s.workstations[0].name} ~${s.workstations[0].dist}m ${s.workstations[0].dir}`);
        if (s.loot.length) parts.push(`${s.loot.length} dropped item(s) on ground`);
        if (s.playerCount) parts.push(`${s.playerCount} player(s) around`);
        return parts.join(' · ');
    }

    /** Best wander target: walk TOWARD what she needs instead of random */
    bestWanderTarget(need = 'trees') {
        const s = this.scan();
        if (need === 'trees' && s.trees.length) {
            const g = s.trees.sort((a, b) => b.count - a.count)[0];
            const pos = this.bot.entity.position;
            // Walk 60% of the way toward the tree cluster center
            const angles = { 'east': 0, 'south-east': 45, 'south': 90, 'south-west': 135,
                'west': 180, 'north-west': 225, 'north': 270, 'north-east': 315 };
            const ang = angles[g.dir] ?? Math.random() * 360;
            const rad = ang * Math.PI / 180;
            // compass: east=+x, south=+z
            const dx = Math.cos(rad), dz = Math.sin(rad);
            const step = Math.max(20, Math.min(50, g.dist * 0.6));
            return { x: pos.x + dx * step, z: pos.z + dz * step };
        }
        return null; // fall back to random
    }
}

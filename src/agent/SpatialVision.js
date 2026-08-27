// SpatialVision.js — deterministic perception + spatial memory. No models.
// Continuously scans entities & blocks around the bot, remembers where
// resources were seen, tracks failures, and answers "what do you see?".

import fs from 'fs';
import path from 'path';
import { Vec3 } from 'vec3';
import { isWoodBlockName } from '../utils/item_families.js';

export class SpatialVision {
    constructor(bot, { scanRange = 48, persist = true, username = null } = {}) {
        this.bot = bot;
        this.scanRange = scanRange;
        this.persist = persist;
        this.username = username || bot?.username || 'bot';
        this.memory = new Map();      // memKey -> { kind, name, pos, count?, ts }
        this.blacklist = new Map();   // posKey -> { fails, until }
        this.visitedCells = new Map();// "cx,cz" -> last visit ts (32-block grid)
        this.lastScanAt = 0;
        this.scans = 0;
        this.timer = null;
        this._saveTimer = null;
        this._loadPersisted();
    }

    _persistPath() {
        return path.join(process.cwd(), 'bots', this.username, 'spatial_memory.json');
    }

    _loadPersisted() {
        if (!this.persist) return;
        try {
            const p = this._persistPath();
            if (!fs.existsSync(p)) return;
            const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
            // Only restore long-lived knowledge; transient mobs/drops are skipped.
            const LONG_LIVED = new Set(['tree', 'ore', 'chest', 'water']);
            let restored = 0;
            const cutoff = Date.now() - 3600000 * 12; // 12h relevance
            for (const m of raw.memory || []) {
                if (!m || !m.kind || !m.pos) continue;
                if (!LONG_LIVED.has(m.kind)) continue;
                if ((m.ts || 0) < cutoff) continue;
                this.memory.set(m.key || `${m.kind}:b:${m.pos.x | 0},${m.pos.y | 0},${m.pos.z | 0}`, { ...m, pos: new Vec3(m.pos.x, m.pos.y, m.pos.z) });
                restored++;
            }
            for (const [cell, ts] of Object.entries(raw.visitedCells || {})) {
                this.visitedCells.set(cell, ts);
            }
            // Restore failure blacklists — otherwise every restart forgets
            // which spots are ghosts/unreachable and re-chases them.
            for (const [k, b] of Object.entries(raw.blacklist || {})) {
                if (b && (b.until || 0) > Date.now()) this.blacklist.set(k, b);
            }
            if (restored > 0) console.log(`[Vision] Restored ${restored} remembered locations + ${Object.keys(raw.visitedCells || {}).length} visited cells`);
        } catch (e) {
            console.log(`[Vision] Memory restore skipped: ${e.message}`);
        }
    }

    saveNow() {
        if (!this.persist) return;
        try {
            const dir = path.dirname(this._persistPath());
            fs.mkdirSync(dir, { recursive: true });
            // Persist only long-lived kinds with position data
            const KEEP = new Set(['tree', 'ore', 'chest', 'water']);
            const memory = [];
            for (const [key, m] of this.memory) {
                if (!KEEP.has(m.kind)) continue;
                memory.push({ key, kind: m.kind, name: m.name, pos: { x: Math.round(m.pos.x), y: Math.round(m.pos.y), z: Math.round(m.pos.z) }, ts: m.ts });
            }
            const visitedCells = {};
            for (const [cell, ts] of this.visitedCells) visitedCells[cell] = ts;
            const blacklist = {};
            for (const [k, b] of this.blacklist) {
                if ((b?.until || 0) > Date.now()) blacklist[k] = b;
            }
            fs.writeFileSync(this._persistPath(), JSON.stringify({ savedAt: Date.now(), memory, visitedCells, blacklist }));
        } catch {}
    }

    start(intervalMs = 3000) {
        this.stop();
        this.timer = setInterval(() => this.scan(), intervalMs);
        this.timer.unref?.();
        // Block scans are the expensive part (volume search) — run them on a
        // slower cadence so the 3s entity scan stays cheap on low-end CPUs.
        this._blockTimer = setInterval(() => { this._doBlocks = true; }, intervalMs * 4);
        this._blockTimer.unref?.();
        this._saveTimer = setInterval(() => this.saveNow(), 60000);
        this._saveTimer.unref?.();
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        if (this._blockTimer) clearInterval(this._blockTimer);
        if (this._saveTimer) clearInterval(this._saveTimer);
        this.timer = this._blockTimer = this._saveTimer = null;
    }

    static posKey(p) { return `${p.x | 0},${p.y | 0},${p.z | 0}`; }

    static cellOf(p) { return `${Math.floor(p.x / 32)},${Math.floor(p.z / 32)}`; }

    noteVisit() {
        const p = this.bot.entity?.position;
        if (!p) return;
        this.visitedCells.set(SpatialVision.cellOf(p), Date.now());
    }

    _blacklisted(pos) {
        const b = this.blacklist.get(SpatialVision.posKey(pos));
        return b && Date.now() < b.until;
    }

    markFailed(pos, kind) {
        const k = SpatialVision.posKey(pos);
        const b = this.blacklist.get(k) || { fails: 0, until: 0 };
        b.fails++;
        // Graduated strikes: first failure = short cooldown, repeat offender
        // = long cooldown. A spot that yielded nothing must not be re-suggested
        // while cooling down, or the bot death-spirals chasing it.
        b.until = Date.now() + (b.fails >= 2 ? 300000 : 90000);
        this.blacklist.set(k, b);
        // Drop matching memories IMMEDIATELY (scan() would otherwise
        // resurrect them seconds later if the block still physically exists).
        for (const [mk, m] of this.memory) {
            if (SpatialVision.posKey(m.pos) === k && (!kind || m.kind === kind)) this.memory.delete(mk);
        }
    }

    // Purge every memory within `radius` blocks of pos — used when an area
    // proves barren/protected so sibling memories of the same dead tree
    // can't resurrect the chase one block at a time.
    markFailedNear(pos, kind, radius = 3) {
        const k = SpatialVision.posKey(pos);
        for (const [mk, m] of this.memory) {
            if (kind && m.kind !== kind) continue;
            if (Math.hypot(m.pos.x - pos.x, m.pos.y - pos.y, m.pos.z - pos.z) <= radius) {
                this.memory.delete(mk);
            }
        }
        void k;
    }

    markSuccess(pos) {
        this.blacklist.delete(SpatialVision.posKey(pos));
    }

    // Post-arrival truth check: does a remembered spot STILL hold its
    // resource? Chunks are only loaded near the bot, so this is only
    // meaningful AFTER navigating there. Returns { name, x, y, z } of the
    // actual block seen (real species/variant!), or null if nothing of
    // that kind is here — a ghost memory (mined/chopped).
    validateArrival(dest, kind) {
        const bot = this.bot;
        try {
            let pred = null;
            // Any wood counts as tree material — canonical predicate from
            // utils/item_families.js (all logs/woods/stems/hyphae/bamboo).
            const isWood = isWoodBlockName;
            if (kind === 'tree') pred = (b) => isWood(b?.name);
            else if (kind === 'ore') pred = (b) => /(^|deepslate_)(iron|coal|gold|diamond|copper|redstone|lapis|emerald)_ore$/.test(b?.name || '');
            else if (kind === 'chest') pred = (b) => b?.name === 'chest' || b?.name === 'barrel';
            else if (kind === 'water') pred = (b) => b?.name === 'water';
            if (!pred) return null;
            const found = bot.findBlocks({ matching: pred, maxDistance: 8, count: 1 }) || [];
            if (!found.length) return null;
            const blk = bot.blockAt(found[0]);
            if (!blk?.name) return null;
            return { name: blk.name, x: found[0].x, y: found[0].y, z: found[0].z };
        } catch {}
        return null;
    }

    scan(force = false) {
        const bot = this.bot;
        if (!bot?.entity) return;
        const now = Date.now();
        if (!force && now - this.lastScanAt < 2000) return;
        this.lastScanAt = now;
        this.scans++;

        // ── prune stale memories (>6 min) ──
        for (const [k, m] of this.memory) {
            if (now - m.ts > 360000) this.memory.delete(k);
        }

        // ── entities: animals, hostile mobs, item drops ──
        try {
            for (const e of Object.values(bot.entities)) {
                if (!e || !e.position || !e.isValid) continue;
                const d = e.position.distanceTo(bot.entity.position);
                if (d > this.scanRange) continue;

                const isDrop = (e.type === 'object' && (e.displayName === 'Item' || e.name === 'item')) || e.entityType === 'item';
                if (isDrop) {
                    let itemName = 'item';
                    try {
                        const md = e.metadata || [];
                        for (const m of md) {
                            if (m && typeof m === 'object' && m.itemId !== undefined) { itemName = 'item'; break; }
                        }
                    } catch {}
                    this.memory.set(`drop:${e.id}`, { kind: 'drop', name: itemName, pos: e.position.clone(), entityId: e.id, ts: now });
                    continue;
                }
                if (e.type === 'mob' && e.name) {
                    const hostile = ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'drowned', 'husk', 'stray', 'phantom', 'pillager', 'vindicator'].includes(e.name);
                    this.memory.set(`mob:${e.id}`, {
                        kind: hostile ? 'hostile' : 'animal',
                        name: e.name,
                        pos: e.position.clone(),
                        entityId: e.id,
                        ts: now,
                    });
                }
            }
        } catch {}

        // ── blocks: trees, water, ores, chests (only when the slow cadence fires) ──
        if (!force && !this._doBlocks) return;
        this._doBlocks = false;
        try {
            const wantLogs = (b) => b && b.name && (b.name.endsWith('_log') || b.name.endsWith('_stem') || b.name === 'bamboo_block');
            const wantWater = (b) => b?.name === 'water';
            const wantOres = (b) => b && /^(iron|coal|gold|diamond|copper|redstone|lapis)_ore$/.test(b.name);
            const wantChest = (b) => b && (b.name === 'chest' || b.name === 'barrel');
            const groups = [
                ['tree', wantLogs],
                ['water', wantWater],
                ['ore', wantOres],
                ['chest', wantChest],
            ];
            for (const [kind, pred] of groups) {
                // NOTE: findBlocks returns Vec3 POSITIONS, not Block objects.
                // (Reading .position off them threw silently — that's why the
                // bot walked past forests "blind" even though scans ran.)
                const found = bot.findBlocks({ matching: pred, maxDistance: this.scanRange, count: 120 }) || [];
                for (const pos of found) {
                    const k = `${kind}:b:${SpatialVision.posKey(pos)}`;
                    // Resolve the concrete block name so planners know WHICH
                    // species of tree / which ore this memory points at.
                    let name = kind;
                    try {
                        const blk = bot.blockAt(pos);
                        if (blk?.name) name = kind === 'tree' ? `${blk.name.replace('_wood', '_log')}` : blk.name;
                    } catch {}
                    const prev = this.memory.get(k);
                    // Keep the freshest ts but never downgrade a specific name to generic
                    const keepName = (prev && prev.name && prev.name !== kind && name === kind) ? prev.name : name;
                    this.memory.set(k, { kind, name: keepName, pos: typeof pos.clone === 'function' ? pos.clone() : pos, ts: now });
                }
            }
        } catch {}

        this.noteVisit();
    }

    // Best remembered target of a kind, closest first, skipping blacklisted.
    nearest(kind, maxAgeMs = 300000) {
        const p = this.bot.entity?.position;
        if (!p) return null;
        let best = null, bestD = Infinity;
        const now = Date.now();
        for (const m of this.memory.values()) {
            if (m.kind !== kind) continue;
            if (now - m.ts > maxAgeMs) continue;
            if (this._blacklisted(m.pos)) continue;
            const d = m.pos.distanceTo(p);
            if (d < bestD) { bestD = d; best = m; }
        }
        return best ? { ...best, dist: Math.round(bestD) } : null;
    }

    counts() {
        const c = {};
        for (const m of this.memory.values()) c[m.kind] = (c[m.kind] || 0) + 1;
        return c;
    }

    // Human/deterministic-chat summary of current perception.
    describe() {
        this.scan(true);
        const p = this.bot.entity?.position;
        const c = this.counts();
        if (!p) return 'I cannot see anything right now.';
        const parts = [];
        const near = (kind) => this.nearest(kind);
        const t = near('tree');  if (t) parts.push(`${c.tree} tree${c.tree > 1 ? 's' : ''} (nearest ${t.dist}m${t.name ? `, ${t.name.replace(/_/g, ' ')}` : ''})`);
        const a = near('animal');if (a) parts.push(`${c.animal} animal${c.animal > 1 ? 's' : ''} (nearest ${a.dist}m: ${a.name})`);
        const h = c.hostile;     if (h) parts.push(`⚠️ ${h} hostile${h > 1 ? 's' : ''}`);
        const d = c.drop;        if (d) parts.push(`${d} item drop${d > 1 ? 's' : ''}`);
        const o = near('ore');   if (o) parts.push(`ores visible (${o.name.replace(/_/g,' ')} ${o.dist}m)`);
        const ch = near('chest');if (ch) parts.push(`a chest ${ch.dist}m away`);
        const w = near('water'); if (w) parts.push(`water ${w.dist}m`);
        if (!parts.length) return `Nothing notable within ${this.scanRange}m of (${p.x | 0}, ${p.y | 0}, ${p.z | 0}).`;
        return `I see ${parts.join(', ')}.`;
    }

    // Pick an exploration target biased toward unvisited cells AND away
    // from water/terrain dead-ends. Old version picked blind compass points
    // and the bot repeatedly waded into lakes.
    explorationTarget(minDist = 40, maxDist = 90) {
        const p = this.bot.entity.position;
        let best = null, bestScore = -Infinity;
        for (let i = 0; i < 14; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = minDist + Math.random() * (maxDist - minDist);
            const tx = Math.round(p.x + Math.cos(angle) * dist);
            const tz = Math.round(p.z + Math.sin(angle) * dist);
            const cell = `${Math.floor(tx / 32)},${Math.floor(tz / 32)}`;
            const last = this.visitedCells.get(cell) || 0;
            // prefer never-visited, then least-recently-visited; slight tiebreak on distance
            let score = -last + (100000 - dist) * 0.001;
            // Terrain veto: if the destination column is loaded, reject water
            // targets outright and penalize steep cliffs (unreachable Y).
            try {
                const surface = this.bot.blockAt({ x: tx, y: Math.min(Math.max(Math.floor(p.y), 1), 250), z: tz });
                if (surface) {
                    if (surface.name === 'water' || surface.name === 'lava') score -= 5000;
                    else {
                        // Find the real top solid block near target height
                        let dy = 0, top = null;
                        for (dy = 6; dy >= -8; dy--) {
                            const b = this.bot.blockAt({ x: tx, y: Math.min(254, Math.max(1, Math.floor(p.y) + dy)), z: tz });
                            if (b && b.boundingBox === 'block') { top = b; break; }
                        }
                        if (!top && dy < -7) score -= 2000; // likely a hole/cave drop
                        else if (top) {
                            const climb = Math.abs(top.position.y - p.y);
                            if (climb > 12) score -= 1500;   // cliff walls are a time sink
                            else if (top.name.includes('water')) score -= 3000;
                        }
                    }
                }
                // Unknown/unloaded chunk → mild unknown penalty so loaded land wins ties
                else score -= 50;
            } catch (_) {}
            if (score > bestScore) { bestScore = score; best = { tx, tz, fresh: !last }; }
        }
        return best || { tx: Math.round(p.x + minDist), tz: Math.round(p.z), fresh: false };
    }
}

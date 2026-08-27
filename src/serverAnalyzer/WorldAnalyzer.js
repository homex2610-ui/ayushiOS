import Vec3 from 'vec3';

const INTERESTING_BLOCKS = {
    'spawner': { type: 'spawner', priority: 9 },
    'ender_chest': { type: 'storage', priority: 7 },
    'chest': { type: 'storage', priority: 6 },
    'barrel': { type: 'storage', priority: 6 },
    'shulker_box': { type: 'storage', priority: 8 },
    'furnace': { type: 'utility', priority: 5 },
    'blast_furnace': { type: 'utility', priority: 5 },
    'smoker': { type: 'utility', priority: 5 },
    'anvil': { type: 'utility', priority: 6 },
    'enchanting_table': { type: 'utility', priority: 7 },
    'brewing_stand': { type: 'utility', priority: 6 },
    'beacon': { type: 'utility', priority: 8 },
    'nether_portal': { type: 'portal', priority: 9 },
    'end_portal_frame': { type: 'portal', priority: 10 },
    'crafting_table': { type: 'utility', priority: 4 },
    'bed': { type: 'rest', priority: 5 },
    'respawn_anchor': { type: 'utility', priority: 7 },
    'lodestone': { type: 'navigation', priority: 6 },
};

function v(p) {
    if (!p || typeof p.floored === 'function') return p;
    return new Vec3(p.x, p.y, p.z);
}

export class WorldAnalyzer {
    constructor(knowledgeBase, logger) {
        this.kb = knowledgeBase;
        this.log = logger || ((...a) => {});
        this._visited = new Set();
        this._exploreRadius = 32;
        this._scanCooldown = 30000;
        this._lastScan = 0;
    }

    scan(bot) {
        if (!bot?.entity) return;
        const now = Date.now();
        if (now - this._lastScan < this._scanCooldown) return;
        this._lastScan = now;

        const pos = v(bot.entity.position);
        if (!pos) return;
        const chunkKey = `${Math.floor(pos.x / 16)},${Math.floor(pos.z / 16)}`;
        if (this._visited.has(chunkKey)) return;
        this._visited.add(chunkKey);

        this._scanSurroundings(bot, pos);
        this._recordLocation(bot, pos);
    }

    _scanSurroundings(bot, pos) {
        const r = this._exploreRadius;
        for (let x = -r; x <= r; x += 4) {
            for (let z = -r; z <= r; z += 4) {
                for (let y = Math.max(0, pos.y - 10); y <= Math.min(320, pos.y + 10); y += 3) {
                    const block = bot.blockAt(v({ x: pos.x + x, y, z: pos.z + z }));
                    if (!block) continue;
                    const info = INTERESTING_BLOCKS[block.name];
                    if (info) {
                        const loc = {
                            type: info.type,
                            block: block.name,
                            position: { x: block.position.x, y: block.position.y, z: block.position.z },
                            priority: info.priority,
                            discovered: Date.now(),
                            dimension: bot.game.dimension || 'overworld',
                        };
                        this.kb.push('locations', loc);
                    }
                }
            }
        }
    }

    _recordLocation(bot, pos) {
        const biome = bot.blockAt(v(pos))?.biome?.name || 'unknown';
        const dimension = bot.game.dimension || 'overworld';
        const key = `${dimension}_${Math.floor(pos.x / 100)},${Math.floor(pos.z / 100)}`;
        const locations = this.kb.data.locations || [];
        const existing = locations.find(l => l.key === key);
        if (!existing) {
            const entry = {
                key,
                dimension,
                biome,
                center: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
                firstVisit: Date.now(),
                lastVisit: Date.now(),
                visitCount: 1,
                features: [],
            };
            locations.push(entry);
        } else {
            existing.lastVisit = Date.now();
            existing.visitCount++;
        }
        this.kb.save();
    }

    noteStructure(type, position) {
        this.kb.push('locations', {
            type: 'structure',
            structureType: type,
            position: { x: position.x, y: position.y, z: position.z },
            priority: 8,
            discovered: Date.now(),
            dimension: 'overworld',
        });
    }

    setSpawn(pos) {
        this.kb.set('server.spawn', { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) });
    }

    setHome(name, pos) {
        const homes = this.kb.get('homes') || {};
        homes[name] = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), set: Date.now() };
        this.kb.set('homes', homes);
    }
}

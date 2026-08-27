function v(p) {
    if (!p || typeof p.floored === 'function') return p;
    return new Vec3(p.x, p.y, p.z);
}

import Vec3 from 'vec3';

export class DangerAnalyzer {
    constructor(knowledgeBase, logger) {
        this.kb = knowledgeBase;
        this.log = logger || ((...a) => {});
        this._pendingDangers = [];
    }

    observe(bot) {
        if (!bot?.entity) return;
        const pos = v(bot.entity.position);
        if (!pos) return;
        this._checkEnvironment(bot, pos);
        this._checkEntities(bot, pos);
        this._flushDangers();
    }

    _checkEnvironment(bot, pos) {
        const r = 5;
        for (let x = -r; x <= r; x++) {
            for (let z = -r; z <= r; z++) {
                for (let y = -3; y <= 3; y++) {
                    const block = bot.blockAt(v({ x: pos.x + x, y: pos.y + y, z: pos.z + z }));
                    if (!block) continue;
                    if (block.name === 'lava' || block.name === 'flowing_lava') {
                        this._reportDanger('lava', { x: block.position.x, y: block.position.y, z: block.position.z }, 'high');
                    }
                    if (block.name === 'cactus') {
                        this._reportDanger('cactus', { x: block.position.x, y: block.position.y, z: block.position.z }, 'medium');
                    }
                    if (block.name === 'fire') {
                        this._reportDanger('fire', { x: block.position.x, y: block.position.y, z: block.position.z }, 'medium');
                    }
                    if (block.name === 'sweet_berry_bush') {
                        this._reportDanger('berry_bush', { x: block.position.x, y: block.position.y, z: block.position.z }, 'low');
                    }
                }
            }
        }
        const below = bot.blockAt(v({ x: pos.x, y: pos.y - 2, z: pos.z }));
        if (below && below.name === 'air' && bot.entity.velocity.y < -0.5) {
            this._reportDanger('fall', { x: Math.round(pos.x), y: Math.round(pos.y - 2), z: Math.round(pos.z) }, 'medium');
        }
    }

    _checkEntities(bot, pos) {
        const hostileTypes = ['creeper', 'zombie', 'skeleton', 'spider', 'enderman', 'witch', 'phantom', 'warden', 'blaze', 'ghast', 'hoglin', 'piglin_brute', 'evoker', 'vindicator', 'ravager', 'vex'];
        const nearby = Object.values(bot.entities || {}).filter(e => {
            if (!e?.position) return false;
            const dist = pos.distanceTo(e.position);
            return dist < 16 && hostileTypes.includes(e.name);
        });
        for (const entity of nearby) {
            if (entity.name === 'creeper' && pos.distanceTo(entity.position) < 5) {
                this._reportDanger('creeper', entity.position, 'high');
            }
            if (entity.name === 'warden') {
                this._reportDanger('warden', entity.position, 'critical');
            }
            if (entity.name === 'skeleton' || entity.name === 'blaze') {
                this._reportDanger('ranged_mob', entity.position, 'medium');
            }
        }
    }

    _reportDanger(type, position, severity) {
        // Buffered: collected during the observation pass, persisted in one batch.
        this._pendingDangers.push({ type, position, severity, ts: Date.now() });
    }

    _flushDangers() {
        if (this._pendingDangers.length === 0) return;
        if (!Array.isArray(this.kb.data.dangers)) this.kb.data.dangers = [];
        const dangers = this.kb.data.dangers;
        for (const rep of this._pendingDangers) {
            const key = `${rep.type}_${Math.round(rep.position.x)}_${Math.round(rep.position.y)}_${Math.round(rep.position.z)}`;
            // Stable position key defeats per-tick duplicate entries.
            if (dangers.find(d => d.key === key)) continue;
            dangers.push({
                key,
                type: rep.type,
                severity: rep.severity,
                position: { x: Math.round(rep.position.x), y: Math.round(rep.position.y), z: Math.round(rep.position.z) },
                firstSeen: rep.ts,
                lastSeen: rep.ts,
                count: 1,
            });
        }
        this._pendingDangers = [];
        this.kb.save(); // single save after the whole pass
    }

    markUnsafeArea(startPos, endPos, reason) {
        this.kb.push('dangers', {
            key: `unsafe_${Date.now()}`,
            type: 'unsafe_area',
            severity: 'medium',
            area: {
                start: { x: Math.round(startPos.x), y: Math.round(startPos.y), z: Math.round(startPos.z) },
                end: { x: Math.round(endPos.x), y: Math.round(endPos.y), z: Math.round(endPos.z) },
            },
            reason,
            firstSeen: Date.now(),
        });
    }

    getActiveDangers(botPos, maxDistance = 32) {
        return (this.kb.data.dangers || []).filter(d => {
            if (!d.position || !botPos) return false;
            const dist = Math.sqrt(
                (d.position.x - botPos.x) ** 2 +
                (d.position.z - botPos.z) ** 2
            );
            return dist < maxDistance && d.severity !== 'resolved';
        });
    }
}

export class LearningEngine {
    constructor(knowledgeBase, logger) {
        this.kb = knowledgeBase;
        this.log = logger || ((...a) => {});
        this._mergeCount = 0;
    }

    tick() {
        this._deduplicateLocations();
        this._deduplicateDangers();
        this._mergePlayerData();
        this._expireOldData();
        this._pruneLowConfidence();
        this._mergeCount++;
        if (this._mergeCount % 5 === 0) this.kb.save();
    }

    _deduplicateLocations() {
        const locs = this.kb.data.locations || [];
        const map = new Map();
        for (const loc of locs) {
            const pos = loc.position;
            const key = `${loc.type}_${Math.round(pos?.x || 0)}_${Math.round(pos?.y || 0)}_${Math.round(pos?.z || 0)}`;
            if (map.has(key)) {
                const existing = map.get(key);
                existing.lastSeen = Math.max(existing.lastSeen, loc.lastSeen || loc.discovered || 0);
                existing.visitCount = (existing.visitCount || 1) + 1;
                if (loc.priority > existing.priority) existing.priority = loc.priority;
            } else {
                map.set(key, { ...loc });
            }
        }
        this.kb.data.locations = [...map.values()].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    }

    _deduplicateDangers() {
        const dangers = this.kb.data.dangers || [];
        const map = new Map();
        for (const d of dangers) {
            if (map.has(d.key)) {
                const existing = map.get(d.key);
                existing.count = (existing.count || 1) + 1;
                existing.lastSeen = Math.max(existing.lastSeen, d.lastSeen);
            } else {
                map.set(d.key, { ...d });
            }
        }
        this.kb.data.dangers = [...map.values()].sort((a, b) => {
            const severityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
            return (severityOrder[b.severity] || 0) - (severityOrder[a.severity] || 0);
        });
    }

    _mergePlayerData() {
        const players = this.kb.data.players || {};
        for (const [name, data] of Object.entries(players)) {
            if (data.encounters > 5 && data.confidence === undefined) {
                data.confidence = Math.min(1, data.encounters / 10);
            }
        }
    }

    _expireOldData() {
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const dangers = this.kb.data.dangers || [];
        this.kb.data.dangers = dangers.filter(d => (d.lastSeen || d.firstSeen) > weekAgo);
    }

    _pruneLowConfidence() {
        const commands = this.kb.data.commands || {};
        for (const [cmd, data] of Object.entries(commands)) {
            if (data.confidence < 0.15 && data.testing) {
                delete commands[cmd];
            }
        }
        const plugins = this.kb.data.plugins || {};
        for (const [name, data] of Object.entries(plugins)) {
            if (data.confidence < 0.15) {
                delete plugins[name];
            }
        }
    }

    learnFromMessage(message) {
        if (message.includes('bought') || message.includes('sold') || message.includes('purchased')) {
            this.kb.set('economy.enabled', true);
        }
        if (/died|killed|death/i.test(message)) {
            this.kb.set('server.pvp', true);
        }
    }
}

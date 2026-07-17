export class SummaryEngine {
    constructor(knowledgeBase, logger) {
        this.kb = knowledgeBase;
        this.log = logger || ((...a) => {});
    }

    generate() {
        const data = this.kb.data;
        return {
            server: this._summarizeServer(data),
            plugins: this._summarizePlugins(data),
            economy: this._summarizeEconomy(data),
            commands: this._summarizeCommands(data),
            locations: this._summarizeLocations(data),
            dangers: this._summarizeDangers(data),
            players: this._summarizePlayers(data),
            rules: this._summarizeRules(data),
            progression: this._summarizeProgression(data),
            stats: data.stats || {},
        };
    }

    generateShort() {
        const full = this.generate();
        return {
            server: full.server,
            plugins: full.plugins,
            economy: full.economy,
            commands: full.commands.slice(0, 10),
            locations: full.locations.slice(0, 5),
            dangers: full.dangers.slice(0, 3),
            players: full.players.slice(0, 5),
            rules: full.rules.slice(0, 5),
        };
    }

    _summarizeServer(data) {
        const s = data.server || {};
        return {
            name: s.name || 'Unknown',
            claimSystem: s.claimSystem || 'Unknown',
            pvp: !!s.pvp,
            owner: s.owner || null,
            spawn: s.spawn || null,
        };
    }

    _summarizePlugins(data) {
        return Object.entries(data.plugins || {})
            .filter(([, p]) => p.confidence >= 0.3)
            .sort(([, a], [, b]) => b.confidence - a.confidence)
            .map(([name, p]) => ({ name, confidence: p.confidence }));
    }

    _summarizeEconomy(data) {
        const eco = data.economy || {};
        return {
            enabled: !!eco.enabled,
            currency: eco.currency || 'unknown',
            symbols: eco.symbols || [],
        };
    }

    _summarizeCommands(data) {
        return Object.values(data.commands || {})
            .filter(c => c.confidence >= 0.3 && c.available !== false)
            .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
            .slice(0, 30)
            .map(c => ({ command: c.command, type: c.type || 'unknown', confidence: c.confidence }));
    }

    _summarizeLocations(data) {
        return (data.locations || [])
            .filter(l => (l.priority || 0) >= 5)
            .sort((a, b) => (b.priority || 0) - (a.priority || 0))
            .slice(0, 20)
            .map(l => ({
                type: l.type || l.structureType || 'point',
                block: l.block || null,
                position: l.position,
                dimension: l.dimension || 'overworld',
            }));
    }

    _summarizeDangers(data) {
        return (data.dangers || [])
            .filter(d => d.severity !== 'resolved')
            .sort((a, b) => {
                const order = { critical: 4, high: 3, medium: 2, low: 1 };
                return (order[b.severity] || 0) - (order[a.severity] || 0);
            })
            .slice(0, 10)
            .map(d => ({ type: d.type, severity: d.severity, position: d.position }));
    }

    _summarizePlayers(data) {
        return Object.entries(data.players || {})
            .sort(([, a], [, b]) => (b.encounters || 0) - (a.encounters || 0))
            .slice(0, 20)
            .map(([name, p]) => ({
                name,
                friendly: !!p.friendly,
                hostile: !!p.hostile,
                owner: !!p.owner,
                encounters: p.encounters || 0,
                lastPosition: p.lastPosition,
            }));
    }

    _summarizeRules(data) {
        return (data.rules || [])
            .filter(r => r.confidence >= 0.5)
            .map(r => r.description);
    }

    _summarizeProgression(data) {
        const scoreboard = data.scoreboard || {};
        const stats = {};
        const s = data.server || {};
        if (s.onlineCount) stats.onlineCount = s.onlineCount;
        if (s.rank) stats.rank = s.rank;
        if (data.playerLevel) stats.level = data.playerLevel;
        if (data.economy?.lastBalance) stats.balance = data.economy.lastBalance;
        return stats;
    }
}

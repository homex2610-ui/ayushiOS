export class PlayerAnalyzer {
    constructor(knowledgeBase, logger) {
        this.kb = knowledgeBase;
        this.log = logger || ((...a) => {});
        this._observations = {};
        this._cooldown = 5000;
    }

    observe(bot) {
        if (!bot?.players) return;
        const now = Date.now();
        for (const [name, player] of Object.entries(bot.players)) {
            if (name === bot.username) continue;
            if ((this._observations[name]?.lastSeen || 0) > now - this._cooldown) continue;
            this._observations[name] = { lastSeen: now, count: (this._observations[name]?.count || 0) + 1 };

            const entry = this.kb.get('players.' + name) || { name, firstSeen: now, encounters: 0, lastPosition: null, gear: [], behaviors: [] };
            entry.lastSeen = now;
            entry.encounters = (entry.encounters || 0) + 1;

            if (player.entity) {
                const pos = player.entity.position;
                if (pos) {
                    entry.lastPosition = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
                }
                if (player.entity.metadata) {
                    try {
                        const items = player.entity.metadata?.[6]?.itemEnchantments || player.entity.metadata?.[5]?.itemEnchantments || [];
                        if (items.length > 0) entry.hasArmor = true;
                    } catch (_) {}
                }
            }

            if (player.gamemode) entry.gamemode = player.gamemode;
            if (player.ping !== undefined) entry.lastPing = player.ping;

            this.kb.set('players.' + name, entry);
            this.kb.data.stats.playersObserved = Object.keys(this._observations).length;
        }
        this.kb.save();
    }

    markHostile(playerName, reason) {
        const entry = this.kb.get('players.' + playerName) || { name: playerName, firstSeen: Date.now(), encounters: 0 };
        entry.hostile = true;
        entry.hostileReason = reason;
        entry.hostileSince = Date.now();
        this.kb.set('players.' + playerName, entry);
        this.kb.push('dangers', { type: 'hostile_player', player: playerName, reason, ts: Date.now() });
    }

    markFriendly(playerName, reason) {
        const entry = this.kb.get('players.' + playerName) || { name: playerName, firstSeen: Date.now(), encounters: 0 };
        entry.friendly = true;
        entry.friendlyReason = reason;
        this.kb.set('players.' + playerName, entry);
    }

    setOwner(playerName) {
        const entry = this.kb.get('players.' + playerName) || { name: playerName, firstSeen: Date.now(), encounters: 0 };
        entry.owner = true;
        entry.friendly = true;
        this.kb.set('players.' + playerName, entry);
        this.kb.set('server.owner', playerName);
    }
}

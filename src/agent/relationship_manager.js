const POSITIVE_WORDS = ['thanks', 'good', 'great', 'nice', 'love', 'awesome', 'cool', 'yes', 'perfect', 'amazing', 'help', 'friend'];
const NEGATIVE_WORDS = ['stop', 'bad', 'no', 'stupid', 'hate', 'ugly', 'terrible', 'wrong', 'dumb', 'shut'];

export class RelationshipManager {
    constructor(agent) {
        this.agent = agent;
        this.relationships = {};
    }

    _get(player) {
        if (!this.relationships[player]) {
            this.relationships[player] = {
                lastSeen: 0,
                totalInteractions: 0,
                sentiment: 0.5,
                trust: 0.3,
                traded: 0,
                attacked: 0,
                helped: 0,
                notes: '',
            };
        }
        return this.relationships[player];
    }

    recordMessage(player, message) {
        const rel = this._get(player);
        rel.lastSeen = Date.now();
        rel.totalInteractions++;
        const lower = message.toLowerCase();
        let delta = 0;
        for (const w of POSITIVE_WORDS) {
            if (lower.includes(w)) delta += 0.03;
        }
        for (const w of NEGATIVE_WORDS) {
            if (lower.includes(w)) delta -= 0.04;
        }
        rel.sentiment = Math.max(0, Math.min(1, rel.sentiment + delta));
        if (delta > 0) rel.trust = Math.min(1, rel.trust + 0.02);
        this._save();
    }

    recordEvent(player, event) {
        const rel = this._get(player);
        rel.lastSeen = Date.now();
        switch (event) {
            case 'attack':
                rel.attacked++;
                rel.sentiment = Math.max(0, rel.sentiment - 0.15);
                rel.trust = Math.max(0, rel.trust - 0.1);
                if (this.agent.memory_bank) {
                    this.agent.memory_bank.addMemory(`${player} attacked me`, { type: 'interaction', importance: 0.85 });
                }
                break;
            case 'trade':
                rel.traded++;
                rel.sentiment = Math.min(1, rel.sentiment + 0.08);
                rel.trust = Math.min(1, rel.trust + 0.05);
                break;
            case 'help':
                rel.helped++;
                rel.sentiment = Math.min(1, rel.sentiment + 0.1);
                rel.trust = Math.min(1, rel.trust + 0.08);
                if (this.agent.memory_bank) {
                    this.agent.memory_bank.addMemory(`${player} helped me`, { type: 'interaction', importance: 0.8 });
                }
                break;
            case 'death':
                if (rel.sentiment > 0.5) {
                    rel.sentiment = Math.max(0, rel.sentiment - 0.1);
                }
                break;
        }
        this._save();
    }

    getSummary(maxPlayers = 3) {
        const sorted = Object.entries(this.relationships)
            .sort((a, b) => (b[1].totalInteractions + b[1].trust * 10) - (a[1].totalInteractions + a[1].trust * 10));
        return sorted.slice(0, maxPlayers).map(([name, rel]) => {
            const feeling = rel.sentiment > 0.7 ? 'friendly' : rel.sentiment > 0.4 ? 'neutral' : 'unfriendly';
            return `${name} (${feeling}, trust:${(rel.trust * 100).toFixed(0)}%, ${rel.totalInteractions} chats)`;
        }).join('\n');
    }

    getPlayer(player) {
        return this.relationships[player] || null;
    }

    load(data) {
        if (data) this.relationships = data;
    }

    toJSON() {
        return this.relationships;
    }

    _save() {
        if (this.agent.memory_bank) {
            this.agent.memory_bank._dirty = true;
        }
    }
}

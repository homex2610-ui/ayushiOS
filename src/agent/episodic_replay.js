export class EpisodicReplay {
    constructor(agent) {
        this.agent = agent;
        this.lastReplay = 0;
        this.interval = 1500000;
    }

    setInterval(ms) {
        this.interval = ms;
    }

    async tick() {
        if (!this.agent.memory_bank || !this.agent.bot?.entity) return;
        const now = Date.now();
        if (now - this.lastReplay < this.interval) return;
        this.lastReplay = now;

        try {
            const recent = this.agent.memory_bank.store.filter(m => {
                return (now - m.created) < this.interval * 2;
            });

            if (recent.length < 3) return;

            const grouped = this._groupByType(recent);
            let consolidated = 0;

            for (const [type, items] of Object.entries(grouped)) {
                if (items.length < 2) continue;
                const best = items.sort((a, b) => b.importance - a.importance)[0];
                const duplicates = items.filter(m => {
                    if (m.id === best.id) return false;
                    const sim = this._similarity(m.content, best.content);
                    return sim > 0.6;
                });
                for (const dup of duplicates) {
                    best.timesUsed += dup.timesUsed;
                    best.confidence = Math.min(1, best.confidence + 0.05);
                    this.agent.memory_bank.removeMemory(dup.id);
                    consolidated++;
                }
            }

            this.agent.memory_bank.prune(true);

            if (consolidated > 0) {
                console.log(`[EpisodicReplay] Consolidated ${consolidated} duplicate memories`);
                this.agent.memory_bank.addMemory(
                    `Consolidated ${consolidated} memories (replay cycle)`,
                    { type: 'episode', importance: 0.3 }
                );
            }
        } catch (err) {
            console.warn('[EpisodicReplay] Error:', err.message);
        }
    }

    _groupByType(items) {
        const groups = {};
        for (const m of items) {
            if (!groups[m.type]) groups[m.type] = [];
            groups[m.type].push(m);
        }
        return groups;
    }

    _similarity(a, b) {
        const wordsA = new Set(a.toLowerCase().split(/\W+/));
        const wordsB = new Set(b.toLowerCase().split(/\W+/));
        let intersect = 0;
        for (const w of wordsA) {
            if (wordsB.has(w)) intersect++;
        }
        const union = new Set([...wordsA, ...wordsB]);
        return union.size > 0 ? intersect / union.size : 0;
    }
}

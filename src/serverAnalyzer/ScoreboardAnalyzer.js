export class ScoreboardAnalyzer {
    constructor(knowledgeBase, logger) {
        this.kb = knowledgeBase;
        this.log = logger || ((...a) => {});
        this._lastSnapshot = '';
        this._changeCount = 0;
    }

    feed(bot) {
        if (!bot?.scoreboard) return;
        try {
            const sb = bot.scoreboard;
            const lines = [];
            if (sb.sidebar) {
                lines.push('=== SIDEBAR ===');
                lines.push(sb.sidebar.title?.text || '');
                for (const item of sb.sidebar.items || []) {
                    lines.push(item.text || '');
                }
            }
            if (sb.belowName) {
                lines.push('=== BELOW NAME ===');
                lines.push(sb.belowName.title?.text || '');
                for (const item of sb.belowName.items || []) {
                    lines.push(item.text || '');
                }
            }
            if (sb.player) {
                lines.push('=== PLAYER LIST ===');
                for (const item of sb.player.items || []) {
                    lines.push(item.text || '');
                }
            }
            const snapshot = lines.join('\n');
            if (snapshot === this._lastSnapshot) return;
            this._lastSnapshot = snapshot;
            this._changeCount++;

            // Reader-shaped view: ServerSemanticLayer reads kb.get('scoreboard')
            // expecting { title, lines }. Write it first, then the scalar keys
            // below merge into the same node (raw/lastUpdate/updateCount preserved).
            this.kb.set('scoreboard', {
                title: sb.sidebar?.title?.text || sb.belowName?.title?.text || '',
                lines,
            });
            this.kb.set('scoreboard.raw', snapshot);
            this.kb.set('scoreboard.lastUpdate', Date.now());
            this.kb.set('scoreboard.updateCount', this._changeCount);

            this._parseLines(lines);
        } catch (_) {}
    }

    _parseLines(lines) {
        const text = lines.join(' ');
        const extractors = [
            { key: 'server.name', re: /(?:server|network|mc)\s*[:•-]?\s*([A-Za-z0-9_\s]+?)(?:\s*\[|$)/i },
            { key: 'server.tps', re: /TPS[:\s]*(\d+\.?\d*)/i },
            { key: 'server.online', re: /Online[:\s]*(\d+)/i },
            { key: 'economy.balance', re: /(?:Balance|Money|Coins|Credits|Tokens?)[:\s]*\$?([\d,]+)/i },
            { key: 'economy.currency', re: /(?:Balance|Money|Coins|Credits|Tokens?)[:\s]*([A-Z$€£¥]+)/i },
            { key: 'playerLevel', re: /Level[:\s]*(\d+)/i },
            { key: 'server.rank', re: /Rank[:\s]*(\[?\w+\]?)/i },
        ];
        for (const ex of extractors) {
            const m = text.match(ex.re);
            if (m) {
                this.kb.set(ex.key, m[1].trim());
            }
        }
        const pluginExtractors = [
            { plugin: 'Jobs', re: /Jobs?[:\s]*Level[:\s]*(\d+)|Job Payment/i },
            { plugin: 'mcMMO', re: /Power Level|mcMMO/i },
            { plugin: 'AureliumSkills', re: /Skills?[:\s]*Level/i },
            { plugin: 'Lands', re: /Land\s+Power/i },
            { plugin: 'Towny', re: /Town|Nation|Resident/i },
            { plugin: 'Factions', re: /Faction/i },
        ];
        for (const ex of pluginExtractors) {
            if (ex.re.test(text)) {
                const entry = this.kb.get('plugins.' + ex.plugin);
                if (entry) entry.confidence = Math.min(1, entry.confidence + 0.15);
                else this.kb.set('plugins.' + ex.plugin, { name: ex.plugin, confidence: 0.4, firstSeen: Date.now(), lastSeen: Date.now() });
            }
        }
    }
}

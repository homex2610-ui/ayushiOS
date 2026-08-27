const RULE_PATTERNS = [
    { re: /no\s*grief(?:ing)?/i, key: 'nogrief', description: 'No griefing' },
    { re: /no\s*steal(?:ing)?/i, key: 'nosteal', description: 'No stealing' },
    { re: /no\s*(?:spam|advertise|advertising)/i, key: 'nospam', description: 'No spam' },
    { re: /no\s*hack(?:ing|s)?/i, key: 'nohack', description: 'No hacking' },
    { re: /no\s*(?:xray|x-ray)/i, key: 'noxray', description: 'No xray' },
    { re: /no\s*(?:dupe|duping|duplication)/i, key: 'nodup', description: 'No duping' },
    { re: /no\s*(?:alt|alternative)\s*account/i, key: 'noalt', description: 'No alt accounts' },
    { re: /no\s*(?:offensive|toxic|harass)/i, key: 'noharass', description: 'No harassment' },
    { re: /respect\s*(?:other|every|all)/i, key: 'respect', description: 'Respect others' },
    { re: /(?:pvp|pvp zone|pvp arena)/i, key: 'pvprules', description: 'PvP rules apply' },
    { re: /(?:claim|land|town)\s*(?:system|protect)/i, key: 'claimsystem', description: 'Claims system in use' },
    { re: /no\s*(?:nsfw|18\+|adult)/i, key: 'nonsfw', description: 'No NSFW' },
    { re: /be\s*(?:respectful|nice|kind|friendly)/i, key: 'berespectful', description: 'Be respectful' },
    { re: /(?:english|language)\s*(?:only|required|please)/i, key: 'english', description: 'English only' },
    { re: /no\s*(?:advert|advertising|promoting)/i, key: 'noads', description: 'No advertising' },
    { re: /(?:don't|do not|never)\s*(?:grief|steal|spam)/i, key: 'norulebreak', description: 'Do not break rules' },
    { re: /(?:minimum|require)\s*age/i, key: 'minage', description: 'Minimum age required' },
    { re: /(?:discord|website)\s*(?:required|needed)/i, key: 'discordrequired', description: 'Discord required' },
];

const CLAIM_PATTERNS = [
    { re: /(?:claim|unclaim|trust|untrust)/i, type: 'griefprevention' },
    { re: /(?:lands|land)\s*(?:claim|create)/i, type: 'lands' },
    { re: /(?:town|towny|nation|resident)/i, type: 'towny' },
    { re: /\bfactions?\b/i, type: 'factions' },
    { re: /(?:res|residence)/i, type: 'residence' },
];

export class RuleAnalyzer {
    constructor(knowledgeBase, logger) {
        this.kb = knowledgeBase;
        this.log = logger || ((...a) => {});
    }

    feed(message) {
        for (const p of RULE_PATTERNS) {
            if (p.re.test(message)) {
                const rules = this.kb.get('rules') || [];
                if (!rules.find(r => r.key === p.key)) {
                    rules.push({ key: p.key, description: p.description, source: 'chat', firstSeen: Date.now(), confidence: 0.6 });
                    this.kb.set('rules', rules);
                } else {
                    const rule = rules.find(r => r.key === p.key);
                    if (rule) rule.confidence = Math.min(1, rule.confidence + 0.1);
                }
                break;
            }
        }
        this._detectClaimType(message);
    }

    _detectClaimType(msg) {
        for (const cp of CLAIM_PATTERNS) {
            if (cp.re.test(msg)) {
                this.kb.merge('server', { claimSystem: cp.type });
                break;
            }
        }
    }

    inferClaimSystem(bot) {
        if (this.kb.get('server.claimSystem')) return;
        const commands = this.kb.data.commands || {};
        const commandList = Object.keys(commands);
        if (commandList.some(c => c.startsWith('/claim') || c.startsWith('/trust') || c.startsWith('/untrust'))) {
            this.kb.set('server.claimSystem', 'griefprevention');
        } else if (commandList.some(c => c.startsWith('/lands') || c.startsWith('/land'))) {
            this.kb.set('server.claimSystem', 'lands');
        } else if (commandList.some(c => c.startsWith('/town') || c.startsWith('/towny'))) {
            this.kb.set('server.claimSystem', 'towny');
        } else if (commandList.some(c => c.startsWith('/f ') || c.startsWith('/factions'))) {
            this.kb.set('server.claimSystem', 'factions');
        } else if (commandList.some(c => c.startsWith('/res') || c.startsWith('/residence'))) {
            this.kb.set('server.claimSystem', 'residence');
        }
    }

    inferPvPState(bot) {
        if (this.kb.get('server.pvp')) return;
        try {
            if (bot?.players) {
                for (const [, p] of Object.entries(bot.players)) {
                    if (p.entity?.metadata) {
                        const hasSword = p.entity.metadata?.[5]?.itemId;
                        if (hasSword) {
                            this.kb.set('server.pvp', true);
                            this.kb.set('server.pvpType', 'arena');
                            return;
                        }
                    }
                }
            }
        } catch (_) {}
    }
}

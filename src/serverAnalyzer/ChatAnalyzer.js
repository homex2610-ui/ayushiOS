const SYSTEM_PATTERNS = [
    { re: /\[(?:SERVER|GLOBAL|BROADCAST)\]\s*(.+)/i, type: 'broadcast' },
    { re: /Welcome\s*(.+?)\s*to\s*(.+)/i, type: 'welcome' },
    { re: /You\s+(?:have\s+)?(?:been\s+)?(?:kicked|banned|muted|warned)/i, type: 'punishment' },
    { re: /(?:Balance|Money|Coins|Credits|Tokens)[:\s]+\$?(\d+[.,]?\d*)/i, type: 'balance' },
    { re: /You\s+(?:received|got|earned)\s+\$?(\d+[.,]?\d*)\s*(?:coins?|money|credits|tokens?)/i, type: 'earnings' },
    { re: /Paid\s+\$?(\d+[.,]?\d*)\s*(?:coins?|money|credits|tokens?)\s+to/i, type: 'payment' },
    { re: /(?:Quest|Mission|Task)\s*(?:completed|done|finished)/i, type: 'quest_complete' },
    { re: /Level[:\s]+up/i, type: 'level_up' },
    { re: /\[(?:VIP|MVP|DONOR|ELITE|LEGEND|TITAN|IMMORTAL)\]/i, type: 'rank' },
    { re: /(?:Crate|Key)\s*(?:opened|reward)/i, type: 'crate' },
    { re: /(?:Auction|AH|AuctionHouse)[:\s]/i, type: 'auction' },
    { re: /(?:Guild|Faction|Town|Clan)[:\s]/i, type: 'group' },
    { re: /(?:Marry|Divorce|Marriage)/i, type: 'marriage' },
    { re: /Vote\s*(?:reward|party|streak)/i, type: 'vote' },
    { re: /\[WARNING\]|\[ALERT\]|\[ANTICHEAT\]|\[CHEAT\]/i, type: 'warning' },
];

const COMMAND_PATTERNS = [
    { re: /^\/(\w+)/, type: 'command_used' },
    { re: /Use\s+\/(\w+)/i, type: 'command_suggested' },
    { re: /Type\s+\/(\w+)/i, type: 'command_suggested' },
    { re: /Try\s+\/(\w+)/i, type: 'command_suggested' },
];

const PLUGIN_PATTERNS = [
    { re: /\[Essentials\]|EssentialsX/i, plugin: 'EssentialsX' },
    { re: /\[CMI\]/i, plugin: 'CMI' },
    { re: /\[Jobs(?:Reborn)?\]|Job (?:level|joined|left)/i, plugin: 'Jobs' },
    { re: /\[mcMMO\]|mcMMO/i, plugin: 'mcMMO' },
    { re: /\[AureliumSkills\]|AureliumSkills/i, plugin: 'AureliumSkills' },
    { re: /\[Quests\]|Quest (?:completed|started|failed)/i, plugin: 'Quests' },
    { re: /\[AuctionHouse\]|\[AH\]/i, plugin: 'AuctionHouse' },
    { re: /\[GriefPrevention\]|\[GP\]/i, plugin: 'GriefPrevention' },
    { re: /\[Lands\]/i, plugin: 'Lands' },
    { re: /\[Towny\]/i, plugin: 'Towny' },
    { re: /\[Factions(?:UUID)?\]/i, plugin: 'Factions' },
    { re: /\[Residence\]|\[Res\]/i, plugin: 'Residence' },
    { re: /\[WorldGuard\]|\[WG\]/i, plugin: 'WorldGuard' },
    { re: /\[ShopGUIPlus\]|\[Shop\]/i, plugin: 'ShopGUIPlus' },
    { re: /\[EcoShop\]/i, plugin: 'EcoShop' },
    { re: /\[ExcellentCrates\]|\[Crates\]|Crate opened/i, plugin: 'ExcellentCrates' },
    { re: /\[VotingPlugin\]|Vote (?:reward|party|streak)/i, plugin: 'VotingPlugin' },
    { re: /\[Marriage\]|\[Marry\]/i, plugin: 'Marriage' },
    { re: /\[DiscordSRV\]|\[Discord\]/i, plugin: 'DiscordSRV' },
    { re: /\[Citizens\]|\[NPC\]/i, plugin: 'Citizens' },
    { re: /\[CoreProtect\]/i, plugin: 'CoreProtect' },
    { re: /\[ViaVersion\]/i, plugin: 'ViaVersion' },
    { re: /\[Geyser(?:MC)?\]/i, plugin: 'Geyser' },
];

export class ChatAnalyzer {
    constructor(knowledgeBase, logger, ownerName = null) {
        this.kb = knowledgeBase;
        this.log = logger || ((...a) => {});
        this.ownerName = ownerName;
        this.recentMessages = [];
        this.maxRecent = 50;
    }

    feed(rawMessage, senderName = null) {
        this.kb.data.stats.messagesParsed++;
        this.recentMessages.push(rawMessage);
        if (this.recentMessages.length > this.maxRecent) this.recentMessages.shift();

        this._detectSystemPatterns(rawMessage);
        this._detectCommands(rawMessage, senderName);
        this._detectPlugins(rawMessage);
        this._detectLinks(rawMessage);
    }

    _detectSystemPatterns(msg) {
        for (const p of SYSTEM_PATTERNS) {
            const m = msg.match(p.re);
            if (m) {
                this.kb.push('chatEvents', { type: p.type, raw: msg, ts: Date.now() });

                if (p.type === 'balance') {
                    const amt = parseFloat(m[1].replace(/,/g, ''));
                    if (!isNaN(amt)) {
                        this.kb.set('economy.enabled', true);
                        this.kb.set('economy.lastBalance', amt);
                    }
                }
                if (p.type === 'earnings') {
                    const amt = parseFloat(m[1].replace(/,/g, ''));
                    if (!isNaN(amt)) {
                        this.kb.set('economy.enabled', true);
                    }
                }
                if (p.type === 'rank') {
                    const rank = m[0].match(/\[(.+?)\]/)?.[1];
                    if (rank) this.kb.push('observedRanks', rank);
                }
                break;
            }
        }
    }

    _isTrustedSender(senderName) {
        if (!senderName) return false;
        const owner = this.ownerName || this.kb.get('server.owner');
        return !!owner && String(senderName).toLowerCase() === String(owner).toLowerCase();
    }

    _detectCommands(msg, senderName = null) {
        // SECURITY: only commands spoken by the trusted owner persist with
        // probeable confidence. Unknown/non-owner senders are stored at 0.2
        // (below CommandDiscovery's 0.3 probe threshold) so a chat-harvested
        // command can never be auto-executed by the bot.
        const trustedSpeaker = this._isTrustedSender(senderName);
        for (const p of COMMAND_PATTERNS) {
            const m = msg.match(p.re);
            if (m) {
                const cmd = '/' + m[1];
                const existing = this.kb.get('commands.' + cmd);
                if (existing) {
                    existing.seenCount = (existing.seenCount || 1) + 1;
                    existing.lastSeen = Date.now();
                } else {
                    const confidence = trustedSpeaker ? (p.type === 'command_used' ? 0.8 : 0.4) : 0.2;
                    this.kb.set('commands.' + cmd, { command: cmd, seenCount: 1, firstSeen: Date.now(), lastSeen: Date.now(), confidence });
                    this.kb.data.stats.commandsDiscovered++;
                }
                break;
            }
        }
    }

    _detectPlugins(msg) {
        for (const p of PLUGIN_PATTERNS) {
            if (p.re.test(msg)) {
                const plugin = this.kb.get('plugins.' + p.plugin);
                if (plugin) {
                    plugin.confidence = Math.min(1, plugin.confidence + 0.1);
                    plugin.lastSeen = Date.now();
                } else {
                    this.kb.set('plugins.' + p.plugin, { name: p.plugin, confidence: 0.5, firstSeen: Date.now(), lastSeen: Date.now() });
                }
                break;
            }
        }
    }

    _detectLinks(msg) {
        const linkMatch = msg.match(/(https?:\/\/[^\s]+)/gi);
        if (linkMatch) {
            for (const link of linkMatch) {
                if (link.includes('discord')) this.kb.merge('server', { discord: link });
                else if (link.includes('store') || link.includes('shop') || link.includes('buy') || link.includes('donate')) this.kb.merge('server', { store: link });
                else if (link.includes('vote')) this.kb.merge('server', { voteLink: link });
                else if (link.includes('map')) this.kb.merge('server', { mapLink: link });
                else this.kb.push('observedLinks', link);
            }
        }
    }
}

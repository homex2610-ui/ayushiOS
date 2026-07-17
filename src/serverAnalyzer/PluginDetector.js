import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PLUGIN_SIGNATURES = {
    'EssentialsX': {
        commands: ['/spawn', '/home', '/sethome', '/tpa', '/tpahere', '/back', '/msg', '/r', '/mail', '/kit', '/warp'],
        messages: ['[Essentials]', 'Teleportation cancelled', 'Home set', 'Warp'],
        scoreboard: null
    },
    'CMI': {
        commands: ['/cmi', '/tpa', '/home', '/warp', '/spawn', '/back', '/kit'],
        messages: ['[CMI]', 'Inventory saved'],
        scoreboard: null
    },
    'LuckPerms': {
        commands: ['/lp', '/luckperms', '/permissions'],
        messages: ['[LuckPerms]'],
        scoreboard: null
    },
    'Vault': {
        commands: [],
        messages: ['Balance:', '$', 'coins', 'money'],
        scoreboard: /(?:Balance|Money|Coins)[:\s]/i
    },
    'Jobs': {
        commands: ['/jobs', '/jobs join', '/jobs leave', '/jobs browse', '/jobs stats'],
        messages: ['[Jobs]', 'Job level', 'Job joined', 'Job left', 'XP:', 'Job payment'],
        scoreboard: /Jobs|Job\s+Level/i
    },
    'mcMMO': {
        commands: ['/mcmmo', '/mcstats', '/mctop', '/skill'],
        messages: ['[mcMMO]', 'Skill increased', 'mcMMO'],
        scoreboard: /mcMMO|Power Level/i
    },
    'AureliumSkills': {
        commands: ['/skills', '/stats', '/rank'],
        messages: ['[AureliumSkills]', 'Skill level up'],
        scoreboard: /Skills|Skill\s+Level/i
    },
    'Quests': {
        commands: ['/quests', '/q', '/quest'],
        messages: ['[Quests]', 'Quest completed', 'Quest started', 'Quest failed'],
        scoreboard: null
    },
    'AuctionHouse': {
        commands: ['/ah', '/auction', '/ah sell', '/ah browse'],
        messages: ['[AuctionHouse]', '[AH]', 'Auction', 'Bid', 'Listed'],
        scoreboard: null
    },
    'GriefPrevention': {
        commands: ['/claim', '/trust', '/untrust', '/accesstrust', '/containertrust'],
        messages: ['[GriefPrevention]', 'Claim created', 'Claim resized'],
        scoreboard: null
    },
    'Lands': {
        commands: ['/lands', '/land', '/lands claim'],
        messages: ['[Lands]', '[Land]', 'claimed', 'Land created'],
        scoreboard: /Lands|Land\s+Power/i
    },
    'Towny': {
        commands: ['/town', '/towny', '/town claim', '/resident', '/nation'],
        messages: ['[Towny]', 'Town created', 'Town joined'],
        scoreboard: /Town|Nation|Resident/i
    },
    'Factions': {
        commands: ['/f', '/factions', '/f claim', '/f create'],
        messages: ['[Factions]', '[FactionsUUID]', 'Faction created'],
        scoreboard: /Faction(s)?\s+Power|Faction/i
    },
    'Residence': {
        commands: ['/res', '/residence', '/res create'],
        messages: ['[Residence]', 'Residence created'],
        scoreboard: null
    },
    'WorldGuard': {
        commands: ['/rg', '/region'],
        messages: ['[WorldGuard]', '[WG]', 'protected', 'region'],
        scoreboard: null
    },
    'WorldEdit': {
        commands: ['//wand', '//set', '//copy', '//paste', '//undo'],
        messages: ['[WorldEdit]'],
        scoreboard: null
    },
    'ShopGUIPlus': {
        commands: ['/shop', '/shopgui'],
        messages: ['[ShopGUI+]', '[Shop]'],
        scoreboard: null
    },
    'EcoShop': {
        commands: ['/shop', '/ecoshop'],
        messages: ['[EcoShop]'],
        scoreboard: null
    },
    'ExcellentCrates': {
        commands: ['/crates', '/crate', '/key'],
        messages: ['[ExcellentCrates]', 'Crate opened', '[Crates]'],
        scoreboard: null
    },
    'CrazyCrates': {
        commands: ['/crates', '/cc'],
        messages: ['[CrazyCrates]', '[CC]'],
        scoreboard: null
    },
    'VotingPlugin': {
        commands: ['/vote'],
        messages: ['[VotingPlugin]', 'Vote reward', 'Vote party'],
        scoreboard: null
    },
    'Marriage': {
        commands: ['/marry', '/divorce'],
        messages: ['[Marriage]'],
        scoreboard: null
    },
    'DiscordSRV': {
        commands: ['/discord'],
        messages: ['[DiscordSRV]', '[Discord]'],
        scoreboard: null
    },
    'Citizens': {
        commands: ['/npc', '/npc select'],
        messages: ['[Citizens]', '[NPC]'],
        scoreboard: null
    },
    'CoreProtect': {
        commands: ['/co', '/coreprotect', '/co inspect'],
        messages: ['[CoreProtect]'],
        scoreboard: null
    },
    'ViaVersion': {
        commands: [],
        messages: ['[ViaVersion]'],
        scoreboard: null
    },
    'Geyser': {
        commands: [],
        messages: ['[Geyser]', '[GeyserMC]'],
        scoreboard: null
    }
};

export class PluginDetector {
    constructor(knowledgeBase, logger) {
        this.kb = knowledgeBase;
        this.log = logger || ((...a) => {});
        this._commandHits = {};
        this._messageHits = {};
    }

    observeCommand(cmd) {
        for (const [plugin, sig] of Object.entries(PLUGIN_SIGNATURES)) {
            if (sig.commands.some(c => cmd === c || cmd.startsWith(c + ' ') || cmd.startsWith(c + ':'))) {
                this._commandHits[plugin] = (this._commandHits[plugin] || 0) + 1;
                this._updateConfidence(plugin, 0.15);
            }
        }
    }

    observeMessage(msg) {
        for (const [plugin, sig] of Object.entries(PLUGIN_SIGNATURES)) {
            if (sig.messages.some(m => msg.includes(m))) {
                this._messageHits[plugin] = (this._messageHits[plugin] || 0) + 1;
                this._updateConfidence(plugin, 0.1);
            }
        }
    }

    observeScoreboard(lines) {
        const text = lines.join(' ');
        for (const [plugin, sig] of Object.entries(PLUGIN_SIGNATURES)) {
            if (sig.scoreboard && sig.scoreboard.test(text)) {
                this._updateConfidence(plugin, 0.2);
            }
        }
    }

    observeGUI(guiTitle) {
        const guiPluginMap = {
            'shop': ['ShopGUIPlus', 'EcoShop', 'EssentialsX'],
            'crate': ['ExcellentCrates', 'CrazyCrates'],
            'quest': ['Quests'],
            'auction': ['AuctionHouse'],
            'trade': ['Citizens'],
            'jobs': ['Jobs'],
            'skills': ['mcMMO', 'AureliumSkills'],
            'economy': ['Vault'],
        };
        const lower = guiTitle?.toLowerCase() || '';
        for (const [keyword, plugins] of Object.entries(guiPluginMap)) {
            if (lower.includes(keyword)) {
                for (const p of plugins) this._updateConfidence(p, 0.1);
            }
        }
    }

    _updateConfidence(plugin, increment) {
        const entry = this.kb.get('plugins.' + plugin);
        if (entry) {
            entry.confidence = Math.min(1, entry.confidence + increment);
            entry.lastSeen = Date.now();
        } else {
            this.kb.set('plugins.' + plugin, { name: plugin, confidence: Math.min(1, increment), firstSeen: Date.now(), lastSeen: Date.now() });
        }
    }

    getDetectedPlugins(minConfidence = 0.3) {
        const detected = [];
        for (const [name, data] of Object.entries(this.kb.data.plugins)) {
            if (data.confidence >= minConfidence) detected.push({ name, confidence: data.confidence, firstSeen: data.firstSeen });
        }
        return detected.sort((a, b) => b.confidence - a.confidence);
    }
}

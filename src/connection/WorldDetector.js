import { WorldType } from './ConnectionSettings.js';
import { computeHubScore } from '../hub/HubDetector.js';

export class WorldDetector {
    constructor(bot) {
        this.bot = bot;
        this._worldProfile = null;
        this._classificationAttempts = 0;
    }

    get worldProfile() {
        return this._worldProfile;
    }

    get isClassified() {
        return this._worldProfile !== null;
    }

    async classify() {
        this._classificationAttempts++;
        console.log(`[WorldDetector] Classifying world (attempt ${this._classificationAttempts})...`);

        const profile = {
            type: WorldType.UNKNOWN,
            gamemode: null,
            hasNPCs: false,
            hasCompass: false,
            canBreakBlocks: false,
            pvp: false,
            scoreboardTitle: null,
            scoreboardLines: [],
            worldName: null,
            spawnType: null,
            canChat: false,
            canMove: false,
            tabHeader: null,
            tabFooter: null,
            playerCount: 0,
            isProxy: false,
            isHub: false,
            isLobby: false,
            hasScoreboard: false,
            confidence: 0,
            hubDetectionScore: 0
        };

        await this._checkScoreboard(profile);
        await this._checkInventory(profile);
        await this._checkWorld(profile);
        await this._checkBossBar(profile);
        await this._checkTabList(profile);
        await this._checkPlayers(profile);
        await this._checkGameState(profile);

        profile.type = this._decideType(profile);

        this._worldProfile = profile;

        console.log(`[WorldDetector] World classified as: ${profile.type} (confidence: ${profile.confidence}%, scoreboard: "${profile.scoreboardTitle || 'none'}", gamemode: ${profile.gamemode || 'unknown'})`);
        return profile;
    }

    async _checkScoreboard(profile) {
        try {
            const scoreboard = this.bot.scoreboard;
            if (!scoreboard) return;

            const title = (scoreboard.title || '').toLowerCase().trim();
            profile.scoreboardTitle = title;

            if (title) {
                profile.hasScoreboard = true;
                profile.confidence += 10;
            }

            if (title.includes('hub') || title.includes('lobby') || title.includes('practice')) {
                profile.isHub = true;
                profile.confidence += 30;
            } else if (title.includes('survival') || title.includes('smp') || title.includes('earth') || title.includes('towny') || title.includes('economy') || title.includes('vanilla')) {
                profile.confidence += 40;
            } else if (title.includes('lifesteal')) {
                profile.confidence += 20;
            } else if (title.includes('skyblock') || title.includes('oneblock')) {
                profile.confidence += 25;
            } else if (title.includes('bedwars') || title.includes('skywars') || title.includes('duels') || title.includes('kitpvp') || title.includes('minigame')) {
                profile.confidence += 10;
            }

            profile.scoreboardLines = [];
            if (scoreboard.items) {
                for (const item of Object.values(scoreboard.items)) {
                    const name = (item.displayName?.text || item.name || '').toLowerCase();
                    if (name) profile.scoreboardLines.push(name);
                }
            }

            const hubKeywords = ['hub', 'lobby', 'practice', 'selector', 'minigame', 'kitpvp', 'bedwars', 'skywars', 'parkour', 'duels'];
            const survivalKeywords = ['survival', 'lifesteal', 'smp', 'earth', 'towny', 'economy', 'vanilla', 'rank', 'balance', 'money', 'kills', 'deaths'];

            const hubMatchCount = profile.scoreboardLines.filter(l => hubKeywords.some(k => l.includes(k))).length;
            const survivalMatchCount = profile.scoreboardLines.filter(l => survivalKeywords.some(k => l.includes(k))).length;

            if (hubMatchCount > 2) {
                profile.isHub = true;
                profile.confidence += 20;
            }
            if (survivalMatchCount > 1 && hubMatchCount === 0) {
                profile.confidence += 25;
            }
            if (survivalMatchCount > 0 && hubMatchCount > 0) {
                profile.confidence += 10;
            }

        } catch (e) {
            // scoreboard may not be available yet
        }
    }

    async _checkInventory(profile) {
        try {
            const inv = this.bot.inventory;
            if (!inv || !inv.items) return;

            const items = inv.items();
            for (const item of items) {
                const name = (item.displayName || item.name || item.minecraftID || '').toLowerCase();
                if (name.includes('compass') || item.name === 'minecraft:compass') {
                    profile.hasCompass = true;
                    profile.confidence += 15;
                }
                try {
                    const lore = item.lore || [];
                    for (const line of lore) {
                        const text = (line.text || line || '').toLowerCase();
                        if (text.includes('hub') || text.includes('server selector') || text.includes('navigate') || text.includes('menu')) {
                            profile.hasCompass = true;
                            if (!profile.isHub) {
                                profile.isHub = true;
                                profile.confidence += 10;
                            }
                        }
                    }
                } catch (_) {}
            }
        } catch (e) {
            // inventory may not be ready
        }
    }

    async _checkWorld(profile) {
        try {
            const world = this.bot.world;
            if (!world) return;

            const dimension = world.dimension?.toLowerCase?.() || '';
            if (dimension) {
                profile.worldName = dimension;
                profile.confidence += 5;
            }

            const difficulty = this.bot.game?.difficulty || '';
            if (difficulty && difficulty !== 'peaceful') {
                profile.pvp = true;
            }

        } catch (e) {}
    }

    async _checkBossBar(profile) {
        try {
            const bossBars = this.bot.bossBars;
            if (!bossBars) return;

            for (const bar of Object.values(bossBars)) {
                const title = (bar.title?.text || bar.title || '').toLowerCase();
                if (title.includes('hub') || title.includes('lobby')) {
                    profile.isHub = true;
                    profile.confidence += 20;
                }
                if (title.includes('survival') || title.includes('smp') || title.includes('earth') || title.includes('towny')) {
                    profile.confidence += 25;
                }
            }
        } catch (e) {}
    }

    async _checkTabList(profile) {
        try {
            const tabList = this.bot.tabList;
            if (!tabList) return;

            if (tabList.header) {
                profile.tabHeader = (tabList.header.text || '').toLowerCase();
                if (profile.tabHeader.includes('hub') || profile.tabHeader.includes('lobby')) {
                    profile.isHub = true;
                    profile.confidence += 15;
                }
                if (profile.tabHeader.includes('survival') || profile.tabHeader.includes('smp') || profile.tabHeader.includes('earth')) {
                    profile.confidence += 20;
                }
            }
            if (tabList.footer) {
                profile.tabFooter = (tabList.footer.text || '').toLowerCase();
                if (profile.tabFooter.includes('hub') || profile.tabFooter.includes('lobby')) {
                    profile.isHub = true;
                    profile.confidence += 10;
                }
                if (profile.tabFooter.includes('survival') || profile.tabFooter.includes('smp')) {
                    profile.confidence += 15;
                }
            }
        } catch (e) {}
    }

    async _checkPlayers(profile) {
        try {
            const players = this.bot.players;
            if (players) {
                profile.playerCount = Object.keys(players).length;
                if (profile.playerCount > 5) profile.confidence += 5;
                if (profile.playerCount > 20) profile.confidence += 5;
            }
        } catch (e) {}
    }

    async _checkGameState(profile) {
        try {
            const game = this.bot.game;
            if (!game) return;

            profile.gamemode = game.gameMode || '';

            if (game.gameMode === 'survival' || game.gameMode === 'creative') {
                profile.canBreakBlocks = true;
                profile.confidence += 15;
            }

            if (game.levelType && !game.levelType.includes('flat')) {
                profile.confidence += 5;
            }

        } catch (e) {}
    }

    _decideType(profile) {
        const title = (profile.scoreboardTitle || '').toLowerCase();

        // Direct hub detection
        if (profile.isHub || title.includes('hub') || title.includes('lobby')) {
            return WorldType.HUB;
        }

        // Direct survival detection
        if (profile.confidence > 50) {
            if (title.includes('survival') || title.includes('smp') || title.includes('earth') ||
                title.includes('towny') || title.includes('economy') || title.includes('vanilla')) {
                return WorldType.SURVIVAL;
            }
            if (title.includes('lifesteal')) return WorldType.LIFESTEAL;
            if (title.includes('skyblock') || title.includes('oneblock')) return WorldType.SKYBLOCK;
            if (title.includes('practice') || title.includes('kitpvp')) return WorldType.PRACTICE;
            if (title.includes('bedwars') || title.includes('skywars')) return WorldType.MINIGAME;
        }

        // Detect hub by compass + no break blocks
        if (profile.hasCompass && !profile.canBreakBlocks) {
            profile.isHub = true;
            return WorldType.HUB;
        }

        // HubDetector confidence scoring — check BEFORE assuming survival, catches
        // hub servers that have survival gamemode (e.g. Drift SMP hub)
        try {
            const hubResult = computeHubScore(this.bot);
            profile.hubDetectionScore = hubResult.score;
            if (hubResult.isHub) {
                console.log(`[WorldDetector] HubDetector confidence score ${hubResult.score} — classifying as HUB`);
                profile.isHub = true;
                return WorldType.HUB;
            }
            if (hubResult.isPossibleHub) {
                console.log(`[WorldDetector] Possible hub (score: ${hubResult.score}) — checking more signals`);
            }
        } catch (e) {
            console.warn(`[WorldDetector] HubDetector error: ${e.message}`);
        }

        // Check for hub NPCs with mode keywords (e.g. KryonMC hub)
        try {
            const modeNpcKeywords = ['survival', 'smp', 'lifesteal', 'practice', 'kitpvp', 'bedwars', 'skywars', 'minigame', 'parkour', 'factions', 'advertise'];
            const hasModeNPCs = Object.values(this.bot.entities || {}).some(e => {
                const entityName = e.username || e.name || e.displayName || '';
                if (e.type === 'player' && entityName === this.bot.username) return false;
                if (e.type === 'player' && entityName && this.bot.players?.[entityName]) return false;
                const name = (e.displayName || e.name || e.username || '').toLowerCase().replace(/§./g, '');
                const customName = e.metadata?.[2]?.toString?.().replace(/§./g, '').toLowerCase().trim();
                const matchText = customName || name;
                return matchText.length > 0 && modeNpcKeywords.some(k => matchText.includes(k));
            });
            if (hasModeNPCs) {
                console.log(`[WorldDetector] Hub NPCs detected with mode keywords — classifying as HUB`);
                profile.isHub = true;
                return WorldType.HUB;
            }
        } catch (e) {
            console.warn(`[WorldDetector] NPC check error: ${e.message}`);
        }

        // If in survival mode, it's a survival world
        if (profile.canBreakBlocks && profile.gamemode === 'survival') {
            return WorldType.SURVIVAL;
        }

        // If there's a scoreboard but no hub indicators, assume survival
        if (profile.hasScoreboard && !profile.isHub && profile.confidence >= 30) {
            return WorldType.SURVIVAL;
        }

        // Can move and chat = probably not a loading screen. Default to survival for SMP servers
        if (profile.confidence >= 10) {
            return WorldType.SURVIVAL;
        }

        // Fallback to survival (most common for SMP bots)
        return WorldType.SURVIVAL;
    }

    isSurvivalOrSMP() {
        if (!this._worldProfile) return false;
        const type = this._worldProfile.type;
        return type === WorldType.SURVIVAL || type === WorldType.SMP ||
               type === WorldType.LIFESTEAL || type === WorldType.SKYBLOCK ||
               type === WorldType.LAN;
    }

    isHub() {
        return this._worldProfile?.type === WorldType.HUB || this._worldProfile?.type === WorldType.LOBBY ||
               this._worldProfile?.isHub === true;
    }
}

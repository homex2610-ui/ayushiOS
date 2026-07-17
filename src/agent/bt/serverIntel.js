import settings from '../settings.js';

const CLAIM_DENIAL_PATTERNS = [
    /you (don'?t|do not) have permission/i,
    /this (area|land|region) (is|has been) claimed/i,
    /you (can'?t|cannot) build here/i,
    /you are not (allowed|permitted) (to|in) this/i,
    /protected (area|region|land)/i,
    /(this|that) (chunk|plot) belongs to/i,
    /insufficient permission/i,
    /no permission for that/i,
];

const ECONOMY_PATTERNS = [
    /\$\s?[\d,]+(\.\d+)?/,
    /(bought|sold|purchased) .* for .* (coins?|gold|dollars?|\$)/i,
    /balance:?\s*[\d,]+/i,
    /not enough (money|funds|coins|balance)/i,
    /shop (is|has been) (opened|created)/i,
];

const COMMAND_ERROR_PATTERNS = [
    /unknown command/i,
    /incorrect (usage|syntax)/i,
    /command (not found|does not exist)/i,
];

const COMMAND_FAILURE_TTL_MS = 5 * 60 * 1000;

export class ServerIntel {
    constructor(memory) {
        this.memory = memory;
        this._attached = false;
        this._lastSentCommand = null;
    }

    attach(bot) {
        if (this._attached) return;
        this._attached = true;

        bot.on('chat', (username, message) => {
            this._classifyAndRecord(bot, username, message);
        });

        bot.on('message', (jsonMsg) => {
            try {
                const text = typeof jsonMsg.toString === 'function' ? jsonMsg.toString() : String(jsonMsg);
                this._classifyAndRecord(bot, null, text);
            } catch {}
        });
    }

    _classifyAndRecord(bot, username, message) {
        if (!message) return;

        if (CLAIM_DENIAL_PATTERNS.some(p => p.test(message))) {
            this._recordClaimHere(bot, message);
            if (settings.bt_log) console.log(`[ServerIntel] Claim denial: "${message}"`);
            return;
        }

        if (ECONOMY_PATTERNS.some(p => p.test(message))) {
            this.memory.setServerFlag('hasEconomy', true);
            if (settings.bt_log) console.log(`[ServerIntel] Economy: "${message}"`);
            return;
        }

        if (COMMAND_ERROR_PATTERNS.some(p => p.test(message))) {
            this._recordLastCommandFailure(message);
            if (settings.bt_log) console.log(`[ServerIntel] Command error: "${message}"`);
        }
    }

    _recordClaimHere(bot, reasonText) {
        if (!bot?.entity) return;
        const pos = bot.entity.position;
        this.memory.addClaimedArea(
            { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
            reasonText
        );
    }

    _recordLastCommandFailure(reasonText) {
        const last = this._lastSentCommand;
        if (!last) return;
        this.memory.recordCommandResult(last, false, reasonText);
    }

    noteCommandSent(commandString) {
        this._lastSentCommand = commandString;
    }

    beginCommandCheck(bot, watch) {
        if (watch === 'inventory') {
            const before = bot.inventory.items().map(i => ({ name: i.name, count: i.count }));
            return () => {
                const after = bot.inventory.items().map(i => ({ name: i.name, count: i.count }));
                return { changed: JSON.stringify(before) !== JSON.stringify(after) };
            };
        }
        if (watch === 'position') {
            const p = bot.entity.position;
            const before = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
            return () => {
                const p2 = bot.entity.position;
                const after = { x: Math.floor(p2.x), y: Math.floor(p2.y), z: Math.floor(p2.z) };
                return { changed: JSON.stringify(before) !== JSON.stringify(after) };
            };
        }
        return () => ({ changed: false });
    }

    shouldAvoidRetrying(commandString) {
        return this.memory.hasCommandFailedRecently(commandString, COMMAND_FAILURE_TTL_MS);
    }

    getScoreboardData(bot) {
        try {
            const boards = bot.scoreboards || {};
            const out = {};
            for (const [name, board] of Object.entries(boards)) {
                out[name] = {
                    title: board.title,
                    items: (board.items || []).map(i => ({ name: i.displayName || i.name, value: i.value })),
                };
            }
            return out;
        } catch {
            return {};
        }
    }

    getTabListData(bot) {
        try {
            const list = bot.players || {};
            return Object.keys(list).map(name => ({
                name,
                ping: list[name]?.ping ?? null,
                displayName: list[name]?.displayName?.toString?.() ?? name,
            }));
        } catch {
            return [];
        }
    }

    isLikelyClaimed(pos, radius) {
        if (radius == null) radius = 16;
        const claims = this.memory.data.claimedAreas || [];
        return claims.some(c => {
            const dx = c.pos.x - pos.x;
            const dy = c.pos.y - pos.y;
            const dz = c.pos.z - pos.z;
            return Math.sqrt(dx * dx + dy * dy + dz * dz) <= radius;
        });
    }
}

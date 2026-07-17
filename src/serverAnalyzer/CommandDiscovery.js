const DISCOVERY_COMMANDS = [
    { cmd: '/help', type: 'help' },
    { cmd: '/hub', type: 'teleport' },
    { cmd: '/lobby', type: 'teleport' },
    { cmd: '/spawn', type: 'teleport' },
    { cmd: '/warp', type: 'teleport' },
    { cmd: '/home', type: 'teleport' },
    { cmd: '/shop', type: 'economy' },
    { cmd: '/balance', type: 'economy' },
    { cmd: '/pay', type: 'economy' },
    { cmd: '/jobs browse', type: 'economy' },
    { cmd: '/ah', type: 'economy' },
    { cmd: '/quests', type: 'progression' },
    { cmd: '/skills', type: 'progression' },
    { cmd: '/stats', type: 'progression' },
    { cmd: '/vote', type: 'vote' },
    { cmd: '/crates', type: 'crate' },
    { cmd: '/kit', type: 'kit' },
    { cmd: '/rtp', type: 'teleport' },
    { cmd: '/tpa', type: 'teleport' },
    { cmd: '/back', type: 'teleport' },
    { cmd: '/sethome', type: 'teleport' },
    { cmd: '/delhome', type: 'teleport' },
    { cmd: '/claim', type: 'claims' },
    { cmd: '/lands', type: 'claims' },
    { cmd: '/f', type: 'claims' },
    { cmd: '/town', type: 'claims' },
    { cmd: '/pm', type: 'social' },
    { cmd: '/msg', type: 'social' },
    { cmd: '/mail', type: 'social' },
    { cmd: '/ignore', type: 'social' },
    { cmd: '/friend', type: 'social' },
    { cmd: '/party', type: 'social' },
    { cmd: '/rules', type: 'info' },
    { cmd: '/info', type: 'info' },
    { cmd: '/discord', type: 'info' },
    { cmd: '/website', type: 'info' },
    { cmd: '/menu', type: 'menu' },
    { cmd: '/server', type: 'server' },
];

const RESPONSE_INDICATORS = {
    help: [/usage|help|command|available|list|page|index/i],
    teleport: [/teleport|warp|home|spawn|moving|you do not have/i],
    economy: [/balance|money|coin|credit|token|shop|price|cost|buy|sell|insufficient/i],
    social: [/message|whisper|tell|msg|offline|not found|player/i],
    claims: [/claim|land|town|faction|wilderness|plot|region/i],
    info: [/rule|info|discord|website|link/i],
    progression: [/quest|skill|level|xpg|progression/i],
    vote: [/vote|reward|key|link/i],
    crate: [/crate|key|reward|open/i],
    kit: [/kit|cooldown|ready|claim/i],
    menu: [/menu|gui|click|select|open/i],
    server: [/server|joining|connected|transfer/i],
};

const HELP_PAGE_REGEX = /Help.*Index\s*\(?\d+\/?\d*\)?/i;
const PLUGIN_CMD_REGEX = /^(\w+):/m;

export class CommandDiscovery {
    constructor(knowledgeBase, bot, logger, serverIntel) {
        this.kb = knowledgeBase;
        this.bot = bot;
        this.log = logger || ((...a) => {});
        this.serverIntel = serverIntel || null;
        this._queue = [];
        this._running = false;
        this._cooldown = 3000;
        this._discovered = new Set();
        this._failed = new Set();
        this._phase = 0;
        this._helpPageCount = 0;
        this._helpPagesProbed = 0;
        this._discoveredFromHelp = new Set();
        this._lastCmdCheck = null;
        this._cmdSentAt = 0;
    }

    start() {
        if (this._running) return;
        this._running = true;
        this._helpPageCount = 0;
        this._helpPagesProbed = 0;
        this._scheduleNext();
    }

    stop() {
        this._running = false;
        this._queue = [];
    }

    addCustomCommand(cmd, type = 'custom') {
        const key = cmd.split(' ')[0];
        if (!this._discovered.has(key)) {
            this._discovered.add(key);
            this.kb.set('commands.' + key, { command: key, seenCount: 1, firstSeen: Date.now(), lastSeen: Date.now(), confidence: 1.0, type, discovered: true });
            this.kb.data.stats.commandsDiscovered++;
        }
    }

    _addFromHelp(text) {
        const lines = text.split('\n');
        for (const line of lines) {
            const match = line.match(/^\s*(\/(\w+))\s*(?:-|–|—|:)/);
            if (match) {
                const cmd = match[1];
                const name = match[2];
                if (!this._discoveredFromHelp.has(cmd)) {
                    this._discoveredFromHelp.add(cmd);
                    this.log('[CMD] Discovered from /help:', cmd);
                    let type = 'custom';
                    for (const [t, patterns] of Object.entries(RESPONSE_INDICATORS)) {
                        if (patterns.some(p => p.test(line))) { type = t; break; }
                    }
                    this.addCustomCommand(cmd, type);
                }
            }
        }
    }

    observeResponse(cmd, response) {
        const key = cmd.split(' ')[0];
        if (this._failed.has(key)) return;
        const entry = this.kb.get('commands.' + key);
        if (!entry) return;
        const isHelpPage = HELP_PAGE_REGEX.test(response);
        if (isHelpPage) {
            this._addFromHelp(response);
        }
        for (const [type, patterns] of Object.entries(RESPONSE_INDICATORS)) {
            if (patterns.some(p => p.test(response))) {
                entry.type = type;
                entry.confidence = Math.min(1, entry.confidence + 0.1);
                break;
            }
        }
        const failPatterns = [/unknown command|not found|invalid command|you don't have permission|no permission|access denied|incomplete command/i];
        if (failPatterns.some(p => p.test(response))) {
            entry.available = false;
            entry.confidence = Math.max(0.1, entry.confidence - 0.3);
            this._failed.add(key);
        } else {
            entry.available = true;
            entry.confidence = Math.min(1, entry.confidence + 0.3);
        }
        entry.lastResponse = response.slice(0, 200);
        this.kb.save();
    }

    _scheduleNext() {
        if (!this._running) return;

        if (this.serverIntel && this._lastCmdCheck) {
            const result = this._lastCmdCheck();
            this._lastCmdCheck = null;
            this._cmdSentAt = 0;
            this.serverIntel.memory.recordCommandResult('(flush)', result.changed, 'cooldown flush');
        }

        if (this._phase === 0) {
            this._queue = [{ cmd: '/help', type: 'help' }];
            this._phase = 1;
        }
        if (this._queue.length === 0 && this._phase === 1) {
            this._phase = 2;
            return;
        }
        if (this._queue.length === 0 && this._phase === 2) {
            this._queue = DISCOVERY_COMMANDS.filter(c => {
                const key = c.cmd.split(' ')[0];
                return !this._discoveredFromHelp.has(c.cmd) && !this._discovered.has(key);
            });
            this._phase = 3;
        }
        if (this._queue.length === 0 && this._phase === 3) {
            this._queue = Object.entries(this.kb.data.commands || {})
                .filter(([k, v]) => !v.available && v.confidence >= 0.3)
                .map(([k, v]) => ({ cmd: k, type: v.type || 'custom' }));
            this._phase = 4;
        }
        if (this._queue.length === 0) {
            this._phase = 5;
            this._running = false;
            this.log('[CMD] Discovery complete.', this._discovered.size, 'commands known,', this._helpPagesProbed, 'help pages parsed');
            return;
        }
        const item = this._queue.shift();
        const key = item.cmd.split(' ')[0];
        if (this._discovered.has(key) || this._failed.has(key)) {
            setTimeout(() => this._scheduleNext(), 100);
            return;
        }

        if (this.serverIntel && this.serverIntel.shouldAvoidRetrying(item.cmd)) {
            this.log('[CMD] Skipping recently-failed command:', item.cmd);
            this._failed.add(key);
            setTimeout(() => this._scheduleNext(), 100);
            return;
        }

        this._discovered.add(key);
        this.kb.set('commands.' + key, { command: key, seenCount: 1, firstSeen: Date.now(), lastSeen: Date.now(), confidence: 0.5, type: item.type, testing: true });
        this.kb.data.stats.commandsDiscovered++;
        if (this.serverIntel) {
            this.serverIntel.noteCommandSent(item.cmd);
            this._lastCmdCheck = this.serverIntel.beginCommandCheck(this.bot, 'inventory');
            this._cmdSentAt = Date.now();
        }
        try {
            this.bot.chat(item.cmd);
        } catch (_) {}
        setTimeout(() => this._scheduleNext(), this._cooldown);
    }

    onChatResponse(msg) {
        if (this._phase === 0 || this._phase === 5) return;
        if (this._phase === 1) {
            const isHelpPage = HELP_PAGE_REGEX.test(msg);
            if (isHelpPage) {
                this._helpPagesProbed++;
                const helpMatch = msg.match(/Help.*Index\s*\(?(\d+)\/?(\d*)\)?/i);
                if (helpMatch) {
                    const current = parseInt(helpMatch[1]);
                    const total = helpMatch[2] ? parseInt(helpMatch[2]) : current;
                    this._helpPageCount = Math.max(this._helpPageCount, total);
                    if (current < total) {
                        this._queue.push({ cmd: `/help ${current + 1}`, type: 'help' });
                    }
                }
                this._addFromHelp(msg);
                return;
            }
            if (this._queue.length === 0) return;
            const currentItem = this._queue[0];
            if (!currentItem || currentItem.cmd !== '/help') {
                this._phase = 2;
                this._scheduleNext();
            }
            return;
        }
        for (const [key, data] of Object.entries(this.kb.data.commands || {})) {
            if (!data.testing) continue;
            this.observeResponse(key, msg);
            data.testing = false;

            if (this.serverIntel && this._lastCmdCheck) {
                const elapsed = Date.now() - this._cmdSentAt;
                if (elapsed >= 500) {
                    const result = this._lastCmdCheck();
                    this._lastCmdCheck = null;
                    this._cmdSentAt = 0;
                    this.serverIntel.memory.recordCommandResult(
                        key, result.changed,
                        result.changed ? 'inventory changed' : 'no inventory change'
                    );
                }
            }
            break;
        }
    }
}

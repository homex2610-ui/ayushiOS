import { KnowledgeBase } from './KnowledgeBase.js';
import { ChatAnalyzer } from './ChatAnalyzer.js';
import { PluginDetector } from './PluginDetector.js';
import { CommandDiscovery } from './CommandDiscovery.js';
import { ScoreboardAnalyzer } from './ScoreboardAnalyzer.js';
import { PlayerAnalyzer } from './PlayerAnalyzer.js';
import { EconomyAnalyzer } from './EconomyAnalyzer.js';
import { GUIAnalyzer } from './GUIAnalyzer.js';
import { ItemLoreAnalyzer } from './ItemLoreAnalyzer.js';
import { NPCAnalyzer } from './NPCAnalyzer.js';
import { WorldAnalyzer } from './WorldAnalyzer.js';
import { DangerAnalyzer } from './DangerAnalyzer.js';
import { RuleAnalyzer } from './RuleAnalyzer.js';
import { LearningEngine } from './LearningEngine.js';
import { SummaryEngine } from './SummaryEngine.js';

export class ServerAnalyzer {
    constructor(agent) {
        this.agent = agent;
        this.bot = agent.bot;
        this.name = agent.name;
        this.enabled = true;

        this.kb = new KnowledgeBase(this.name);
        this.log = (...args) => console.log('[ServerAnalyzer]', ...args);

        this.chat = new ChatAnalyzer(this.kb, this.log);
        this.plugins = new PluginDetector(this.kb, this.log);
        this.commands = new CommandDiscovery(this.kb, this.bot, this.log, this.agent.btServerIntel || null);
        this.scoreboard = new ScoreboardAnalyzer(this.kb, this.log);
        this.players = new PlayerAnalyzer(this.kb, this.log);
        this.economy = new EconomyAnalyzer(this.kb, this.log);
        this.gui = new GUIAnalyzer(this.kb, this.log);
        this.itemLore = new ItemLoreAnalyzer(this.kb, this.log);
        this.npc = new NPCAnalyzer(this.kb, this.log);
        this.world = new WorldAnalyzer(this.kb, this.log);
        this.danger = new DangerAnalyzer(this.kb, this.log);
        this.rules = new RuleAnalyzer(this.kb, this.log);
        this.learning = new LearningEngine(this.kb, this.log);
        this.summary = new SummaryEngine(this.kb, this.log);

        this._tickInterval = null;
        this._tickMs = 5000;
        this._bootPhase = 0;
        this._startTime = Date.now();
        this._lastSummary = '';
    }

    start() {
        if (!this.enabled) return;
        this.log('Starting server analysis...');
        this.commands.start();
        this._tickInterval = setInterval(() => this._tick(), this._tickMs);
        this._boot();
    }

    stop() {
        this.enabled = false;
        if (this._tickInterval) {
            clearInterval(this._tickInterval);
            this._tickInterval = null;
        }
        this.commands.stop();
        this.kb.save();
        this.log('Server analysis stopped.');
    }

    _boot() {
        this._bootPhase = 1;
        setTimeout(() => {
            this.log('Boot phase 1: Chat listeners active');
            this._bootPhase = 2;
        }, 5000);
        setTimeout(() => {
            this.log('Boot phase 2: Command discovery running');
            this._bootPhase = 3;
        }, 15000);
        setTimeout(() => {
            this.log('Boot phase 3: World scan starting');
            this._bootPhase = 4;
        }, 30000);
        setTimeout(() => {
            this._bootPhase = 5;
            this.log('Boot complete. Server analysis fully active.');
            this._logSummary();
        }, 60000);
    }

    _tick() {
        if (!this.enabled || !this.bot?.entity) return;
        try {
            this.scoreboard.feed(this.bot);
            this.players.observe(this.bot);
            this.npc.observe(this.bot);
            this.world.scan(this.bot);
            this.danger.observe(this.bot);
            this.learning.tick();
            this.rules.inferClaimSystem(this.bot);
            this.rules.inferPvPState(this.bot);

            const elapsed = Date.now() - this._startTime;
            if (elapsed > 120000 && (elapsed % 60000 < this._tickMs)) {
                this._logSummary();
            }
        } catch (err) {
            console.warn('[ServerAnalyzer] Tick error:', err.message);
        }
    }

    onChatMessage(rawMessage) {
        if (!this.enabled) return;
        this.chat.feed(rawMessage);
        this.plugins.observeMessage(rawMessage);
        this.commands.onChatResponse(rawMessage);
        this.economy.feed(rawMessage);
        this.rules.feed(rawMessage);
        this.learning.learnFromMessage(rawMessage);

        const cmdMatch = rawMessage.match(/^\/(\w+)/);
        if (cmdMatch) {
            this.plugins.observeCommand('/' + cmdMatch[1]);
        }
    }

    onWindowOpen(window) {
        if (!this.enabled) return;
        this.gui.feed(window);
        if (window.title?.text) {
            this.plugins.observeGUI(window.title.text);
        }
        const slots = window.slots || [];
        for (let i = 0; i < Math.min(slots.length, 54); i++) {
            const item = slots[i];
            if (item?.lore?.length) this.itemLore.feed(item);
        }
    }

    onCommandUsed(cmd) {
        this.plugins.observeCommand(cmd);
    }

    onDeath(cause) {
        this.log('Death detected:', cause);
        const pos = this.bot?.entity?.position;
        if (pos) {
            this.danger.markUnsafeArea(
                { x: pos.x - 5, y: pos.y - 5, z: pos.z - 5 },
                { x: pos.x + 5, y: pos.y + 5, z: pos.z + 5 },
                `Death: ${cause || 'unknown'}`
            );
        }
    }

    onDimensionChange(dimension) {
        this.log('Dimension changed to:', dimension);
        this.kb.merge('server', { lastDimension: dimension });
    }

    onPlayerAttack(attackerName) {
        this.players.markHostile(attackerName, 'attack');
        this.kb.set('server.pvp', true);
    }

    onPlayerDeath(playerName) {
        this.kb.set('server.pvp', true);
    }

    setOwner(playerName) {
        this.players.setOwner(playerName);
    }

    getSummary() {
        return this.summary.generate();
    }

    getShortSummary() {
        return this.summary.generateShort();
    }

    _logSummary() {
        const s = this.getShortSummary();
        const str = JSON.stringify(s);
        if (str === this._lastSummary) return;
        this._lastSummary = str;
        this.log('=== Server Analysis Summary ===');
        this.log('Server:', s.server.name || 'Unknown', '| Claims:', s.server.claimSystem, '| PvP:', s.server.pvp);
        this.log('Plugins:', s.plugins.map(p => `${p.name}(${Math.round(p.confidence*100)}%)`).join(', '));
        this.log('Economy:', s.economy.enabled ? s.economy.currency || 'active' : 'none');
        this.log('Commands discovered:', s.commands.length);
        this.log('Locations mapped:', s.locations?.length ?? 0);
        this.log('Dangers:', s.dangers?.length ?? 0);
        this.log('Players tracked:', s.players?.length ?? 0);
        this.log('Rules:', s.rules?.length ?? 0);
        this.log('================================');
    }
}

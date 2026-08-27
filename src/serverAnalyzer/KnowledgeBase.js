import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';

export class KnowledgeBase {
    constructor(name) {
        this.name = name;
        this.dir = `./bots/${name}/server_knowledge`;
        this.fp = path.join(this.dir, 'knowledge.json');
        mkdirSync(this.dir, { recursive: true });
        this.data = this._load();
    }

    _load() {
        // Full default skeleton: every key analyzers push()/set() against must
        // exist so nothing is silently dropped on fresh or legacy files.
        const DEFAULTS = () => ({
            server: { name: null, motd: null, version: null, firstSeen: Date.now() },
            plugins: {},
            commands: {},
            economy: { enabled: false, currency: null, symbols: [] },
            players: {},
            locations: [],
            npcs: [],
            rules: [],
            dangers: [],
            chatEvents: [],
            observedRanks: [],
            observedLinks: [],
            knownGUITypes: [],
            customItems: [],
            observedPrices: [],
            guiMenus: [],
            itemLores: [],
            scoreboard: {},
            stats: { messagesParsed: 0, commandsDiscovered: 0, playersObserved: 0 }
        });

        let loaded = {};
        try {
            if (existsSync(this.fp)) {
                loaded = JSON.parse(readFileSync(this.fp, 'utf8')) || {};
            }
        } catch (_) {}
        this.data = Object.assign({}, DEFAULTS(), loaded);
        // One-level deep merge for object-valued defaults so loaded objects
        // inherit missing sub-keys; loaded arrays replace the defaults wholesale.
        for (const k of ['server', 'economy', 'stats']) {
            const cur = this.data[k];
            const def = DEFAULTS()[k];
            if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
                this.data[k] = Object.assign({}, def, cur);
            }
        }
        // Legacy-format guard: ChatAnalyzer does stats.messagesParsed++ unconditionally.
        if (!this.data.stats || typeof this.data.stats !== 'object') this.data.stats = { messagesParsed: 0 };
        return this.data;
    }

    save() {
        try {
            writeFileSync(this.fp, JSON.stringify(this.data, null, 2), 'utf8');
        } catch (_) {}
    }

    get(key) {
        return key.split('.').reduce((o, k) => o?.[k], this.data);
    }

    set(key, value) {
        const keys = key.split('.');
        let obj = this.data;
        for (let i = 0; i < keys.length - 1; i++) {
            if (!obj[keys[i]]) obj[keys[i]] = {};
            obj = obj[keys[i]];
        }
        obj[keys[keys.length - 1]] = value;
        this.save();
    }

    merge(key, value) {
        const existing = this.get(key);
        if (typeof existing === 'object' && typeof value === 'object' && !Array.isArray(existing)) {
            this.set(key, { ...existing, ...value });
        } else {
            this.set(key, value);
        }
    }

    push(key, item) {
        const arr = this.get(key);
        if (Array.isArray(arr)) {
            const exists = arr.some(a => JSON.stringify(a) === JSON.stringify(item));
            if (!exists) {
                arr.push(item);
                this.save();
            }
        }
    }

    ensurePath(key) {
        const keys = key.split('.');
        let obj = this.data;
        for (const k of keys) {
            if (!obj[k]) obj[k] = {};
            obj = obj[k];
        }
        return obj;
    }
}

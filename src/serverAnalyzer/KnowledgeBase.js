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
        try {
            if (existsSync(this.fp)) {
                return JSON.parse(readFileSync(this.fp, 'utf8'));
            }
        } catch (_) {}
        return {
            server: { name: null, motd: null, version: null, firstSeen: Date.now() },
            plugins: {},
            commands: {},
            economy: { enabled: false, currency: null, symbols: [] },
            players: {},
            locations: [],
            npcs: [],
            rules: [],
            dangers: [],
            guiMenus: [],
            itemLores: [],
            scoreboard: {},
            stats: { messagesParsed: 0, commandsDiscovered: 0, playersObserved: 0 }
        };
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

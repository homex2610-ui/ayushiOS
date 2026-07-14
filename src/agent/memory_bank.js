import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';

const MEMORY_TYPES = ['place', 'fact', 'episode', 'interaction', 'reflection', 'meta', 'relationship', 'skill'];

export class MemoryBank {
    constructor(agentName) {
        this.name = agentName || 'unknown';
        this.store = [];
        this._idCounter = 0;
        this._dirty = false;
        this._lastPrune = 0;
        this._agent = null;
        this._load();
    }

    setAgent(agent) {
        this._agent = agent;
    }

    _nextId() {
        return `${Date.now()}_${++this._idCounter}`;
    }

    addMemory(content, { type = 'fact', importance, confidence, ttl } = {}) {
        if (!content) return;
        const now = Date.now();
        const entry = {
            id: this._nextId(),
            content: typeof content === 'string' ? content : JSON.stringify(content),
            type: MEMORY_TYPES.includes(type) ? type : 'fact',
            importance: importance ?? this._calcImportance(content, type),
            confidence: confidence ?? 0.7,
            timesUsed: 0,
            lastAccessed: now,
            created: now,
            ttl: ttl ?? null,
        };
        this.store.push(entry);
        this._dirty = true;
        return entry.id;
    }

    _calcImportance(content, type) {
        const lower = content.toLowerCase();
        let base = 0.5;
        if (type === 'reflection' || type === 'meta') base = 0.95;
        else if (type === 'place') base = 0.6;
        else if (type === 'episode') base = 0.5;
        if (lower.includes('die') || lower.includes('death') || lower.includes('killed')) base += 0.2;
        if (lower.includes('found') || lower.includes('discover') || lower.includes('new') || lower.includes('village')) base += 0.15;
        if (lower.includes('diamond') || lower.includes('ancient') || lower.includes('portal')) base += 0.2;
        if (lower.includes('help') || lower.includes('thanks') || lower.includes('friend')) base += 0.1;
        if (lower.includes('mistake') || lower.includes('fail') || lower.includes('error')) base += 0.15;
        return Math.min(1, Math.max(0.1, base));
    }

    findMemories(query, { type, limit = 5, minImportance = 0 } = {}) {
        const lower = query ? query.toLowerCase() : '';
        const scored = this.store.filter(m => {
            if (type && m.type !== type) return false;
            if (m.importance < minImportance) return false;
            if (query && !m.content.toLowerCase().includes(lower)) return false;
            return true;
        }).map(m => {
            let score = m.importance * (1 + m.timesUsed * 0.05);
            if (query) {
                const idx = m.content.toLowerCase().indexOf(lower);
                if (idx >= 0) score += 0.3 / (1 + idx);
            }
            score *= (0.9 + 0.2 * m.confidence);
            return { entry: m, score };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map(s => {
            s.entry.timesUsed++;
            s.entry.lastAccessed = Date.now();
            this._dirty = true;
            return s.entry;
        });
    }

    recallById(id) {
        const m = this.store.find(e => e.id === id);
        if (m) {
            m.timesUsed++;
            m.lastAccessed = Date.now();
            this._dirty = true;
        }
        return m;
    }

    updateImportance(id, delta) {
        const m = this.store.find(e => e.id === id);
        if (m) {
            m.importance = Math.min(1, Math.max(0, m.importance + delta));
            m.lastAccessed = Date.now();
            this._dirty = true;
        }
    }

    reinforce(id) {
        const m = this.store.find(e => e.id === id);
        if (m) {
            m.confidence = Math.min(1, m.confidence + 0.1);
            m.timesUsed++;
            m.lastAccessed = Date.now();
            this._dirty = true;
        }
    }

    removeMemory(id) {
        this.store = this.store.filter(e => e.id !== id);
        this._dirty = true;
    }

    prune(force = false) {
        const now = Date.now();
        if (!force && now - this._lastPrune < 300000) return;
        this._lastPrune = now;
        const before = this.store.length;
        this.store = this.store.filter(m => {
            if (m.importance > 0.9) return true;
            if (m.ttl !== null && now - m.created > m.ttl) return false;
            const ageHours = (now - m.created) / 3600000;
            const decay = m.importance * m.confidence;
            if (ageHours > 72 && decay < 0.2 && m.timesUsed < 2) return false;
            if (ageHours > 24 && decay < 0.1 && m.timesUsed === 0) return false;
            return true;
        });
        if (this.store.length !== before) {
            this._dirty = true;
            console.log(`[MemoryBank] Pruned ${before - this.store.length} memories (${this.store.length} remain)`);
        }
    }

    getLongTermSummary(maxItems = 10) {
        const ranked = [...this.store].sort((a, b) => {
            const sa = a.importance * (1 + a.timesUsed * 0.1);
            const sb = b.importance * (1 + b.timesUsed * 0.1);
            return sb - sa;
        });
        const top = ranked.slice(0, maxItems);
        return top.map(m => {
            let label = m.type === 'place' ? '📍' : m.type === 'episode' ? '📖' : m.type === 'reflection' ? '💡' : m.type === 'meta' ? '🧠' : m.type === 'relationship' ? '👤' : '';
            return `${label} ${m.content.slice(0, 120)} (${(m.importance * 100).toFixed(0)}%)`;
        }).join('\n');
    }

    getStats() {
        const byType = {};
        for (const m of this.store) {
            byType[m.type] = (byType[m.type] || 0) + 1;
        }
        return {
            total: this.store.length,
            byType,
            avgImportance: this.store.length ? (this.store.reduce((s, m) => s + m.importance, 0) / this.store.length).toFixed(2) : 0,
        };
    }

    /** Relationship delegation — sub-manager can be attached */
    setRelationshipManager(rm) {
        this.relationshipManager = rm;
    }

    save() {
        if (!this._dirty) return;
        try {
            const dir = `./bots/${this.name}`;
            mkdirSync(dir, { recursive: true });
            const data = {
                store: this.store,
                _idCounter: this._idCounter,
            };
            if (this._agent?.relationshipManager) {
                data.relationships = this._agent.relationshipManager.toJSON();
            }
            if (this._agent?.knowledgeGraph) {
                data.knowledgeGraph = this._agent.knowledgeGraph.toJSON();
            }
            writeFileSync(`${dir}/long_term_memory.json`, JSON.stringify(data, null, 2));
            this._dirty = false;
        } catch (err) {
            console.error('[MemoryBank] Save failed:', err.message);
        }
    }

    _load() {
        try {
            const fp = `./bots/${this.name}/long_term_memory.json`;
            if (!existsSync(fp)) return;
            const data = JSON.parse(readFileSync(fp, 'utf8'));
            this.store = data.store || [];
            this._idCounter = data._idCounter || 0;
            // Restore relationships and graph via agent reference (set after load)
            this._loadedData = data;
        } catch (err) {
            console.warn('[MemoryBank] Load failed:', err.message);
        }
    }

    restoreSubsystems(agent) {
        if (!this._loadedData) return;
        if (this._loadedData.relationships && agent.relationshipManager) {
            agent.relationshipManager.load(this._loadedData.relationships);
        }
        if (this._loadedData.knowledgeGraph && agent.knowledgeGraph) {
            agent.knowledgeGraph.load(this._loadedData.knowledgeGraph);
        }
        delete this._loadedData;
    }
}

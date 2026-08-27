import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import settings from './settings.js';

function simpleHash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h) + s.charCodeAt(i);
        h |= 0;
    }
    return h;
}

export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        // P0-7 FIX: History previously wrote bots/<n>/memory.json — the SAME
        // path MemoryMatrix uses, last-writer-wins, silently destroying
        // whichever schema lost. Conversation state now owns its own file.
        this.memory_fp = `./bots/${this.name}/conversation.json`;
        this._legacy_fp = `./bots/${this.name}/memory.json`; // one-time migration source
        this.full_history_fp = undefined;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

        this.turns = [];
        this.memory = '';
        this.max_messages = settings.max_messages;
        this.summary_chunk_size = 5;

        this._lastSave = 0;
        this._lastMemoryHash = 0;
        this._saveThrottle = 2000;
    }

    getHistory() {
        return JSON.parse(JSON.stringify(this.turns));
    }

    async summarizeMemories(turns) {
        if (turns.length === 0) return;
        if (!this.agent.prompter || settings.enable_llm === false) {
            this.memory = turns.map(t => t.content).join(' | ').slice(0, 500);
            return;
        }
        const oldMem = this.memory;
        try {
            this.memory = await this.agent.prompter.promptMemSaving(turns);
        } catch (e) {
            console.warn('[History] Memory save failed:', e.message);
            this.memory = oldMem || turns.map(t => t.content).join(' | ').slice(0, 300);
            return;
        }

        if (this.memory.length > 500) {
            this.memory = this.memory.slice(0, 500);
            this.memory += '...(truncated)';
        }

        if (this.memory === oldMem) {
            this.memory = oldMem;
        }
    }

    async appendFullHistory(to_store) {
        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.json`;
            writeFileSync(this.full_history_fp, '[]', 'utf8');
        }
        try {
            const data = readFileSync(this.full_history_fp, 'utf8');
            let full_history = JSON.parse(data);
            full_history.push(...to_store);
            writeFileSync(this.full_history_fp, JSON.stringify(full_history, null, 4), 'utf8');
        } catch (err) {
            console.error(`Error reading ${this.name}'s full history file: ${err.message}`);
        }
    }

    async add(name, content) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        this.turns.push({role, content});

        if (this.turns.length >= this.max_messages) {
            let chunk = this.turns.splice(0, this.summary_chunk_size);
            while (this.turns.length > 0 && this.turns[0].role === 'assistant')
                chunk.push(this.turns.shift());

            await this.summarizeMemories(chunk);
            await this.appendFullHistory(chunk);
        }
    }

    async save() {
        const now = Date.now();
        const memHash = simpleHash(this.memory + JSON.stringify(this.turns.slice(-2)));
        if (memHash === this._lastMemoryHash && now - this._lastSave < this._saveThrottle) return;
        this._lastMemoryHash = memHash;
        this._lastSave = now;

        try {
            const data = {
                memory: this.memory,
                turns: this.turns,
                self_prompting_state: this.agent.self_prompter.state,
                self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                taskStart: this.agent.task.taskStartTime,
                last_sender: this.agent.last_sender
            };
            writeFileSync(this.memory_fp, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error('Failed to save history:', error.message);
        }
    }

    load() {
        try {
            // One-time migration: if the new conversation file doesn't exist
            // but the legacy shared path does AND it looks like OUR schema
            // (has `turns`), adopt it. MemoryMatrix-format files (no turns)
            // are left alone — that's the brain's file now.
            if (!existsSync(this.memory_fp) && existsSync(this._legacy_fp)) {
                try {
                    const legacy = JSON.parse(readFileSync(this._legacy_fp, 'utf8'));
                    if (Array.isArray(legacy?.turns)) {
                        writeFileSync(this.memory_fp, JSON.stringify(legacy, null, 2));
                        console.log('[History] Migrated conversation state from legacy memory.json → conversation.json');
                    }
                } catch (_) { /* unreadable/foreign format — ignore */ }
            }
            if (!existsSync(this.memory_fp)) {
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));
            this.memory = data.memory || '';
            this.turns = data.turns || [];
            return data;
        } catch (error) {
            console.error('Failed to load history:', error.message);
            return null;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
    }
}

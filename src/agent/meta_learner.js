export class MetaLearner {
    constructor(agent) {
        this.agent = agent;
        this.lastMeta = 0;
        this.interval = 1200000;
        this.lessons = [];
    }

    setInterval(ms) {
        this.interval = ms;
    }

    async tick() {
        if (!this.agent.memory_bank || !this.agent.bot?.entity) return;
        const now = Date.now();
        if (now - this.lastMeta < this.interval) return;
        this.lastMeta = now;

        try {
            const reflections = this.agent.memory_bank.store
                .filter(m => m.type === 'reflection')
                .sort((a, b) => b.created - a.created)
                .slice(0, 5);

            const episodes = this.agent.memory_bank.store
                .filter(m => m.type === 'episode')
                .sort((a, b) => b.importance - a.importance)
                .slice(0, 5);

            const prevMeta = this.agent.memory_bank.store
                .filter(m => m.type === 'meta')
                .sort((a, b) => b.created - a.created)
                .slice(0, 3)
                .map(m => `- ${m.content}`)
                .join('\n');

            const refText = reflections.map(m => `- ${m.content}`).join('\n');
            const epText = episodes.map(m => `- ${m.content}`).join('\n');

            const prompt = `Review your recent performance:\n\nReflections:\n${refText || 'none'}\n\nEpisodes:\n${epText || 'none'}\n\nPrevious lessons:\n${prevMeta || 'none'}\n\nWhat strategies worked? What failed? What should you change? Output 2-3 concrete lessons (max 120 chars each).`;

            const res = await this.agent.prompter.chat_model.sendRequest([], prompt);
            if (res && res.trim().length > 10) {
                const cleaned = res.replace(/<\/?think>/g, '').trim();
                this.agent.memory_bank.addMemory(cleaned, { type: 'meta', importance: 1.0 });
                console.log(`[MetaLearner] New lesson: ${cleaned.slice(0, 80)}...`);
            }
        } catch (err) {
            console.warn('[MetaLearner] Error:', err.message);
        }
    }

    getLessons() {
        if (!this.agent.memory_bank) return '';
        return this.agent.memory_bank.store
            .filter(m => m.type === 'meta')
            .sort((a, b) => b.created - a.created)
            .slice(0, 3)
            .map(m => `- ${m.content}`)
            .join('\n');
    }
}

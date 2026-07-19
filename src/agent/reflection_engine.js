export class ReflectionEngine {
    constructor(agent) {
        this.agent = agent;
        this.lastReflection = 0;
        this.interval = 3600000;
    }

    setInterval(ms) {
        this.interval = ms;
    }

    async tick() {
        if (!this.agent.memory_bank || !this.agent.bot?.entity) return;
        if (!this.agent.prompter?.chat_model) return; // LLM disabled
        const now = Date.now();
        if (now - this.lastReflection < this.interval) return;
        this.lastReflection = now;

        try {
            const recentMemories = this.agent.memory_bank.store
                .filter(m => (now - m.created) < this.interval)
                .sort((a, b) => b.importance - a.importance)
                .slice(0, 8);

            const prevReflections = this.agent.memory_bank.store
                .filter(m => m.type === 'reflection')
                .sort((a, b) => b.created - a.created)
                .slice(0, 3)
                .map(m => `- ${m.content}`)
                .join('\n');

            const memoryText = recentMemories.map(m => `[${m.type}] ${m.content}`).join('\n');
            const prompt = `Review the last hour:\n${memoryText}\n\nPrevious reflections:\n${prevReflections || 'none'}\n\nWhat did you learn? What mistakes happened? How can you improve?\nOutput as 3 short bullet points (max 100 chars each).`;

            const res = await this.agent.prompter.chat_model.sendRequest([], prompt);
            if (res && res.trim().length > 10) {
                const cleaned = res.replace(/<\/?think>/g, '').trim();
                this.agent.memory_bank.addMemory(cleaned, { type: 'reflection', importance: 0.95 });
                console.log(`[Reflection] Saved: ${cleaned.slice(0, 80)}...`);
            }
        } catch (err) {
            console.warn('[Reflection] Error:', err.message);
        }
    }
}

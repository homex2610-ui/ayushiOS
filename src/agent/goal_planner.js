export class GoalPlanner {
    constructor(agent) {
        this.agent = agent;
        this.enabled = false;
        this.lastPlan = 0;
        this.planInterval = 120000;
        this.currentGoal = null;
        this.stepIndex = 0;
        this.plan = [];
    }

    start() {
        this.enabled = true;
    }

    stop() {
        this.enabled = false;
        this.plan = [];
        this.currentGoal = null;
    }

    async tick() {
        if (!this.enabled) return;
        if (!this.agent.bot || !this.agent.bot.entity) return;
        if (!this.agent.isIdle()) return;
        if (this.agent.self_prompter.isActive()) return;

        const now = Date.now();
        if (now - this.lastPlan < this.planInterval) return;
        this.lastPlan = now;

        if (this.plan.length > 0 && this.stepIndex < this.plan.length) {
            const step = this.plan[this.stepIndex];
            this.agent.self_prompter.pushGoal(step);
            this.stepIndex++;
            return;
        }

        await this._generatePlan();
    }

    async _generatePlan() {
        try {
            const inventory = this._getInventorySummary();
            const stats = this._getStats();
            const world = this.agent.worldKnowledge?.getSummary() || '';
            const emotions = this.agent.emotionState?.getDescription() || '';

            const prompt = `You are ${this.agent.name} in Minecraft.
Current stats: ${stats}
Inventory: ${inventory}
World: ${world}
Feeling: ${emotions}

What should you do next? Output a plan as a JSON array of 2-4 short action strings (max 80 chars each).
Example: ["Find trees and chop wood", "Craft planks from wood", "Build a small shelter"]
Respond ONLY with the JSON array, nothing else.`;

            const res = await this.agent.prompter.chat_model.sendRequest([], prompt);
            const parsed = this._parsePlan(res);
            if (parsed && parsed.length > 0) {
                this.plan = parsed;
                this.stepIndex = 0;
                const step = this.plan[this.stepIndex];
                this.agent.self_prompter.pushGoal(step);
                this.stepIndex++;
                console.log(`[GoalPlanner] Plan: ${this.plan.join(' -> ')}`);
                if (this.agent.memory_bank) {
                    this.agent.memory_bank.addMemory(`Planned: ${this.plan.join(' -> ')}`, { type: 'episode', importance: 0.5 });
                }
            }
        } catch (err) {
            console.warn('[GoalPlanner] Plan generation failed:', err.message);
        }
    }

    _parsePlan(res) {
        try {
            const json = res.match(/\[[\s\S]*?\]/);
            if (json) return JSON.parse(json[0]);
        } catch {}
        const lines = res.split('\n').filter(l => l.trim().startsWith('"') || l.trim().startsWith('-'));
        if (lines.length > 0) return lines.map(l => l.replace(/^[-"[\]]+/, '').replace(/["[\]]+$/, '').trim()).filter(Boolean);
        return null;
    }

    _getInventorySummary() {
        try {
            const items = this.agent.bot.inventory.items();
            const groups = {};
            for (const item of items) {
                groups[item.name] = (groups[item.name] || 0) + item.count;
            }
            return Object.entries(groups).slice(0, 8).map(([k, v]) => `${k}x${v}`).join(', ') || 'empty';
        } catch { return 'unknown'; }
    }

    _getStats() {
        try {
            const b = this.agent.bot;
            return `HP:${b.health?.toFixed(1)||'?'} Food:${b.food?.toFixed(0)||'?'}`;
        } catch { return 'unknown'; }
    }
}

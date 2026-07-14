import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';

export class SkillLearner {
    constructor(agent) {
        this.agent = agent;
        this.customSkills = [];
        this._dirty = false;
        this._lastSave = 0;
        this._load();
    }

    async detectNewSkill(commandName, args, result) {
        if (!result || result.includes('failed') || result.includes('Error')) return;

        const existing = this.customSkills.find(s => s.command === commandName);
        if (existing) {
            existing.successCount++;
            existing.lastUsed = Date.now();
            this._dirty = true;
            return;
        }

        try {
            const prompt = `A Minecraft bot just ran !${commandName} with args "${args}" and got: "${result.slice(0, 200)}". Write a one-line description of what this command does (max 100 chars). Response only the description.`;

            const desc = await this.agent.prompter.chat_model.sendRequest([], prompt);
            const cleaned = desc.replace(/<\/?think>/g, '').trim().slice(0, 100);

            this.customSkills.push({
                command: commandName,
                args: args || '',
                description: cleaned || `Executed !${commandName}`,
                successCount: 1,
                created: Date.now(),
                lastUsed: Date.now(),
                context: this.agent.worldKnowledge?.getSummary()?.slice(0, 120) || '',
            });

            this._dirty = true;
            console.log(`[SkillLearner] Learned new skill: !${commandName} - ${cleaned}`);
        } catch (err) {
            console.warn('[SkillLearner] Failed to describe skill:', err.message);
        }
    }

    getSkillDocs() {
        if (this.customSkills.length === 0) return '';
        return this.customSkills
            .sort((a, b) => b.successCount - a.successCount)
            .map(s => `!${s.command} - ${s.description} (used ${s.successCount}x)`)
            .join('\n');
    }

    getTopSkills(limit = 5) {
        return [...this.customSkills]
            .sort((a, b) => b.successCount - a.successCount)
            .slice(0, limit);
    }

    save() {
        if (!this._dirty) return;
        try {
            const dir = `./bots/${this.agent.name}`;
            mkdirSync(dir, { recursive: true });
            writeFileSync(`${dir}/custom_skills.json`, JSON.stringify(this.customSkills, null, 2));
            this._dirty = false;
            this._lastSave = Date.now();
        } catch (err) {
            console.error('[SkillLearner] Save failed:', err.message);
        }
    }

    _load() {
        try {
            const fp = `./bots/${this.agent.name}/custom_skills.json`;
            if (!existsSync(fp)) return;
            this.customSkills = JSON.parse(readFileSync(fp, 'utf8'));
        } catch (err) {
            console.warn('[SkillLearner] Load failed:', err.message);
        }
    }
}

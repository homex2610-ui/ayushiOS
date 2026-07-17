import { readFileSync, mkdirSync, writeFileSync} from 'fs';
import { Examples } from '../utils/examples.js';
import { getCommandDocs } from '../agent/commands/index.js';
import { SkillLibrary } from "../agent/library/skill_library.js";
import { stringifyTurns } from '../utils/text.js';
import { getCommand } from '../agent/commands/index.js';
import settings from '../agent/settings.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { selectAPI, createModel } from './_model_map.js';
import { ModelRouter } from './model_router.js';
import { AIService } from '../services/ai_service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class Prompter {
    constructor(agent, profile) {
        this.agent = agent;
        this.profile = profile;
        const defaults_dir = path.join(__dirname, '../../profiles/defaults');
        let default_profile = JSON.parse(readFileSync(path.join(defaults_dir, '_default.json'), 'utf8'));
        let base_fp;
        if (settings.base_profile.includes('survival')) {
            base_fp = path.join(defaults_dir, 'survival.json');
        } else if (settings.base_profile.includes('assistant')) {
            base_fp = path.join(defaults_dir, 'assistant.json');
        } else if (settings.base_profile.includes('creative')) {
            base_fp = path.join(defaults_dir, 'creative.json');
        } else if (settings.base_profile.includes('god_mode')) {
            base_fp = path.join(defaults_dir, 'god_mode.json');
        } else {
            throw new Error(`Unknown base_profile: "${settings.base_profile}". Must be one of: survival, assistant, creative, god_mode`);
        }
        let base_profile = JSON.parse(readFileSync(base_fp, 'utf8'));

        // first use defaults to fill in missing values in the base profile
        for (let key in default_profile) {
            if (base_profile[key] === undefined)
                base_profile[key] = default_profile[key];
        }
        // then use base profile to fill in missing values in the individual profile
        for (let key in base_profile) {
            if (this.profile[key] === undefined)
                this.profile[key] = base_profile[key];
        }
        // base overrides default, individual overrides base

        this.convo_examples = null;
        this.coding_examples = null;
        
        let name = this.profile.name;
        this.cooldown = this.profile.cooldown ? this.profile.cooldown : 0;
        this.last_prompt_time = 0;
        this.awaiting_coding = false;

        // for backwards compatibility, move max_tokens to params
        let max_tokens = null;
        if (this.profile.max_tokens)
            max_tokens = this.profile.max_tokens;

        if (settings.enable_llm !== false && Array.isArray(this.profile.models)) {
            this.chat_model = new ModelRouter(this.profile.models);
            this.ai_service = new AIService();
            this.ai_service.initialize(this.profile.models);
        } else if (settings.enable_llm !== false) {
            let chat_model_profile = selectAPI(this.profile.model);
            this.chat_model = createModel(chat_model_profile);
            this.ai_service = null;
        }

        if (settings.enable_llm !== false && this.profile.code_model) {
            let code_model_profile = selectAPI(this.profile.code_model);
            this.code_model = createModel(code_model_profile);
        }
        else {
            this.code_model = this.chat_model;
        }

        if (this.profile.vision_model) {
            let vision_model_profile = selectAPI(this.profile.vision_model);
            this.vision_model = createModel(vision_model_profile);
        }
        else {
            this.vision_model = this.chat_model;
        }

        
        let embedding_model_profile = null;
        if (this.profile.embedding) {
            try {
                embedding_model_profile = selectAPI(this.profile.embedding);
            } catch (e) {
                embedding_model_profile = null;
            }
        }
        if (embedding_model_profile) {
            this.embedding_model = createModel(embedding_model_profile);
        }
        else {
            this.embedding_model = null;
        }

        this.skill_libary = new SkillLibrary(agent, this.embedding_model);
        mkdirSync(`./bots/${name}`, { recursive: true });
        try {
            writeFileSync(`./bots/${name}/last_profile.json`, JSON.stringify(this.profile, null, 4));
        } catch (err) {
            console.error('Failed to save profile:', err.message);
        }
    }

    getName() {
        return this.profile.name;
    }

    getInitModes() {
        return this.profile.modes;
    }

    async initExamples() {
        try {
            this.convo_examples = new Examples(this.embedding_model, settings.num_examples);
            this.coding_examples = new Examples(this.embedding_model, settings.num_examples);
            
            // Wait for both examples to load before proceeding
            await Promise.all([
                this.convo_examples.load(this.profile.conversation_examples),
                this.coding_examples.load(this.profile.coding_examples),
                this.skill_libary.initSkillLibrary()
            ]).catch(error => {
                // Preserve error details
                console.error('Failed to initialize examples. Error details:', error);
                console.error('Stack trace:', error.stack);
                throw error;
            });

            console.log('Examples initialized.');
        } catch (error) {
            console.error('Failed to initialize examples:', error);
            console.error('Stack trace:', error.stack);
            throw error; // Re-throw with preserved details
        }
    }

    async replaceStrings(prompt, messages, examples=null, to_summarize=[], last_goals=null) {
        prompt = prompt.replaceAll('$NAME', this.agent.name);

        if (prompt.includes('$STATS')) {
            let stats = await getCommand('!stats').perform(this.agent) + '\n';
            stats += await getCommand('!entities').perform(this.agent) + '\n';
            stats += await getCommand('!nearbyBlocks').perform(this.agent);
            prompt = prompt.replaceAll('$STATS', stats);
        }
        if (prompt.includes('$INVENTORY')) {
            let inventory = await getCommand('!inventory').perform(this.agent);
            prompt = prompt.replaceAll('$INVENTORY', inventory);
        }
        if (prompt.includes('$ACTION')) {
            prompt = prompt.replaceAll('$ACTION', this.agent.actions.currentActionLabel);
        }
        if (prompt.includes('$COMMAND_DOCS'))
            prompt = prompt.replaceAll('$COMMAND_DOCS', getCommandDocs(this.agent));
        if (prompt.includes('$CODE_DOCS')) {
            const code_task_content = messages.slice().reverse().find(msg =>
                msg.role !== 'system' && msg.content.includes('!newAction(')
            )?.content?.match(/!newAction\((.*?)\)/)?.[1] || '';

            prompt = prompt.replaceAll(
                '$CODE_DOCS',
                await this.skill_libary.getRelevantSkillDocs(code_task_content, settings.relevant_docs_count)
            );
        }
        if (prompt.includes('$EXAMPLES') && examples !== null)
            prompt = prompt.replaceAll('$EXAMPLES', await examples.createExampleMessage(messages));
        if (prompt.includes('$MEMORY'))
            prompt = prompt.replaceAll('$MEMORY', this.agent.history.memory);
        if (prompt.includes('$WORLD_AWARE') && this.agent.worldKnowledge)
            prompt = prompt.replaceAll('$WORLD_AWARE', this.agent.worldKnowledge.getSummary());
        if (prompt.includes('$MEMORY_SUMMARY') && this.agent.memory_bank)
            prompt = prompt.replaceAll('$MEMORY_SUMMARY', this.agent.memory_bank.getLongTermSummary());
        if (prompt.includes('$EMOTIONS') && this.agent.emotionState)
            prompt = prompt.replaceAll('$EMOTIONS', this.agent.emotionState.getDescription());
        if (prompt.includes('$RELATIONSHIPS') && this.agent.relationshipManager)
            prompt = prompt.replaceAll('$RELATIONSHIPS', this.agent.relationshipManager.getSummary());
        if (prompt.includes('$GRAPH') && this.agent.knowledgeGraph)
            prompt = prompt.replaceAll('$GRAPH', this.agent.knowledgeGraph.getSummary());
        if (prompt.includes('$META_LESSONS'))
            prompt = prompt.replaceAll('$META_LESSONS', this.agent.metaLearner ? this.agent.metaLearner.getLessons() : '');
        if (prompt.includes('$CUSTOM_SKILLS'))
            prompt = prompt.replaceAll('$CUSTOM_SKILLS', this.agent.skillLearner ? this.agent.skillLearner.getSkillDocs() : '');
        if (prompt.includes('$TO_SUMMARIZE'))
            prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize));
        if (prompt.includes('$CONVO'))
            prompt = prompt.replaceAll('$CONVO', 'Recent conversation:\n' + stringifyTurns(messages));
        if (prompt.includes('$GAME_STATE')) {
            const bot = this.agent.bot;
            const pos = bot.entity?.position;
            let state = '=== GAME STATE ===';
            if (bot.entity && pos) {
                state += `\nHP: ${Math.round(bot.health)}/20  Food: ${Math.round(bot.food)}/20  Pos: ${pos.x.toFixed(1)} ${pos.y.toFixed(1)} ${pos.z.toFixed(1)}`;
            } else {
                state += '\nNot spawned yet.';
            }
            if (bot.entities) {
                const players = Object.values(bot.entities)
                    .filter(e => e.type === 'player' && e.username !== bot.username && e.position && bot.entity?.position)
                    .map(e => ({ name: e.username, dist: Math.round(bot.entity.position.distanceTo(e.position)) }))
                    .sort((a, b) => a.dist - b.dist);
                if (players.length > 0) {
                    state += `\nPlayers: ${players.map(p => `${p.name}(${p.dist}m)`).join(', ')}`;
                }
                const mobs = Object.values(bot.entities)
                    .filter(e => e.type === 'mob' && e.position && bot.entity?.position && e.position.distanceTo(bot.entity.position) < 32)
                    .map(e => ({ name: e.name || e.displayName, dist: Math.round(bot.entity.position.distanceTo(e.position)) }))
                    .sort((a, b) => a.dist - b.dist);
                if (mobs.length > 0) {
                    const grouped = {};
                    for (const m of mobs) {
                        if (!grouped[m.name]) grouped[m.name] = { count: 0, minDist: m.dist };
                        grouped[m.name].count++;
                        if (m.dist < grouped[m.name].minDist) grouped[m.name].minDist = m.dist;
                    }
                    state += `\nMobs: ${Object.entries(grouped).map(([n, g]) => `${g.count}×${n}(${g.minDist}m)`).join(', ')}`;
                }
                const npcs = Object.values(bot.entities)
                    .filter(e => {
                        if (e.type === 'player' || e.type === 'mob' || !e.position || !bot.entity?.position) return false;
                        const customName = e.metadata?.[2]?.toString?.().replace(/§./g, '').trim();
                        return customName && e.position.distanceTo(bot.entity.position) < 32;
                    })
                    .map(e => ({
                        name: e.metadata?.[2]?.toString?.().replace(/§./g, '').trim() || e.name,
                        dist: Math.round(bot.entity.position.distanceTo(e.position))
                    }))
                    .sort((a, b) => a.dist - b.dist);
                if (npcs.length > 0) {
                    state += `\nNPCs: ${npcs.map(n => `${n.name}(${n.dist}m)`).join(', ')}`;
                }
            }
            if (bot.inventory) {
                const counts = {};
                for (const slot of bot.inventory.slots) {
                    if (slot && slot.name) counts[slot.name] = (counts[slot.name] || 0) + slot.count;
                }
                const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
                if (entries.length > 0) {
                    state += `\nItems: ${entries.map(([n, c]) => `${n}×${c}`).join(', ')}`;
                }
                let armor = [];
                const armorSlots = [5, 6, 7, 8];
                for (const idx of armorSlots) {
                    const slot = bot.inventory.slots[idx];
                    if (slot) armor.push(slot.name);
                }
                if (armor.length > 0) state += `\nArmor: ${armor.join(', ')}`;
            }
            if (this.agent.self_prompter && !this.agent.self_prompter.isStopped()) {
                state += `\nGoal: ${this.agent.self_prompter.prompt}`;
            }
            if (this.agent.history?.memory) {
                state += `\nMemory: ${this.agent.history.memory}`;
            }
            const action = this.agent.actions?.currentActionLabel || (this.agent.isIdle() ? 'Idle' : 'Busy');
            state += `\nStatus: ${action}`;
            prompt = prompt.replaceAll('$GAME_STATE', state);
        }
        if (prompt.includes('$SELF_PROMPT')) {
            // if active or paused, show the current goal
            let self_prompt = !this.agent.self_prompter.isStopped() ? `YOUR CURRENT ASSIGNED GOAL: "${this.agent.self_prompter.prompt}"\n` : '';
            prompt = prompt.replaceAll('$SELF_PROMPT', self_prompt);
        }
        if (prompt.includes('$LAST_GOALS')) {
            let goal_text = '';
            for (let goal in last_goals) {
                if (last_goals[goal])
                    goal_text += `You recently successfully completed the goal ${goal}.\n`
                else
                    goal_text += `You recently failed to complete the goal ${goal}.\n`
            }
            prompt = prompt.replaceAll('$LAST_GOALS', goal_text.trim());
        }
        if (prompt.includes('$BLUEPRINTS')) {
            if (this.agent.npc.constructions) {
                let blueprints = '';
                for (let blueprint in this.agent.npc.constructions) {
                    blueprints += blueprint + ', ';
                }
                prompt = prompt.replaceAll('$BLUEPRINTS', blueprints.slice(0, -2));
            }
        }

        // check if there are any remaining placeholders with syntax $<word>
        let remaining = prompt.match(/\$[A-Z_]+/g);
        if (remaining !== null) {
            console.warn('Unknown prompt placeholders:', remaining.join(', '));
        }
        return prompt;
    }

    async checkCooldown() {
        let elapsed = Date.now() - this.last_prompt_time;
        if (elapsed < this.cooldown && this.cooldown > 0) {
            await new Promise(r => setTimeout(r, Math.min(this.cooldown - elapsed, 100)));
        }
        this.last_prompt_time = Date.now();
    }

    async promptConvo(messages) {
        if (settings.enable_llm === false) return '';
        let prompt = this.profile.conversing;
        prompt = await this.replaceStrings(prompt, messages, this.convo_examples);

        try {
            const model = this.ai_service || this.chat_model;
            const generation = await model.sendRequest(messages, prompt);
            if (typeof generation !== 'string') {
                console.error('Error: Generated response is not a string', generation);
                return '';
            }
            if (generation.includes('(FROM OTHER BOT)')) {
                console.warn('LLM hallucinated message as another bot.');
                return '';
            }
            let result = generation;
            if (result?.includes('</think>')) {
                const [_, afterThink] = result.split('</think>');
                result = afterThink;
            }
            await this._saveLog(prompt, messages, result, 'conversation');
            return result;
        } catch (error) {
            console.error('Error during message generation:', error.message);
            return '';
        }
    }

    async promptCoding(messages) {
        if (settings.enable_llm === false) return '';
        if (this.awaiting_coding) {
            console.warn('Already awaiting coding response, returning no response.');
            return '```//no response```';
        }
        this.awaiting_coding = true;
        await this.checkCooldown();
        let prompt = this.profile.coding;
        prompt = await this.replaceStrings(prompt, messages, this.coding_examples);

        let resp = await this.code_model.sendRequest(messages, prompt);
        this.awaiting_coding = false;
        await this._saveLog(prompt, messages, resp, 'coding');
        return resp;
    }

    async promptMemSaving(to_summarize) {
        if (settings.enable_llm === false) return '';
        await this.checkCooldown();
        let prompt = this.profile.saving_memory;
        prompt = await this.replaceStrings(prompt, null, null, to_summarize);
        let resp;
        try {
            resp = await this.chat_model.sendRequest([], prompt);
        } catch (e) {
            throw e;
        }
        if (resp?.includes('</think>')) {
            const [_, afterThink] = resp.split('</think>')
            resp = afterThink;
        }
        return resp;
    }

    async promptShouldRespondToBot(new_message) {
        if (settings.enable_llm === false) return false;
        await this.checkCooldown();
        let prompt = this.profile.bot_responder;
        let messages = this.agent.history.getHistory();
        messages.push({role: 'user', content: new_message});
        prompt = await this.replaceStrings(prompt, null, null, messages);
        let res = await this.chat_model.sendRequest([], prompt);
        return res.trim().toLowerCase() === 'respond';
    }

    async promptVision(messages, imageBuffer) {
        if (settings.enable_llm === false) return '';
        await this.checkCooldown();
        let prompt = this.profile.image_analysis;
        prompt = await this.replaceStrings(prompt, messages, null, null, null);
        return await this.vision_model.sendVisionRequest(messages, prompt, imageBuffer);
    }

    async promptGoalSetting(messages, last_goals) {
        if (settings.enable_llm === false) return null;
        let system_message = this.profile.goal_setting;
        system_message = await this.replaceStrings(system_message, messages);

        let user_message = 'Use the below info to determine what goal to target next\n\n';
        user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO'
        user_message = await this.replaceStrings(user_message, messages, null, null, last_goals);
        let user_messages = [{role: 'user', content: user_message}];

        let res = await this.chat_model.sendRequest(user_messages, system_message);

        let goal = null;
        try {
            let data = res.split('```')[1].replace('json', '').trim();
            goal = JSON.parse(data);
        } catch (err) {
            console.log('Failed to parse goal:', res, err);
        }
        if (!goal || !goal.name || !goal.quantity || isNaN(parseInt(goal.quantity))) {
            console.log('Failed to set goal:', res);
            return null;
        }
        goal.quantity = parseInt(goal.quantity);
        return goal;
    }

    async _saveLog(prompt, messages, generation, tag) {
        if (!settings.log_all_prompts)
            return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        let logEntry;
        let task_id = this.agent.task.data?.task_id;
        if (task_id == null) {
            logEntry = `[${timestamp}] \nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        } else {
            logEntry = `[${timestamp}] Task ID: ${task_id}\nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        }
        const logFile = `${tag}_${timestamp}.txt`;
        await this._saveToFile(logFile, logEntry);
    }

    async _saveToFile(logFile, logEntry) {
        let task_id = this.agent.task.data?.task_id;
        let logDir;
        if (task_id == null) {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs`);
        } else {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs/${task_id}`);
        }

        await fs.mkdir(logDir, { recursive: true });

        logFile = path.join(logDir, logFile);
        await fs.appendFile(logFile, String(logEntry), 'utf-8');
    }
}

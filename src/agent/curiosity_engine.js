export class CuriosityEngine {
    constructor(agent) {
        this.agent = agent;
        this.enabled = false;
        this.advisorMode = false;
        this.lastTick = 0;
        this.currentBehavior = null;
        this.learnedFacts = [];
    }

    start({ advisorMode = false } = {}) {
        this.enabled = true;
        this.advisorMode = !!advisorMode;
        this.lastTick = Date.now();
    }

    stop() {
        this.enabled = false;
    }

    setAdvisorMode(on) {
        this.advisorMode = !!on;
    }

    async tick() {
        if (!this.enabled) return;
        if (!this.agent.bot || !this.agent.bot.entity) return;

        const now = Date.now();
        if (now - this.lastTick < 5000) return;
        this.lastTick = now;

        if (this.advisorMode || !!this.agent.brain) {
            this._suggest();
            return;
        }

        if (!this.agent.isIdle()) return;
        if (this.agent.self_prompter.isActive()) return;
        if (this.agent.goalPlanner?.enabled) return;

        const behavior = this._pickBehavior();
        this.currentBehavior = behavior;

        switch (behavior) {
            case 'explore':
                this._doExplore();
                break;
            case 'observe_player':
                this._doObservePlayer();
                break;
            case 'try_interact':
                this._doTryInteract();
                break;
            case 'practice_skill':
                break;
        }
    }

    _suggest() {
        const behavior = this._pickBehavior();
        this.currentBehavior = behavior;
        const bot = this.agent.bot;
        const propose = (suggestion) => {
            this.agent.brain?.proposeSuggestion?.({
                ...suggestion,
                source: 'curiosity',
            });
        };

        if (behavior === 'explore') {
            const yaw = Math.random() * Math.PI * 2;
            const dist = 8 + Math.random() * 12;
            const x = bot.entity.position.x + Math.cos(yaw) * dist;
            const z = bot.entity.position.z + Math.sin(yaw) * dist;
            propose({
                type: 'explore',
                goal: 'explore_unknown',
                reason: `Look around near ${Math.round(x)}, ${Math.round(z)}`,
                priority: 0.25,
                steps: [
                    { skill: 'move_to', params: { x: Math.round(x), y: Math.round(bot.entity.position.y), z: Math.round(z), range: 5 } },
                    { skill: 'wait', params: { ms: 4000 } },
                ],
            });
            return;
        }

        if (behavior === 'observe_player') {
            propose({
                type: 'social',
                goal: 'socialize',
                reason: 'Nearby player worth observing',
                priority: 0.2,
            });
            return;
        }

        if (behavior === 'try_interact') {
            propose({
                type: 'explore',
                goal: 'explore_unknown',
                reason: 'Interesting block nearby',
                priority: 0.22,
            });
        }
    }

    _pickBehavior() {
        const bot = this.agent.bot;
        const emotions = this.agent.emotionState;
        const nearby = Object.values(bot.players || {}).filter(p => {
            if (p.username === bot.username) return false;
            if (!p.entity || !p.entity.position) return false;
            return bot.entity.position.distanceTo(p.entity.position) < 16;
        });
        if (nearby.length > 0) return 'observe_player';
        if (emotions) {
            if (emotions.fear > 0.6) return 'practice_skill';
            if (emotions.energy < 0.3) return 'practice_skill';
            if (emotions.curiosity > 0.7) return 'explore';
        }
        const rand = Math.random();
        if (rand < 0.3) return 'explore';
        if (rand < 0.6) return 'try_interact';
        return 'practice_skill';
    }

    _doExplore() {
        const bot = this.agent.bot;
        const yaw = Math.random() * Math.PI * 2;
        const dist = 8 + Math.random() * 12;
        const x = bot.entity.position.x + Math.cos(yaw) * dist;
        const z = bot.entity.position.z + Math.sin(yaw) * dist;
        const nearby = this.agent.worldKnowledge?.getInterestingBlocks?.()?.slice(0, 2).join(', ') || '';
        const goal = `Look around at ${Math.round(x)}, ${Math.round(z)}${nearby ? ' (near: ' + nearby + ')' : ''}`;
        this.agent.self_prompter.pushGoal(goal);
        setTimeout(() => {
            if (this.agent.self_prompter.isActive()) {
                this.agent.self_prompter.stop(false);
            }
        }, 15000);
    }

    _doObservePlayer() {
        const bot = this.agent.bot;
        const player = Object.values(bot.players || {}).find(p =>
            p.username !== bot.username && p.entity
        );
        if (!player) return;
        const dist = bot.entity.position.distanceTo(player.entity.position);
        if (dist > 20) return;
        if (this.agent.memory_bank) {
            this.agent.memory_bank.addMemory(
                `Watched ${player.username} at ${Math.round(player.entity.position.x)}, ${Math.round(player.entity.position.z)}`,
                { type: 'interaction', importance: 0.4 }
            );
        }
        if (this.agent.relationshipManager) {
            this.agent.relationshipManager.recordMessage(player.username, '(observed)');
        }
    }

    _doTryInteract() {
        const bot = this.agent.bot;
        const target = this.agent.worldKnowledge?.getInterestingBlocks?.()?.[0];
        if (!target) return;
        const goal = `Try to touch the ${target} nearby`;
        this.agent.self_prompter.pushGoal(goal);
        setTimeout(() => {
            if (this.agent.self_prompter.isActive()) {
                this.agent.self_prompter.stop(false);
            }
        }, 15000);
    }

    learnFact(fact) {
        this.learnedFacts.push({ fact, time: Date.now() });
        if (this.learnedFacts.length > 20) this.learnedFacts.shift();
        if (this.agent.memory_bank) {
            this.agent.memory_bank.addMemory(fact, { type: 'fact', importance: 0.5 });
        }
    }

    getFacts() {
        return this.learnedFacts.map(f => f.fact);
    }
}

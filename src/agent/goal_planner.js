// GoalPlanner.js
// Deterministic, rule-based planning for autonomous bot behavior.
// Plans are executed directly with available TaskRunner skills.

export class GoalPlanner {
    constructor(agent) {
        this.agent = agent;
        this.enabled = false;
        this.lastPlan = 0;
        this.planInterval = 120000;
        this.plan = [];
        this.currentTask = null;
    }

    start() {
        this.enabled = true;
    }

    stop() {
        this.enabled = false;
        this.plan = [];
        this.currentTask = null;
    }

    async tick() {
        if (!this.enabled) return;
        if (!this.agent.bot || !this.agent.bot.entity) return;
        if (!this.agent.isIdle()) return;
        if (this.currentTask) return;
        if (!this.agent.taskRunner) return;

        const now = Date.now();
        if (now - this.lastPlan < this.planInterval) return;
        this.lastPlan = now;

        await this._executePlan();
    }

    async _executePlan() {
        try {
            const state = this._gatherState();
            const plan = this._buildPlan(state);
            if (!plan || plan.length === 0) return;

            this.plan = plan;
            const planSummary = plan.map(step => `${step.skill}${step.params ? `(${Object.keys(step.params).join(',')})` : ''}`).join(' -> ');
            console.log(`[GoalPlanner] Executing plan: ${planSummary}`);
            if (this.agent.memory_bank) {
                this.agent.memory_bank.addMemory(`Planned: ${planSummary}`, { type: 'episode', importance: 0.6 });
            }

            this.currentTask = this.agent.taskRunner.runTask(plan);
            const result = await this.currentTask;
            if (result && result.success === false) {
                console.warn(`[GoalPlanner] Plan failed at step ${result.failedStep}: ${result.reason}`);
                if (this.agent.memory_bank) {
                    this.agent.memory_bank.addMemory(`Plan failed: ${result.reason}`, { type: 'incident', importance: 0.8 });
                }
            }
        } catch (err) {
            console.warn('[GoalPlanner] Plan execution failed:', err.message);
        } finally {
            this.plan = [];
            this.currentTask = null;
        }
    }

    _gatherState() {
        const bot = this.agent.bot;
        const snapshot = this.agent.brain?.senses?.getSnapshot?.() || {};
        const position = snapshot.environment?.position || (bot.entity ? {
            x: Math.round(bot.entity.position.x),
            y: Math.round(bot.entity.position.y),
            z: Math.round(bot.entity.position.z),
        } : null);

        const items = (bot.inventory?.items() || []).reduce((acc, item) => {
            acc[item.name] = (acc[item.name] || 0) + item.count;
            return acc;
        }, {});

        const hasFood = !!(
            items.apple || items.bread || items.stew || items.pumpkin_pie || items.cake ||
            items.cooked_beef || items.cooked_porkchop || items.cooked_chicken || items.cooked_cod ||
            items.cooked_salmon || items.cooked_mutton || items.cooked_rabbit || items.cooked_potato ||
            items.carrot || items.beetroot || items.potato || items.melon_slice || items.honey_bottle ||
            items.egg
        );

        const hasIron = !!(items.iron_ingot || items.raw_iron);
        const hasDiamond = !!items.diamond;

        const armor = {
            diamond: this._hasArmor('diamond'),
            iron: this._hasArmor('iron'),
        };

        const safeWaypoint = this.agent.brain?.memory?.getSafeWaypoint?.(position);
        const nearbyHazards = this.agent.brain?.memory?.getHazardsNear?.(position, 30) || [];
        const knownWarps = Object.keys(this.agent.brain?.memory?.longTerm?.semantic?.warps || {});
        const nearestWarp = this.agent.brain?.memory?.findNearestWarp?.(position) || null;
        const nearestFoodSource = this.agent.brain?.memory?.findBestFoodSources?.(position, 120)?.[0] || null;
        const nearestSafeBase = this.agent.brain?.memory?.findNearestSafeBase?.(position) || null;
        const knownNPCs = this.agent.brain?.memory?.findKnownNPCs?.() || [];
        const nearbyFoodSources = this.agent.brain?.memory?.findBestFoodSources?.(position, 120) || [];
 
        const threats = snapshot.threats || [];
        const nearestPlayer = snapshot.social?.nearbyPlayers?.[0] || null;
 
        return {
            position,
            health: snapshot.vitality?.health ?? bot.health,
            food: snapshot.vitality?.food ?? bot.food,
            isNight: snapshot.environment?.isNight ?? false,
            hasFood,
            hasIron,
            hasDiamond,
            armor,
            threats,
            nearestPlayer,
            safeWaypoint,
            nearbyHazards,
            knownWarps,
            nearestWarp,
            nearestFoodSource,
            nearestSafeBase,
            nearbyFoodSources,
            knownNPCs,
            summary: this.agent.worldKnowledge?.getSummary?.() || '',
        };
    }

    _hasArmor(material) {
        const inventory = this.agent.bot.inventory?.items() || [];
        return inventory.some(i => i.name.includes(`${material}_helmet`) || i.name.includes(`${material}_chestplate`) || i.name.includes(`${material}_leggings`) || i.name.includes(`${material}_boots`));
    }

    _buildPlan(state) {
        if (state.threats.length > 0) {
            return this._planSeekSafety(state);
        }

        if (!state.hasFood || state.food < 10) {
            return this._planGetFood(state);
        }

        if (!state.armor.iron && !state.armor.diamond) {
            return this._planGetIronGear(state);
        }

        if (!state.safeWaypoint && state.position) {
            return this._planEstablishBase(state);
        }

        if (state.nearbyHazards.length > 0) {
            return this._planAvoidHazards(state);
        }

        if (state.knownWarps.length > 0) {
            return this._planExploreWarp(state);
        }
 
        if (state.knownNPCs?.length > 0) {
            return this._planInvestigateNPC(state);
        }
 
        return this._planExplore(state);
    }

    _planSeekSafety(state) {
        const target = state.safeWaypoint || state.nearestSafeBase;
        if (target) {
            return [
                { skill: 'move_to', params: { x: target.position.x, y: target.position.y, z: target.position.z, range: 2 } },
                { skill: 'wait', params: { ms: 8000 } }
            ];
        }
        return [
            { skill: 'go_surface', params: {} },
            { skill: 'wait', params: { ms: 6000 } }
        ];
    }

    _planGetFood(state) {
        if (state.hasFood) {
            return [
                { skill: 'eat', params: { minFood: 18 } }
            ];
        }
        if (state.nearestFoodSource) {
            const item = state.nearestFoodSource.name?.toLowerCase().includes('potato') ? 'potato' :
                         state.nearestFoodSource.name?.toLowerCase().includes('carrot') ? 'carrot' :
                         state.nearestFoodSource.name?.toLowerCase().includes('wheat') ? 'wheat' :
                         'carrot';
            return [
                { skill: 'move_to', params: { x: state.nearestFoodSource.position.x, y: state.nearestFoodSource.position.y, z: state.nearestFoodSource.position.z, range: 4 } },
                { skill: 'wait', params: { ms: 4000 } },
                { skill: 'collect', params: { item, count: 4 } },
                { skill: 'eat', params: { minFood: 18 } }
            ];
        }
        if (state.nearbyFoodSources && state.nearbyFoodSources.length > 0) {
            const alternate = state.nearbyFoodSources[0];
            return [
                { skill: 'move_to', params: { x: alternate.position.x, y: alternate.position.y, z: alternate.position.z, range: 4 } },
                { skill: 'collect', params: { item: alternate.name?.toLowerCase().includes('potato') ? 'potato' : 'carrot', count: 4 } },
                { skill: 'eat', params: { minFood: 18 } }
            ];
        }
        return [
            { skill: 'collect', params: { item: 'carrot', count: 3 } },
            { skill: 'eat', params: { minFood: 18 } }
        ];
    }

    _planGetIronGear(state) {
        if (state.hasIron) {
            return [
                { skill: 'smelt', params: { input: 'iron_ingot', count: 4, fuel: 'coal' } },
                { skill: 'craft', params: { item: 'iron_chestplate', count: 1 } },
                { skill: 'equip', params: { item: 'iron_chestplate', slot: 'chest' } }
            ];
        }
        return [
            { skill: 'collect', params: { item: 'iron_ore', count: 8 } },
            { skill: 'smelt', params: { input: 'iron_ingot', count: 4, fuel: 'coal' } },
            { skill: 'craft', params: { item: 'iron_chestplate', count: 1 } }
        ];
    }

    _planEstablishBase(state) {
        if (state.nearestSafeBase) {
            return [
                { skill: 'move_to', params: { x: state.nearestSafeBase.position.x, y: state.nearestSafeBase.position.y, z: state.nearestSafeBase.position.z, range: 3 } },
                { skill: 'wait', params: { ms: 3000 } }
            ];
        }
        return [
            { skill: 'move_to', params: { x: state.position.x + 10, y: state.position.y, z: state.position.z + 10, range: 4 } },
            { skill: 'collect', params: { item: 'oak_log', count: 8 } },
            { skill: 'craft', params: { item: 'oak_planks', count: 16 } }
        ];
    }

    _planAvoidHazards(state) {
        const target = state.safeWaypoint || state.nearestSafeBase;
        if (target) {
            return [
                { skill: 'move_to', params: { x: target.position.x, y: target.position.y, z: target.position.z, range: 2 } }
            ];
        }
        return [
            { skill: 'go_surface', params: {} }
        ];
    }

    _planExploreWarp(state) {
        if (state.nearestWarp && state.nearestWarp.position) {
            return [
                { skill: 'move_to', params: { x: state.nearestWarp.position.x, y: state.nearestWarp.position.y, z: state.nearestWarp.position.z, range: 6 } },
                { skill: 'wait', params: { ms: 5000 } }
            ];
        }
        return [
            { skill: 'move_to', params: { x: state.position.x + 15, y: state.position.y, z: state.position.z + 15, range: 6 } },
            { skill: 'wait', params: { ms: 5000 } }
        ];
    }
 
    _planInvestigateNPC(state) {
        const npcTarget = state.knownNPCs[0];
        if (npcTarget?.position) {
            return [
                { skill: 'move_to', params: { x: npcTarget.position.x, y: npcTarget.position.y, z: npcTarget.position.z, range: 5 } },
                { skill: 'wait', params: { ms: 3000 } }
            ];
        }
        return this._planExplore(state);
    }
 
    _planExplore(state) {
        const candidateWaypoints = Object.values(this.agent.brain?.memory?.longTerm?.semantic?.worldGraph?.nodes || {})
            .filter(node => node.position && (!node.visitCount || node.visitCount < 3))
            .sort((a, b) => (a.visitCount || 0) - (b.visitCount || 0));

        if (candidateWaypoints.length > 0) {
            const target = candidateWaypoints[0];
            return [
                { skill: 'move_to', params: { x: target.position.x, y: target.position.y, z: target.position.z, range: 4 } },
                { skill: 'wait', params: { ms: 4000 } }
            ];
        }

        return [
            { skill: 'move_to', params: { x: state.position.x + 12, y: state.position.y, z: state.position.z + 12, range: 5 } },
            { skill: 'wait', params: { ms: 4000 } }
        ];
    }
}

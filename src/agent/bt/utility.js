import settings from '../settings.js';

export const WEIGHTS = {
    survival: 100,
    ownerCommand: 80,
    activeCombat: 60,
    protectAlly: 55,
    objective: 40,
    gather: 25,
    efficiency: 15,
    explore: 10,
    social: 3,
    buildShelter: 35,
    mineResources: 30,
    craftGear: 28,
};

const RETREAT_HP_THRESHOLD = 6;
const EAT_FOOD_THRESHOLD = 6;
const LOW_ARMOR_THRESHOLD = 3;
const LOW_ARMOR_PCT = 20;
const LOW_LIGHT_THRESHOLD = 7;

export class UtilityScorer {
    /**
     * Builds and ranks the full candidate action list for this tick.
     * Every _score* helper receives the shared `candidates` array and
     * pushes into it directly — nothing returns a separate list that
     * needs merging, so there's no way for a candidate to go missing.
     */
    scoreActions(state, memory) {
        if (!state) return [];

        const candidates = [];

        this._scoreSurvival(state, candidates);
        this._scoreCombat(state, candidates);
        this._scoreAllies(state, candidates);
        this._scoreGoal(state, memory, candidates);
        this._scoreMining(state, candidates);
        this._scoreBuilding(state, candidates);
        // MUST run after _scoreGoal: _scoreGathering's claim-penalty
        // iterates all existing candidates applying 0.1x to gather/buildShelter
        this._scoreGathering(state, memory, candidates);
        this._scoreEfficiency(state, candidates);
        this._scoreExplore(candidates);

        const ranked = candidates.sort((a, b) => b.score - a.score);

        if (settings.bt_log) {
            const summary = ranked
                .map(c => `${c.action}=${c.score.toFixed(1)}${c.target ? `[${c.target}]` : ''}`)
                .join(' | ');
            console.log(`[BT Utility] ${summary}`);
        }

        return ranked;
    }

    _scoreSurvival(state, candidates) {
        if (state.self.hp < RETREAT_HP_THRESHOLD && state.threats.length > 0) {
            const urgency = 1 + (RETREAT_HP_THRESHOLD - state.self.hp) / RETREAT_HP_THRESHOLD;
            candidates.push({ action: 'retreat', score: WEIGHTS.survival * urgency });
        }

        if (state.self.food < EAT_FOOD_THRESHOLD) {
            const hasFood = state.self.inventory.some(i =>
                i.name.includes('apple') || i.name.includes('bread') || i.name.includes('cooked')
                || i.name.includes('steak') || i.name.includes('pork') || i.name === 'golden_carrot'
                || i.name.includes('beetroot') || i.name.includes('potato')
            );
            if (hasFood) {
                candidates.push({ action: 'eat', score: WEIGHTS.survival * 0.8 });
            } else {
                candidates.push({ action: 'gatherFood', score: WEIGHTS.survival * 0.6 });
            }
        }

        if (state.self.armorSlots < LOW_ARMOR_THRESHOLD) {
            const hasArmor = state.self.inventory.some(i =>
                i.name.includes('chestplate') || i.name.includes('leggings')
                || i.name.includes('helmet') || i.name.includes('boots')
            );
            if (hasArmor) {
                candidates.push({ action: 'equipArmor', score: WEIGHTS.survival * 0.5 });
            }
        }

        if (state.self.armorDurabilityPct < LOW_ARMOR_PCT && state.self.armorSlots > 0) {
            const hasSpare = state.self.inventory.some(i =>
                i.name.includes('chestplate') || i.name.includes('leggings')
                || i.name.includes('helmet') || i.name.includes('boots')
            );
            if (hasSpare) {
                candidates.push({ action: 'replaceArmor', score: WEIGHTS.survival * 0.4 });
            }
        }

        if (state.self.inLava) {
            candidates.push({ action: 'escapeLava', score: WEIGHTS.survival * 2 });
        }

        if (state.self.fallDistance > 8) {
            const hasBucket = state.self.inventory.some(i => i.name === 'water_bucket');
            if (hasBucket) {
                candidates.push({ action: 'mlgWaterBucket', score: WEIGHTS.survival * 2 });
            }
        }
    }

    _scoreCombat(state, candidates) {
        if (state.threats.length === 0) return;

        const threat = this._bestThreat(state.threats);
        const winProb = this._estimateFightWinProbability(state.self, threat);

        if (winProb > 0.6) {
            candidates.push({
                action: 'fight',
                score: WEIGHTS.activeCombat * winProb,
                target: threat.id,
                params: { threatName: threat.name },
            });
        } else {
            candidates.push({
                action: 'retreat',
                score: WEIGHTS.activeCombat * (1 - winProb),
            });
        }
    }

    _scoreAllies(state, candidates) {
        for (const ally of state.allies) {
            if (ally.hp < 8 && ally.underThreat) {
                candidates.push({
                    action: 'assist',
                    score: WEIGHTS.protectAlly * (1 - ally.hp / 20),
                    target: ally.id,
                    params: { allyName: ally.name },
                });
            }
        }
    }

    _scoreGoal(state, memory, candidates) {
        if (!memory) return;
        const stack = memory.getGoalStack();
        if (!stack || stack.length === 0) return;

        const goal = stack[0];
        if (!goal || !goal.nextAction) return;

        candidates.push({
            action: goal.nextAction,
            score: WEIGHTS.objective * (goal.priority || 1),
            target: goal.target || null,
            params: goal.params || {},
        });
    }

    _scoreGathering(state, memory, candidates) {
        const need = this._firstUnmetResourceNeed(state, memory?.getGoalStack());
        if (need) {
            candidates.push({
                action: 'gather',
                score: WEIGHTS.gather,
                target: need,
                params: { resource: need },
            });
        }

        const hasTorch = state.self.inventory.some(i => i.name === 'torch');
        if (state.terrain.light < LOW_LIGHT_THRESHOLD && hasTorch) {
            candidates.push({ action: 'placeTorch', score: WEIGHTS.efficiency * 1.2 });
        }

        const hasWood = state.self.inventory.some(i => i.name.includes('log') || i.name.includes('planks'));
        if (!hasWood && state.blocks.nearby.some(b => b.type.includes('log'))) {
            candidates.push({ action: 'gather', score: WEIGHTS.gather * 0.8, target: 'wood' });
        }

        if (state.server?.nearbyClaim) {
            for (const c of candidates) {
                if (c.action === 'gather' || c.action === 'buildShelter') {
                    c.score *= 0.1;
                }
            }
        }
    }

    _scoreEfficiency(state, candidates) {
        if (state.blocks.hazards.length > 0) {
            const nearest = state.blocks.hazards.reduce((a, b) => {
                const da = this._distToPos(state.self.pos, a.pos);
                const db = this._distToPos(state.self.pos, b.pos);
                return da < db ? a : b;
            });
            candidates.push({
                action: 'avoidHazard',
                score: WEIGHTS.survival * 0.6,
                target: nearest.pos,
            });
        }

        const hasTorch = state.self.inventory.some(i => i.name === 'torch');
        const alreadyQueuedTorch = candidates.some(c => c.action === 'placeTorch');

        if (state.terrain.light < LOW_LIGHT_THRESHOLD && !alreadyQueuedTorch) {
            if (hasTorch) {
                candidates.push({ action: 'placeTorch', score: WEIGHTS.efficiency });
            } else if (state.blocks.nearby.some(b => b.type.includes('log'))) {
                candidates.push({ action: 'gatherSticksForTorches', score: WEIGHTS.efficiency * 0.5 });
            }
        }
    }

    _scoreMining(state, candidates) {
        const hasDiamondPick = state.self.inventory.some(i => i.name.includes('diamond') && i.name.includes('pickaxe'));
        const hasIronPick = state.self.inventory.some(i => i.name.includes('iron') && i.name.includes('pickaxe'));
        const hasDiamondArmor = state.self.inventory.some(i => i.name.includes('diamond') && (i.name.includes('chestplate') || i.name.includes('helmet') || i.name.includes('leggings') || i.name.includes('boots')));

        if (!hasDiamondArmor && hasIronPick) {
            const hasTorches = state.self.inventory.some(i => i.name === 'torch');
            if (hasTorches) {
                candidates.push({ action: 'mineForDiamonds', score: WEIGHTS.mineResources * 1.2 });
            } else {
                candidates.push({ action: 'gatherSticksForTorches', score: WEIGHTS.mineResources * 0.5 });
            }
        }

        if (!hasDiamondPick && state.self.inventory.some(i => i.name.includes('diamond'))) {
            candidates.push({ action: 'craftDiamondPick', score: WEIGHTS.craftGear * 1.5 });
        }

        const hasOres = state.self.inventory.some(i => i.name.includes('ore') || i.name.includes('raw_'));
        if (hasOres && !hasIronPick) {
            candidates.push({ action: 'smeltOres', score: WEIGHTS.craftGear });
        }
    }

    _scoreBuilding(state, candidates) {
        const hasChest = state.self.inventory.some(i => i.name === 'chest');
        const hasBed = state.self.inventory.some(i => i.name.includes('bed'));
        const hasCraftingTable = state.self.inventory.some(i => i.name === 'crafting_table');
        const hasFurnace = state.self.inventory.some(i => i.name === 'furnace');

        const noBaseItems = !hasChest || !hasBed || !hasCraftingTable || !hasFurnace;
        const hasWood = state.self.inventory.some(i => i.name.includes('log') || i.name.includes('planks'));

        if (noBaseItems && hasWood) {
            candidates.push({ action: 'buildShelter', score: WEIGHTS.buildShelter });
        } else if (noBaseItems) {
            candidates.push({ action: 'gatherWood', score: WEIGHTS.gather * 0.8 });
        }
    }

    _scoreExplore(candidates) {
        const nothingUrgent = candidates.length === 0
            || candidates.every(c => c.score < WEIGHTS.objective);

        if (nothingUrgent) {
            candidates.push({ action: 'explore', score: WEIGHTS.explore });
        }
    }

    _bestThreat(threats) {
        return threats.reduce((a, b) => {
            const scoreA = (a.lineOfSight ? 2 : 1) * (1 / Math.max(a.distance, 1)) * (a.groupSize || 1);
            const scoreB = (b.lineOfSight ? 2 : 1) * (1 / Math.max(b.distance, 1)) * (b.groupSize || 1);
            return scoreA > scoreB ? a : b;
        });
    }

    _estimateFightWinProbability(self, enemy) {
        const hpRatio = Math.min(self.hp / (enemy.hp || 20), 2);
        const armorScore = self.armorSlots / 4;
        const numRatio = 1 / Math.max(1, enemy.groupSize || 1);
        const losPenalty = enemy.lineOfSight ? 1 : 1.2;
        return Math.min(1, Math.max(0, (0.4 * hpRatio + 0.3 * armorScore + 0.3 * numRatio) * losPenalty));
    }

    _firstUnmetResourceNeed(state, goalStack) {
        if (!goalStack || goalStack.length === 0) return null;

        for (const step of goalStack) {
            if (step.need && !step.met) {
                const has = state.self.inventory.find(i => i.name === step.need);
                if (!has || has.count < (step.qty || 1)) {
                    return step.need;
                }
            }
        }
        return null;
    }

    _distToPos(a, b) {
        const dx = (a.x ?? a[0]) - (b[0]);
        const dy = (a.y ?? a[1]) - (b[1]);
        const dz = (a.z ?? a[2]) - (b[2]);
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
}

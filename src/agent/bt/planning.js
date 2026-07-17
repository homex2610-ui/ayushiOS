
const RECIPES = {
    wooden_pickaxe: [
        { id: 'gather_wood', need: 'oak_log', qty: 3, from: 'gather', nextAction: 'gather', target: 'wood' },
        { id: 'craft_planks', need: 'oak_planks', qty: 4, from: 'craft', nextAction: 'craft', params: { recipe: 'oak_planks', qty: 4 } },
        { id: 'craft_sticks', need: 'stick', qty: 2, from: 'craft', nextAction: 'craft', params: { recipe: 'stick', qty: 2 } },
        { id: 'craft_wooden_pickaxe', need: 'wooden_pickaxe', qty: 1, from: 'craft', nextAction: 'craft', params: { recipe: 'wooden_pickaxe', qty: 1 } },
    ],

    stone_pickaxe: [
        { id: 'craft_sticks', need: 'stick', qty: 2, from: 'craft', nextAction: 'craft', params: { recipe: 'stick', qty: 2 } },
        { id: 'gather_cobblestone', need: 'cobblestone', qty: 3, from: 'gather', nextAction: 'gather', target: 'cobblestone' },
        { id: 'craft_stone_pickaxe', need: 'stone_pickaxe', qty: 1, from: 'craft', nextAction: 'craft', params: { recipe: 'stone_pickaxe', qty: 1 } },
    ],

    iron_gear: [
        { id: 'gather_wood', need: 'oak_log', qty: 5, from: 'gather', nextAction: 'gather', target: 'wood' },
        { id: 'craft_planks', need: 'oak_planks', qty: 8, from: 'craft', nextAction: 'craft', params: { recipe: 'oak_planks', qty: 8 } },
        { id: 'craft_sticks', need: 'stick', qty: 4, from: 'craft', nextAction: 'craft', params: { recipe: 'stick', qty: 4 } },
        { id: 'craft_wooden_pickaxe', need: 'wooden_pickaxe', qty: 1, from: 'craft', nextAction: 'craft', params: { recipe: 'wooden_pickaxe', qty: 1 } },
        { id: 'gather_cobblestone', need: 'cobblestone', qty: 8, from: 'gather', nextAction: 'gather', target: 'cobblestone' },
        { id: 'craft_stone_pickaxe', need: 'stone_pickaxe', qty: 1, from: 'craft', nextAction: 'craft', params: { recipe: 'stone_pickaxe', qty: 1 } },
        { id: 'gather_iron_ore', need: 'iron_ore', qty: 6, from: 'mine_iron', nextAction: 'gather', target: 'iron' },
        { id: 'craft_furnace', need: 'furnace', qty: 1, from: 'craft', nextAction: 'craft', params: { recipe: 'furnace', qty: 1 } },
        { id: 'smelt_iron', need: 'iron_ingot', qty: 6, from: 'smelt', nextAction: 'smelt', params: { item: 'iron_ingot', qty: 6 } },
        { id: 'craft_iron_sword', need: 'iron_sword', qty: 1, from: 'craft', nextAction: 'craft', params: { recipe: 'iron_sword', qty: 1 }, requires: ['iron_ingot'] },
        { id: 'craft_iron_pickaxe', need: 'iron_pickaxe', qty: 1, from: 'craft', nextAction: 'craft', params: { recipe: 'iron_pickaxe', qty: 1 }, requires: ['iron_ingot'] },
    ],

    diamond_gear: [
        { id: 'gather_wood', need: 'oak_log', qty: 8, from: 'gather', nextAction: 'gather', target: 'wood' },
        { id: 'craft_planks', need: 'oak_planks', qty: 12, from: 'craft', nextAction: 'craft', params: { recipe: 'oak_planks', qty: 12 } },
        { id: 'craft_iron_pickaxe', need: 'iron_pickaxe', qty: 1, from: 'craft', nextAction: 'craft', params: { recipe: 'iron_pickaxe', qty: 1 }, requires: ['iron_ingot'] },
        { id: 'gather_diamond', need: 'diamond', qty: 3, from: 'mine_diamond', nextAction: 'gather', target: 'diamond' },
        { id: 'craft_diamond_sword', need: 'diamond_sword', qty: 1, from: 'craft', nextAction: 'craft', params: { recipe: 'diamond_sword', qty: 1 } },
        { id: 'craft_diamond_pickaxe', need: 'diamond_pickaxe', qty: 1, from: 'craft', nextAction: 'craft', params: { recipe: 'diamond_pickaxe', qty: 1 } },
    ],

    food_setup: [
        { id: 'gather_wood', need: 'oak_log', qty: 5, from: 'gather', nextAction: 'gather', target: 'wood' },
        { id: 'craft_planks', need: 'oak_planks', qty: 8, from: 'craft', nextAction: 'craft', params: { recipe: 'oak_planks', qty: 8 } },
        { id: 'craft_wooden_hoe', need: 'wooden_hoe', qty: 1, from: 'craft', nextAction: 'craft', params: { recipe: 'wooden_hoe', qty: 1 } },
        { id: 'find_seeds', need: 'wheat_seeds', qty: 3, from: 'gather', nextAction: 'gather', target: 'wheat_seeds' },
        { id: 'farm_wheat', need: 'wheat', qty: 20, from: 'farm', nextAction: 'farm', params: { crop: 'wheat', qty: 20 } },
        { id: 'craft_bread', need: 'bread', qty: 4, from: 'craft', nextAction: 'craft', params: { recipe: 'bread', qty: 4 } },
    ],

    shelter: [
        { id: 'gather_wood', need: 'oak_log', qty: 10, from: 'gather', nextAction: 'gather', target: 'wood' },
        { id: 'craft_planks', need: 'oak_planks', qty: 20, from: 'craft', nextAction: 'craft', params: { recipe: 'oak_planks', qty: 20 } },
        { id: 'craft_door', need: 'oak_door', qty: 1, from: 'craft', nextAction: 'craft', params: { recipe: 'oak_door', qty: 1 } },
        { id: 'build_shelter', need: 'shelter', qty: 1, from: 'build', nextAction: 'buildShelter', params: { size: 5 } },
    ],

    torch_run: [
        { id: 'gather_coal', need: 'coal', qty: 4, from: 'gather', nextAction: 'gather', target: 'coal' },
        { id: 'gather_sticks', need: 'stick', qty: 4, from: 'craft', nextAction: 'craft', params: { recipe: 'stick', qty: 4 } },
        { id: 'craft_torches', need: 'torch', qty: 16, from: 'craft', nextAction: 'craft', params: { recipe: 'torch', qty: 16 } },
    ],
};

export class Planner {
    getRecipe(goalName) {
        return RECIPES[goalName] || null;
    }

    getAllRecipeNames() {
        return Object.keys(RECIPES);
    }

    buildGoalStack(goalName, inventory) {
        const steps = RECIPES[goalName];
        if (!steps) return [];

        const stack = [];
        for (const step of steps) {
            const satisfied = this._isStepSatisfied(step, inventory);
            if (!satisfied) {
                stack.push({ ...step, met: false });
            }
        }
        return stack;
    }

    nextStep(goalStack, inventory) {
        if (!goalStack || goalStack.length === 0) return null;
        for (const step of goalStack) {
            const satisfied = this._isStepSatisfied(step, inventory);
            if (!satisfied) return step;
        }
        return null;
    }

    isSatisfied(step, inventory) {
        return this._isStepSatisfied(step, inventory);
    }

    _isStepSatisfied(step, inventory) {
        if (step.need === 'shelter') return false;
        if (!inventory || inventory.length === 0) return false;
        const item = inventory.find(i => i.name === step.need);
        if (!item) return false;
        return item.count >= (step.qty || 1);
    }
}

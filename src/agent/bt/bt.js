import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import settings from '../settings.js';

const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';
const RUNNING = 'RUNNING';

async function gotoWithTimeout(bot, goal, timeoutMs) {
    const timer = setTimeout(() => {
        try { bot.pathfinder?.setGoal?.(null); } catch (_) {}
        try { bot.pathfinder?.stop?.(); } catch (_) {}
    }, timeoutMs);
    try {
        await bot.pathfinder.goto(goal);
    } finally {
        clearTimeout(timer);
    }
}

export class Action {
    constructor(fn) {
        this.fn = fn;
    }
    tick(ctx) {
        try {
            return this.fn(ctx) ? SUCCESS : FAILURE;
        } catch { return FAILURE; }
    }
    reset() {}
}

export class AsyncAction {
    constructor(fn) {
        this.fn = fn;
        this.promise = null;
        this.done = false;
        this.ok = false;
        this._started = false;
        this._capturedGen = 0;
    }
    tick(ctx) {
        // If a new BT generation started (task was replaced), this promise is orphaned
        if (this._started && ctx._btGen !== undefined && this._capturedGen !== ctx._btGen) {
            this.promise = null;
            this.done = true;
            this.ok = false;
            return FAILURE;
        }
        if (this.done) return this.ok ? SUCCESS : FAILURE;
        if (ctx.bot.interrupt_code && this._started) {
            this.done = true;
            this.ok = false;
            return FAILURE;
        }
        if (!this._started) {
            this._started = true;
            this._capturedGen = ctx._btGen || 0;
            ctx.bot.interrupt_code = false;
            this.promise = this.fn(ctx)
                .then(() => { if (!this.done) { this.done = true; this.ok = true; } })
                .catch(() => { if (!this.done) { this.done = true; this.ok = false; } });
        }
        return RUNNING;
    }
    reset() {
        this.promise = null;
        this.done = false;
        this.ok = false;
        this._started = false;
        this._capturedGen = 0;
    }
}

export class Condition {
    constructor(fn) {
        this.fn = fn;
    }
    tick(ctx) {
        try {
            return this.fn(ctx) ? SUCCESS : FAILURE;
        } catch { return FAILURE; }
    }
    reset() {}
}

export class Sequence {
    constructor(children) {
        this.children = children;
        this.index = 0;
    }
    tick(ctx) {
        while (this.index < this.children.length) {
            const status = this.children[this.index].tick(ctx);
            if (status === RUNNING) return RUNNING;
            if (status === FAILURE) { this.index = 0; return FAILURE; }
            this.index++;
        }
        this.index = 0;
        return SUCCESS;
    }
    reset() {
        this.index = 0;
        for (const c of this.children) c.reset();
    }
}

export class Selector {
    constructor(children) {
        this.children = children;
        this.index = 0;
    }
    tick(ctx) {
        while (this.index < this.children.length) {
            const status = this.children[this.index].tick(ctx);
            if (status === SUCCESS) { this.index = 0; return SUCCESS; }
            if (status === RUNNING) return RUNNING;
            this.index++;
        }
        this.index = 0;
        return FAILURE;
    }
    reset() {
        this.index = 0;
        for (const c of this.children) c.reset();
    }
}

export class RetryOnce {
    constructor(child) {
        this.child = child;
        this.tried = false;
    }
    tick(ctx) {
        const status = this.child.tick(ctx);
        if (status === FAILURE && !this.tried) {
            this.tried = true;
            this.child.reset();
            return RUNNING;
        }
        if (status === SUCCESS || status === FAILURE) {
            this.tried = false;
        }
        return status;
    }
    reset() {
        this.tried = false;
        this.child.reset();
    }
}

export class Succeeder {
    constructor(child) {
        this.child = child;
    }
    tick(ctx) {
        this.child.tick(ctx);
        return SUCCESS;
    }
    reset() { this.child.reset(); }
}

export class Inverter {
    constructor(child) {
        this.child = child;
    }
    tick(ctx) {
        const status = this.child.tick(ctx);
        if (status === RUNNING) return RUNNING;
        return status === SUCCESS ? FAILURE : SUCCESS;
    }
    reset() { this.child.reset(); }
}

export class BehaviorTree {
    constructor() {
        this.currentTask = null;
        this._generation = 0;
    }

    checkHardInterrupts(state) {
        if (!state) return null;

        if (state.self.inLava) {
            return { action: 'escapeLava', score: 999 };
        }

        if (state.self.fallDistance > 10) {
            const hasBucket = state.self.inventory.some(i => i.name === 'water_bucket');
            if (hasBucket) return { action: 'mlgWaterBucket', score: 999 };
        }

        if (state.self.hp <= 2) {
            return { action: 'emergencyHeal', score: 999 };
        }

        return null;
    }

    build(candidate, state) {
        this._generation++;
        if (!candidate || !candidate.action) return null;

        switch (candidate.action) {
            case 'fight': return this._buildFight(candidate, state);
            case 'retreat': return this._buildRetreat(candidate, state);
            case 'eat': return this._buildEat(candidate);
            case 'gather': return this._buildGather(candidate, state);
            case 'gatherFood': return this._buildGatherFood(state);
            case 'gatherSticksForTorches': return this._buildGatherSticks();
            case 'equipArmor': return new Action(ctx => this._equipBestArmor(ctx.bot));
            case 'replaceArmor': return new Action(ctx => this._equipBestArmor(ctx.bot));
            case 'escapeLava': return this._buildEscapeLava();
            case 'mlgWaterBucket': return this._buildMLGWaterBucket();
            case 'placeTorch': return this._buildPlaceTorch();
            case 'avoidHazard': return this._buildAvoidHazard(candidate);
            case 'assist': return this._buildAssist(candidate, state);
            case 'explore': return this._buildExplore(state);
            case 'mineForDiamonds': return this._buildMineDiamonds(state);
            case 'craftDiamondPick': return this._buildCraftDiamondPick();
            case 'smeltOres': return this._buildSmeltOres();
            case 'buildShelter': return this._buildShelter(state);
            case 'gatherWood': return this._buildGatherWood();
            case 'emergencyHeal': return this._buildEmergencyHeal();
            case 'stashLoot': return this._buildStashLoot();
            default:
                if (settings.bt_log) console.warn(`[BT] No builder for action: ${candidate.action}`);
                return new Action(() => false);
        }
    }

    isDone(state) {
        return this.currentTask === null;
    }

    _buildFight(candidate, state) {
        const targetId = candidate.target;
        const target = state.threats.find(t => t.id === targetId) || state.threats[0];
        if (!target) return new Action(() => false);

        const enemyPos = target.pos;
        const fightAction = new AsyncAction(async (ctx) => {
            ctx.bot.modes.pause('combat');
            ctx.bot.modes.pause('cowardice');
            ctx.bot.modes.pause('self_defense'); // prevent mode-defense from fighting BT over the pathfinder goal
            ctx.bot.modes.pause('pvp');
            await skills.equipHighestAttack(ctx.bot);
            const entity = ctx.bot.nearestEntity(e => e.id === targetId || (e.name === target.name && ctx.bot.entity.position.distanceTo(e.position) < 20));
            if (!entity) { ctx.bot.modes.unPauseAll(); return false; }

            const pf = await import('mineflayer-pathfinder');
            // CJS interop: the module may land at .default or spread across the namespace
            const pfm = pf.default ?? pf;
            const PFGoals = pfm.goals ?? pf.goals;
            ctx.bot.pathfinder.setMovements(skills.safeMovements(ctx.bot, { destructive: true }));
            let lastPathAt = 0;
            while (!ctx.bot.interrupt_code && ctx.bot.entity.position.distanceTo(entity.position) < 20 && entity.isValid) {
            if (ctx.bot.entity.position.distanceTo(entity.position) >= 3) {
            // Re-path at most every 1.5s — constantly resetting GoalFollow is what
            // caused "The goal was changed before it could be completed" spam.
            if (Date.now() - lastPathAt > 1500) {
                lastPathAt = Date.now();
                try { await gotoWithTimeout(ctx.bot, new PFGoals.GoalFollow(entity, 2), 8000); }
                catch (err) { console.warn(`[BT] fight chase failed: ${err.message}`); }
            } else {
                await new Promise(r => setTimeout(r, 150));
            }
            }
            if (ctx.bot.entity.position.distanceTo(entity.position) <= 2.5 && entity.name !== 'creeper') {
                ctx.bot.pvp.attack(entity);
                await new Promise(r => setTimeout(r, 300));
            } else if (entity.name === 'creeper' && ctx.bot.entity.position.distanceTo(entity.position) <= 3) {
                // Creeper about to blow — back off instead of trading damage.
                try { await gotoWithTimeout(ctx.bot, new PFGoals.GoalInvert(new PFGoals.GoalFollow(entity, 4)), 3000); }
                catch (err) { /* best effort */ }
                continue;
            }
                await new Promise(r => setTimeout(r, 200));
            }
            ctx.bot.pvp.stop();
            ctx.bot.modes.unPauseAll();
            return true;
        });

        return new Sequence([
            new Action(ctx => { ctx.bot.pathfinder.stop(); return true; }),
            fightAction,
        ]);
    }

    _buildRetreat(candidate, state) {
        return new AsyncAction(async (ctx) => {
            ctx.bot.modes.pause('cowardice');
            ctx.bot.pathfinder.stop();
            ctx.bot.pvp.stop();
            const pos = ctx.bot.entity.position;
            const retreatDir = { x: pos.x + (pos.x > 0 ? 10 : -10), y: pos.y, z: pos.z + (pos.z > 0 ? 10 : -10) };
            try {
                const pf = await import('mineflayer-pathfinder');
            const pfx = pf.default ?? pf; const PFG = pfx.goals ?? pf.goals;
                ctx.bot.pathfinder.setMovements(new pfx.Movements(ctx.bot));
                await gotoWithTimeout(ctx.bot, new PFG.GoalBlock(retreatDir.x, retreatDir.y, retreatDir.z), 8000);
            } catch (err) { console.warn(`[BT] retreat failed: ${err.message}`); }
            ctx.bot.modes.unPauseAll();
            return true;
        });
    }

    _buildEat(candidate) {
        return new AsyncAction(async (ctx) => {
            try {
                await skills.eatBestFood(ctx.bot);
                return true;
            } catch { return false; }
        });
    }

    _buildGather(candidate, state) {
        const resource = candidate.params?.resource || candidate.target || 'wood';
        const blockType = this._resourceToBlock(resource);

        return new Sequence([
            new Action(ctx => { ctx.bot.pathfinder.stop(); return true; }),
            new AsyncAction(async (ctx) => {
                try {
                    const found = world.getNearestBlocks(ctx.bot, [blockType], 32, 1);
                    if (!found || found.length === 0) return false;
                    await skills.collectBlock(ctx.bot, blockType, 10);
                    return !ctx.bot.interrupt_code;
                } catch { return false; }
            }),
        ]);
    }

    _buildGatherFood(state) {
        return new Sequence([
            new Action(ctx => { ctx.bot.pathfinder.stop(); return true; }),
            new Selector([
                new AsyncAction(async (ctx) => {
                    const animals = world.getNearbyEntities(ctx.bot, 12)
                        .filter(e => ['cow', 'pig', 'chicken', 'sheep', 'rabbit'].includes(e.name));
                    if (animals.length === 0) return false;
                    await skills.equipHighestAttack(ctx.bot);
                    for (const animal of animals) {
                        if (ctx.bot.interrupt_code) break;
                        ctx.bot.pvp.attack(animal);
                        await new Promise(r => setTimeout(r, 1000));
                    }
                    ctx.bot.pvp.stop();
                    return true;
                }),
                new AsyncAction(async (ctx) => {
                    const crops = ['wheat', 'carrots', 'potatoes', 'beetroots'];
                    for (const crop of crops) {
                        const found = world.getNearestBlocks(ctx.bot, [crop], 12, 3);
                        if (found && found.length > 0) {
                            await skills.collectBlock(ctx.bot, crop, 5);
                            return !ctx.bot.interrupt_code;
                        }
                    }
                    return false;
                }),
            ]),
        ]);
    }

    _buildGatherSticks() {
        return new AsyncAction(async (ctx) => {
            const logs = world.getNearestBlocks(ctx.bot, ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'], 16, 1);
            if (!logs || logs.length === 0) return false;
            try { await skills.collectBlock(ctx.bot, logs[0].name, 3); return true; }
            catch { return false; }
        });
    }

    _buildEscapeLava() {
        return new AsyncAction(async (ctx) => {
            ctx.bot.pathfinder.stop();
            ctx.bot.clearControlStates();
            const pos = ctx.bot.entity.position;
            const escapeY = Math.min(pos.y + 3, ctx.bot.game?.dimension?.height ?? 320);
            try {
                const pf = await import('mineflayer-pathfinder');
            const pfx = pf.default ?? pf; const PFG = pfx.goals ?? pf.goals;
                ctx.bot.pathfinder.setMovements(new pfx.Movements(ctx.bot));
                await gotoWithTimeout(ctx.bot, new PFG.GoalBlock(pos.x, escapeY, pos.z), 8000);
            } catch (err) { console.warn(`[BT] lava escape failed: ${err.message}`); }
            return true;
        });
    }

    _buildMLGWaterBucket() {
        return new AsyncAction(async (ctx) => {
            try {
                await skills.mlgWaterBucket(ctx.bot);
                return true;
            } catch { return false; }
        });
    }

    _buildPlaceTorch() {
        return new AsyncAction(async (ctx) => {
            try {
                const pos = world.getPosition(ctx.bot);
                await skills.placeBlock(ctx.bot, 'torch', pos.x, pos.y, pos.z, 'bottom', true);
                return true;
            } catch { return false; }
        });
    }

    _buildAvoidHazard(candidate) {
        const hazardPos = candidate.target;
        if (!hazardPos) return new Action(() => false);
        return new AsyncAction(async (ctx) => {
            ctx.bot.pathfinder.stop();
            const away = {
                x: ctx.bot.entity.position.x + (ctx.bot.entity.position.x - hazardPos[0]) * 2,
                y: ctx.bot.entity.position.y,
                z: ctx.bot.entity.position.z + (ctx.bot.entity.position.z - hazardPos[2]) * 2,
            };
            try {
                const pf = await import('mineflayer-pathfinder');
            const pfx = pf.default ?? pf; const PFG = pfx.goals ?? pf.goals;
                ctx.bot.pathfinder.setMovements(new pfx.Movements(ctx.bot));
                await gotoWithTimeout(ctx.bot, new PFG.GoalBlock(away.x, away.y, away.z), 10000);
            } catch (err) { console.warn(`[BT] hazard avoid failed: ${err.message}`); }
            return true;
        });
    }

    _buildAssist(candidate, state) {
        const targetId = candidate.target;
        const ally = state.allies.find(a => a.id === targetId);
        if (!ally) return new Action(() => false);

        return new Sequence([
            new AsyncAction(async (ctx) => {
                try {
                    const pf = await import('mineflayer-pathfinder');
            const pfx = pf.default ?? pf; const PFG = pfx.goals ?? pf.goals;
                    ctx.bot.pathfinder.setMovements(new pfx.Movements(ctx.bot));
                    await gotoWithTimeout(ctx.bot, new PFG.GoalNear(ally.pos.x, ally.pos.y, ally.pos.z, 3), 15000);
                } catch (err) { console.warn(`[BT] assist goto failed: ${err.message}`); }
                return true;
            }),
            new AsyncAction(async (ctx) => {
                try {
                    await skills.defendSelf(ctx.bot, 12);
                    return true;
                } catch { return false; }
            }),
        ]);
    }

    _buildExplore(state) {
        const pos = state.self.pos;
        const angle = Math.random() * Math.PI * 2;
        const dist = 20 + Math.random() * 30;
        const target = {
            x: Math.floor(pos.x + Math.cos(angle) * dist),
            y: Math.floor(pos.y),
            z: Math.floor(pos.z + Math.sin(angle) * dist),
        };

        return new Sequence([
            new AsyncAction(async (ctx) => {
                try {
                    const pf = await import('mineflayer-pathfinder');
            const pfx = pf.default ?? pf; const PFG = pfx.goals ?? pf.goals;
                    ctx.bot.pathfinder.setMovements(new pfx.Movements(ctx.bot));
                    await gotoWithTimeout(ctx.bot, new PFG.GoalNear(target.x, target.y, target.z, 5), 15000);
                } catch (err) { console.warn(`[BT] explore goto failed: ${err.message}`); }
                return true;
            }),
        ]);
    }

    _buildEmergencyHeal() {
        return new AsyncAction(async (ctx) => {
            try {
                await skills.eatBestFood(ctx.bot);
                return true;
            } catch { return false; }
        });
    }

    _buildStashLoot() {
        // Deposit loot at the nearest chest while keeping survival essentials.
        // Uses the InventoryManager when available (it knows keep-rules +
        // remembered chest positions); falls back to raw skills otherwise.
        return new AsyncAction(async (ctx) => {
            try {
                const im = ctx.agent?.inventoryManager;
                if (im) {
                    const summary = await im.depositLoot();
                    await im.compact({ sort: true });
                    return summary !== 'no chest available';
                }
                // Fallback: deposit everything except a few keeps
                const chest = ctx.bot.findBlock({ matching: b => b.name === 'chest' || b.name === 'barrel', maxDistance: 48 });
                if (!chest) return false;
                const pf = await import('mineflayer-pathfinder');
                const pfx = pf.default ?? pf; const PFG = pfx.goals ?? pf.goals;
                ctx.bot.pathfinder.setMovements(skills.safeMovements(ctx.bot));
                await gotoWithTimeout(ctx.bot, new PFG.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2), 20000);
                const container = await ctx.bot.openContainer(chest);
                for (const item of [...ctx.bot.inventory.items()]) {
                    if (/pickaxe|sword|axe|shovel|torch|food|cooked|raw_|bucket/.test(item.name)) continue;
                    try { await container.deposit(item.type, null, item.count); } catch (_) {}
                }
                await container.close();
                return true;
            } catch { return false; }
        });
    }

    _buildMineDiamonds(state) {
        return new Sequence([
            new Action(ctx => { ctx.bot.pathfinder.stop(); return true; }),
            new AsyncAction(async (ctx) => {
                try {
                    await skills.equipHighestAttack(ctx.bot);
                    const pf = await import('mineflayer-pathfinder');
            const pfx = pf.default ?? pf; const PFG = pfx.goals ?? pf.goals;
                    ctx.bot.pathfinder.setMovements(new pfx.Movements(ctx.bot));
                    const targetY = Math.max(0, ctx.bot.entity.position.y - 15);
                    await gotoWithTimeout(ctx.bot, new PFG.GoalBlock(ctx.bot.entity.position.x, targetY, ctx.bot.entity.position.z), 20000);
                    await skills.collectBlock(ctx.bot, 'diamond_ore', 8);
                    return !ctx.bot.interrupt_code;
                } catch { return false; }
            }),
        ]);
    }

    _buildCraftDiamondPick() {
        return new AsyncAction(async (ctx) => {
            try {
                const ok = await skills.craftRecipe(ctx.bot, 'diamond_pickaxe', 1);
                if (!ok) return false;
                const pick = ctx.bot.inventory.findInventoryItem('diamond_pickaxe');
                if (pick) await ctx.bot.equip(pick, 'hand');
                return true;
            } catch { return false; }
        });
    }

    _buildSmeltOres() {
        return new Sequence([
            new Action(ctx => { ctx.bot.pathfinder.stop(); return true; }),
            new AsyncAction(async (ctx) => {
                try {
                    const furnace = ctx.bot.findBlock({ matching: b => b.name === 'furnace', maxDistance: 6 });
                    if (!furnace) return false;
                    await ctx.bot.lookAt(furnace.position.offset(0.5, 0.5, 0.5), true);
                    const rawIron = ctx.bot.inventory.findInventoryItem('raw_iron');
                    const coal = ctx.bot.inventory.findInventoryItem('coal');
                    if (rawIron && coal) {
                        await ctx.bot.smelt(rawIron.type, coal.type, 1);
                    }
                    return true;
                } catch { return false; }
            }),
        ]);
    }

    _buildShelter(state) {
        return new Sequence([
            new Action(ctx => { ctx.bot.pathfinder.stop(); return true; }),
            new AsyncAction(async (ctx) => {
                try {
                    const pos = ctx.bot.entity.position;
                    const pf = await import('mineflayer-pathfinder');
            const pfx = pf.default ?? pf; const PFG = pfx.goals ?? pf.goals;
                    const chest = ctx.bot.findBlock({ matching: b => b.name === 'chest', maxDistance: 10 });
                    if (chest) {
                        await gotoWithTimeout(ctx.bot, new PFG.GoalNear(chest.position.x, chest.position.y, chest.position.z, 2), 15000);
                        return true;
                    }
                    const below = ctx.bot.blockAt({ x: Math.floor(pos.x), y: Math.floor(pos.y) - 1, z: Math.floor(pos.z) });
                    if (!below || below.name === 'air') return false;
                    await skills.placeBlock(ctx.bot, 'crafting_table', Math.floor(pos.x) + 1, Math.floor(pos.y), Math.floor(pos.z), 'bottom', true);
                    await skills.placeBlock(ctx.bot, 'chest', Math.floor(pos.x) + 2, Math.floor(pos.y), Math.floor(pos.z), 'bottom', true);
                    await skills.placeBlock(ctx.bot, 'furnace', Math.floor(pos.x) - 1, Math.floor(pos.y), Math.floor(pos.z), 'bottom', true);
                    await skills.placeBlock(ctx.bot, 'bed', Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z) + 1, 'bottom', true);
                    return true;
                } catch { return false; }
            }),
        ]);
    }

    _buildGatherWood() {
        return new Sequence([
            new Action(ctx => { ctx.bot.pathfinder.stop(); return true; }),
            new AsyncAction(async (ctx) => {
                try {
                    await skills.equipHighestAttack(ctx.bot);
                    const log = world.getNearestBlocks(ctx.bot, ['oak_log', 'birch_log', 'spruce_log'], 24, 1);
                    if (!log || log.length === 0) return false;
                    await skills.collectBlock(ctx.bot, log[0].name, 8);
                    return !ctx.bot.interrupt_code;
                } catch { return false; }
            }),
        ]);
    }

    _equipBestArmor(bot) {
        const armors = bot.inventory.items().filter(i =>
            i.name.includes('chestplate') || i.name.includes('leggings')
            || i.name.includes('helmet') || i.name.includes('boots')
        );
        if (armors.length === 0) return false;
        for (const armor of armors) {
            const slot = armor.name.includes('helmet') ? 'head'
                : armor.name.includes('chestplate') ? 'torso'
                : armor.name.includes('leggings') ? 'legs'
                : armor.name.includes('boots') ? 'feet' : 'hand';
            try { bot.equip(armor, slot); } catch {}
        }
        return true;
    }

    _resourceToBlock(resource) {
        const map = {
            'wood': 'oak_log',
            'stone': 'stone',
            'cobblestone': 'stone',
            'iron': 'iron_ore',
            'coal': 'coal_ore',
            'diamond': 'diamond_ore',
            'food': 'wheat',
        };
        return map[resource] || resource;
    }
}

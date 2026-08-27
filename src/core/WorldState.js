export class WorldState {
    constructor(bot) {
        this.bot = bot;
        this.tick = 0;
        this._snapshot = null;
    }

    refresh() {
        const bot = this.bot;
        if (!bot?.entity) {
            this._snapshot = null;
            return null;
        }

        this.tick++;
        const pos = bot.entity.position;

        const below = bot.blockAt(pos.offset(0, -1, 0));
        const headBlock = bot.blockAt(pos.offset(0, 1, 0));

        const hotbarItems = [];
        for (let i = 36; i <= 44; i++) {
            const item = bot.inventory?.slots[i];
            if (item) {
                hotbarItems.push({
                    slot: i - 36,
                    name: item.name,
                    count: item.count,
                    displayName: item.displayName,
                });
            }
        }

        const nearbyEntities = [];
        if (bot.entities) {
            for (const [id, entity] of Object.entries(bot.entities)) {
                if (Number(id) === bot.entity.id) continue;
                const dist = entity.position?.distanceTo(pos);
                nearbyEntities.push({
                    id,
                    name: entity.name || entity.type,
                    type: entity.type,
                    position: entity.position ? { x: entity.position.x, y: entity.position.y, z: entity.position.z } : null,
                    distance: dist,
                    mobType: entity.type === 'mob' ? entity.name : null,
                });
            }
        }

        const sb = bot.scoreboard?.sidebar;
        const scoreboard = sb ? {
            title: sb.title ?? null,
            lines: (sb.items || []).map(i => ({
                name: i.name,
                value: i.value
            }))
        } : null;

        const window = bot.currentWindow ? {
            title: bot.currentWindow.title?.toString?.()?.replace(/§./g, '') || null,
            type: bot.currentWindow.type,
            slotCount: bot.currentWindow.slots?.length || 0,
            slots: bot.currentWindow.slots?.map((s, i) => s ? {
                slot: i,
                name: s.name,
                count: s.count,
                displayName: s.displayName?.replace(/§./g, '') || s.name,
            } : null).filter(Boolean) || []
        } : null;

        this._snapshot = {
            tick: this.tick,
            position: {
                x: Number(pos.x.toFixed(2)),
                y: Number(pos.y.toFixed(2)),
                z: Number(pos.z.toFixed(2)),
                yaw: bot.entity.yaw,
                pitch: bot.entity.pitch,
            },
            dimension: bot.game?.dimension || null,
            gamemode: bot.game?.gameMode || null,
            health: Math.round(bot.health),
            hunger: Math.round(bot.food),
            oxygen: bot.oxygenLevel,
            isInWater: bot.entity?.isInWater || false,
            isCollidedHorizontally: bot.entity?.isCollidedHorizontally || false,
            onGround: bot.entity?.onGround || false,
            velocity: bot.entity?.velocity ? {
                x: Number(bot.entity.velocity.x.toFixed(3)),
                y: Number(bot.entity.velocity.y.toFixed(3)),
                z: Number(bot.entity.velocity.z.toFixed(3)),
            } : null,
            belowBlock: below ? { name: below.name, type: below.type } : null,
            headBlock: headBlock ? { name: headBlock.name, type: headBlock.type } : null,
            inventory: {
                counts: this._getInventoryCounts(bot),
                totalSlots: bot.inventory?.slots?.length || 0,
                hotbar: hotbarItems,
                equipment: {
                    helmet: bot.inventory?.slots[5]?.name || null,
                    chestplate: bot.inventory?.slots[6]?.name || null,
                    leggings: bot.inventory?.slots[7]?.name || null,
                    boots: bot.inventory?.slots[8]?.name || null,
                    mainHand: bot.heldItem?.name || null,
                    offHand: bot.inventory?.slots[45]?.name || null,
                },
            },
            entities: {
                players: nearbyEntities.filter(e => e.type === 'player'),
                mobs: nearbyEntities.filter(e => e.type === 'mob'),
                items: nearbyEntities.filter(e => e.type === 'object'),
                total: nearbyEntities.length,
            },
            scoreboard,
            window,
            time: {
                age: bot.time?.age || 0,
                timeOfDay: bot.time?.timeOfDay || 0,
                label: this._getTimeLabel(bot),
            },
            weather: bot.thunderState > 0 ? 'thunder' : bot.rainState > 0 ? 'rain' : 'clear',
            server: {
                brand: bot.game?.serverBrand || null,
                brandRaw: bot.game?.serverBrandRaw || null,
            },
            ping: bot.player?.ping ?? null,
        };

        return this._snapshot;
    }

    get snapshot() {
        if (!this._snapshot) this.refresh();
        return this._snapshot;
    }

    get position() { return this.snapshot?.position || null; }
    get inventory() { return this.snapshot?.inventory || null; }
    get health() { return this.snapshot?.health ?? null; }
    get hunger() { return this.snapshot?.hunger ?? null; }
    get entities() { return this.snapshot?.entities || null; }
    get window() { return this.snapshot?.window || null; }
    get scoreboard() { return this.snapshot?.scoreboard || null; }
    get gamemode() { return this.snapshot?.gamemode || null; }
    get isConnected() { return !!this._snapshot; }

    _getInventoryCounts(bot) {
        const counts = {};
        if (!bot.inventory) return counts;
        for (const item of bot.inventory.items()) {
            if (!item) continue;
            const name = item.name;
            counts[name] = (counts[name] || 0) + item.count;
        }
        return counts;
    }

    _getTimeLabel(bot) {
        if (!bot.time?.timeOfDay) return 'Unknown';
        const t = bot.time.timeOfDay;
        if (t < 6000) return 'Morning';
        if (t < 12000) return 'Afternoon';
        if (t < 13000) return 'Sunset';
        return 'Night';
    }
}

import * as mc from '../../utils/mcdata.js';

const THREAT_SCAN_RADIUS = 24;
const BLOCK_SCAN_RADIUS = 8;
const BLOCK_SCAN_Y_ABOVE = 3;
const BLOCK_SCAN_Y_BELOW = 2;
const ALLY_SCAN_RADIUS = 48;
const MAX_EVENTS = 10;

export class Perception {
    constructor() {
        this.eventBuffer = [];
        this._setupEventListeners = false;
    }

    _ensureListeners(bot) {
        if (this._setupEventListeners) return;
        this._setupEventListeners = true;

        bot.on('entityHurt', (entity) => {
            this.eventBuffer.push({
                type: 'entityHurt',
                data: { name: entity.name, pos: entity.position },
                tick: bot.time?.age ?? 0,
                time: Date.now(),
            });
            this._trimEvents();
        });

        bot.on('entityDead', (entity) => {
            this.eventBuffer.push({
                type: 'entityDead',
                data: { name: entity.name, pos: entity.position },
                tick: bot.time?.age ?? 0,
                time: Date.now(),
            });
            this._trimEvents();
        });

        bot.on('health', () => {
            this.eventBuffer.push({
                type: 'healthChange',
                data: { hp: bot.health, food: bot.food },
                tick: bot.time?.age ?? 0,
                time: Date.now(),
            });
            this._trimEvents();
        });
    }

    _trimEvents() {
        if (this.eventBuffer.length > MAX_EVENTS) {
            this.eventBuffer = this.eventBuffer.slice(-MAX_EVENTS);
        }
    }

    buildState(bot, btMemory, serverIntel) {
        if (!bot?.entity) return null;

        this._ensureListeners(bot);

        const state = {
            self: this._getSelfState(bot),
            threats: this._getThreats(bot, btMemory),
            allies: this._getAllies(bot, btMemory),
            blocks: this._getBlockState(bot),
            terrain: this._getTerrainState(bot),
            events: [...this.eventBuffer],
            server: this._getServerState(bot, btMemory, serverIntel),
            tick: bot.time?.age ?? 0,
        };

        return state;
    }

    _getSelfState(bot) {
        const pos = bot.entity.position;
        const inv = bot.inventory ? bot.inventory.items() : [];
        const armor = bot.entity.equipment || [];
        const armorSlots = armor.filter(i => i != null).length;
        const armorDurabilityPct = this._avgArmorDurability(armor);

        return {
            pos: { x: pos.x, y: pos.y, z: pos.z },
            hp: bot.health,
            food: bot.food,
            armorSlots,
            armorDurabilityPct,
            heldItem: bot.heldItem?.name ?? null,
            inventory: inv.map(i => ({ name: i.name, count: i.count, slot: i.slot })),
            fallDistance: bot.entity.fallDistance ?? 0,
            inLava: this._isInLava(bot),
            drowning: bot.entity.isInWater && !this._headAboveWater(bot),
            velocity: bot.entity.velocity ? { x: bot.entity.velocity.x, y: bot.entity.velocity.y, z: bot.entity.velocity.z } : { x: 0, y: 0, z: 0 },
        };
    }

    _avgArmorDurability(armor) {
        let total = 0;
        let count = 0;
        for (const item of armor) {
            if (item && item.durabilityUsed != null && item.maxDurability != null) {
                total += 1 - (item.durabilityUsed / item.maxDurability);
                count++;
            }
        }
        return count > 0 ? (total / count) * 100 : 0;
    }

    _isInLava(bot) {
        try {
            const pos = bot.entity.position;
            const block = bot.blockAt(pos);
            return block && (block.name === 'lava' || block.name === 'flowing_lava');
        } catch { return false; }
    }

    _headAboveWater(bot) {
        try {
            const pos = bot.entity.position;
            const head = bot.blockAt({ x: pos.x, y: pos.y + 1, z: pos.z });
            return head && head.name === 'air';
        } catch { return true; }
    }

    _getThreats(bot, btMemory) {
        const threats = [];
        const selfPos = bot.entity.position;

        for (const entity of Object.values(bot.entities)) {
            if (entity === bot.entity) continue;
            const dist = selfPos.distanceTo(entity.position);
            if (dist > THREAT_SCAN_RADIUS) continue;

            const isHostileMob = entity.type === 'mob' && mc.isHostile(entity);
            const isHostilePlayer = entity.type === 'player'
                && entity.username !== bot.username
                && btMemory?.isHostile(entity.username);
            const isNeutralProvoked = entity.name === 'wolf' || entity.name === 'bee' || entity.name === 'zombified_piglin';

            if (!isHostileMob && !isHostilePlayer && !isNeutralProvoked) continue;

            const los = this._hasLineOfSight(bot, entity.position);

            threats.push({
                id: entity.id,
                name: entity.name || entity.username,
                type: entity.type,
                kind: entity.name || entity.username,
                pos: entity.position,
                distance: dist,
                hp: entity.health ?? null,
                lineOfSight: los,
                groupSize: this._countNearbySame(bot, entity, 8),
            });
        }

        threats.sort((a, b) => {
            if (a.lineOfSight !== b.lineOfSight) return a.lineOfSight ? -1 : 1;
            return a.distance - b.distance;
        });

        return threats;
    }

    _hasLineOfSight(bot, targetPos) {
        try {
            const origin = bot.entity.position.offset(0, bot.entity.height * 0.7, 0);
            const direction = targetPos.minus(origin).normalize();
            const distance = origin.distanceTo(targetPos);
            const hit = bot.world.raycast(origin, direction, distance);
            return hit === null;
        } catch { return true; }
    }

    _countNearbySame(bot, entity, radius) {
        let count = 0;
        for (const e of Object.values(bot.entities)) {
            if (e === entity) { count++; continue; }
            if (e.name === entity.name && entity.position.distanceTo(e.position) < radius) {
                count++;
            }
        }
        return count;
    }

    _getAllies(bot, btMemory) {
        if (!btMemory) return [];
        const allies = [];
        const trusted = btMemory.data.trustedPlayers;
        if (!trusted.length) return allies;

        for (const entity of Object.values(bot.entities)) {
            if (entity === bot.entity || entity.type !== 'player') continue;
            if (!trusted.includes(entity.username)) continue;
            const dist = bot.entity.position.distanceTo(entity.position);
            if (dist > ALLY_SCAN_RADIUS) continue;
            allies.push({
                id: entity.id,
                name: entity.username,
                pos: entity.position,
                hp: entity.health ?? 20,
                distance: dist,
                underThreat: this._isUnderThreat(bot, entity),
            });
        }
        return allies;
    }

    _isUnderThreat(bot, entity) {
        for (const e of Object.values(bot.entities)) {
            if (e === entity || e.type !== 'mob') continue;
            if (!mc.isHostile(e)) continue;
            if (entity.position.distanceTo(e.position) < 12) return true;
        }
        return false;
    }

    _getBlockState(bot) {
        const result = { hazards: [], ores: [], food: [], lowLight: [], nearby: [] };
        const pos = bot.entity.position.floored();

        for (let x = -BLOCK_SCAN_RADIUS; x <= BLOCK_SCAN_RADIUS; x++) {
            for (let y = -BLOCK_SCAN_Y_BELOW; y <= BLOCK_SCAN_Y_ABOVE; y++) {
                for (let z = -BLOCK_SCAN_RADIUS; z <= BLOCK_SCAN_RADIUS; z++) {
                    try {
                        const bp = { x: pos.x + x, y: pos.y + y, z: pos.z + z };
                        const block = bot.blockAt(bp);
                        if (!block || block.name === 'air') continue;

                        const entry = { pos: [bp.x, bp.y, bp.z], type: block.name, light: block.light };
                        result.nearby.push(entry);

                        if (this._isHazard(block)) result.hazards.push(entry);
                        if (this._isOre(block)) result.ores.push(entry);
                        if (this._isFoodSource(block)) result.food.push(entry);

                    } catch { continue; }
                }
            }
        }

        return result;
    }

    _isHazard(block) {
        const hazards = ['lava', 'flowing_lava', 'fire', 'cactus', 'magma_block', 'campfire'];
        return hazards.includes(block.name);
    }

    _isOre(block) {
        return block.name.endsWith('_ore') || block.name === 'ancient_debris';
    }

    _isFoodSource(block) {
        const crops = ['wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart',
            'pumpkin', 'melon', 'sugar_cane', 'bamboo', 'kelp',
            'cocoa', 'sweet_berry_bush', 'cave_vines'];
        return crops.some(c => block.name.includes(c));
    }

    _getTerrainState(bot) {
        try {
            const pos = bot.entity.position;
            const feet = bot.blockAt(pos);
            const head = bot.blockAt({ x: pos.x, y: pos.y + 1, z: pos.z });

            return {
                light: feet ? feet.light : 15,
                biome: bot.entity?.biome?.name ?? 'unknown',
                canSeeSky: head ? head.name === 'air' && pos.y > (typeof bot.game?.dimension?.height === 'number' ? bot.game.dimension.height : 256) * 0.6 : true,
                rain: bot.isRaining ?? false,
                groundBlock: feet?.name ?? 'air',
            };
        } catch {
            return { light: 15, biome: 'unknown', canSeeSky: true, rain: false, groundBlock: 'air' };
        }
    }

    _getServerState(bot, btMemory, serverIntel) {
        const players = bot.players ? Object.keys(bot.players) : [];
        const base = {
            timeOfDay: bot.time?.timeOfDay ?? 0,
            weather: bot.isRaining ? 'rain' : 'clear',
            playerCount: players.length,
            playerList: players.filter(p => p !== bot.username),
        };

        if (!serverIntel) return base;

        const pos = bot.entity.position;
        return {
            ...base,
            hasEconomy: btMemory?.getServerFlag('hasEconomy') ?? false,
            nearbyClaim: serverIntel.isLikelyClaimed({ x: pos.x, y: pos.y, z: pos.z }),
            scoreboard: serverIntel.getScoreboardData(bot),
        };
    }
}

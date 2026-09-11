import { Vec3 } from 'vec3';
import fs from 'fs';

let Camera = null;
try {
  const camMod = await import("./camera.js");
  Camera = camMod.Camera;
} catch (e) {
  console.warn('Vision disabled (camera module not available):', e.message.slice(0,80));
}

export class VisionInterpreter {
    constructor(agent, allow_vision) {
        this.agent = agent;
        this.allow_vision = allow_vision && Camera !== null;
        this.fp = './bots/'+agent.name+'/screenshots/';
        if (this.allow_vision) {
            this.camera = new Camera(agent.bot, this.fp);
        }
        this._visionCache = new Map();
        this._threatMap = new Map(); // track threats by position + type
        this._oreMap = new Map();     // track ore vein locations
        this._structureMap = new Map(); // track structures (bases, loot, etc)
    }

    /**
     * ENHANCED: Analyze environment for pro-player decision making
     * Returns: { threats, resources, structures, recommendations }
     */
    async getFullEnvironmentAnalysis() {
        if (!this.allow_vision) {
            return this._getFallbackAnalysis();
        }
        
        try {
            const bot = this.agent.bot;
            const analysis = {
                timestamp: Date.now(),
                position: bot.entity?.position ? { ...bot.entity.position } : null,
                vision: {},
                threats: [],
                resources: [],
                structures: [],
                recommendations: [],
                graph: {}
            };

            // ── VISION LAYER: Screenshot + LLM Analysis ──
            const snapshot = await this.camera.capture();
            const visionData = await this.analyzeImage(snapshot);
            analysis.vision = {
                raw: visionData,
                timestamp: Date.now()
            };

            // ── THREAT ANALYSIS: Real-time entity scanning ──
            analysis.threats = this._analyzeThreatEnvironment(bot);

            // ── RESOURCE DETECTION: Ore, trees, water, animals ──
            analysis.resources = this._detectResources(bot);

            // ── STRUCTURE MAPPING: Nearby bases, caves, loot locations ──
            analysis.structures = this._mapStructures(bot);

            // ── RECOMMENDATION ENGINE: What to do next (pro-player tactics) ──
            analysis.recommendations = this._generateRecommendations(analysis);

            // ── GRAPH GENERATION: Position + threat + resource network ──
            analysis.graph = this._buildEnvironmentGraph(bot, analysis);

            return analysis;
        } catch (e) {
            console.warn('[Vision] Full analysis failed:', e.message);
            return this._getFallbackAnalysis();
        }
    }

    /**
     * ENHANCED: Detailed threat mapping (hunters, distance, patterns)
     */
    _analyzeThreatEnvironment(bot) {
        const threats = [];
        const entities = bot.entities || {};
        const pos = bot.entity?.position;

        if (!pos) return threats;

        const HOSTILE_NAMES = ['creeper','skeleton','spider','zombie','enderman','blaze','ghast','pillager','vindicator','witch','drowned','phantom','slime','magma_cube'];
        const SPEED_MAP = {
            'creeper': 1.2, 'skeleton': 1.0, 'spider': 1.3, 'zombie': 0.4, 
            'enderman': 3.5, 'blaze': 1.0, 'pillager': 0.6, 'witch': 1.0,
            'warden': 0.8, 'slime': 0.4
        };
        const DAMAGE_MAP = {
            'creeper': 0, 'skeleton': 1, 'spider': 2, 'zombie': 2,
            'enderman': 3, 'blaze': 1, 'pillager': 1, 'witch': 0, 
            'warden': 4, 'slime': 1
        };

        for (const entity of Object.values(entities)) {
            if (!entity?.isValid || !entity.position) continue;
            
            const name = (entity.name || '').toLowerCase();
            const isHostile = HOSTILE_NAMES.some(h => name.includes(h));
            
            if (!isHostile) continue;

            const dist = pos.distanceTo(entity.position);
            const threat = {
                type: entity.name,
                distance: dist,
                position: { ...entity.position },
                health: entity.health ?? 20,
                speed: SPEED_MAP[entity.name] || 1.0,
                damage: DAMAGE_MAP[entity.name] || 1,
                danger: (1 / (dist + 1)) * (DAMAGE_MAP[entity.name] || 1),
                relative: {
                    x: entity.position.x - pos.x,
                    y: entity.position.y - pos.y,
                    z: entity.position.z - pos.z
                }
            };

            threats.push(threat);
        }

        // Sort by danger (closest + highest damage first)
        return threats.sort((a, b) => b.danger - a.danger);
    }

    /**
     * ENHANCED: Detect and map all valuable resources nearby
     */
    _detectResources(bot) {
        const resources = [];
        const pos = bot.entity?.position;
        if (!pos) return resources;

        const SEARCH_RADIUS = 48;

        // ── WOOD & LOGS ──
        try {
            const trees = bot.findBlocks({
                matching: (b) => b?.name && /log/.test(b.name),
                maxDistance: SEARCH_RADIUS,
                count: 10
            });
            for (const tree of trees) {
                resources.push({
                    type: 'wood',
                    name: tree.name,
                    position: { ...tree },
                    distance: pos.distanceTo(tree),
                    priority: 0.3 // low priority (abundant)
                });
            }
        } catch (_) {}

        // ── ORE DEPOSITS ──
        const ORE_PRIORITY = {
            'diamond_ore': 0.95,
            'emerald_ore': 0.90,
            'gold_ore': 0.85,
            'iron_ore': 0.70,
            'lapis_ore': 0.60,
            'redstone_ore': 0.50,
            'copper_ore': 0.40,
            'coal_ore': 0.35
        };

        try {
            const ores = bot.findBlocks({
                matching: (b) => b?.name && /_ore$/.test(b.name),
                maxDistance: SEARCH_RADIUS,
                count: 15
            });
            for (const ore of ores) {
                resources.push({
                    type: 'ore',
                    name: ore.name,
                    position: { ...ore },
                    distance: pos.distanceTo(ore),
                    priority: ORE_PRIORITY[ore.name] || 0.3
                });
            }
        } catch (_) {}

        // ── ANIMALS (food source) ──
        const entities = bot.entities || {};
        const ANIMAL_NAMES = ['cow', 'pig', 'sheep', 'chicken', 'rabbit'];
        for (const entity of Object.values(entities)) {
            if (!entity?.isValid || !entity.position) continue;
            const isAnimal = ANIMAL_NAMES.some(a => (entity.name || '').includes(a));
            if (isAnimal) {
                resources.push({
                    type: 'animal',
                    name: entity.name,
                    position: { ...entity.position },
                    distance: pos.distanceTo(entity.position),
                    priority: 0.5, // medium priority (food)
                    health: entity.health
                });
            }
        }

        // ── WATER & LAVA ──
        try {
            const water = bot.findBlock({
                matching: b => b?.name === 'water',
                maxDistance: SEARCH_RADIUS
            });
            if (water) {
                resources.push({
                    type: 'water',
                    position: { ...water },
                    distance: pos.distanceTo(water),
                    priority: 0.6 // useful for escape
                });
            }
        } catch (_) {}

        return resources.sort((a, b) => b.priority - a.priority);
    }

    /**
     * ENHANCED: Detect structures (bases, caves, loot chests)
     */
    _mapStructures(bot) {
        const structures = [];
        const pos = bot.entity?.position;
        if (!pos) return structures;

        // ── CHESTS & BARRELS (loot potential) ──
        try {
            const chests = bot.findBlocks({
                matching: b => b?.name && /chest|barrel|hopper/.test(b.name),
                maxDistance: 32,
                count: 8
            });
            for (const chest of chests) {
                structures.push({
                    type: 'chest',
                    position: { ...chest },
                    distance: pos.distanceTo(chest),
                    priority: 0.7
                });
            }
        } catch (_) {}

        // ── BEDS (respawn points) ──
        try {
            const beds = bot.findBlocks({
                matching: b => b?.name === 'bed',
                maxDistance: 32,
                count: 5
            });
            for (const bed of beds) {
                structures.push({
                    type: 'bed',
                    position: { ...bed },
                    distance: pos.distanceTo(bed),
                    priority: 0.6
                });
            }
        } catch (_) {}

        // ── CRAFTING STATIONS ──
        try {
            const stations = bot.findBlocks({
                matching: b => b?.name && /crafting_table|furnace|anvil|enchanting_table/.test(b.name),
                maxDistance: 32,
                count: 5
            });
            for (const station of stations) {
                structures.push({
                    type: 'workstation',
                    name: station.name,
                    position: { ...station },
                    distance: pos.distanceTo(station),
                    priority: 0.8
                });
            }
        } catch (_) {}

        return structures.sort((a, b) => b.priority - a.priority);
    }

    /**
     * ENHANCED: Generate pro-player recommendations based on full analysis
     */
    _generateRecommendations(analysis) {
        const recs = [];
        const threats = analysis.threats || [];
        const resources = analysis.resources || [];

        // ── THREAT ASSESSMENT ──
        if (threats.length > 0) {
            const nearest = threats[0];
            if (nearest.distance < 8) {
                recs.push({
                    action: 'COMBAT',
                    reason: `${nearest.type} at ${nearest.distance.toFixed(1)}m`,
                    priority: 0.9,
                    steps: ['equip_weapon', 'face_threat', 'attack_pattern']
                });
            } else if (nearest.distance < 16) {
                recs.push({
                    action: 'KITE',
                    reason: `${nearest.type} approaching, distance ${nearest.distance.toFixed(1)}m`,
                    priority: 0.7,
                    steps: ['maintain_distance', 'prepare_weapon']
                });
            }
        }

        // ── RESOURCE GATHERING ──
        if (resources.length > 0) {
            const topResource = resources[0];
            if (topResource.priority > 0.7) {
                recs.push({
                    action: 'MINE',
                    target: topResource.name,
                    reason: `High priority ${topResource.type} at ${topResource.distance.toFixed(1)}m`,
                    priority: threats.length === 0 ? 0.8 : 0.3,
                    steps: ['navigate', 'mine_block', 'collect']
                });
            }
        }

        // ── SHELTER & SAFETY ──
        const structures = analysis.structures || [];
        const beds = structures.filter(s => s.type === 'bed');
        if (beds.length === 0 && (analysis.graph?.nighttime || false)) {
            recs.push({
                action: 'BUILD_SHELTER',
                reason: 'Nightfall approaching, no bed found',
                priority: 0.85,
                steps: ['gather_wood', 'craft_bed', 'place_bed']
            });
        }

        return recs.sort((a, b) => b.priority - a.priority);
    }

    /**
     * ENHANCED: Build environment graph for pathfinding & strategy
     */
    _buildEnvironmentGraph(bot, analysis) {
        const pos = bot.entity?.position || { x: 0, y: 0, z: 0 };
        const time = bot.time?.timeOfDay ?? 0;
        
        return {
            center: pos,
            dimension: bot.game?.dimension || 'overworld',
            nighttime: time > 12541 && time < 23459,
            timeOfDay: time,
            
            threatNetwork: (analysis.threats || []).map(t => ({
                type: t.type,
                pos: t.position,
                dist: t.distance,
                danger: t.danger
            })),
            
            resourceNetwork: (analysis.resources || [])
                .filter(r => r.priority > 0.5)
                .map(r => ({
                    type: r.type,
                    pos: r.position,
                    dist: r.distance,
                    value: r.priority
                })),
            
            structureNetwork: (analysis.structures || []).map(s => ({
                type: s.type,
                pos: s.position,
                dist: s.distance
            })),
            
            // Path recommendations (AStar-style)
            safeZones: this._identifySafeZones(bot, analysis),
            dangerZones: this._identifyDangerZones(bot, analysis)
        };
    }

    _identifySafeZones(bot, analysis) {
        const pos = bot.entity?.position;
        const threats = analysis.threats || [];
        const zones = [];

        if (!pos) return zones;

        // Zones far from all threats
        if (threats.length === 0) {
            zones.push({
                center: pos,
                radius: 30,
                safety: 1.0
            });
        } else {
            const nearest = threats[0];
            // Move perpendicular to nearest threat
            const away = {
                x: pos.x + (pos.x - nearest.position.x) * 2,
                y: pos.y,
                z: pos.z + (pos.z - nearest.position.z) * 2
            };
            zones.push({
                center: away,
                radius: 20,
                safety: 0.8
            });
        }

        return zones;
    }

    _identifyDangerZones(bot, analysis) {
        const threats = analysis.threats || [];
        return threats.map(t => ({
            center: t.position,
            radius: Math.max(8, t.distance + 4),
            threat: t.type,
            danger: t.danger
        }));
    }

    async lookAtPlayer(player_name, direction) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        const player = bot.players[player_name]?.entity;
        if (!player) {
            return `Could not find player ${player_name}`;
        }

        let filename;
        if (direction === 'with') {
            await bot.look(player.yaw, player.pitch);
            result = `Looking in the same direction as ${player_name}\n`;
            filename = await this.camera.capture();
        } else {
            await bot.lookAt(new Vec3(player.position.x, player.position.y + player.height, player.position.z));
            result = `Looking at player ${player_name}\n`;
            filename = await this.camera.capture();
        }

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    async lookAtPosition(x, y, z) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        await bot.lookAt(new Vec3(x, y + 2, z));
        result = `Looking at coordinate ${x}, ${y}, ${z}\n`;

        let filename = await this.camera.capture();

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    getCenterBlockInfo() {
        const bot = this.agent.bot;
        const maxDistance = 128;
        const targetBlock = bot.blockAtCursor(maxDistance);
        
        if (targetBlock) {
            return `Block at center view: ${targetBlock.name} at (${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z})`;
        } else {
            return "No block in center view";
        }
    }

    async analyzeImage(filename) {
        try {
            const cacheKey = filename;
            if (this._visionCache.has(cacheKey)) {
                return this._visionCache.get(cacheKey);
            }

            const imageBuffer = fs.readFileSync(`${this.fp}/${filename}.jpg`);
            const messages = this.agent.history.getHistory();

            const blockInfo = this.getCenterBlockInfo();
            const result = await this.agent.prompter.promptVision(messages, imageBuffer);
            const analysis = result + `\n${blockInfo}`;
            
            this._visionCache.set(cacheKey, analysis);
            return analysis;

        } catch (error) {
            console.warn('Error reading image:', error);
            return `Error reading image: ${error.message}`;
        }
    }

    /**
     * FALLBACK: When vision is disabled, use scanner only
     */
    _getFallbackAnalysis() {
        const bot = this.agent.bot;
        return {
            timestamp: Date.now(),
            position: bot.entity?.position ? { ...bot.entity.position } : null,
            vision: { raw: 'Vision disabled' },
            threats: this._analyzeThreatEnvironment(bot),
            resources: this._detectResources(bot),
            structures: this._mapStructures(bot),
            recommendations: [],
            graph: this._buildEnvironmentGraph(bot, { threats: this._analyzeThreatEnvironment(bot), resources: this._detectResources(bot) })
        };
    }
}

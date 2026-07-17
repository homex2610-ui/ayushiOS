const WOOL_COLORS = ['white','orange','magenta','light_blue','yellow','lime','pink','gray','light_gray','cyan','purple','blue','brown','green','red','black'];

const INTERESTING_BLOCKS = [
    'diamond_ore', 'iron_ore', 'gold_ore', 'coal_ore', 'copper_ore',
    'emerald_ore', 'lapis_ore', 'redstone_ore',
    'chest', 'furnace', 'crafting_table', 'bed', 'door', 'ladder',
    'water', 'lava', 'cactus', 'sugar_cane', 'portal',
];

const HOSTILE_MOBS = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'phantom'];

export class WorldKnowledge {
    constructor(agent) {
        this.agent = agent;
        this.lastRefresh = 0;
        this.cached = '';
        this.lastHealth = 20;
        this.lastFood = 20;
        this.changes = [];
    }

    async refresh(force) {
        const bot = this.agent.bot;
        if (!bot || !bot.entity) return;
        const now = Date.now();
        if (!force && now - this.lastRefresh < 15000) return;
        this.lastRefresh = now;
        this.cached = await this._buildSummary(bot);
    }

    async _buildSummary(bot) {
        const parts = [];
        const pos = bot.entity.position;
        const time = bot.time.timeOfDay;
        const timeStr = time < 6000 ? 'dawn' : time < 12000 ? 'day' : time < 18000 ? 'sunset' : 'night';

        if (bot.health < this.lastHealth) this.changes.push('took damage');
        if (bot.food < this.lastFood && bot.food < 10) this.changes.push('hungry');
        this.lastHealth = bot.health;
        this.lastFood = bot.food;

        const dim = bot.game.dimension || 'overworld';
        parts.push(`HP:${bot.health??20} Food:${bot.food??20} ${timeStr} ${dim} @${Math.round(pos.x)},${Math.round(pos.z)}`);

        // ground beneath feet
        const ground = bot.blockAt(pos.offset(0, -1, 0));
        const feet = bot.blockAt(pos);
        if (feet && feet.name === 'air') parts.push('standing_in_hole');
        else if (ground) parts.push(`on:${ground.name}`);

        // colored wool / interesting blocks nearby
        const wool = this._nearbyWool(bot);
        if (wool.length > 0) parts.push(`wool:${wool.slice(0,6).join(',')}`);

        const blocks = this._interestingBlocks(bot);
        if (blocks.length > 0) parts.push(`near:${blocks.slice(0,8).join(',')}`);

        // mobs
        const mobs = this._nearbyMobs(bot);
        if (mobs.hostile.length > 0) parts.push(`❗${mobs.hostile.slice(0,3).join(',')}`);
        if (mobs.passive.length > 0) parts.push(`animals:${mobs.passive.slice(0,3).join(',')}`);

        // players
        const players = Object.values(bot.players || {}).filter(p => p.username !== bot.username);
        if (players.length > 0) parts.push(`players:${players.map(p => p.username).join(',')}`);

        if (this.changes.length > 0) parts.push(`changes:${this.changes.slice(-3).join(', ')}`);

        return parts.join(' | ');
    }

    _nearbyWool(bot) {
        const found = [];
        for (const color of WOOL_COLORS) {
            try {
                const block = bot.findBlock({ point: bot.entity.position, matching: b => b.name === `${color}_wool`, maxDistance: 12, count: 1 });
                if (block) found.push(color);
            } catch (err) { console.warn('[WorldKnowledge] _nearbyWool:', err.message); }
            if (found.length >= 6) break;
        }
        return found;
    }

    _interestingBlocks(bot) {
        const results = [];
        for (const name of INTERESTING_BLOCKS) {
            try {
                const block = bot.findBlock({ point: bot.entity.position, matching: b => b.name === name, maxDistance: 16, count: 1 });
                if (block) results.push(name);
            } catch (err) { console.warn('[WorldKnowledge] _interestingBlocks:', err.message); }
        }
        return results;
    }

    _nearbyMobs(bot) {
        const hostile = [], passive = [];
        for (const id in bot.entities) {
            const e = bot.entities[id];
            if (e.type === 'mob' && e.position && e.position.distanceTo(bot.entity.position) < 24) {
                if (HOSTILE_MOBS.includes(e.name)) hostile.push(e.name);
                else if (['chicken','cow','pig','sheep','rabbit'].includes(e.name)) passive.push(e.name);
            }
        }
        return { hostile, passive };
    }

    getSummary() {
        return this.cached || 'exploring...';
    }

    clearChanges() {
        this.changes = [];
    }
}

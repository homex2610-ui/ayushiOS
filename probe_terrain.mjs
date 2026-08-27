// probe_terrain.mjs — joins the world, runs SpatialVision-style scans, reports truth.
import mc from 'minecraft-protocol';
import mineflayer from 'mineflayer';

const bot = mineflayer.createBot({
    host: '127.0.0.1',
    port: 53959,
    username: 'scout_probe',
    auth: 'offline',
    version: '1.21.11',
});

bot.once('spawn', async () => {
    try {
        await new Promise(r => setTimeout(r, 5000));
        const p = bot.entity.position;
        console.log(`PROBE at (${p.x | 0}, ${p.y | 0}, ${p.z | 0})`);

        const biome = bot.blockAt(bot.entity.position)?.biome?.name;
        console.log('biome at feet:', biome);

        for (const range of [48, 96, 160]) {
            const logs = bot.findBlocks({ matching: b => b?.name?.endsWith('_log'), maxDistance: range, count: 50 });
            const water = bot.findBlocks({ matching: b => b?.name === 'water', maxDistance: range, count: 5 });
            const animals = Object.values(bot.entities).filter(e => e.type === 'mob' && e.name &&
                !['zombie','skeleton','creeper','spider','witch','enderman','drowned','husk','stray'].includes(e.name) && e.position.distanceTo(p) < range);
            console.log(`range=${range}: LOGS=${logs.length} ${logs.slice(0,3).map(b=>b.name).join(',')} | water=${water.length>0} | animals=${animals.length}`);
        }
        // sample what blocks ARE around
        const near = bot.findBlocks({ matching: () => true, maxDistance: 12, count: 200 });
        const tally = {};
        for (const b of near) { const n = bot.blockAt(b.position)?.name; if (n) tally[n] = (tally[n]||0)+1; }
        console.log('nearby block census:', JSON.stringify(Object.entries(tally).sort((a,b)=>b[1]-a[1]).slice(0,10)));
    } catch (e) {
        console.log('probe error:', e.message);
    }
    setTimeout(() => { bot.quit(); process.exit(0); }, 3000);
});

// test_brain.mjs — offline smoke test of DeterministicBrain reply chain
import { DeterministicBrain } from './src/agent/deterministic_brain.js';

const fakeBot = {
    health: 18, food: 20,
    entity: { position: { x: -41, y: 69, z: -317 }, username: 'ayushi_ds_2026' },
    time: { timeOfDay: 6000 },
    inventory: { items: () => [{ name: 'bread', count: 3 }, { name: 'oak_log', count: 5 }] },
    chat: () => {},
};

const fakeAgent = {
    name: 'ayushi_ds_2026',
    bot: fakeBot,
    openChat: () => {},
    actions: { runAction: async () => ({ success: true }), stop: async () => {}, cancelResume: () => {} },
    history: { add: () => {}, save: () => {}, getHistory: () => [] },
};

const brain = new DeterministicBrain(fakeAgent);
await brain._initPromise;

const cases = [
    ['updesh', 'hello'],
    ['updesh', 'how are you'],
    ['updesh', 'where are you'],
    ['updesh', 'what can you do'],
    ['updesh', 'thanks'],
];

for (const [sender, msg] of cases) {
    const t0 = Date.now();
    const reply = await brain.handle(sender, msg);
    console.log(`"${msg}"`.padEnd(22), '->', JSON.stringify(reply), `(${Date.now() - t0}ms)`);
}

// Command-path cases go through RuleBrain first — replies should come back instantly
for (const [sender, msg] of [['updesh', 'status'], ['updesh', 'inventory']]) {
    const t0 = Date.now();
    const reply = await brain.handle(sender, msg);
    console.log(`"${msg}"`.padEnd(22), '->', JSON.stringify(reply), `(${Date.now() - t0}ms)`);
}
process.exit(0);

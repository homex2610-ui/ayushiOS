// test_neural.mjs — offline validation of the neural cortex:
// 1. 6-layer architecture sanity
// 2. Learning: synthetic danger task — loss must fall, accuracy must rise
// 3. Serialization roundtrip: weights survive save/load
// 4. SensorArray: feature vector shape + bounds with a fake bot

import { TinyBrain } from '../../src/brain/NeuralNet.js';
import { SensorArray, NN_FEATURE_COUNT } from '../../src/brain/SensorArray.js';

let failures = 0;
function check(name, cond, extra = '') {
    if (cond) console.log(`  PASS  ${name}`);
    else { console.error(`  FAIL  ${name} ${extra}`); failures++; }
}

console.log('\n[1] Architecture — 6 layers');
{
    const brain = new TinyBrain([NN_FEATURE_COUNT, 32, 16, 8, 4, 3]);
    check('6 layers total', brain.layers.length === 5 && brain.sizes.length === 6,
        `sizes=${brain.sizes}`);
    check('input size matches feature count', brain.inputSize === NN_FEATURE_COUNT);
    check('output bounded [0,1]', (() => {
        const out = brain.predict(new Array(NN_FEATURE_COUNT).fill(0.5));
        return out.every(v => v >= 0 && v <= 1) && out.length === 3;
    })());
}

console.log('\n[2] Learning — synthetic "danger" task');
{
    // Ground truth: danger when health low AND hostile close AND night
    const sample = (danger) => {
        const x = new Array(NN_FEATURE_COUNT).fill(0).map(() => Math.random() * 0.3);
        x[0] = danger ? Math.random() * 0.3 : 0.7 + Math.random() * 0.3; // health
        x[1] = 0.8;                                                        // food ok
        x[6] = danger ? 0.85 : Math.random() * 0.2;                        // threat proximity
        if (Math.random() < 0.5) x[11] = danger ? 1 : 0;                   // sometimes night
        return { x, y: [danger ? 1 : 0, 0, danger ? 0 : 1] };
    };
    const brain = new TinyBrain([NN_FEATURE_COUNT, 32, 16, 8, 4, 3]);
    const data = [];
    for (let i = 0; i < 120; i++) data.push(sample(i % 2 === 0));

    const lossBefore = brain.trainBatch(data.slice(0, 16), 0.05);
    for (let epoch = 0; epoch < 60; epoch++) {
        // shuffle-ish
        data.sort(() => Math.random() - 0.5);
        for (let i = 0; i < data.length; i += 16) brain.trainBatch(data.slice(i, i + 16), 0.05);
    }
    const lossAfter = brain.trainBatch(data.slice(0, 16), 0.05);

    let correct = 0;
    for (const d of data) {
        const p = brain.predict(d.x);
        const predictedDanger = p[0] > 0.5;
        if (predictedDanger === (d.y[0] === 1)) correct++;
    }
    const acc = correct / data.length;
    check(`loss decreases (${lossBefore.toFixed(3)} → ${lossAfter.toFixed(3)})`, lossAfter < lossBefore);
    check(`accuracy > 90% (got ${(acc * 100).toFixed(0)}%)`, acc > 0.9);

    console.log('\n[3] Serialization roundtrip');
    const saved = JSON.parse(JSON.stringify(brain.toJSON()));
    const revived = TinyBrain.fromJSON(saved);
    const a = brain.predict(data[0].x);
    const b = revived.predict(data[0].x);
    check('predictions identical after reload', a.every((v, i) => Math.abs(v - b[i]) < 1e-9));
}

console.log('\n[4] SensorArray with fake bot');
{
    const listeners = {};
    const fakeBot = {
        on: (ev, fn) => { listeners[ev] = fn; },
        removeListener: () => {},
        entity: {
            position: { x: 10, y: 70, z: -20, distanceTo(o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z); } },
            isInWater: false,
            metadata: [{ fallDistance: 0 }],
        },
        time: { timeOfDay: 18000 },
    };
    const sa = new SensorArray(fakeBot);
    check('sound listener attached', !!listeners.soundEffectHeard);

    const snapshot = {
        vitality: { health: 12, food: 18, saturation: 2, oxygen: 20, armorSlots: 2, hasFood: true },
        environment: { isNight: true, isRaining: false, lightLevel: 4, position: { y: 70 } },
        threats: [{ name: 'zombie', distance: 6 }, { name: 'skeleton', distance: 11 }],
        social: { nearbyPlayers: [{ username: 'updesh', distance: 15 }] },
        body: { inventory: new Array(20).fill({ name: 'cobblestone', count: 1 }), equipped: { hand: 'iron_sword' } },
    };

    listeners.soundEffectHeard?.('creeper.primed', { x: 12, y: 70, z: -21 });
    const v = sa.readFeatures(snapshot);
    check(`vector length ${NN_FEATURE_COUNT}`, v.length === NN_FEATURE_COUNT);
    check('all features finite & in [0,1]', v.every(n => Number.isFinite(n) && n >= 0 && n <= 1),
        JSON.stringify(v));
    check('health feature reflects 12/20', Math.abs(v[0] - 0.6) < 1e-9);
    check('threat proximity high (zombie at 6m)', v[6] > 0.55);
    check('danger sound detected', v[18] === 1);
    check('night flag set', v[11] === 1);
    check('sword class = 1', v[21] === 1);

    // Damage labeling path
    sa.observeVitals(12, 18, Date.now());
    const dmg = sa.observeVitals(9, 17, Date.now());
    check('damage delta observed (3 HP)', dmg === 3);

    sa.detach();
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);

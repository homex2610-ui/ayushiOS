// test_quantum.mjs — offline validation of the QuantumMind arbiter:
// Born-rule normalization, interference learning, annealing, tunneling,
// entropy hysteresis, and describe() payload sanity.

import { QuantumMind } from '../../src/brain/QuantumMind.js';

let failures = 0;
function check(name, cond, extra = '') {
    if (cond) console.log(`  PASS  ${name}`);
    else { console.error(`  FAIL  ${name} ${extra}`); failures++; }
}
const sum = m => [...m.values()].reduce((a, b) => a + b, 0);
const NEEDS = ['eat', 'sleep', 'craft_gear', 'build_base', 'explore_unknown', 'avoid_hazard', 'seek_safety', 'resume_task'];
const dist = (q, scored) => { q._evolve(new Map(scored.map(s => [s.need, s.score]))); q._interfere(); return q._born(); };

console.log('\n[1] Born rule — normalization + degenerate safety');
{
    const q = new QuantumMind(NEEDS);
    const scored = NEEDS.map((n, i) => ({ need: n, score: i === 0 ? 1 : 0.1 }));
    const probs = dist(q, scored);
    check('probabilities sum to 1', Math.abs(sum(probs) - 1) < 1e-9, `total=${sum(probs)}`);
    check('finite & non-negative', [...probs.values()].every(p => Number.isFinite(p) && p >= 0));
    check('highest utility holds most mass', probs.get('eat') > probs.get('sleep'));

    const q2 = new QuantumMind(NEEDS);
    const p2 = dist(q2, NEEDS.map(n => ({ need: n, score: 0 })));
    check('zero-utility fallback stays normalized', Math.abs(sum(p2) - 1) < 1e-9 && [...p2.values()].every(Number.isFinite));
}

console.log('\n[2] Interference — outcome feedback shifts the distribution');
{
    const q = new QuantumMind(NEEDS);
    const scored = NEEDS.map(n => ({ need: n, score: 0.5 }));
    const baseline = dist(q, scored);
    for (let i = 0; i < 10; i++) { q.observe('craft_gear', +1); q.observe('explore_unknown', -1); }
    const after = dist(q, scored);
    check('rewarded need gains mass', after.get('craft_gear') > baseline.get('craft_gear'),
        `${baseline.get('craft_gear').toFixed(4)} -> ${after.get('craft_gear').toFixed(4)}`);
    check('punished need loses mass', after.get('explore_unknown') < baseline.get('explore_unknown'),
        `${baseline.get('explore_unknown').toFixed(4)} -> ${after.get('explore_unknown').toFixed(4)}`);
}

console.log('\n[3] Annealing — temperature decays toward floor');
{
    const q = new QuantumMind(NEEDS);
    const scored = NEEDS.map(n => ({ need: n, score: 0.5 }));
    const t0 = q.temperature;
    for (let i = 0; i < 50; i++) q.arbitrate(scored, null);
    check(`temperature decays (${t0} -> ${q.temperature.toFixed(3)})`, q.temperature < t0 && q.temperature >= q.tempFloor);
}

console.log('\n[4] Sampling — valid picks; hot state explores');
{
    const q = new QuantumMind(NEEDS, { tempDecay: 1.0, tempFloor: 0.9 });
    const scored = NEEDS.map((n, i) => ({ need: n, score: i === 2 ? 1 : 0 }));
    const picks = new Set();
    for (let i = 0; i < 400; i++) {
        const r = q.arbitrate(scored, null);
        if (!NEEDS.includes(r.need)) { check('pick outside basis', false, r.need); break; }
        picks.add(r.need);
    }
    check('all picks inside basis', true);
    check('peak need is reachable (born + tunnel)', picks.has('craft_gear'));
}

console.log('\n[5] Entropy hysteresis — indecisive state sticks to current goal');
{
    const q = new QuantumMind(NEEDS, { tempDecay: 1.0, tempFloor: 0.05 });
    const scored = NEEDS.map(n => ({ need: n, score: 0.5 }));
    let stayed = 0;
    const N = 300;
    for (let i = 0; i < N; i++) if (q.arbitrate(scored, 'build_base').need === 'build_base') stayed++;
    const share = stayed / N;
    check(`current-goal share above uniform (got ${(share * 100).toFixed(0)}% vs 12.5%)`, share > 0.125);
}

console.log('\n[6] describe() — dashboard payload sane');
{
    const q = new QuantumMind(NEEDS);
    q.arbitrate(NEEDS.map(n => ({ need: n, score: 0.4 })), null);
    const d = q.describe();
    check('temperature/entropy/decisions finite', Number.isFinite(d.temperature) && Number.isFinite(d.entropy) && d.decisions >= 1);
    check('probs object complete', Object.keys(d.probs).length === NEEDS.length);
    check('amplitudes object complete', Object.keys(d.amplitudes).length === NEEDS.length);
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);

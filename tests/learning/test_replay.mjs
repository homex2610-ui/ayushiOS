// test_replay.mjs
// Tests ReplayEngine v1 — offline analysis of Experience data.
// No bot, no server, no Mineflayer — purely derived data.

import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { ReplayEngine } from '../../src/learning/ReplayEngine.js';

const TMP_DIR = 'bots/_test_replay';
const TMP_FP = TMP_DIR + '/experiences.json';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}`); }
}
function assertEqual(a, b, label) {
  if (a === b) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
}
function assertGT(a, b, label) {
  if (a > b) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} — expected >${b}, got ${a}`); }
}

if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });

console.log('\n=== 1. ReplayEngine — Loading and Basic Aggregation ===\n');

{
  // Create a small corpus
  const experiences = [
    { id: 'e1', goal: 'craft_iron_pickaxe', serverType: 'survival', result: 'completed', reward: 85, duration: 94000, actions: [{ skill: 'craft', duration: 5000, status: 'completed' }], failureReason: null, contextSnapshot: { assumptions: ['hint:use_furnace'] }, interruptions: [], lessonsLearned: [], beliefsSnapshot: { health: 20, food: 18, threats: [] }, taskGraph: [], timestamp: Date.now(), version: { planner: 'v1', rewardModel: 1, semanticModel: 1, skillRepository: 1 } },
    { id: 'e2', goal: 'craft_iron_pickaxe', serverType: 'survival', result: 'completed', reward: 90, duration: 82000, actions: [{ skill: 'craft', duration: 5000, status: 'completed' }], failureReason: null, contextSnapshot: { assumptions: ['hint:use_furnace'] }, interruptions: [], lessonsLearned: [], beliefsSnapshot: { health: 20, food: 18, threats: [] }, taskGraph: [], timestamp: Date.now(), version: { planner: 'v1', rewardModel: 1, semanticModel: 1, skillRepository: 1 } },
    { id: 'e3', goal: 'craft_iron_pickaxe', serverType: 'survival', result: 'failed', reward: -25, duration: 45000, actions: [{ skill: 'craft', duration: 5000, status: 'failed' }], failureReason: 'no sticks', contextSnapshot: { assumptions: [] }, interruptions: [{ reason: 'combat', at: Date.now() }], lessonsLearned: [], beliefsSnapshot: { health: 12, food: 8, threats: [{ type: 'zombie' }] }, taskGraph: [], timestamp: Date.now(), version: { planner: 'v1', rewardModel: 1, semanticModel: 1, skillRepository: 1 } },
    { id: 'e4', goal: 'seek_safety', serverType: 'survival', result: 'completed', reward: 50, duration: 15000, actions: [{ skill: 'go_surface', duration: 5000, status: 'completed' }], failureReason: null, contextSnapshot: { assumptions: [] }, interruptions: [], lessonsLearned: [], beliefsSnapshot: { health: 6, food: 4, threats: [{ type: 'creeper' }] }, taskGraph: [], timestamp: Date.now(), version: { planner: 'v1', rewardModel: 1, semanticModel: 1, skillRepository: 1 } },
    { id: 'e5', goal: 'seek_safety', serverType: 'survival', result: 'failed', reward: -40, duration: 8000, actions: [{ skill: 'go_surface', duration: 5000, status: 'failed' }], failureReason: 'creeper exploded', contextSnapshot: { assumptions: [] }, interruptions: [], lessonsLearned: [], beliefsSnapshot: { health: 0, food: 4, threats: [] }, taskGraph: [], timestamp: Date.now(), version: { planner: 'v1', rewardModel: 1, semanticModel: 1, skillRepository: 1 } },
    { id: 'e6', goal: 'eat', serverType: 'lifesteal', result: 'completed', reward: 30, duration: 5000, actions: [{ skill: 'eat', duration: 2000, status: 'completed' }], failureReason: null, contextSnapshot: { assumptions: [] }, interruptions: [], lessonsLearned: [], beliefsSnapshot: { health: 10, food: 0, threats: [] }, taskGraph: [], timestamp: Date.now(), version: { planner: 'v1', rewardModel: 1, semanticModel: 1, skillRepository: 1 } },
  ];

  writeFileSync(TMP_FP, JSON.stringify(experiences, null, 2), 'utf8');
  const engine = new ReplayEngine(TMP_FP);
  engine.load();

  const all = engine.filter(); // no filter
  assertEqual(all.length, 6, '6 experiences loaded');

  const goals = engine.goalReport(all);
  assertEqual(goals.length, 3, '3 unique goals');

  const craftGoal = goals.find(g => g.goal === 'craft_iron_pickaxe');
  assert(craftGoal, 'craft_iron_pickaxe goal found');
  assertEqual(craftGoal.runs, 3, '3 runs for craft_iron_pickaxe');
  assertEqual(craftGoal.successes, 2, '2 successes for craft_iron_pickaxe');
  assertEqual(craftGoal.failures, 1, '1 failure for craft_iron_pickaxe');
  assertEqual(craftGoal.avgReward, (85 + 90 - 25) / 3, 'Avg reward calculated');
  assertEqual(craftGoal.commonFailures.length, 1, '1 common failure type');
  assertEqual(craftGoal.commonFailures[0].reason, 'no sticks', 'Failure reason correct');

  const safetyGoal = goals.find(g => g.goal === 'seek_safety');
  assert(safetyGoal, 'seek_safety goal found');
  assertEqual(safetyGoal.runs, 2, '2 runs for seek_safety');
  assertEqual(safetyGoal.failures, 1, '1 failure for seek_safety');

  const eatGoal = goals.find(g => g.goal === 'eat');
  assert(eatGoal, 'eat goal found');
  assertEqual(eatGoal.runs, 1, '1 run for eat');
}

console.log('\n=== 2. ReplayEngine — Global Summary ===\n');

{
  const engine = new ReplayEngine(TMP_FP);
  engine.load();
  const all = engine.filter();
  const global = engine.globalSummary(all);

  assertEqual(global.total, 6, 'Total 6 experiences');
  assertEqual(global.completed, 4, '4 completed');
  assertEqual(global.failed, 2, '2 failed');
  assertEqual(global.interrupted, 1, '1 interrupted');
  assertEqual(global.completionRate, ((4 / 6) * 100).toFixed(1), 'Completion rate 66.7%');
  assertGT(global.totalReward, 0, 'Total reward positive');
}

console.log('\n=== 3. ReplayEngine — Filtering ===\n');

{
  const engine = new ReplayEngine(TMP_FP);
  engine.load();

  const survival = engine.filter({ serverType: 'survival' });
  assertEqual(survival.length, 5, '5 survival experiences');

  const failed = engine.filter({ result: 'failed' });
  assertEqual(failed.length, 2, '2 failed experiences');

  const craftFailures = engine.filter({ goalPrefix: 'craft', result: 'failed' });
  assertEqual(craftFailures.length, 1, '1 craft failure');

  const lifesteal = engine.filter({ serverType: 'lifesteal' });
  assertEqual(lifesteal.length, 1, '1 lifesteal experience');
}

console.log('\n=== 4. ReplayEngine — Report Generation ===\n');

{
  const engine = new ReplayEngine(TMP_FP);
  engine.load();
  const report = engine.runFilteredReport({ serverType: 'survival' });

  assert(report.includes('craft_iron_pickaxe'), 'Report includes craft_iron_pickaxe goal');
  assert(report.includes('seek_safety'), 'Report includes seek_safety goal');
  assert(!report.includes('eat'), 'Report excludes eat (lifesteal only)');
  assert(report.includes('Global Summary'), 'Report includes global summary');
  assert(report.includes('ReplayEngine v1'), 'Report includes version header');

  // Validate the report has reasonable content
  const lines = report.split('\n').filter(l => l.trim());
  assertGT(lines.length, 30, 'Report has substantial content');
}

console.log('\n=== 5. ReplayEngine — Edge Cases ===\n');

{
  // Empty corpus
  writeFileSync(TMP_FP, '[]', 'utf8');
  const empty = new ReplayEngine(TMP_FP);
  empty.load();
  const all = empty.filter();
  assertEqual(all.length, 0, '0 experiences in empty corpus');
  const global = empty.globalSummary(all);
  assertEqual(global.total, 0, 'Global total is 0 for empty');
  assertEqual(global.completionRate, '0.0', 'Completion rate 0 for empty');

  const report = empty.report(all);
  assert(report.includes('Total experiences: 0'), 'Empty report shows 0');
}

console.log('\n=== Results ===\n');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed === 0) console.log('\n  All ReplayEngine validations passed! ✓');
else process.exit(1);

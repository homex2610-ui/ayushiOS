// test_integration_e2e.mjs
// End-to-end integration test: ExecutiveBrain → DecisionTrace → LearningEngine → ExperienceStore → disk.
// Proves the full chain from goal selection to experience persistence.

import fs from 'fs';
import path from 'path';
import { ExecutiveBrain } from '../../src/brain/ExecutiveBrain.js';
import { DecisionTrace } from '../../src/brain/DecisionTrace.js';
import { LearningEngine } from '../../src/learning/LearningEngine.js';
import { ExperienceStore } from '../../src/learning/ExperienceStore.js';

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

function assertNotEqual(a, b, label) {
  if (a !== b) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} — both are ${JSON.stringify(a)}`); }
}

const TEST_USER = '_test_e2e_runner';
const testDir = path.join(process.cwd(), 'bots', TEST_USER);

function cleanup() {
  try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
}

// ─────────────────────────────────────────────────────────────
// 1. ExecutiveBrain cooldown — avoid_hazard should not repeat
//    within the cooldown window.
// ─────────────────────────────────────────────────────────────
console.log('\n=== 1. ExecutiveBrain — Cooldown prevents avoid_hazard repeat ===\n');

{
  const memory = { recordFailure: () => {} };
  const personality = {
    traits: { curiosity: 0.5, sociability: 0.3, bravery: 0.7 },
    allowsRiskyTasks: () => true,
    evaluateMood: () => 'Neutral',
    getDialogueTone: () => 'hi',
  };
  const tom = {};
  const events = [];
  const bus = { emit: (name, data) => events.push({ name, data }), on: () => {} };
  const knowledge = {
    snapshot: (pos) => ({
      hasSafeBase: false, nearestSafeBase: null, nearestFoodSource: null, nearbyFoodSources: [],
      nearestWarp: null, hazardsNearby: true, hazardCount: 2, knownWarpCount: 0,
      knownWarps: [], knownNPCs: [], knownCommands: [], dimension: 'overworld', biome: 'plains',
      position: pos, vitality: { health: 20, food: 20, hasFood: true }, threats: [],
      nearbyNPCs: [], nearbyPlayers: [], nearbyHazards: [],
      openGui: null, scoreboard: { title: null, lines: [] },
      currentServer: { name: 'test', motd: null, version: null, pvp: false, claimSystem: null, spawn: null },
      economy: { enabled: false, currency: null, symbols: [] },
      serverKnowledge: { commandCount: 0, plugins: [], name: null, economy: null },
      recentEpisodes: [], recentHazardWarnings: [],
    }),
  };

  const brain = new ExecutiveBrain(memory, personality, tom, bus, { knowledge });

  const snapshot = {
    vitality: { health: 20, food: 18, hasFood: true },
    threats: [],
    equipment: { hasDiamondArmor: false, hasIronArmor: false, hasShield: false, hasWaterBucket: false },
    resources: { hasFood: true, hasCraftingTable: false, hasFurnace: false, hasBed: false, hasOre: () => false, inventory: [] },
    environment: { position: { x: 0, y: 65, z: 0 }, isNight: false, biome: 'plains', nearestChest: null, nearestBed: null, nearestWorkstation: null },
    social: { nearbyPlayers: [] },
  };

  const result1 = brain.decide(snapshot);
  assert(result1.task === 'avoid_hazard', 'First decide picks avoid_hazard when hazardsNearby');

  const result2 = brain.decide(snapshot);
  assertNotEqual(result2.task, 'avoid_hazard', 'Second decide skips avoid_hazard (cooldown active)');
  assert(result2.steps.length > 0, 'Second decide still produces steps');
}

// ─────────────────────────────────────────────────────────────
// 2. DecisionTrace — in-memory and file persistence
// ─────────────────────────────────────────────────────────────
console.log('\n=== 2. DecisionTrace — In-memory recording and file persistence ===\n');

{
  cleanup();
  const trace = new DecisionTrace({ username: TEST_USER });

  trace.record({
    goal: 'craft_gear',
    need: 'craft_gear',
    score: 0.7,
    reason: 'need:craft_gear(0.70)',
    knowledgeUsed: { hazardCount: 0, biome: 'plains' },
    chosenTask: 'craft_gear',
    steps: [{ skill: 'collect', params: { item: 'raw_iron' } }],
    suggestionsConsidered: [],
  });

  const latest = trace.latest();
  assert(latest !== null, 'latest() returns an entry');
  assertEqual(latest.goal, 'craft_gear', 'Entry records correct goal');

  const logFile = path.join(testDir, 'decision_trace.log');
  assert(fs.existsSync(logFile), 'Trace log file created on disk');

  const content = fs.readFileSync(logFile, 'utf-8');
  assert(content.includes('craft_gear'), 'Log file contains the recorded goal');
  cleanup();
}

// ─────────────────────────────────────────────────────────────
// 3. DecisionTrace — full cognitive trace stages
// ─────────────────────────────────────────────────────────────
console.log('\n=== 3. DecisionTrace — Cognitive trace stages ===\n');

{
  cleanup();
  const trace = new DecisionTrace({ username: TEST_USER, capacity: 10 });

  trace.beginTrace();
  trace.recordPerception({ threats: [] }, { threats: 0 });
  trace.recordBeliefUpdate({ snapshot: {} }, { hazardsNearby: false }, 'No hazards');
  trace.recordPlanning(
    { needs: [{ name: 'explore_unknown', score: 0.175 }] },
    { selected: 'explore_unknown', score: 0.175 },
    'Chosen: explore_unknown'
  );
  trace.recordTaskSelection(
    { goal: 'explore_unknown' },
    { task: 'explore_unknown', steps: ['move_to'] }
  );
  trace.recordAction(
    { action: 'move_to', params: { x: 10, y: 65, z: 10 } },
    { result: 'completed' }
  );
  trace.recordResult('completed', 'Task finished successfully');
  trace.recordLearning(
    { experienceId: 'exp_1' },
    { hazardAlert: 0, failureCaution: 0 },
    'No adjustment needed'
  );

  trace.record({
    goal: 'explore_unknown',
    need: 'explore_unknown',
    score: 0.175,
    reason: 'need:explore_unknown(0.18)',
    knowledgeUsed: { hazardCount: 0, biome: 'plains' },
    chosenTask: 'explore_unknown',
    steps: [{ skill: 'move_to', params: { x: 10, y: 65, z: 10 } }],
    suggestionsConsidered: [],
  });
  const latest = trace.latest();
  assert(latest !== null, 'commitTrace saves the full trace');
  assert(latest.perception !== null, 'Perception stage recorded');
  assert(latest.beliefUpdate !== null, 'BeliefUpdate stage recorded');
  assert(latest.planning !== null, 'Planning stage recorded');
  assert(latest.taskSelection !== null, 'TaskSelection stage recorded');
  assert(latest.action !== null, 'Action stage recorded');
  assert(latest.result !== null, 'Result stage recorded');
  assert(latest.learning !== null, 'Learning stage recorded');

  const logFile = path.join(testDir, 'decision_trace.log');
  const content = fs.readFileSync(logFile, 'utf-8');
  assert(content.includes('explore_unknown'), 'Full trace written to log file');
  cleanup();
}

// ─────────────────────────────────────────────────────────────
// 4. LearningEngine → Experience → ExperienceStore → disk
// ─────────────────────────────────────────────────────────────
console.log('\n=== 4. LearningEngine — Task lifecycle produces persisted experience ===\n');

{
  cleanup();

  const busEvents = [];
  const busHandlers = {};
  const bus = {
    on: (name, fn) => { if (!busHandlers[name]) busHandlers[name] = []; busHandlers[name].push(fn); },
    emit: (name, data) => {
      busEvents.push({ name, data });
      (busHandlers[name] || []).forEach(fn => fn(data));
    },
  };
  const knowledge = {
    getServerType: () => ({ type: 'survival' }),
    getCurrentServer: () => ({ name: 'e2e-test-server' }),
  };
  const memory = {};
  const beliefs = { vitality: { health: 20, food: 20 }, threats: [], position: { x: 0, y: 65, z: 0 } };
  const motorCortex = {
    activeContext: {
      goal: 'craft_gear',
      steps: [{ skill: 'collect', params: { item: 'raw_iron' } }, { skill: 'smelt', params: { input: 'raw_iron' } }],
      currentStepIndex: 2,
    },
  };
  const trace = new DecisionTrace({ username: TEST_USER });

  const engine = new LearningEngine({
    bus,
    knowledge,
    memory,
    beliefs,
    motorCortex,
    trace,
    username: TEST_USER,
  });

  bus.emit('task_started', { taskName: 'craft_gear', context: { steps: motorCortex.activeContext.steps } });
  bus.emit('task_completed', { taskName: 'craft_gear' });

  const stats = engine.getStats();
  assert(stats.totalExperiences >= 1, 'At least one experience stored');
  assert(stats.goalsTracked >= 1, 'At least one goal tracked');

  const store = engine.experienceStore;
  store.flush();
  const allExps = store.getAll();
  assert(allExps.length >= 1, 'ExperienceStore has records');

  const exp = allExps.find(e => e.goal === 'craft_gear');
  assert(exp !== undefined, 'Found craft_gear experience');
  assert(exp.isSuccess(), 'Completed task is success');
  assertEqual(exp.result, 'completed', 'Result is completed');

  const experienceFile = path.join(testDir, 'experiences.json');
  assert(fs.existsSync(experienceFile), 'experiences.json file created on disk');

  const diskContent = JSON.parse(fs.readFileSync(experienceFile, 'utf-8'));
  assert(Array.isArray(diskContent), 'Disk file is an array');
  assert(diskContent.length >= 1, 'Disk file has at least one experience');

  const diskExp = diskContent.find(e => e.goal === 'craft_gear');
  assert(diskExp !== undefined, 'Disk experience has craft_gear');
  assertEqual(diskExp.result, 'completed', 'Disk experience result is completed');
  assert(diskExp.version !== undefined, 'Disk experience has version metadata');
  assert(diskExp.id !== undefined, 'Disk experience has unique ID');
  assert(diskExp.reward !== undefined, 'Disk experience has reward');

  cleanup();
}

// ─────────────────────────────────────────────────────────────
// 5. LearningEngine — failed task also persists
// ─────────────────────────────────────────────────────────────
console.log('\n=== 5. LearningEngine — Failed task persists ===\n');

{
  cleanup();

  const busEvents = [];
  const busHandlers2 = {};
  const bus = {
    on: (name, fn) => { if (!busHandlers2[name]) busHandlers2[name] = []; busHandlers2[name].push(fn); },
    emit: (name, data) => {
      busEvents.push({ name, data });
      (busHandlers2[name] || []).forEach(fn => fn(data));
    },
  };
  const knowledge = {
    getServerType: () => ({ type: 'survival' }),
    getCurrentServer: () => ({ name: 'e2e-test-server' }),
  };
  const memory = {};
  const beliefs = { vitality: { health: 10, food: 8 }, threats: [{ type: 'zombie' }], position: { x: 0, y: 40, z: 0 } };
  const motorCortex = {
    activeContext: {
      goal: 'seek_safety',
      steps: [{ skill: 'go_surface', params: {} }],
      currentStepIndex: 0,
    },
  };
  const trace = new DecisionTrace({ username: TEST_USER });

  const engine = new LearningEngine({
    bus,
    knowledge,
    memory,
    beliefs,
    motorCortex,
    trace,
    username: TEST_USER,
  });

  bus.emit('task_started', { taskName: 'seek_safety', context: { steps: motorCortex.activeContext.steps } });
  bus.emit('task_failed', { taskName: 'seek_safety', error: 'creeper exploded' });

  const store = engine.experienceStore;
  store.flush();
  const allExps = store.getAll();
  const failedExp = allExps.find(e => e.goal === 'seek_safety');

  assert(failedExp !== undefined, 'Failed experience stored');
  assert(failedExp.isFailure(), 'Failed experience marked as failure');
  assertEqual(failedExp.failureReason, 'creeper exploded', 'Failure reason preserved');

  const experienceFile = path.join(testDir, 'experiences.json');
  const diskContent = JSON.parse(fs.readFileSync(experienceFile, 'utf-8'));
  const diskFailed = diskContent.find(e => e.goal === 'seek_safety');
  assert(diskFailed !== undefined, 'Failed experience on disk');
  assertEqual(diskFailed.result, 'failed', 'Disk result is failed');
  assertEqual(diskFailed.failureReason, 'creeper exploded', 'Disk failure reason preserved');

  cleanup();
}

// ─────────────────────────────────────────────────────────────
// 6. ExecutiveBrain — no hazards means other goals selected
// ─────────────────────────────────────────────────────────────
console.log('\n=== 6. ExecutiveBrain — No hazards, other needs dominate ===\n');

{
  const memory = { recordFailure: () => {} };
  const personality = {
    traits: { curiosity: 0.5, sociability: 0.3, bravery: 0.7 },
    allowsRiskyTasks: () => true,
    evaluateMood: () => 'Neutral',
    getDialogueTone: () => 'hi',
  };
  const tom = {};
  const bus = { emit: () => {}, on: () => {} };
  const knowledge = {
    snapshot: (pos) => ({
      hasSafeBase: false, nearestSafeBase: null, nearestFoodSource: null, nearbyFoodSources: [],
      nearestWarp: null, hazardsNearby: false, hazardCount: 0, knownWarpCount: 0,
      knownWarps: [], knownNPCs: [], knownCommands: [], dimension: 'overworld', biome: 'plains',
      position: pos, vitality: { health: 20, food: 20, hasFood: true }, threats: [],
      nearbyNPCs: [], nearbyPlayers: [], nearbyHazards: [],
      openGui: null, scoreboard: { title: null, lines: [] },
      currentServer: { name: 'test', motd: null, version: null, pvp: false, claimSystem: null, spawn: null },
      economy: { enabled: false, currency: null, symbols: [] },
      serverKnowledge: { commandCount: 0, plugins: [], name: null, economy: null },
      recentEpisodes: [], recentHazardWarnings: [],
    }),
  };

  const brain = new ExecutiveBrain(memory, personality, tom, bus, { knowledge });

  const snapshot = {
    vitality: { health: 20, food: 18, hasFood: true },
    threats: [],
    equipment: { hasDiamondArmor: false, hasIronArmor: false, hasShield: false, hasWaterBucket: false },
    resources: { hasFood: true, hasCraftingTable: false, hasFurnace: false, hasBed: false, hasOre: () => false, inventory: [] },
    environment: { position: { x: 0, y: 65, z: 0 }, isNight: false, biome: 'plains', nearestChest: null, nearestBed: null, nearestWorkstation: null },
    social: { nearbyPlayers: [] },
  };

  const result = brain.decide(snapshot);
  assertNotEqual(result.task, 'avoid_hazard', 'Without hazards, avoid_hazard is not selected');
  assert(result.steps.length > 0, 'Decision produces steps');
  assert(result.context !== undefined, 'Decision produces task context');
}

// ─────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────
console.log(`\n=== Results ===\n`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

if (failed > 0) {
  console.log(`\n  ✗ Some integration validations failed!\n`);
  process.exit(1);
} else {
  console.log(`\n  All integration validations passed! ✓\n`);
}

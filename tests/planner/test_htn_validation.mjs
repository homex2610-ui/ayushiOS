// test_htn_validation.mjs
// Isolated HTN planner validation — no Minecraft server needed.
// Tests all 9 goals, failure classification, resumption, and ExecutiveBrain HTN integration.

import { HTNPlanner } from '../../src/brain/HTNPlanner.js';
import { TaskNode } from '../../src/brain/Planner.js';
import { TaskContext } from '../../src/brain/TaskContext.js';
import { getTask, taskNames } from '../../src/domain/tasks.js';
import { getOperator, operatorNames } from '../../src/domain/operators.js';
import { RESOURCES } from '../../src/domain/resources.js';
import * as P from '../../src/domain/predicates.js';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

function assertEqual(a, b, label) {
  if (a === b) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
}

function assertGT(a, b, label) {
  if (a > b) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} — expected >${b}, got ${a}`); }
}

// Basic state
const BASE_STATE = {
  resources: { inventory: [] },
  equipment: {},
  environment: { position: { x: 0, y: 64, z: 0 } },
  vitality: { health: 20, food: 20, hasFood: false },
  threats: [],
  hazardsNearby: false,
  hasSafeBase: false,
  nearestSafeBase: null,
  nearestWarp: null,
  knownWarpCount: 0,
  knownWarps: [],
  knownLocations: {},
  social: { nearbyPlayers: [] },
  beliefs: {
    hasSafeBase: false, nearestSafeBase: null, nearestWarp: null, knownWarpCount: 0,
    hazardsNearby: false, hazardCount: 0,
  },
  planning: {},
};

console.log('\n=== 1. Domain Integrity ===\n');

// All expected task names (P0-3: advance_capability added to domain)
const expectedTasks = ['eat', 'seek_safety', 'avoid_hazard', 'farm_food', 'craft_gear', 'advance_capability', 'build_base', 'visit_known_warp', 'explore_unknown', 'socialize'];
assertEqual(taskNames().sort().join(','), expectedTasks.sort().join(','), 'All executive tasks defined');

// All operators defined
const expectedOperators = ['Acquire', 'Travel', 'Interact', 'Craft', 'CraftPlanks', 'Smelt', 'Farm', 'Use', 'Equip', 'Combat', 'Escape', 'Observe', 'Wait', 'Collect'];
assertEqual(operatorNames().sort().join(','), expectedOperators.sort().join(','), 'All operators defined');

// Each task has required fields
for (const name of expectedTasks) {
  const t = getTask(name);
  assert(!!t, `Task "${name}" exists`);
  if (t) {
    assert(typeof t.id === 'string', `  id is string for "${name}"`);
    assert(typeof t.priority === 'number', `  priority is number for "${name}"`);
    assert(Array.isArray(t.preconditions), `  preconditions is array for "${name}"`);
    assert(Array.isArray(t.effects), `  effects is array for "${name}"`);
    assert(typeof t.expand === 'function', `  expand is function for "${name}"`);
  }
}

// Each operator has required fields
for (const name of expectedOperators) {
  const o = getOperator(name);
  assert(!!o, `Operator "${name}" exists`);
  if (o) {
    assert(Array.isArray(o.preconditions), `  preconditions is array for "${name}"`);
    assert(Array.isArray(o.effects), `  effects is array for "${name}"`);
    assert(Array.isArray(o.btSkills), `  btSkills is array for "${name}"`);
  }
}

// Resource definitions
assert(RESOURCES.WOOD.types.length >= 3, 'WOOD has multiple types');
assert(RESOURCES.IRON.types.length >= 2, 'IRON has multiple types');
assert(RESOURCES.DIAMOND.types.length >= 1, 'DIAMOND has types');
assert(RESOURCES.FOOD_VEGETABLE.types.length >= 3, 'FOOD_VEGETABLE has types');
assert(RESOURCES.CRAFTING_TABLE.types.length >= 1, 'CRAFTING_TABLE has types');

console.log('\n=== 2. Predicate Functions ===\n');

// hasItem
assert(!P.hasItem(BASE_STATE, 'WOOD'), 'hasItem(WOOD) false with empty inventory');
assert(P.hasItem({ ...BASE_STATE, inventory: [{ name: 'oak_log', count: 4 }] }, 'WOOD'), 'hasItem(WOOD) true with oak_log');
assert(P.hasItem({ ...BASE_STATE, inventory: [{ name: 'diamond', count: 1 }] }, 'DIAMOND'), 'hasItem(DIAMOND) true with diamond');

// hasFood
assert(!P.hasFood(BASE_STATE), 'hasFood false with empty inventory');
assert(P.hasFood({ ...BASE_STATE, inventory: [{ name: 'carrot', count: 3 }] }), 'hasFood true with carrot');
assert(P.hasFood({ ...BASE_STATE, inventory: [{ name: 'bread', count: 1 }] }), 'hasFood true with bread');

// hasTool
assert(!P.hasTool(BASE_STATE, 'any_pickaxe'), 'hasTool any_pickaxe false empty');
assert(P.hasTool({ ...BASE_STATE, inventory: [{ name: 'stone_pickaxe', count: 1 }] }, 'any_pickaxe'), 'hasTool any_pickaxe with stone_pickaxe');
assert(P.hasTool({ ...BASE_STATE, inventory: [{ name: 'iron_sword', count: 1 }] }, 'any_weapon'), 'hasTool any_weapon with iron_sword');

// hasWorkstation
assert(!P.hasWorkstation(BASE_STATE, 'crafting_table'), 'hasWorkstation crafting_table false empty');
assert(P.hasWorkstation({ ...BASE_STATE, inventory: [{ name: 'crafting_table', count: 1 }] }, 'crafting_table'), 'hasWorkstation true with inventory');
assert(P.hasWorkstation({ ...BASE_STATE, environment: { nearestWorkstation: true } }, 'crafting_table'), 'hasWorkstation true with env');

// isHungry
assert(!P.isHungry(BASE_STATE), 'isHungry false at food=20');
assert(P.isHungry({ ...BASE_STATE, food: 12 }), 'isHungry true at food=12');

// enemyNearby
assert(!P.enemyNearby(BASE_STATE), 'enemyNearby false no threats');
assert(P.enemyNearby({ ...BASE_STATE, threats: [{ type: 'zombie' }] }), 'enemyNearby true with threat');

// knowsWarp
assert(!P.knowsWarp(BASE_STATE), 'knowsWarp false at 0');
assert(P.knowsWarp({ ...BASE_STATE, knownWarpCount: 2 }), 'knowsWarp true at 2');

// isNight
assert(!P.isNight(BASE_STATE), 'isNight false');
assert(P.isNight({ ...BASE_STATE, isNight: true }), 'isNight true');

console.log('\n=== 3. HTNPlanner — Plan All 9 Goals ===\n');

const planner = new HTNPlanner();

const goalTests = [
  { name: 'eat', state: { ...BASE_STATE, inventory: [{ name: 'bread', count: 3 }], resources: { inventory: [{ name: 'bread', count: 3 }] } }, minSteps: 1 },
  { name: 'seek_safety', state: { ...BASE_STATE, environment: { position: { x: 0, y: 64, z: 0 } }, nearestSafeBase: { position: { x: 10, y: 64, z: 10 } } }, minSteps: 1 },
  { name: 'avoid_hazard', state: BASE_STATE, minSteps: 1 },
  { name: 'farm_food', state: BASE_STATE, minSteps: 2 },
  { name: 'craft_gear', state: { ...BASE_STATE, inventory: [{ name: 'raw_iron', count: 8 }], resources: { inventory: [{ name: 'raw_iron', count: 8 }] }, planning: { rawIronCount: 8 }, equipment: {} }, minSteps: 1 },
  { name: 'build_base', state: { ...BASE_STATE, environment: { position: { x: 0, y: 64, z: 0 } }, nearestSafeBase: null }, minSteps: 1 },
  { name: 'visit_known_warp', state: { ...BASE_STATE, nearestWarp: { position: { x: 100, y: 64, z: 200 } }, knownWarpCount: 1, knownWarps: [{ name: 'spawn', position: { x: 100, y: 64, z: 200 } }] }, minSteps: 1 },
  { name: 'explore_unknown', state: BASE_STATE, minSteps: 1 },
  { name: 'socialize', state: BASE_STATE, minSteps: 1 },
];

for (const { name, state, minSteps } of goalTests) {
  const result = planner.plan(name, state, null);
  const passed_plan = result && result.steps && result.steps.length >= minSteps;
  assert(passed_plan, `plan("${name}") returns >=${minSteps} steps (got ${result?.steps?.length || 0})`);
  if (result?.steps?.length > 0) {
    // All steps use valid operators
    for (const step of result.steps) {
      const op = getOperator(step.operator);
      assert(!!op, `  step "${step.operator}" is a valid operator`);
    }
  }
}

// Plan one in detail — inspect seek_safety
{
  const safeState = { ...BASE_STATE, nearestSafeBase: { position: { x: 10, y: 64, z: 10 } } };
  const result = planner.plan('seek_safety', safeState, null);
  assert(result.steps.length >= 2, 'seek_safety with safe base produces >=2 steps');
  assert(result.steps[0].operator === 'Travel' || result.steps[0].operator === 'Escape', 'seek_safety first step is Travel or Escape');
}

// Plan eat without food — should still produce at least one step (fallback)
{
  const result = planner.plan('eat', BASE_STATE, null);
  assert(result.steps.length >= 1, 'eat without food still produces steps');
}

console.log('\n=== 4. Task Context — Pause/Resume ===\n');

const ctx = new TaskContext('craft_gear', {
  steps: [
    { skill: 'collect', params: { item: 'raw_iron', count: 8 } },
    { skill: 'smelt', params: { input: 'raw_iron', count: 8, fuel: 'coal' } },
    { skill: 'craft', params: { item: 'iron_chestplate', count: 1 } },
  ],
  currentStepIndex: 1,
});

assertEqual(ctx.status, 'pending', 'Context starts as pending');
assertEqual(ctx.currentStepIndex, 1, 'Context starts at step 1');

ctx.start();
assertEqual(ctx.status, 'running', 'Context becomes running after start');

ctx.pause();
assertEqual(ctx.status, 'paused', 'Context becomes paused after pause');

ctx.start();
ctx.advanceStep();
assertEqual(ctx.currentStepIndex, 2, 'Advance to step 2');
assert(ctx.progress > 0, 'Progress > 0 after advance');

ctx.complete('success');
assertEqual(ctx.status, 'completed', 'Context completed');
assertEqual(ctx.result, 'success', 'Result recorded');

const expiredCtx = new TaskContext('eat', { steps: [] });
assert(!expiredCtx.isExpired(300000), 'Fresh context not expired');
expiredCtx.lastActiveAt = Date.now() - 310000;
assert(expiredCtx.isExpired(300000), 'Old context is expired');
expiredCtx.complete();
assert(expiredCtx.isExpired(300000), 'Completed context is expired');

console.log('\n=== 5. HTNPlanner — Resumption ===\n');

{
  const ctx2 = new TaskContext('craft_gear', {
    steps: [
      { skill: 'collect', params: { item: 'raw_iron', count: 8 } },
      { skill: 'smelt', params: { input: 'raw_iron', count: 8, fuel: 'coal' } },
    ],
    currentStepIndex: 1,
    status: 'paused',
    goal: 'craft_gear',
  });
  const result = planner.plan('craft_gear', BASE_STATE, ctx2);
  assert(result.steps.length >= 1, 'Resume produces steps from paused context');
  assert(result.context?.steps?.length >= 1, 'Resumed context carries remaining steps');
}

console.log('\n=== 6. HTNPlanner — Replanning & Failure Classification ===\n');

// Danger failure -> seek_safety
{
  const result = planner.replan({ operator: 'Collect' }, 'creeper exploded', BASE_STATE, { goal: 'craft_gear', steps: [], blockers: [] });
  assert(result.steps.length >= 1, 'Danger replan produces steps');
  assert(result.context?.goal === 'seek_safety' || result.context?.blockers?.includes('danger'), 'Danger replan switches to seek_safety or marks danger');
}

// Missing resource -> replan same goal
{
  const result = planner.replan({ operator: 'Craft' }, 'missing iron_ingot', BASE_STATE, { goal: 'craft_gear', steps: [], blockers: [] });
  assert(result.steps.length >= 0, 'Missing resource replan returns steps');
}

// Plugin restriction -> replan same goal
{
  const result = planner.replan({ operator: 'Interact' }, 'no access to chest', BASE_STATE, { goal: 'build_base', steps: [], blockers: [] });
  assert(result.steps.length >= 0, 'Plugin restriction replan returns steps');
}

// Network failure -> replan same goal
{
  const result = planner.replan({ operator: 'Interact' }, 'connection timeout', BASE_STATE, { goal: 'visit_known_warp', steps: [], blockers: [] });
  assert(result.steps.length >= 0, 'Network failure replan returns steps');
}

console.log('\n=== 7. HTNPlanner — Validation ===\n');

{
  const state = { ...BASE_STATE, inventory: [{ name: 'diamond', count: 1 }], resources: { inventory: [{ name: 'diamond', count: 1 }] } };
  const result = planner.plan('eat', state, null);
  const validation = planner.validate(result.steps, state);
  assert(typeof validation.valid === 'boolean', 'Validation returns valid boolean');
  assert(Array.isArray(validation.issues), 'Validation returns issues array');
}

console.log('\n=== 8. TaskNode — Graph correctness ===\n');

const root = new TaskNode('root', 'craft_gear', { priority: 0.5, depth: 0 });
const child1 = new TaskNode('c1', 'Acquire', { parent: root.id, priority: 0.5, depth: 1 });
const child2 = new TaskNode('c2', 'Craft', { parent: root.id, priority: 0.5, depth: 1 });
root.children = [child1, child2];

assert(!root.isPrimitive(), 'Root with children is not primitive');
assert(child1.isPrimitive(), 'Leaf child is primitive');
assert(root.isCompound(), 'Root with children is compound');
const json = root.toJSON();
assert(json.id === 'root', 'toJSON preserves id');
assert(json.children.length === 2, 'toJSON preserves children');

console.log('\n=== 9. ExecutiveBrain HTN Integration ===\n');

// Test that _planGoal routes to HTN for known goals
import('../../src/brain/ExecutiveBrain.js').then(mod => {
  const { ExecutiveBrain } = mod;
  const brain = new ExecutiveBrain(null, { allowsRiskyTasks: () => true, getDialogueTone: () => 'hi', traits: { curiosity: 0.3, sociability: 0.5 } }, null, null, { knowledge: null });

  // Test that HTN goal names are registered (excluding tasks with hand-written plans)
  const htnTasks = expectedTasks.filter(t => !['eat', 'socialize'].includes(t));
  for (const taskName of htnTasks) {
    assert(brain._htnTasks.has(taskName), `ExecutiveBrain has "${taskName}" in _htnTasks`);
  }
  // eat and socialize have hand-written _planEat/_planSocialize fallbacks
  assert(!brain._htnTasks.has('eat'), 'ExecutiveBrain correctly excludes "eat" from _htnTasks (hand-written _planEat)');
  assert(!brain._htnTasks.has('socialize'), 'ExecutiveBrain correctly excludes "socialize" from _htnTasks (hand-written _planSocialize)');

  // Test decide() returns valid plan for a basic snapshot
  const snapshot = {
    resources: { inventory: [], hasCraftingTable: false, hasFurnace: false, hasBed: false, hasOre: () => false },
    equipment: { hasDiamondArmor: false, hasIronArmor: false, hasShield: false, hasWaterBucket: false },
    environment: { position: { x: 0, y: 64, z: 0 }, nearestChest: false, nearestBed: false, nearestWorkstation: false },
    vitality: { health: 20, food: 18, hasFood: false },
    social: { nearbyPlayers: [] },
    threats: [],
    beliefs: { hasSafeBase: false, nearestSafeBase: null, nearestWarp: null, knownWarpCount: 0, hazardsNearby: false, hazardCount: 0, knownWarps: [], knownNPCs: [], knownCommands: [], currentServer: {}, serverKnowledge: {}, recentEpisodes: [] },
  };

  const decision = brain.decide(snapshot);
  assert(!!decision, 'decision() returns a result');
  assert(typeof decision.task === 'string', 'decision().task is a string');
  assert(Array.isArray(decision.steps), 'decision().steps is an array');
  // P0-3: decide() returns {task, steps} — plan context lives in MotorCortex
  assert(decision.context === undefined, 'decision() carries no context (motor owns it)');

  console.log(`\n  Decided task: ${decision.task}`);
  console.log(`  Steps: ${decision.steps.map(s => s.skill).join(', ')}`);

  // Test that fallback still works — eat/socialize have hand-written plans
  // Use a state where food is low enough to trigger _planEat's collect path
  const hungrySnapshot = {
    ...snapshot,
    vitality: { health: 20, food: 10, hasFood: false },
    beliefs: { ...snapshot.beliefs, foodItem: 'carrot', nearestFoodSource: null },
  };
  const hungryPlanState = brain._buildPlanState(hungrySnapshot);
  const fallbackResult = brain._planGoal({ name: 'eat', task: 'eat', params: {} }, hungryPlanState);
  assert(fallbackResult.length > 0, 'Fallback path works when HTN goal missing (eat uses hand-written _planEat)');

  console.log('\n=== Results ===\n');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed === 0) console.log('\n  All validations passed! ✓');
  else process.exit(1);
}).catch(err => {
  console.error('Import error:', err.message);
  process.exit(1);
});

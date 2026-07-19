// test_learning.mjs
// Isolated Phase 3 Learning validation — no bot/server needed.
// Tests Experience, RewardModel, ExperienceStore, SkillRepository, LearningEngine.

import { Experience } from '../../src/learning/Experience.js';
import { RewardModel } from '../../src/learning/RewardModel.js';
import { ExperienceStore } from '../../src/learning/ExperienceStore.js';
import { SkillRepository } from '../../src/learning/SkillRepository.js';
import { VERSIONS } from '../../src/learning/Version.js';

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

function assertLT(a, b, label) {
  if (a < b) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label} — expected <${b}, got ${a}`); }
}

// Use a temp username for store tests
const TEST_USER = '_test_learning_runner';

console.log('\n=== 1. Experience — Construction and Queries ===\n');

{
  const exp = new Experience({
    goal: 'craft_gear',
    serverType: 'survival',
    result: 'completed',
    duration: 45000,
    actions: [
      { skill: 'collect', params: { item: 'raw_iron' }, duration: 30000, status: 'completed' },
      { skill: 'smelt', params: { input: 'raw_iron' }, duration: 10000, status: 'completed' },
      { skill: 'craft', params: { item: 'iron_chestplate' }, duration: 5000, status: 'completed' },
    ],
    taskGraph: [
      { skill: 'collect', status: 'completed' },
      { skill: 'smelt', status: 'completed' },
      { skill: 'craft', status: 'completed' },
    ],
    beliefsSnapshot: { health: 20, food: 18, threats: [] },
    interruptions: [],
  });

  assert(exp.isSuccess(), 'isSuccess true for completed');
  assert(!exp.isFailure(), 'isFailure false for completed');
  assert(!exp.wasInterrupted(), 'No interruptions detected');
  assertEqual(exp.effectiveDuration(), 45000, 'Effective duration returned');
  assert(!!exp.primaryAction(), 'Primary action found');
  assertEqual(exp.primaryAction().skill, 'collect', 'Primary action is longest step');

  const json = exp.toJSON();
  assertEqual(json.goal, 'craft_gear', 'toJSON preserves goal');
  assertEqual(json.result, 'completed', 'toJSON preserves result');
  assertEqual(json.actions.length, 3, 'toJSON preserves actions');
  assertEqual(json.reward, 0, 'Initial reward is 0');
}

{
  const failedExp = new Experience({
    goal: 'seek_safety',
    result: 'failed',
    failureReason: 'creeper exploded',
    actions: [{ skill: 'go_surface', duration: 5000, status: 'failed' }],
  });
  assert(failedExp.isFailure(), 'isFailure true for failed');
  assert(!failedExp.isSuccess(), 'isSuccess false for failed');
  assertEqual(failedExp.failureReason, 'creeper exploded', 'Failure reason preserved');
}

{
  const interruptedExp = new Experience({
    goal: 'explore_unknown',
    result: 'interrupted',
    interruptions: [{ reason: 'emergency', at: Date.now() }],
  });
  assert(interruptedExp.wasInterrupted(), 'Interruption detected');
  assert(!interruptedExp.isSuccess(), 'Interrupted is not success');
}

console.log('\n=== 2. RewardModel — Scoring ===\n');

{
  const rm = new RewardModel();

  // Successful goal with no interruptions
  const goodExp = new Experience({
    goal: 'craft_gear',
    result: 'completed',
    duration: 25000,
    actions: [{ skill: 'craft', duration: 5000, status: 'completed' }, { skill: 'craft', duration: 5000, status: 'completed' }],
    beliefsSnapshot: { health: 20, food: 18 },
    interruptions: [],
    lessonsLearned: [],
  });
  const goodReward = rm.calculate(goodExp);
  assertGT(goodReward, 50, 'Successful task earns positive reward');
  assertLT(goodReward, 200, 'Positive reward within bounds');

  // Failed goal with death
  const deathExp = new Experience({
    goal: 'seek_safety',
    result: 'failed',
    failureReason: 'died to creeper',
    duration: 5000,
    actions: [{ skill: 'go_surface', duration: 5000, status: 'failed' }],
  });
  const deathReward = rm.calculate(deathExp);
  assertLT(deathReward, 0, 'Death task gets negative reward');
  assertGT(deathReward, -100, 'Death penalty within bounds');

  // Interrupted goal
  const interruptExp = new Experience({
    goal: 'craft_gear',
    result: 'interrupted',
    interruptions: [{ reason: 'hunger', at: Date.now() }],
    actions: [{ skill: 'collect', duration: 10000, status: 'interrupted' }],
  });
  const interruptReward = rm.calculate(interruptExp);
  assertLT(interruptReward, 0, 'Interrupted task gets negative reward');

  // Goal with lessons learned
  const learnedExp = new Experience({
    goal: 'build_base',
    result: 'completed',
    duration: 60000,
    actions: [{ skill: 'collect', duration: 40000, status: 'completed' }],
    lessonsLearned: ['fast execution', 'ensure area safe'],
  });
  const learnedReward = rm.calculate(learnedExp);
  assertGT(learnedReward, 80, 'Task with lessons gets bonus reward');
}

console.log('\n=== 3. ExperienceStore — Persistence ===\n');

{
  const bus = { events: [], on(ev, fn) { this.events.push({ ev, fn }); }, emit(ev, data) {} };
  const store = new ExperienceStore(TEST_USER, { bus });
  store.clear();
  assertEqual(store.totalExperiences(), 0, 'Empty store after clear');

  const exp1 = new Experience({ goal: 'craft_gear', result: 'completed', actions: [{ skill: 'craft', status: 'completed' }] });
  const exp2 = new Experience({ goal: 'seek_safety', result: 'failed', failureReason: 'creeper', actions: [{ skill: 'go_surface', status: 'failed' }] });
  const exp3 = new Experience({ goal: 'eat', result: 'completed', actions: [{ skill: 'eat', status: 'completed' }] });

  store.add(exp1);
  store.add(exp2);
  store.add(exp3);

  assertEqual(store.totalExperiences(), 3, 'Store has 3 experiences');
  assertEqual(store.getByGoal('craft_gear').length, 1, '1 craft_gear experience');
  assertEqual(store.getByGoal('seek_safety').length, 1, '1 seek_safety experience');
  assertEqual(store.getRecent(2).length, 2, 'Recent returns 2 latest');

  assertEqual(store.successRate('craft_gear'), 1, '100% success for craft_gear');
  assertEqual(store.successRate('seek_safety'), 0, '0% success for seek_safety');
  assertEqual(store.getSuccesses('craft_gear').length, 1, '1 success for craft_gear');
  assertEqual(store.getFailures('seek_safety').length, 1, '1 failure for seek_safety');

  // Persistence test — flush async writes, then verify data persists across instances
  store.flush();
  const store2 = new ExperienceStore(TEST_USER);
  assertEqual(store2.totalExperiences(), 3, 'Data persists across instances');

  store2.clear();
  store2.flush();
  const store3 = new ExperienceStore(TEST_USER);
  assertEqual(store3.totalExperiences(), 0, 'Clear removes all data');
}

console.log('\n=== 4. SkillRepository — Statistics ===\n');

{
  const skills = new SkillRepository(TEST_USER);
  skills.clear();

  // Simulate several experiences for the same goal
  const makeExp = (goal, result, serverType, failureReason = null, duration = 30000) => {
    return new Experience({
      goal,
      result,
      serverType,
      failureReason,
      duration,
      actions: [{ skill: 'collect', duration: 20000, status: result === 'completed' ? 'completed' : 'failed' }],
      reward: result === 'completed' ? 100 : -30,
    });
  };

  skills.updateFromExperience(makeExp('craft_gear', 'completed', 'survival'));
  skills.updateFromExperience(makeExp('craft_gear', 'completed', 'survival'));
  skills.updateFromExperience(makeExp('craft_gear', 'failed', 'survival', 'missing_iron'));
  skills.updateFromExperience(makeExp('craft_gear', 'completed', 'lifesteal'));
  skills.updateFromExperience(makeExp('seek_safety', 'failed', 'survival', 'creeper'));

  // Check skill was created
  const gearSkills = skills.getSkillsForGoal('craft_gear');
  assert(gearSkills.length > 0, 'Skills created for craft_gear');

  const bestSkill = skills.getBestSkill('craft_gear');
  assert(!!bestSkill, 'Best skill found');
  assertGT(bestSkill.optimal.successRate, 0.5, 'Best skill has >50% success rate');

  const survivalSkill = skills.getSkillForServer('craft_gear', 'survival');
  assert(!!survivalSkill, 'Skill for survival found');
  assertEqual(survivalSkill.serverTypes['survival'].attempts, 3, '3 attempts on survival');

  // Average duration
  const avgDuration = skills.averageDuration('craft_gear');
  assertGT(avgDuration, 0, 'Average duration calculated');

  // Success rate
  const successRate = skills.successRate('craft_gear');
  assertGT(successRate, 0.5, 'Success rate > 50%');
  assertLT(successRate, 1, 'Success rate < 100%');

  // Common failures
  const failures = skills.commonFailureReasons('craft_gear');
  assert(failures.length >= 1, 'Failure reasons tracked');
  assertEqual(failures[0].reason, 'missing_iron', 'Most common failure is missing_iron');

  // All skills list
  const all = skills.allSkills();
  assert(all.length >= 2, 'Multiple skills tracked');

  skills.clear();
  assertEqual(skills.allSkills().length, 0, 'Clear removes skills');
}

console.log('\n=== 5. SkillRepository — Confidence Growth ===\n');

{
  const skills = new SkillRepository(TEST_USER);
  skills.clear();

  const makeExp = (goal, result) => new Experience({ goal, result, actions: [{ skill: 'craft', status: result === 'completed' ? 'completed' : 'failed' }] });

  // Low confidence initially
  skills.updateFromExperience(makeExp('test_conf', 'completed'));
  const skill1 = skills.getBestSkill('test_conf');
  assertEqual(skill1.confidence, 0.35, 'Confidence starts at 0.35 after 1 attempt');

  // Confidence grows with more attempts
  for (let i = 0; i < 10; i++) {
    skills.updateFromExperience(makeExp('test_conf', 'completed'));
  }
  const skill2 = skills.getBestSkill('test_conf');
  assertGT(skill2.confidence, 0.6, 'Confidence grows with attempts');

  skills.clear();
}

console.log('\n=== 6. Experience — Edge Cases ===\n');

{
  // No actions
  const empty = new Experience({ goal: 'idle', result: 'completed' });
  assertEqual(empty.effectiveDuration(), 0, 'Empty actions duration is 0');
  assert(!empty.primaryAction(), 'No primary action for empty');

  // Multiple interruptions
  const multiInterrupt = new Experience({
    goal: 'craft_gear',
    result: 'failed',
    interruptions: [
      { reason: 'creeper', at: 1000 },
      { reason: 'hunger', at: 2000 },
    ],
    actions: [{ skill: 'collect', duration: 500, status: 'interrupted' }],
    failureReason: 'too many interruptions',
  });
  assertEqual(multiInterrupt.interruptions.length, 2, 'Multiple interruptions tracked');
  assert(multiInterrupt.wasInterrupted(), 'Multiple interruptions detected');
  assert(multiInterrupt.isFailure(), 'Interrupted by failure is still failure');

  // Very fast completion
  const fast = new Experience({ goal: 'eat', result: 'completed', duration: 500, actions: [{ skill: 'eat', duration: 500, status: 'completed' }] });
  assert(fast.isSuccess(), 'Fast completion is success');
}

console.log('\n=== 7. Version provenance (central Version.js) ===\n');

{
  const exp = new Experience({ goal: 'test', result: 'completed', actions: [] });
  assertEqual(exp.version.planner, VERSIONS.planner, 'Experience.version.planner matches VERSIONS');
  assertEqual(exp.version.rewardModel, VERSIONS.rewardModel, 'Experience.version.rewardModel matches VERSIONS');
  assertEqual(exp.version.semanticModel, VERSIONS.semanticModel, 'Experience.version.semanticModel matches VERSIONS');
  assertEqual(exp.version.skillRepository, VERSIONS.skillRepository, 'Experience.version.skillRepository matches VERSIONS');
  // toJSON should include version
  const json = exp.toJSON();
  assertEqual(json.version.planner, VERSIONS.planner, 'toJSON includes version.planner');
}

console.log('\n=== 8. ExperienceStore — Debounce coalescing proven by writeCount ===\n');

{
  // Burst N adds in one event-loop tick with writeCount instrumentation.
  // If debounce works, writeCount should be 1 (or at most a few), not N.
  const COUNT = 100;
  const store = new ExperienceStore(TEST_USER + '_coalesce');
  store.clear();
  store.writeCount = 0; // reset after load+clear

  for (let i = 0; i < COUNT; i++) {
    store.add(new Experience({
      goal: 'coalesce_test',
      result: i % 2 === 0 ? 'completed' : 'failed',
      actions: [{ skill: 'craft', status: i % 2 === 0 ? 'completed' : 'failed' }],
    }));
  }

  store.flush(); // force one synchronous flush

  // Acceptance: writeCount < COUNT proves coalescing occurred
  assertLT(store.writeCount, COUNT, `writeCount (${store.writeCount}) < ${COUNT} — coalescing proven`);

  // Acceptance: all COUNT unique IDs present in memory
  assertEqual(store.totalExperiences(), COUNT, `${COUNT} experiences in memory`);

  // Acceptance: all COUNT unique IDs on disk, every original ID present
  const originalIds = new Set(store.getAll().map(e => e.id));
  assertEqual(originalIds.size, COUNT, `${COUNT} unique IDs in memory`);

  const reloaded = new ExperienceStore(TEST_USER + '_coalesce');
  assertEqual(reloaded.totalExperiences(), COUNT, `${COUNT} experiences on disk after reload`);
  const reloadedIds = new Set(reloaded.getAll().map(e => e.id));
  assertEqual(reloadedIds.size, COUNT, `${COUNT} unique IDs on disk`);

  // Every original ID is present on disk
  for (const id of originalIds) {
    assert(reloadedIds.has(id), `Original ID ${id} present on disk`);
  }

  store.clear();
  store.flush();
}

console.log('\n=== 9. ExperienceStore — Burst + prune interaction ===\n');

{
  const STORE_CAP = 500;
  const BURST = STORE_CAP + 20; // 520 adds — exceeds cap by 20
  const store = new ExperienceStore(TEST_USER + '_burst_prune');
  store.clear();

  // Track every experience we add so we can verify retention/eviction
  const added = [];
  for (let i = 0; i < BURST; i++) {
    const exp = new Experience({
      goal: 'burst_prune_test',
      result: 'completed',
      actions: [{ skill: 'craft', duration: 100, status: 'completed' }],
    });
    added.push(exp);
    store.add(exp);
  }

  store.flush();

  // Acceptance: exactly STORE_CAP experiences remain
  assertEqual(store.totalExperiences(), STORE_CAP, `Exactly ${STORE_CAP} experiences after burst above cap`);

  // Acceptance: newest STORE_CAP experiences are retained
  const retainedSet = new Set(store.getAll().map(e => e.id));
  const expectedRetained = added.slice(-STORE_CAP); // last 500
  const expectedPruned = added.slice(0, -STORE_CAP); // first 20

  for (const exp of expectedRetained) {
    assert(retainedSet.has(exp.id), `Newer experience ${exp.id} is retained`);
  }
  for (const exp of expectedPruned) {
    assert(!retainedSet.has(exp.id), `Older experience ${exp.id} is pruned`);
  }

  // Acceptance: no duplicate IDs among retained set
  assertEqual(retainedSet.size, STORE_CAP, 'No duplicate IDs among retained');

  // Acceptance: no missing IDs — retained count matches expected
  assertEqual(store.getAll().length, STORE_CAP, 'Retained count equals store total');

  // Acceptance: valid JSON on disk
  const reloaded = new ExperienceStore(TEST_USER + '_burst_prune');
  assertEqual(reloaded.totalExperiences(), STORE_CAP, 'Pruned state persisted to disk');
  const reloadedIds = new Set(reloaded.getAll().map(e => e.id));
  assertEqual(reloadedIds.size, STORE_CAP, 'No duplicate IDs on disk after prune');

  // Every retained ID is present on disk
  for (const exp of expectedRetained) {
    assert(reloadedIds.has(exp.id), `Retained ID ${exp.id} present on disk`);
  }

  store.clear();
  store.flush();
}

console.log('\n=== Results ===\n');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed === 0) console.log('\n  All Learning validations passed! ✓');
else process.exit(1);

// test_capabilities.mjs — quick harness: verify capability plans are wood-generic
// and never emit nonsense steps (collect any_planks etc.)
import { resolveCapability, countInInventory } from './src/brain/capabilities.js';

let failures = 0;
function check(name, cond, extra = '') {
    if (cond) console.log(`  PASS  ${name}`);
    else { console.error(`  FAIL  ${name} ${extra}`); failures++; }
}
const inv = (items) => items.map(([name, count]) => ({ name, count }));
const stepStr = (steps) => steps.map(s => `${s.skill}(${JSON.stringify(s.params)})`).join(' → ');
const BAD = (steps) => steps.some(s =>
    JSON.stringify(s.params).includes('any_planks') ||
    JSON.stringify(s.params).includes('any_log'));

console.log('\n[1] Empty inventory → canMineStone');
{
    const r = resolveCapability(inv([]), 'canMineStone', []);
    console.log('   ', stepStr(r.steps));
    check('unsatisfied', !r.satisfied);
    check('no any_* leak into collect/craft params', !BAD(r.steps));
    check('starts with collecting logs', r.steps[0]?.skill === 'collect' && r.steps[0]?.params?.item === 'log', `got ${r.steps[0]?.skill}`);
    check('includes plank conversion', r.steps.some(s => s.skill === 'craft_planks'));
    check('includes crafting_table craft', r.steps.some(s => s.skill === 'craft' && s.params.item === 'crafting_table'));
    check('ends with wooden_pickaxe craft', r.steps[r.steps.length - 1]?.params?.item === 'wooden_pickaxe');
}

console.log('\n[2] Has spruce_planks x4 → canMineStone (table path)');
{
    const r = resolveCapability(inv([['spruce_planks', 4]]), 'canMineStone', []);
    console.log('   ', stepStr(r.steps));
    check('no any_* leak', !BAD(r.steps));
    check('crafts table from generic planks', r.steps.some(s => s.skill === 'craft' && s.params.item === 'crafting_table'));
    check('still plans the pickaxe', r.steps.some(s => s.skill === 'craft' && s.params.item === 'wooden_pickaxe'));
}

console.log('\n[3] Has sticks+planks+table placed → wooden_pickaxe only needs craft');
{
    const r = resolveCapability(inv([['stick', 4], ['birch_planks', 8]]), 'canMineStone', ['crafting_table']);
    console.log('   ', stepStr(r.steps));
    check('single craft step', r.steps.length === 1 && r.steps[0].skill === 'craft' && r.steps[0].params.item === 'wooden_pickaxe');
}

console.log('\n[4] Has oak_log x2 → canMineStone');
{
    const r = resolveCapability(inv([['spruce_log', 2]]), 'canMineStone', []);
    console.log('   ', stepStr(r.steps));
    check('no any_* leak', !BAD(r.steps));
    check('converts held logs to planks', r.steps.some(s => s.skill === 'craft_planks'));
    check('plans pickaxe at end', r.steps[r.steps.length - 1]?.params?.item === 'wooden_pickaxe');
}

console.log('\n[5] canFight empty inventory');
{
    const r = resolveCapability(inv([]), 'canFight', []);
    console.log('   ', stepStr(r.steps));
    check('ends with sword craft', ['wooden_sword'].includes(r.steps[r.steps.length - 1]?.params?.item));
    check('no any_* leak', !BAD(r.steps));
}

console.log('\n[6] countInInventory categories');
{
    const i = inv([['spruce_planks', 3], ['oak_planks', 5], ['stone', 1]]);
    check('any_planks counts all species', countInInventory(i, 'any_planks') === 8);
    check('exact name still works', countInInventory(i, 'oak_planks') === 5);
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' FAILURES'}`);
process.exit(failures === 0 ? 0 : 1);

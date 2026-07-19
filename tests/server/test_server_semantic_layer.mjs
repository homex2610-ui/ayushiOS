// test_server_semantic_layer.mjs
// Isolated Server Semantic Layer validation — no Minecraft server needed.
// Tests classification of server types, capabilities, NPC roles, and GUI types.

import { ServerSemanticLayer } from '../../src/serverAnalyzer/ServerSemanticLayer.js';

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

function mockKB(data) {
  return {
    data: data || {},
    get(key) {
      return key.split('.').reduce((o, k) => o?.[k], this.data);
    },
  };
}

console.log('\n=== 1. SSL Identity — Empty KB ===\n');

{
  const kb = mockKB();
  const ssl = new ServerSemanticLayer(kb);
  const identity = ssl.classifyServerType();
  assertEqual(identity.type, 'unknown', 'Empty KB classifies as unknown');
  assertEqual(identity.confidence, 0, 'Empty KB has 0 confidence');
}

console.log('\n=== 2. SSL Identity — Lifesteal Server ===\n');

{
  const kb = mockKB({
    commands: { '/lifesteal': { type: 'custom' }, '/revive': { type: 'custom' }, '/combat': { type: 'custom' }, '/spawn': { type: 'teleport' } },
    plugins: { Lifesteal: { confidence: 0.7 } },
  });
  const ssl = new ServerSemanticLayer(kb);
  const identity = ssl.classifyServerType();
  assertEqual(identity.type, 'lifesteal', 'Lifesteal server classified correctly');
  assertGT(identity.confidence, 0, 'Lifesteal has positive confidence');
}

console.log('\n=== 3. SSL Identity — Skyblock Server ===\n');

{
  const kb = mockKB({
    commands: { '/island': { type: 'teleport' }, '/coop': { type: 'social' }, '/visit': { type: 'teleport' } },
    scoreboard: { title: 'Skyblock', lines: ['Island Level: 10'] },
  });
  const ssl = new ServerSemanticLayer(kb);
  const identity = ssl.classifyServerType();
  assertEqual(identity.type, 'skyblock', 'Skyblock server classified correctly');
  assertGT(identity.confidence, 0, 'Skyblock has positive confidence');
}

console.log('\n=== 4. SSL Identity — Survival with Essentials ===\n');

{
  const kb = mockKB({
    commands: { '/home': { type: 'teleport' }, '/sethome': { type: 'teleport' }, '/tpa': { type: 'teleport' }, '/spawn': { type: 'teleport' }, '/warp': { type: 'teleport' }, '/shop': { type: 'economy' }, '/bal': { type: 'economy' } },
    plugins: { EssentialsX: { confidence: 0.8 }, Vault: { confidence: 0.6 } },
    server: { motd: 'Welcome to our Survival server!' },
  });
  const ssl = new ServerSemanticLayer(kb);
  const identity = ssl.classifyServerType();
  assert(identity.type === 'survival' || identity.type === 'smp', `Survival/smp classified (got ${identity.type})`);
  assertGT(identity.confidence, 0, 'Survival has positive confidence');
}

console.log('\n=== 5. SSL Identity — Minigame Server ===\n');

{
  const kb = mockKB({
    commands: { '/join': { type: 'custom' }, '/game': { type: 'custom' }, '/kit': { type: 'custom' }, '/leave': { type: 'custom' } },
    scoreboard: { title: 'Game', lines: ['Kills: 5', 'Time: 3:00'] },
  });
  const ssl = new ServerSemanticLayer(kb);
  const identity = ssl.classifyServerType();
  assertEqual(identity.type, 'minigame', 'Minigame server classified correctly');
}

console.log('\n=== 6. SSL Mechanics — Full Capability Detection ===\n');

{
  const kb = mockKB({
    commands: { '/home': {}, '/sethome': {}, '/warp': {}, '/spawn': {}, '/tpa': {}, '/rtp': {}, '/back': {} },
    plugins: { EssentialsX: { confidence: 0.9 }, GriefPrevention: { confidence: 0.7 }, Vault: { confidence: 0.6 } },
    server: { pvp: true, claimSystem: 'griefprevention' },
    economy: { enabled: true, currency: 'coins', symbols: ['$'] },
  });
  const ssl = new ServerSemanticLayer(kb);
  const mechanics = ssl.inferMechanics();

  assert(mechanics.homes.available, 'Homes available');
  assert(mechanics.warps.available, 'Warps available');
  assert(mechanics.spawn.available, 'Spawn available');
  assert(mechanics.tpa.available, 'TPA available');
  assert(mechanics.rtp.available, 'RTP available');
  assert(mechanics.back.available, 'Back available');
  assert(mechanics.economy.enabled, 'Economy enabled');
  assert(mechanics.combat.pvp, 'PvP enabled');
  assertEqual(mechanics.claims.system, 'griefprevention', 'Claim system detected');
  assert(mechanics.capabilities.includes('homes'), 'Homes capability');
  assert(mechanics.capabilities.includes('warps'), 'Warps capability');
  assert(mechanics.capabilities.includes('claims'), 'Claims capability');
  assert(mechanics.capabilities.includes('economy'), 'Economy capability');
}

console.log('\n=== 7. SSL Mechanics — No Capabilities ===\n');

{
  const kb = mockKB({ commands: {} });
  const ssl = new ServerSemanticLayer(kb);
  const mechanics = ssl.inferMechanics();
  assert(!mechanics.homes.available, 'No homes');
  assert(!mechanics.warps.available, 'No warps');
  assert(!mechanics.spawn.available, 'No spawn');
  assert(!mechanics.tpa.available, 'No TPA');
  assert(!mechanics.economy.enabled, 'No economy');
  assertEqual(mechanics.claims.system, 'none', 'No claim system');
}

console.log('\n=== 8. SSL NPC Classification ===\n');

{
  const kb = mockKB({});
  const ssl = new ServerSemanticLayer(kb);

  // Quest giver NPC
  const questGiver = ssl.classifyNPC({ name: 'QuestMaster', traits: ['quest_giver'], functions: ['quest'] });
  assertEqual(questGiver.role, 'quest_giver', 'Quest giver NPC classified');
  assertGT(questGiver.confidence, 0.3, 'Quest giver confidence > 0.3');

  // Shop NPC
  const shopNPC = ssl.classifyNPC({ name: 'Shopkeeper', traits: ['shop'] });
  assertEqual(shopNPC.role, 'shop', 'Shop NPC classified');
  assertGT(shopNPC.confidence, 0.3, 'Shop confidence > 0.3');

  // Banker NPC
  const banker = ssl.classifyNPC({ name: 'Banker', traits: ['banker'] });
  assertEqual(banker.role, 'banker', 'Banker NPC classified');

  // Warp NPC
  const warpNpc = ssl.classifyNPC({ name: 'WarpMaster', traits: ['travel'] });
  assertEqual(warpNpc.role, 'warp', 'Warp NPC classified');

  // Unknown NPC
  const unknown = ssl.classifyNPC({ name: 'Steve', traits: [] });
  assertEqual(unknown.role, 'unknown', 'Unknown NPC remains unknown');

  // Auction NPC
  const auction = ssl.classifyNPC({ name: 'Auctioneer', traits: ['auction'] });
  assertEqual(auction.role, 'auction', 'Auction NPC classified');

  // Guide NPC
  const guide = ssl.classifyNPC({ name: 'Guide', traits: ['guide'] });
  assertEqual(guide.role, 'guide', 'Guide NPC classified');
}

console.log('\n=== 9. SSL GUI Classification ===\n');

{
  const kb = mockKB({});
  const ssl = new ServerSemanticLayer(kb);

  // Shop GUI
  const shopGUI = ssl.classifyGUI({ title: 'Shop', size: 54, itemCount: 30 });
  assertEqual(shopGUI.type, 'shop', 'Shop GUI classified');
  assertGT(shopGUI.confidence, 0.3, 'Shop GUI confidence > 0.3');

  // Crate GUI
  const crateGUI = ssl.classifyGUI({ title: 'Crate Rewards', size: 27, itemCount: 15 });
  assertEqual(crateGUI.type, 'crate', 'Crate GUI classified');

  // Quest GUI
  const questGUI = ssl.classifyGUI({ title: 'Quest Menu', size: 54, itemCount: 10 });
  assertEqual(questGUI.type, 'quest', 'Quest GUI classified');

  // Auction GUI
  const auctionGUI = ssl.classifyGUI({ title: 'Auction House', size: 54, itemCount: 40 });
  assertEqual(auctionGUI.type, 'auction', 'Auction GUI classified');

  // Unknown GUI
  const unknownGUI = ssl.classifyGUI({ title: '', size: 9, itemCount: 0 });
  assertEqual(unknownGUI.type, 'unknown', 'Empty GUI classified as unknown');
}

console.log('\n=== 10. SSL Full Analysis Pipeline ===\n');

{
  const kb = mockKB({
    server: { name: 'MyFunServer', motd: 'Welcome to Survival SMP!', version: '1.20.4', pvp: true },
    commands: { '/home': { type: 'teleport', confidence: 0.9 }, '/sethome': { type: 'teleport' }, '/spawn': { type: 'teleport' }, '/warp': { type: 'teleport' }, '/tpa': { type: 'teleport' }, '/shop': { type: 'economy' }, '/bal': { type: 'economy' } },
    plugins: { EssentialsX: { confidence: 0.9 }, Vault: { confidence: 0.7 }, GriefPrevention: { confidence: 0.6 } },
    economy: { enabled: true, currency: 'coins', symbols: ['$'] },
    npcs: [
      { name: 'QuestMaster', traits: ['quest_giver'], functions: ['quest'], position: { x: 10, y: 64, z: 10 }, lastSeen: Date.now() },
      { name: 'Shopkeeper', traits: ['shop'], functions: ['trade'], position: { x: 15, y: 64, z: 10 }, lastSeen: Date.now() },
      { name: 'Banker', traits: ['banker', 'economy'], functions: ['economy'], position: { x: 5, y: 64, z: 15 }, lastSeen: Date.now() },
    ],
    guiMenus: [
      { title: 'Shop', size: 54, itemCount: 30, category: 'shop', lastSeen: Date.now(), seenCount: 5 },
      { title: 'Quest Menu', size: 27, itemCount: 8, category: 'quest', lastSeen: Date.now(), seenCount: 3 },
    ],
  });
  const ssl = new ServerSemanticLayer(kb);

  const profile = ssl.compileProfile();
  assert(!!profile.identity, 'Profile has identity');
  assert(!!profile.mechanics, 'Profile has mechanics');
  assert(!!profile.plugins, 'Profile has plugins');
  assert(!!profile.commands, 'Profile has commands');
  assert(profile.npcs.length === 3, 'Profile has 3 NPCS');
  assert(profile.guis.length === 2, 'Profile has 2 GUIs');
  assert(!!profile.summary, 'Profile has summary');
  assert(!!profile.summary.text, 'Summary has text');

  // Compile profile should also work as summary
  const summary = ssl.getSummary();
  assert(!!summary, 'getSummary() returns text');
}

console.log('\n=== 11. SSL Caching and Performance ===\n');

{
  const kb = mockKB({
    commands: { '/spawn': { type: 'teleport' } },
  });
  const ssl = new ServerSemanticLayer(kb);

  const first = ssl.analyze(false);
  const second = ssl.analyze(false);
  assert(first === second, 'Analyze returns cached result within 10s');

  const forced = ssl.analyze(true);
  assert(first !== forced, 'Analyze(true) forces fresh analysis');
}

console.log('\n=== 12. SSL Query Methods ===\n');

{
  const kb = mockKB({
    commands: { '/home': {}, '/sethome': {} },
    plugins: { EssentialsX: { confidence: 0.8 } },
    npcs: [
      { name: 'WarpMaster', traits: ['travel'], position: { x: 0, y: 64, z: 0 }, lastSeen: Date.now() },
    ],
    guiMenus: [
      { title: 'Warp Menu', size: 45, itemCount: 20, category: 'warp', lastSeen: Date.now(), seenCount: 2 },
    ],
  });
  const ssl = new ServerSemanticLayer(kb);

  // Trigger analysis
  ssl.analyze(true);

  const serverType = ssl.getServerType();
  assert(typeof serverType === 'string', 'getServerType() returns string');

  const mechanics = ssl.getMechanics();
  assert(!!mechanics, 'getMechanics() returns object');
  assert(Array.isArray(mechanics.capabilities), 'mechanics.capabilities is array');

  const npcRole = ssl.getNPCRole('WarpMaster');
  assert(!!npcRole, 'getNPCRole() returns result');
  assert(typeof npcRole.role === 'string', 'NPCRole.role is string');

  const guiType = ssl.getGUIType('Warp Menu');
  assert(!!guiType, 'getGUIType() returns result');
  assert(typeof guiType.type === 'string', 'GUIType.type is string');
}

console.log('\n=== 13. SSL NPC from Names (no KB lookup) ===\n');

{
  const kb = mockKB({});
  const ssl = new ServerSemanticLayer(kb);

  const tests = [
    { name: 'QuestGiver', expected: 'quest_giver' },
    { name: 'Merchant', expected: 'shop' },
    { name: 'Banker John', expected: 'banker' },
    { name: 'Warp NPC', expected: 'warp' },
  ];

  for (const t of tests) {
    const result = ssl.classifyNPC({ name: t.name, traits: [] });
    assertEqual(result.role, t.expected, `Name "${t.name}" classified as ${t.expected}`);
  }
}

console.log('\n=== 14. SSL GUI Classification by Title ===\n');

{
  const kb = mockKB({});
  const ssl = new ServerSemanticLayer(kb);

  const tests = [
    { title: 'Shop Menu', expected: 'shop' },
    { title: 'Kit Selector', expected: 'kit' },
    { title: 'Crate Rewards', expected: 'crate' },
    { title: 'Quest Menu', expected: 'quest' },
    { title: 'Bank', expected: 'economy' },
    { title: 'Warp Menu', expected: 'warp' },
    { title: 'Auction House', expected: 'auction' },
  ];

  for (const t of tests) {
    const result = ssl.classifyGUI({ title: t.title, size: 27, itemCount: 5 });
    assertEqual(result.type, t.expected, `GUI "${t.title}" classified as ${t.expected}`);
  }
}

console.log('\n=== Results ===\n');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed === 0) console.log('\n  All Server Semantic Layer validations passed! ✓');
else process.exit(1);

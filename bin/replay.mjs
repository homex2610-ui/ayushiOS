#!/usr/bin/env node
// bin/replay.mjs
// CLI entry point for ReplayEngine v1.
//
// Usage:
//   node bin/replay.mjs --file bots/<username>/experiences.json
//   node bin/replay.mjs --file bots/<username>/experiences.json --filter serverType=survival
//   node bin/replay.mjs --file bots/<username>/experiences.json --filter result=failed
//   node bin/replay.mjs --file bots/<username>/experiences.json --filter goalPrefix=craft
//   node bin/replay.mjs --file bots/<username>/experiences.json --meta sessionId=run1 --meta server="CureDoom SMP"
//
// Metadata keys: sessionId, server, mcVersion, botVersion, plannerVersion, rewardModel, duration

import { ReplayEngine } from '../src/learning/ReplayEngine.js';

function usage() {
  console.log('Usage:');
  console.log('  node bin/replay.mjs --file <path> [--filter key=value] [--meta key=value]');
  console.log('');
  console.log('Filters (repeatable):');
  console.log('  serverType=<type>     e.g. survival, lifesteal');
  console.log('  result=<status>       e.g. completed, failed, interrupted');
  console.log('  goalPrefix=<prefix>   e.g. craft_');
  console.log('');
  console.log('Metadata (repeatable, optional):');
  console.log('  sessionId=<id>        e.g. 2026-07-18T20:15:31Z');
  console.log('  server=<name>         e.g. CureDoom SMP');
  console.log('  mcVersion=<ver>       e.g. 1.20.1');
  console.log('  botVersion=<ver>      e.g. htn-lite-v1');
  console.log('  plannerVersion=<ver>');
  console.log('  rewardModel=<ver>');
  console.log('  duration=<time>       e.g. 30min');
  process.exit(1);
}

const args = process.argv.slice(2);
let fp = null;
const filters = {};
const metadata = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') {
    fp = args[++i];
  } else if (args[i] === '--filter') {
    const kv = args[++i];
    const eq = kv.indexOf('=');
    if (eq === -1) { console.error('ERROR: --filter must be key=value'); usage(); }
    const k = kv.slice(0, eq);
    const v = kv.slice(eq + 1);
    if (!['serverType', 'result', 'goalPrefix'].includes(k)) {
      console.error(`ERROR: unknown filter key "${k}". Valid: serverType, result, goalPrefix`);
      usage();
    }
    filters[k] = v;
  } else if (args[i] === '--meta') {
    const kv = args[++i];
    const eq = kv.indexOf('=');
    if (eq === -1) { console.error('ERROR: --meta must be key=value'); usage(); }
    const k = kv.slice(0, eq);
    const v = kv.slice(eq + 1);
    metadata[k] = v;
  } else if (args[i] === '--help') {
    usage();
  } else {
    console.error(`ERROR: unknown argument "${args[i]}"`);
    usage();
  }
}

if (!fp) {
  console.error('ERROR: --file is required');
  usage();
}

try {
  const engine = new ReplayEngine(fp);
  engine.load();
  const report = engine.runFilteredReport({ ...filters, metadata });
  console.log(report);
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
}

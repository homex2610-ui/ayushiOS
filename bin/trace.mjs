#!/usr/bin/env node
// bin/trace.mjs
// DecisionTrace log analyzer.
// Parses bots/<user>/decision_trace.log and reports:
//   - Repeated goals (same goal > N times)
//   - Action loops (same skill repeated)
//   - Interruption → resume chains
//   - Average planning latency
//   - Average task latency
//   - Counterfactual frequency
//
// Usage:
//   node bin/trace.mjs bots/<user>/decision_trace.log

import { readFileSync, existsSync } from 'fs';

function usage() {
  console.log('Usage:');
  console.log('  node bin/trace.mjs <path-to-decision_trace.log>');
  process.exit(1);
}

const fp = process.argv[2];
if (!fp) usage();
if (!existsSync(fp)) {
  console.error(`ERROR: file not found — ${fp}`);
  process.exit(1);
}

const text = readFileSync(fp, 'utf8');

// ─── Parse entries ─────────────────────────────────────────────
// Each entry is a block delimited by ====...==== lines.
// We extract: Goal, Need, trace.planning, trace.action, trace.learning, INTERRUPTED, RESUMED

const blocks = text.split(/={5,}/).filter(b => b.trim());

const entries = [];
const interruptions = [];
const resumes = [];

for (const block of blocks) {
  const lines = block.split('\n').map(l => l.trim()).filter(l => l);

  // Check for interruption/resume markers (both may appear in one block)
  const interLines = lines.filter(l => l.startsWith('>>> INTERRUPTED'));
  for (const il of interLines) interruptions.push(il);
  const resumeLines = lines.filter(l => l.startsWith('<<< RESUMED/COMPLETED'));
  for (const rl of resumeLines) resumes.push(rl);
  if (interLines.length > 0 || resumeLines.length > 0) continue;

  // Full decision entry
  const goalMatch = block.match(/Goal:\s*(\S+)/);
  const needMatch = block.match(/Need:\s*(\S+)/);
  const planningDurationMatch = block.match(/Planning.*?Duration:\s*(\d+)/);
  const actionDurationMatch = block.match(/Action.*?Duration:\s*(\d+)/);

  if (goalMatch) {
    entries.push({
      goal: goalMatch[1],
      need: needMatch ? needMatch[1] : null,
      planningDuration: planningDurationMatch ? parseInt(planningDurationMatch[1], 10) : null,
      actionDuration: actionDurationMatch ? parseInt(actionDurationMatch[1], 10) : null,
      raw: block,
    });
  }
}

// ─── Analysis ──────────────────────────────────────────────────

console.log('='.repeat(60));
console.log('  DecisionTrace Analyzer — v1');
console.log('='.repeat(60));
console.log(`\nFile: ${fp}`);
console.log(`Entries: ${entries.length}`);
console.log(`Interruptions: ${interruptions.length}`);
console.log(`Resumes/Completions: ${resumes.length}`);
console.log('');

// Repeated goals
const goalCounts = new Map();
for (const e of entries) {
  goalCounts.set(e.goal, (goalCounts.get(e.goal) || 0) + 1);
}
const repeated = [...goalCounts.entries()]
  .filter(([, c]) => c > 2)
  .sort((a, b) => b[1] - a[1]);

if (repeated.length > 0) {
  console.log('─'.repeat(40));
  console.log('  Repeated Goals (>2 occurrences)');
  console.log('─'.repeat(40));
  for (const [goal, count] of repeated) {
    console.log(`  ${goal}: ${count}x`);
  }
  console.log('');
} else {
  console.log('  No goals appeared more than 2 times.\n');
}

// Action loops — consecutive identical needs
console.log('─'.repeat(40));
console.log('  Potential Loops');
console.log('─'.repeat(40));
let loopCount = 0;
for (let i = 2; i < entries.length; i++) {
  if (entries[i].need &&
      entries[i].need === entries[i - 1].need &&
      entries[i].need === entries[i - 2].need) {
    if (loopCount === 0) console.log('  Same need selected 3+ times in a row:');
    console.log(`    "${entries[i].need}" at entries ${i - 1}–${i + 1}`);
    loopCount++;
  }
}
if (loopCount === 0) console.log('  None detected (no 3+ consecutive identical needs).\n');

// Interruption → Resume chain
if (interruptions.length > 0 || resumes.length > 0) {
  console.log('─'.repeat(40));
  console.log('  Interruption → Resume Chain');
  console.log('─'.repeat(40));
  const max = Math.max(interruptions.length, resumes.length);
  for (let i = 0; i < max; i++) {
    if (i < interruptions.length) {
      const m = interruptions[i].match(/>>> INTERRUPTED AT: (\S+) \| Goal: (\S+) \| Trigger: (.+)/);
      if (m) console.log(`  \u26A0\uFE0F  ${m[1]} | Goal: ${m[2]} | ${m[3]}`);
      else console.log(`  \u26A0\uFE0F  ${interruptions[i]}`);
    }
    if (i < resumes.length) {
      const m = resumes[i].match(/<<< RESUMED\/COMPLETED AT: (\S+) \| Goal: (\S+)/);
      if (m) console.log(`  \u2705  ${m[1]} | Goal: ${m[2]}`);
      else console.log(`  \u2705  ${resumes[i]}`);
    }
  }
  console.log('');
}

// Average planning latency
const planningDurations = entries.map(e => e.planningDuration).filter(d => d !== null);
if (planningDurations.length > 0) {
  const avg = planningDurations.reduce((s, d) => s + d, 0) / planningDurations.length;
  const max = Math.max(...planningDurations);
  const min = Math.min(...planningDurations);
  console.log('─'.repeat(40));
  console.log('  Planning Latency');
  console.log('─'.repeat(40));
  console.log(`  Average: ${Math.round(avg)}ms`);
  console.log(`  Min:     ${min}ms`);
  console.log(`  Max:     ${max}ms`);
  console.log(`  Samples: ${planningDurations.length}`);
  console.log('');
}

// Average task latency
const actionDurations = entries.map(e => e.actionDuration).filter(d => d !== null);
if (actionDurations.length > 0) {
  const avg = actionDurations.reduce((s, d) => s + d, 0) / actionDurations.length;
  const max = Math.max(...actionDurations);
  const min = Math.min(...actionDurations);
  console.log('─'.repeat(40));
  console.log('  Task Execution Latency');
  console.log('─'.repeat(40));
  console.log(`  Average: ${Math.round(avg)}ms`);
  console.log(`  Min:     ${min}ms`);
  console.log(`  Max:     ${max}ms`);
  console.log(`  Samples: ${actionDurations.length}`);
  console.log('');
}

// Counterfactual frequency
let cfCount = 0;
for (const e of entries) {
  if (e.raw.includes('counterfactual')) cfCount++;
}
console.log('─'.repeat(40));
console.log('  Counterfactual Logging');
console.log('─'.repeat(40));
console.log(`  Entries with counterfactual data: ${cfCount}/${entries.length}`);
console.log('');

console.log('='.repeat(60));

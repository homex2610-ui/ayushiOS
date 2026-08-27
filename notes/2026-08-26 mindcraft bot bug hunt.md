# Mindcraft bot bug hunt — 2026-08-26

#bug-hunt #mindcraft #ayushi #stability

## Problem

Bot crash-loops: `logs/bot_watchdog.log` shows restarts every 5–15 min on Aug 24 (19:16 → 21:07, ten restarts). No populated error logs (`bot_error.log` is empty), all 183 JS files pass `node --check`. So the failure is a runtime/logic bug, not a syntax error.

## Root cause (crash loop)

**Empty-chat heartbeat flood** — `src/agent/agent.js:1416-1421`.

```js
if (this.bot?.entity && Date.now() - this._lastHeartbeat > 300000) {
    try { this.bot.chat(''); } catch { /* exit(1) */ }
}
```

- `_lastHeartbeat` is set once at startup (`agent.js:69`) and refreshed **only when a chat arrives** (`agent.js:624`). The probe never refreshes it.
- After 5 quiet minutes, `update()` (~300 ms tick) sends an **empty chat packet ~3×/sec forever**. Paper/vanilla anti-spam kicks the bot → `process.exit` path or server kick → watchdog restart.
- `bot.chat()` does not throw on a half-dead socket, so the `catch → process.exit(1)` branch is nearly dead code — the "dead socket detector" detects nothing.

Timeline matches: ~5 min silence + a few min until rate-limiter kicks = restarts every 5–15 min.

## All findings (ranked)

### Critical

| # | Bug | Location | Fix |
|---|-----|----------|-----|
| 1 | Empty-chat heartbeat flood (root cause above) | `src/agent/agent.js:1416` | Refresh `_lastHeartbeat` after probing; rate-limit probe; use keep-alive ack tracking instead of `chat('')` |
| 2 | MotorCortex resume path never terminalizes its TaskManager handle — `busy` stuck true forever; `_cancelRequested` stays set so `interrupt_code=true` re-written every tick → bot self-aborts every skill | `src/brain/MotorCortex.js:187-214` (resume) vs `265-276` (normal path has `finally`, resume doesn't) | Add same `try/finally` cleanup to resume path |
| 3 | `goToGoal` timeout `setTimeout` never cleared on success — fires later and calls `cancelNavigation()` on the **next** navigation, silently crippling step N+1 of multi-step plans | `src/agent/library/skills.js:1394-1409` | Hold timer id, `clearTimeout` in both paths (mirror `gotoWithTimeout` in `bt.js:10-20`) |

### High

| # | Bug | Location | Fix |
|---|-----|------|-----|
| 4 | Child agent processes have **no** `unhandledRejection`/`uncaughtException` handlers (only `main.js` does; agents run via `init_agent.js`) — any fire-and-forget rejection kills the agent | `src/process/init_agent.js` | Install both handlers like `main.js:9-16` |
| 5 | Fire-and-forget async LLM call in bot-to-bot chat: `_scheduleProcessInMessage` un-awaited; inside it `promptShouldRespondToBot` has no try/catch; `ModelRouter.sendRequest` throws `"All models exhausted"` → unhandled rejection → process death (with #4) | `src/agent/conversation.js:206`, `:309`; `src/models/model_router.js:87` | Await/catch the call; return `false` on LLM error like `promptConvo` does |
| 6 | `endConversation()` derefs null `activeConversation.name` — `!stfu` → `shutUp()` → `endAllConversations()` throws after any prior conversation | `src/agent/conversation.js:242` | Guard `if (this.activeConversation && ...)` |
| 7 | Disconnect during hub nav = zombie: handler returns without `process.exit` or reconnect scheduling; watchdog only acts on child exit → dead bot, live process | `src/agent/agent.js:156-160` | Schedule bounded fallback `process.exit(1)` (~90 s) in that branch |
| 8 | Hub-nav 60 s timeout race abandons a still-running HubStateMachine that keeps chatting `/server`, `/hub`… for up to ~6 min per command cycle → anti-spam kicks + fights the brain | `src/connection/ConnectionManager.js:263-267`, `src/hub/HubStateMachine.js:78-130` | Cancellation token checked in `_run`/`_tick`; abort on race timeout |
| 9 | Rapid-crash guard strands whole stack: exits within 10 s of last restart → logs and returns, no retry scheduled, no non-zero exit → parent looks healthy, watchdog never intervenes. Also `_restartCount` never resets after stable uptime (15 crashes over days = permanent retirement) | `src/process/agent_process.js:62-65` | Backoff-and-retry anyway, or `process.exit(1)`; decay counter after stable uptime |

### Medium

| # | Bug | Location | Fix |
|---|---|----------|-----|
| 10 | `motor.isBusy` setter rewrite made pin-guards no-ops: agent pins busy during auto-grind but TaskManager says free → brain launches concurrent goals fighting the grind; master `!command` now *cancels* brain goals instead of pausing | `src/brain/MotorCortex.js:47-57` vs `src/agent/agent.js:443,509,519,990` | Register grind as real task or add pinned flag; save/restore in handleMessage |
| 11 | Spawn bootstrap failure exits code 0 → parent treats as clean stop, never restarts | `src/agent/agent.js:528-530` | `process.exit(1)` |
| 12 | `ActionManager.timedout` latches true forever after first timeout → interrupted actions misreported to LLM | `src/agent/action_manager.js:7,174` | Reset at top of `_executeAction` |
| 13 | collectBlock progress uses exact inventory key: mining `iron_ore` yields `raw_iron` → false "no progress" give-up + false failure returns | `src/agent/library/skills.js:654,700-706,727-729` | Use family-aware count from `utils/item_families.js` |
| 14 | AyushiOS `_tick` interval callback has try/finally but no catch → one throw aborts that cycle; `emergency_stop` clears interval permanently | `src/brain/AyushiOS.js:186-197` | `.catch()` the tick; make emergency stop recoverable |
| 15 | Unguarded `bot.entity.position` in perception hot paths during respawn/death windows → dropped chat/reflexes | `src/brain/SensoryCortex.js:26,30`, `SpinalCord.js:65,72` | Early-return guards |
| 16 | MemoryMatrix `save()` non-atomic writeFileSync on nearly every mutator → crash mid-write truncates memory.json, next boot silently wipes all long-term memory; worldGraph grows unbounded | `src/brain/MemoryMatrix.js:83-97` | tmp-file + rename atomic writes; throttle; cap worldGraph |

### Low

| # | Bug | Location | Fix |
|---|---|----------|-----|
| 17 | `windowOpen` listener leak on NPC-interact timeout (accumulates per hub visit) | `src/hub/LobbyHelpers.js:109-119` | Named handler + removeListener on timeout |
| 18 | `_recentChats` dedupe Map never pruned → slow memory growth | `src/agent/agent.js:626-631` | Prune stale keys or LRU |
| 19 | Self-prompter `interrupt` flag can stick true between cycles → autonomous loop won't auto-restart | `src/agent/self_prompter.js:76,91-105` | Clear interrupt in `stop()` |
| 20 | AuthHandler register-retry fires at t=3 s but requires ≥5 s elapsed → dead fallback branch | `src/agent/AuthHandler.js:115-120` | Schedule at 5.5 s |
| 21 | HealthMonitor pings localhost for cloud providers → misleading unhealthy flags | `src/services/health_monitor.js:93-105` | Skip providers without HTTP URL |
| 22 | Inverted "all goals resting" check in AyushiOS (`!c ||` should be `c &&`) | `src/brain/AyushiOS.js:318-319` | Invert condition |
| 23 | Latent arg-order bug in `resumeAction(fn, timeout)` forwards fn into label slot | `src/agent/action_manager.js:16-18` | Forward as `(null, actionFn, timeout)` |
| 24 | Zombie socket.io client on failed mindserver connect (retries forever) | `src/agent/mindserver_proxy.js:18-30` | Close socket in reject path |
| 25 | Dead auditory pipeline: `recentChat` permanently empty, warp/command learning stopped | `src/brain/SensoryCortex.js:21,136` | Restore hook or remove field |

## Operational note

`watchdog.mjs` and `run_forever.ps1` are interchangeable supervisors — running **both** spawns two bots with the same username → duplicate-login kick war. Pick one.

## Fixes applied

### Round 1 (2026-08-26, earlier session)

- **#1 FIXED** — `agent.js`: replaced `chat('')` probe with keep-alive ack tracking (`_lastKeepAliveAck`, refreshed via `bot._client.on('keep_alive')` + incoming chats). `update()` now exits only if no keep-alive for 60 s. Note: protocol-level dead-socket detection was also stretched to 300 s at `mcdata.js:66` (`checkTimeoutInterval`), which masked the original flood timeline.
- **#2 FIXED** — `MotorCortex.js` resume path now mirrors the normal path's `finally`: terminal TaskManager transition (COMPLETED/FAILED/CANCELLED), `syncInterruptFlag`, handle cleared. No more stuck `busy`/`interrupt_code`.
- **#3 FIXED** — `skills.js goToGoal`: timeout timer id held and `clearTimeout` in the existing `finally` (mirrors `gotoWithTimeout` in `bt.js`). Late timer can no longer cancel the next navigation.

Verified: `node --check` clean on all three files; all test suites pass (htn 217, e2e 39, semantic-layer 72, learning 1187, replay 34).

### Round 2 (2026-08-26, this session)

| Finding | File | Change |
|---------|------|--------|
| #4 | `src/process/init_agent.js` | Added `unhandledRejection` (log) + `uncaughtException` (log + exit 1 so AgentProcess restarts) global handlers; bootstrap IIFE got `.catch` |
| #5 | `src/agent/conversation.js:207,312-322` | `.catch()` on fire-and-forget `_scheduleProcessInMessage`; `promptShouldRespondToBot` wrapped in try/catch defaulting to stay quiet |
| #6 | `src/agent/conversation.js:242` | Null guard before `activeConversation.name` — `!stfu` no longer throws |
| #9 | `src/process/agent_process.js:62-77` | Crash-loop backs off 30-40s and retries instead of stranding the stack; crash budget resets after 5 min healthy uptime |
| #12 | `src/agent/action_manager.js:66-68` | `timedout` reset per action at top of `_executeAction` |
| #20 | `src/agent/AuthHandler.js` | Register-retry timer 3000→5500ms so its ≥5s guard can actually pass |
| #22 | `src/brain/AyushiOS.js:318-319` | Inverted backoff check fixed (`!c \|\|` → `c &&`) — explore only when *all* goals resting |
| #23 | `src/agent/action_manager.js:16-19` | `resumeAction` forwards `(null, actionFn, timeout)` — latent arg-order landmine removed |

Plus: missing semicolon conversation.js:298.

Verified: `node --check` clean on all 6 changed files; eslint reports only pre-existing patterns; `test_brain.mjs` PASS, `test_capabilities.mjs` ALL TESTS PASSED.

### Round 3 (2026-08-26, this session — all remaining findings)

| Finding | File | Change |
|---------|------|--------|
| #7 hub-nav disconnect zombie | `src/agent/agent.js:156-171` | Bounded 90s grace timer then forced `process.exit(1)` (verified nothing reconnects in-process; supervisor needs an exit) |
| #8 hub-nav timeout race | `src/hub/HubStateMachine.js`, `HubNavigator.js`, `ConnectionManager.js` | `cancel(reason)` on the machine + `abort()` flag polled inside executeCommand's multi-minute loops; race loser now aborted at timeout |
| #10 isBusy setter vs pins | `MotorCortex.js:47-88`, `agent.js` | New `pinBusy(token)/unpinBusy(token)/releaseAllBusyPins()` — grind + manual-command pauses hold busy without lying to TaskManager or cancelling running goals; watchdog force-clear releases pins |
| #11 spawn-failure exit code | `agent.js:549-553` | `process.exit(1)` so AgentProcess restarts on bootstrap failure |
| #13 collectBlock false give-ups | `skills.js:22-45,594,668,714,741` | Drop-aware progress counting (`collectProgressCount`) via `bot.registry` drops — iron_ore→raw_iron, stone→cobblestone now credit progress |
| #14 tick error boundary | `AyushiOS.js:186-213` | `.catch()` on async tick interval; emergency stop now uses `stop()` and `resumeLoop()` can restart it |
| #15 entity null derefs | `SensoryCortex.js:24-28`, `SpinalCord.js` | Null guards in getSnapshot (returns null; _tick skips cycle), creeper-hiss and entityHurt handlers |
| #16 memory wipe risk | `MemoryMatrix.js:83-135` | Atomic tmp+rename writes; corrupt files preserved as `.corrupt-*` backups; worldGraph pruned (≤1200 nodes / ≤2000 edges, safe/bed/high-importance protected) |
| #17 windowOpen leak | `LobbyHelpers.js:109-129` | Named handler removed on timeout path |
| #18 recentChats growth | `agent.js:648-657` | Expired dedupe keys pruned when map >500 entries |
| #19 self-prompter stuck flag | `self_prompter.js:75-130` | `stop()/pause()` wait out the loop and clear interrupt themselves; `update()` clears stale interrupts when no loop is running |
| #21 localhost health probes | `health_monitor.js:93-105` | Cloud providers (no URL) assumed healthy instead of pinging 127.0.0.1:11434 |
| #24 zombie socket.io client | `mindserver_proxy.js:24-33` | Failed connect closes the socket (`.once` handlers too) |
| #25 dead auditory pipeline | `SensoryCortex.js:26-38`, `BrocaArea.js:37-39` | Restored: `hearChat(username,msg)` feeds recentChat (60s TTL, cap 20) + emits `heard_speech`; wired into BrocaArea chat handler |

Verified: all 14 changed files pass `node --check`; eslint shows only pre-existing patterns (empty catches in SpinalCord et al., legacy semicolons); ALL suites green — brain ✓, capabilities ✓, htn ✓, learning ✓, replay ✓, semantic-layer ✓, e2e ✓.

### Still open

Nothing from the original audit. Residual hardening ideas (out of scope): pick ONE of `watchdog.mjs`/`run_forever.ps1` as supervisor; wire `HealthMonitor` state into ModelRouter or delete it; consider wiring `resumeLoop()` to a whisper command after kill-switch.

## Neural cortex added — 2026-08-26

**Request:** "add neural network and sensors" (make the bot smarter).

### New modules

- **`src/brain/NeuralNet.js`** — `TinyBrain`: dependency-free MLP with hand-rolled backprop (tanh hidden layers, sigmoid output, BCE loss), JSON serialization, <1ms forward+backward.
  - Architecture (6 layers): `22 inputs → 32 → 16 → 8 → 4 → 3 outputs`
  - Outputs: `[danger, hungerRisk, grindReadiness]`, each 0..1
- **`src/brain/SensorArray.js`** — extended senses feeding a fixed normalized 22-feature vector:
  vitals, armor, inventory fullness, threat/player proximity+counts, light, night, rain,
  altitude, water, fall, speed (position deltas), recent damage (health-drop tracking),
  danger sounds (`soundEffectHeard` ring buffer: creeper/zombie/skeleton within ~10 blocks),
  day phase, has-food, held-item class.

### Learning loop (in AyushiOS `_neuralStep`, every 1.5s tick)

1. Read features → forward pass → emit `nn_prediction` on the bus.
2. Queue sample; after an 8s outcome window label it from observed reality:
   took damage / got hungry / stayed safe → replay buffer (cap 200).
3. Train mini-batch (last 16) at most every 10s; weights saved atomically to
   `bots/<name>/neural_net.json` every 5 min and on stop(). Shape change ⇒ fresh retrain.

### Behavior influence

- `danger > 0.8` vetoes risky autonomy goals for one cycle (max once/15s, safe tasks exempt).
- `hungerRisk > 0.7` with food in inventory pushes an early `eat` suggestion to the executive.

### Drive-by fix

- `agent.js` walk-away goal passed `{x, z}` without Y → pathfinder error
  "Failed to reach -4, undefined, 48". Now passes `y`.

### Verification

`tests/brain/test_neural.mjs` — 13/13 PASS: architecture, learning convergence
(loss 2.089 → 0.164, 100% acc synthetic task), serialization roundtrip, feature bounds.
HTN/learning/brain suites still green.

## "Bot is dumb" fixes — 2026-08-26 evening (live-verified)

Watched the LAN session (`proxy` logs in `%TEMP%\opencode\mclogs\`) and fixed three
behavior killers:

1. **One emergency killed the whole 22-step grind** — grind loop broke silently on
   `interrupt_code`, printed "completed!" after step 1. Fix (`agent.js`): interrupted
   steps now wait out the emergency goal (≤90s), retry same step up to 3×, then continue.
   **Live proof:** `Step 5 interrupted — waiting out emergency...` → later
   `Step 5/22: craft({"item":"crafting_table"})` — resumed exactly where it left off,
   reached step 9/22.
2. **Night-mob safety loop** — any zombie within scan radius scored seek_safety ≥0.7
   forever; its go_surface plan changed nothing at surface level → infinite
   avoid_hazard ↔ seek_safety alternation. Fix (`ExecutiveBrain.js`): seek_safety only
   fires when threat ≤6 blocks, health below low, or 3+ threats.
3. **Recorded hazards never resolved** — boot scan wrote 3 hazard memories near spawn;
   avoid_hazard re-fired on them every 12s cooldown forever. Fix (`MemoryMatrix.js` +
   AyushiOS): completed avoidance marks nearby hazards avoided → 60s grace before re-arm.
4. **Walk-away crash**: `move_to {x,z}` without Y → "Failed to reach -4, undefined, 48".
   Fixed to pass Y.

Also observed & accepted: emergency_retreat preempts are real (night hostiles) — the
grind now survives them instead of dying. LAN disconnects recovered via watchdog.

## Quantum-inspired decision making — 2026-08-26 evening

**Request:** "add quantum physics and maths" (smarter decisions).

Built `src/brain/QuantumMind.js` — six-layer quantum cognition model:

- **Complex amplitudes**: each need holds `ψ = re + im·i` (not a scalar score).
- **Born rule**: choice probability `p = |ψ|²` → stochastic selection.
- **Interference**: coherent needs amplify; opposed needs cancel (classical can't).
- **Annealing**: temperature decays 1.0 → 0.08; mixes exploration → exploitation.
- **Tunneling**: rare `T²` jumps to low-probability needs escape local optima.
- **Entropy hysteresis**: high von Neumann entropy → stick with current goal (fixes flip-flop safety loop).

Wired into `ExecutiveBrain.decide()` replacing greedy `scored[0]` — keeps utility
scores as basis, samples via wave function. Failures feed destructive interference,
successes constructive. Dashboard streams `via`, `need`, `T`, `H`.

Tests: `tests/brain/test_quantum.mjs` — 13/13 PASS (Born rule, interference,
annealing, sampling, entropy hysteresis, describe() payload).

## Pacing + tool fix + whisper fix — 2026-08-26 evening

1. **Pacing** (`src/agent/Pacing.js`): human-like reaction delays (REPLY 800-2000ms,
   ACTION_GAP 700-1800ms), stale message dropping, move timeout 15s ×2 retries (was 30s ×3).
   Wired into `_processQueue`, `TaskRunner.move_to`, grind loop, `FastReply`.

2. **Tool fix** (`skills.js`): `mineflayer-tool` not installed → `bot.tool.equipForBlock`
   always threw. New `equipBestToolFor(bot, block)` scans registry material → kind → best
   tier from inventory. All `collectBlock` / strip-mine / manual fallbacks use it.

3. **Whisper fix** (`agent.js`): only the real `bot.on('whisper')` listener sets
   `_whisperLast`; `respondFunc` no longer poises public replies to whisper for 60s.

## Dashboard — 2026-08-26 evening

Created `src/mindcraft/public/dashboard.html` — dark monitoring console at
`localhost:8080/dashboard.html`. Panels:

- **Agent**: health/hunger bars, biome, position, activity pill, nearby entities
- **Live Vision**: prismarine-viewer iframe (requires `render_bot_view: true` in settings.js)
- **Brain**: danger/hunger/readiness gauges, quantum via/need/T/H, neural train steps
- **Trace**: last 20 events with timestamps
- **Inventory**: item icons with counts
- **Chat**: live messages + send input + quick commands (!come, !stay, !follow, !stop)

Backend: `full_state.js` extended to stream `brain.neural` and `brain.quantum` via
existing `listen-to-agents` socket.io event. Vision served via prismarine-viewer
iframe when `render_bot_view: true`.

Settings change: `settings.js:43` — `render_bot_view` toggled to `true`.

## Polish pass — 2026-08-26 evening

Extracted NN tuning knobs in `AyushiOS.js` to named constants:
`NN_OUTCOME_WINDOW_MS`, `NN_REPLAY_CAP`, `NN_TRAIN_INTERVAL_MS`, `NN_TRAIN_BATCH`,
`NN_TRAIN_LR`, `NN_SAVE_INTERVAL_MS`, `NN_DEFER_THROTTLE_MS`, `NN_LOG_EVERY`.

All 13 core files pass `node --check`. Neural + quantum + HTN + learning suites
still green.

## Related

- [[2026-08-26]] daily note
- Commit context: `bb835b3` introduced the heartbeat bug; `d1c8c49` introduced #3 and #13; `533e00e` restart-delay reduction exposed #9

# Ayushi OS — the brain

A full nervous system for your Mineflayer bot: she perceives, feels, remembers,
decides, speaks, and acts — instead of just running a script.

## Files

```
src/
  agent.example.js          # how to boot her in a real bot
  brain/
    config.js                # character traits + all tunable thresholds
    EventBus.js               # corpus callosum — connects every region
    SensoryCortex.js          # eyes/ears/skin/proprioception -> one snapshot
    MemoryMatrix.js            # working / episodic / semantic / social memory + dreaming
    PersonalityEngine.js       # traits -> mood, mood -> dialogue tone & risk gating
    SpinalCord.js              # 0ms reflexes, bypasses conscious thought
    TheoryOfMind.js             # lightweight social-risk prediction
    ExecutiveBrain.js          # weighted need-arbitration -> picks one goal per tick
    MotorCortex.js              # wraps YOUR TaskRunner, manages busy state + interrupts
    BrocaArea.js                 # understands chat intent, generates replies
    TaskRunner.example.js       # stub — replace with your real skill engine
```

## Wiring it in

Only one line changes in your real bot:

```js
import TaskRunner from './brain/TaskRunner.example.js'; // swap for your real TaskRunner
import { AyushiOS } from './brain/AyushiOS.js';

bot.once('spawn', () => {
  const taskRunner = new TaskRunner(bot);       // your existing JSON skill engine
  const brain = new AyushiOS(bot, taskRunner);  // she's alive
});
```

Your TaskRunner only needs `runTask(steps): Promise<void>` — everything else
(reflexes, mood, memory, goal selection) is handled by the brain.

## How a tick actually works

Every 2 seconds (`THRESHOLDS.cognitiveTickMs`):

1. **SensoryCortex** builds a fresh snapshot (health, threats, nearby players, inventory, weather...).
2. **PersonalityEngine** turns that snapshot into a mood.
3. **ExecutiveBrain** scores every competing *need* (eat, flee, sleep, avoid a risky player,
   socialize, explore) against the snapshot and picks whichever scores highest —
   mood can veto risky choices even if they scored well (e.g. curiosity loses to fear).
4. **MotorCortex** runs the resulting JSON steps through your TaskRunner.

Meanwhile, **SpinalCord** listens to raw Mineflayer events directly (creeper hiss,
sudden damage, fire, drowning, falling toward the void) and reacts in the same
tick they happen — it doesn't wait for the 2-second loop, and it force-interrupts
whatever the Motor Cortex was doing.

**MemoryMatrix** logs events all the time; only when she actually sleeps
(`bot.on('sleep')`) does REM consolidation run — promoting important memories
from the volatile working buffer into the permanent episodic log, and
re-labeling relationships as friend/enemy based on trust drift.

**BrocaArea** parses incoming chat for simple intent (greeting, question, thanks,
insult, follow-me...) and either uses a fixed-template reply or, optionally, asks
an LLM for an in-character line.

## Suggested additions already built in

These go beyond your original doc — small, cheap modules that make the "human
brain" framing hold up under more situations:

- **EventBus (corpus callosum)** — every region only talks through signals, not
  direct references. Add a new brain region later without touching old code.
- **Weighted need-arbitration instead of if/else priorities** (`ExecutiveBrain.js`)
  — real motivation is competing pulls, not a fixed checklist. Adding a new need
  (say, "collect food for winter") is one object in an array, not a new `if` branch
  buried in a big function.
- **TheoryOfMind.js** — tracks a lightweight behavior pattern per player (attacked?
  gave items? helped?) and produces a risk prediction the Executive Brain factors
  into decisions, rather than trust being the only signal.
- **Semantic memory, separate from episodic memory** — `MemoryMatrix` now
  distinguishes "things that happened" (episodic: dated, decays) from "things I
  know" (semantic: home coordinates, named bases, resource locations) — this
  mirrors how human memory actually splits.
- **Language layer (`BrocaArea.js`)** — basic intent detection on incoming chat
  (not just logging it), plus an optional hook to have an LLM (Claude) generate
  natural in-character dialogue instead of fixed strings, gated behind a feature
  flag so it's fully optional.
- **Mood-gated risk-taking** — `PersonalityEngine.allowsRiskyTasks()` lets fear
  override curiosity/sociability even when they'd otherwise win the goal
  arbitration, so a "Panicked" Ayushi won't wander off to explore mid-crisis.
- **More reflexes** — fire/lava escape, drowning/air-surfacing, and a basic
  void-fall panic, alongside your original creeper-flee and critical-damage ones.
- **Central `config.js`** — every trait and threshold lives in one file so you
  can retune her personality or survival sensitivity without touching logic.

## Ideas for what to add next

- **Homeostasis dashboard** — log health/food/mood over time to a small JSON
  or SQLite time-series so you can literally graph her "wellbeing" across a
  server session — useful for debugging and kind of fun to watch.
- **Curiosity-driven exploration memory** — have `idle_patrol` bias toward
  chunks she hasn't visited recently (store a lightweight visited-chunk set in
  semantic memory) so exploration feels purposeful instead of random.
- **Grudge/forgiveness decay curve** — right now trust only moves on explicit
  events; consider a slow passive decay toward 0 over days, so old grudges fade
  unless reinforced (more human, and prevents permanent enemy lists).
- **Multi-bot shared memory** — if you ever run more than one bot on the same
  server, let them read/write a shared `social` memory file so they build a
  collective reputation system for players.
- **Voice/emote layer** — map moods to particle effects, held-item swaps, or
  `/title`-style text so her internal state is visible even when she's not
  talking.

All of the above are intentionally *not* built yet — they're extensions, not
requirements, so the core brain stays lean and easy to reason about.

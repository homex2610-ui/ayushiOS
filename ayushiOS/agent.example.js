// agent.example.js
// Drop this pattern into your real src/agent/agent.js (or wherever
// your bot spawns). Replace TaskRunner.example.js with your real
// TaskRunner import once you've confirmed the brain works.

import mineflayer from 'mineflayer';
import TaskRunner from './brain/TaskRunner.example.js'; // <-- swap for your real one
import { AyushiOS } from './brain/AyushiOS.js';

const bot = mineflayer.createBot({
  host: 'play.kryonmc.net',
  username: 'ayushi',
  version: '1.20.4'
});

bot.loadPlugin((await import('mineflayer-pathfinder')).pathfinder);

bot.once('spawn', () => {
  console.log('[System] Bot spawned. Booting up Ayushi OS...');

  const taskRunner = new TaskRunner(bot);

  const brain = new AyushiOS(bot, taskRunner);

  // She's alive now: perceiving every tick, reflexively dodging danger,
  // tracking who she trusts, dreaming when she sleeps, and picking her
  // own goals when idle — while still running your JSON task queues
  // whenever you command her directly (e.g. via chat commands that call
  // brain.motor.runGoal('manual_task', jsonSteps)).
});

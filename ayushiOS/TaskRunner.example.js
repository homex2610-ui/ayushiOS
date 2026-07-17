// TaskRunner.example.js
// ─────────────────────────────────────────────────────────────
// You almost certainly already have a real TaskRunner (your
// atomic JSON-skill engine). This file is only here so the
// brain is runnable/testable on its own before you wire in the
// real one. Replace this import in your bot's entry file with
// your actual TaskRunner — MotorCortex only requires one method:
//
//     runTask(steps: Array<{skill: string, params: object}>): Promise<void>
//
// ─────────────────────────────────────────────────────────────

export default class TaskRunner {
  constructor(bot) {
    this.bot = bot;
    // A tiny skill registry as a placeholder — swap for your real one.
    this.skills = {
      eat: async (bot, params) => {
        console.log(`[TaskRunner:stub] eat until food >= ${params.minFoodLevel}`);
      },
      wander: async (bot, params) => {
        console.log(`[TaskRunner:stub] wander within ${params.radius} blocks`);
      },
      interact: async (bot, params) => {
        console.log(`[TaskRunner:stub] interact with ${params.blockName} (${params.action})`);
      },
      flee_or_barricade: async (bot, params) => {
        console.log(`[TaskRunner:stub] flee/barricade from`, params.threats);
      },
      move_away_from: async (bot, params) => {
        console.log(`[TaskRunner:stub] move away from ${params.username}`);
      },
    };
  }

  async runTask(steps) {
    for (const step of steps) {
      const fn = this.skills[step.skill];
      if (!fn) {
        console.warn(`[TaskRunner:stub] Unknown skill "${step.skill}", skipping.`);
        continue;
      }
      await fn(this.bot, step.params || {});
    }
  }
}

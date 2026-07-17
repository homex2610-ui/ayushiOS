// PersonalityEngine.js
// ─────────────────────────────────────────────────────────────
// LIMBIC SYSTEM (mood) + sense of self (traits).
// Mood isn't just cosmetic — ExecutiveBrain reads it before
// picking goals. A "Panicked" Ayushi refuses to accept new
// combat/building tasks even if the JSON queue says to.
// ─────────────────────────────────────────────────────────────

import { CHARACTER, THRESHOLDS } from './config.js';

export class PersonalityEngine {
  constructor(bus) {
    this.bus = bus;
    this.traits = CHARACTER.traits;
    this.currentMood = "Neutral"; // Neutral, Happy, Anxious, Panicked, Angry, Lonely
  }

  evaluateMood(snapshot) {
    const { vitality, threats, environment, social } = snapshot;
    const braveryAdj = 1 - this.traits.bravery; // low bravery = more easily scared

    const prevMood = this.currentMood;

    if (vitality.health < THRESHOLDS.healthCritical || threats.length > 2 * braveryAdj + 1) {
      this.currentMood = "Panicked";
    } else if (threats.length > 0 || (environment.isNight && vitality.health < THRESHOLDS.healthLow)) {
      this.currentMood = "Anxious";
    } else if (social.nearbyPlayers.length === 0 && this.traits.sociability > 0.7) {
      this.currentMood = "Lonely";
    } else if (vitality.food > 18 && vitality.health > 18) {
      this.currentMood = "Happy";
    } else {
      this.currentMood = "Neutral";
    }

    if (prevMood !== this.currentMood) {
      this.bus?.emit('mood_changed', { from: prevMood, to: this.currentMood });
    }
    return this.currentMood;
  }

  // Fixed-template tone (fast, free, offline). Dialogue is generated from
  // deterministic templates and mood state only.
  getDialogueTone() {
    switch (this.currentMood) {
      case "Panicked": return "AHHH! Everything is trying to kill me! Need backup!";
      case "Anxious": return "I don't like the look of this place... keep your eyes open.";
      case "Lonely": return "Kind of quiet out here... anyone around?";
      case "Happy": return "What a gorgeous day in Minecraft! What are we building today?";
      default: return "All systems operational. Ready for tasks.";
    }
  }

  // Blocks risky goals when scared, regardless of what the task queue wants.
  allowsRiskyTasks() {
    if (this.currentMood === "Panicked") return false;
    if (this.currentMood === "Anxious") return this.traits.bravery > 0.6;
    return true;
  }
}

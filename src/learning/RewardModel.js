// RewardModel.js
// Scores every completed task outcome.
// Positive for success, efficiency, safety.
// Negative for failure, death, interruption, excessive time.

const REWARDS = {
  GOAL_COMPLETE: 100,
  SAVED_FOOD: 20,
  AVOIDED_COMBAT: 15,
  LEARNED_NEW: 10,
  FAST_COMPLETION: 10,
  NO_INTERRUPTIONS: 10,
  SUCCESSFUL_RETRY: 5,
  RESOURCE_EFFICIENT: 5,
  COMPLETED_STEPS: (n) => Math.min(20, n * 3),
  PENALTY_DEATH: -40,
  PENALTY_INTERRUPTED: -25,
  PENALTY_TOO_SLOW: -15,
  PENALTY_FAILED: -30,
  PENALTY_WASTED_RESOURCES: -10,
  PENALTY_REPEATED_FAILURE: -20,
};

export class RewardModel {
  constructor() {
    this._learningRate = 1.0;
    this._discount = 0.9;
  }

  calculate(experience) {
    let reward = 0;

    if (experience.isSuccess()) {
      reward += REWARDS.GOAL_COMPLETE;
      reward += REWARDS.COMPLETED_STEPS(experience.actions.length);

      if (experience.duration > 0 && experience.duration < 30000) {
        reward += REWARDS.FAST_COMPLETION;
      }

      if (experience.beliefsSnapshot.food && experience.beliefsSnapshot.food > 16) {
        reward += REWARDS.SAVED_FOOD;
      }

      if (!experience.wasInterrupted()) {
        reward += REWARDS.NO_INTERRUPTIONS;
      }
    }

    if (experience.isFailure()) {
      reward += REWARDS.PENALTY_FAILED;
      if (experience.failureReason) {
        const fr = experience.failureReason.toLowerCase();
        if (/death|kill|die|exploded/.test(fr)) reward += REWARDS.PENALTY_DEATH;
        if (/interrupt|cancel|stop|pause/.test(fr)) reward += REWARDS.PENALTY_INTERRUPTED;
        if (/timeout|slow|took long/.test(fr)) reward += REWARDS.PENALTY_TOO_SLOW;
      }
    }

    if (experience.wasInterrupted()) {
      reward += REWARDS.PENALTY_INTERRUPTED;
    }

    if (experience.lessonsLearned.length > 0) {
      reward += REWARDS.LEARNED_NEW * Math.min(3, experience.lessonsLearned.length);
    }

    return Math.round(reward * this._learningRate);
  }

  setLearningRate(rate) {
    this._learningRate = Math.max(0.1, Math.min(2.0, rate));
  }

  normalize(reward) {
    return Math.max(-100, Math.min(150, reward));
  }
}

// telemetry_events.js — P1
// ─────────────────────────────────────────────────────────────
// CANONICAL telemetry vocabulary. Every subsystem event that the future
// AYUSHI OS Control Center (and any log analysis) consumes MUST use one of
// these names. Emitting ad-hoc event names is a review failure.
//
// Transport today: AyushiOS internal EventBus (`bus.emit`). The MindServer
// bridge (P3) will forward these to Socket.IO clients verbatim.
// ─────────────────────────────────────────────────────────────

export const TELEMETRY = Object.freeze({
    // Perception / world
    PERCEPTION_UPDATED: 'perception.updated',
    WORLD_MODEL_TICK: 'worldmodel.tick',
    THREAT_ASSESSED: 'threat_assessed',

    // Beliefs & goals
    BELIEF_UPDATED: 'belief.updated',
    GOAL_SELECTED: 'goal_selected',
    GOAL_SCORES: 'goal_scores',            // full WHY-THIS/WHY-NOT ranking
    GOAL_INTERRUPTED: 'goal.interrupted',
    GOAL_RESUMED: 'goal.resumed',

    // Planning
    PLAN_CREATED: 'plan.created',          // plan_composed alias — canonical name
    PLAN_REJECTED: 'plan.rejected',

    // Tasks (TaskManager)
    TASK_CREATED: 'task_created',
    TASK_STARTED: 'task_started',
    TASK_COMPLETED: 'task_completed',
    TASK_FAILED: 'task_failed',
    TASK_PAUSED: 'task_paused',
    TASK_CANCEL_REQUESTED: 'task_cancel_requested',
    TASK_CANCELLED: 'task_cancelled',
    TASK_RESUMED: 'task_resumed',

    // Reflexes / safety
    REFLEX_FIRED: 'reflex_fired',
    REFLEX_PREEMPT: 'reflex_preempt',
    REFLEX_RESOLVED: 'reflex_resolved',
    EMERGENCY_STOP: 'emergency_stop',

    // Connection
    CONNECTION_CHANGED: 'connection.changed',

    // Learning
    EXPERIENCE_CREATED: 'experience_created',
    LEARNING_UPDATED: 'learning.updated',
});

export default TELEMETRY;

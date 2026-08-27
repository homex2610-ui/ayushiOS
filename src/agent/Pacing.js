// Pacing.js
// ─────────────────────────────────────────────────────────────
// HUMAN REACTION-TIME MODEL — one source of truth for pacing.
// Fixes two opposite complaints at once:
//   • bot freezing for minutes (unbounded move retries × 30s timeouts)
//   • bot acting faster than a human can read (zero reaction delays)
// Every delay here is randomized so cadence never looks robotic.
// ─────────────────────────────────────────────────────────────

export const PACE = {
    // Chat: thinking time before responding to a player message
    REPLY_MIN: 800,
    REPLY_MAX: 2000,

    // Between consecutive autonomous actions/steps
    ACTION_GAP_MIN: 700,
    ACTION_GAP_MAX: 1800,

    // Routine navigation: bounded so a bad path can't freeze us for minutes
    MOVE_TIMEOUT_MS: 15000,   // hard cap per move attempt
    MOVE_RETRIES: 2,          // attempts before giving up (was 3 × 30s)
    MOVE_RETRY_WAIT_MS: 600,  // breather between attempts
};

/** Random integer in [min, max). */
export function randInt(min, max) {
    return Math.floor(min + Math.random() * Math.max(0, max - min));
}

/**
 * Sleep a random human-ish interval.
 * @param {number} minMs
 * @param {number} maxMs
 */
export async function humanPause(minMs, maxMs) {
    await new Promise(r => setTimeout(r, randInt(minMs, maxMs)));
}

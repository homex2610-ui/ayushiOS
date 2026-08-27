// SurvivalSupervisor.js — P0-5
// ─────────────────────────────────────────────────────────────
// High-priority SAFETY SUPERVISOR. Owns every emergency threshold and the
// preemption policy that was previously inlined in AyushiOS._tick.
//
// Rules of engagement:
//  • Observes vitality/threats each cognitive tick.
//  • Returns a preemption decision or null. It NEVER executes actions
//    itself and NEVER picks strategic goals — execution stays in
//    MotorCortex, strategy stays in ExecutiveBrain.
//  • Rate-limits emergencies globally to prevent reflex thrash.
// ─────────────────────────────────────────────────────────────

import { THRESHOLDS } from '../brain/config.js';

export class SurvivalSupervisor {
    constructor({ bus } = {}) {
        this.bus = bus || null;
        this._lastEmergencyAt = 0;
        this.lastDecision = null;
    }

    /**
     * Assess a perception snapshot while a task is running.
     * @returns {null | {kind:'retreat'|'eat', reason:string}}
     */
    assess(snapshot) {
        const EMERGENCY_COOLDOWN_MS = 1500;
        const now = Date.now();
        if (now - this._lastEmergencyAt < EMERGENCY_COOLDOWN_MS) return null;

        const threats = snapshot?.threats || [];
        const health = snapshot?.vitality?.health ?? 20;
        const food = snapshot?.vitality?.food ?? 20;
        const hasFood = !!snapshot?.vitality?.hasFood;

        // Pro player rule: only react to threats within DANGER range (8 blocks)
        // Distant mobs are NOT an emergency — keep working, stay alert
        const DANGER_RANGE = 8;
        const nearbyThreats = threats.filter(t => {
            return t && t.distance != null && t.distance < DANGER_RANGE;
        });

        const creeperNear = nearbyThreats.some(t =>
            (t.name || t.type || '').toLowerCase().includes('creeper'));

        let decision = null;
        if (health < THRESHOLDS.healthCritical || creeperNear) {
            decision = { kind: 'retreat', reason: creeperNear ? 'creeper_near' : 'health_critical' };
        } else if (food < THRESHOLDS.foodCritical && hasFood) {
            decision = { kind: 'eat', reason: 'food_critical' };
        }

        if (decision) {
            this._lastEmergencyAt = now;
            decision.time = now;
            console.log(`[SurvivalSupervisor] ⚠ Preempt: ${decision.kind} (${decision.reason})`);
            this.bus?.emit('threat_assessed', { decision, health, food });
        }
        this.lastDecision = decision;
        return decision;
    }
}

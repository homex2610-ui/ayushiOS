// WorldModel.js — P0-6
// ─────────────────────────────────────────────────────────────
// CANONICAL world representation v1. One place defines:
//   • THREAT_CONTRACT — what counts as a threat, at which radii.
//     (Previously 7 divergent detectors across the codebase.)
//   • VITALITY_CONTRACT — hunger/health thresholds. ONE source of truth
//     for "am I hungry" (previously eat-at-6 vs 8 vs 14 disagreements).
//   • build(snapshot) → normalized world view consumed by BeliefState,
//     ExecutiveBrain scoring, and the dashboard.
//
// SensoryCortex remains the raw sensor; this module is the MODEL layer:
// normalization + contracts + belief feeding. No decisions here.
// ─────────────────────────────────────────────────────────────

import * as mc from '../utils/mcdata.js';
import { countResource } from '../utils/item_families.js';
import { THRESHOLDS } from '../brain/config.js';

export const VITALITY_CONTRACT = Object.freeze({
    healthCritical: THRESHOLDS.healthCritical ?? 6,
    foodCritical: THRESHOLDS.foodCritical ?? 6,
    foodLow: THRESHOLDS.foodLow ?? 12,
    foodComfortable: THRESHOLDS.foodComfortable ?? 18,
});

export const THREAT_CONTRACT = Object.freeze({
    meleeRadius: 4.5,        // immediate combat danger (SpinalCord reflex zone)
    awarenessRadius: 24,     // strategic threat assessment (ExecutiveBrain)
    fleeRadius: 8,           // cowardice/mood reactions
    // Hostility classification — single authority (was duplicated ×7)
    isHostile(entity) {
        try { return !!entity && (entity.kind === 'Hostile mobs' || mc.isHostile(entity)); }
        catch { return false; }
    },
});

export class WorldModel {
    constructor({ bot, beliefs = null, memory = null } = {}) {
        this.bot = bot;
        this.beliefs = beliefs;
        this.memory = memory;
        this.last = null;
        this.updatedAt = 0;
    }

    /**
     * Normalize a raw SensoryCortex snapshot into the canonical world view.
     * @returns {object} world — same reference each tick, mutated in place.
     */
    update(raw) {
        const w = this.last || (this.last = {});
        const pos = raw?.environment?.position ?? this.bot?.entity?.position ?? null;

        w.position = pos ? { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } : null;
        w.dimension = raw?.environment?.dimension ?? null;
        w.biome = raw?.environment?.biome ?? null;
        w.time = raw?.environment?.timeOfDay ?? null;
        w.weather = raw?.environment?.weather ?? null;
        w.isNight = !!raw?.environment?.isNight;
        w.gamemode = this.bot?.game?.gameMode ?? null;

        // ── Vitality contract ──
        const health = raw?.vitality?.health ?? this.bot?.health ?? 20;
        const food = raw?.vitality?.food ?? this.bot?.food ?? 20;
        w.vitality = {
            health,
            food,
            hasFood: !!raw?.vitality?.hasFood,
            state: health <= VITALITY_CONTRACT.healthCritical ? 'critical'
                : food <= VITALITY_CONTRACT.foodCritical ? 'starving'
                : food <= VITALITY_CONTRACT.foodLow ? 'hungry'
                : food >= VITALITY_CONTRACT.foodComfortable ? 'comfortable' : 'ok',
        };

        // ── Threat contract ──
        const threats = [];
        let nearestHostileDist = Infinity, nearestHostileName = null;
        for (const t of raw?.threats || []) {
            const dist = Number.isFinite(t.distance) ? t.distance : null;
            threats.push({ name: t.name || t.type || 'unknown', distance: dist });
            if (dist != null && dist < nearestHostileDist) {
                nearestHostileDist = dist; nearestHostileName = t.name || t.type;
            }
        }
        w.threats = threats;
        w.threatLevel = threats.length === 0 ? 'none'
            : nearestHostileDist <= THREAT_CONTRACT.meleeRadius ? 'immediate'
            : nearestHostileDist <= THREAT_CONTRACT.awarenessRadius ? 'nearby' : 'distant';
        w.nearestThreat = nearestHostileName ? { name: nearestHostileName, dist: Math.round(nearestHostileDist) } : null;

        // ── Social / resources / equipment passthrough (normalized) ──
        w.players = (raw?.social?.nearbyPlayers || []).map(p => ({
            name: p.username || p.name, distance: Number.isFinite(p.distance) ? Math.round(p.distance) : null,
        }));
        w.inventoryCounts = raw?.resources?.inventoryCounts || {};
        w.equipment = raw?.equipment || {};
        w.resources = {
            hasCraftingTable: !!(raw?.resources?.hasCraftingTable),
            hasFurnace: !!(raw?.resources?.hasFurnace),
            hasBed: !!(raw?.resources?.hasBed),
            woodTotal: countResource(w.inventoryCounts, 'log'),
            planksTotal: countResource(w.inventoryCounts, 'planks'),
            foodTotal: countResource(w.inventoryCounts, 'food'),
            fuelTotal: countResource(w.inventoryCounts, 'fuel'),
            ironTotal: countResource(w.inventoryCounts, 'iron'),
        };

        this.updatedAt = Date.now();

        // Feed transient facts to the authoritative BeliefState
        try {
            this.beliefs?.update({
                position: w.position,
                biome: w.biome,
                isNight: w.isNight,
                vitality: w.vitality,
                threatLevel: w.threatLevel,
                nearestThreat: w.nearestThreat,
                nearbyPlayers: w.players,
            }, 'world_model');
        } catch (_) {}

        return w;
    }

    /** Dashboard/diagnostic projection. */
    describe() {
        if (!this.last) return 'no perception yet';
        const w = this.last;
        return [
            `${w.dimension ?? '?'} @ ${w.position ? `(${w.position.x},${w.position.y},${w.position.z})` : '?'}`,
            `hp=${w.vitality.health} food=${w.vitality.food} (${w.vitality.state})`,
            `threat=${w.threatLevel}${w.nearestThreat ? ` (${w.nearestThreat.name} ${w.nearestThreat.dist}m)` : ''}`,
            `players=${w.players.length}`, `night=${w.isNight}`,
        ].join(' | ');
    }
}

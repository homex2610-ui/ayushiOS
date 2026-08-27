// SwimController.js
// ─────────────────────────────────────────────────────────────
// WHY THIS EXISTS: mineflayer-pathfinder (this version) has NO swim
// moves — it only walks along the bottom of water bodies. In deep
// water the bot waded on the lake floor, ran out of oxygen and
// drowned or panicked. This module gives the bot REAL swimming:
// raw-control surface swimming steered toward a target, with
// oxygen safety and shore egress. Zero LLM, pure physics.
// ─────────────────────────────────────────────────────────────

import Vec3 from 'vec3';

/** Feet or eye block is water? */
export function isInWater(bot) {
    try {
        if (!bot?.entity?.position) return false;
        const feet = bot.blockAt(bot.entity.position);
        if (feet?.name === 'water') return true;
        const eye = bot.blockAt(bot.entity.position.offset(0, 1.5, 0));
        return eye?.name === 'water';
    } catch (_) { return false; }
}

/** Deep enough that walking out is impossible — must swim. */
export function isDeepWater(bot) {
    try {
        if (!isInWater(bot)) return false;
        const p = bot.entity.position;
        const below = bot.blockAt(p.offset(0, -1, 0));
        const head = bot.blockAt(p.offset(0, 1.5, 0));
        return below?.name === 'water' || head?.name === 'water';
    } catch (_) { return false; }
}

function clearControls(bot) {
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
        try { bot.setControlState(c, false); } catch (_) {}
    }
}

/**
 * Actively swim toward (x,y,z). Holds jump to ride the surface (the
 * fastest vanilla swim posture), steers with lookAt, sprints when fed.
 * Resolves true when close to target OR standing on land again,
 * false on timeout. Oxygen-safe: surfaces first if running low.
 */
export async function swimToward(bot, x, y, z, { timeoutMs = 20000 } = {}) {
    if (!bot?.entity) return false;
    const start = Date.now();
    let lastSteer = 0;
    let surfacedAt = 0;

    console.log(`[Swim] Engaging swim → (${x | 0}, ${y | 0}, ${z | 0})`);

    try {
        while (Date.now() - start < timeoutMs && bot.entity) {
            const p = bot.entity.position;
            const dist = Math.hypot(x - p.x, y - p.y, z - p.z);

            // Arrived near the goal?
            if (dist <= 2.5) break;

            // Reached land near-ish the target heading? Let pathfinder take over.
            if (!isInWater(bot)) {
                if (!surfacedAt) surfacedAt = Date.now();
                if (Date.now() - surfacedAt > 600 || dist < 8) break;
            } else {
                surfacedAt = 0;
            }

            // OXYGEN SAFETY: ascend aggressively when low — jump-hold rises fast
            const o2 = bot.oxygenLevel ?? 20;
            if (o2 <= 6) {
                try { bot.setControlState('forward', false); } catch (_) {}
                try { bot.setControlState('jump', true); } catch (_) {}
                await new Promise(r => setTimeout(r, 250));
                continue;
            }

            // Steer toward target (10 Hz steering, cheap)
            if (Date.now() - lastSteer > 100) {
                lastSteer = Date.now();
                try {
                    await bot.lookAt(new Vec3(x, p.y + 0.4, z), true);
                } catch (_) {}
            }

            try {
                bot.setControlState('jump', true);      // surface swim = fastest
                bot.setControlState('forward', true);
                if ((bot.food ?? 20) > 6) bot.setControlState('sprint', true);
            } catch (_) {}

            // Anti-stuck: if barely moving for 4s, do a dive-and-round stroke
            // (occasionally the hull catches on a block under the surface)
            bot._swimLastPos ??= { x: p.x, y: p.y, z: p.z, t: Date.now() };
            const lp = bot._swimLastPos;
            if (Date.now() - lp.t > 4000) {
                const moved = Math.hypot(p.x - lp.x, p.y - lp.y, p.z - lp.z);
                if (moved < 1.0) {
                    // nudge: brief sink + strafe to unstick
                    try {
                        bot.setControlState('jump', false);
                        bot.setControlState('sneak', true);
                        bot.lookAt(new Vec3(x, p.y - 1.5, z), true);
                    } catch (_) {}
                    await new Promise(r => setTimeout(r, 500));
                    try { bot.setControlState('sneak', false); } catch (_) {}
                }
                Object.assign(lp, { x: p.x, y: p.y, z: p.z, t: Date.now() });
            }

            await new Promise(r => setTimeout(r, 60));
        }
    } finally {
        clearControls(bot);
        delete bot._swimLastPos;
    }

    const ok = !isInWater(bot) || bot.entity.position.distanceTo(new Vec3(x, y, z)) < 4;
    console.log(`[Swim] Done (${ok ? 'reached' : 'timeout'})`);
    return ok;
}

/**
 * Find the nearest walk-out direction when stranded in open water with
 * no target: scans loaded columns on an expanding ring for non-water
 * ground. Returns {x,z} of nearest shore or null.
 */
export function nearestShore(bot, maxRange = 40) {
    try {
        const p = bot.entity.position;
        const py = Math.floor(p.y);
        for (let r = 4; r <= maxRange; r += 4) {
            for (let a = 0; a < 16; a++) {
                const ang = (a / 16) * Math.PI * 2;
                const tx = Math.floor(p.x + Math.cos(ang) * r);
                const tz = Math.floor(p.z + Math.sin(ang) * r);
                for (let dy = 6; dy >= -6; dy--) {
                    const b = bot.blockAt(new Vec3(tx, py + dy, tz));
                    if (b && b.boundingBox === 'block' && b.name !== 'water') {
                        return { x: tx, z: tz };
                    }
                }
            }
        }
    } catch (_) {}
    return null;
}

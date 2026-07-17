export async function smoothLook(bot, yaw, pitch, steps = 15) {
    const startYaw = bot.entity.yaw;
    const startPitch = bot.entity.pitch;

    let diffYaw = yaw - startYaw;
    while (diffYaw < -Math.PI) diffYaw += Math.PI * 2;
    while (diffYaw > Math.PI) diffYaw -= Math.PI * 2;

    const diffPitch = pitch - startPitch;

    for (let i = 1; i <= steps; i++) {
        const progress = i / steps;
        const ease = (1 - Math.cos(progress * Math.PI)) / 2;

        const targetYaw = startYaw + diffYaw * ease;
        const targetPitch = startPitch + diffPitch * ease;

        bot.look(targetYaw, targetPitch, true);
        await new Promise(resolve => bot.once('physicsTick', resolve));
    }
}

export async function smoothLookAt(bot, targetPos, steps = 15) {
    const dx = targetPos.x - bot.entity.position.x;
    const dz = targetPos.z - bot.entity.position.z;
    const dy = targetPos.y - (bot.entity.position.y + bot.entity.height);

    const yaw = Math.atan2(-dx, -dz);
    const groundDist = Math.sqrt(dx * dx + dz * dz);
    const pitch = -Math.atan2(dy, groundDist);

    await smoothLook(bot, yaw, pitch, steps);
}

export function startIdleLookRoutine(bot) {
    let interval = null;
    let active = true;

    const tick = () => {
        if (!active) return;
        if (!bot || !bot.entity) return;
        if (bot.pathfinder && bot.pathfinder.isMoving()) return;
        if (Math.random() > 0.35) return;

        const nearbyEntity = bot.nearestEntity(e =>
            e.type === 'player' && e.id !== bot.entity.id && bot.entity.position.distanceTo(e.position) < 16
        );

        if (nearbyEntity) {
            const headOffset = (Math.random() - 0.5) * 0.4;
            const targetPos = nearbyEntity.position.offset(0, 1.6 + headOffset, 0);
            bot.lookAt(targetPos);
        } else {
            const yaw = bot.entity.yaw + (Math.random() - 0.5) * 1.2;
            const pitch = (Math.random() - 0.5) * 0.5;
            bot.look(yaw, pitch, true);
        }
    };

    interval = setInterval(tick, 4000 + Math.random() * 4000);

    return {
        stop: () => {
            active = false;
            if (interval) clearInterval(interval);
            interval = null;
        },
        isActive: () => active,
    };
}

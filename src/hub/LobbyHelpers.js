export async function useHotbarSelector(bot, slot) {
  console.log(`[LobbyHelpers] Selecting hotbar slot ${slot}...`);

  bot.setQuickBarSlot(slot);

  if (typeof bot.waitForTicks === 'function') {
    await bot.waitForTicks(3);
  } else {
    await new Promise(r => setTimeout(r, 150));
  }

  if (bot.entity) {
    const yaw = bot.entity.yaw;
    const lookTarget = bot.entity.position.offset(
      -Math.sin(yaw) * 3,
      0.5,
      -Math.cos(yaw) * 3
    );
    try { await bot.lookAt(lookTarget, true); } catch (e) {}
  }

  // Try right-click first (use item), then left-click (attack) if that fails
  console.log(`[LobbyHelpers] Activating hotbar item (right-click)...`);
  bot.activateItem(false);
  await new Promise(r => setTimeout(r, 500));

  if (!bot.currentWindow) {
    console.log(`[LobbyHelpers] Right-click didn't open GUI, trying left-click...`);
    bot.attack();
    await new Promise(r => setTimeout(r, 500));
  }

  if (!bot.currentWindow) {
    console.log(`[LobbyHelpers] Left-click also didn't open GUI, trying swing...`);
    bot.swingArm();
    await new Promise(r => setTimeout(r, 500));
  }
}

export function findPhysicalNPC(bot, npcName) {
  const target = bot.nearestEntity(entity => {
    if (entity.type === 'player' && entity.username === bot.username) return false;
    if (entity.entityType === 'armor_stand' || entity.name === 'armor_stand') return false;
    if (entity.type === 'drop') return false;
    const rawName = entity.displayName || entity.username || entity.metadata?.[2]?.toString?.() || '';
    if (!rawName) return false;
    const cleanName = String(rawName).replace(/§[0-9a-fk-orxX]/g, '').toLowerCase();
    return cleanName.includes(npcName.toLowerCase());
  });
  return target;
}

export async function interactWithNPC(bot, npcName, hotbarManager) {
  console.log(`[LobbyHelpers] Finding NPC: "${npcName}"...`);
  const npc = findPhysicalNPC(bot, npcName);
  if (!npc) {
    console.log(`[LobbyHelpers] No physical NPC found for "${npcName}"`);
    return { success: false, reason: 'not_found' };
  }

  const dist = bot.entity.position.distanceTo(npc.position);
  console.log(`[LobbyHelpers] NPC "${npcName}" at distance ${dist.toFixed(1)}m`);

  if (dist > 3.5) {
    if (bot.pathfinder) {
      try {
        const pf = await import('mineflayer-pathfinder');
        const GoalNear = (pf.default?.goals || pf.goals)?.GoalNear;
        if (GoalNear) {
          await bot.pathfinder.goto(new GoalNear(npc.position.x, npc.position.y, npc.position.z, 2));
        } else {
          bot.setControlState('forward', true);
          await new Promise(r => setTimeout(r, 1000));
          bot.clearControlStates();
        }
      } catch {
        bot.setControlState('forward', true);
        await new Promise(r => setTimeout(r, 1000));
        bot.clearControlStates();
      }
    } else {
      bot.setControlState('forward', true);
      await new Promise(r => setTimeout(r, 1000));
      bot.clearControlStates();
    }
  }

  const lookTarget = npc.position.offset(0, (npc.height || 1.8) * 0.7, 0);
  await bot.lookAt(lookTarget, true);

  if (typeof bot.waitForTicks === 'function') {
    await bot.waitForTicks(2);
  } else {
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`[LobbyHelpers] Interacting with NPC: ${npcName}`);
  try {
    bot.activateEntity(npc);
  } catch (e) {
    try {
      await bot.useOn(npc);
    } catch (e2) {
      console.warn(`[LobbyHelpers] NPC interaction failed (activateEntity + useOn): ${e2.message}`);
      return { success: false, reason: 'interact_failed', error: e2.message };
    }
  }

  return new Promise(resolve => {
    let settled = false;
    const onWindowOpen = window => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      console.log(`[LobbyHelpers] NPC interaction opened GUI: "${window.title || 'Container'}"`);
      resolve({ success: true, window, reason: 'gui_opened' });
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Detach the pending listener — leaked once-handlers fire on GUIs
      // opened much later and accumulate every hub visit.
      bot.removeListener('windowOpen', onWindowOpen);
      console.log(`[LobbyHelpers] NPC interaction done — no GUI opened`);
      resolve({ success: true, window: null, reason: 'interacted_no_gui' });
    }, 1500);
    bot.once('windowOpen', onWindowOpen);
  });
}

export async function findGUIDestination(bot, targetMode, guiClient) {
  const MODE_KEYWORDS = {
    survival: ['survival', 'smp', 'earth', 'vanilla', 'towny', 'overworld'],
    lifesteal: ['lifesteal', 'life_steal'],
    practice: ['practice', 'prac', 'pvp practice', 'duel', 'arena'],
    kitpvp: ['kitpvp', 'kit pvp', 'pvp', 'combat', 'battle', 'war'],
    bedwars: ['bedwars', 'bed wars', 'bed'],
    skywars: ['skywars', 'sky wars'],
    minigame: ['minigame', 'mini game', 'game', 'event', 'parkour'],
  };

  const keywords = MODE_KEYWORDS[targetMode] || [targetMode];
  const slot = guiClient.findSlot(keywords);
  if (slot) {
    console.log(`[LobbyHelpers] Found GUI slot for "${targetMode}": slot ${slot.slot} — "${slot.displayName}"`);
    return slot;
  }

  for (const kw of keywords) {
    const alts = guiClient.findSlotsByName(kw);
    if (alts.length > 0) {
      console.log(`[LobbyHelpers] Found alternative slot for "${kw}": slot ${alts[0].slot}`);
      return alts[0];
    }
  }

  console.log(`[LobbyHelpers] No GUI slot found for "${targetMode}"`);
  return null;
}

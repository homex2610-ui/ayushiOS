import * as prismarineNbt from 'prismarine-nbt';

export function dumpWindow(bot) {
  console.log('\n=== [DEBUG: CURRENT OPEN WINDOW] ===');
  const window = bot.currentWindow;
  if (!window) {
    console.log('No active Container UI / Chest window open.');
    return;
  }
  console.log(`Title: ${window.title || window.type} | ID: ${window.id}`);
  console.log(`Inventory Capacity: ${window.slots.length} slots`);

  window.slots.forEach((item, idx) => {
    if (!item) return;
    const lore = item.nbt ? extractLore(item.nbt) : null;
    console.log(`  Slot #${idx.toString().padStart(2, '0')}: ${item.displayName} (${item.name}) x${item.count}`);
    if (lore && lore.length > 0) {
      lore.forEach(line => console.log(`    Lore: ${line}`));
    }
  });
  console.log('====================================\n');
}

function extractLore(nbt) {
  try {
    const simplified = prismarineNbt.simplify(nbt);
    if (simplified.display && simplified.display.Lore) {
      const lore = Array.isArray(simplified.display.Lore) ? simplified.display.Lore : [simplified.display.Lore];
      return lore.map(l => String(l).replace(/§./g, ''));
    }
  } catch (e) {
    // silent
  }
  return null;
}

export function dumpNPCs(bot) {
  console.log('\n=== [DEBUG: NEARBY ENTITIES / NPCs] ===');
  let detected = 0;
  for (const id in bot.entities) {
    const entity = bot.entities[id];
    const isPlayer = entity.type === 'player';
    const hasName = entity.username || (entity.metadata && entity.metadata[2]);

    if ((isPlayer && entity.username !== bot.username) || hasName) {
      const name = entity.username || entity.metadata[2];
      const distance = bot.entity.position.distanceTo(entity.position).toFixed(1);
      console.log(`  - [${(entity.type || 'unknown').toUpperCase()}] ${name} | Dist: ${distance}m | Pos: ${entity.position.floored().toString()}`);
      detected++;
    }
  }
  if (detected === 0) console.log('No visible NPCs or external players.');
  console.log('========================================\n');
}

export function dumpHotbar(bot) {
  console.log('\n=== [DEBUG: PLAYER HOTBAR] ===');
  for (let i = 0; i < 9; i++) {
    const invSlot = 36 + i;
    const item = bot.inventory.slots[invSlot];
    const indicator = bot.quickbarSlot === i ? ' ->' : '   ';
    if (item) {
      const lore = item.nbt ? extractLore(item.nbt) : null;
      console.log(`${indicator} Hotbar #${i} (Slot ${invSlot}): ${item.displayName} (${item.name}) x${item.count}`);
      if (lore && lore.length > 0) {
        lore.forEach(line => console.log(`     Lore: ${line}`));
      }
    } else {
      console.log(`${indicator} Hotbar #${i} (Slot ${invSlot}): Empty`);
    }
  }
  console.log('==============================\n');
}

export function dumpScoreboard(bot) {
  console.log('\n=== [DEBUG: SCOREBOARD] ===');
  const sb = bot.scoreboard;
  if (!sb) {
    console.log('No active scoreboard.');
    return;
  }
  if (sb.title) {
    console.log(`Sidebar Title: "${resolveText(sb.title)}"`);
  }
  if (sb.items) {
    const lines = Object.values(sb.items).filter(i => i);
    lines.forEach(item => {
      const name = resolveText(item.displayName) || item.name || String(item);
      console.log(`  - ${name}`);
    });
  }
  if (sb.sidebar) {
    console.log(`Sidebar objective: "${resolveText(sb.sidebar.title) || 'untitled'}"`);
    if (sb.sidebar.items) {
      sb.sidebar.items.forEach(item => {
        const name = resolveText(item.displayName) || item.name || String(item);
        console.log(`  ${name}: ${item.value || ''}`);
      });
    }
  }
  if (sb.belowName) {
    console.log(`BelowName: "${resolveText(sb.belowName.title) || 'untitled'}"`);
  }
  if (sb.player) {
    console.log(`PlayerList objective present`);
  }
  console.log('=============================\n');
}

function resolveText(component) {
  if (!component) return '';
  if (typeof component === 'string') return component.replace(/§./g, '');
  let text = '';
  if (typeof component.text === 'string') text += component.text;
  if (typeof component.value === 'string') text += component.value;
  if (component.value && typeof component.value === 'object') text += resolveText(component.value);
  if (Array.isArray(component.extra)) {
    component.extra.forEach(part => { text += resolveText(part); });
  }
  if (component.translate && component.with) {
    text += component.translate;
    component.with.forEach(arg => { text += resolveText(arg); });
  }
  return text.replace(/§./g, '');
}

export function dumpBossbar(bot) {
  console.log('\n=== [DEBUG: ACTIVE BOSSBARS] ===');
  const bars = bot.bossBars;
  if (!bars || Object.keys(bars).length === 0) {
    console.log('No active bossbars.');
    return;
  }
  for (const id in bars) {
    const bar = bars[id];
    console.log(`  Bossbar [${id}]: "${bar.title}" | Level: ${bar.health * 100}% | Color: ${bar.color}`);
  }
  console.log('================================\n');
}

export function dumpAll(bot) {
  console.log('\n########################################################');
  console.log('##               RUNTIME ENVIRONMENT REPORT           ##');
  console.log('########################################################');
  dumpHotbar(bot);
  dumpScoreboard(bot);
  dumpBossbar(bot);
  dumpNPCs(bot);
  dumpWindow(bot);
  console.log('########################################################\n');
}



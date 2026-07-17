export class EnvironmentReporter {
  constructor(agent) {
    this.agent = agent;
    this.bot = agent.bot;
  }

  summarize() {
    const bot = this.bot;
    const kb = this.agent.serverAnalyzer?.kb;
    if (!bot || !bot.entity) return null;

    return {
      environment: this._getEnvironment(),
      hotbar: this._getHotbar(),
      npcs: this._getNPCs(kb),
      window: this._getWindow(),
      scoreboard: this._getScoreboard(),
      heldItem: this._getHeldItem(),
      playerCount: Object.keys(bot.players || {}).length,
    };
  }

  format() {
    const s = this.summarize();
    if (!s) return 'ENVIRONMENT: Bot not spawned yet.';

    let out = '';

    out += `SERVER: ${s.environment.server}\n`;
    out += `WORLD: ${s.environment.worldType}\n`;
    out += `DIMENSION: ${s.environment.dimension}\n`;
    out += `PLAYERS: ${s.playerCount}\n`;
    out += `POSITION: ${s.environment.position}\n`;

    out += `\nSCOREBOARD:\n`;
    if (s.scoreboard.title) {
      out += `  Title: ${s.scoreboard.title}\n`;
      for (const line of s.scoreboard.lines.slice(0, 5)) {
        out += `  ${line}\n`;
      }
    } else {
      out += `  (none)\n`;
    }

    out += `\nHELD ITEM:\n`;
    if (s.heldItem) {
      out += `  Name: ${s.heldItem.name}\n`;
      out += `  Display: ${s.heldItem.displayName}\n`;
      if (s.heldItem.lore.length > 0) {
        out += `  Lore: ${s.heldItem.lore[0]}\n`;
      }
    } else {
      out += `  (empty)\n`;
    }

    out += `\nHOTBAR:\n`;
    for (const item of s.hotbar) {
      out += `  Slot ${item.slot}: ${item.displayName}`;
      if (item.enchanted) out += ` (enchanted)`;
      if (item.lore.length > 0) out += ` — ${item.lore[0]}`;
      out += `\n`;
    }

    if (s.npcs.length > 0) {
      out += `\nNEARBY NPCS:\n`;
      for (const npc of s.npcs) {
        out += `  ${npc.name} (${npc.distance}m)`;
        if (npc.traits.length > 0) out += ` [${npc.traits.join(', ')}]`;
        out += `\n`;
      }
    }

    if (s.window) {
      out += `\nOPEN WINDOW:\n`;
      out += `  Title: ${s.window.title}\n`;
      out += `  Slots: ${s.window.slotCount}\n`;
      for (const slot of s.window.slots.slice(0, 9)) {
        out += `  Slot ${slot.slot}: ${slot.displayName}`;
        if (slot.enchanted) out += ` (enchanted)`;
        if (slot.lore.length > 0) out += ` [${slot.lore[0]}]`;
        out += `\n`;
      }
    }

    out += `\nCAPABILITIES:\n`;
    const caps = this.agent.serverCapabilities;
    if (caps) {
      for (const [key, val] of Object.entries(caps.getAll())) {
        if (val !== null) out += `  ${key}: ${val}\n`;
      }
    }

    out += `\nRECOMMENDED ACTION:\n`;
    if (s.environment.isHub) {
      out += `  Use ${s.heldItem?.displayName || 'compass'} to join survival\n`;
    } else {
      out += `  Idle or execute current task\n`;
    }

    return out;
  }

  _getEnvironment() {
    const bot = this.bot;
    const wd = this.agent.connectionManager?.worldDetector;
    const profile = wd?.worldProfile;

    return {
      server: bot.scoreboard?.title || 'unknown',
      worldType: profile?.type || 'unknown',
      isHub: profile?.type === 'hub' || profile?.isHub || false,
      dimension: bot.world?.dimension || 'unknown',
      position: bot.entity?.position
        ? `${bot.entity.position.x.toFixed(0)}, ${bot.entity.position.y.toFixed(0)}, ${bot.entity.position.z.toFixed(0)}`
        : 'unknown',
      time: bot.time?.timeOfDay >= 0
        ? `${Math.floor(bot.time.timeOfDay / 1000)}:${String(Math.floor(bot.time.timeOfDay % 1000 / 16.67)).padStart(2, '0')}`
        : 'unknown',
    };
  }

  _getHotbar() {
    const items = this.bot.inventory?.items() || [];
    return items
      .filter(i => i.slot >= 36 && i.slot <= 44)
      .map(i => ({
        slot: i.slot - 36,
        name: i.name,
        displayName: i.displayName?.replace(/§./g, '') || i.name,
        count: i.count,
        enchanted: i.enchants?.length > 0,
        lore: (i.lore || []).map(l => String(l).replace(/§./g, '')).slice(0, 2),
      }));
  }

  _getNPCs(kb) {
    const npcs = kb?.get('npcs') || [];
    const bot = this.bot;
    return npcs.slice(0, 8).map(npc => ({
      name: npc.name || 'unknown',
      distance: bot.entity?.position
        ? Math.round(bot.entity.position.distanceTo(npc.position))
        : '?',
      traits: npc.traits || [],
    })).sort((a, b) => (typeof a.distance === 'number' ? a.distance : 999) - (typeof b.distance === 'number' ? b.distance : 999));
  }

  _getWindow() {
    const w = this.bot.currentWindow;
    if (!w) return null;

    const slots = [];
    for (let i = 0; i < (w.containerSize || 0); i++) {
      const item = w.slots[i];
      if (!item) continue;
      slots.push({
        slot: i,
        name: item.name,
        displayName: item.displayName?.replace(/§./g, '') || item.name,
        lore: (item.lore || []).map(l => String(l).replace(/§./g, '')),
        enchanted: item.enchants?.length > 0,
      });
    }

    let title = '';
    try {
      title = typeof w.title === 'string'
        ? w.title.replace(/§./g, '')
        : JSON.stringify(w.title).replace(/§./g, '');
    } catch { title = 'unknown'; }

    return { title, slotCount: slots.length, slots };
  }

  _getScoreboard() {
    const sb = this.bot.scoreboard;
    if (!sb) return { title: null, lines: [] };
    const lines = [];
    if (sb.items) {
      for (const item of Object.values(sb.items)) {
        const text = (item.displayName?.text || item.name || '');
        if (text) lines.push(text.replace(/§./g, ''));
      }
    }
    return {
      title: sb.title?.replace(/§./g, '') || null,
      lines: lines.slice(0, 10),
    };
  }

  _getHeldItem() {
    const qb = this.bot.quickBarSlot ?? 0;
    const item = this.bot.inventory?.items()?.find(i => i.slot === qb + 36);
    if (!item) return null;
    return {
      name: item.name,
      displayName: item.displayName?.replace(/§./g, '') || item.name,
      count: item.count,
      lore: (item.lore || []).map(l => String(l).replace(/§./g, '')),
      slot: qb,
    };
  }
}

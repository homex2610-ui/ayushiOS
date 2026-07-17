export class HubGUIClient {
  constructor(bot) {
    this.bot = bot;
  }

  getOpenWindow() {
    return this.bot.currentWindow || null;
  }

  hasOpenWindow() {
    return this.bot.currentWindow !== null && this.bot.currentWindow !== undefined;
  }

  async waitForWindow(timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (this.hasOpenWindow()) return this.getOpenWindow();
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
  }

  async waitForWindowClose(timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!this.hasOpenWindow()) return true;
      await new Promise(r => setTimeout(r, 200));
    }
    return !this.hasOpenWindow();
  }

  analyzeWindow() {
    const window = this.getOpenWindow();
    if (!window) return null;

    const slots = [];
    const totalSlots = window.slots ? window.slots.length : 0;

    if (!window.title && window.type === 'minecraft:chest') {
      console.log('[HubGUIClient] Window has no title — likely empty/loading');
    }

    for (let i = 0; i < totalSlots; i++) {
      const item = window.slots[i];
      if (!item) continue;
      slots.push({
        slot: i,
        name: item.name,
        displayName: item.displayName?.replace(/§./g, '') || item.name,
        count: item.count,
        lore: (item.lore || []).map(l => String(l).replace(/§./g, '')),
        enchanted: item.enchants?.length > 0 || false,
        damage: item.damage || 0,
        durability: item.durability || null,
        nbt: item.nbt ? item.nbt.toString() : null,
      });
    }

    let title = '';
    try {
      title = typeof window.title === 'string'
        ? window.title.replace(/§./g, '')
        : (window.title?.text || JSON.stringify(window.title)).replace(/§./g, '');
    } catch {
      title = 'unknown';
    }

    return {
      title: title.toLowerCase(),
      titleRaw: title,
      type: window.type,
      slots,
      containerSize: totalSlots,
    };
  }

  findSlot(targetKeywords) {
    const analysis = this.analyzeWindow();
    if (!analysis) return null;

    const keywords = Array.isArray(targetKeywords) ? targetKeywords : [targetKeywords];

    for (const slot of analysis.slots) {
      const searchText = [
        slot.displayName.toLowerCase(),
        slot.name.toLowerCase(),
        ...slot.lore.map(l => l.toLowerCase()),
        slot.nbt ? slot.nbt.toLowerCase() : '',
      ].join(' ');

      const match = keywords.some(k => searchText.includes(k.toLowerCase().replace(/_/g, ' ')));
      if (match) return slot;
    }

    return null;
  }

  findSlotsByLore(keywords) {
    const analysis = this.analyzeWindow();
    if (!analysis) return [];

    const kw = Array.isArray(keywords) ? keywords : [keywords];
    return analysis.slots.filter(slot =>
      slot.lore.some(l => kw.some(k => l.toLowerCase().includes(k.toLowerCase())))
    );
  }

  findSlotsByName(targetName) {
    const analysis = this.analyzeWindow();
    if (!analysis) return [];

    const name = targetName.toLowerCase();
    return analysis.slots.filter(slot =>
      slot.displayName.toLowerCase().includes(name) ||
      slot.name.toLowerCase().includes(name)
    );
  }

  async click(slot, button = 0, mode = 0) {
    if (typeof slot === 'object' && slot.slot !== undefined) slot = slot.slot;
    const window = this.getOpenWindow();
    if (!window) return false;

    try {
      await this.bot.clickWindow(slot, button, mode);
      await new Promise(r => setTimeout(r, 500));
      return true;
    } catch (e) {
      console.warn(`[HubGUIClient] clickWindow slot ${slot} failed: ${e.message}`);
      return false;
    }
  }

  async clickSlot(slot, button = 0, mode = 0) {
    return this.click(slot, button, mode);
  }

  async close() {
    if (!this.hasOpenWindow()) return true;
    try {
      this.bot.closeWindow(this.getOpenWindow());
      await new Promise(r => setTimeout(r, 300));
      return true;
    } catch (e) {
      console.warn(`[HubGUIClient] closeWindow failed: ${e.message}`);
      return false;
    }
  }

  getSlot(index) {
    const window = this.getOpenWindow();
    if (!window || !window.slots) return null;
    const item = window.slots[index];
    if (!item) return null;
    return {
      slot: index,
      name: item.name,
      displayName: item.displayName?.replace(/§./g, '') || item.name,
      count: item.count,
      lore: (item.lore || []).map(l => String(l).replace(/§./g, '')),
    };
  }

  getSlotCount() {
    const analysis = this.analyzeWindow();
    return analysis ? analysis.slots.length : 0;
  }

  getTitle() {
    const analysis = this.analyzeWindow();
    return analysis ? analysis.title : '';
  }
}

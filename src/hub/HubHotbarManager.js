const KNOWN_SELECTOR_NAMES = [
  'compass', 'minecraft:compass',
  'nether_star', 'minecraft:nether_star',
  'slime_ball', 'minecraft:slime_ball',
  'clock', 'minecraft:clock',
  'paper', 'minecraft:paper',
  'book', 'minecraft:book',
  'writable_book', 'minecraft:writable_book',
  'written_book', 'minecraft:written_book',
  'feather', 'minecraft:feather',
  'firework_rocket', 'minecraft:firework_rocket',
  'ender_pearl', 'minecraft:ender_pearl',
  'ender_eye', 'minecraft:ender_eye',
  'egg', 'minecraft:egg',
  'map', 'minecraft:filled_map',
  'blaze_rod', 'minecraft:blaze_rod',
  'stick', 'minecraft:stick',
  'bone', 'minecraft:bone',
  'fire_charge', 'minecraft:fire_charge',
  'experience_bottle', 'minecraft:experience_bottle',
  'tropical_fish', 'minecraft:tropical_fish',
  'nautilus_shell', 'minecraft:nautilus_shell',
  'heart_of_the_sea', 'minecraft:heart_of_the_sea',
];

const TOOL_WEAPON_FOOD = [
  'sword', 'pickaxe', 'axe', 'shovel', 'hoe',
  'helmet', 'chestplate', 'leggings', 'boots',
  'bow', 'crossbow', 'trident', 'shield',
  'fishing_rod', 'carrot_on_a_stick', 'warped_fungus_on_a_stick',
  'bread', 'apple', 'porkchop', 'beef', 'chicken', 'fish',
  'potato', 'carrot', 'beetroot', 'cooked_', 'golden_',
  'mutton', 'rabbit', 'cookie', 'cake', 'pumpkin_pie',
  'melon_slice', 'sweet_berries', 'glow_berries',
  'suspicious_stew', 'honey_bottle', 'mushroom_stew',
  'beetroot_soup', 'rabbit_stew',
];

export class HubHotbarManager {
  constructor(bot) {
    this.bot = bot;
    this._selectorCache = null;
    this._cacheTime = 0;
  }

  getHotbar() {
    const items = this.bot.inventory?.items() || [];
    return items
      .filter(item => item.slot >= 36 && item.slot <= 44)
      .map(item => ({
        slot: item.slot - 36,
        name: item.name,
        displayName: item.displayName?.replace(/§./g, '') || item.name,
        lore: (item.lore || []).map(l => String(l).replace(/§./g, '')),
        count: item.count,
        enchanted: item.enchants?.length > 0,
        nbt: item.nbt ? item.nbt.toString() : null,
        item,
      }));
  }

  getHeldItem() {
    return this.bot.inventory?.items()?.find(i => i.slot === this.bot.quickBarSlot + 36) || null;
  }

  findSelectorItem() {
    const hotbar = this.getHotbar();

    const knownSelectors = hotbar.filter(item =>
      KNOWN_SELECTOR_NAMES.includes(item.name) ||
      KNOWN_SELECTOR_NAMES.includes(item.displayName?.toLowerCase())
    );

    if (knownSelectors.length > 0) {
      knownSelectors.sort((a, b) => {
        const order = ['compass', 'nether_star', 'slime_ball', 'clock', 'paper', 'book'];
        const aIdx = order.indexOf(a.name.replace('minecraft:', ''));
        const bIdx = order.indexOf(b.name.replace('minecraft:', ''));
        return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
      });
      this._cacheSelector(knownSelectors[0]);
      return knownSelectors[0];
    }

    const loreSelectors = hotbar.filter(item =>
      item.lore.some(l => {
        const text = l.toLowerCase();
        return text.includes('server') || text.includes('selector') ||
               text.includes('game') || text.includes('teleport') ||
               text.includes('navigate') || text.includes('menu') ||
               text.includes('join') || text.includes('play');
      })
    );

    if (loreSelectors.length > 0) {
      this._cacheSelector(loreSelectors[0]);
      return loreSelectors[0];
    }

    const fallback = hotbar.find(item =>
      !TOOL_WEAPON_FOOD.some(t => item.name.includes(t)) &&
      !item.lore.some(l => {
        const text = l.toLowerCase();
        return text.includes('damage') || text.includes('attack') || text.includes('defense');
      })
    );

    if (fallback) {
      this._cacheSelector(fallback);
      return fallback;
    }

    return null;
  }

  async selectSlot(slot) {
    if (typeof slot !== 'number' || slot < 0 || slot > 8) return false;
    try {
      this.bot.setQuickBarSlot(slot);
      await new Promise(r => setTimeout(r, 200));
      return true;
    } catch (e) {
      console.warn(`[HubHotbarManager] Failed to select slot ${slot}: ${e.message}`);
      return false;
    }
  }

  async useSelectedItem() {
    try {
      this.bot.activateItem();
      await new Promise(r => setTimeout(r, 500));
      return true;
    } catch (e) {
      console.warn(`[HubHotbarManager] Failed to use item: ${e.message}`);
      return false;
    }
  }

  async selectAndUse(slot) {
    if (await this.selectSlot(slot)) {
      return await this.useSelectedItem();
    }
    return false;
  }

  async equipSelector() {
    const selector = this.findSelectorItem();
    if (!selector) return false;
    return await this.selectSlot(selector.slot);
  }

  _cacheSelector(selector) {
    this._selectorCache = selector;
    this._cacheTime = Date.now();
  }

  getCachedSelector() {
    if (this._cacheTime > 0 && Date.now() - this._cacheTime < 60000) {
      return this._selectorCache;
    }
    return null;
  }

  invalidateCache() {
    this._selectorCache = null;
    this._cacheTime = 0;
  }
}

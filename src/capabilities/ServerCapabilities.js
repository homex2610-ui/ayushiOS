export class ServerCapabilities {
  constructor(bot) {
    this.bot = bot;
    this._capabilities = {
      canBreakBlocks: null,
      canPlaceBlocks: null,
      canAttack: null,
      canChat: true,
      canUseCompass: null,
      canUseCommands: null,
      canOpenInventory: null,
      canDropItems: null,
      canFly: null,
      canSprint: true,
      useNPCs: null,
      useGUI: null,
      useSelectorItem: null,
      useScoreboard: null,
      useBossBar: null,
    };
    this._detected = false;
  }

  async detect() {
    if (this._detected) return this._capabilities;

    console.log('[ServerCapabilities] Detecting server capabilities...');

    this._capabilities.canFly = this.bot.abilities?.mayfly || false;

    const gameMode = this.bot.game?.gameMode;
    if (gameMode === 'creative' || gameMode === 'spectator') {
      this._capabilities.canBreakBlocks = true;
      this._capabilities.canPlaceBlocks = true;
      this._capabilities.canAttack = false;
    }

    this._capabilities.hasScoreboard = !!this.bot.scoreboard?.title;
    this._capabilities.hasBossBar = !!this.bot.bossBars && Object.keys(this.bot.bossBars).length > 0;

    const items = this.bot.inventory?.items() || [];
    this._capabilities.hasCompass = items.some(i => i.name === 'compass' || i.name === 'minecraft:compass');
    this._capabilities.hasSelectorItem = items.some(i => {
      const lore = (i.lore || []).map(l => String(l).toLowerCase());
      const name = (i.displayName || i.name || '').toLowerCase();
      return lore.some(l => l.includes('server') || l.includes('selector') || l.includes('navigate') || l.includes('menu')) ||
             name.includes('compass') || name.includes('nether_star') || name.includes('slime_ball');
    });

    this._capabilities.nearbyNPCs = Object.values(this.bot.entities || {}).some(e => {
      const name = (e.displayName || e.name || '').toLowerCase();
      const customName = e.metadata?.[2]?.toString?.().replace(/§./g, '').toLowerCase().trim();
      return (customName && customName.length > 0) || name.includes('npc');
    });

    this._detected = true;
    console.log(`[ServerCapabilities] Detected: break=${this._capabilities.canBreakBlocks}, compass=${this._capabilities.hasCompass}, npcs=${this._capabilities.nearbyNPCs}, gui=${this._capabilities.hasGUI}`);
    return this._capabilities;
  }

  get(key) {
    return this._capabilities[key] ?? null;
  }

  getAll() {
    return { ...this._capabilities };
  }

  set(key, value) {
    this._capabilities[key] = value;
  }

  reset() {
    for (const key of Object.keys(this._capabilities)) {
      this._capabilities[key] = null;
    }
    this._capabilities.canChat = true;
    this._capabilities.canSprint = true;
    this._detected = false;
  }
}

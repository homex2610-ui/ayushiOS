// ServerSemanticLayer.js
// Canonical, read-only server semantic model.
// Reads from KnowledgeBase (populated by 16 sub-analyzers) and produces
// structured, classified semantics with confidence scoring.
// ServerKnowledgeBridge pulls these models into the brain each sync cycle.

const SERVER_TYPES = [
  { type: 'lifesteal', weight: 0, patterns: [] },
  { type: 'skyblock', weight: 0, patterns: [] },
  { type: 'survival', weight: 0, patterns: [] },
  { type: 'smp', weight: 0, patterns: [] },
  { type: 'minigame', weight: 0, patterns: [] },
  { type: 'creative', weight: 0, patterns: [] },
  { type: 'hub', weight: 0, patterns: [] },
  { type: 'roleplay', weight: 0, patterns: [] },
  { type: 'prison', weight: 0, patterns: [] },
  { type: 'anarchy', weight: 0, patterns: [] },
];

const TYPE_SIGNATURES = [
  {
    type: 'lifesteal',
    confidence: 0.8,
    rules: [
      (kb) => {
        const cmds = Object.keys(kb.get('commands') || {});
        const hasLifesteal = cmds.some(c => /lifesteal|ls|revive|heart/i.test(c));
        const hasCombat = cmds.some(c => /combat|pvp|arena|duel/i.test(c));
        return hasLifesteal || hasCombat ? 1 : 0;
      },
      (kb) => {
        const plugins = Object.keys(kb.get('plugins') || {});
        return plugins.some(p => /lifesteal|heart/i.test(p)) ? 1 : 0;
      },
      (kb) => {
        const chat = (kb.get('recentMessages') || []).join(' ');
        return /lifesteal|heart|revive|eliminate/i.test(chat) ? 1 : 0;
      },
    ],
  },
  {
    type: 'skyblock',
    confidence: 0.8,
    rules: [
      (kb) => {
        const cmds = Object.keys(kb.get('commands') || {});
        return cmds.some(c => /island|skyblock|coop|visit/i.test(c)) ? 1 : 0;
      },
      (kb) => {
        const plugins = Object.keys(kb.get('plugins') || {});
        return plugins.some(p => /skyblock|island|bskyblock|acidisland/i.test(p)) ? 1 : 0;
      },
      (kb) => {
        const scoreboard = kb.get('scoreboard') || {};
        const text = [scoreboard.title, ...(scoreboard.lines || [])].join(' ');
        return /island|skyblock|coop/i.test(text) ? 1 : 0;
      },
    ],
  },
  {
    type: 'survival',
    confidence: 0.6,
    rules: [
      (kb) => {
        const plugins = Object.keys(kb.get('plugins') || {});
        const hasEconomyPlugin = plugins.some(p => /vault|economy|essentials|cmi/i.test(p));
        return hasEconomyPlugin ? 1 : 0;
      },
      (kb) => {
        const cmds = Object.keys(kb.get('commands') || {});
        const hasSurvivalCmds = cmds.some(c => /sethome|home|tpa|warp|spawn|shop|bal|pay/i.test(c));
        return hasSurvivalCmds ? 1 : 0;
      },
      (kb) => {
        const server = kb.get('server') || {};
        return server.motd && /survival|smp|vanilla/i.test(server.motd) ? 1 : 0;
      },
    ],
  },
  {
    type: 'smp',
    confidence: 0.5,
    rules: [
      (kb) => {
        const server = kb.get('server') || {};
        return server.motd && /smp|hermit|whitelist/i.test(server.motd) ? 1 : 0;
      },
      (kb) => {
        const pvp = !!kb.get('server.pvp');
        const cmds = Object.keys(kb.get('commands') || {});
        const hasBasicCmds = cmds.some(c => /msg|home|tpa|spawn/i.test(c));
        return pvp && hasBasicCmds ? 1 : 0;
      },
    ],
  },
  {
    type: 'minigame',
    confidence: 0.7,
    rules: [
      (kb) => {
        const cmds = Object.keys(kb.get('commands') || {});
        return cmds.some(c => /join|leave|game|arena|kit|class/i.test(c)) ? 1 : 0;
      },
      (kb) => {
        const menus = kb.get('guiMenus') || [];
        return menus.some(m => {
          const t = (m.title || '').toLowerCase();
          return /game|arena|kit|selector|class/i.test(t);
        }) ? 1 : 0;
      },
      (kb) => {
        const scoreboard = kb.get('scoreboard') || {};
        const text = [scoreboard.title, ...(scoreboard.lines || [])].join(' ');
        return /game|round|kill|score|point|time|arena/i.test(text) ? 1 : 0;
      },
    ],
  },
  {
    type: 'creative',
    confidence: 0.7,
    rules: [
      (kb) => {
        const cmds = Object.keys(kb.get('commands') || {});
        return cmds.some(c => /worldedit|we|brush|paint|clipboard/i.test(c)) ? 1 : 0;
      },
      (kb) => {
        const plugins = Object.keys(kb.get('plugins') || {});
        return plugins.some(p => /worldedit|worldguard|plot/i.test(p)) ? 1 : 0;
      },
      (kb) => {
        const server = kb.get('server') || {};
        return server.motd && /creative|build|plot/i.test(server.motd) ? 1 : 0;
      },
    ],
  },
  {
    type: 'hub',
    confidence: 0.6,
    rules: [
      (kb) => {
        const cmds = Object.keys(kb.get('commands') || {});
        return cmds.some(c => /hub|lobby|server|join|connect/i.test(c)) ? 1 : 0;
      },
      (kb) => {
        const menus = kb.get('guiMenus') || [];
        return menus.some(m => {
          const t = (m.title || '').toLowerCase();
          return /hub|lobby|server selector|games/i.test(t);
        }) ? 1 : 0;
      },
    ],
  },
  {
    type: 'roleplay',
    confidence: 0.6,
    rules: [
      (kb) => {
        const server = kb.get('server') || {};
        return server.motd && /roleplay|rp|rpg|lore|medieval|fantasy/i.test(server.motd) ? 1 : 0;
      },
      (kb) => {
        const cmds = Object.keys(kb.get('commands') || {});
        return cmds.some(c => /me|emote|roll|char|profile/i.test(c)) ? 1 : 0;
      },
    ],
  },
  {
    type: 'prison',
    confidence: 0.7,
    rules: [
      (kb) => {
        const cmds = Object.keys(kb.get('commands') || {});
        return cmds.some(c => /mine|prison|rankup|prestige|gang/i.test(c)) ? 1 : 0;
      },
      (kb) => {
        const plugins = Object.keys(kb.get('plugins') || {});
        return plugins.some(p => /prison|mines|rankup/i.test(p)) ? 1 : 0;
      },
    ],
  },
  {
    type: 'anarchy',
    confidence: 0.6,
    rules: [
      (kb) => {
        const server = kb.get('server') || {};
        return server.motd && /anarchy|noprotect|no rules|2b2t|free/i.test(server.motd) ? 1 : 0;
      },
      (kb) => {
        const pvp = !!kb.get('server.pvp');
        const rules = kb.get('rules') || [];
        const noRules = rules.length === 0;
        const claimPlugin = Object.keys(kb.get('plugins') || {}).some(p => /griefprevention|lands|towny|factions|residence/i.test(p));
        return pvp && noRules && !claimPlugin ? 1 : 0;
      },
    ],
  },
];

const NPC_ROLES = [
  {
    role: 'quest_giver',
    priority: 1,
    patterns: [/quest|mission|task|objective/i, /accept|complete|start/i],
    traits: ['quest_giver'],
    guiFunctions: ['quest'],
  },
  {
    role: 'shop',
    priority: 2,
    patterns: [/shop|merchant|trade|trader|vendor|store|market/i, /buy|sell|price|cost/i],
    traits: ['shop'],
    guiFunctions: ['trade', 'shop'],
  },
  {
    role: 'banker',
    priority: 3,
    patterns: [/bank|banker|eco|finance|vault|atm|balance/i, /deposit|withdraw|balance/i],
    traits: ['banker'],
    guiFunctions: ['economy'],
  },
  {
    role: 'warp',
    priority: 4,
    patterns: [/warp|portal|travel|gate|transit|teleport/i, /navigate|destination/i],
    traits: ['travel'],
    guiFunctions: ['warp', 'travel'],
  },
  {
    role: 'auction',
    priority: 5,
    patterns: [/auction|ah|bid|market|listing/i, /sell|buy|list|bid/i],
    traits: ['auction'],
    guiFunctions: ['auction'],
  },
  {
    role: 'guide',
    priority: 6,
    patterns: [/guide|helper|tutor|mentor|welcome/i],
    traits: ['guide', 'quest_giver'],
    guiFunctions: [],
  },
  {
    role: 'cosmetic',
    priority: 7,
    patterns: [/cosmetic|pet|mount|particle|trail|cloak|hat|gadget/i],
    traits: ['cosmetic'],
    guiFunctions: [],
  },
  {
    role: 'tutorial',
    priority: 8,
    patterns: [/tutorial|learn|introduction|newbie|starter/i],
    traits: ['guide'],
    guiFunctions: [],
  },
  {
    role: 'decoration',
    priority: 9,
    patterns: [/decoration|decor|statue|display|mannequin/i],
    traits: [],
    guiFunctions: [],
  },
  {
    role: 'equipment',
    priority: 6,
    patterns: [/blacksmith|armor(?:er|y)|weaponsmith|toolsmith|enchant/i, /repair|upgrade|sell|buy/i],
    traits: ['blacksmith', 'equipment'],
    guiFunctions: ['craft', 'trade'],
  },
  {
    role: 'food',
    priority: 8,
    patterns: [/butcher|farmer|fisherman|cook|chef|baker|brew/i, /food|bread|meat|potion/i],
    traits: ['food'],
    guiFunctions: ['trade'],
  },
];

const GUI_CATEGORIES = [
  { type: 'shop', patterns: [/shop|store|buy|sell|price|cost|purchase|market/i] },
  { type: 'storage', patterns: [/chest|storage|backpack|vault|inventory/i] },
  { type: 'crate', patterns: [/crate|key|reward|loot|prize|spin/i] },
  { type: 'quest', patterns: [/quest|mission|task|objective|challenge/i] },
  { type: 'auction', patterns: [/auction|ah|bid|listing|marketplace/i] },
  { type: 'trade', patterns: [/trade|merchant|exchange|barter|offer/i] },
  { type: 'craft', patterns: [/craft|recipe|smith|workbench|anvil|grindstone/i] },
  { type: 'enchant', patterns: [/enchant|magic|potion|brew|alchemy|arcane/i] },
  { type: 'furnace', patterns: [/furnace|smelt|cook|kiln|oven/i] },
  { type: 'economy', patterns: [/eco|bank|balance|atm|finance|money/i] },
  { type: 'warp', patterns: [/warp|teleport|travel|gate|navigate|map/i] },
  { type: 'kit', patterns: [/kit|loadout|class|donation|rank|upgrade/i] },
  { type: 'job', patterns: [/job|profession|career|work|employment/i] },
  { type: 'skill', patterns: [/skill|ability|perk|talent|progression/i] },
  { type: 'vote', patterns: [/vote|reward|claim|daily|weekly/i] },
  { type: 'menu', patterns: [/menu|settings|options|configuration|preferences/i] },
  { type: 'pvp', patterns: [/pvp|arena|combat|duel|battle|war/i] },
  { type: 'server_selector', patterns: [/server|lobby|hub|select|switch|connect/i] },
];

const CLAIM_SYSTEMS = [
  { id: 'griefprevention', patterns: [/griefprevention|gp|claim|trust|accesstrust|containertrust|claim/i] },
  { id: 'lands', patterns: [/lands|land claim|chunk/i] },
  { id: 'towny', patterns: [/towny|town|nation|resident|plot/i] },
  { id: 'factions', patterns: [/factions|faction|f power|f home|f claim/i] },
  { id: 'residence', patterns: [/residence|res create|res select|res area/i] },
  { id: 'worldguard', patterns: [/worldguard|region|rg|protected|member|owner/i] },
];

const PLUGIN_CAPABILITIES = {
  EssentialsX: ['homes', 'warps', 'spawn', 'tpa', 'kit', 'mail', 'economy'],
  CMI: ['homes', 'warps', 'spawn', 'tpa', 'kit', 'mail', 'economy'],
  Vault: ['economy'],
  GriefPrevention: ['claims'],
  Lands: ['claims'],
  Towny: ['claims'],
  Factions: ['claims'],
  Residence: ['claims'],
  WorldGuard: ['protection'],
  WorldEdit: ['building'],
  ShopGUIPlus: ['shops', 'economy'],
  EcoShop: ['shops', 'economy'],
  Citizens: ['npcs'],
  Quests: ['quests'],
  mcMMO: ['skills'],
  AureliumSkills: ['skills'],
  Jobs: ['jobs', 'economy'],
  AuctionHouse: ['auction', 'economy'],
  ExcellentCrates: ['crates'],
  CrazyCrates: ['crates'],
  VotingPlugin: ['vote'],
  DiscordSRV: ['discord'],
  CoreProtect: ['logging'],
  Marriage: ['social'],
  ViaVersion: ['compatibility'],
  Geyser: ['crossplay'],
};

const HOME_CAPABILITY_SIGNALS = [
  { cmd: '/home', weight: 1.0 },
  { cmd: '/sethome', weight: 1.0 },
  { cmd: '/delhome', weight: 1.0 },
  { cmd: '/homes', weight: 0.9 },
];

const WARP_CAPABILITY_SIGNALS = [
  { cmd: '/warp', weight: 1.0 },
  { cmd: '/warps', weight: 0.9 },
  { cmd: '/warp list', weight: 0.9 },
];

const SPAWN_CAPABILITY_SIGNALS = [
  { cmd: '/spawn', weight: 1.0 },
  { cmd: '/hub', weight: 0.8 },
  { cmd: '/lobby', weight: 0.8 },
];

const TPA_CAPABILITY_SIGNALS = [
  { cmd: '/tpa', weight: 1.0 },
  { cmd: '/tpahere', weight: 0.9 },
  { cmd: '/tpaccept', weight: 1.0 },
  { cmd: '/tpdeny', weight: 0.8 },
];

const RTP_CAPABILITY_SIGNALS = [
  { cmd: '/rtp', weight: 1.0 },
  { cmd: '/wild', weight: 0.9 },
  { cmd: '/randomteleport', weight: 0.9 },
];

const BACK_CAPABILITY_SIGNALS = [
  { cmd: '/back', weight: 1.0 },
  { cmd: '/return', weight: 0.7 },
];

export class ServerSemanticLayer {
  constructor(knowledgeBase, logger) {
    this.kb = knowledgeBase;
    this.log = logger || ((...a) => {});
    this._lastAnalysis = null;
    this._lastAnalysisAt = 0;
  }

  analyze(force = false) {
    const now = Date.now();
    if (!force && this._lastAnalysis && now - this._lastAnalysisAt < 10000) {
      return this._lastAnalysis;
    }

    const identity = this.classifyServerType();
    const mechanics = this.inferMechanics();
    const plugins = this._compilePlugins();
    const commands = this._compileCommands();
    const npcs = this._classifyAllNPCs();
    const guis = this._classifyAllGUIs();

    this._lastAnalysis = {
      identity,
      mechanics,
      plugins,
      commands,
      npcs,
      guis,
      compiledAt: now,
    };
    this._lastAnalysisAt = now;
    return this._lastAnalysis;
  }

  classifyServerType() {
    const scores = {};

    for (const sig of TYPE_SIGNATURES) {
      let matched = 0;
      let total = sig.rules.length;
      for (const rule of sig.rules) {
        matched += rule(this.kb);
      }
      if (total > 0) {
        const raw = matched / total;
        scores[sig.type] = {
          score: raw,
          confidence: sig.confidence * raw,
          evidence: `matched ${matched}/${total} rules`,
        };
      }
    }

    const sorted = Object.entries(scores)
      .filter(([, s]) => s.score > 0)
      .sort((a, b) => b[1].confidence - a[1].confidence);

    if (sorted.length === 0) {
      return { type: 'unknown', confidence: 0, evidence: 'no matching signatures', alternatives: [] };
    }

    const top = sorted[0];
    return {
      type: top[0],
      confidence: top[1].confidence,
      evidence: top[1].evidence,
      alternatives: sorted.slice(1, 3).map(([t, s]) => ({
        type: t,
        confidence: s.confidence,
        evidence: s.evidence,
      })),
    };
  }

  inferMechanics() {
    const cmds = Object.keys(this.kb.get('commands') || {});
    const plugins = Object.keys(this.kb.get('plugins') || {});
    const server = this.kb.get('server') || {};
    const rules = this.kb.get('rules') || [];
    const economy = this.kb.get('economy') || {};

    const capabilities = new Set();
    for (const [plugin, caps] of Object.entries(PLUGIN_CAPABILITIES)) {
      if (plugins.includes(plugin)) {
        for (const cap of caps) capabilities.add(cap);
      }
    }

    const _signalConfidence = (signals) => {
      const matches = signals.filter(s => cmds.includes(s.cmd));
      if (matches.length === 0) return { available: false, confidence: 0, signals: 0 };
      const totalWeight = matches.reduce((sum, m) => sum + m.weight, 0);
      return { available: totalWeight >= 0.8, confidence: Math.min(1, totalWeight / signals.length), signals: matches.length };
    };

    return {
      economy: {
        enabled: !!(economy.enabled || capabilities.has('economy')),
        currency: economy.currency || null,
        symbols: economy.symbols || [],
        plugin: plugins.find(p => (PLUGIN_CAPABILITIES[p] || []).includes('economy')) || null,
        confidence: economy.enabled ? 0.7 : (capabilities.has('economy') ? 0.5 : 0.2),
      },
      homes: {
        ..._signalConfidence(HOME_CAPABILITY_SIGNALS),
        max: null,
        plugin: plugins.find(p => (PLUGIN_CAPABILITIES[p] || []).includes('homes')) || null,
      },
      warps: {
        ..._signalConfidence(WARP_CAPABILITY_SIGNALS),
        plugin: plugins.find(p => (PLUGIN_CAPABILITIES[p] || []).includes('warps')) || null,
      },
      spawn: {
        ..._signalConfidence(SPAWN_CAPABILITY_SIGNALS),
        plugin: plugins.find(p => (PLUGIN_CAPABILITIES[p] || []).includes('spawn')) || null,
      },
      tpa: {
        ..._signalConfidence(TPA_CAPABILITY_SIGNALS),
      },
      rtp: {
        ..._signalConfidence(RTP_CAPABILITY_SIGNALS),
      },
      back: {
        ..._signalConfidence(BACK_CAPABILITY_SIGNALS),
      },
      combat: {
        pvp: !!server.pvp,
        safeZones: rules.some(r => /safe|no pvp|protected|spawn.*protection/i.test(r)),
        safeZoneConfidence: 0.5,
      },
      claims: this._detectClaimSystem(plugins, cmds, rules),
      capabilities: [...capabilities],
    };
  }

  classifyNPC(npc) {
    if (!npc || !npc.name) return { role: 'unknown', confidence: 0, functions: [] };

    const name = npc.name || '';
    const traits = npc.traits || [];
    const functions = npc.functions || [];
    const npcGui = npc.lastInteraction?.gui || '';
    const combined = `${name} ${traits.join(' ')} ${functions.join(' ')} ${npcGui}`;

    const scored = NPC_ROLES.map(role => {
      let score = 0;
      for (const pattern of role.patterns) {
        if (pattern.test(combined)) score += 0.4;
      }
      if (role.traits.some(t => traits.includes(t))) score += 0.3;
      if (role.guiFunctions.some(g => functions.includes(g))) score += 0.2;
      if (role.guiFunctions.some(g => npcGui.toLowerCase().includes(g))) score += 0.1;

      const confidence = Math.min(1, score);
      return { role: role.role, confidence, priority: role.priority };
    }).filter(r => r.confidence > 0);

    if (scored.length === 0) {
      return { role: 'unknown', confidence: 0.2, functions: traits };
    }

    scored.sort((a, b) => b.confidence - a.confidence || a.priority - b.priority);
    const top = scored[0];
    return {
      role: top.role,
      confidence: top.confidence,
      functions: [...new Set([...traits, ...functions])],
      alternatives: scored.slice(1, 3).map(r => ({ role: r.role, confidence: r.confidence })),
    };
  }

  classifyGUI(gui) {
    if (!gui) return { type: 'unknown', purpose: [], confidence: 0 };

    const title = (gui.title || '').toLowerCase();
    const category = (gui.category || '').toLowerCase();
    const combined = `${title} ${category}`;

    const scored = GUI_CATEGORIES.map(cat => {
      const match = cat.patterns.some(p => p.test(combined));
      return match ? { type: cat.type, score: 1 } : null;
    }).filter(Boolean);

    if (scored.length === 0) {
      return { type: 'unknown', purpose: [], confidence: 0.1 };
    }

    const purposes = scored.map(s => s.type);
    const topType = scored[0].type;
    const confidence = Math.min(1, 0.3 + scored.length * 0.15);
    const size = gui.size || 0;
    const hasNavigation = size > 18 || (gui.itemCount || 0) > 10;

    return {
      type: topType,
      confidence,
      purpose: purposes,
      hasNavigation,
      totalSlots: size,
      itemCount: gui.itemCount || 0,
      seenCount: gui.seenCount || 1,
    };
  }

  compileProfile() {
    const analysis = this.analyze(true);
    const server = this.kb.get('server') || {};
    const profile = this.kb.get('serverProfile') || {};
    const knownCmds = this.kb.get('commands') || {};
    const economy = this.kb.get('economy') || {};
    const dangers = this.kb.get('dangers') || [];
    const npcs = this.kb.get('npcs') || [];
    const guiMenus = this.kb.get('guiMenus') || [];

    return {
      identity: analysis.identity,
      server: {
        name: server.name || null,
        motd: server.motd || null,
        version: server.version || profile.version || null,
        firstSeen: server.firstSeen || profile.firstSeen || null,
      },
      mechanics: analysis.mechanics,
      plugins: analysis.plugins,
      commands: analysis.commands,
      npcs: analysis.npcs,
      guis: analysis.guis,
      dangers: {
        total: dangers.length,
        categories: this._countBy(dangers, 'type'),
      },
      summary: this._generateSummary(analysis, server),
    };
  }

  getServerType() {
    return this.classifyServerType().type;
  }

  hasCapability(name) {
    const cached = this._lastAnalysis;
    if (cached?.mechanics?.capabilities) {
      return cached.mechanics.capabilities.includes(name);
    }
    return false;
  }

  getMechanics() {
    const cached = this._lastAnalysis;
    if (cached?.mechanics) return cached.mechanics;
    return this.inferMechanics();
  }

  getNPCRole(npcName) {
    const npcs = this.kb.get('npcs') || [];
    const npc = npcs.find(n => n.name === npcName);
    return this.classifyNPC(npc || { name: npcName });
  }

  getGUIType(guiTitle) {
    const guis = this.kb.get('guiMenus') || [];
    const gui = guis.find(g => g.title === guiTitle);
    return this.classifyGUI(gui || { title: guiTitle });
  }

  getSummary() {
    const cached = this._lastAnalysis;
    if (cached?.profile?.summary) return cached.profile.summary;
    return this.compileProfile().summary;
  }

  // ── Private ────────────────────────────────────────────────

  _detectClaimSystem(plugins, cmds, rules) {
    for (const cs of CLAIM_SYSTEMS) {
      if (plugins.some(p => cs.patterns.some(pat => pat.test(p)))) {
        return { system: cs.id, confidence: 0.8, source: 'plugin' };
      }
    }
    for (const cs of CLAIM_SYSTEMS) {
      if (cmds.some(c => cs.patterns.some(pat => pat.test(c)))) {
        return { system: cs.id, confidence: 0.6, source: 'command' };
      }
    }
    for (const cs of CLAIM_SYSTEMS) {
      if (rules.some(r => cs.patterns.some(pat => pat.test(r)))) {
        return { system: cs.id, confidence: 0.4, source: 'rule' };
      }
    }
    return { system: 'none', confidence: 0.5, source: 'default' };
  }

  _compilePlugins() {
    const plugins = this.kb.get('plugins') || {};
    return Object.entries(plugins)
      .filter(([, meta]) => (meta?.confidence || 0) >= 0.2)
      .map(([name, meta]) => ({
        name,
        confidence: meta?.confidence || 0.3,
        capabilities: PLUGIN_CAPABILITIES[name] || [],
        firstSeen: meta?.firstSeen,
        lastSeen: meta?.lastSeen,
      }))
      .sort((a, b) => b.confidence - a.confidence);
  }

  _compileCommands() {
    const commands = this.kb.get('commands') || {};
    const byCategory = {};
    let total = 0;
    for (const [cmd, meta] of Object.entries(commands)) {
      total++;
      const type = meta?.type || 'custom';
      if (!byCategory[type]) byCategory[type] = [];
      byCategory[type].push(cmd);
    }
    return { total, byCategory, items: commands };
  }

  _classifyAllNPCs() {
    const npcs = this.kb.get('npcs') || [];
    return npcs.map(npc => {
      const classification = this.classifyNPC(npc);
      return {
        name: npc.name,
        position: npc.position,
        role: classification.role,
        confidence: classification.confidence,
        functions: classification.functions,
        lastSeen: npc.lastSeen,
        alternatives: classification.alternatives,
      };
    });
  }

  _classifyAllGUIs() {
    const guis = this.kb.get('guiMenus') || [];
    return guis.map(gui => {
      const classification = this.classifyGUI(gui);
      return {
        title: gui.title,
        type: classification.type,
        confidence: classification.confidence,
        purpose: classification.purpose,
        hasNavigation: classification.hasNavigation,
        size: gui.size,
        lastSeen: gui.lastSeen,
        seenCount: gui.seenCount,
      };
    });
  }

  _generateSummary(analysis, server) {
    const identity = analysis.identity;
    const mechanics = analysis.mechanics;
    const parts = [];

    if (identity.type !== 'unknown') {
      parts.push(`Server: ${server.name || 'Unknown'} (${identity.type}, ${Math.round(identity.confidence * 100)}% confidence)`);
    } else {
      parts.push(`Server: ${server.name || 'Unknown'} (type unknown)`);
    }
    parts.push(`Plugins: ${analysis.plugins.map(p => `${p.name}(${Math.round(p.confidence * 100)}%)`).join(', ') || 'none detected'}`);
    parts.push(`Economy: ${mechanics.economy.enabled ? mechanics.economy.currency || 'active' : 'none'}`);
    parts.push(`Homes: ${mechanics.homes.available ? '✓' : '✗'} | Warps: ${mechanics.warps.available ? '✓' : '✗'} | Spawn: ${mechanics.spawn.available ? '✓' : '✗'}`);
    parts.push(`TPA: ${mechanics.tpa.available ? '✓' : '✗'} | RTP: ${mechanics.rtp.available ? '✓' : '✗'} | Back: ${mechanics.back.available ? '✓' : '✗'}`);
    parts.push(`Claims: ${mechanics.claims.system} (${Math.round(mechanics.claims.confidence * 100)}%)`);
    parts.push(`PvP: ${mechanics.combat.pvp ? 'enabled' : 'disabled'}${mechanics.combat.safeZones ? ' (safe zones detected)' : ''}`);
    parts.push(`Commands: ${analysis.commands.total} discovered`);
    parts.push(`NPCs: ${analysis.npcs.length} observed`);
    parts.push(`GUIs: ${analysis.guis.length} layouts known`);

    return { text: parts.join('\n'), parts };
  }

  _countBy(arr, key) {
    const counts = {};
    for (const item of arr || []) {
      const val = item[key] || 'unknown';
      counts[val] = (counts[val] || 0) + 1;
    }
    return counts;
  }
}

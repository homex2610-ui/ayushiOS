// ServerKnowledgeBridge.js
// ─────────────────────────────────────────────────────────────
// READ-ONLY knowledge pipeline:
//   ServerAnalyzer (observations) → normalize →
//     BeliefState (current facts) + MemoryMatrix (persistent facts)
//
// Rules:
//   • Never issues bot commands or starts tasks
 //   • Never plans — only writes facts
//   • ExecutiveBrain consumes via Knowledge facade
// ─────────────────────────────────────────────────────────────

const SEVERITY_MAP = {
  critical: 3,
  high: 3,
  medium: 2,
  low: 1,
};

const LOCATION_TYPE_TAGS = {
  storage: ['storage', 'safe'],
  utility: ['utility', 'workstation'],
  rest: ['bed', 'safe', 'shelter'],
  portal: ['portal'],
  spawner: ['spawner', 'hazard'],
  navigation: ['navigation'],
  structure: ['structure'],
};

export class ServerKnowledgeBridge {
  /**
   * @param {{ kb: { get: Function, data: object }, semantics?: import('../serverAnalyzer/ServerSemanticLayer.js').ServerSemanticLayer }} serverAnalyzer
   * @param {import('./MemoryMatrix.js').MemoryMatrix} memory
   * @param {{ intervalMs?: number, beliefs?: import('./BeliefState.js').BeliefState }} [opts]
   */
  constructor(serverAnalyzer, memory, opts = {}) {
    this.serverAnalyzer = serverAnalyzer;
    this.memory = memory;
    this.beliefs = opts.beliefs || null;
    this.intervalMs = opts.intervalMs ?? 15000;
    this._timer = null;
    this._lastSyncAt = 0;
    this._syncing = false;
    this._lastSemanticProfile = null;
  }

  setBeliefs(beliefs) {
    this.beliefs = beliefs;
  }

  start() {
    if (this._timer) return;
    this.sync(true);
    this._timer = setInterval(() => this.sync(false), this.intervalMs);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Pull latest ServerAnalyzer KB into BeliefState + MemoryMatrix.
   * @param {boolean} [force]
   */
  sync(force = false) {
    if (!this.serverAnalyzer?.kb || !this.memory) return;
    if (this._syncing) return;
    const now = Date.now();
    if (!force && now - this._lastSyncAt < Math.min(5000, this.intervalMs)) return;

    this._syncing = true;
    try {
      const kb = this.serverAnalyzer.kb;
      this._syncServerProfile(kb);
      this._syncCommands(kb);
      this._syncLocations(kb);
      this._syncHomes(kb);
      this._syncGuiMenus(kb);
      this._syncSemantics(kb);
      this._updateBeliefState(kb);
      this._lastSyncAt = Date.now();
      this.memory.bus?.emit('server_knowledge_synced', {
        at: this._lastSyncAt,
        commandCount: Object.keys(kb.get('commands') || {}).length,
        npcCount: (kb.get('npcs') || []).length,
        dangerCount: (kb.get('dangers') || []).length,
      });
    } catch (err) {
      console.warn('[ServerKnowledgeBridge] Sync failed:', err.message);
    } finally {
      this._syncing = false;
    }
  }

  _updateBeliefState(kb) {
    if (!this.beliefs) return;
    const server = kb.get('server') || {};
    const economy = kb.get('economy') || {};
    const scoreboard = kb.get('scoreboard') || {};
    const npcs = kb.get('npcs') || [];
    const dangers = kb.get('dangers') || [];
    const guiMenus = kb.get('guiMenus') || [];
    const latestGui = guiMenus.length ? guiMenus[guiMenus.length - 1] : null;

    const semanticAnalysis = this.serverAnalyzer?.semantics?.analyze(false);
    const patch = {
      dimension: server.lastDimension || this.beliefs.dimension,
      currentServer: {
        name: server.name || null,
        motd: server.motd || null,
        version: server.version || null,
        pvp: !!server.pvp,
        claimSystem: server.claimSystem || null,
        spawn: server.spawn || null,
      },
      scoreboard: {
        title: scoreboard.title || scoreboard.displayName || null,
        lines: scoreboard.lines || scoreboard.scores || [],
      },
      openGui: latestGui
        ? { title: latestGui.title || null, category: latestGui.category || null, itemCount: latestGui.itemCount || 0 }
        : null,
      nearbyNPCs: npcs.slice(0, 20).map(npc => ({
        name: npc.name,
        profession: npc.type || npc.profession || (npc.functions && npc.functions[0]) || 'npc',
        position: npc.position || null,
        confidence: npc.confidence || 0.6,
        functions: npc.functions || [],
        role: npc.role || null,
        roleConfidence: npc.roleConfidence || 0,
      })),
      nearbyHazards: dangers.slice(0, 20).map(danger => {
        const severity = typeof danger.severity === 'number'
          ? danger.severity
          : (SEVERITY_MAP[danger.severity] || 2);
        let position = danger.position || null;
        if (!position && danger.area?.start) {
          const a = danger.area.start;
          const b = danger.area.end || a;
          position = {
            x: Math.round((a.x + b.x) / 2),
            y: Math.round((a.y + b.y) / 2),
            z: Math.round((a.z + b.z) / 2),
          };
        }
        return {
          type: danger.type || 'unknown',
          reason: danger.reason || danger.type || 'server danger',
          severity,
          position,
        };
      }),
      economySnapshot: {
        enabled: !!economy.enabled,
        currency: economy.currency || null,
        symbols: economy.symbols || [],
      },
    };

    if (semanticAnalysis) {
      patch.serverSemantics = {
        type: semanticAnalysis.identity?.type || null,
        typeConfidence: semanticAnalysis.identity?.confidence || 0,
        mechanics: semanticAnalysis.mechanics || null,
        capabilities: semanticAnalysis.mechanics?.capabilities || [],
        npcClassifications: (semanticAnalysis.npcs || []).map(n => ({
          name: n.name, role: n.role, confidence: n.confidence, functions: n.functions,
        })),
        guiClassifications: (semanticAnalysis.guis || []).map(g => ({
          title: g.title, type: g.type, confidence: g.confidence, purpose: g.purpose,
        })),
        lastAnalysis: semanticAnalysis.compiledAt || Date.now(),
      };
    }

    this.beliefs.update(patch);
  }

  _syncServerProfile(kb) {
    const server = kb.get('server') || {};
    const economy = kb.get('economy') || {};
    const plugins = kb.get('plugins') || {};
    const scoreboard = kb.get('scoreboard') || {};
    const pluginList = Object.entries(plugins).map(([name, meta]) => ({
      name,
      confidence: meta?.confidence ?? 0.3,
    }));

    this.memory.rememberServerProfile({
      name: server.name || null,
      motd: server.motd || null,
      version: server.version || null,
      spawn: server.spawn || null,
      dimension: server.lastDimension || null,
      pvp: !!server.pvp,
      claimSystem: server.claimSystem || null,
      economy: {
        enabled: !!economy.enabled,
        currency: economy.currency || null,
        symbols: economy.symbols || [],
      },
      plugins: pluginList,
      scoreboardTitle: scoreboard.title || scoreboard.displayName || null,
      source: 'serverAnalyzer',
    });

    if (server.spawn) {
      this.memory.rememberWaypoint({
        name: 'server_spawn',
        type: 'spawn',
        position: server.spawn,
        tags: ['spawn', 'server'],
        note: 'Server spawn from analyzer',
        source: 'serverAnalyzer',
        importance: 2,
        confidence: 0.8,
      });
      if (!this.memory.longTerm.semantic.homePos) {
        this.memory.setHome(server.spawn);
      }
    }
  }

  _syncCommands(kb) {
    const commands = kb.get('commands') || {};
    for (const [command, meta] of Object.entries(commands)) {
      this.memory.rememberServerCommand(command, {
        ...meta,
        source: 'serverAnalyzer',
      });

      const type = (meta?.type || '').toLowerCase();
      const name = String(command).replace(/^\//, '').toLowerCase();
      if (type === 'teleport' && (name === 'spawn' || name === 'hub' || name === 'lobby' || name.startsWith('warp'))) {
        this.memory.rememberWarp(name, null, `Command ${command} available`, meta.confidence || 0.5);
      }
    }
  }

  _syncNPCs(kb) {
    const npcs = kb.get('npcs') || [];
    for (const npc of npcs) {
      if (!npc?.name) continue;
      const profession = npc.type || npc.profession || (npc.functions && npc.functions[0]) || 'npc';
      const noteParts = ['Observed NPC from server analyzer'];
      if (npc.functions?.length) noteParts.push(`functions: ${npc.functions.join(',')}`);
      this.memory.rememberNPC(
        npc.name,
        npc.position || null,
        profession,
        noteParts.join(' | '),
        npc.confidence || 0.6
      );
    }
  }

  _syncLocations(kb) {
    const locations = kb.get('locations') || [];
    for (const loc of locations) {
      const position = loc.position || loc.center;
      if (!position) continue;

      if (loc.key && (loc.biome || loc.dimension) && !loc.block) {
        const regionName = loc.key;
        this.memory.learnLocation(regionName, position, `${loc.dimension || '?'} / ${loc.biome || '?'}`);
        continue;
      }

      const type = loc.type || loc.structureType || 'landmark';
      const tags = [...(LOCATION_TYPE_TAGS[type] || [type])];
      if (loc.block) tags.push(loc.block);
      const name = loc.block
        ? `${loc.block}_${Math.round(position.x)}_${Math.round(position.z)}`
        : (loc.structureType || type);

      this.memory.rememberWaypoint({
        name,
        type: type === 'rest' ? 'shelter' : type,
        position,
        tags,
        note: loc.block ? `Block ${loc.block}` : (loc.structureType || type),
        source: 'serverAnalyzer',
        importance: Math.min(3, Math.ceil((loc.priority || 4) / 3)),
        confidence: 0.55 + Math.min(0.35, (loc.priority || 0) * 0.03),
      });

      if (type === 'spawner') {
        this.memory.recordHazard({
          position,
          type: 'spawner',
          reason: `Mob spawner (${loc.block || 'unknown'})`,
          severity: 2,
          radius: 8,
          confidence: 0.7,
        });
      }
    }
  }

  _syncHomes(kb) {
    const homes = kb.get('homes') || {};
    for (const [name, pos] of Object.entries(homes)) {
      if (!pos || pos.x == null) continue;
      this.memory.rememberWaypoint({
        name: `home_${name}`,
        type: 'home',
        position: pos,
        tags: ['home', 'safe', 'shelter'],
        note: `Home '${name}' from server analyzer`,
        source: 'serverAnalyzer',
        importance: 3,
        confidence: 0.85,
      });
      if (name === 'default' || name === 'home') {
        this.memory.setHome(pos);
      }
    }
  }

  _syncDangers(kb) {
    const dangers = kb.get('dangers') || [];
    for (const danger of dangers) {
      if (!danger) continue;
      const severity = typeof danger.severity === 'number'
        ? danger.severity
        : (SEVERITY_MAP[danger.severity] || 2);

      if (danger.position) {
        this.memory.recordHazard({
          position: danger.position,
          type: danger.type || 'unknown',
          reason: danger.reason || danger.type || 'server danger',
          severity,
          radius: danger.type === 'creeper' ? 6 : danger.type === 'lava' ? 4 : 5,
          confidence: 0.65,
        });
      } else if (danger.area?.start) {
        const a = danger.area.start;
        const b = danger.area.end || a;
        const center = {
          x: Math.round((a.x + b.x) / 2),
          y: Math.round((a.y + b.y) / 2),
          z: Math.round((a.z + b.z) / 2),
        };
        this.memory.recordHazard({
          position: center,
          type: danger.type || 'unsafe_area',
          reason: danger.reason || 'unsafe area',
          severity,
          radius: Math.max(5, Math.abs(b.x - a.x) / 2),
          confidence: 0.6,
        });
      }
    }
  }

  _syncGuiMenus(kb) {
    const guiMenus = kb.get('guiMenus') || [];
    for (const gui of guiMenus.slice(-8)) {
      const title = gui.title || 'Server GUI';
      const nearestNpc = (kb.get('npcs') || []).find(n =>
        n.lastInteraction?.gui === title || (n.functions || []).includes(gui.category)
      );
      const position = nearestNpc?.position;
      if (!position) continue;
      this.memory.rememberWaypoint({
        name: `gui_${title}`.slice(0, 48),
        type: 'gui',
        position,
        tags: ['gui', 'server', gui.category].filter(Boolean),
        note: `GUI "${title}" (${gui.itemCount || 0} items)`,
        source: 'serverAnalyzer',
        confidence: 0.55,
      });
    }
  }

  _syncSemantics(kb) {
    if (!this.serverAnalyzer?.semantics) return;
    try {
      const analysis = this.serverAnalyzer.semantics.analyze(false);
      if (!analysis) return;

      if (analysis.identity.type !== 'unknown') {
        this.memory.rememberServerProfile({
          semanticType: analysis.identity.type,
          semanticConfidence: analysis.identity.confidence,
          mechanics: {
            economy: analysis.mechanics.economy,
            homes: analysis.mechanics.homes,
            warps: analysis.mechanics.warps,
            claims: analysis.mechanics.claims,
            combat: analysis.mechanics.combat,
            capabilities: analysis.mechanics.capabilities,
          },
        });
      }

      const semanticNPCs = analysis.npcs || [];
      for (const snpc of semanticNPCs) {
        if (snpc.role !== 'unknown' && snpc.confidence >= 0.3) {
          const existingNpcs = kb.get('npcs') || [];
          const match = existingNpcs.find(n => n.name === snpc.name);
          if (match) {
            match.role = snpc.role;
            match.roleConfidence = snpc.confidence;
            match.functions = snpc.functions;
          }
        }
      }

      const semanticGUIs = analysis.guis || [];
      for (const sgui of semanticGUIs) {
        if (sgui.type !== 'unknown' && sgui.confidence >= 0.3) {
          const existingMenus = kb.get('guiMenus') || [];
          const match = existingMenus.find(m => m.title === sgui.title);
          if (match) {
            match.semanticType = sgui.type;
            match.purpose = sgui.purpose;
            match.hasNavigation = sgui.hasNavigation;
          }
        }
      }

      this._lastSemanticProfile = analysis.profile;
      this.memory.bus?.emit('semantic_analysis', {
        serverType: analysis.identity.type,
        typeConfidence: analysis.identity.confidence,
        npcRoles: semanticNPCs.filter(n => n.confidence >= 0.3).map(n => n.name + ':' + n.role),
        guiTypes: semanticGUIs.filter(g => g.confidence >= 0.3).map(g => g.title + ':' + g.type),
        capabilities: analysis.mechanics.capabilities,
      });
    } catch (err) {
      console.warn('[ServerKnowledgeBridge] _syncSemantics failed:', err.message);
    }
  }
}

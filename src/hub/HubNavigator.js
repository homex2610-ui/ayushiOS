import CONNECTION_CONFIG from '../connection/ConnectionSettings.js';
import { useHotbarSelector, findPhysicalNPC, interactWithNPC, findGUIDestination } from './LobbyHelpers.js';

const GUI_SLOT_ORDER = {
  boxpvp: 10,
  lifesteal: 12,
  limbo: 14,
  survival: 14,
  practice: 16,
  hub: 1,
};

const MODE_KEYWORDS = {
  survival: ['survival', 'smp', 'classic', 'kryonsurvival', 'minecraft'],
  lifesteal: ['lifesteal', 'heart', 'red dye'],
  practice: ['practice', 'pvp', 'duel', 'arena'],
  boxpvp: ['boxpvp', 'box', 'spyglass'],
  limbo: ['limbo', 'idle', 'afk'],
};

const MODE_COMMANDS = {
  survival: ['/server survival', '/survival', '/smp', '/join survival'],
  lifesteal: ['/server lifesteal', '/lifesteal', '/join lifesteal'],
  practice: ['/server practice', '/practice', '/duel', '/arena'],
  kitpvp: ['/server kitpvp', '/kitpvp', '/pvp', '/combat'],
  bedwars: ['/server bedwars', '/bedwars'],
  skywars: ['/server skywars', '/skywars'],
  minigame: ['/server minigame', '/minigame', '/parkour', '/event'],
};

export class HubNavigator {
  constructor(bot, agent, hotbarManager, guiClient) {
    this.bot = bot;
    this.agent = agent;
    this.hotbarManager = hotbarManager;
    this.guiClient = guiClient;
    this._lastCommandTime = 0;
    this._commandCooldown = 3000;
    this._posBefore = null;
    this._lastSelectorItem = null;
    this._lastSelectorSlot = null;
    this._lastClickedSlot = null;
    this._lastGuiTitle = null;
    this._lastGameMode = null;
    this._lastDimension = null;
  }

  getModeCommands(targetMode) {
    const target = (targetMode || 'survival').toLowerCase();
    return [
      ...CONNECTION_CONFIG.serverJoinCommands.map(cmd => cmd.replace('{target}', target)),
      ...(MODE_COMMANDS[target] || []),
      '/hub', '/lobby', '/server', '/join',
    ];
  }

  async executeCommand(targetMode) {
    this.bot._navigationInProgress = true;
    const commands = this.getModeCommands(targetMode);
    const now = Date.now();
    if (now - this._lastCommandTime < this._commandCooldown) {
      await new Promise(r => setTimeout(r, this._commandCooldown - (now - this._lastCommandTime)));
    }

    const seen = new Set();
    for (const cmd of commands) {
      if (seen.has(cmd)) continue;
      seen.add(cmd);

      try {
        this._snapshotPosition();
        console.log(`[HubNavigator] executeCommand: ${cmd}`);
        this.bot.chat(cmd);
        this._lastCommandTime = Date.now();
        // Wait and poll for transfer every 2s up to 15s
        for (let w = 0; w < 8; w++) {
          await new Promise(r => setTimeout(r, 2000));
          if (await this.verifyTransfer()) return true;
        }
      } catch (e) {
        console.warn(`[HubNavigator] Command ${cmd} error: ${e.message}`);
      }
    }

    if (targetMode !== 'practice' && targetMode !== 'lifesteal') {
      const host = this.bot.host || '';
      const known = SERVERS_WITH_KNOWN_COMMANDS[host];
      if (known) {
        for (const mode of known.available) {
          const cmd = known.command.replace('{mode}', mode);
          if (seen.has(cmd)) continue;
          seen.add(cmd);
          try {
            this._snapshotPosition();
            console.log(`[HubNavigator] executeFallback: ${cmd}`);
            this.bot.chat(cmd);
            this._lastCommandTime = Date.now();
            await new Promise(r => setTimeout(r, 3000));
            if (await this.verifyTransfer()) return true;
          } catch (e) {
            console.warn(`[HubNavigator] Fallback ${cmd} error: ${e.message}`);
          }
        }
      }
    }

    return false;
  }

  async openSelectorGUI() {
    const selector = this.hotbarManager.findSelectorItem();
    if (!selector) {
      console.log('[HubNavigator] No selector item found');
      return false;
    }

    this._lastSelectorItem = selector.name;
    this._lastSelectorSlot = selector.slot;
    this._snapshotPosition();
    console.log(`[HubNavigator] Using ${selector.displayName || selector.name} in slot ${selector.slot}`);

    try {
      await useHotbarSelector(this.bot, selector.slot);
    } catch (e) {
      console.warn(`[HubNavigator] useHotbarSelector failed: ${e.message}`);
      const equipped = await this.hotbarManager.selectSlot(selector.slot);
      if (!equipped) return false;
      await new Promise(r => setTimeout(r, 300));
      this.bot.activateItem(false);
      await new Promise(r => setTimeout(r, 500));
    }

    const window = await this.guiClient.waitForWindow(3000);
    if (window) {
      this._lastGuiTitle = this.guiClient.getTitle();
      console.log(`[HubNavigator] GUI opened: "${this._lastGuiTitle}". Waiting for items to populate...`);
      await new Promise(r => setTimeout(r, 200));

      const analysis = this.guiClient.analyzeWindow();
      console.log(`[HubNavigator] GUI analysis: ${analysis.slots.length} populated slots out of ${analysis.containerSize} total`);
      if (analysis.slots.length > 0) {
        analysis.slots.slice(0, 54).forEach(s => {
          const lore = s.lore && s.lore.length > 0 ? ` lore="${s.lore.join(' | ')}"` : '';
          console.log(`  Slot ${String(s.slot).padStart(2, ' ')}: ${s.displayName || s.name}${lore}`);
        });
      }
      if (analysis.slots.length === 0 && analysis.containerSize > 0) {
        console.log(`[HubNavigator] All ${analysis.containerSize} slots are empty — checking raw window...`);
        const raw = this.guiClient.getOpenWindow();
        if (raw) {
          for (let i = 0; i < Math.min(raw.slots.length, 54); i++) {
            const item = raw.slots[i];
            console.log(`  Raw slot ${i}: ${item ? `${item.name || item.displayName} x${item.count}` : 'null'}`);
          }
        }
      }
      return true;
    }

    return false;
  }

  async clickNPCTarget(targetMode) {
    console.log(`[HubNavigator] Attempting NPC interaction for mode: ${targetMode}`);
    this._snapshotPosition();

    // First try exact mode name match
    const result = await interactWithNPC(this.bot, targetMode, this.hotbarManager);
    if (result.success) {
      if (result.window) {
        console.log(`[HubNavigator] NPC opened a GUI — clicking target slot for "${targetMode}"`);
        await new Promise(r => setTimeout(r, 1000));
        const clicked = await this.clickTargetSlot(targetMode);
        if (!clicked) {
          console.warn(`[HubNavigator] Could not find "${targetMode}" in NPC GUI`);
          this.guiClient.close();
          return false;
        }
        await new Promise(r => setTimeout(r, 2000));
      } else {
        await new Promise(r => setTimeout(r, 3000));
      }
      return await this.verifyTransfer();
    }

    // Try common NPC names found in KryonMC hub
    const knownNpcs = ['Lifesteal', 'survival', 'SMP', 'minigame', 'kitpvp', 'factions'];
    for (const npcName of knownNpcs) {
      if (npcName.toLowerCase() === targetMode.toLowerCase()) continue;
      console.log(`[HubNavigator] Trying NPC "${npcName}" as fallback...`);
      const fallbackResult = await interactWithNPC(this.bot, npcName, this.hotbarManager);
      if (fallbackResult.success && fallbackResult.window) {
        console.log(`[HubNavigator] NPC "${npcName}" opened GUI — looking for "${targetMode}"`);
        await new Promise(r => setTimeout(r, 1000));
        const clicked = await this.clickTargetSlot(targetMode);
        if (clicked) {
          await new Promise(r => setTimeout(r, 2000));
          return await this.verifyTransfer();
        }
        this.guiClient.close();
      }
      // If the server teleported us, we might be in survival now
      if (await this.verifyTransfer()) return true;
    }

    console.warn(`[HubNavigator] NPC interaction failed: ${result.reason}`);
    return false;
  }

  async clickTargetSlot(targetMode) {
    const window = this.guiClient.getOpenWindow();
    if (!window) {
      console.log('[HubNavigator] No open window found to click.');
      return false;
    }

    const keywords = MODE_KEYWORDS[targetMode] || [targetMode];
    let slot = this.guiClient.findSlot(keywords);

    if (!slot) {
      for (const kw of keywords) {
        const alt = this.guiClient.findSlotsByName(kw);
        if (alt.length > 0) {
          slot = alt[0];
          break;
        }
      }
    }

    if (!slot && GUI_SLOT_ORDER[targetMode] !== undefined) {
      const fallbackSlotIndex = GUI_SLOT_ORDER[targetMode];
      console.log(`[HubNavigator] Using positional mapping fallback for "${targetMode}": Slot ${fallbackSlotIndex}`);
      slot = this.guiClient.getSlot(fallbackSlotIndex);
    }

    if (slot) {
      const slotName = slot.displayName || slot.name || 'Unknown Item';
      console.log(`[HubNavigator] Clicking slot ${slot.slot} (${slotName}) for mode: ${targetMode}`);
      this._lastClickedSlot = slot.slot;
      return await this.guiClient.click(slot.slot);
    }

    console.log(`[HubNavigator] All fallback options exhausted. Could not resolve a GUI slot for: ${targetMode}`);
    return false;
  }

  async verifyTransfer() {
    await new Promise(r => setTimeout(r, 2000));

    // 1) Game mode change — if it changed to something different, we moved
    const gm = this.bot.game?.gameMode;
    if (gm && this._lastGameMode && gm !== this._lastGameMode) {
      console.log(`[HubNavigator] Game mode changed: "${this._lastGameMode}" → "${gm}"`);
      this._lastGameMode = gm;
      return true;
    }
    this._lastGameMode = gm;

    const now = this.bot.entity?.position;

    // 2) Position shift > 5 blocks
    if (this._posBefore && now) {
      const dx = now.x - this._posBefore.x;
      const dz = now.z - this._posBefore.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > 5) {
        console.log(`[HubNavigator] Position shifted ${dist.toFixed(1)} blocks — world changed`);
        return true;
      }
    }

    // 3) Dimension change
    const dim = this.bot.game?.dimension;
    if (this._lastDimension && dim && dim !== this._lastDimension) {
      console.log(`[HubNavigator] Dimension changed: "${this._lastDimension}" → "${dim}"`);
      this._lastDimension = dim;
      return true;
    }
    this._lastDimension = dim;

    // 4) Scoreboard change
    const title = this.bot.scoreboard?.title?.toLowerCase() || '';
    if (title && this._lastScoreboard && title !== this._lastScoreboard) {
      console.log(`[HubNavigator] Scoreboard changed: "${this._lastScoreboard}" → "${title}"`);
      this._lastScoreboard = title;
      return true;
    }
    this._lastScoreboard = title;

    // 5) Player count change > 3
    const nowCount = Object.keys(this.bot.players || {}).length;
    if (this._lastPlayerCount && Math.abs(nowCount - this._lastPlayerCount) > 3) {
      console.log(`[HubNavigator] Player count changed: ${this._lastPlayerCount} → ${nowCount}`);
      this._lastPlayerCount = nowCount;
      return true;
    }
    this._lastPlayerCount = nowCount;

    return false;
  }

  async fastJoin(profile) {
    if (profile.selectorSlot !== null && profile.selectorSlot !== undefined) {
      console.log(`[HubNavigator] Fast join: use slot ${profile.selectorSlot}`);
      try {
        await useHotbarSelector(this.bot, profile.selectorSlot);
      } catch {
        await this.hotbarManager.selectAndUse(profile.selectorSlot);
      }
    const window = await this.guiClient.waitForWindow(5000);
      if (window) {
        if (profile.guiSlot !== null && profile.guiSlot !== undefined) {
          console.log(`[HubNavigator] Fast join: clicking saved GUI slot ${profile.guiSlot}`);
          await this.guiClient.click(profile.guiSlot);
          await new Promise(r => setTimeout(r, 3000));
          return await this.verifyTransfer();
        }
        const keywords = MODE_KEYWORDS[profile.targetMode || 'survival'] || [profile.targetMode || 'survival'];
        const slot = this.guiClient.findSlot(keywords);
        if (slot) {
          await this.guiClient.click(slot.slot);
          await new Promise(r => setTimeout(r, 3000));
          return await this.verifyTransfer();
        }
      }
    }

    if (profile.commands && profile.commands.length > 0) {
      for (const cmd of profile.commands) {
        this.bot.chat(cmd);
        await new Promise(r => setTimeout(r, 4000));
        if (await this.verifyTransfer()) return true;
      }
    }

    return false;
  }

  _snapshotPosition() {
    const p = this.bot.entity?.position;
    this._posBefore = p ? { x: p.x, y: p.y, z: p.z } : null;
    this._lastGameMode = this.bot.game?.gameMode || null;
    this._lastDimension = this.bot.game?.dimension || null;
  }

  reset() {
    this._posBefore = null;
    this._lastScoreboard = null;
    this._lastPlayerCount = 0;
    this._lastSelectorItem = null;
    this._lastSelectorSlot = null;
    this._lastClickedSlot = null;
    this._lastGuiTitle = null;
    this._lastGameMode = null;
    this._lastDimension = null;
  }
}

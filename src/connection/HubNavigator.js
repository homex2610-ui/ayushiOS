import { HubNavigator as NewHubNavigator } from '../hub/HubNavigator.js';
import { HubHotbarManager } from '../hub/HubHotbarManager.js';
import { HubGUIClient } from '../hub/HubGUIClient.js';

function _getOrCreateManagers(bot) {
  const hotbarManager = new HubHotbarManager(bot);
  const guiClient = new HubGUIClient(bot);
  return { hotbar: hotbarManager, gui: guiClient };
}

export class HubNavigator {
  constructor(bot) {
    this.bot = bot;
    const managers = _getOrCreateManagers(bot);
    this._hotbarManager = managers.hotbar;
    this._guiClient = managers.gui;
    this._impl = new NewHubNavigator(bot, null, this._hotbarManager, this._guiClient);
    this._navigating = false;
    this._navigationMethod = null;
    this._targetMode = null;
  }

  get isNavigating() {
    return this._navigating;
  }

  async navigateToMode(targetMode) {
    this._targetMode = targetMode || 'survival';
    if (this._navigating) {
      console.warn('[HubNavigator] Already navigating');
      return false;
    }
    this._navigating = true;
    this._navigationMethod = 'execution';
    if (this.bot) this.bot._navigationInProgress = true;

    try {
      const methods = [
        // Try commands first (fastest for KryonMC)
        { name: 'command', fn: () => this._impl.executeCommand(this._targetMode) },
        // Try NPC interaction (KryonMC has NPCs with names like "Lifesteal", "survival")
        { name: 'npc', fn: () => this._impl.clickNPCTarget(this._targetMode) },
        // Try GUI selector (nether star / compass)
        { name: 'gui', fn: async () => {
            const opened = await this._impl.openSelectorGUI();
            if (!opened) return false;
            this._navigationMethod = 'compass_gui';
            const clicked = await this._impl.clickTargetSlot(this._targetMode);
            if (!clicked) return false;
            await new Promise(r => setTimeout(r, 3000));
            return await this._impl.verifyTransfer();
          }
        },
      ];

      for (const method of methods) {
        try {
          const result = await method.fn();
          if (result) {
            console.log(`[HubNavigator] Navigation succeeded via ${method.name}`);
            this._navigating = false;
            if (this.bot) this.bot._navigationInProgress = false;
            return true;
          }
        } catch (e) {
          console.warn(`[HubNavigator] Method ${method.name} error: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn(`[HubNavigator] navigateToMode error: ${e.message}`);
    }

    console.warn('[HubNavigator] All navigation methods failed');
    this._navigating = false;
    if (this.bot) this.bot._navigationInProgress = false;
    return false;
  }

  async navigateToSurvival(targetServerName) {
    return this.navigateToMode(targetServerName || 'survival');
  }

  reset() {
    this._navigating = false;
    this._navigationMethod = null;
    this._targetMode = null;
    if (this._impl) this._impl.reset();
  }
}

export function createHubNavigator(bot) {
  return new HubNavigator(bot);
}

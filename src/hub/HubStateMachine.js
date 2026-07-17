import { HubNavigator } from './HubNavigator.js';
import { HubHotbarManager } from './HubHotbarManager.js';
import { HubGUIClient } from './HubGUIClient.js';
import { HubProfile } from './HubProfile.js';
import { computeHubScore } from './HubDetector.js';
import { findPhysicalNPC } from './LobbyHelpers.js';

const HubStates = {
  INIT: 'init',
  AUTHENTICATING: 'authenticating',
  AUTHENTICATED: 'authenticated',
  HUB_DETECTED: 'hub_detected',
  READING_HOTBAR: 'reading_hotbar',
  SELECTING_METHOD: 'selecting_method',
  EXECUTING_COMMAND: 'executing_command',
  INTERACTING_NPC: 'interacting_npc',
  OPENING_GUI: 'opening_gui',
  CLICKING_TARGET: 'clicking_target',
  VERIFYING: 'verifying',
  VERIFIED: 'verified',
  SURVIVAL: 'survival',
  FAILED: 'failed',
};

const MAX_RETRIES = 3;
const STATE_TIMEOUT = 15000;

export class HubStateMachine {
  constructor(agent) {
    this.agent = agent;
    this.bot = agent.bot;
    this.state = HubStates.INIT;
    this.hotbarManager = new HubHotbarManager(this.bot);
    this.guiClient = new HubGUIClient(this.bot);
    this.profile = new HubProfile(this.bot);
    this.navigator = new HubNavigator(this.bot, this.agent, this.hotbarManager, this.guiClient);
    this.retryCount = 0;
    this.stateStartTime = Date.now();
    this.stateHistory = [];
    this._stateTimeout = null;
    this._onComplete = null;
    this._onFail = null;
  }

  get currentState() { return this.state; }

  onComplete(cb) { this._onComplete = cb; }
  onFail(cb) { this._onFail = cb; }

  async start(targetMode = 'survival') {
    this.targetMode = targetMode;
    this.retryCount = 0;
    this.stateHistory = [];

    if (this.bot) this.bot._navigationInProgress = true;

    const profile = this.profile.load();
    if (profile && profile.hub && profile.selector) {
      console.log(`[HubStateMachine] Loaded hub profile for ${profile.server || 'this server'} — fast path`);
      return await this._fastPath(profile);
    }

    return await this._run();
  }

  async _fastPath(profile) {
    console.log(`[HubStateMachine] Fast path: equip selector, open GUI, click target`);
    const result = await this.navigator.fastJoin(profile);
    if (result) {
      console.log(`[HubStateMachine] Fast path succeeded`);
      if (this._onComplete) this._onComplete();
      return true;
    }
    console.log(`[HubStateMachine] Fast path failed, falling back to full detection`);
    return await this._run();
  }

  async _run() {
    this.state = HubStates.INIT;
    this.stateStartTime = Date.now();

    while (this.state !== HubStates.SURVIVAL && this.state !== HubStates.FAILED) {
      if (this.retryCount > MAX_RETRIES) {
        console.error(`[HubStateMachine] Max retries (${MAX_RETRIES}) exceeded`);
        this.state = HubStates.FAILED;
        break;
      }

      const elapsed = Date.now() - this.stateStartTime;
      if (elapsed > STATE_TIMEOUT) {
        console.warn(`[HubStateMachine] State ${this.state} timed out after ${elapsed}ms, retrying`);
        this.retryCount++;
        this.stateStartTime = Date.now();
      }

      try {
        await this._tick();
      } catch (e) {
        console.warn(`[HubStateMachine] Error in state ${this.state}: ${e.message}`);
        this.retryCount++;
        await new Promise(r => setTimeout(r, 2000));
      }

      await new Promise(r => setTimeout(r, 500));
    }

    if (this.state === HubStates.SURVIVAL) {
      console.log(`[HubStateMachine] Navigation complete — target server reached`);
      const rawSlot = this.navigator._lastSelectorSlot;
      const hotbarIdx = (rawSlot !== null && rawSlot >= 36 && rawSlot <= 44) ? (rawSlot - 36) : rawSlot;
      const profileData = {
        targetMode: this.targetMode,
        selectorItem: this.navigator._lastSelectorItem || null,
        selectorSlot: rawSlot ?? null,
        guiSlot: this.navigator._lastClickedSlot ?? null,
        guiTitle: this.navigator._lastGuiTitle || null,
        hotbarIndex: hotbarIdx,
      };
      this.profile.save(this.targetMode, profileData);
      console.log(`[HubStateMachine] Hub profile saved to disk`);
      this._clearNavFlag();
      if (this._onComplete) this._onComplete();
      return true;
    }

    console.error(`[HubStateMachine] Navigation failed`);
    this._clearNavFlag();
    if (this._onFail) this._onFail();
    return false;
  }

  async _tick() {
    const prevState = this.state;

    switch (this.state) {
      case HubStates.INIT: {
        const hubResult = computeHubScore(this.bot);
        if (hubResult.isHub || hubResult.isPossibleHub) {
          this.state = HubStates.HUB_DETECTED;
          break;
        }
        console.log(`[HubStateMachine] Not in hub (score: ${hubResult.score})`);
        this.retryCount++;
        if (this.retryCount > MAX_RETRIES) {
          console.error(`[HubStateMachine] Max retries in INIT — failing`);
          this.state = HubStates.FAILED;
        } else {
          await new Promise(r => setTimeout(r, 3000));
        }
        break;
      }

      case HubStates.HUB_DETECTED: {
        this._triedMethods = new Set();
        console.log(`[HubStateMachine] Hub detected — reading environment`);
        this.state = HubStates.READING_HOTBAR;
        break;
      }

      case HubStates.READING_HOTBAR: {
        const hotbar = this.hotbarManager.getHotbar();
        const selector = this.hotbarManager.findSelectorItem();
        if (selector) {
          console.log(`[HubStateMachine] Found selector: ${selector.displayName || selector.name} in slot ${selector.slot}`);
        } else {
          console.log(`[HubStateMachine] No selector item found in hotbar`);
        }
        this.state = HubStates.SELECTING_METHOD;
        break;
      }

      case HubStates.SELECTING_METHOD: {
        const method = await this._pickMethod();
        if (method === 'command') {
          this.state = HubStates.EXECUTING_COMMAND;
        } else if (method === 'gui') {
          this.state = HubStates.OPENING_GUI;
        } else if (method === 'npc') {
          this.state = HubStates.INTERACTING_NPC;
        } else {
          this.retryCount++;
          this.state = HubStates.HUB_DETECTED;
        }
        break;
      }

      case HubStates.EXECUTING_COMMAND: {
        const cmdResult = await this.navigator.executeCommand(this.targetMode);
        if (cmdResult) {
          this.state = HubStates.VERIFYING;
        } else {
          console.warn(`[HubStateMachine] Command failed — retrying from HUB_DETECTED`);
          this.retryCount++;
          this.state = HubStates.HUB_DETECTED;
        }
        break;
      }

      case HubStates.OPENING_GUI: {
        const guiOpened = await this.navigator.openSelectorGUI();
        if (guiOpened) {
          this.state = HubStates.CLICKING_TARGET;
        } else {
          console.warn(`[HubStateMachine] Failed to open GUI — retrying from HUB_DETECTED`);
          this.retryCount++;
          this.state = HubStates.HUB_DETECTED;
        }
        break;
      }

      case HubStates.INTERACTING_NPC: {
        const npcResult = await this.navigator.clickNPCTarget(this.targetMode);
        if (npcResult) {
          this.state = HubStates.VERIFYING;
        } else {
          console.warn(`[HubStateMachine] NPC interaction failed — retrying from HUB_DETECTED`);
          this.retryCount++;
          this.state = HubStates.HUB_DETECTED;
        }
        break;
      }

      case HubStates.CLICKING_TARGET: {
        const clicked = await this.navigator.clickTargetSlot(this.targetMode);
        if (clicked) {
          this.state = HubStates.VERIFYING;
        } else {
          this.guiClient.close();
          console.warn(`[HubStateMachine] No target slot found in GUI — retrying from HUB_DETECTED`);
          this.retryCount++;
          this.state = HubStates.HUB_DETECTED;
        }
        break;
      }

      case HubStates.VERIFYING: {
        const verified = await this.navigator.verifyTransfer();
        if (verified) {
          this.state = HubStates.SURVIVAL;
        } else {
          console.warn(`[HubStateMachine] Transfer verification failed — retrying from HUB_DETECTED`);
          this.retryCount++;
          this.state = HubStates.HUB_DETECTED;
        }
        break;
      }

      case HubStates.FAILED: {
        console.error(`[HubStateMachine] Navigation failed permanently`);
        break;
      }
    }

    if (prevState !== this.state) {
      this.stateHistory.push({ from: prevState, to: this.state, at: Date.now() });
      this.stateStartTime = Date.now();
    }
  }

  async _pickMethod() {
    if (!this._triedMethods) this._triedMethods = new Set();

    const candidates = [];
    const selector = this.hotbarManager.findSelectorItem();
    if (selector) candidates.push('gui');

    const npcTarget = findPhysicalNPC(this.bot, this.targetMode);
    if (npcTarget) candidates.push('npc');

    const commands = this.navigator.getModeCommands(this.targetMode);
    if (commands.length > 0) candidates.push('command');

    for (const method of candidates) {
      if (!this._triedMethods.has(method)) {
        console.log(`[HubStateMachine] Selected method: ${method}`);
        return method;
      }
    }

    this._triedMethods.clear();
    const fallback = candidates[0] || 'command';
    console.log(`[HubStateMachine] All methods tried, resetting — falling back to: ${fallback}`);
    return fallback;
  }

  _clearNavFlag() {
    if (this.bot) this.bot._navigationInProgress = false;
  }

  reset() {
    this.state = HubStates.INIT;
    this.retryCount = 0;
    this.targetMode = null;
    this.stateHistory = [];
    this.hotbarManager = new HubHotbarManager(this.bot);
    this.guiClient = new HubGUIClient(this.bot);
  }
}

import { computeHubScore, debugHubScore } from './HubDetector.js';
import { HubStateMachine } from './HubStateMachine.js';
import { HubProfile } from './HubProfile.js';

const SURVIVAL_MODES = [
  'self_defense',
  'self_preservation',
  'walking_gaze',
  'fidget',
  'idle_staring',
  'auto_survival',
  'elbow_room',
  'torch_placing',
  'item_collecting',
  'hunting',
];

export class HubMode {
  constructor(agent) {
    this.agent = agent;
    this.bot = agent.bot;
    this.on = true;
    this.paused = false;
    this.active = false;
    this._hubDetected = false;
    this._dwellerMode = false;
    this._stateMachine = null;
    this._lastCheck = 0;
    this._checkInterval = 5000;
    this._lastScore = -1;
    this._survivalModesPaused = false;
  }

  update(agent) {
    if (!this.on || this.paused) return;

    if (this._stateMachine) {
      const state = this._stateMachine.currentState;
      if (state === 'survival' || state === 'failed') {
        if (state === 'survival') {
          console.log('[HubMode] Navigation completed — unblocking survival modes');
          this._hubDetected = false;
          this._unblockSurvivalModes();
        } else {
          console.error('[HubMode] Navigation failed permanently');
        }
        this._stateMachine = null;
        this.active = false;
      }
      return;
    }

    const now = Date.now();
    if (now - this._lastCheck < this._checkInterval) return;
    this._lastCheck = now;

    const result = computeHubScore(this.bot);

    if (result.isHub) {
      this._lastScore = result.score;
      if (!this._hubDetected) {
        console.log(`[HubMode] Hub detected (score: ${result.score}). Blocking survival modes.`);
        this._hubDetected = true;
      }
      this._blockSurvivalModes();
      if (this._dwellerMode) return;
      this._startNavigation();
    } else if (this._hubDetected && !result.isHub && result.score < 30) {
      console.log(`[HubMode] No longer in hub (score: ${result.score}). Unblocking survival modes.`);
      this._hubDetected = false;
      this._unblockSurvivalModes();
    } else if (this._hubDetected && result.isPossibleHub) {
      this._lastScore = result.score;
    } else if (this._lastScore === -1) {
      const debug = debugHubScore(this.bot);
      console.log(`[HubMode] First check — hub score: ${debug.score}${debug.isHub ? ' (HUB)' : debug.isPossibleHub ? ' (POSSIBLE)' : ' (NOT HUB)'}`);
      this._lastScore = debug.score;
    }
  }

  _startNavigation() {
    if (this.active) return;
    this.active = true;

    const profile = new HubProfile(this.bot);
    if (profile.isHubLocked()) {
      console.log('[HubMode] Hub is locked — navigation disabled. Activating hub dweller mode.');
      this._activateDwellerMode();
      return;
    }

    console.log('[HubMode] Starting background navigation to survival...');
    this._stateMachine = new HubStateMachine(this.agent);
    this._stateMachine.start('survival').then(success => {
      if (!success && this._stateMachine?.currentState !== 'survival') {
        console.error('[HubMode] Navigation returned false');
        this._stateMachine = null;
        this.active = false;
        this._hubDetected = false;
        this._unblockSurvivalModes();

        profile.lockHub();
        this._activateDwellerMode();
      }
    }).catch(e => {
      console.error(`[HubMode] Navigation error: ${e.message}`);
      this._stateMachine = null;
      this.active = false;
      this._hubDetected = false;
      this._unblockSurvivalModes();

      profile.lockHub();
      this._activateDwellerMode();
    });
  }

  _activateDwellerMode() {
    console.log('[HubDweller] Bot will stay on hub as lobby greeter.');
    this._dwellerMode = true;
    this._hubDetected = true;
    this.active = false;
    this._unblockSurvivalModes();

    if (!this.bot || !this.bot.entity) {
      console.warn('[HubDweller] Bot disconnected — cannot activate greeter.');
      return;
    }

    this.bot.on('playerJoined', (player) => {
      if (!player || player.username === this.bot.username) return;
      setTimeout(() => {
        try {
          this.bot.chat(`hey ${player.username}!`);
        } catch {}
      }, 2000);
    });
  }

  _blockSurvivalModes() {
    if (this._survivalModesPaused) return;
    const bot = this.bot;
    for (const modeName of SURVIVAL_MODES) {
      if (bot.modes && typeof bot.modes.pause === 'function') {
        bot.modes.pause(modeName);
      }
    }
    this._survivalModesPaused = true;
  }

  _unblockSurvivalModes() {
    if (!this._survivalModesPaused) return;
    const bot = this.bot;
    for (const modeName of SURVIVAL_MODES) {
      if (bot.modes && typeof bot.modes.unpause === 'function') {
        bot.modes.unpause(modeName);
      }
    }
    this._survivalModesPaused = false;
  }

  reset() {
    this._hubDetected = false;
    this._lastCheck = 0;
    this._lastScore = -1;
    this._unblockSurvivalModes();
    if (this._stateMachine) {
      this._stateMachine.reset();
      this._stateMachine = null;
    }
    this.active = false;
  }
}

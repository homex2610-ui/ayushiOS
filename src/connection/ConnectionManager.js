import { LANScanner } from './LANScanner.js';
import { WorldDetector } from './WorldDetector.js';
import { ServerSelector } from './ServerSelector.js';
import { ReconnectManager } from './ReconnectManager.js';
import { HealthMonitor } from './HealthMonitor.js';
import { HubStateMachine } from '../hub/HubStateMachine.js';
import { HubNavigator } from '../hub/HubNavigator.js';
import { computeHubScore } from '../hub/HubDetector.js';
import { HubProfile } from '../hub/HubProfile.js';
import { dumpAll } from '../debug/ServerInspectors.js';
import CONNECTION_CONFIG, { ServerState, WorldType } from './ConnectionSettings.js';

export class ConnectionManager {
    constructor() {
        this.state = ServerState.UNKNOWN;
        this.lanScanner = new LANScanner();
        this.serverSelector = new ServerSelector({});
        this.worldDetector = null;
        this._hubStateMachine = null;
        this.reconnectManager = new ReconnectManager();
        this.healthMonitor = null;
        this.bot = null;
        this._targetServer = null;
        this._onReadyCallback = null;
        this._onStateChange = null;
        this._readyResolvers = [];
    }

    setBot(bot) {
        this.bot = bot;
        this.worldDetector = new WorldDetector(bot);
        this._hubStateMachine = null;
        this.healthMonitor = new HealthMonitor(bot);
        this._lastInspectTime = 0;
        this._registerInspectCommand();
    }

    _registerInspectCommand() {
        this.bot.on('chat', (username, message) => {
            if (!username || username === this.bot.username) return;
            if (message.trim().toLowerCase() !== '!inspect') return;

            const now = Date.now();
            if (now - this._lastInspectTime < 3000) return;
            this._lastInspectTime = now;

            try {
                console.log(`\n[ChatInspector] Diagnostic triggered in-game by ${username}`);
                dumpAll(this.bot);

                const currentWindow = this.bot.currentWindow
                    ? `GUI: "${this.bot.currentWindow.title || 'Container'}"`
                    : 'No open GUI';
                const heldSlot = 36 + (this.bot.quickbarSlot || 0);
                const heldItem = this.bot.inventory.slots[heldSlot];
                const heldName = heldItem ? `${heldItem.displayName || heldItem.name} x${heldItem.count}` : 'Empty Hand';
                const objCount = this.bot.scoreboard?.title ? 1 : 0;

                this.bot.chat(`[Inspector] Held: ${heldName} | ${currentWindow} | Scoreboards: ${objCount}`);
            } catch (err) {
                console.error('[ChatInspector] Dump failed:', err);
                this.bot.chat('[Inspector] Dump failed — check console');
            }
        });
    }

    onReady(callback) {
        this._onReadyCallback = callback;
    }

    onStateChange(callback) {
        this._onStateChange = callback;
    }

    _setState(newState) {
        const oldState = this.state;
        this.state = newState;
        console.log(`[Connection] State: ${oldState} -> ${newState}`);
        if (this._onStateChange) {
            this._onStateChange(newState, oldState);
        }
    }

    async selectTarget(settings) {
        this._setState(ServerState.CONNECTING);
        console.log('[Connection] Scanning for available servers...');

        this.serverSelector.settings = settings;

        let lanServer = null;
        if (CONNECTION_CONFIG.preferLAN) {
            lanServer = await this.lanScanner.scan('127.0.0.1');
        }

        this._targetServer = await this.serverSelector.select(lanServer);

        if (!this._targetServer) {
            this._setState(ServerState.ERROR);
            throw new Error('[Connection] No server available to connect to.');
        }

        console.log(`[Connection] Target selected: ${this._targetServer.host}:${this._targetServer.port} (${this._targetServer.type})`);
        this._setState(ServerState.CONNECTING);

        const result = {
            host: this._targetServer.host,
            port: this._targetServer.port,
            auth: this._targetServer.auth,
            minecraft_version: this._targetServer.minecraft_version,
            source: this._targetServer.source,
            type: this._targetServer.type
        };

        if (this._targetServer.password) result.password = this._targetServer.password;

        return result;
    }

    async waitForReady(timeoutMs = 60000) {
        return new Promise((resolve, reject) => {
            this._readyResolvers.push(resolve);

            const timeout = setTimeout(() => {
                console.warn('[Connection] Ready timeout reached');
                this._setState(ServerState.READY);
                resolve({ success: true, timeout: true });
            }, timeoutMs);

            this.onReady((result) => {
                clearTimeout(timeout);
                resolve(result);
            });
        });
    }

    async handleSpawn(bot) {
        this.setBot(bot);
        console.log('[Connection] Bot spawned.');

        this._setState(ServerState.PROXY);

        // Run startup commands (register/login/etc)
        if (CONNECTION_CONFIG.startupCommands && CONNECTION_CONFIG.startupCommands.length > 0) {
            console.log('[Connection] Running startup commands...');
            for (const cmd of CONNECTION_CONFIG.startupCommands) {
                await new Promise(r => setTimeout(r, 1500));
                bot.chat(cmd);
                console.log(`[Connection] Sent: ${cmd}`);
            }
            await new Promise(r => setTimeout(r, 2000));
        }

        console.log('[Connection] Classifying world...');
        await new Promise(r => setTimeout(r, 3000));

        // Debug Inspection: dump runtime environment immediately
        console.log('\n########################################################');
        console.log('##         RUNTIME ENVIRONMENT REPORT (INITIAL)       ##');
        console.log('########################################################');
        dumpAll(this.bot);
        console.log('########################################################\n');

        // Fast path: check for existing profile and skip classification
        const hubProfile = new HubProfile(this.bot);
        const cachedProfile = hubProfile.load();
        if (cachedProfile && cachedProfile.hub) {
            console.log(`[Connection] Found saved profile for ${cachedProfile.server || hubProfile._getServerKey()}. Attempting fast-join...`);
            const hotbarManager = new HubHotbarManager(this.bot);
            const guiClient = new HubGUIClient(this.bot);
            const fastNavigator = new HubNavigator(this.bot, null, hotbarManager, guiClient);
            const fastResult = await fastNavigator.fastJoin(cachedProfile);
            if (fastResult) {
                console.log('[Connection] Fast-join succeeded — bypass classification');
                this._setState(ServerState.SURVIVAL);
                return await this._signalReady({ type: WorldType.SURVIVAL, confidence: 100, scoreboardTitle: '' });
            }
            console.log('[Connection] Fast-join failed. Profile may be stale. Re-scanning...');
        }

        let worldProfile = await this.worldDetector.classify();
        console.log(`[Connection] Initial classification: ${worldProfile.type} (confidence: ${worldProfile.confidence}%)`);

        if (this.worldDetector.isHub()) {
            return await this._handleHub(worldProfile);
        }

        // If classified as survival but HubDetector says possible hub, wait for more data and retry
        if (!this.worldDetector.isHub() && worldProfile.type !== WorldType.HUB) {
            const hubCheck = computeHubScore(this.bot);
            if (hubCheck.isPossibleHub || hubCheck.isHub) {
                console.log(`[Connection] HubDetector score: ${hubCheck.score} (possible hub) — waiting for more data...`);
                await new Promise(r => setTimeout(r, 5000));
                worldProfile = await this.worldDetector.classify();
                if (this.worldDetector.isHub()) {
                    return await this._handleHub(worldProfile);
                }
            }
        }

        if (this.worldDetector.isSurvivalOrSMP()) {
            this._setState(ServerState.SURVIVAL);
            console.log('[Connection] Connected to survival world!');
            return await this._signalReady(worldProfile);
        }

        console.log(`[Connection] World classified as ${worldProfile.type}. Proceeding with ready state.`);
        this._setState(ServerState.READY);
        return await this._signalReady(worldProfile);
    }



    async _handleHub(worldProfile) {
        this._setState(ServerState.HUB);

        // Always start fresh — delete stale profile from previous session
        const hubProfile = new HubProfile(this.bot);
        hubProfile.delete();
        console.log('[Connection] Deleted stale hub profile — starting fresh navigation');

        const targetName = this._detectTargetFromScoreboard(worldProfile) || 'survival';
        console.log(`[Connection] Detected hub — navigating to: ${targetName}`);

        if (!this._hubStateMachine) {
            this._hubStateMachine = new HubStateMachine({ bot: this.bot });
        }
        this._hubStateMachine.onComplete(() => {});
        this._hubStateMachine.onFail(() => {});
        const navPromise = this._hubStateMachine.start(targetName);
        const timeoutPromise = new Promise(r => setTimeout(() => r(false), 60000));
        const navigated = await Promise.race([navPromise, timeoutPromise]);

        if (navigated) {
            console.log(`[Connection] Successfully joined ${targetName} server!`);
            await new Promise(r => setTimeout(r, 3000));
            const newProfile = await this.worldDetector.classify();
            this._setState(ServerState.SURVIVAL);
            return await this._signalReady(newProfile);
        }

        console.warn(`[Connection] Navigation to ${targetName} timed out or failed. Trying fallback...`);
        // Don't lock hub - try to proceed anyway, the bot may already be in survival
        this._setState(ServerState.SURVIVAL);
        return await this._signalReady(worldProfile);
    }

    _detectTargetFromScoreboard(worldProfile) {
        if (!worldProfile || !worldProfile.scoreboardTitle) return null;
        const title = worldProfile.scoreboardTitle.toLowerCase();
        if (title === 'none' || title === '') return null;
        if (title.includes('lifesteal')) return 'lifesteal';
        if (title.includes('survival')) return 'survival';
        if (title.includes('smp')) return 'smp';
        if (title.includes('earth')) return 'earth';
        if (title.includes('towny')) return 'towny';
        if (title.includes('economy')) return 'economy';
        return null;
    }

    async _signalReady(worldProfile) {
        this._setState(ServerState.READY);
        const result = {
            success: true,
            worldProfile,
            server: this._targetServer
        };
        if (this._onReadyCallback) this._onReadyCallback(result);
        for (const resolve of this._readyResolvers) resolve(result);
        this._readyResolvers = [];
        return result;
    }

    async handleDisconnect(reason, reconnectFn) {
        this._setState(ServerState.DISCONNECTED);
        console.log(`[Connection] Handling disconnect: ${reason}`);
        return await this.reconnectManager.handleDisconnect(reason, reconnectFn);
    }

    startHealthMonitoring(healthCheckFn) {
        if (this.healthMonitor) {
            this.healthMonitor.start(healthCheckFn);
        }
    }

    stopHealthMonitoring() {
        if (this.healthMonitor) {
            this.healthMonitor.stop();
        }
    }

    shutdown() {
        console.log('[Connection] Shutting down connection manager...');
        this.reconnectManager.stop();
        this.stopHealthMonitoring();
        this._hubStateMachine = null;
    }

    updateConfig(settings) {
        if (settings.connection_prefer_lan !== undefined) CONNECTION_CONFIG.preferLAN = settings.connection_prefer_lan;
        if (settings.connection_auto_fallback !== undefined) CONNECTION_CONFIG.autoFallback = settings.connection_auto_fallback;
        if (settings.connection_auto_reconnect !== undefined) CONNECTION_CONFIG.autoReconnect = settings.connection_auto_reconnect;
        if (settings.connection_auto_detect_hub !== undefined) CONNECTION_CONFIG.autoDetectHub = settings.connection_auto_detect_hub;
    }
}

export const connectionManager = new ConnectionManager();

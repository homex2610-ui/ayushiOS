import CONNECTION_CONFIG from './ConnectionSettings.js';

// P1 ARCHITECTURE NOTE — recovery topology:
//  • In-process reconnect (this class) is DORMANT by design today: on kick,
//    agent.js exits (connection_auto_reconnect) and AgentProcess restarts the
//    whole child, which re-runs ConnectionManager.selectTarget → spawn.
//    That is the production recovery path.
//  • This class remains available for in-process recovery experiments and
//    emits `recovery.reconnect_attempt` telemetry so a future dashboard can
//    visualize either path. Do not wire both paths simultaneously.

export class ReconnectManager {
    constructor() {
        this._attempts = 0;
        this._maxAttempts = 15;
        this._lastReconnect = 0;
        this._exiting = false;
        this._timer = null;
    }

    get attemptCount() {
        return this._attempts;
    }

    get isExiting() {
        return this._exiting;
    }

    async handleDisconnect(reason, reconnectFn) {
        if (this._exiting) return;

        this._attempts++;
        console.log(`[Reconnect] Disconnected: ${reason}`);
        console.log(`[Reconnect] Reconnect attempt ${this._attempts}/${this._maxAttempts}`);

        if (this._attempts > this._maxAttempts) {
            console.error(`[Reconnect] Max attempts (${this._maxAttempts}) reached. Giving up.`);
            return false;
        }

        const delay = this._calculateDelay();
        console.log(`[Reconnect] Waiting ${(delay/1000).toFixed(1)}s before reconnecting...`);

        return new Promise((resolve) => {
            this._timer = setTimeout(async () => {
                if (this._exiting) {
                    resolve(false);
                    return;
                }
                console.log('[Reconnect] Attempting reconnection...');
                try {
                    const result = await reconnectFn();
                    if (result) {
                        this._attempts = 0;
                        console.log('[Reconnect] Reconnection successful');
                        resolve(true);
                    } else {
                        console.warn('[Reconnect] Reconnection returned false, will retry...');
                        resolve(await this.handleDisconnect('reconnect_failed', reconnectFn));
                    }
                } catch (err) {
                    console.error(`[Reconnect] Reconnection failed: ${err.message}`);
                    resolve(await this.handleDisconnect(err.message, reconnectFn));
                }
            }, delay);
        });
    }

    _calculateDelay() {
        const base = CONNECTION_CONFIG.reconnectDelay;
        const max = CONNECTION_CONFIG.maxReconnectDelay;
        const exponential = base * Math.pow(2, this._attempts - 1);
        const jitter = Math.random() * 3000;
        return Math.min(exponential + jitter, max);
    }

    reset() {
        this._attempts = 0;
        this._lastReconnect = 0;
        this._exiting = false;
    }

    cancel() {
        this._exiting = true;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }

    stop() {
        this.cancel();
    }
}

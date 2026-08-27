import CONNECTION_CONFIG from './ConnectionSettings.js';

export class HealthMonitor {
    constructor(bot) {
        this.bot = bot;
        this._interval = null;
        this._lastHeartbeat = Date.now();
        this._healthy = true;
        this._frozenCount = 0;
        this._started = false;
        this._onChatActivity = null;
        this._onMoveActivity = null;
        this._onKeepAlive = null;
    }

    get isHealthy() {
        return this._healthy;
    }

    start(healthCheckFn) {
        if (this._started) return;
        this._started = true;
        console.log('[HealthMonitor] Starting health checks...');
        this._lastHeartbeat = Date.now();
        this._healthy = true;

        this._onChatActivity = () => { this._lastHeartbeat = Date.now(); };
        this._onMoveActivity = () => { this._lastHeartbeat = Date.now(); };
        this.bot.on('chat', this._onChatActivity);
        this.bot.on('move', this._onMoveActivity);

        if (this.bot._client) {
            this._onKeepAlive = () => { this._lastHeartbeat = Date.now(); };
            this.bot._client.on('keep_alive', this._onKeepAlive);
        }

        this._interval = setInterval(() => {
            this._check(healthCheckFn);
        }, CONNECTION_CONFIG.healthCheckInterval);
    }

    stop() {
        if (this._onChatActivity) this.bot.removeListener('chat', this._onChatActivity);
        if (this._onMoveActivity) this.bot.removeListener('move', this._onMoveActivity);
        if (this._onKeepAlive && this.bot._client) this.bot._client.removeListener('keep_alive', this._onKeepAlive);
        this._onChatActivity = null;
        this._onMoveActivity = null;
        this._onKeepAlive = null;
        this._started = false;
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
    }

    _check(healthCheckFn) {
        try {
            if (!this.bot || !this.bot.entity) {
                this._healthy = false;
                return;
            }

            const now = Date.now();
            const elapsed = now - this._lastHeartbeat;

            if (elapsed > CONNECTION_CONFIG.healthCheckTimeout) {
                this._frozenCount++;
                console.warn(`[HealthMonitor] No activity for ${(elapsed/1000).toFixed(0)}s (threshold: ${CONNECTION_CONFIG.healthCheckTimeout/1000}s, count: ${this._frozenCount})`);

                if (this._frozenCount >= 3) {
                    console.error('[HealthMonitor] Bot appears frozen. Triggering health check callback...');
                    this._healthy = false;
                    if (healthCheckFn) healthCheckFn('frozen');
                }
            } else {
                this._frozenCount = 0;
                this._healthy = true;
            }
        } catch (e) {
            console.warn(`[HealthMonitor] Check error: ${e.message}`);
        }
    }

    ping() {
        this._lastHeartbeat = Date.now();
    }
}

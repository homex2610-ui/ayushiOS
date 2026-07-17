import CONNECTION_CONFIG from './ConnectionSettings.js';

export class HealthMonitor {
    constructor(bot) {
        this.bot = bot;
        this._interval = null;
        this._lastHeartbeat = Date.now();
        this._healthy = true;
        this._frozenCount = 0;
    }

    get isHealthy() {
        return this._healthy;
    }

    start(healthCheckFn) {
        console.log('[HealthMonitor] Starting health checks...');
        this._lastHeartbeat = Date.now();
        this._healthy = true;

        this.bot.on('chat', () => { this._lastHeartbeat = Date.now(); });
        this.bot.on('move', () => { this._lastHeartbeat = Date.now(); });

        if (this.bot._client) {
            this.bot._client.on('keep_alive', () => { this._lastHeartbeat = Date.now(); });
        }

        this._interval = setInterval(() => {
            this._check(healthCheckFn);
        }, CONNECTION_CONFIG.healthCheckInterval);
    }

    stop() {
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

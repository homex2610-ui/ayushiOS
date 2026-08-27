import { createModel, selectAPI } from '../models/_model_map.js';

const HEALTH_CHECK_INTERVAL = 30000;
const MAX_CONSECUTIVE_FAILURES = 3;

export class HealthMonitor {
    constructor() {
        this.providers = new Map();
        this._interval = null;
    }

    registerProvider(name, modelString, url) {
        const profile = selectAPI({ model: modelString, url });
        const instance = createModel(profile);
        this.providers.set(name, {
            name,
            modelString,
            instance,
            healthy: true,
            consecutiveFailures: 0,
            lastCheck: 0,
            lastError: null,
        });
    }

    start() {
        this._interval = setInterval(() => this._checkAll(), HEALTH_CHECK_INTERVAL);
        this._checkAll();
    }

    stop() {
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
    }

    isHealthy(name) {
        const p = this.providers.get(name);
        return p ? p.healthy : false;
    }

    getStatus() {
        const result = {};
        for (const [name, p] of this.providers) {
            result[name] = {
                healthy: p.healthy,
                consecutiveFailures: p.consecutiveFailures,
                lastError: p.lastError?.substring(0, 100) || null,
                model: p.modelString,
            };
        }
        return result;
    }

    async _checkAll() {
        for (const [, p] of this.providers) {
            await this._checkOne(p);
        }
    }

    async _checkOne(p) {
        try {
            let ok = false;
            if (p.instance.health) {
                ok = await p.instance.health();
            } else {
                ok = await this._fallbackHealthCheck(p.instance, p.modelString);
            }
            if (ok) {
                p.consecutiveFailures = 0;
                if (!p.healthy) {
                    p.healthy = true;
                    p.lastError = null;
                    console.log(`[Health] ${p.name} is now healthy`);
                }
            } else {
                throw new Error('Health check returned false');
            }
        } catch (err) {
            p.consecutiveFailures++;
            p.lastError = err.message || String(err);
            if (p.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                if (p.healthy) {
                    console.warn(`[Health] ${p.name} marked UNHEALTHY after ${p.consecutiveFailures} failures: ${p.lastError}`);
                }
                p.healthy = false;
            }
        }
        p.lastCheck = Date.now();
    }

    async _fallbackHealthCheck(instance, modelString) {
        try {
            const url = instance.url;
            // Cloud SDK providers have no HTTP endpoint to probe — assuming
            // healthy beats pinging localhost and misflagging them.
            if (!url) return true;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            return res.ok;
        } catch {
            return false;
        }
    }
}

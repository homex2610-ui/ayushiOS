export class WarmupManager {
    constructor() {
        this._interval = null;
        this.warmups = new Map();
    }

    register(name, instance, options = {}) {
        const interval = options.interval || 60000;
        const prompt = options.prompt || 'ping';
        this.warmups.set(name, {
            instance,
            interval,
            prompt,
            lastWarmup: 0,
            healthy: true,
        });
    }

    start() {
        this._interval = setInterval(() => this._warmupAll(), 60000);
    }

    stop() {
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
    }

    async _warmupAll() {
        for (const [name, w] of this.warmups) {
            if (Date.now() - w.lastWarmup >= w.interval) {
                this._warmupOne(name, w);
            }
        }
    }

    async _warmupOne(name, w) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);
            const url = new URL('/health', w.instance.url || 'http://127.0.0.1:8080');
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timeoutId);
            if (res.ok) {
                w.lastWarmup = Date.now();
                if (!w.healthy) {
                    w.healthy = true;
                }
            }
        } catch {
            if (w.healthy) {
                w.healthy = false;
            }
        }
    }
}

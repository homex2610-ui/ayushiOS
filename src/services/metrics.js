export class MetricsCollector {
    constructor() {
        this.metrics = new Map();
    }

    _key(provider, model) {
        return `${provider}:${model || 'default'}`;
    }

    recordSuccess(provider, model, latencyMs) {
        const key = this._key(provider, model);
        if (!this.metrics.has(key)) {
            this.metrics.set(key, {
                requests: 0,
                successes: 0,
                failures: 0,
                totalLatency: 0,
                maxLatency: 0,
                minLatency: Infinity,
                lastLatency: 0,
                errors: {},
            });
        }
        const m = this.metrics.get(key);
        m.requests++;
        m.successes++;
        m.totalLatency += latencyMs;
        m.lastLatency = latencyMs;
        if (latencyMs > m.maxLatency) m.maxLatency = latencyMs;
        if (latencyMs < m.minLatency) m.minLatency = latencyMs;
    }

    recordFailure(provider, model, errorType) {
        const key = this._key(provider, model);
        if (!this.metrics.has(key)) {
            this.metrics.set(key, {
                requests: 0,
                successes: 0,
                failures: 0,
                totalLatency: 0,
                maxLatency: 0,
                minLatency: Infinity,
                lastLatency: 0,
                errors: {},
            });
        }
        const m = this.metrics.get(key);
        m.requests++;
        m.failures++;
        m.errors[errorType] = (m.errors[errorType] || 0) + 1;
    }

    getStats(provider, model) {
        const m = this.metrics.get(this._key(provider, model));
        if (!m) return null;
        return {
            requests: m.requests,
            successRate: m.requests > 0 ? (m.successes / m.requests * 100).toFixed(1) + '%' : '0%',
            avgLatency: m.successes > 0 ? (m.totalLatency / m.successes).toFixed(0) + 'ms' : 'N/A',
            maxLatency: m.maxLatency + 'ms',
            minLatency: m.minLatency === Infinity ? 'N/A' : m.minLatency + 'ms',
            lastLatency: m.lastLatency + 'ms',
            errors: m.errors,
        };
    }

    getAllStats() {
        const result = {};
        for (const [key, m] of this.metrics) {
            result[key] = {
                requests: m.requests,
                successRate: m.requests > 0 ? (m.successes / m.requests * 100).toFixed(1) + '%' : '0%',
                avgLatency: m.successes > 0 ? (m.totalLatency / m.successes).toFixed(0) + 'ms' : 'N/A',
                failures: m.failures,
                errors: m.errors,
            };
        }
        return result;
    }
}

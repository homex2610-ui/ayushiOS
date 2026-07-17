import { createModel, selectAPI } from '../models/_model_map.js';
import { HealthMonitor } from './health_monitor.js';

export class ProviderManager {
    constructor() {
        this.providers = [];
        this.healthMonitor = new HealthMonitor();
        this.fallbackChain = [];
    }

    addProvider(name, modelString, url, priority = 0, options = {}) {
        const profile = selectAPI({ model: modelString, url });
        const instance = createModel(profile);
        this.providers.push({
            name,
            api: profile.api,
            model: profile.model,
            instance,
            priority,
            enabled: true,
            ...options,
        });
        this.providers.sort((a, b) => b.priority - a.priority);
        this.healthMonitor.registerProvider(name, modelString, url);
    }

    setFallbackChain(chain) {
        this.fallbackChain = chain;
    }

    getPrimary() {
        return this.providers.find(p => p.enabled) || null;
    }

    getEnabled() {
        return this.providers.filter(p => p.enabled);
    }

    disableProvider(name) {
        const p = this.providers.find(p => p.name === name);
        if (p) p.enabled = false;
    }

    enableProvider(name) {
        const p = this.providers.find(p => p.name === name);
        if (p) p.enabled = true;
    }

    startHealthMonitor() {
        this.healthMonitor.start();
    }

    stopHealthMonitor() {
        this.healthMonitor.stop();
    }

    getStatus() {
        return {
            providers: this.providers.map(p => ({
                name: p.name,
                api: p.api,
                model: p.model,
                priority: p.priority,
                enabled: p.enabled,
            })),
            health: this.healthMonitor.getStatus(),
        };
    }
}

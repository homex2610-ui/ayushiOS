import { ModelRouter } from '../models/model_router.js';
import { ProviderManager } from './provider_manager.js';
import { HealthMonitor } from './health_monitor.js';
import { RequestQueue } from './request_queue.js';
import { WarmupManager } from './warmup_manager.js';
import { MetricsCollector } from './metrics.js';

export class AIService {
    constructor(config = {}) {
        this.providerManager = new ProviderManager();
        this.healthMonitor = new HealthMonitor();
        this.requestQueue = new RequestQueue({ maxConcurrent: config.maxConcurrent || 1 });
        this.warmupManager = new WarmupManager();
        this.metrics = new MetricsCollector();
        this.config = config;
        this.modelRouter = null;
        this._initialized = false;
    }

    async initialize(profileModels) {
        if (!profileModels || profileModels.length === 0) {
            console.warn('[AIService] No models provided, using ModelRouter directly');
            this.modelRouter = new ModelRouter(profileModels || []);
            return;
        }

        for (const modelEntry of profileModels) {
            const modelStr = typeof modelEntry === 'string' ? modelEntry : modelEntry.model;
            const priority = modelEntry.priority ?? (modelStr.startsWith('llamacpp') ? 100 : 50);
            const url = modelEntry.url || null;

            const api = modelStr.split('/')[0];
            const modelName = modelStr.split('/').slice(1).join('/');

            this.providerManager.addProvider(
                api,
                modelStr,
                url,
                priority,
                { modelName }
            );
        }

        this.providerManager.startHealthMonitor();
        this.warmupManager.start();

        this.modelRouter = new ModelRouter(profileModels);
        this._initialized = true;

        console.log(`[AIService] Initialized with ${profileModels.length} models (primary: ${profileModels[0]})`);
    }

    async sendRequest(turns, systemMessage) {
        return await this.modelRouter.sendRequest(turns, systemMessage);
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        return await this.modelRouter.sendVisionRequest(messages, systemMessage, imageBuffer);
    }

    async embed(text) {
        return this.modelRouter.embed(text);
    }

    getMetrics() {
        return this.metrics.getAllStats();
    }

    getStatus() {
        return {
            initialized: this._initialized,
            providerStatus: this.providerManager.getStatus(),
            metrics: this.metrics.getAllStats(),
            queueLength: this.requestQueue.pending,
            activeRequests: this.requestQueue.running,
        };
    }

    shutdown() {
        this.providerManager.stopHealthMonitor();
        this.warmupManager.stop();
        this._initialized = false;
    }
}

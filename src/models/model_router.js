import { selectAPI, createModel } from './_model_map.js';

const PROVIDER_CONFIG = {
    groq:       { cooldownBase: 60, errorKeywords: ['429', 'rate limit', 'too many requests'] },
    google:     { cooldownBase: 60, errorKeywords: ['429', '403', 'quota', 'rate limit', 'resource exhausted'] },
    deepseek:   { cooldownBase: 30, errorKeywords: ['429', 'rate limit', 'insufficient_quota'] },
    openai:     { cooldownBase: 30, errorKeywords: ['429', 'rate limit'] },
    anthropic:  { cooldownBase: 60, errorKeywords: ['429', 'rate limit', 'overloaded'] },
    openrouter: { cooldownBase: 60, errorKeywords: ['402', 'credits', 'insufficient', 'max_tokens'] },
    ollama:     { cooldownBase: 10, errorKeywords: ['connection refused', 'econnrefused', 'fetch failed'] },
    huggingface:{ cooldownBase: 30, errorKeywords: ['429', 'rate limit'] },
};

function getCooldown(api, failures) {
    const cfg = PROVIDER_CONFIG[api] || { cooldownBase: 30 };
    return Math.min(cfg.cooldownBase * (failures || 1), 120);
}

function matchesError(err, api) {
    const msg = (err?.message || String(err)).toLowerCase();
    const cfg = PROVIDER_CONFIG[api];
    if (!cfg) return true;
    return cfg.errorKeywords.some(k => msg.includes(k));
}

export class ModelRouter {
    constructor(modelProfiles) {
        this.models = modelProfiles.map(p => {
            const profile = typeof p === 'string' ? p : (p.model || p);
            const resolved = selectAPI(profile);
            const instance = createModel({ ...resolved });
            return {
                api: resolved.api,
                model: resolved.model || profile,
                instance,
                cooldownUntil: 0,
                failures: 0,
            };
        });
    }

    async sendRequest(turns, systemMessage) {
        const errors = [];
        for (const entry of this.models) {
            if (Date.now() < entry.cooldownUntil) {
                errors.push(`${entry.api}/${entry.model}: cooling down (${((entry.cooldownUntil - Date.now())/1000).toFixed(0)}s)`);
                continue;
            }
            try {
                const res = await entry.instance.sendRequest(turns, systemMessage);
                if (typeof res !== 'string') {
                    throw new Error(`Invalid response type: ${typeof res}`);
                }
                entry.failures = 0;
                return res;
            } catch (err) {
                entry.failures++;
                if (matchesError(err, entry.api)) {
                    const cd = getCooldown(entry.api, entry.failures);
                    entry.cooldownUntil = Date.now() + cd * 1000;
                    console.warn(`[Router] ${entry.api}/${entry.model} failed (${err.message}). Cooling ${cd}s.`);
                } else {
                    console.warn(`[Router] ${entry.api}/${entry.model} non-rate error: ${err.message}. Skipping.`);
                }
                errors.push(`${entry.api}/${entry.model}: ${err.message}`);
            }
        }
        throw new Error(`All models exhausted: ${errors.join(' | ')}`);
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        for (const entry of this.models) {
            if (Date.now() < entry.cooldownUntil) continue;
            if (!entry.instance.sendVisionRequest) continue;
            try {
                return await entry.instance.sendVisionRequest(messages, systemMessage, imageBuffer);
            } catch (err) {
                console.warn(`[Router] Vision ${entry.api}/${entry.model} failed: ${err.message}`);
            }
        }
        throw new Error('All models exhausted for vision request');
    }

    async embed(text) {
        for (const entry of this.models) {
            if (!entry.instance.embed) continue;
            try {
                return await entry.instance.embed(text);
            } catch (err) {
                console.warn(`[Router] Embed ${entry.api}/${entry.model} failed: ${err.message}`);
            }
        }
        throw new Error('No model available for embeddings');
    }
}

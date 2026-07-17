import { selectAPI, createModel } from './_model_map.js';

const PROVIDER_CONFIG = {
    groq:       { cooldownBase: 30, errorKeywords: ['429', 'rate limit', 'too many requests'] },
    google:     { cooldownBase: 30, errorKeywords: ['429', '403', 'quota', 'rate limit', 'resource exhausted'] },
    deepseek:   { cooldownBase: 15, errorKeywords: ['429', 'rate limit', 'insufficient_quota'] },
    openai:     { cooldownBase: 15, errorKeywords: ['429', 'rate limit'] },
    anthropic:  { cooldownBase: 30, errorKeywords: ['429', 'rate limit', 'overloaded'] },
    openrouter: { cooldownBase: 20, errorKeywords: ['402', 'credits', 'insufficient', 'max_tokens'] },
    ollama:     { cooldownBase: 5, errorKeywords: ['connection refused', 'econnrefused', 'fetch failed'] },
    huggingface:{ cooldownBase: 15, errorKeywords: ['429', 'rate limit'] },
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

const MAX_PERMANENT_FAILURES = 5;

export class ModelRouter {
    constructor(modelProfiles) {
        this.models = modelProfiles.map(p => {
            const profile = typeof p === 'string' ? p : (p.model || p);
            let resolved;
            try {
                resolved = selectAPI(profile);
            } catch (e) {
                console.warn(`[Router] Cannot resolve model "${profile}": ${e.message}. Disabling.`);
                return null;
            }
            const instance = createModel({ ...resolved });
            return {
                api: resolved.api,
                model: resolved.model || profile,
                instance,
                cooldownUntil: 0,
                failures: 0,
                permanentFail: false,
            };
        }).filter(Boolean);
        console.log(`[Router] Initialized with ${this.models.length} active models.`);
    }

    async sendRequest(turns, systemMessage) {
        const errors = [];
        for (const entry of this.models) {
            if (entry.permanentFail) {
                errors.push(`${entry.api}/${entry.model}: permanently disabled`);
                continue;
            }
            if (Date.now() < entry.cooldownUntil) {
                errors.push(`${entry.api}/${entry.model}: cooling (${((entry.cooldownUntil - Date.now())/1000).toFixed(0)}s)`);
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
                const isRateLimit = matchesError(err, entry.api);
                if (isRateLimit) {
                    const cd = getCooldown(entry.api, entry.failures);
                    entry.cooldownUntil = Date.now() + cd * 1000;
                    console.warn(`[Router] ${entry.api}/${entry.model} rate-limited (${err.message}). Cooling ${cd}s.`);
                } else {
                    console.warn(`[Router] ${entry.api}/${entry.model} error: ${err.message.substring(0, 80)}`);
                    if (entry.failures >= MAX_PERMANENT_FAILURES) {
                        entry.permanentFail = true;
                        console.warn(`[Router] ${entry.api}/${entry.model} permanently disabled after ${entry.failures} failures.`);
                    }
                }
                errors.push(`${entry.api}/${entry.model}: ${err.message.substring(0, 60)}`);
            }
        }
        throw new Error(`All models exhausted: ${errors.join(' | ')}`);
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const errors = [];
        for (const entry of this.models) {
            if (entry.permanentFail) {
                errors.push(`${entry.api}/${entry.model}: permanently disabled`);
                continue;
            }
            if (Date.now() < entry.cooldownUntil) {
                errors.push(`${entry.api}/${entry.model}: cooling`);
                continue;
            }
            if (!entry.instance.sendVisionRequest) continue;
            try {
                const res = await entry.instance.sendVisionRequest(messages, systemMessage, imageBuffer);
                entry.failures = 0;
                return res;
            } catch (err) {
                entry.failures++;
                const isRateLimit = matchesError(err, entry.api);
                if (isRateLimit) {
                    const cd = getCooldown(entry.api, entry.failures);
                    entry.cooldownUntil = Date.now() + cd * 1000;
                    console.warn(`[Router] Vision ${entry.api}/${entry.model} rate-limited. Cooling ${cd}s.`);
                } else {
                    console.warn(`[Router] Vision ${entry.api}/${entry.model} failed: ${err.message.substring(0, 80)}`);
                    if (entry.failures >= MAX_PERMANENT_FAILURES) {
                        entry.permanentFail = true;
                        console.warn(`[Router] Vision ${entry.api}/${entry.model} permanently disabled.`);
                    }
                }
                errors.push(`${entry.api}/${entry.model}: ${err.message.substring(0, 60)}`);
            }
        }
        throw new Error(`All models exhausted for vision request: ${errors.join(' | ')}`);
    }

    async embed(text) {
        const errors = [];
        for (const entry of this.models) {
            if (entry.permanentFail) {
                errors.push(`${entry.api}/${entry.model}: permanently disabled`);
                continue;
            }
            if (Date.now() < entry.cooldownUntil) {
                errors.push(`${entry.api}/${entry.model}: cooling`);
                continue;
            }
            if (!entry.instance.embed) continue;
            try {
                const res = await entry.instance.embed(text);
                entry.failures = 0;
                return res;
            } catch (err) {
                entry.failures++;
                const isRateLimit = matchesError(err, entry.api);
                if (isRateLimit) {
                    const cd = getCooldown(entry.api, entry.failures);
                    entry.cooldownUntil = Date.now() + cd * 1000;
                    console.warn(`[Router] Embed ${entry.api}/${entry.model} rate-limited. Cooling ${cd}s.`);
                } else {
                    console.warn(`[Router] Embed ${entry.api}/${entry.model} failed: ${err.message.substring(0, 80)}`);
                    if (entry.failures >= MAX_PERMANENT_FAILURES) {
                        entry.permanentFail = true;
                        console.warn(`[Router] Embed ${entry.api}/${entry.model} permanently disabled.`);
                    }
                }
                errors.push(`${entry.api}/${entry.model}: ${err.message.substring(0, 60)}`);
            }
        }
        throw new Error(`No model available for embeddings: ${errors.join(' | ')}`);
    }
}

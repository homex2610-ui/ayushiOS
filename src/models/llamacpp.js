import { strictFormat } from '../utils/text.js';

export class LlamaCpp {
    static prefix = 'llamacpp';

    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.url = url || 'http://127.0.0.1:8080';
        this.chat_endpoint = '/v1/chat/completions';
        this.embedding_endpoint = '/v1/embeddings';
    }

    async sendRequest(turns, systemMessage) {
        let model = this.model_name;
        let messages = strictFormat(turns);
        messages.unshift({ role: 'system', content: systemMessage });

        const maxAttempts = 2;
        let attempt = 0;
        let finalRes = null;

        while (attempt < maxAttempts) {
            attempt++;
            console.log(`[llama.cpp] Awaiting response... (model: ${model}, attempt: ${attempt})`);
            let res = null;
            try {
                let apiResponse = await this.send(this.chat_endpoint, {
                    model: model,
                    messages: messages,
                    stream: false,
                    ...(this.params || {})
                });
                if (apiResponse && apiResponse.choices && apiResponse.choices[0]) {
                    res = apiResponse.choices[0].message.content;
                } else {
                    throw new Error('llama.cpp returned no response. Is the server running?');
                }
            } catch (err) {
                if (err.message.toLowerCase().includes('context length') && turns.length > 1) {
                    console.log('[llama.cpp] Context length exceeded, retrying with shorter context.');
                    return await this.sendRequest(turns.slice(1), systemMessage);
                } else {
                    console.error('[llama.cpp] Request failed:', err.message);
                    throw err;
                }
            }

            const hasOpenTag = res.includes("<think>");
            const hasCloseTag = res.includes("</think>");

            if (hasOpenTag && !hasCloseTag) {
                console.warn('[llama.cpp] Partial <think> block detected. Re-generating...');
                if (attempt < maxAttempts) continue;
            }
            if (hasCloseTag && !hasOpenTag) {
                res = '<think>' + res;
            }
            if (hasOpenTag && hasCloseTag) {
                res = res.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            }
            finalRes = res;
            break;
        }

        if (finalRes == null) {
            console.warn('[llama.cpp] Could not get a valid response after max attempts.');
            throw new Error('llama.cpp failed after max attempts');
        }
        return finalRes;
    }

    async embed(text, timeoutMs = 10000) {
        const model = this.model_name;

        const body = {
            model,
            input: text
        };

        const res = await this.send(this.embedding_endpoint, body, timeoutMs);

        if (res?.data?.[0]?.embedding) {
            return res.data[0].embedding;
        }

        throw new Error('llama.cpp embedding API returned no embedding.');
    }

    async send(endpoint, body, timeoutMs = 180000) {
        const url = new URL(endpoint, this.url);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        let data = null;
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (res.ok) {
                data = await res.json();
            } else {
                const text = await res.text();
                throw new Error(`llama.cpp Status: ${res.status} - ${text.substring(0, 200)}`);
            }
        } catch (err) {
            clearTimeout(timeoutId);
            if (err.name === 'AbortError') {
                console.error(`[llama.cpp] Request timed out after ${timeoutMs/1000}s`);
            } else {
                console.error('[llama.cpp] Request failed:', err.message);
            }
        }
        return data;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "text", text: systemMessage },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                    }
                }
            ]
        });
        return this.sendRequest(imageMessages, systemMessage);
    }

    async health() {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            const res = await fetch(new URL('/health', this.url), { signal: controller.signal });
            clearTimeout(timeoutId);
            return res.ok;
        } catch {
            return false;
        }
    }
}

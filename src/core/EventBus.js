export class EventBus {
    constructor(bot) {
        this.bot = bot;
        this._handlers = new Map();
        this._botListeners = new Map();
        this._internalHandlers = new Map();
    }

    on(botEvent, handler, options = {}) {
        if (!this._handlers.has(botEvent)) {
            this._handlers.set(botEvent, new Set());
            this._wireBotEvent(botEvent);
        }
        this._handlers.get(botEvent).add({ fn: handler, filter: options.filter || null, once: false });
        return this;
    }

    once(botEvent, handler, options = {}) {
        if (!this._handlers.has(botEvent)) {
            this._handlers.set(botEvent, new Set());
            this._wireBotEvent(botEvent);
        }
        this._handlers.get(botEvent).add({ fn: handler, filter: options.filter || null, once: true });
        return this;
    }

    off(botEvent, handler) {
        const handlers = this._handlers.get(botEvent);
        if (!handlers) return this;
        for (const entry of handlers) {
            if (entry.fn === handler) {
                handlers.delete(entry);
                break;
            }
        }
        if (handlers.size === 0) {
            this._handlers.delete(botEvent);
            this._unwireBotEvent(botEvent);
        }
        return this;
    }

    removeAll(botEvent) {
        if (botEvent) {
            this._handlers.delete(botEvent);
            this._unwireBotEvent(botEvent);
        } else {
            for (const event of this._handlers.keys()) {
                this._unwireBotEvent(event);
            }
            this._handlers.clear();
        }
    }

    emit(event, ...args) {
        const handlers = this._internalHandlers.get(event);
        if (!handlers) return;
        for (const entry of handlers) {
            if (entry.filter && !entry.filter(...args)) continue;
            entry.fn(...args);
        }
    }

    onInternal(event, handler, options = {}) {
        if (!this._internalHandlers.has(event)) {
            this._internalHandlers.set(event, new Set());
        }
        this._internalHandlers.get(event).add({ fn: handler, filter: options.filter || null, once: false });
        return this;
    }

    offInternal(event, handler) {
        const handlers = this._internalHandlers.get(event);
        if (!handlers) return;
        for (const entry of handlers) {
            if (entry.fn === handler) {
                handlers.delete(entry);
                break;
            }
        }
        if (handlers.size === 0) this._internalHandlers.delete(event);
    }

    destroy() {
        this.removeAll();
        this._internalHandlers.clear();
    }

    _wireBotEvent(botEvent) {
        if (this._botListeners.has(botEvent)) return;
        const wrapped = (...args) => this._dispatch(botEvent, ...args);
        this._botListeners.set(botEvent, wrapped);
        if (botEvent === 'packet') {
            this.bot._client?.on('packet', wrapped);
        } else {
            this.bot.on(botEvent, wrapped);
        }
    }

    _unwireBotEvent(botEvent) {
        const wrapped = this._botListeners.get(botEvent);
        if (!wrapped) return;
        if (botEvent === 'packet') {
            this.bot._client?.removeListener('packet', wrapped);
        } else {
            this.bot.removeListener(botEvent, wrapped);
        }
        this._botListeners.delete(botEvent);
    }

    _dispatch(botEvent, ...args) {
        const handlers = this._handlers.get(botEvent);
        if (!handlers) return;
        const toRemove = [];
        for (const entry of handlers) {
            if (entry.filter && !entry.filter(...args)) continue;
            entry.fn(...args);
            if (entry.once) toRemove.push(entry);
        }
        for (const entry of toRemove) {
            handlers.delete(entry);
        }
        if (handlers.size === 0) {
            this._handlers.delete(botEvent);
            this._unwireBotEvent(botEvent);
        }
    }
}

export class RequestQueue {
    constructor(options = {}) {
        this.maxConcurrent = options.maxConcurrent || 1;
        this.queue = [];
        this.active = 0;
        this.processing = false;
    }

    enqueue(fn, priority = 0) {
        return new Promise((resolve, reject) => {
            this.queue.push({ fn, priority, resolve, reject, timestamp: Date.now() });
            this.queue.sort((a, b) => b.priority - a.priority || a.timestamp - b.timestamp);
            this._process();
        });
    }

    async _process() {
        if (this.processing) return;
        this.processing = true;

        while (this.queue.length > 0 && this.active < this.maxConcurrent) {
            const item = this.queue.shift();
            this.active++;
            item.fn()
                .then(result => item.resolve(result))
                .catch(err => item.reject(err))
                .finally(() => {
                    this.active--;
                    this._process();
                });
        }

        this.processing = false;
    }

    get pending() {
        return this.queue.length;
    }

    get running() {
        return this.active;
    }
}

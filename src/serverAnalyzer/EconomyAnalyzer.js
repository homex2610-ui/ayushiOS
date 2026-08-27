const CURRENCY_SYMBOLS = ['$', '€', '£', '¥', '✦', '✧', '✦', '❖', '◆', '◇', '●', '○', '★', '☆'];

export class EconomyAnalyzer {
    constructor(knowledgeBase, logger) {
        this.kb = knowledgeBase;
        this.log = logger || ((...a) => {});
        this._prices = {};
        this._transactions = [];
    }

    feed(message) {
        const patterns = [
            { re: /(?:sold|bought|purchased)\s+(?:\d+\s+)?(.+?)\s+(?:for|at)\s+\$?(\d+[.,]?\d*)/i, type: 'shop' },
            { re: /(?:bought|purchased)\s+(?:\d+\s+)?(.+?)\s+(?:for|at)\s+\$?(\d+[.,]?\d*)/i, type: 'buy' },
            { re: /(?:sold)\s+(?:\d+\s+)?(.+?)\s+(?:for|at)\s+\$?(\d+[.,]?\d*)/i, type: 'sell' },
            { re: /(?:paid|received|earned)\s+\$?(\d+[.,]?\d*)/i, type: 'transfer' },
            { re: /Balance[:\s]+\$?(\d+[.,]?\d*)/i, type: 'balance_check' },
        ];
        for (const p of patterns) {
            const m = message.match(p.re);
            if (m) {
                this.kb.set('economy.enabled', true);
                if (p.type === 'balance_check') {
                    const amt = parseFloat(m[1].replace(/,/g, ''));
                    if (!isNaN(amt)) this.kb.set('economy.lastBalance', amt);
                }
                if ((p.type === 'shop' || p.type === 'buy' || p.type === 'sell') && m[2]) {
                    const item = (m[1] || '').trim().toLowerCase();
                    const price = parseFloat(m[2].replace(/,/g, ''));
                    if (item && !isNaN(price)) {
                        if (!this._prices[item]) this._prices[item] = [];
                        this._prices[item].push({ price, type: p.type, ts: Date.now() });
                        if (this._prices[item].length > 10) this._prices[item].shift();
                    }
                }
                break;
            }
        }
        this._detectCurrency(message);
    }

    _detectCurrency(msg) {
        for (const sym of CURRENCY_SYMBOLS) {
            if (msg.includes(sym)) {
                const existing = this.kb.get('economy.symbols') || [];
                if (!existing.includes(sym)) {
                    existing.push(sym);
                    this.kb.set('economy.symbols', existing);
                }
                break;
            }
        }
        const currencyNames = [
            // Group 2 captures the currency word so `economy.currency` populates.
            { re: /(\d+[.,]?\d*)\s*((?:coins?|gold|dollars?|credits?|tokens?))/i, name: null },
        ];
        for (const cn of currencyNames) {
            const m = msg.match(cn.re);
            if (m) {
                if (m[2]) this.kb.merge('economy', { currency: m[2].toLowerCase() });
                this.kb.set('economy.enabled', true);
            }
        }
    }

    getAveragePrice(item) {
        const prices = this._prices[item.toLowerCase()];
        if (!prices || prices.length === 0) return null;
        const sum = prices.reduce((a, b) => a + b.price, 0);
        return sum / prices.length;
    }

    getEconomySummary() {
        const eco = this.kb.data.economy || {};
        return {
            enabled: eco.enabled || false,
            currency: eco.currency || 'unknown',
            symbols: eco.symbols || [],
            lastBalance: eco.lastBalance || null,
        };
    }
}

// NeuralNet.js
// ─────────────────────────────────────────────────────────────
// TINY CEREBRAL CORTEX — a small in-process neural network.
// Pure JS, zero dependencies, no API cost. Trains online from
// observed outcomes (self-supervision) and predicts near-term
// risk states so the executive can steer BEFORE damage happens,
// not after. Deliberately tiny (<1ms forward/backward pass) so
// it can never starve the event loop that feeds keep-alives.
// ─────────────────────────────────────────────────────────────

const clamp01 = (v) => Math.max(0, Math.min(1, v));

function tanh(v) { return Math.tanh(v); }
function sigmoid(v) { return 1 / (1 + Math.exp(-v)); }

class Layer {
  constructor(nIn, nOut) {
    this.nIn = nIn;
    this.nOut = nOut;
    // Xavier-ish init keeps activations sane from step one.
    const scale = Math.sqrt(2 / (nIn + nOut));
    this.w = Array.from({ length: nOut }, () =>
      Array.from({ length: nIn }, () => (Math.random() * 2 - 1) * scale));
    this.b = new Array(nOut).fill(0);
    // Grad accumulators (momentum-free SGD, batch = 1..N)
    this.gw = Array.from({ length: nOut }, () => new Array(nIn).fill(0));
    this.gb = new Array(nOut).fill(0);
  }

  forward(x, act) {
    this._in = x;
    this._z = new Array(this.nOut);
    this._a = new Array(this.nOut);
    for (let j = 0; j < this.nOut; j++) {
      let sum = this.b[j];
      const wj = this.w[j];
      for (let i = 0; i < this.nIn; i++) sum += wj[i] * x[i];
      this._z[j] = sum;
      this._a[j] = act(sum);
    }
    return this._a;
  }

  /** dAct: derivative evaluated on activation output. */
  backward(dA, dAct) {
    const dX = new Array(this.nIn).fill(0);
    for (let j = 0; j < this.nOut; j++) {
      const dZ = dA[j] * dAct(this._a[j]);
      this.gb[j] += dZ;
      const wj = this.w[j];
      const x = this._in;
      for (let i = 0; i < this.nIn; i++) {
        dX[i] += wj[i] * dZ;
        this.gw[j][i] += dZ * x[i];
      }
    }
    return dX;
  }

  apply(lr, batchSize) {
    const s = lr / batchSize;
    for (let j = 0; j < this.nOut; j++) {
      this.b[j] -= s * this.gb[j];
      const wj = this.w[j], gwj = this.gw[j];
      for (let i = 0; i < this.nIn; i++) {
        wj[i] -= s * gwj[i];
        gwj[i] = 0;
      }
      this.gb[j] = 0;
    }
  }

  toJSON() {
    return { nIn: this.nIn, nOut: this.nOut, w: this.w, b: this.b };
  }

  static fromJSON(d) {
    const l = new Layer(d.nIn, d.nOut);
    l.w = d.w.map(r => r.slice());
    l.b = d.b.slice();
    return l;
  }
}

export class TinyBrain {
  /**
   * @param {number[]} sizes e.g. [22, 16, 8, 3] — last layer uses sigmoid,
   *                         all hidden layers use tanh.
   */
  constructor(sizes) {
    if (!Array.isArray(sizes) || sizes.length < 2) throw new Error('TinyBrain needs [in,...,out]');
    this.sizes = sizes.slice();
    this.layers = [];
    for (let i = 0; i < sizes.length - 1; i++) this.layers.push(new Layer(sizes[i], sizes[i + 1]));
    this.trainSteps = 0;
  }

  get inputSize() { return this.sizes[0]; }
  get outputSize() { return this.sizes[this.sizes.length - 1]; }

  /** Forward pass → sigmoid outputs in [0,1]. */
  predict(x) {
    if (x.length !== this.inputSize) throw new Error(`input ${x.length} != ${this.inputSize}`);
    let a = x;
    for (let i = 0; i < this.layers.length; i++) {
      a = this.layers[i].forward(a, i === this.layers.length - 1 ? sigmoid : tanh);
    }
    return a.slice();
  }

  /**
   * One SGD step over a mini-batch of {x, y} samples.
   * Output loss: binary cross-entropy (sigmoid-friendly).
   * Returns mean loss for logging.
   */
  trainBatch(batch, lr = 0.03) {
    if (!batch.length) return 0;
    let totalLoss = 0;
    for (const { x, y } of batch) {
      const out = this.predict(x);
      const last = this.layers.length - 1;
      // dLoss/dZ for sigmoid+BCE collapses to (p - t)
      let dA = out.map((p, k) => p - (y[k] ?? 0));
      for (let k = 0; k < out.length; k++) {
        const t = y[k] ?? 0;
        const p = clamp01(Math.max(out[k], 1e-7));
        totalLoss -= t * Math.log(p) + (1 - t) * Math.log(1 - p);
      }
      for (let i = last; i >= 0; i--) {
        const layer = this.layers[i];
        dA = i === last
          ? layer.backward(dA, () => 1) // sigmoid': absorbed into delta
          : layer.backward(dA, (a) => 1 - a * a); // tanh'
      }
    }
    for (const layer of this.layers) layer.apply(lr, batch.length);
    this.trainSteps++;
    return totalLoss / batch.length;
  }

  toJSON() {
    return {
      version: 1,
      sizes: this.sizes,
      trainSteps: this.trainSteps,
      layers: this.layers.map(l => l.toJSON()),
    };
  }

  static fromJSON(d) {
    if (!d || !Array.isArray(d.sizes)) throw new Error('bad TinyBrain payload');
    const brain = new TinyBrain(d.sizes);
    if (brain.layers.length !== (d.layers?.length ?? -1)) throw new Error('layer count mismatch');
    brain.layers = d.layers.map(l => Layer.fromJSON(l));
    brain.trainSteps = d.trainSteps || 0;
    return brain;
  }
}

// ─── Action-Outcome Memory ────────────────────────────────────
// Tracks which actions succeed/fail in which environmental contexts.
// Context = quantized feature snapshot; Action = task name;
// Outcome = running success rate with decay. consulted by the
// executive to boost proven actions and damp failing ones in
// similar situations — the bot learns from experience, not just
// raw sensor predictions.
// ──────────────────────────────────────────────────────────────

const ACTION_MEMORY_CAP = 500;
const ACTION_MEMORY_DECAY = 0.98;     // per-hour decay toward neutral
const ACTION_CONTEXT_BINS = 4;        // quantize each feature into N bins

export class ActionMemory {
  constructor() {
    /** @type {Map<string, {success: number, attempts: number, lastSeen: number}>} */
    this.entries = new Map();
  }

  /**
   * Quantize a feature vector into a compact context key.
   * Bins each feature into ACTION_CONTEXT_BINS buckets → string key.
   */
  _contextKey(features) {
    const step = 1 / ACTION_CONTEXT_BINS;
    let key = '';
    for (let i = 0; i < features.length; i++) {
      const bin = Math.min(ACTION_CONTEXT_BINS - 1, Math.floor(features[i] / step));
      key += bin;
    }
    return key;
  }

  /**
   * Record an action outcome.
   * @param {number[]} features - sensor snapshot at time of action
   * @param {string} action - task/goal name
   * @param {number} outcome - 1 = success, 0 = failure, 0.5 = neutral
   */
  record(features, action, outcome) {
    const ctx = this._contextKey(features);
    const key = `${ctx}:${action}`;
    const existing = this.entries.get(key);
    if (existing) {
      existing.success = existing.success * 0.9 + outcome * 0.1; // EMA
      existing.attempts++;
      existing.lastSeen = Date.now();
    } else {
      this.entries.set(key, { success: outcome, attempts: 1, lastSeen: Date.now() });
    }
    // Cap entries
    if (this.entries.size > ACTION_MEMORY_CAP) {
      const oldest = [...this.entries.entries()]
        .sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
  }

  /**
   * Query the success rate for an action in a given context.
   * Returns 0.5 (neutral) if no data.
   */
  query(features, action) {
    const ctx = this._contextKey(features);
    const key = `${ctx}:${action}`;
    const e = this.entries.get(key);
    if (!e || e.attempts < 2) return 0.5; // not enough data
    return e.success;
  }

  /**
   * Get a boost/penalty for an action based on context.
   * Returns [-0.15, +0.15] range.
   */
  adjustment(features, action) {
    const rate = this.query(features, action);
    return (rate - 0.5) * 0.3; // 0.0 success → -0.15; 1.0 → +0.15
  }

  /** Decay all entries toward neutral (simulates forgetting stale data). */
  decay() {
    const now = Date.now();
    for (const [k, e] of this.entries) {
      const hoursSince = (now - e.lastSeen) / 3600000;
      if (hoursSince > 24) { this.entries.delete(k); continue; }
      e.success = 0.5 + (e.success - 0.5) * Math.pow(ACTION_MEMORY_DECAY, hoursSince);
    }
  }

  toJSON() {
    return [...this.entries.entries()].map(([k, v]) => [k, v]);
  }

  static fromJSON(data) {
    const m = new ActionMemory();
    if (Array.isArray(data)) {
      for (const [k, v] of data) m.entries.set(k, v);
    }
    return m;
  }
}

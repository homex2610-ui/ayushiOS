// QuantumMind.js
// ─────────────────────────────────────────────────────────────
// QUANTUM-COGNITION ARBITER — quantum-INSPIRED math on classical
// hardware. Not mysticism: each need is a complex amplitude; the
// Born rule (p = |ψ|²) turns amplitudes into choice probabilities;
// phase dynamics create constructive/destructive interference so
// goals reinforce or cancel each other the way ambivalent humans
// actually decide (Busemeyer & Bruza, "Quantum Models of Cognition
// and Decision"). Classical probability cannot represent cancellation
// — amplitudes can. That is the whole point.
//
//   • amplitude  ψᵢ = re + im·i,  |ψᵢ|² → choice probability
//   • phase θᵢ rotates with urgency (high need = high angular velocity)
//   • interference: coherent needs amplify, opposed needs cancel
//   • outcome feedback: success adds along phase, failure subtracts
//   • annealing temperature mixes in exploration, decays over time
//   • tunneling: rare temperature² jumps to low-probability needs
//   • von Neumann entropy gates hysteresis (indecisive → stay course)
// ─────────────────────────────────────────────────────────────

const TAU = Math.PI * 2;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** |ψ|² for a complex amplitude kept as {re, im}. */
const prob = (amp) => amp.re * amp.re + amp.im * amp.im;

export class QuantumMind {
  /**
   * @param {string[]} needNames — the basis states of the decision space
   * @param {object} [opts]
   */
  constructor(needNames, opts = {}) {
    this.needs = needNames.slice();
    // One complex amplitude per basis state. Start uniform superposition.
    const mag0 = Math.sqrt(1 / Math.max(1, this.needs.length));
    this.psi = new Map(this.needs.map(n => [n, { re: mag0, im: 0 }]));
    this.phase = new Map(this.needs.map(n => [n, Math.random() * TAU]));

    // Tuning (all bounded, all deterministic given the sample seed)
    this.interferenceK = opts.interferenceK ?? 0.15;  // pairwise coherence strength
    this.outcomeGain = opts.outcomeGain ?? 0.12;      // success/failure kick
    this.phaseVelocity = opts.phaseVelocity ?? 0.6;   // rad per decision cycle at full urgency
    this.tempDecay = opts.tempDecay ?? 0.97;          // annealing schedule
    this.tempFloor = opts.tempFloor ?? 0.08;
    this.hysteresisMax = opts.hysteresisMax ?? 1.0;   // entropy-gated stickiness (floor = uniform × (1+max))
    this.entropyHigh = opts.entropyHigh ?? 1.45;      // ln(K) for K needs ≈ max entropy

    this.temperature = 1.0;
    this.decisions = 0;
    this.lastWinner = null;
    this.lastVia = null;
    this.lastEntropy = 0;
  }

  /** Rotate phase by urgency-driven angular velocity; evolve magnitudes toward √utility. */
  _evolve(utilities) {
    for (const need of this.needs) {
      const u = clamp01(utilities.get(need) ?? 0);
      // Schrödinger-flavored drift: phase precesses faster under high urgency.
      const omega = this.phaseVelocity * (0.2 + u);
      this.phase.set(need, (this.phase.get(need) + omega) % TAU);
      // Magnitude target √u (Born-rule-ready), eased to avoid discontinuities.
      const target = Math.sqrt(u);
      const amp = this.psi.get(need);
      const mag = Math.sqrt(prob(amp));
      const next = mag + (target - mag) * 0.5;
      amp.re = next * Math.cos(this.phase.get(need));
      amp.im = next * Math.sin(this.phase.get(need));
    }
  }

  /** Pairwise interference: coherent phases amplify, opposed phases cancel.
   *  Shift is clamped so interference can never crush a need past recovery. */
  _interfere() {
    const kappa = this.interferenceK;
    for (const a of this.needs) {
      let shift = 0;
      for (const b of this.needs) {
        if (a === b) continue;
        const wB = Math.sqrt(prob(this.psi.get(b)));
        if (wB < 1e-6) continue;
        // cos of phase difference: +1 constructive, −1 destructive
        shift += kappa * wB * Math.cos(this.phase.get(a) - this.phase.get(b));
      }
      shift = Math.max(-0.5, Math.min(0.5, shift));
      const amp = this.psi.get(a);
      const mag = Math.max(0, Math.sqrt(prob(amp)) * (1 + shift));
      amp.re = mag * Math.cos(this.phase.get(a));
      amp.im = mag * Math.sin(this.phase.get(a));
    }
  }

  /**
   * Outcome feedback — the learning channel.
   * @param {string} need
   * @param {number} outcome +1 success (constructive kick), −1 failure (destructive)
   */
  observe(need, outcome) {
    if (!this.psi.has(need)) return;
    const amp = this.psi.get(need);
    const kick = this.outcomeGain * (outcome >= 0 ? 1 : -1);
    const theta = this.phase.get(need);
    amp.re += kick * Math.cos(theta);
    amp.im += kick * Math.sin(theta);
    // Failure also spins the phase — a punished state stops aligning with itself.
    if (outcome < 0) this.phase.set(need, (theta + Math.PI * 0.25) % TAU);
  }

  /** Born rule → probability distribution over needs. */
  _born() {
    const probs = new Map();
    let z = 0;
    for (const need of this.needs) {
      const p = prob(this.psi.get(need));
      probs.set(need, p);
      z += p;
    }
    if (z <= 1e-9) {
      // Fully cancelled state — uniform fallback (never NaN).
      for (const need of this.needs) probs.set(need, 1 / this.needs.length);
      return probs;
    }
    for (const need of this.needs) probs.set(need, probs.get(need) / z);
    return probs;
  }

  /** Von Neumann entropy H = −Σ p ln p (nats). */
  _entropy(probs) {
    let h = 0;
    for (const p of probs.values()) if (p > 1e-12) h -= p * Math.log(p);
    return h;
  }

  /**
   * Pick the winning need.
   * @param {Array<{need: string, score: number}>} scored — utility scores from ExecutiveBrain
   * @param {string} currentNeed — goal we're currently on (hysteresis anchor)
   * @returns {{need: string, via: string}} winner + why (born|tunnel)
   */
  arbitrate(scored, currentNeed = null) {
    this.decisions++;
    const utilities = new Map(scored.map(s => [s.need, Math.max(0, s.score)]));
    this._evolve(utilities);
    this._interfere();
    const bornProbs = this._born();

    // Entropy from the Born distribution determines hysteresis strength.
    const entropy = this._entropy(bornProbs);
    this.lastEntropy = entropy;

    // Annealing: blend Born probs toward uniform by temperature, then cool.
    const temp = this.temperature;
    this.temperature = Math.max(this.tempFloor, this.temperature * this.tempDecay);
    const probs = new Map();
    for (const [need, p] of bornProbs) {
      probs.set(need, p * (1 - temp) + temp / this.needs.length);
    }

    // Tunneling: rare temperature² jump to ANY viable need —
    // escapes local optima greedy argmax gets stuck in.
    const viable = scored.filter(s => s.score > 0.01);
    if (viable.length > 0 && Math.random() < temp * temp * 0.15) {
      const pick = viable[Math.floor(Math.random() * viable.length)];
      this.lastWinner = pick.need;
      this.lastVia = 'tunnel';
      return { need: pick.need, via: 'tunnel' };
    }

    // Entropy-gated hysteresis AFTER annealing: the closer the state is to
    // maximal entropy (total indecision), the harder we bias toward
    // continuing the current goal. Floor semantics guarantee the current
    // goal is ≥ uniform × (1 + stick), so phase-noise can't suppress it
    // below "deliberately continuing" — and annealing can't erase it.
    if (currentNeed && probs.has(currentNeed)) {
      const ratio = entropy / Math.log(Math.max(2, this.needs.length)); // 0..1
      const stick = this.hysteresisMax * clamp01((ratio - 0.45) / 0.55);
      const uniform = 1 / this.needs.length;
      const floor = uniform * (1 + stick);
      if (probs.get(currentNeed) < floor) {
        probs.set(currentNeed, floor);
        let z = 0;
        for (const p of probs.values()) z += p;
        for (const [k, p] of probs) probs.set(k, p / z);
      }
    }

    let r = Math.random();
    let winner = this.needs[0];
    for (const [need, p] of probs) {
      r -= p;
      if (r <= 0) { winner = need; break; }
      winner = need;
    }
    this.lastWinner = winner;
    this.lastVia = 'born';
    return { need: winner, via: 'born' };
  }

  /** Snapshot for dashboards/traces. */
  describe() {
    const probs = this._born();
    return {
      temperature: +this.temperature.toFixed(3),
      entropy: +this.lastEntropy.toFixed(3),
      decisions: this.decisions,
      via: this.lastVia,
      need: this.lastWinner,
      amplitudes: Object.fromEntries(this.needs.map(n => {
        const a = this.psi.get(n);
        return [n, +Math.sqrt(prob(a)).toFixed(3)];
      })),
      probs: Object.fromEntries([...probs.entries()].map(([n, p]) => [n, +p.toFixed(3)])),
    };
  }
}

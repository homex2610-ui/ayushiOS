// EventBus.js
// ─────────────────────────────────────────────────────────────
// THE CORPUS CALLOSUM
// In a real brain, regions don't call each other's functions
// directly — they fire signals across neural pathways and let
// whoever's listening react. This bus is that pathway. It lets
// SensoryCortex, MemoryMatrix, SpinalCord, ExecutiveBrain, etc.
// stay decoupled: none of them need a reference to the others,
// only to the bus.
// ─────────────────────────────────────────────────────────────

export class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(signal, handler) {
    if (!this.listeners.has(signal)) this.listeners.set(signal, []);
    this.listeners.get(signal).push(handler);
    return () => this.off(signal, handler); // returns an unsubscribe fn
  }

  off(signal, handler) {
    const arr = this.listeners.get(signal);
    if (!arr) return;
    this.listeners.set(signal, arr.filter(h => h !== handler));
  }

  emit(signal, payload) {
    const arr = this.listeners.get(signal);
    if (!arr || arr.length === 0) return;
    for (const handler of arr) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[EventBus] Handler for "${signal}" threw:`, err);
      }
    }
  }
}

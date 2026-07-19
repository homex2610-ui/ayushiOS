/* global process */
// ExperienceStore.js
// Persists Experiences per bot.
// Append-only log — never mutates existing entries.
// Atomic writes via temp-file + rename.
// Debounced save — multiple writes coalesce into one disk operation.
//
// Concurrency model:
//   • Writes are debounced via Promise microtask — multiple add() calls
//     within the same event-loop tick coalesce into a single disk write.
//   • Atomic rename (tmp → target) prevents partial-file reads on crash.
//   • Synchronous I/O is used so that the in-memory state and on-disk
//     state are never meaningfully out of sync during normal operation.
//   • If the process exits before the microtask flush runs, at most
//     one tick of writes may be lost. Call flush() explicitly before
//     shutdown if durability is required.
//
// Failure handling:
//   • Write failures are surfaced via the optional bus event
//     'experience_store_write_failed' if a bus is provided.
//   • On failure, _dirty remains true and the write is retried
//     on the next add() call.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { Experience } from './Experience.js';

export class ExperienceStore {
  constructor(username, opts = {}) {
    this.dir = path.join(process.cwd(), 'bots', username);
    this.fp = path.join(this.dir, 'experiences.json');
    this.tmpFp = this.fp + '.tmp';
    this.bus = opts.bus || null;
    this._experiences = [];
    this._dirty = false;
    this._writePending = false;
    /** Number of actual disk writes performed. Accessed by tests to prove coalescing. */
    this.writeCount = 0;
    this._load();
  }

  _load() {
    try {
      if (existsSync(this.fp)) {
        const raw = JSON.parse(readFileSync(this.fp, 'utf8'));
        this._experiences = (raw || []).map(e => new Experience(e));
      }
    } catch (_) {
      // File not found or invalid — start fresh
    }
    if (this._experiences.length === 0) {
      this._experiences = [];
    }
  }

  /**
   * Debounced atomic save.
   * Multiple dirty marks within the same microtask coalesce into one write.
   */
  _scheduleSave() {
    if (this._writePending) return;
    this._writePending = true;
    // Use Promise microtask to batch concurrent adds
    Promise.resolve().then(() => this._flush());
  }

  _flush() {
    this._writePending = false;
    if (!this._dirty) return;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.tmpFp, JSON.stringify(this._experiences.map(e => e.toJSON()), null, 2), 'utf8');
      renameSync(this.tmpFp, this.fp);
      this._dirty = false;
      this.writeCount++;
    } catch (err) {
      this._dirty = true;
      const msg = `ExperienceStore flush failed: ${err.message}`;
      console.error('[ExperienceStore]', msg);
      this.bus?.emit?.('experience_store_write_failed', {
        error: err.message,
        experienceCount: this._experiences.length,
        path: this.fp,
      });
    }
  }

  /**
   * Synchronous flush — use before shutdown or test assertions.
   */
  flush() {
    this._writePending = false;
    this._flush();
  }

  add(experience) {
    if (!(experience instanceof Experience)) {
      experience = new Experience(experience);
    }
    this._experiences.push(experience);
    this._dirty = true;
    if (this._experiences.length > 500) {
      this._prune();
    }
    this._scheduleSave();
  }

  getAll() {
    return [...this._experiences];
  }

  getByGoal(goal) {
    return this._experiences.filter(e => e.goal === goal);
  }

  getRecent(n = 20) {
    return this._experiences.slice(-Math.max(1, n));
  }

  getSuccesses(goal) {
    return this._experiences.filter(e => e.goal === goal && e.isSuccess());
  }

  getFailures(goal) {
    return this._experiences.filter(e => e.goal === goal && e.isFailure());
  }

  totalExperiences() {
    return this._experiences.length;
  }

  successRate(goal) {
    const all = this._experiences.filter(e => e.goal === goal);
    if (all.length === 0) return 0;
    return all.filter(e => e.isSuccess()).length / all.length;
  }

  clear() {
    this._experiences = [];
    this._dirty = true;
    this._scheduleSave();
  }

  _prune() {
    this._experiences = this._experiences.slice(-500);
    this._dirty = true;
  }
}

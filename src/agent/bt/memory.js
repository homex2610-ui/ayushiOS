import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';

export class BTMemory {
    constructor(name) {
        this.path = `./bots/${name}/bt_memory.json`;
        this.data = {
            trustedPlayers: [],
            hostilePlayers: [],
            bases: [],
            caches: [],
            dangerZones: [],
            goalStack: [],
            pendingCommand: null,
            lastUpdated: 0,
            claimedAreas: [],
            commandLog: {},
            serverFlags: {},
        };
        this.load();
    }

    load() {
        if (existsSync(this.path)) {
            try {
                const raw = readFileSync(this.path, 'utf8');
                const loaded = JSON.parse(raw);
                Object.assign(this.data, loaded);
                console.log(`[BTMemory] Loaded from ${this.path}`);
            } catch (err) {
                console.warn(`[BTMemory] Failed to load ${this.path}: ${err.message}`);
            }
        } else {
            console.log(`[BTMemory] No existing memory at ${this.path}, starting fresh`);
        }
    }

    save() {
        try {
            this.data.lastUpdated = Date.now();
            const dir = path.dirname(this.path);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(this.path, JSON.stringify(this.data, null, 2));
        } catch (err) {
            console.warn(`[BTMemory] Failed to save: ${err.message}`);
        }
    }

    addBase(name, pos) {
        const existing = this.data.bases.find(b => b.name === name);
        if (existing) {
            existing.pos = pos;
        } else {
            this.data.bases.push({ name, pos });
        }
        this.save();
    }

    addCache(type, pos) {
        this.data.caches.push({ type, pos, created: Date.now() });
        this.save();
    }

    addDangerZone(pos, reason) {
        this.data.dangerZones.push({ pos, reason, added: Date.now() });
        this.save();
    }

    addTrustedPlayer(name) {
        if (!this.data.trustedPlayers.includes(name)) {
            this.data.trustedPlayers.push(name);
            this.save();
        }
    }

    addHostilePlayer(name) {
        if (!this.data.hostilePlayers.includes(name)) {
            this.data.hostilePlayers.push(name);
            this.save();
        }
    }

    setGoalStack(stack) {
        this.data.goalStack = stack;
        this.save();
    }

    setPendingCommand(cmd) {
        this.data.pendingCommand = cmd;
        this.save();
    }

    isTrusted(name) {
        return this.data.trustedPlayers.includes(name);
    }

    isHostile(name) {
        return this.data.hostilePlayers.includes(name);
    }

    nearestBase(pos) {
        if (!this.data.bases.length) return null;
        return this.data.bases.reduce((a, b) => {
            const da = distance(a.pos, pos);
            const db = distance(b.pos, pos);
            return da < db ? a : b;
        });
    }

    getGoalStack() {
        return this.data.goalStack || [];
    }

    addClaimedArea(pos, reason) {
        const DEDUPE_RADIUS = 8;
        const already = this.data.claimedAreas.some(c => {
            const dx = c.pos.x - pos.x;
            const dy = c.pos.y - pos.y;
            const dz = c.pos.z - pos.z;
            return Math.sqrt(dx * dx + dy * dy + dz * dz) <= DEDUPE_RADIUS;
        });
        if (already) return;
        this.data.claimedAreas.push({ pos, reason, added: Date.now() });
        this.save();
    }

    recordCommandResult(commandString, success, reason) {
        const entry = this.data.commandLog[commandString] || { success: 0, failure: 0 };
        if (success) {
            entry.success = (entry.success || 0) + 1;
        } else {
            entry.failure = (entry.failure || 0) + 1;
            entry.lastReason = reason || null;
        }
        entry.lastTried = Date.now();
        this.data.commandLog[commandString] = entry;
        this.save();
    }

    hasCommandFailedRecently(commandString, ttlMs) {
        const entry = this.data.commandLog[commandString];
        if (!entry || !entry.lastTried) return false;
        const failedMore = (entry.failure || 0) > 0
            && entry.lastReason != null
            && (entry.success || 0) === 0;
        return failedMore && (Date.now() - entry.lastTried) < ttlMs;
    }

    setServerFlag(key, value) {
        this.data.serverFlags[key] = value;
        this.save();
    }

    getServerFlag(key) {
        return this.data.serverFlags[key];
    }
}

function distance(a, b) {
    const ax = a.x ?? a[0] ?? 0;
    const ay = a.y ?? a[1] ?? 0;
    const az = a.z ?? a[2] ?? 0;
    const bx = b.x ?? b[0] ?? 0;
    const by = b.y ?? b[1] ?? 0;
    const bz = b.z ?? b[2] ?? 0;
    const dx = ax - bx;
    const dy = ay - by;
    const dz = az - bz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// fabric_scan.js
// ─────────────────────────────────────────────────────────────
// Scans the real Fabric instance's mods folder and reads each
// jar's fabric.mod.json to get EXACT {id, version} pairs.
//
// WHY: hardcoding the manifest broke the moment the host client
// updated (new fabric-language-kotlin, fastclient-hud bump) —
// Fabric's registry sync compares declared packs against what the
// integrated server loaded, and any drift gets you kicked with
// "this server requires fabric api installed on your client".
// Scanning the jars keeps the declaration permanently in lockstep.
//
// No dependencies: fabric.mod.json lives inside a ZIP, so we walk
// the zip central directory ourselves and inflateRaw the entry
// (zlib is built-in). Cached by mods-dir mtime.
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const DEFAULT_MODS_DIR = path.join(process.env.APPDATA || '', '.fastclient', 'profiles', 'updesh', 'mods');

function findFabricModJson(buf) {
    // Walk the End of Central Directory record backwards for its signature
    const EOCD = 0x06054b50;
    let eocd = -1;
    const minEocd = Math.max(0, buf.length - 66000);
    for (let i = buf.length - 22; i >= minEocd; i--) {
        if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('no zip EOCD');
    const entryCount = buf.readUInt16LE(eocd + 10);
    let ptr = buf.readUInt32LE(eocd + 16); // central directory offset

    for (let n = 0; n < entryCount; n++) {
        if (buf.readUInt32LE(ptr) !== 0x02014b50) break; // central file header
        const method = buf.readUInt16LE(ptr + 10);
        const compSize = buf.readUInt32LE(ptr + 20);
        const nameLen = buf.readUInt16LE(ptr + 28);
        const extraLen = buf.readUInt16LE(ptr + 30);
        const commentLen = buf.readUInt16LE(ptr + 32);
        const localOff = buf.readUInt32LE(ptr + 42);
        const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
        if (name === 'fabric.mod.json') {
            // Local file header at localOff: skip 30 bytes + name + extra
            const lNameLen = buf.readUInt16LE(localOff + 26);
            const lExtraLen = buf.readUInt16LE(localOff + 28);
            const dataStart = localOff + 30 + lNameLen + lExtraLen;
            const raw = buf.subarray(dataStart, dataStart + compSize);
            const jsonBytes = method === 0 ? raw : zlib.inflateRawSync(raw);
            return JSON.parse(jsonBytes.toString('utf8'));
        }
        ptr += 46 + nameLen + extraLen + commentLen;
    }
    return null;
}

// Nested-jar aware: fabric-api is an UMBRELLA — its real networked modules
// (fabric-registry-sync-v0, fabric-networking-api-v1, …) are nested jars
// under META-INF/jars/ with their OWN mod ids. FastClient's stage-2 check
// verifies those module ids, so they must be declared too.
function findNestedModIds(buf, logger) {
    const ids = [];
    try {
        const EOCD = 0x06054b50;
        let eocd = -1;
        const minEocd = Math.max(0, buf.length - 66000);
        for (let i = buf.length - 22; i >= minEocd; i--) {
            if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
        }
        if (eocd < 0) return ids;
        const entryCount = buf.readUInt16LE(eocd + 10);
        let ptr = buf.readUInt32LE(eocd + 16);
        for (let n = 0; n < entryCount; n++) {
            if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
            const method = buf.readUInt16LE(ptr + 10);
            const compSize = buf.readUInt32LE(ptr + 20);
            const nameLen = buf.readUInt16LE(ptr + 28);
            const extraLen = buf.readUInt16LE(ptr + 30);
            const commentLen = buf.readUInt16LE(ptr + 32);
            const localOff = buf.readUInt32LE(ptr + 42);
            const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
            ptr += 46 + nameLen + extraLen + commentLen;
            if (!/^META-INF\/jars\/[^/]+\.jar$/.test(name)) continue;
            // Extract nested jar bytes from its local header
            const lNameLen2 = buf.readUInt16LE(localOff + 26);
            const lExtraLen2 = buf.readUInt16LE(localOff + 28);
            const dataStart2 = localOff + 30 + lNameLen2 + lExtraLen2;
            let nestedBuf;
            try {
                nestedBuf = method === 0
                    ? buf.subarray(dataStart2, dataStart2 + compSize)
                    : zlib.inflateRawSync(buf.subarray(dataStart2, dataStart2 + compSize));
            } catch (_) { continue; }
            const nestedMeta = findFabricModJson(nestedBuf);
            if (nestedMeta?.id && nestedMeta?.version) {
                ids.push({ namespace: 'fabric', id: nestedMeta.id, version: String(nestedMeta.version) });
            }
        }
    } catch (e) {
        logger?.log?.(`[FabricScan] nested scan error: ${e.message}`);
    }
    return ids;
}

/**
 * Scan the mods dir → [{namespace:'fabric', id, version}, ...]
 * Only client-side-relevant entries matter for declaration; we simply
 * declare everything the instance ships, exactly like the real client.
 */
export function scanFabricMods(modsDir = DEFAULT_MODS_DIR, logger = console) {
    const out = [];
    let files = [];
    try {
        files = fs.readdirSync(modsDir).filter(f => f.toLowerCase().endsWith('.jar'));
    } catch (e) {
        logger.log?.(`[FabricScan] cannot read ${modsDir}: ${e.message}`);
        return out;
    }
    for (const f of files) {
        const full = path.join(modsDir, f);
        try {
            // Skip obvious sources/javadoc artifacts
            if (/-sources\.jar$/i.test(f)) continue;
            const buf = fs.readFileSync(full);
            const meta = findFabricModJson(buf);
            if (!meta || !meta.id || !meta.version) {
                logger.log?.(`[FabricScan] ${f}: no fabric.mod.json — skipping`);
                continue;
            }
            out.push({ namespace: 'fabric', id: meta.id, version: String(meta.version) });
            // UMBRELLA EXPANSION: pull nested module jars (fabric-api ships
            // ~30 networked modules as META-INF/jars/* with own mod ids)
            out.push(...findNestedModIds(buf, logger));
        } catch (e) {
            logger.log?.(`[FabricScan] ${f}: ${e.message} — skipping`);
        }
    }
    return out;
}

/** Cached scan keyed by directory mtime (jars change ⇒ rescan). */
let _cache = { sig: null, packs: null };

export function getFabricPackList(logger = console) {
    let sig = null;
    try { sig = fs.statSync(DEFAULT_MODS_DIR).mtimeMs; } catch (_) {}
    if (_cache.packs && _cache.sig === sig) return _cache.packs;

    const scanned = scanFabricMods(DEFAULT_MODS_DIR, logger);

    // Loader version: best-effort from libraries dir, else last-known-good
    let loaderVersion = '0.19.3';
    try {
        const libRoot = path.join(process.env.APPDATA || '', '.fastclient', 'libraries', 'net', 'fabricmc', 'fabric-loader');
        const vers = fs.readdirSync(libRoot).filter(d => /^\d+\.\d+/.test(d)).sort().reverse();
        if (vers[0]) loaderVersion = vers[0];
    } catch (_) {}

    const packs = [
        { namespace: 'minecraft', id: 'core', version: '1.21.11' },
        { namespace: 'fabric', id: 'fabricloader', version: loaderVersion },
        // fabric-api must be declared explicitly — its jar id is 'fabric-api'
        ...scanned,
        // Deeply-nested modules the host log proves are loaded but which
        // don't appear as top-level or single-level nested fabric.mod.json:
        { namespace: 'fabric', id: 'conditional-mixin', version: '0.6.4' },
        { namespace: 'fabric', id: 'trender', version: '1.5.2' },
        { namespace: 'fabric', id: 'fabric-key-binding-api-v1', version: '1.0.47+1.21.11' },
        { namespace: 'fabric', id: 'fabric-transitive-access-wideners-v1', version: '1.0.0+1.21.11' },
    ];

    if (scanned.length) {
        logger.log?.(`[FabricScan] declaring ${packs.length} packs from ${scanned.length} jars (${DEFAULT_MODS_DIR})`);
    } else {
        logger.log?.('[FabricScan] scan produced nothing — falling back to hardcoded manifest');
    }

    _cache = { sig, packs };
    return packs;
}

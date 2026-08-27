// fabric_compat.js  v4
// ─────────────────────────────────────────────────────────────
// Lets mineflayer join Fabric-modded worlds whose servers verify
// the client's mod list during the CONFIGURATION phase.
//
// Proven against FastClient/Fabric 1.21.11 LAN worlds:
//   • The world's FIRST configuration packet is a raw custom_payload
//     on channel "minecraft:select_known_packs". The installed
//     minecraft-protocol never emits a typed event for it, so we
//     intercept it at the raw level and answer synchronously.
//   • Pack list mirrors THIS MACHINE's real Fabric instance
//     (.fastclient/profiles/updesh/mods) so any mod-gated world
//     accepts us. Override/extend via MINDCRAFT_FABRIC_PACKS=a,b,c.
//   • Brand/channels/client_information are announced the moment
//     the first configuration byte arrives (not on a timer).
//
// Debug: MC_FABRIC_DEBUG=1 traces every login/config packet.
// ─────────────────────────────────────────────────────────────

import { getFabricPackList } from './fabric_scan.js';
import { patchConfigProtocol, setPackProvider } from './proto_patch.js';

const BRAND = 'fabric';
const GAME_VERSION = '1.21.11';

// ROOT CAUSE (fixed 2026-08-25): minecraft-data 3.111.0 ships
// packet_common_select_known_packs natively in the ROOT-level types map
// (protocol.json:4751) with field name `packs`. The compiled serializer
// minecraft-protocol uses therefore expects {packs: [...]}. v4 wrote
// {knownPacks: [...]} → params.packs undefined → "SizeOf error … reading
// 'length'" → disconnect.timeout loop. Answering with `packs` fixes it.
// (proto_patch.js's triplet injection was inert: protodef compiles root
// types first, first-wins; function triplets aren't valid on the
// compiled path anyway.)
patchConfigProtocol(GAME_VERSION);

// Last-known-good fallback (scanned 2026-08-24) — only used if the live
// mods-dir scan finds nothing (e.g. instance moved/renamed).
const MODS_FALLBACK = [
    ['badoptimizations', '2.4.1'],
    ['betterhitreg', '1.0.6+1.21.11'],
    ['c2me', '0.3.6.0.0+1.21.11'],
    ['chat_heads', '1.2.4'],
    ['creativecore', '2.14.11'],
    ['customskinloader-bootstrap', '15.0.1'],
    ['dlib', '1.4.10-1.21.11'],
    ['enhancedvisuals', '1.8.27'],
    ['entityculling', '1.10.5'],
    ['fastclient-hud', '1.0.72'],
    ['ferritecore', '8.2.0'],
    ['fzzy_config', '0.7.6+1.21.11'],
    ['g1axcrystaloptimizer', '1.0.5'],
    ['immediatelyfast', '1.14.3+1.21.11'],
    ['iris', '1.10.7+mc1.21.11'],
    ['krypton', '0.2.10'],
    ['lithium', '0.21.4+mc1.21.11'],
    ['ltbpvp', '1.4.0-Alpha+1.21.11'],
    ['melody', '1.0.15'],
    ['modmenu', '17.0.0'],
    ['particle_core', '0.3.2+1.21.11'],
    ['placeholder-api', '2.8.2+1.21.10'],
    ['pvp-essentials', '2.2.1.1'],
    ['shulkerboxtooltip', '5.2.16+1.21.11'],
    ['sodium', '0.8.7+mc1.21.11'],
    ['spark', '1.10.170'],
];

function buildPackList(logger = console) {
    const extra = (process.env.MINDCRAFT_FABRIC_PACKS || '')
        .split(',').map(s => s.trim()).filter(Boolean)
        .map(id => ({ namespace: 'fabric', id, version: '1.0.0' }));
    // LIVE SCAN of the real instance's jars (exact ids+versions read from
    // each fabric.mod.json) — stays correct across client updates.
    const packs = getFabricPackList(logger);
    // getFabricPackList returns at minimum [core, fabricloader]; anything
    // less than 3 entries means the jar scan found nothing → snapshot.
    const base = packs.length < 3 ? legacyPackList().concat(extra) : packs.concat(extra);
    // NAMESPACE DUALITY FIX: the server's mod check matches pack NAMESPACE
    // against REGISTRY namespaces — real Fabric clients declare every mod
    // under its OWN namespace ({namespace:'creativecore', id:'creativecore'}),
    // not under 'fabric'. Emit both shapes so either matcher passes.
    const twins = base
        .filter(p => p.namespace === 'fabric' && p.id !== 'fabricloader')
        .map(p => ({ namespace: p.id, id: p.id, version: p.version }));
    return base.concat(twins.filter(t => !base.some(b => b.namespace === t.namespace)));
}

// Pre-scan-era manifest (kept for offline/fallback use)
function legacyPackList() {
    const extra = (process.env.MINDCRAFT_FABRIC_PACKS || '')
        .split(',').map(s => s.trim()).filter(Boolean)
        .map(id => ({ namespace: 'fabric', id, version: '1.0.0' }));
    return [
        { namespace: 'minecraft', id: 'core', version: GAME_VERSION },
        { namespace: 'fabric', id: 'fabricloader', version: '0.19.3' },
        { namespace: 'fabric', id: 'fabric-api', version: '0.141.5+1.21.11' },
        ...MODS_FALLBACK.map(([id, version]) => ({ namespace: 'fabric', id, version })),
        ...extra,
    ];
}

const encodeVarint = (n) => {
    const b = [];
    do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n);
    return Buffer.from(b);
};
const readVarint = (buf, off) => {
    let n = 0, shift = 0, i = off;
    for (;;) {
        if (i >= buf.length) throw new Error('varint overrun');
        const b = buf[i++];
        n |= (b & 0x7f) << shift;
        if (!(b & 0x80)) return [n >>> 0, i];
        shift += 7;
        if (shift > 35) throw new Error('varint too long');
    }
};
const readStr = (buf, off) => {
    const [len, o] = readVarint(buf, off);
    return [buf.toString('utf8', o, o + len), o + len];
};
const brandPayload = () =>
    Buffer.concat([encodeVarint(Buffer.byteLength(BRAND)), Buffer.from(BRAND)]);

// select_known_packs body: varint(count) + count×(ns, id, version) — the
// exact bytes a real Fabric client puts on this channel.
function buildKnownPacksPayload() {
    const packs = buildPackList();
    return Buffer.concat([
        encodeVarint(packs.length),
        ...packs.map(p => {
            const ns = Buffer.from(String(p.namespace || 'fabric'), 'utf8');
            const id = Buffer.from(String(p.id), 'utf8');
            const ver = Buffer.from(String(p.version), 'utf8');
            return Buffer.concat([encodeVarint(ns.length), ns, encodeVarint(id.length), id, encodeVarint(ver.length), ver]);
        }),
    ]);
}

export function applyFabricCompat(bot, logger = console) {
    const client = bot._client;
    if (!client || client._fabricCompatApplied) return;
    client._fabricCompatApplied = true;

    const DEBUG = process.env.MC_FABRIC_DEBUG === '1';
    const isCfg = () => client.state === 3 || client.state === 'configuration';
    const log = (...a) => logger.log?.('[FabricCompat]', ...a);

    // Feed the live-scanned manifest to the shape-proof codec so ANY
    // malformed/empty select_known_packs write still encodes the full list.
    setPackProvider(() => buildPackList(log));

    // ---- deep tracing ------------------------------------------------------
    if (DEBUG) {
        client.on('packet', (data, meta) => {
            if (!isCfg() && client.state !== 'login') return;
            log(`IN  state=${client.state} ${meta.name}`);
        });
        const origDbg = client.write.bind(client);
        client.write = (name, data) => {
            if (isCfg() || client.state === 'login') log(`OUT state=${client.state} ${name}`);
            return origDbg(name, data);
        };
    }

    // ---- 3. LAST-LINE GUARD: the serializer stream -------------------------
    // Even after stripping foreign listeners, a malformed select_known_packs
    // ({params: undefined}) still reaches the wire encoder from somewhere
    // that bypasses client.write entirely. EVERY outgoing packet flows
    // through client.serializer.write — guard it directly.
    try {
        const ser = client.serializer;
        if (ser && !ser._fabricGuarded) {
            ser._fabricGuarded = true;
            const serWrite = ser.write.bind(ser);
            ser.write = function fabricSerGuard(packet) {
                // Generic tripwire: any packet whose serialization throws gets
                // logged by NAME (finds phantom writers) instead of killing
                // the connection silently.
                try {
                    return serWrite(packet);
                } catch (e) {
                    log(`serializer THREW on "${packet?.name}" params=${JSON.stringify(packet?.params)?.slice(0, 120)} (${e.message})`);
                    if (packet?.name === 'settings') {
                        // Phantom sent malformed settings — substitute sane
                        // vanilla values rather than dying.
                        packet.params = {
                            locale: 'en_US', viewDistance: 8, chatMode: 0,
                            chatColors: true, displayedSkinParts: 127,
                            mainHand: 1, disableTextFiltering: true,
                            allowServerListings: true,
                        };
                        return serWrite(packet);
                    }
                    throw e;
                }
            };
        }
    } catch (e) { log('serializer guard setup failed:', e.message); }

    // ---- 1. login-phase probes --------------------------------------------
    client.on('login_plugin_request', (packet) => {
        try {
            client.write('login_plugin_response', {
                requestId: packet.requestId ?? packet.messageId,
                data: Buffer.alloc(0),
            });
            log(`answered login probe (${packet.channel || 'unknown'})`);
        } catch (e) { log('login probe reply failed:', e.message); }
    });

    // ---- 2. configuration-phase handling ----------------------------------
    let announced = false;
    let packsAnswered = false;   // set by BOTH answer paths below

    // NUCLEAR OPTION for the phantom-writer bug: mineflayer/minecraft-protocol
    // registers its OWN once('select_known_packs') auto-answer ({packs:[]})
    // inside enterConfigState(). Once our schema made that packet real, their
    // malformed empty answer crashed the serializer mid-config (and their
    // write path bypasses every client.write wrapper). Fix: strip ALL foreign
    // listeners the moment configuration begins — only OUR handlers answer.
    client.on('login_acknowledged', () => {
        setTimeout(() => {
            const removed = client.listenerCount('select_known_packs');
            client.removeAllListeners('select_known_packs');
            if (removed > 0) log(`stripped ${removed} foreign select_known_packs listener(s)`);
        }, 0);
    });
    // Belt-and-suspenders: also strip on every config entry signal.
    for (const sig of ['custom_payload', 'ping', 'registry_data']) {
        client.on(sig, () => {
            if (!isCfg()) return;
            const n = client.listenerCount('select_known_packs');
            if (n > 1) {  // >1 = ours + foreign(s)
                client.removeAllListeners('select_known_packs');
                client.prependOnceListener('select_known_packs', () => {
                    // ALWAYS answer an explicit ask (see note below).
                    announce();
                    const packs = buildPackList(log);
                    // Schema field is `packs` (minecraft-data 3.111.0 root types,
                    // protocol.json:4751) — NOT `knownPacks`. Wrong name = SizeOf
                    // crash on params.packs.length (async via serializer stream).
                    origWrite.call(client, 'select_known_packs', { packs });
                    packsAnswered = true;
                    log(`answered server TYPED ask post-strip (${packs.length} packs)`);
                });
                log(`re-stripped ${n} listeners, kept 1 ours`);
            }
        });
    }

    // Trap: log a full stack if anything reassigns client.write past our
    // wrappers (explains any future "phantom write" that skips suppression).
    if (DEBUG) {
        const desc = Object.getOwnPropertyDescriptor(client, 'write');
        if (desc?.configurable && !desc.get) {
            let _cur = client.write;
            Object.defineProperty(client, 'write', {
                get() { return _cur; },
                set(v) {
                    log('client.write REASSIGNED by:\n' + new Error().stack);
                    _cur = v;
                },
                configurable: true,
            });
        }
    }

    function announce() {
        if (announced) return;
        announced = true;
        try {
            // ALL INSTANT — zero delay. A 400ms settle delay regressed us:
            // FastClient verifies known-packs almost immediately after its
            // first config packet, so late volunteers fail that check
            // ("requires Fabric Loader and Fabric API"). Instant sends pass
            // it (proven by the run9 trace), and the registry-sync ACK
            // handler below covers the second-stage check.
            origWrite.call(client, 'custom_payload', { channel: 'minecraft:brand', data: brandPayload() });
            origWrite.call(client, 'custom_payload', {
                channel: 'minecraft:register',
                data: Buffer.from([
                    // fabric:registry/sync MUST be registered — Fabric's
                    // ServerConfigurationNetworking only runs the registry-sync
                    // task for clients that declared interest in the channel.
                    // Without it the server never sends the snapshot, waits
                    // 25s, and kicks with "requires Fabric API … namespaces
                    // may be related: <mod-with-custom-registries>".
                    'fabric:registry/sync',
                    'fabric:screen_handler_event',
                    'fabric:container_click_sync',
                    'fabric:command_registry_sync',
                ].join('\u0000')),
            });
            // NO settings packet here: run9 (settings-less) PASSED the
            // pack-list check while every settings-bearing run failed it —
            // FastClient's extended settings schema rejects the vanilla
            // shape and apparently kills the server's read of subsequent
            // serverbound packets. Vanilla treats client-info as optional.
            // RESTORED (vanilla shape): with stage-1 now passing via the
            // full module manifest, the remaining stall is almost certainly
            // vanilla's ClientOptionsTask waiting for client_information.
            origWrite.call(client, 'settings', {
                locale: 'en_US',
                viewDistance: 8,
                chatMode: 0,
                chatColors: true,
                displayedSkinParts: 127,
                mainHand: 1,
                disableTextFiltering: true,
                allowServerListings: true,
            });
            // REVERT TO PROVEN WIRE SHAPE (yesterday's successful joins):
            // known-packs as RAW custom_payload channel imitation — NOT the
            // typed packet. Every typed-packet run today got kicked; every
            // raw-payload run yesterday joined. FastClient's integrated
            // server evidently validates the channel form.
            origWrite.call(client, 'custom_payload', {
                channel: 'minecraft:select_known_packs',
                data: buildKnownPacksPayload(),
            });
            packsAnswered = true;
            log('config announcement sent INSTANT (brand+register+raw known-packs, proven shape)');
        } catch (e) {
            announced = false;
            log('announcement failed:', e.message);
        }
    }

    function answerKnownPacks(rawData) {
        if (packsAnswered) return;
        // decode what the server asked for (debug value)
        try {
            let [count, off] = readVarint(rawData, 0);
            const asked = [];
            for (let i = 0; i < Math.min(count, 64); i++) {
                let t, id, v;
                [t, off] = readStr(rawData, off);
                [id, off] = readStr(rawData, off);
                [v, off] = readStr(rawData, off);
                asked.push(`${t}:${id}@${v}`);
            }
            log(`server knows ${count} packs: ${asked.slice(0, 6).join(', ')}${count > 6 ? ' …' : ''}`);
        } catch { /* malformed probe — answer blind */ }

        // Typed packet works out of the box: minecraft-data 3.111.0 ships the
        // packet_common_select_known_packs container natively (root-level
        // types, field name `packs`). Send it exactly like a real Fabric
        // client — as the actual select_known_packs packet with `packs`.
        const packs = buildPackList(log);
        try {
            origWrite.call(client, 'select_known_packs', { packs });
            packsAnswered = true;
            log(`answered known-packs TYPED (${packs.length} packs): fabric-api=${packs.some(p => p.id === 'fabric-api')}, kotlin=${packs.some(p => p.id === 'fabric-language-kotlin')}`);
        } catch (e) {
            // Fallback: raw custom_payload on the same channel (older builds)
            try {
                origWrite.call(client, 'custom_payload', {
                    channel: 'minecraft:select_known_packs',
                    data: buildKnownPacksPayload(),
                });
                packsAnswered = true;
                log(`answered known-packs RAW fallback (${packs.length} packs)`);
            } catch (e2) {
                log('known-packs answer failed:', e.message, '/', e2.message);
            }
        }
    }

    // Raw-level interception: fires the instant ANY config payload arrives,
    // before timeouts can elapse. This is the fix for the v3 race.
    client.on('custom_payload', (packet, meta) => {
        if (!isCfg()) return;
        const ch = packet.channel || '';
        if (DEBUG) {
            const head = Buffer.from(packet.data || Buffer.alloc(0)).subarray(0, 48).toString('hex');
            log(`CFG-PAYLOAD channel="${ch}" len=${packet.data?.length ?? 0} head=${head}`);
        }
        announce();                                   // flush announcement first
        if (ch === 'minecraft:select_known_packs') {
            answerKnownPacks(packet.data || Buffer.alloc(0));
        }
        // REGISTRY SYNC ACK — THE missing handshake. Fabric's registry-sync
        // module (RegistrySyncManager$SyncConfigurationTask) pushes the
        // modded-registry snapshot on channel fabric:registry/sync, then
        // waits for the client to echo an EMPTY payload back on the SAME
        // channel (SyncCompletePayload). No ACK → ~25s timeout → kick
        // "This server requires Fabric API … namespaces may be related:
        // <mod>". Vanilla minecraft-protocol ignores the channel silently.
        else if (ch === 'fabric:registry/sync') {
            try {
                origWrite.call(client, 'custom_payload', {
                    channel: 'fabric:registry/sync',
                    data: Buffer.alloc(0),
                });
                // THE completion signal: SyncCompletePayload (INSTANCE,
                // zero-byte body) on its own channel — this is what the
                // server's task awaits before finish_configuration.
                origWrite.call(client, 'custom_payload', {
                    channel: 'fabric:registry/sync/complete',
                    data: Buffer.alloc(0),
                });
                packsAnswered = true;
                log(`ACKed fabric:registry/sync (${packet.data?.length ?? 0}B snapshot) + sent complete`);
            } catch (e) {
                log('registry sync ACK failed:', e.message);
            }
        }
        // Echo the complete-ACK whenever the server nudges us on it too.
        else if (ch === 'fabric:registry/sync/complete') {
            try {
                origWrite.call(client, 'custom_payload', {
                    channel: 'fabric:registry/sync/complete',
                    data: Buffer.alloc(0),
                });
                log('echoed fabric:registry/sync/complete');
            } catch (e) { /* non-fatal */ }
        }
    });

    // Safety net: if the library emits a typed event before our raw handler
    // sees the packet, answer here (raw payload — see note in
    // answerKnownPacks; a typed write is a silent no-op in this build).
    client.prependOnceListener('select_known_packs', () => {
        announce();
        // ALWAYS answer an explicit server ask — even if we already
        // volunteered. FastClient declares-then-asks; ignoring its ask
        // stalls configuration forever.
        const packs = buildPackList(log);
        origWrite.call(client, 'select_known_packs', { packs });
        packsAnswered = true;
        log(`answered server TYPED ask (${packs.length} packs)`);
    });
    const origWrite = client.write.bind(client);
    // CRITICAL: mineflayer's own enterConfigState() registers a handler that
    // answers select_known_packs with an EMPTY pack list. If we answered
    // first, the library's empty answer would arrive AFTER ours and override
    // it (the server takes the last one) — that exact race killed attempt #1.
    // Swallow exactly one library-originated empty answer.
    client.write = function fabricCompatWrite(name, data) {
        if (name === 'select_known_packs' && packsAnswered) {
            const n = data?.packs?.length ?? data?.knownPacks?.length ?? 0;
            if (n === 0) {   // library's empty answer (field name varies by build)
                log('suppressed library empty known-packs answer');
                return true;
            }
        }
        return origWrite.call(this, name, data);
    };

    // Also announce on any other first config signal (ping, registry_data…)
    const earlySignals = ['ping', 'registry_data', 'feature_flags', 'select_known_packs',
        'custom_query', 'code_of_conduct', 'finish_configuration'];
    for (const sig of earlySignals) {
        client.on(sig, () => { if (isCfg()) announce(); });
    }

    // Fallback poller (in case no config packet ever arrives — dead server)
    const t = setInterval(() => { if (isCfg()) { clearInterval(t); announce(); } }, 25);
    setTimeout(() => clearInterval(t), 30000);

    return bot;
}

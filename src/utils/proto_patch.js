import mcData from 'minecraft-data';

// Pack provider: set by fabric_compat to inject the live-scanned manifest.
let packProvider = () => [
    { namespace: 'minecraft', id: 'core', version: '1.21.11' },
    { namespace: 'fabric', id: 'fabricloader', version: '0.19.3' },
    { namespace: 'fabric', id: 'fabric-api', version: '0.141.5+1.21.11' },
];
export function setPackProvider(fn) { packProvider = fn; }
export function getPackProvider() { return packProvider; }

// TRUTHFUL NO-OP (2026-08-25): an earlier version of this file tried to
// inject a [read, write, sizeOf] function triplet as
// protocol.configuration.toServer.types.packet_common_select_known_packs.
// That never worked, for two independent reasons:
//   1. minecraft-data 3.111.0 already defines packet_common_select_known_packs
//      natively at ROOT-level types (protocol.json:4751). protodef's compiler
//      registers root types FIRST and first-wins, so any namespace-level
//      entry for the same name is silently discarded.
//   2. Raw function triplets are only understood by the ProtoDef interpreter;
//      minecraft-protocol uses the compiled path (ProtoDefCompiler), which
//      rejects function-valued schemas outright.
// The correct integration is simply to write the typed packet with the
// schema's real field name (`packs`) — see fabric_compat.js.
export function patchConfigProtocol(version = '1.21.11') {
    const data = typeof version === 'string' ? mcData(version) : version;
    const nativeType = data?.protocol?.types?.packet_common_select_known_packs;
    if (!nativeType) {
        console.warn('[proto_patch] packet_common_select_known_packs missing from shared types — typed answers will fail');
        return false;
    }
    console.log('[proto_patch] native select_known_packs schema present (field: packs)');
    return true;
}

export function apply(bot) {
    return patchConfigProtocol(bot?.version || '1.21.11');
}

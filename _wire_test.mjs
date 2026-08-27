// Offline proof: typed select_known_packs bytes == real Fabric client bytes
import mcData from 'minecraft-data';
await import('./src/utils/fabric_compat.js');   // installs schema patch
import mcp from 'minecraft-protocol';
import protodef from 'protodef';

const packs = [
    { namespace: 'minecraft', id: 'core', version: '1.21.11' },
    { namespace: 'fabric', id: 'fabricloader', version: '0.19.3' },
    { namespace: 'fabric', id: 'creativecore', version: '2.14.11' },
];

// Manual reference encoding: varint(3) + entries (the real Fabric wire shape)
const ev = n => { const b = []; do { let x = n & 127; n >>>= 7; if (n) x |= 128; b.push(x); } while (n); return Buffer.from(b); };
const es = s => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([ev(b.length), b]); };
const ref = Buffer.concat([ev(packs.length), ...packs.map(p => Buffer.concat([es(p.namespace), es(p.id), es(p.version)]))]);
console.log('reference hex:', ref.toString('hex'));

// Serialize via protodef with the patched schema
const d = mcData('1.21.11');
const pd = new protodef.ProtoDef(false);
pd.addTypes(d.protocol.types ?? {});          // base datatypes first (string etc.)
pd.addTypes(d.protocol.configuration.toServer.types);
const body = pd.createPacketBuffer('packet', { name: 'select_known_packs', params: { knownPacks: packs } });
console.log('schema    hex:', body.toString('hex'));
console.log('MATCH:', body.toString('hex') === ref.toString('hex'));
process.exit(0);

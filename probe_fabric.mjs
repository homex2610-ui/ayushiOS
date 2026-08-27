// probe_fabric2.js — verify config-phase announcement unblocks the Fabric world
import mc from 'minecraft-protocol';

const encodeVarint = (n) => {
    const b = [];
    do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; b.push(x); } while (n);
    return Buffer.from(b);
};
const brand = () => Buffer.concat([encodeVarint(6), Buffer.from('fabric')]);

const client = mc.createClient({
    host: '127.0.0.1', port: 51472, username: 'ayushi_ds_2026', auth: 'offline', version: '1.21.11',
});

let inConfig = false;
client.on('login_plugin_request', (p) => {
    client.write('login_plugin_response', { requestId: p.requestId ?? p.messageId, data: Buffer.alloc(0) });
    console.log('[probe] answered login plugin request');
});

function announce() {
    if (inConfig) return;
    inConfig = true;
    client.write('custom_payload', { channel: 'minecraft:brand', data: brand() });
    const chans = ['fabric:screen_handler_event', 'fabric:container_click_sync', 'fabric:command_registry_sync'];
    client.write('custom_payload', { channel: 'minecraft:register', data: Buffer.from(chans.join('\u0000')) });
    client.write('client_information', {
        locale: 'en_US', viewDistance: 8, chatMode: 0, chatColors: true,
        displayedSkinParts: 127, mainHand: 1, enableTextFiltering: false, allowServerListings: true,
    });
    console.log('[probe] CONFIG announced: brand=fabric + channels + settings');
}

client.on('start_configuration', () => setTimeout(announce, 30));
client.on('success', () => setTimeout(announce, 200));

let count = 0;
client.on('packet', (data, meta) => {
    count++;
    if (count <= 25) console.log(`[IN ] state=${client.state} ${meta.name}`);
    if (meta.name === 'finish_configuration') console.log('>>> SERVER FINISHED CONFIGURATION — gate passed!');
    if (meta.name === 'login') { console.log('>>> PLAY PHASE LOGIN PACKET — WE ARE IN THE WORLD'); }
});

client.on('disconnect', (msg) => {
    try {
        const parsed = JSON.parse(msg.reason);
        const flat = (o) => typeof o === 'string' ? o : (o?.text || '') + (o?.extra || []).map(flat).join('');
        console.log('KICKED:', flat(parsed));
    } catch { console.log('KICKED RAW:', String(msg.reason).slice(0, 200)); }
    process.exit(1);
});
client.on('end', () => { console.log('(connection closed)'); process.exit(0); });
client.on('error', (e) => console.log('err:', e.message));
setTimeout(() => { console.log('(45s, still alive)'); }, 45000);

// Spawns the Player2-brained guide bot into the RUNNING mindserver (:8080)
// without restarting anything. Uses the official create-agent socket API.
import { io } from 'socket.io-client';
import { readFileSync } from 'fs';

const profile = JSON.parse(readFileSync('./player2_guide.json', 'utf8'));

const settings = {
    profile,
    minecraft_version: 'auto',
    host: '127.0.0.1',
    port: 63716, // current LAN world port (verified via ping before launch)
    auth: 'offline',
    base_profile: 'survival',
    load_memory: false,
    init_message: "You just spawned into the world. Say ONE short line greeting updesh and ayushi_ds_2026, offering to guide them through survival tonight.",
    only_chat_with: [],
    max_messages: 4,
    num_examples: 0,
    spawn_timeout: 90
};

const socket = io('http://[::1]:8080', { transports: ['websocket'] });

socket.on('connect', () => {
    console.log('[inject] connected to mindserver, creating agent', profile.name);
    socket.emit('create-agent', settings, (res) => {
        console.log('[inject] RESULT:', JSON.stringify(res));
        socket.close();
        process.exit(res && res.success ? 0 : 1);
    });
});

socket.on('connect_error', (e) => {
    console.error('[inject] CONNECT ERROR:', e.message);
    process.exit(1);
});

setTimeout(() => {
    console.error('[inject] TIMEOUT: no callback from mindserver in 25s');
    process.exit(2);
}, 25000);

// watchdog.mjs — supervises main.js: logs exit reasons, auto-restarts.
import { spawn } from 'child_process';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const args = process.argv.slice(2);
mkdirSync('logs', { recursive: true });
const LOG = join('logs', 'bot_watchdog.log');

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const note = (m) => { const l = `[${stamp()}] ${m}`; console.log(l); try { appendFileSync(LOG, l + '\n'); } catch {} };

let runs = 0;
let lastStart = Date.now();
let recentCrashes = [];

function launch() {
    runs++;
    lastStart = Date.now();
    note(`start #${runs}: node main.js ${args.join(' ')}`);
    const child = spawn(process.execPath, ['main.js', ...args], { stdio: 'inherit' });

    child.on('exit', (code, signal) => {
        const uptime = ((Date.now() - lastStart) / 1000).toFixed(0);
        note(`EXIT after ${uptime}s — code=${code} signal=${signal}`);
        recentCrashes.push(Date.now());
        recentCrashes = recentCrashes.filter(t => Date.now() - t < 120000);
        // Rapid-crash guard: 4+ deaths in 2min → cool down 90s
        const delay = recentCrashes.length >= 4 ? 90000 : 4000;
        if (recentCrashes.length >= 4) note(`rapid-crash guard — waiting ${delay / 1000}s`);
        setTimeout(launch, delay);
    });
}

note(`watchdog up (pid ${process.pid})`);
launch();

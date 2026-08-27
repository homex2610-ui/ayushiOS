import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { logoutAgent } from '../mindcraft/mindserver.js';

const init_agent_path = fileURLToPath(new URL('./init_agent.js', import.meta.url));

export class AgentProcess {
    constructor(name, port) {
        this.name = name;
        this.port = port;
        this._exiting = false;
        this._restartCount = 0;
        this._maxRestarts = 15;
        this._lastRestart = 0;
    }

    start(load_memory=false, init_message=null, count_id=0, serverSettings={}) {
        this.count_id = count_id;
        this.running = true;
        this._spawnedAt = Date.now();
        // Persist resolved connection target so auto-restarts reconnect to the
        // same server instead of falling back to raw settings.js values.
        if (Object.keys(serverSettings).length > 0) this._serverSettings = serverSettings;
        serverSettings = this._serverSettings || serverSettings;

        let args = [init_agent_path, this.name];
        args.push('-n', this.name);
        args.push('-c', count_id);
        if (load_memory)
            args.push('-l', load_memory);
        if (init_message)
            args.push('-m', init_message);
        args.push('-p', this.port);

        const agentProcess = spawn(process.execPath, args, {
            stdio: 'inherit',
            stderr: 'inherit',
            env: Object.keys(serverSettings).length > 0
                ? { ...process.env, MINDCRAFT_SERVER: JSON.stringify(serverSettings) }
                : { ...process.env },
        });
        
        agentProcess.on('exit', (code, signal) => {
            console.log(`Agent process exited with code ${code} and signal ${signal}`);
            this.running = false;
            this.process = null;
            logoutAgent(this.name);

            if (this._exiting) return;

            // Healthy uptime resets the crash budget, so crashes spread over
            // a long-lived session can't permanently retire the agent.
            const uptime = Date.now() - (this._spawnedAt || Date.now());
            if (uptime > 5 * 60 * 1000) this._restartCount = 0;

            if (code > 1) {
                console.log(`Ending task`);
                process.exit(code);
            }

            if (code !== 0 && signal !== 'SIGINT') {
                this._restartCount++;
                if (this._restartCount > this._maxRestarts) {
                    console.error(`Agent crashed ${this._maxRestarts} times. Giving up.`);
                    process.exit(1);
                    return;
                }
                // Crash-looping: back off hard and retry anyway. A bare return
                // here used to strand the stack — no retry was ever scheduled,
                // and the live parent made the outer watchdog look unnecessary.
                const crashedFast = Date.now() - this._lastRestart < 10000;
                this._lastRestart = Date.now();
                const reconnectDelay = crashedFast
                    ? 30000 + Math.random() * 10000
                    : Math.min(1000 + this._restartCount * 2000, 30000) + Math.random() * 3000;
                console.log(`Restart #${this._restartCount} — waiting ${(reconnectDelay/1000).toFixed(1)}s before reconnecting...`);
                setTimeout(() => {
                    if (!this._exiting) {
                        console.log('Restarting agent...');
                        this._load_memory = true;
                        this._init_message = 'Agent process restarted.';
                        this.start(true, 'Agent process restarted.', count_id);
                    }
                }, reconnectDelay);
            }
        });
    
        agentProcess.on('error', (err) => {
            console.error('Agent process error:', err);
            this.process = null;
        });

        this.process = agentProcess;
    }

    stop() {
        if (!this.running || !this.process) return;
        this._exiting = true;
        this.process.kill('SIGINT');
    }

    forceRestart() {
        if (this._exiting) return;
        if (this.running && this.process && !this.process.killed) {
            console.log(`Agent process for ${this.name} is still running. Attempting to force restart.`);
            
            const restartTimeout = setTimeout(() => {
                console.warn(`Agent ${this.name} did not stop in time. It might be stuck.`);
            }, 5000);

            this.process.once('exit', () => {
                 clearTimeout(restartTimeout);
                 if (!this._exiting) {
                     console.log(`Stopped hanging agent ${this.name}. Now restarting.`);
                     this.start(true, 'Agent process restarted.', this.count_id);
                 }
            });
            this.process.kill('SIGINT');
        } else if (!this._exiting) {
             this.start(true, 'Agent process restarted.', this.count_id);
        }
    }
}
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

        let args = ['--experimental-require-module', init_agent_path, this.name];
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
                if (Date.now() - this._lastRestart < 10000) {
                    console.error(`Agent process exited too quickly and will not be restarted.`);
                    return;
                }
                this._lastRestart = Date.now();
                const reconnectDelay = Math.min(1000 + this._restartCount * 2000, 30000) + Math.random() * 3000;
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
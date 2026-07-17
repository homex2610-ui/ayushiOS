import readline from 'readline';
import { io } from 'socket.io-client';

const COMMANDS = {
    'help': { desc: 'Show available console commands' },
    'say': { desc: 'Send a chat message as you to the bot  (e.g. "say hello")' },
    'task': { desc: 'Show task queue status' },
    'cancel': { desc: 'Cancel a task by ID (e.g. "cancel 0" or "cancel all")' },
    'inventory': { desc: 'Show bot inventory' },
    'stats': { desc: 'Show bot stats' },
    'memory': { desc: 'Show bot memory' },
    'follow': { desc: 'Tell bot to follow you' },
    'stop': { desc: 'Tell bot to stop current actions' },
    'restart': { desc: 'Restart the agent' },
    'think': { desc: 'Force the bot to think/reason' },
    'queue': { desc: 'Alias for "task" - show task queue' },
    'clear': { desc: 'Clear the terminal' },
    'exit': { desc: 'Exit the bot' }
};

export class TerminalConsole {
    constructor(agentName, mindserverPort = 8080) {
        this.agentName = agentName;
        this.mindserverPort = mindserverPort;
        this.socket = null;
        this._connected = false;
        this._rl = null;
        this._running = false;
    }

    async start() {
        if (this._running) return;
        this._running = true;

        await this._connect();

        if (!process.stdin.isTTY) {
            console.log('[Terminal] No TTY available. Terminal input disabled.');
            return;
        }

        this._rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: `\x1b[36m[${this.agentName}]\x1b[0m > `
        });

        this._rl.prompt();

        this._rl.on('line', async (line) => {
            const trimmed = line.trim();
            if (!trimmed) { this._rl.prompt(); return; }
            await this._handleInput(trimmed);
            this._rl.prompt();
        });

        this._rl.on('close', () => {
            console.log('\n[Terminal] Console closed');
            this._running = false;
        });

        console.log(`[Terminal] Console ready. Type "help" for commands.`);
    }

    async _connect() {
        return new Promise((resolve) => {
            try {
                this.socket = io(`http://localhost:${this.mindserverPort}`, {
                    transports: ['websocket', 'polling'],
                    reconnection: true,
                    reconnectionDelay: 2000
                });

                this.socket.on('connect', () => {
                    this._connected = true;
                    this.socket.emit('listen-to-agents');
                    console.log(`[Terminal] Connected to MindServer on port ${this.mindserverPort}`);
                    resolve();
                });

                this.socket.on('connect_error', (err) => {
                    console.warn(`[Terminal] MindServer connection failed: ${err.message}. Terminal will work in local-only mode.`);
                    this._connected = false;
                    resolve();
                });

                this.socket.on('agents-status', (agents) => {
                    this._agents = agents;
                });

                setTimeout(() => {
                    if (!this._connected) {
                        console.warn('[Terminal] MindServer connection timeout. Terminal in local-only mode.');
                        resolve();
                    }
                }, 3000);
            } catch (e) {
                console.warn(`[Terminal] Failed to connect: ${e.message}`);
                resolve();
            }
        });
    }

    _sendMessageToAgent(message) {
        if (this._connected && this.socket) {
            this.socket.emit('send-message', this.agentName, {
                from: 'updesh',
                message: message
            });
            return true;
        }
        console.warn('[Terminal] Cannot send: MindServer not connected');
        return false;
    }

    _sendCommandToAgent(command) {
        if (this._connected && this.socket) {
            this.socket.emit('send-message', this.agentName, {
                from: 'updesh',
                message: command
            });
            return true;
        }
        console.warn('[Terminal] Cannot send command: MindServer not connected');
        return false;
    }

    async _handleInput(line) {
        if (line.startsWith('/') || line.startsWith('!')) {
            const cmd = line.substring(1).toLowerCase().split(' ')[0];
            const rest = line.substring(line.indexOf(' ') + 1);

            switch (cmd) {
                case 'help':
                    this._showHelp();
                    break;

                case 'say':
                    if (rest) {
                        this._sendMessageToAgent(rest);
                        console.log(`\x1b[33m[Chat] updesh >\x1b[0m ${rest}`);
                    } else {
                        console.log('Usage: say <message>');
                    }
                    break;

                case 'task':
                case 'queue':
                    this._sendCommandToAgent('!taskStatus');
                    break;

                case 'cancel':
                    if (rest === 'all') {
                        this._sendCommandToAgent('!cancelAll');
                        console.log('[Terminal] Sent cancel all tasks');
                    } else if (rest) {
                        this._sendCommandToAgent(`!cancelTask ${rest}`);
                        console.log(`[Terminal] Sent cancel task ${rest}`);
                    } else {
                        console.log('Usage: cancel <id|all>');
                    }
                    break;

                case 'inventory':
                    this._sendCommandToAgent('!inventory');
                    break;

                case 'stats':
                    this._sendCommandToAgent('!stats');
                    break;

                case 'memory':
                    this._sendCommandToAgent('!memory');
                    break;

                case 'follow':
                    this._sendCommandToAgent('come here');
                    break;

                case 'stop':
                    this._sendCommandToAgent('!stop');
                    break;

                case 'restart':
                    if (this._connected && this.socket) {
                        this.socket.emit('restart-agent', this.agentName);
                        console.log('[Terminal] Sent restart signal');
                    }
                    break;

                case 'think':
                    this._sendMessageToAgent('What are you doing? Think and report.');
                    break;

                case 'clear':
                    console.clear();
                    break;

                case 'exit':
                    console.log('[Terminal] Shutting down...');
                    process.exit(0);
                    break;

                default:
                    console.log(`Unknown command: ${cmd}. Type "help" for available commands.`);
            }
        } else {
            this._sendMessageToAgent(line);
            console.log(`\x1b[33m[Chat] updesh >\x1b[0m ${line}`);
        }
    }

    _showHelp() {
        console.log('\n\x1b[36m=== Terminal Console ===\x1b[0m');
        console.log('Just type and press Enter to send chat as updesh');
        console.log('Use /command for control commands:\n');
        for (const [name, info] of Object.entries(COMMANDS)) {
            console.log(`  \x1b[33m/${name}\x1b[0m${' '.repeat(Math.max(1, 12 - name.length))}${info.desc}`);
        }
        console.log('');
    }

    stop() {
        this._running = false;
        if (this._rl) {
            this._rl.close();
            this._rl = null;
        }
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
    }
}

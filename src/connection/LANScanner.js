import net from 'net';
import mc from 'minecraft-protocol';

const COMMON_PORTS = [25565, 25566, 25575, 19132, 19133, 25580, 25570];

export class LANScanner {
    constructor() {
        this._scanning = false;
    }

    async scan(ip = '127.0.0.1') {
        if (this._scanning) {
            console.warn('[LANScanner] Scan already in progress');
            return null;
        }
        this._scanning = true;
        try {
            console.log(`[LANScanner] Scanning for LAN worlds on ${ip}...`);

            // Scan common Minecraft ports first
            const quickResult = await this._quickScan(ip, 5000);
            if (quickResult) {
                console.log(`[LANScanner] Found LAN server: ${quickResult.host}:${quickResult.port}`);
                return quickResult;
            }

            // Try scanning the wider port range that Minecraft LAN uses
            console.log('[LANScanner] Scanning wider port range (49000-65535)...');
            const wideResult = await this._quickBatchScan(ip, 10000);
            if (wideResult) {
                console.log(`[LANScanner] Found LAN server: ${wideResult.host}:${wideResult.port}`);
                return wideResult;
            }

            console.log('[LANScanner] No LAN world detected.');
            return null;
        } finally {
            this._scanning = false;
        }
    }

    async _quickScan(ip, totalTimeoutMs) {
        const startTime = Date.now();

        for (const port of COMMON_PORTS) {
            if (Date.now() - startTime > totalTimeoutMs) break;
            const connected = await this._checkPort(ip, port, 300);
            if (connected) {
                const server = await this._serverInfo(ip, port, 800);
                if (server) return server;
            }
        }

        if (Date.now() - startTime < totalTimeoutMs) {
            const remaining = totalTimeoutMs - (Date.now() - startTime);
            const server = await this._quickBatchScan(ip, remaining);
            if (server) return server;
        }

        return null;
    }

    async _quickBatchScan(ip, timeoutMs) {
        const startPort = 49000;
        const endPort = 65535;
        const batchTimeout = Math.min(timeoutMs, 10000);
        const timeout = 50;

        const checkPort = (port) => {
            return new Promise((resolve) => {
                const socket = net.createConnection({ host: ip, port, timeout }, () => {
                    socket.end();
                    resolve(port);
                });
                socket.on('error', () => resolve(null));
                socket.on('timeout', () => { socket.destroy(); resolve(null); });
            });
        };

        const BATCH_SIZE = 1024;
        const originalConsoleLog = console.log;
        console.log = () => {};

        try {
            const maxBatches = Math.ceil(batchTimeout / 200);
            for (let batch = 0; batch < maxBatches; batch++) {
                const batchStart = startPort + (batch * BATCH_SIZE);
                const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, endPort);
                if (batchStart > endPort) break;

                const promises = [];
                for (let port = batchStart; port <= batchEnd; port++) {
                    promises.push(checkPort(port));
                }
                const results = await Promise.all(promises);
                const openPorts = results.filter(p => p !== null);

                for (const port of openPorts) {
                    const server = await this._serverInfo(ip, port, 200);
                    if (server) return server;
                }
            }
        } finally {
            console.log = originalConsoleLog;
        }

        return null;
    }

    async _checkPort(ip, port, timeout) {
        return new Promise((resolve) => {
            const socket = net.createConnection({ host: ip, port, timeout }, () => {
                socket.end();
                resolve(true);
            });
            socket.on('error', () => resolve(false));
            socket.on('timeout', () => { socket.destroy(); resolve(false); });
        });
    }

    async _serverInfo(ip, port, timeout = 1000) {
        return new Promise((resolve) => {
            let timeoutId = setTimeout(() => resolve(null), timeout);
            mc.ping({ host: ip, port }, (err, response) => {
                clearTimeout(timeoutId);
                if (err) return resolve(null);
                const version = response?.version?.name || '';
                const match = String(version).match(/\d+\.\d+(?:\.\d+)?/);
                const numericVersion = match ? match[0] : null;
                resolve({
                    host: ip,
                    port,
                    name: response.description?.text || 'LAN World',
                    ping: response.latency,
                    version: numericVersion,
                    type: 'lan'
                });
            });
        });
    }
}

import net from 'net';
import mc from 'minecraft-protocol';

/**
 * Scans the IP address for Minecraft LAN servers and collects their info.
 * @param {string} ip - The IP address to scan.
 * @param {number} port - The port to check.
 * @param {number} timeout - The connection timeout in ms.
 * @param {boolean} verbose - Whether to print output on connection errors.
 * @returns {Promise<Array>} - A Promise that resolves to an array of server info objects.
 */
export async function serverInfo(ip, port, timeout = 1000, verbose = false) {
    return new Promise((resolve) => {

        let timeoutId = setTimeout(() => {
            if (verbose)
                console.error(`Timeout pinging server ${ip}:${port}`);
            resolve(null); // Resolve as null if no response within timeout
        }, timeout);

        mc.ping({
            host: ip,
            port
        }, (err, response) => {
            clearTimeout(timeoutId);

            if (err) {
                if (verbose)
                    console.error(`Error pinging server ${ip}:${port}`, err);
                return resolve(null);
            }

            // extract version number from modded servers like "Paper 1.21.4"
            const version = response?.version?.name || '';
            const match = String(version).match(/\d+\.\d+(?:\.\d+)?/);
            const numericVersion = match ? match[0] : null;
            if (numericVersion !== version) {
                console.log(`Modded server found (${version}), attempting to use ${numericVersion}...`);
            }

            const serverInfo = {
                host: ip,
                port,
                name: response.description.text || 'No description provided.',
                ping: response.latency,
                version: numericVersion
            };

            resolve(serverInfo);
        });
    });
}

/**
 * Scans the IP address for Minecraft LAN servers and collects their info.
 * @param {string} ip - The IP address to scan.
 * @param {boolean} earlyExit - Whether to exit early after finding a server.
 * @param {number} timeout - The connection timeout in ms.
 * @returns {Promise<Array>} - A Promise that resolves to an array of server info objects.
 */
export async function findServers(ip, earlyExit = false, timeout = 100) {
    const servers = [];
    const startPort = 49000;
    const endPort = 65000;
    let aborted = false;

    const checkPort = (port) => {
        return new Promise((resolve) => {
            if (aborted) return resolve(null);
            const socket = net.createConnection({ host: ip, port, timeout }, () => {
                socket.end();
                if (aborted) return resolve(null);
                resolve(port);
            });
            socket.on('error', () => resolve(null));
            socket.on('timeout', () => {
                socket.destroy();
                resolve(null);
            });
        });
    };

    // This supresses a lot of annoying console output from the mc library
    const originalConsoleLog = console.log;
    console.log = () => { };

    try {
        // Scan in batches of 256 to avoid overwhelming the system
        const BATCH_SIZE = 256;
        for (let batchStart = startPort; batchStart <= endPort && !aborted; batchStart += BATCH_SIZE) {
            const batchEnd = Math.min(batchStart + BATCH_SIZE - 1, endPort);
            const batch = [];
            for (let port = batchStart; port <= batchEnd; port++) {
                batch.push(checkPort(port));
            }
            const results = await Promise.all(batch);
            const openPorts = results.filter(p => p !== null);
            for (const port of openPorts) {
                if (aborted) break;
                const server = await serverInfo(ip, port, 200, false);
                if (server) {
                    servers.push(server);
                    if (earlyExit) {
                        aborted = true;
                        break;
                    }
                }
            }
        }
    } finally {
        console.log = originalConsoleLog;
    }

    return servers;
}

/**
 * Gets the MC server info from the host and port.
 * @param {string} host - The host to search for.
 * @param {number} port - The port to search for.
 * @param {string} version - The version to search for.
 * @returns {Promise<Object>} - A Promise that resolves to the server info object.
 */
export async function getServer(host, port, version) {
    let server = null;
    let serverString = "";
    let serverVersion = "";
    
    // Search for server
    if (port == -1)
    {
        console.log(`No port provided. Searching for LAN server on host ${host}...`);
        
        for (let attempt = 1; attempt <= 3; attempt++) {
            await findServers(host, true).then((servers) => {
                if (servers.length > 0)
                    server = servers[0];
            });
            if (server) break;
            if (attempt < 3) {
                console.log(`LAN scan attempt ${attempt}/3 failed. Retrying in 3s... (open your world to LAN if not done yet)`);
                await new Promise(r => setTimeout(r, 3000));
            }
        }

        if (server == null)
            throw new Error(`No server found on LAN after 3 attempts. Make sure your world is open to LAN (Esc -> Open to LAN -> Start LAN World).`);
    }
    else
        server = await serverInfo(host, port, 5000, true);

    // If ping failed but host:port were explicitly provided, try connecting directly
    if (server == null && port !== -1) {
        console.warn(`Could not ping ${host}:${port} — it may be blocking pings. Attempting connection anyway...`);
        server = { host, port, version: version === "auto" ? null : version };
    }
    else if (server == null) {
        throw new Error(`MC server not found. (Host: ${host}, Port: ${port}) Check the host and port in settings.js, and ensure the server is running and open to public or LAN.`);
    }

    serverString = `(Host: ${server.host}, Port: ${server.port}, Version: ${server.version})`;

    if (version === "auto")
        serverVersion = server.version;
    else
        serverVersion = version || server.version;

    // Try to find the best matching supported version
    let matchedVersion = null;
    if (!serverVersion) {
        console.warn('Server version unknown. Will attempt connection without version check.');
    }
    else if (mc.supportedVersions.some(v => serverVersion === v)) {
        matchedVersion = serverVersion;
    } else {
        // Check parent version match (e.g. "1.21.4" matches supported "1.21")
        matchedVersion = mc.supportedVersions.find(v =>
            serverVersion.startsWith(v) && serverVersion.charAt(v.length) === '.'
        );
        if (!matchedVersion) {
            // Try extracting major.minor and find closest match
            const majorMinor = serverVersion.match(/^(\d+\.\d+)/);
            if (majorMinor) {
                matchedVersion = mc.supportedVersions.find(v =>
                    v.startsWith(majorMinor[1]) && (v.length === majorMinor[1].length || v.charAt(majorMinor[1].length) === '.')
                );
            }
        }
    }

    // Velocity/BungeeCord proxies often show old version strings (e.g. "1.7.2")
    // but support modern clients. Don't use sub-1.8 versions — fall back to modern.
    if (matchedVersion) {
        const major = parseInt(matchedVersion.split('.')[0], 10);
        const minor = parseInt(matchedVersion.split('.')[1], 10);
        if (major < 1 || (major === 1 && minor < 8)) {
            console.warn(`Detected version ${matchedVersion} is too old for mineflayer. Using latest supported version instead (proxy handles translation).`);
            matchedVersion = null;
        }
    }

    if (matchedVersion) {
        server.version = matchedVersion;
        console.log(`MC server found. ${serverString} (using protocol version ${matchedVersion})`);
    } else if (!serverVersion) {
        console.warn(`Server version unknown. Connecting to ${host}:${port} without version check.`);
    } else {
        // Version too old or not found — use the latest supported version 
        // (proxies like Velocity/BungeeCord handle version translation)
        const defaultVersion = mc.supportedVersions.filter(v => {
            const parts = v.split('.');
            return parseInt(parts[0]) === 1 && parseInt(parts[1]) >= 8;
        }).pop() || mc.supportedVersions[mc.supportedVersions.length - 1];
        server.version = defaultVersion;
        console.log(`MC server found. ${serverString} (proxy detected, using ${defaultVersion})`);
    }

    return server;
}

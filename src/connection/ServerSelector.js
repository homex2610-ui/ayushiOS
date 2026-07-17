import CONNECTION_CONFIG from './ConnectionSettings.js';

export class ServerSelector {
    constructor(settings) {
        this.settings = settings;
        this._selectedServer = null;
    }

    get selectedServer() {
        return this._selectedServer;
    }

    async select(lanServer) {
        console.log('[ServerSelector] Selecting target server...');
        console.log(`[ServerSelector] Priority: ${CONNECTION_CONFIG.priority.map(p => p.label).join(' > ')}`);

        if (CONNECTION_CONFIG.preferLAN && lanServer) {
            console.log(`[ServerSelector] LAN world detected! Selecting: ${lanServer.host}:${lanServer.port}`);
            this._selectedServer = {
                host: lanServer.host,
                port: lanServer.port,
                auth: 'offline',
                minecraft_version: lanServer.version || this.settings.minecraft_version || 'auto',
                type: 'lan',
                source: 'lan_scan'
            };
            return this._selectedServer;
        }

        if (CONNECTION_CONFIG.autoFallback && this.settings.host) {
            console.log(`[ServerSelector] Falling back to configured SMP: ${this.settings.host}:${this.settings.port}`);
            this._selectedServer = {
                host: this.settings.host,
                port: this.settings.port,
                auth: this.settings.auth || 'offline',
                minecraft_version: this.settings.minecraft_version || 'auto',
                type: 'public',
                source: 'settings'
            };
            return this._selectedServer;
        }

        console.warn('[ServerSelector] No server selected!');
        return null;
    }

    async selectFallback(lanServer, settings) {
        if (CONNECTION_CONFIG.preferLAN && lanServer) {
            return {
                host: lanServer.host,
                port: lanServer.port,
                auth: 'offline',
                minecraft_version: lanServer.version || settings.minecraft_version || 'auto',
                type: 'lan',
                source: 'lan_scan'
            };
        }
        return null;
    }
}

const CONNECTION_CONFIG = {
    preferLAN: false,
    autoFallback: true,
    autoReconnect: true,
    avoidMinigames: true,
    avoidPractice: true,
    avoidLifesteal: true,
    autoDetectHub: false,
    resumeTasks: true,
    reconnectDelay: 3000,
    maxReconnectDelay: 30000,
    lanScanAttempts: 0,
    lanScanInterval: 1000,
    hubDetectionTimeout: 10000,
    serverChangeTimeout: 20000,
    classificationRetries: 5,
    healthCheckInterval: 3000,
    healthCheckTimeout: 10000,
    logLevel: 'info',

    knownHubIndicators: [
        'hub', 'lobby', 'practice', 'minigame', 'selector',
        'kitpvp', 'bedwars', 'skywars', 'duels', 'parkour',
        'network', 'server selector', 'games'
    ],

    knownSurvivalIndicators: [
        'survival', 'smp', 'earth', 'towny', 'economy',
        'vanilla', 'lifesteal', 'skyblock', 'oneblock',
    ],

    priority: [
        { type: 'public', label: 'Configured SMP' },
        { type: 'lan', label: 'LAN World' },
        { type: 'backup', label: 'Backup SMP' }
    ],

    startupCommands: [],

    serverJoinCommands: [
        '/server survival',
        '/survival',
        '/server {target}',
        '/join survival',
        '/join {target}',
        '/smp',
        '/warp survival',
        '/warp smp',
        '/warp',
        '/server',
        '/hub',
        '/lobby',
    ]
};

export default CONNECTION_CONFIG;

export const ServerState = {
    UNKNOWN: 'unknown',
    CONNECTING: 'connecting',
    PROXY: 'proxy',
    HUB: 'hub',
    LOBBY: 'lobby',
    SELECTING_SERVER: 'selecting_server',
    SURVIVAL: 'survival',
    READY: 'ready',
    DISCONNECTED: 'disconnected',
    ERROR: 'error'
};

export const WorldType = {
    LAN: 'lan',
    SURVIVAL: 'survival',
    SMP: 'smp',
    SKYBLOCK: 'skyblock',
    LIFESTEAL: 'lifesteal',
    PRACTICE: 'practice',
    KITPVP: 'kitpvp',
    BEDWARS: 'bedwars',
    SKYWARS: 'skywars',
    MINIGAME: 'minigame',
    LOBBY: 'lobby',
    HUB: 'hub',
    UNKNOWN: 'unknown'
};

import { createMindServer, registerAgent, numStateListeners } from './mindserver.js';
import { AgentProcess } from '../process/agent_process.js';
import { getServer } from './mcserver.js';
import { connectionManager } from '../connection/ConnectionManager.js';
import open from 'open';

let mindserver;
let connected = false;
let agent_processes = {};
let agent_count = 0;
let mindserver_port = 8080;

export async function init(host_public=false, port=8080, auto_open_ui=true) {
    if (connected) {
        console.error('Already initialized!');
        return;
    }
    mindserver = createMindServer(host_public, port);
    mindserver_port = port;
    connected = true;
    if (auto_open_ui) {
        setTimeout(() => {
            // check if browser listener is already open
            if (numStateListeners() === 0) {
                open('http://localhost:'+port);
            }
        }, 3000);
    }
}

export async function createAgent(settings) {
    if (!settings.profile.name) {
        console.error('Agent name is required in profile');
        return {
            success: false,
            error: 'Agent name is required in profile'
        };
    }
    settings = JSON.parse(JSON.stringify(settings));
    let agent_name = settings.profile.name;
    const agentIndex = agent_count++;
    const viewer_port = 3000 + agentIndex;
    registerAgent(settings, viewer_port);
    let load_memory = settings.load_memory || false;
    let init_message = settings.init_message || null;

    // Allow per-profile server override
    if (settings.profile.server) {
        if (settings.profile.server.host) settings.host = settings.profile.server.host;
        if (settings.profile.server.port != null) settings.port = settings.profile.server.port;
        if (settings.profile.server.auth) settings.auth = settings.profile.server.auth;
        if (settings.profile.server.version) settings.minecraft_version = settings.profile.server.version;
    }

    try {
        // Use ConnectionManager to select target (LAN priority > public SMP)
        try {
            const target = await connectionManager.selectTarget(settings);
            settings.host = target.host;
            settings.port = target.port;
            settings.auth = target.auth;
            settings.minecraft_version = target.minecraft_version;
            settings.connection_source = target.source;
            settings.connection_type = target.type;
        } catch (selectError) {
            // Fallback: if ConnectionManager selects nothing, use original getServer
            console.warn(`[ConnectionManager] Server selection failed: ${selectError.message}. Falling back to direct connection.`);
            const server = await getServer(settings.host, settings.port, settings.minecraft_version);
            settings.host = server.host;
            settings.port = server.port;
            settings.minecraft_version = server.version;
        }

        const agentProcess = new AgentProcess(agent_name, mindserver_port);
        agentProcess.start(load_memory, init_message, agentIndex, { host: settings.host, port: settings.port, auth: settings.auth, minecraft_version: settings.minecraft_version, password: settings.password });
        agent_processes[settings.profile.name] = agentProcess;
    } catch (error) {
        console.error(`Error creating agent ${agent_name}:`, error);
        destroyAgent(agent_name);
        return {
            success: false,
            error: error.message
        };
    }
    return {
        success: true,
        error: null
    };
}

export function getAgentProcess(agentName) {
    return agent_processes[agentName];
}

export function startAgent(agentName) {
    if (agent_processes[agentName]) {
        agent_processes[agentName].forceRestart();
    }
    else {
        console.error(`Cannot start agent ${agentName}; not found`);
    }
}

export function stopAgent(agentName) {
    if (agent_processes[agentName]) {
        agent_processes[agentName].stop();
    }
}

export function destroyAgent(agentName) {
    if (agent_processes[agentName]) {
        agent_processes[agentName].stop();
        delete agent_processes[agentName];
    }
}

export function shutdown() {
    console.log('Shutting down');
    connected = false;
    for (let agentName in agent_processes) {
        agent_processes[agentName].stop();
    }
    if (mindserver) {
        try {
            mindserver.close();
        } catch (e) {
            // ignore close errors
        }
    }
    setTimeout(() => {
        process.exit(0);
    }, 2000);
}

import { Agent } from '../agent/agent.js';
import { serverProxy } from '../agent/mindserver_proxy.js';
import settings from '../agent/settings.js';
import yargs from 'yargs';

// Child agents don't run under main.js, so they need their own global safety
// nets. Without these, any fire-and-forget async rejection kills the process.
process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled Rejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err, origin) => {
    // Exit non-zero so AgentProcess treats it as a crash and restarts us.
    console.error('[FATAL] Uncaught Exception:', err?.stack || err);
    console.error('[FATAL] Origin:', origin);
    process.exit(1);
});

const args = process.argv.slice(2);
if (args.length < 1) {
    console.log('Usage: node init_agent.js -n <agent_name> -p <port> -l <load_memory> -m <init_message> -c <count_id>');
    process.exit(1);
}

const argv = yargs(args)
    .option('name', {
        alias: 'n',
        type: 'string',
        description: 'name of agent'
    })
    .option('load_memory', {
        alias: 'l',
        type: 'boolean',
        description: 'load agent memory from file on startup'
    })
    .option('init_message', {
        alias: 'm',
        type: 'string',
        description: 'automatically prompt the agent on startup'
    })
    .option('count_id', {
        alias: 'c',
        type: 'number',
        default: 0,
        description: 'identifying count for multi-agent scenarios',
    })
    .option('port', {
        alias: 'p',
        type: 'number',
        description: 'port of mindserver'
    })
    .argv;

// Apply server overrides from parent process
try {
    const serverEnv = process.env.MINDCRAFT_SERVER;
    if (serverEnv) {
        const overrides = JSON.parse(serverEnv);
        if (overrides.host) settings.host = overrides.host;
        if (overrides.port != null) settings.port = overrides.port;
        if (overrides.auth) settings.auth = overrides.auth;
        if (overrides.minecraft_version) settings.minecraft_version = overrides.minecraft_version;
        if (overrides.password) settings.password = overrides.password;
    }
} catch (e) {
    console.warn('Failed to parse MINDCRAFT_SERVER env:', e.message);
}

(async () => {
    try {
        const agent = new Agent();
        serverProxy.setAgent(agent);
        console.log('Connecting to MindServer');
        await serverProxy.connect(argv.name, argv.port);

        // Re-apply server overrides AFTER setSettings() resets them
        try {
            const serverEnv = process.env.MINDCRAFT_SERVER;
            if (serverEnv) {
                const overrides = JSON.parse(serverEnv);
                if (overrides.host) settings.host = overrides.host;
                if (overrides.port != null) settings.port = overrides.port;
                if (overrides.auth) settings.auth = overrides.auth;
                if (overrides.minecraft_version) settings.minecraft_version = overrides.minecraft_version;
                if (overrides.password) settings.password = overrides.password;
            }
        } catch (e) {
            console.warn('Failed to re-apply MINDCRAFT_SERVER env:', e.message);
        }

        console.log('Starting agent');
        await agent.start(argv.load_memory, argv.init_message, argv.count_id);
    } catch (error) {
        console.error('Failed to start agent process:');
        console.error(error.message);
        console.error(error.stack);
        process.exit(1);
    }
})().catch(e => {
    // Belt-and-suspenders: the inner catch covers startup failures; this
    // catches anything thrown by the handler chain itself.
    console.error('Fatal error in agent bootstrap:', e?.stack || e);
    process.exit(1);
});

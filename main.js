import * as Mindcraft from './src/mindcraft/mindcraft.js';
import settings from './settings.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { readFileSync, existsSync } from 'fs';
import { TerminalConsole } from './src/console/TerminalConsole.js';
import { safeJSON, safeReadJSON } from './src/utils/safe_json.js';

process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled Rejection at:', promise);
    console.error('[FATAL] Reason:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err, origin) => {
    console.error('[FATAL] Uncaught Exception:', err.stack || err);
    console.error('[FATAL] Origin:', origin);
});

function parseArguments() {
    return yargs(hideBin(process.argv))
        .option('profiles', {
            type: 'array',
            describe: 'List of agent profile paths',
        })
        .option('host', {
            type: 'string',
            describe: 'Minecraft server address (IP or domain)',
        })
        .option('port', {
            type: 'number',
            describe: 'Minecraft server port',
        })
        .option('auth', {
            type: 'string',
            choices: ['offline', 'microsoft'],
            describe: 'Authentication method',
        })
        .option('task_path', {
            type: 'string',
            describe: 'Path to task file to execute'
        })
        .option('task_id', {
            type: 'string',
            describe: 'Task ID to execute'
        })
        .help()
        .alias('help', 'h')
        .parse();
}
const args = parseArguments();
if (args.profiles) {
    settings.profiles = args.profiles;
}
if (args.task_path) {
    let tasks = JSON.parse(readFileSync(args.task_path, 'utf8'));
    if (args.task_id) {
        if (tasks[args.task_id]) {
            settings.task = tasks[args.task_id];
            settings.task.task_id = args.task_id;
        } else {
            // task_id might be an array index if tasks is an array
            const idx = parseInt(args.task_id);
            if (!isNaN(idx) && Array.isArray(tasks) && tasks[idx]) {
                settings.task = { steps: tasks, task_id: args.task_id };
            }
        }
    } else {
        // If no task_id but task_path is provided, treat the whole file as steps
        if (Array.isArray(tasks)) {
            settings.task = { steps: tasks, task_id: 'default' };
        }
    }
}

// Auto-load diamond_grind task if no task specified and auto_task is not explicitly nullified
if (settings.auto_task !== false && !settings.task && existsSync('./tasks/diamond_grind.json')) {
    try {
        const tasks = JSON.parse(readFileSync('./tasks/diamond_grind.json', 'utf8'));
        if (Array.isArray(tasks)) {
            settings._taskSteps = tasks;
            settings.task = null; // Don't use Task class - we'll use TaskRunner directly
            console.log(`[Main] Auto-loaded diamond_grind task (${tasks.length} steps)`);
        }
    } catch (err) {
        console.warn('[Main] Failed to auto-load task:', err.message);
    }
}

if (args.host) {
    settings.host = args.host;
}
if (args.port) {
    settings.port = args.port;
}
if (args.auth) {
    settings.auth = args.auth;
}

// these environment variables override certain settings
if (process.env.MINECRAFT_PORT) {
    settings.port = Number.parseInt(process.env.MINECRAFT_PORT, 10);
}
if (process.env.MINDSERVER_PORT) {
    settings.mindserver_port = Number.parseInt(process.env.MINDSERVER_PORT, 10);
}
const profilesEnv = safeJSON(process.env.PROFILES, []);
if (profilesEnv.length > 0) {
    settings.profiles = profilesEnv;
}
if (process.env.INSECURE_CODING) {
    settings.allow_insecure_coding = true;
}
const blockedActions = safeJSON(process.env.BLOCKED_ACTIONS, null);
if (blockedActions) {
    settings.blocked_actions = blockedActions;
}
if (process.env.MAX_MESSAGES) {
    settings.max_messages = Number.parseInt(process.env.MAX_MESSAGES, 10);
}
if (process.env.NUM_EXAMPLES) {
    settings.num_examples = Number.parseInt(process.env.NUM_EXAMPLES, 10);
}
if (process.env.LOG_ALL) {
    settings.log_all_prompts = process.env.LOG_ALL === 'true' || process.env.LOG_ALL === '1';
}
if (process.env.SETTINGS_JSON) {
    try {
        Object.assign(settings, JSON.parse(process.env.SETTINGS_JSON));
    } catch (err) {
        console.error("Failed to parse environment variable for SETTINGS_JSON:", err);
    }
}


const cleanup = () => {
    console.log('[Main] Shutting down...');
    Mindcraft.shutdown();
    process.exit(0);
};
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

Mindcraft.init(false, settings.mindserver_port, settings.auto_open_ui);

for (let profile of settings.profiles) {
    const profile_json = safeReadJSON(() => readFileSync(profile, 'utf8'), {});
    settings.profile = profile_json;
    Mindcraft.createAgent(settings);
}

// Start terminal console
if (settings.enable_terminal_console !== false) {
    const firstProfile = settings.profiles.length > 0
        ? safeReadJSON(() => readFileSync(settings.profiles[0], 'utf8'), {})
        : {};
    const agentName = firstProfile.name || 'ayushi';
    const console_ = new TerminalConsole(agentName, settings.mindserver_port || 8080);
    setTimeout(() => {
        console_.start().catch(err => console.error('[Terminal] Console error:', err.message));
    }, 5000);
}
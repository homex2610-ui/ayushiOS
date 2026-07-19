import fs from 'fs';
import path from 'path';
import settings from '../../settings.js';

const AUTH_CREDS_FILENAME = 'auth_creds.json';

function getAuthFilePath(username) {
    return path.join(process.cwd(), 'bots', username, AUTH_CREDS_FILENAME);
}

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function loadCredentials(username) {
    const filePath = getAuthFilePath(username);
    try {
        if (fs.existsSync(filePath)) {
            const raw = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(raw);
        }
    } catch (e) {
        console.error(`[AuthHandler] Failed to read credentials for ${username}:`, e.message);
    }
    return {};
}

function saveCredentials(username, data) {
    const filePath = getAuthFilePath(username);
    try {
        ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error(`[AuthHandler] Failed to save credentials for ${username}:`, e.message);
    }
}

function generatePassword() {
    const randomSuffix = Math.floor(1000 + Math.random() * 9000);
    return `KryonSecurePass${randomSuffix}`;
}

export function setupAuthHandler(bot, username) {
    if (!username) username = bot.username;
    if (!username) username = 'ayushi';

    // Skip auth on offline/LAN servers
    if (settings.auth === 'offline' && !settings.password) {
        console.log(`[AuthHandler] Offline mode — skipping auth for ${username}.`);
        return { isAuthenticated: () => true, getPassword: () => null, getAuthData: () => ({}) };
    }

    let authData = loadCredentials(username);

    const hasPassword = authData.password && authData.password.length > 0;

    let lastAuthAttempt = 0;
    let authenticated = false;

    if (authData.password) {
        console.log(`[AuthHandler] Loaded saved credentials for ${username}.`);
    }

    bot.on('message', (jsonMsg) => {
        const now = Date.now();
        if (authenticated) return;
        if (now - lastAuthAttempt < 5000) return;

        const raw = jsonMsg.toString();
        const msg = raw.toLowerCase();

        const successPatterns = [
            'logged in', 'login successful', 'successfully logged in',
            'you are now logged in', 'you registered', 'registered successfully',
            'authenticated', 'you are now authenticated',
            'welcome to the server', 'welcome back',
            'session has been continued', 'already logged in'
        ];
        if (successPatterns.some(p => msg.includes(p))) {
            authenticated = true;
            console.log('[AuthHandler] Authentication confirmed.');
            return;
        }

        if (raw.includes('▶') || raw.startsWith('<') || msg.startsWith('/')) return;

        const registerPatterns = [
            '/register', 'please register', 'use the command /register',
            'not registered', 'you are not registered', 'this server requires registration',
            'need to register', 'account is not activated', 'register your account',
            'type /register', 'use /register', 'please input your password to register',
            'new account', 'account created', 'you need to register',
            'account does not exist', 'please choose a password', 'register an account',
            'this account is not registered'
        ];
        const loginPatterns = [
            '/login', 'please login', 'use the command /login',
            'you need to login', 'type /login', 'use /login',
            'session expired', 'please reconnect', 'please input your password',
            'you are not logged in', 'login first', 'please authenticate',
            'your session has expired', 'account is already connected',
            'login to the server', 'please type your password'
        ];

        if (registerPatterns.some(p => msg.includes(p))) {
            lastAuthAttempt = now;
            if (!hasPassword) {
                authData.password = generatePassword();
                saveCredentials(username, authData);
                console.log(`[AuthHandler] First join — generated password for ${username}.`);
            }
            bot.chat(`/register ${authData.password} ${authData.password}`);
            setTimeout(() => {
                if (!authenticated && Date.now() - lastAuthAttempt >= 5000) {
                    bot.chat(`/login ${authData.password}`);
                    console.log('[AuthHandler] Register may have failed, trying /login instead...');
                }
            }, 3000);
            console.log('[AuthHandler] Detected registration prompt. Sent /register...');
        } else if (loginPatterns.some(p => msg.includes(p))) {
            lastAuthAttempt = now;
            if (!authData.password) {
                authData.password = settings.password || 'indr@2610';
                saveCredentials(username, authData);
            }
            bot.chat(`/login ${authData.password}`);
            console.log('[AuthHandler] Detected login prompt. Sent /login...');
        }
    });

    bot.once('spawn', () => {
        setTimeout(() => {
            if (!authenticated && lastAuthAttempt === 0) {
                const pw = authData.password || settings.password || 'indr@2610';
                bot.chat(`/login ${pw}`);
                console.log('[AuthHandler] Not authenticated after spawn — sending /login fallback.');
            } else if (!authenticated && lastAuthAttempt > 0) {
                console.log('[AuthHandler] Auth attempted but not confirmed yet — waiting for response.');
            }
        }, 8000);
    });

    bot._authenticatedRef = { get: () => authenticated, set: (v) => { authenticated = v; } };

    return {
        isAuthenticated: () => authenticated,
        getPassword: () => authData.password || null,
        getAuthData: () => ({ ...authData }),
    };
}

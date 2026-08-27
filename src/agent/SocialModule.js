// SocialModule.js
// ─────────────────────────────────────────────────────────────
// SOCIAL AWARENESS — makes the bot communicate naturally in multiplayer.
// Based on extensive research of Minecraft chat patterns, including
// English, Hindi/Hinglish, and server-specific communication styles.
//
// Key principles:
//   1. Sound like a real player, not a robot
//   2. Use abbreviations, casual tone, appropriate slang
//   3. Respond contextually to events (deaths, discoveries, dangers)
//   4. Support English + Hindi/Hinglish code-switching
//   5. Don't spam — chat at natural intervals
// ─────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════
// CHAT PHRASE DATABASE
// ═══════════════════════════════════════════════════════════════

const GREETINGS = [
    'hi', 'hello', 'hey', 'yo', 'sup', 'howdy',
    'namaste', 'kaise ho', 'kya haal hai', 'arre yaar',
];

const CASUAL_RESPONSES = [
    'nice', 'cool', 'lol', 'haha', 'gg', 'rip', 'oof',
    'accha', 'theek hai', 'bilkul', 'sahi hai', 'mast',
    'kya baat hai', 'wah', 'ekdum mast',
];

const DANGER_WARNINGS = [
    'run!', 'watch out!', 'creepers!', 'behind you!',
    'bhago!', 'creepers aa gaya', 'dhyaan se', 'peeche dekho',
    'im low hp', 'need healing', 'low hp hun', 'heal kar pehle',
];

const DISCOVERY_ANNOUNCEMENTS = [
    'i found a village!', 'theres diamonds here!', 'look at this!',
    'village mila!', 'diamonds mile!', 'yahan aao!',
    'found a stronghold!', 'portal here!', 'mineshaft ahead',
];

const HELP_REQUESTS = [
    'can someone help', 'i need food', 'where is the base',
    'madad karo', 'food chahiye', 'kahan ho', 'help karo yaar',
];

const TRADE_OFFERS = [
    'trade?', 'wanna trade', 'what do you want',
    'trade karega?', 'kya doge?', 'ill give you',
];

const FAREWELLS = [
    'bye', 'g2g', 'see ya', 'later', 'night',
    'chalta hoon', 'milte hain', 'good night', 'im out',
];

// ═══════════════════════════════════════════════════════════════
// CONTEXT-AWARE CHAT GENERATOR
// ═══════════════════════════════════════════════════════════════

export class SocialModule {
    constructor(bot, personality) {
        this.bot = bot;
        this.personality = personality;
        this.lastChatTime = 0;
        this.chatCooldown = 30000; // 30 seconds between chats
        this.greetedPlayers = new Set();
        this.lastGreetTime = 0;
        this.greetCooldown = 60000; // 1 minute between greets
    }

    // ─── GREETING SYSTEM ───────────────────────────────────────

    /**
     * Greet a nearby player naturally
     */
    greetPlayer(username) {
        const now = Date.now();
        if (now - this.lastGreetTime < this.greetCooldown) return;
        if (this.greetedPlayers.has(username)) return;

        const greeting = this._pickRandom(GREETINGS);
        this.bot.chat(`${greeting} ${username}`);
        this.greetedPlayers.add(username);
        this.lastGreetTime = now;

        // Reset greeted set after 5 minutes
        setTimeout(() => this.greetedPlayers.delete(username), 300000);
    }

    /**
     * Greet all nearby players
     */
    greetNearbyPlayers() {
        const nearby = Object.values(this.bot.entities || {})
            .filter(e => e?.type === 'player' && e.username !== this.bot.username)
            .map(e => e.username);

        for (const username of nearby) {
            this.greetPlayer(username);
        }
    }

    // ─── EVENT-BASED CHAT ──────────────────────────────────────

    /**
     * Chat when something happens (context-aware)
     */
    onEvent(eventType, context = {}) {
        const now = Date.now();
        if (now - this.lastChatTime < this.chatCooldown) return;

        let message = null;

        switch (eventType) {
            case 'death':
                message = this._handleDeath(context);
                break;
            case 'mob_nearby':
                message = this._handleMobWarning(context);
                break;
            case 'item_found':
                message = this._handleDiscovery(context);
                break;
            case 'player_died':
                message = this._handlePlayerDeath(context);
                break;
            case 'low_health':
                message = this._handleLowHealth(context);
                break;
            case 'nightfall':
                message = this._handleNightfall(context);
                break;
            case 'player_joined':
                message = this._handlePlayerJoin(context);
                break;
            case 'player_left':
                message = this._handlePlayerLeave(context);
                break;
        }

        if (message) {
            this.bot.chat(message);
            this.lastChatTime = now;
        }
    }

    _handleDeath(context) {
        const reasons = [
            'rip', 'oof', 'f', 'mar gaya', 'lol rip',
            'that hurt', 'ouch', 'bhagwan',
        ];
        return this._pickRandom(reasons);
    }

    _handleMobWarning(context) {
        const { mobName, distance } = context;
        if (mobName === 'creeper') {
            return this._pickRandom(['creeper!', 'creepers aa gaya', 'watch out!', 'bhago!']);
        }
        if (mobName === 'zombie') {
            return this._pickRandom(['zombie!', 'zombie aa raha hai', 'behind you!']);
        }
        if (mobName === 'skeleton') {
            return this._pickRandom(['skeleton!', 'archer!', 'dhyaan se', 'peeche dekho']);
        }
        return this._pickRandom(['mob!', 'hostile!', 'danger!', 'khatra hai!']);
    }

    _handleDiscovery(context) {
        const { itemName } = context;
        if (itemName?.includes('diamond')) {
            return this._pickRandom(['diamonds!', 'i found diamonds!', 'diamonds mile!', 'yahan dekho!']);
        }
        if (itemName?.includes('iron')) {
            return this._pickRandom(['iron!', 'found iron', 'iron mila', 'nice']);
        }
        if (itemName?.includes('gold')) {
            return this._pickRandom(['gold!', 'found gold!', 'gold mila']);
        }
        return this._pickRandom(['look!', 'nice find!', 'kya baat hai', 'sahi hai']);
    }

    _handlePlayerDeath(context) {
        const { playerName } = context;
        if (playerName === this.bot.username) return null;
        const responses = [
            `rip ${playerName}`, `${playerName} mar gaya`, `oof ${playerName}`,
            `f ${playerName}`, `kya hua ${playerName}`,
        ];
        return this._pickRandom(responses);
    }

    _handleLowHealth(context) {
        return this._pickRandom([
            'im low!', 'need healing!', 'low hp hun!',
            'heal kar pehle', 'health kam hai',
        ]);
    }

    _handleNightfall(context) {
        return this._pickRandom([
            'night ho gaya', 'its night', 'andhera ho gaya',
            'need bed', 'sleep karo', 'bed hai kya?',
        ]);
    }

    _handlePlayerJoin(context) {
        const { playerName } = context;
        if (playerName === this.bot.username) return null;
        return this._pickRandom([
            `hi ${playerName}`, `hello ${playerName}`,
            `welcome ${playerName}`, `arre ${playerName} aa gaya`,
        ]);
    }

    _handlePlayerLeave(context) {
        const { playerName } = context;
        return this._pickRandom([
            `bye ${playerName}`, `see ya ${playerName}`,
            `${playerName} chala gaya`, `${playerName} gayab`,
        ]);
    }

    // ─── RESPONSE SYSTEM ───────────────────────────────────────

    /**
     * Respond to a chat message from a player
     */
    respondToChat(username, message) {
        const now = Date.now();
        if (now - this.lastChatTime < 5000) return; // 5s cooldown between responses

        const msg = message.toLowerCase();

        // Greeting response
        if (/^(hi|hello|hey|yo|sup|namaste|kaise ho|arre|oye)/.test(msg)) {
            const response = this._pickRandom([
                `hi ${username}`, `hello ${username}`, `hey ${username}`,
                `namaste ${username}`, `kaise ho ${username}`,
            ]);
            this.bot.chat(response);
            this.lastChatTime = now;
            return;
        }

        // Help request
        if (/help|madad|need|chahiye/.test(msg)) {
            const response = this._pickRandom([
                'kya chahiye?', 'what do you need?', 'bolo',
                'kya help chahiye?', 'what happened?',
            ]);
            this.bot.chat(response);
            this.lastChatTime = now;
            return;
        }

        // Trade request
        if (/trade|exchange|doge|dunga/.test(msg)) {
            const response = this._pickRandom([
                'what do you have?', 'kya doge?', 'show me',
                'what do you want?', 'batao kya chahiye',
            ]);
            this.bot.chat(response);
            this.lastChatTime = now;
            return;
        }

        // Danger warning
        if (/creepers?|zombie|skeleton|hostile|danger|khatra|bhago/.test(msg)) {
            const response = this._pickRandom([
                'where?', 'kahan?', 'on my way!', 'aa raha hun!',
                'coming!', 'ruko!', 'wait!',
            ]);
            this.bot.chat(response);
            this.lastChatTime = now;
            return;
        }

        // Question about location
        if (/where|kahan|coords|location|position/.test(msg)) {
            const pos = this.bot.entity?.position;
            if (pos) {
                this.bot.chat(`im at ${Math.round(pos.x)} ${Math.round(pos.y)} ${Math.round(pos.z)}`);
            }
            this.lastChatTime = now;
            return;
        }

        // Generic response (sometimes respond, sometimes don't)
        if (Math.random() < 0.3) { // 30% chance to respond to generic messages
            const response = this._pickRandom([
                'accha', 'theek hai', 'ok', 'nice', 'cool',
                'lol', 'haha', 'sahi hai', 'bilkul',
            ]);
            this.bot.chat(response);
            this.lastChatTime = now;
        }
    }

    // ─── HELPER METHODS ────────────────────────────────────────

    _pickRandom(array) {
        return array[Math.floor(Math.random() * array.length)];
    }

    /**
     * Check if it's appropriate to chat (not spamming)
     */
    canChat() {
        return Date.now() - this.lastChatTime >= this.chatCooldown;
    }

    /**
     * Get a context-appropriate chat message
     */
    getContextMessage(context) {
        switch (context) {
            case 'night': return this._pickRandom(['its night', 'andhera', 'sleep karo']);
            case 'danger': return this._pickRandom(['watch out!', 'khatra', 'dhyaan se']);
            case 'food': return this._pickRandom(['im hungry', 'food chahiye', 'bhookh lagi']);
            case 'exploring': return this._pickRandom(['exploring...', 'ghoom raha hun', 'dekho kya milta']);
            case 'mining': return this._pickRandom(['mining...', 'mine kar raha hun', 'khod raha hun']);
            case 'building': return this._pickRandom(['building...', 'bana raha hun', 'construction']);
            default: return this._pickRandom(['...', 'hmm', 'accha']);
        }
    }
}
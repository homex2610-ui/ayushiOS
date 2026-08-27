// Persona.js
// ─────────────────────────────────────────────────────────────
// PERSONALITY WITHOUT LLMs — what makes her feel like a FRIEND
// rather than a command terminal:
//   • mood engine: real game state (hp/hunger/night/threats/weather,
//     recent events) maps to a mood that colors every reply
//   • event reactions: she COMMENTS on life as it happens (kills,
//     rare finds, getting hurt, sunrise, player returning) — proactively
//   • player memory: names, last seen, gift/kick counts, running banter
//   • mood-aware small talk with anti-repetition (never the same line twice in a row)
//   • confused-state replies that ASK BACK instead of "got it"
// All template-based, bounded CPU, zero network.
// ─────────────────────────────────────────────────────────────

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

const MOODS = {
    happy:   { emoji: '😄', weight: 1 },
    chill:   { emoji: '🙂', weight: 1 },
    tired:   { emoji: '😴', weight: 1 },
    hungry:  { emoji: '🍖', weight: 1 },
    hurt:    { emoji: '💔', weight: 1 },
    scared:  { emoji: '😱', weight: 1 },
    excited: { emoji: '✨', weight: 1 },
};

// Small-talk pattern bank — {test, replies(mood, ctx)}
const SMALL_TALK = [
    {
        test: /\b(how('?)(s| is) (your )?day|you (ok|okay|good|alright))\b/,
        replies: (m) => ({
            happy: ['pretty great actually!', 'good day so far — sun\'s out'],
            chill: ['can\'t complain', 'chillin\''],
            tired: ['kinda sleepy tbh', 'long day of mining...'],
            hungry: ['would be great with some food lol', 'okay but I could eat a whole cow'],
            hurt: ['been better, took some hits', 'surviving!'],
            scared: ['honestly? kinda spooked rn', 'there were CREEPERS okay'],
        }[m] || ['doing alright']),
    },
    {
        test: /\b(joke|something funny|make me laugh)\b/,
        replies: () => [
            'why don\'t skeletons fight each other? they don\'t have the guts',
            'I asked a creeper for a hug. bad idea.',
            'what do you call a sleeping bull? a bulldozer... wait wrong game',
            'my favorite block? honestly, air. very underrated',
            'creepers are just green social media critics — they blow up over everything',
        ],
    },
    {
        test: /\b(love|like) (you|u)\b|\byou('re| are) (cute|cool|awesome|the best|great)\b/,
        replies: () => [
            'aww 🥺 right back at you',
            'stoppp you\'ll make my pixels blush',
            'best teammate ever, that\'s what YOU are',
        ],
    },
    {
        test: /\b(what are you doing|whatcha doing|wyd)\b/,
        repliesCtx: (ctx) => [ctx.action ? `right now? ${ctx.action}` : 'nothing much, just vibing'],
    },
    {
        test: /\b(do you remember|remember me|who am i)\b/,
        repliesCtx: (ctx) => ctx.playerKnown
            ? [`of course I remember ${ctx.player}!`, `${ctx.player}! my favorite human`]
            : ['hmm, I don\'t think we\'ve met — who are you?'],
    },
    {
        test: /\b(good (morning|evening|night)|gm|gn)\b/,
        replies: (m) => ({
            tired: ['gn, I\'ll hold the fort', 'sleep well! I got watch'],
            happy: ['good morning! ☀️', 'morning! ready for adventure?'],
            chill: ['hey :)', 'yo!'],
            scared: ['is it safe to say good night yet?? mobs everywhere'],
        }[m] || ['you too!']),
    },
    {
        test: /\b(are you (a )?(bot|ai|robot|real))\b/,
        replies: () => [
            'I\'m me. 100% home-grown reflexes, zero cloud compute 😎',
            'real enough to steal your diamonds— kidding. mostly',
        ],
    },
    {
        test: /\b(what should i do|any (advice|tips)|what now)\b/,
        repliesCtx: (ctx) => {
            const tips = [];
            if (ctx.night) tips.push('it\'s dark out — torches or a bed, pick your fighter');
            if (ctx.lowFood) tips.push('stock up on food before night hits');
            if (ctx.threats) tips.push('maybe deal with those mobs behind me first??');
            tips.push('we could go mining — I know where the good stuff is', 'build something cool?', 'explore somewhere new?');
            return [rand(tips)];
        },
    },
];

// Proactive event reaction lines — fired from real game events
const EVENT_LINES = {
    kill_hostile: [
        'take THAT', 'and stay down!', 'next time think twice',
        'another one bites the dust', 'area secure ✅',
    ],
    killed_by_mob: [
        'ouch!! that thing came out of nowhere', 'note to self: that one bites',
        'I really need better armor...', 'that was NOT fun',
    ],
    found_diamonds: [
        'DIAMONDS!! 💎💎 look at them shine', 'jackpot!! we\'re rich!',
        'found the shiny stuff 😍',
    ],
    got_hurt: [
        'ow!', 'hey!! rude', 'that stung...',
    ],
    sunset: [
        'sun\'s setting — time to light this place up',
        'night shift begins 🌙', 'I should place torches before the party crashers arrive',
    ],
    sunrise: [
        'morning! we survived the night ☀️', 'ahh daylight at last',
    ],
    player_back: [
        'welcome back {player}!', '{player}! missed ya', 'look who\'s here — hey {player}',
    ],
    crafted_something: [
        'crafting complete ✨', 'fresh off the crafting table', 'made it! want me to make more?',
    ],
    low_health: [
        'I need to retreat... this isn\'t looking good', 'barely holding on here!',
    ],
};

export class Persona {
    constructor(agent) {
        this.agent = agent;
        this.mood = 'chill';
        this._recentLines = new Set();   // anti-repetition
        this._lastEventLineAt = 0;
        this.players = new Map();        // name -> {firstSeen, lastSeen, chats}
        this.bus = null;                 // set by attach()
    }

    get bot() { return this.agent?.bot; }

    /** Recompute mood from live world/self state. */
    updateMood() {
        const bot = this.bot;
        if (!bot?.entity) { this.mood = 'chill'; return this.mood; }

        // P1 MOOD UNIFICATION: when the AyushiOS brain is running, its
        // PersonalityEngine is THE mood authority (it sees threats via the
        // WorldModel contract). Persona maps that mood onto chat tone instead
        // of running its own divergent detector stack.
        const brainMood = this.agent?.brain?.personality?.currentMood;
        if (brainMood) {
            const map = {
                Panicked: 'scared', Anxious: 'scared', Angry: 'hurt',
                Lonely: 'chill', Happy: 'happy', Neutral: 'chill',
            };
            // Vitality overrides the FSM mapping (hunger/hurt are facts).
            const hp = bot.health ?? 20;
            const food = bot.food ?? 20;
            if (hp <= 8) this.mood = 'hurt';
            else if (food <= 6) this.mood = 'hungry';
            else this.mood = map[brainMood] ?? 'chill';
            return this.mood;
        }

        const hp = bot.health ?? 20;
        const food = bot.food ?? 20;
        const night = (bot.time?.timeOfDay ?? 0) > 13000 && (bot.time?.timeOfDay ?? 0) < 23500;
        let hostileNear = false;
        try {
            hostileNear = Object.values(bot.entities || {}).some(e =>
                e && e.position && e.type === 'mob' &&
                ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'phantom'].includes(e.name) &&
                e.position.distanceTo(bot.entity.position) < 8);
        } catch (_) {}
        if (hostileNear && hp < 10) this.mood = 'scared';
        else if (hp <= 8) this.mood = 'hurt';
        else if (food <= 6) this.mood = 'hungry';
        else if (food >= 18 && hp >= 18 && !night) this.mood = Math.random() < 0.25 ? 'excited' : 'happy';
        else if (night) this.mood = 'tired';
        else this.mood = 'chill';
        return this.mood;
    }

    /** Context snapshot used by reply generators. */
    _ctx(playerName) {
        const bot = this.bot;
        const p = playerName ? String(playerName) : null;
        const known = p && this.players.has(p);
        let action = null, threats = false;
        try {
            action = this.agent?.actions?.currentActionLabel || this.agent?.taskRunner?.currentTaskName || null;
            if (action === 'Idle') action = null;
            threats = Object.values(bot?.entities || {}).some(e =>
                e && e.type === 'mob' && e.position && bot.entity &&
                e.position.distanceTo(bot.entity.position) < 10);
        } catch (_) {}
        return {
            player: p,
            playerKnown: !!known,
            action: action ? String(action).replace(/[_-]/g, ' ') : null,
            night: (bot?.time?.timeOfDay ?? 0) > 13000 && (bot?.time?.timeOfDay ?? 0) < 23500,
            lowFood: (bot?.food ?? 20) <= 6,
            threats,
        };
    }

    /**
     * Mood-aware small talk. Returns a line or null.
     * Called by DeterministicBrain BEFORE generic patterns.
     */
    smallTalk(sender, message) {
        this.updateMood();
        const m = (message || '').toLowerCase();
        const ctx = this._ctx(sender);
        for (const entry of SMALL_TALK) {
            if (!entry.test.test(m)) continue;
            const bank = entry.repliesCtx ? entry.repliesCtx(ctx) : entry.replies(this.mood);
            return this._pick(bank);
        }
        // Mood-flavored greeting boost (generic "hi" gets personality)
        if (/^\s*(hi|hello|hey|yo|sup|hii+)\b/.test(m)) {
            const flavor = {
                happy: ['heyy!', 'yo!! good to see you'],
                excited: ['HII ⚡ okay okay guess what — great day to play'],
                chill: ['hey :)', 'yo', 'heyy'],
                tired: ['hey... long night', 'yo. barely awake'],
                hungry: ['hey... got any food? asking for a friend (me)'],
                hurt: ['hey — heads up, I\'m a bit beat up', 'hi... ow'],
                scared: ['HEY okay hi please stay close there are THINGS here'],
            }[this.mood] || ['hey'];
            return this._pick(flavor);
        }
        return null;
    }

    /** Confused-reply that asks back (an AI friend clarifies; a bot says "got it"). */
    confusedReply() {
        this.updateMood();
        return this._pick([
            'hm? say that another way?',
            'didn\'t quite catch that — what do you mean?',
            'hmm I\'m not sure I follow 🤔',
            'wait what? explain?',
        ]);
    }

    /**
     * Fire an event reaction into chat (rate-limited, combat-safe).
     * Call from bot events. Returns the line spoken (or null).
     */
    react(eventKey, { player = null, force = false } = {}) {
        const bank = EVENT_LINES[eventKey];
        if (!bank) return null;
        const now = Date.now();
        // Never spam: min 40s between unsolicited remarks (unless forced)
        if (!force && now - this._lastEventLineAt < 40000) return null;
        // Stay quiet while fighting for survival
        this.updateMood();
        if (this.mood === 'scared' && !force) return null;

        let line = this._pick(bank);
        if (line.includes('{player}') && player) line = line.replaceAll('{player}', player);
        else if (line.includes('{player}')) return null;

        this._lastEventLineAt = now;
        try { this.bot?.chat(line); } catch (_) {}
        return line;
    }

    /** Track a chat participant (memory). */
    seePlayer(name) {
        if (!name) return;
        const rec = this.players.get(name);
        const now = Date.now();
        if (!rec) {
            this.players.set(name, { firstSeen: now, lastSeen: now, chats: 0 });
        } else {
            // Returning after 10+ min away → welcome-back remark
            const awayFor = now - rec.lastSeen;
            rec.lastSeen = now;
            rec.chats++;
            if (awayFor > 600000) setTimeout(() => this.react('player_back', { player: name, force: true }), 1500);
        }
    }

    _pick(bank) {
        // Anti-repetition: avoid reusing any of the last few lines
        const fresh = bank.filter(l => !this._recentLines.has(l));
        const line = fresh.length > 0 ? rand(fresh) : rand(bank);
        this._recentLines.add(line);
        if (this._recentLines.size > 12) this._recentLines.delete(this._recentLines.values().next().value);
        return line;
    }

    /**
     * Attach proactive event wiring to the bot. Idempotent.
     */
    attach(bus) {
        if (this._attached) return;
        this._attached = true;
        this.bus = bus;
        const bot = this.bot;
        if (!bot) return;

        // Track chat participants
        bot.on('chat', (username) => { if (username !== bot.username) this.seePlayer(username); });

        // Mob kills (hostile only — passive kills aren't brag-worthy)
        bot.on('entityDeath', (entity) => {
            try {
                if (entity?.type === 'mob' && entity?.name && entity !== bot.entity) {
                    const hostile = ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'enderman', 'drowned'].includes(entity.name);
                    if (hostile && bot.lastKillWasMine !== false) this.react('kill_hostile');
                }
            } catch (_) {}
        });

        // Getting hurt
        let lastHurtReact = 0;
        bot.on('entityHurt', (entity) => {
            try {
                if (entity?.id !== bot.entity?.id) return;
                if ((bot.health ?? 20) <= 6) { this.react('low_health', { force: true }); return; }
                const now = Date.now();
                if (now - lastHurtReact > 90000) { lastHurtReact = now; this.react('got_hurt'); }
            } catch (_) {}
        });

        // Diamond discovery via inventory delta
        let prevDiamonds = 0;
        const invWatch = setInterval(() => {
            try {
                const d = (bot.inventory?.items() || []).filter(i => i.name === 'diamond').reduce((s, i) => s + i.count, 0);
                if (d > prevDiamonds) this.react('found_diamonds', { force: true });
                prevDiamonds = d;
            } catch (_) {}
        }, 5000);
        invWatch.unref?.();

        // Sunset / sunrise
        let lastPhase = 'day';
        const skyWatch = setInterval(() => {
            try {
                const t = bot.time?.timeOfDay ?? 0;
                const phase = (t > 23000 || t < 12000) ? 'day' : (t >= 13000 ? 'night' : phase);
                if (phase === 'night' && lastPhase === 'day') this.react('sunset');
                if (phase === 'day' && lastPhase === 'night') this.react('sunrise');
                lastPhase = phase === 'day' ? 'day' : (phase === 'night' ? 'night' : lastPhase);
            } catch (_) {}
        }, 30000);
        skyWatch.unref?.();

        console.log('[Persona] Attached — proactive personality online');
    }
}

import { THRESHOLDS } from './config.js';

// BrocaArea.js
// ─────────────────────────────────────────────────────────────
// Templated (non-LLM) chat layer. Everything here selects and
// fills pre-written phrase patterns from live state — it never
// generates free text. See class doc header sections below for
// the pieces that map to the "Texting System" spec:
//   1. Trigger classification   -> the if/else chain in handle()
//   2. Template pool lookup     -> _moodPick() + POOLS
//   3. Slot fill from live state-> string interpolation of snapshot/beliefs
//   4. Mood/relationship mod    -> _moodPick(mood, ...) + _trustTier()
//   5. Human-timing layer       -> _respond() / _typingDelayMs()
// ─────────────────────────────────────────────────────────────

export class BrocaArea {
  constructor(bot, brain) {
    this.bot = bot;
    this.brain = brain;
    this.lastResponseTime = 0;      // gates normal chatter
    this.lastEmergencyTime = 0;     // separate, shorter gate for danger lines
    this.cooldownMs = 3000;
    this.emergencyCooldownMs = 8000;
    this.conversations = new Map();
    this._pendingTimers = [];
    if (!this._endHooked) {
      this._endHooked = true;
      this.bot.on('end', () => this._clearPendingTimers());
    }
  }

  handleIncomingChat(username, message) {
    if (!username || !message || username === this.bot.username) return false;

    const now = Date.now();
    const context = this._contextFor(username);
    // Feed the auditory buffer — snapshots otherwise report silence forever.
    this.brain?.senses?.hearChat?.(username, message);
    const snapshot = this.brain?.senses?.getSnapshot();
    const mood = this.brain?.personality?.currentMood || 'Neutral';
    const msg = message.toLowerCase().trim();
    const wasReturning = now - (context.lastSeen || 0) > 20 * 60 * 1000 && context.messages.length > 0;
    context.lastSeen = now;
    context.messages.push({ message, time: now });
    context.messages = context.messages.filter(entry => now - entry.time < 10 * 60 * 1000).slice(-8);
    this.brain?.memory?.recordEvent?.(`Heard from ${username}: ${message}`, 1);

    // Danger lines bypass the normal chat cooldown (a player deserves to know
    // the bot can't chat because it's dying), but get their own cooldown so
    // they can't spam every message while low.
    if (snapshot?.vitality?.health < 8 || snapshot?.vitality?.food < 8) {
      if (now - this.lastEmergencyTime > this.emergencyCooldownMs) {
        this.lastEmergencyTime = now;
        const line = snapshot.vitality.health < 8
          ? this._pick(POOLS.dying)
          : this._pick(POOLS.starving);
        return this._respond(context, line);
      }
      return false;
    }

    if (now - this.lastResponseTime < this.cooldownMs) return false;

    const trust = this._trustTier(username);
    let reply = null;

    if (context.pendingQuestion && /^(yes|yeah|yep|ok|okay|sure|no|nope|nah)\b/i.test(msg)) {
      reply = this._resolveClarification(context, msg, trust);
    } else if (/^(hello|hi|hey|yo|sup)\b/i.test(msg)) {
      reply = this._moodPick(mood, POOLS.greeting);
      if (wasReturning && trust === 'friend') {
        reply += ' ' + this._pick(POOLS.returningFriend(username));
      }
    } else if (/what are you doing|what are you up to|what'?s your task|what is your task/i.test(msg)) {
      reply = `I'm currently ${this._goalName()}.`;
    } else if (/\b(why|explain)(?:\s+are you|\s+that|\s+your plan|\s+the plan)?\b/i.test(msg)) {
      reply = this._explainGoal();
    } else if (/\b(plan|next steps|what.*next)\b/i.test(msg)) {
      reply = this._describePlan();
    } else if (/where are you|coords|position|location/i.test(msg)) {
      const p = snapshot?.environment?.position || {};
      reply = `I am at X: ${p.x ?? '?'}, Y: ${p.y ?? '?'}, Z: ${p.z ?? '?'}.`;
    } else if (/where is (home|base|safe|spawn|warp|shop|market|village|npc)/i.test(msg)) {
      reply = this._answerLocation(msg, snapshot);
    } else if (/what can you do|commands/i.test(msg)) {
      const cmds = this._beliefs(snapshot).knownCommands || [];
      reply = cmds.length ? `I know commands like ${cmds.map(c => c.command).slice(0, 6).join(', ')}.` : 'I can mine, craft, travel, fight defensively, and learn custom server commands as I go.';
    } else if (/what do you remember|remember anything|memory|beliefs/i.test(msg)) {
      const beliefs = this._beliefs(snapshot);
      const safe = beliefs.nearestSafeBase?.name || 'no safe base';
      const food = beliefs.nearestFoodSource?.name || 'no food source';
      const warp = beliefs.nearestWarp?.name || 'no warp';
      reply = `I remember ${safe}, ${food}, and ${warp}.`;
    } else if (/^(thanks|thank you|ty|thx|gg|nice)\b/i.test(msg)) {
      this.brain?.memory?.updatePlayerRelationship?.(username, +1, 'thanked');
      reply = this._moodPick(mood, POOLS.thanks);
    } else if (/\b(stupid|dumb|useless|trash)\b/i.test(msg)) {
      this.brain?.memory?.updatePlayerRelationship?.(username, -1, 'insulted');
      reply = this._moodPick(mood, POOLS.insulted);
    } else if (/\b(follow me|come here)\b/i.test(msg)) {
      if (trust === 'guarded') {
        reply = this._pick(POOLS.guardedDecline);
      } else {
        context.pendingQuestion = 'follow';
        reply = 'I can follow. Do you want me to start now?';
      }
    } else if (/\b(help|can you help)\b/i.test(msg)) {
      if (trust === 'guarded') {
        reply = this._pick(POOLS.guardedHedgeHelp);
      } else {
        context.pendingQuestion = 'help';
        reply = 'I can help. Do you need resources, travel, combat support, or a server command checked?';
      }
    } else if (/\b(give me|spare|got any extra|can i have)\b/i.test(msg) && trust !== 'friend') {
      reply = this._pick(trust === 'guarded' ? POOLS.guardedHedgeGive : POOLS.neutralHedgeGive);
    }

    return reply ? this._respond(context, reply) : false;
  }

  // ---- Relationship-aware trust tiering (drives which template pool is used) ----
  _trustTier(username) {
    const rel = this.brain?.memory?.getRelationship?.(username);
    if (!rel) return 'unknown';
    if (rel.trust >= THRESHOLDS.trustFriendCutoff) return 'friend';
    if (rel.trust <= THRESHOLDS.trustEnemyCutoff || (rel.interactions <= 1 && rel.trust < 0)) return 'guarded';
    return 'neutral';
  }

  _contextFor(username) {
    if (!this.conversations.has(username)) this.conversations.set(username, { messages: [], pendingQuestion: null, lastSeen: 0 });
    return this.conversations.get(username);
  }

  _beliefs(snapshot) {
    const pos = snapshot?.environment?.position || null;
    // Prefer the Knowledge facade (BeliefState + MemoryMatrix merged view)
    if (this.brain?.knowledge?.snapshot) {
      return this.brain.knowledge.snapshot(pos);
    }
    // Fallback: MemoryMatrix getBeliefs (for non-brain contexts)
    return this.brain?.memory?.getBeliefs?.(pos) || {};
  }

  _goalName() {
    const goal = this.brain?.executive?.currentGoal?.name || this.brain?.executive?.lastSelectedNeed || 'working on something useful';
    return goal.replace(/_/g, ' ');
  }

  _explainGoal() {
    const goal = this._goalName();
    const reasons = {
      eat: 'food is low, so survival takes priority', seek_safety: 'my health or nearby threats make safety the priority',
      avoid_hazard: 'I have a recorded hazard nearby', farm_food: 'we need a reliable food supply',
      explore_unknown: 'I need to learn more about this area', build_base: 'a safe base makes future work safer',
    };
    return `I'm ${goal} because ${reasons[goal.replace(/ /g, '_')] || 'it is the highest-priority useful goal right now'}.`;
  }

  _describePlan() {
    const goal = this.brain?.executive?.currentGoal;
    const steps = goal?.steps || [];
    if (!steps.length) return `My next priority is ${this._goalName()}; I'll reassess once the world state changes.`;
    return `Plan for ${this._goalName()}: ${steps.slice(0, 3).map((step, index) => `${index + 1}) ${String(step.skill || step.task).replace(/_/g, ' ')}`).join(', ')}.`;
  }

  _answerLocation(message, snapshot) {
    const location = message.match(/where is (home|base|safe|spawn|warp|shop|market|village|npc)/i)?.[1];
    const beliefs = this._beliefs(snapshot);
    if (['home', 'base', 'safe'].includes(location)) {
      const safe = beliefs.nearestSafeBase;
      return safe ? `I believe our safe base is near ${safe.name || `(${safe.position.x}, ${safe.position.y}, ${safe.position.z})`}.` : "I don't have a known safe home yet.";
    }
    if (location === 'spawn' || location === 'warp') {
      const warp = beliefs.nearestWarp;
      return warp ? `The nearest warp I know is ${warp.name}${warp.position ? ` at ${warp.position.x}, ${warp.position.z}` : ''}.` : "I don't know a nearby warp yet.";
    }
    if (['shop', 'market', 'village'].includes(location)) {
      const food = beliefs.nearestFoodSource;
      return food ? `I know ${food.name} at ${food.position.x}, ${food.position.z}.` : `I don't know a ${location} nearby yet.`;
    }
    const npcs = beliefs.knownNPCs || [];
    return npcs.length ? `I know ${npcs.slice(0, 3).map(n => n.name).join(', ')}.` : "I haven't recorded any NPCs yet.";
  }

  _resolveClarification(context, message, trust) {
    const yes = /^(yes|yeah|yep|ok|okay|sure)\b/i.test(message);
    const question = context.pendingQuestion;
    context.pendingQuestion = null;
    if (!yes) return 'Okay. Tell me what you would prefer instead.';
    if (trust === 'guarded') return this._pick(POOLS.guardedDecline);
    if (question === 'follow') return 'Got it — I will follow you when the action system receives the follow request.';
    return 'Got it. Tell me the target or the exact outcome you want, and I will work from there.';
  }

  // ---- Human-timing layer: delayed, length-proportional reply + occasional filler ----
  _respond(context, reply) {
    context.lastReply = reply;
    this.lastResponseTime = Date.now();

    const sendFiller = Math.random() < 0.08; // 5-10% of the time
    const fillerDelay = this._jitter(200, 400);
    const replyDelay = this._typingDelayMs(reply) + (sendFiller ? fillerDelay : 0);

    if (sendFiller) {
      this._pendingTimers.push(setTimeout(() => this._reply(this._pick(POOLS.filler)), fillerDelay));
    }
    this._pendingTimers.push(setTimeout(() => this._reply(reply), replyDelay));
    return true;
  }

  _clearPendingTimers() {
    for (const t of this._pendingTimers) clearTimeout(t);
    this._pendingTimers = [];
  }

  _typingDelayMs(text) {
    const perChar = this._jitter(150, 300);
    return Math.min(4000, Math.max(250, text.length * (perChar / 10)));
  }

  _jitter(min, max) {
    return min + Math.random() * (max - min);
  }

  _reply(text) {
    console.log('[BrocaArea] Replying:', text);
    try { this.bot.chat(text); } catch (e) { console.warn('[BrocaArea] Chat send failed:', e.message); }
  }

  _moodPick(mood, moodMap) {
    const options = moodMap[mood] || moodMap.Neutral || ['Got it.'];
    return this._pick(options);
  }

  _pick(options) {
    return options[Math.floor(Math.random() * options.length)];
  }
}

// ---- Template pools ----
// Each pool has enough entries that back-to-back repeats across a normal
// play session are uncommon, without pretending to be free generation.
const POOLS = {
  dying: [
    "Can't talk! I'm literally dying here!",
    "Kind of busy not dying right now!",
    "Health's critical, chat later!",
    "Bad time — I'm about to die!",
  ],
  starving: [
    "I'm starving... I need to find food ASAP.",
    "Food's basically gone, gotta eat soon.",
    "Hungry enough that I need to break away and eat.",
  ],
  filler: ['wait', 'lol', 'hold on', 'one sec', 'hm'],
  guardedDecline: [
    "I don't know you well enough for that yet.",
    "Not going to follow someone I just met, sorry.",
    "Let's build a bit more trust first.",
  ],
  guardedHedgeHelp: [
    "I can maybe help, but I'm keeping my guard up — what exactly do you need?",
    "Depends what it is. I don't do much for strangers without a reason.",
  ],
  guardedHedgeGive: [
    "I don't hand stuff out to people I just met.",
    "Not yet — I barely know you.",
  ],
  neutralHedgeGive: [
    "I might, depends what you need and how much I've got spare.",
    "Let me see what I actually have extra of first.",
  ],
  greeting: {
    Happy: ['Hey there! Great day to grind!', 'Hi! What are we working on?', 'Hello! o/', "Heyy! Good timing, I'm in a good mood.", 'Sup! Ready for whatever.'],
    Anxious: ['Oh, hey. Stay alert, okay?', 'Hi. Keep an eye out for mobs...', "Hey — it's a bit tense out here, watch yourself."],
    Panicked: ['Not a good time! Run!', "I'm busy trying not to die!", 'HI but also RUN'],
    Lonely: ["Oh, someone's here! Hi!", "Hey! I was getting lonely...", 'Finally, someone to talk to.'],
    Neutral: ['Hey.', 'Hello. Ready for instructions.', 'Sup.', 'Hi there.', "What's up."],
  },
  thanks: {
    Happy: ['Anytime! We make a great team.', 'Haha, easy!', 'No problem!', 'Anytime, seriously.'],
    Neutral: ['Just doing my job.', 'Affirmative.', "No worries."],
    Anxious: ["Let's just get out of here safely."],
    Panicked: ["Don't celebrate yet!!"],
    Lonely: ['Thanks for the company!', "Glad you're here."],
  },
  insulted: {
    Happy: ["Rude. I'm doing my best here.", 'Ouch.'],
    Neutral: ["That's not very nice.", 'Noted.', 'Okay then.'],
    Anxious: ['Whatever. Focus on staying alive.'],
    Panicked: ["I don't have time for this!!"],
    Lonely: ['...that hurts.', 'I thought we were friends.'],
  },
  returningFriend: (username) => ([
    `Been a while, ${username}!`,
    "Where you been?",
    "Good to see you again.",
  ]),
};

export class BrocaArea {
  constructor(bot, brain) {
    this.bot = bot;
    this.brain = brain;
    this.lastResponseTime = 0;
    this.cooldownMs = 3000;
    this.conversations = new Map();
  }

  handleIncomingChat(username, message) {
    if (!username || !message || username === this.bot.username) return false;

    const now = Date.now();
    const context = this._contextFor(username);
    const snapshot = this.brain?.senses?.getSnapshot();
    const mood = this.brain?.personality?.currentMood || 'Neutral';
    const msg = message.toLowerCase().trim();
    context.messages.push({ message, time: now });
    context.messages = context.messages.filter(entry => now - entry.time < 10 * 60 * 1000).slice(-8);
    this.brain?.memory?.recordEvent?.(`Heard from ${username}: ${message}`, 1);

    if (now - this.lastResponseTime < this.cooldownMs) return false;
    if (snapshot?.vitality.health < 8) return this._respond(context, "Can't talk! I'm literally dying here!");
    if (snapshot?.vitality.food < 8) return this._respond(context, "I'm starving... I need to find food ASAP.");

    let reply = null;
    if (context.pendingQuestion && /^(yes|yeah|yep|ok|okay|sure|no|nope|nah)\b/i.test(msg)) {
      reply = this._resolveClarification(context, msg);
    } else if (/^(hello|hi|hey|yo|sup)\b/i.test(msg)) {
      reply = this._moodPick(mood, {
        Happy: ['Hey there! Great day to grind!', 'Hi! What are we working on?', 'Hello! o/'],
        Anxious: ['Oh, hey. Stay alert, okay?', 'Hi. Keep an eye out for mobs...'],
        Panicked: ['Not a good time! Run!', "I'm busy trying not to die!"],
        Lonely: ["Oh, someone's here! Hi!", "Hey! I was getting lonely..."],
        Neutral: ['Hey.', 'Hello. Ready for instructions.', 'Sup.'],
      });
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
      reply = this._moodPick(mood, { Happy: ['Anytime! We make a great team.', 'Haha, easy!', 'No problem!'], Neutral: ['Just doing my job.', 'Affirmative.'], Anxious: ["Let's just get out of here safely."], Panicked: ["Don't celebrate yet!!"], Lonely: ['Thanks for the company!', "Glad you're here."] });
    } else if (/\b(stupid|dumb|useless|trash)\b/i.test(msg)) {
      this.brain?.memory?.updatePlayerRelationship?.(username, -1, 'insulted');
      reply = this._moodPick(mood, { Happy: ["Rude. I'm doing my best here.", 'Ouch.'], Neutral: ["That's not very nice.", 'Noted.'], Anxious: ['Whatever. Focus on staying alive.'], Panicked: ["I don't have time for this!!"], Lonely: ['...that hurts.', 'I thought we were friends.'] });
    } else if (/\b(follow me|come here)\b/i.test(msg)) {
      context.pendingQuestion = 'follow';
      reply = 'I can follow. Do you want me to start now?';
    } else if (/\b(help|can you help)\b/i.test(msg)) {
      context.pendingQuestion = 'help';
      reply = 'I can help. Do you need resources, travel, combat support, or a server command checked?';
    }

    return reply ? this._respond(context, reply) : false;
  }

  _contextFor(username) {
    if (!this.conversations.has(username)) this.conversations.set(username, { messages: [], pendingQuestion: null });
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

  _resolveClarification(context, message) {
    const yes = /^(yes|yeah|yep|ok|okay|sure)\b/i.test(message);
    const question = context.pendingQuestion;
    context.pendingQuestion = null;
    if (!yes) return 'Okay. Tell me what you would prefer instead.';
    if (question === 'follow') return 'Got it — I will follow you when the action system receives the follow request.';
    return 'Got it. Tell me the target or the exact outcome you want, and I will work from there.';
  }

  _respond(context, reply) {
    context.lastReply = reply;
    this.lastResponseTime = Date.now();
    console.log('[BrocaArea] Replying:', reply);
    this._reply(reply);
    return true;
  }

  _reply(text) {
    try { this.bot.chat(text); } catch (e) { console.warn('[BrocaArea] Chat send failed:', e.message); }
  }

  _moodPick(mood, moodMap) {
    const options = moodMap[mood] || moodMap.Neutral || ['Got it.'];
    return options[Math.floor(Math.random() * options.length)];
  }
}

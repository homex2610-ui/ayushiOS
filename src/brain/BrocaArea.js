export class BrocaArea {
  constructor(bot, brain) {
    this.bot = bot;
    this.brain = brain;
    this.lastResponseTime = 0;
    this.cooldownMs = 3000;
  }

  handleIncomingChat(username, message) {
    if (!username || !message) return;
    if (username === this.bot.username) return;

    const now = Date.now();
    if (now - this.lastResponseTime < this.cooldownMs) return;

    const snapshot = this.brain?.senses?.getSnapshot();
    const mood = this.brain?.personality?.currentMood || 'Neutral';
    const msg = message.toLowerCase().trim();

    if (snapshot && snapshot.vitality.health < 8) {
      this._reply("Can't talk! I'm literally dying here!");
      return;
    }
    if (snapshot && snapshot.vitality.food < 8) {
      this._reply("I'm starving... I need to find food ASAP.");
      return;
    }

    let reply = null;

    if (/^(hello|hi|hey|yo|sup)\b/i.test(msg)) {
      reply = this._moodPick(mood, {
        Happy: ["Hey there! Great day to grind!", "Hi! What are we working on?", "Hello! o/"],
        Anxious: ["Oh, hey. Stay alert, okay?", "Hi. Keep an eye out for mobs..."],
        Panicked: ["Not a good time! Run!", "I'm busy trying not to die!"],
        Lonely: ["Oh, someone's here! Hi!", "Hey! I was getting lonely..."],
        Neutral: ["Hey.", "Hello. Ready for instructions.", "Sup."]
      });
    } else if (/how are you|status|how do you feel/i.test(msg)) {
      const hp = snapshot ? snapshot.vitality.health.toFixed(1) : '?';
      const food = snapshot ? snapshot.vitality.food.toFixed(0) : '?';
      reply = `HP: ${hp}/20 | Food: ${food}/20 | Mood: ${mood}`;
    } else if (/where are you|coords|position|location/i.test(msg)) {
      const p = snapshot?.environment?.position || {};
      reply = `I am at X: ${p.x || '?'}, Y: ${p.y || '?'}, Z: ${p.z || '?'}.`;
    } else if (/help|what can you do|commands/i.test(msg)) {
      reply = "I can mine, smelt, fight, farm, and organize chests! Use !listTasks to see my quest files.";
    } else if (/^(thanks|thank you|ty|thx|gg|nice)\b/i.test(msg)) {
      reply = this._moodPick(mood, {
        Happy: ["Anytime! We make a great team.", "Haha, easy!", "No problem!"],
        Neutral: ["Just doing my job.", "Affirmative."],
        Anxious: ["Let's just get out of here safely.", "Sure, sure."],
        Panicked: ["Don't celebrate yet!!"],
        Lonely: ["Thanks for the company!", "Glad you're here."]
      });
      this.brain?.memory?.updatePlayerRelationship?.(username, +1, 'thanked');
    } else if (/\b(stupid|dumb|useless|trash)\b/i.test(msg)) {
      reply = this._moodPick(mood, {
        Happy: ["Rude. I'm doing my best here.", "Ouch."],
        Neutral: ["That's not very nice.", "Noted."],
        Anxious: ["Whatever. Focus on staying alive.", "Keep it moving."],
        Panicked: ["I don't have time for this!!", "Shut up and run!!"],
        Lonely: ["...that hurts.", "I thought we were friends."]
      });
      this.brain?.memory?.updatePlayerRelationship?.(username, -1, 'insulted');
    } else if (/\bfollow me\b/i.test(msg)) {
      reply = "On it, following you.";
    } else if (/\bcome here\b/i.test(msg)) {
      reply = "Coming!";
    }

    if (reply) {
      this.lastResponseTime = now;
      console.log('[BrocaArea] Replying to', username, ':', reply);
      this._reply(reply);
    }
  }

  _reply(text) {
    try {
      this.bot.chat(text);
    } catch (e) {
      console.warn('[BrocaArea] Chat send failed:', e.message);
    }
  }

  _moodPick(mood, moodMap) {
    const options = moodMap[mood] || moodMap['Neutral'] || ['Got it.'];
    return options[Math.floor(Math.random() * options.length)];
  }
}

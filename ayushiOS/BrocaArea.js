// BrocaArea.js
// ─────────────────────────────────────────────────────────────
// LANGUAGE CENTERS
//   Wernicke-ish half: understand what a player said (simple intent detection)
//   Broca-ish half:    produce what Ayushi says
//
// Default mode is template-based (instant, free, offline-safe).
// If FEATURES.enableLLMDialogue is on and ANTHROPIC_API_KEY is
// set, generateSpeech() will instead ask Claude for a line in
// character — this is the "inner monologue" upgrade suggested
// in the README.
// ─────────────────────────────────────────────────────────────

import { FEATURES, CHARACTER } from './config.js';

const INTENT_PATTERNS = [
  { intent: 'greeting', re: /\b(hi|hello|hey|yo)\b/i },
  { intent: 'question', re: /\?\s*$/ },
  { intent: 'command_follow', re: /\bfollow me\b/i },
  { intent: 'command_come', re: /\bcome here\b/i },
  { intent: 'thanks', re: /\b(thanks|thank you|ty)\b/i },
  { intent: 'insult', re: /\b(stupid|dumb|useless|trash)\b/i },
];

export class BrocaArea {
  constructor(bus, anthropicClient = null) {
    this.bus = bus;
    this.anthropic = anthropicClient; // optional injected client for LLM dialogue
    this.bus.on('heard_speech', (e) => this._interpret(e));
  }

  _interpret({ username, message }) {
    const hit = INTENT_PATTERNS.find(p => p.re.test(message));
    const intent = hit?.intent ?? 'statement';
    this.bus.emit('speech_understood', { username, message, intent });
    return intent;
  }

  // Fixed-template reply — safe default, zero latency, zero cost.
  templateReply(intent, username) {
    switch (intent) {
      case 'greeting': return `Hey ${username}!`;
      case 'thanks': return `Anytime, ${username}.`;
      case 'insult': return `Rude. I'm doing my best here.`;
      case 'command_follow': return `On it, following you.`;
      case 'command_come': return `Coming!`;
      default: return null; // stay quiet rather than force a reply
    }
  }

  // Optional: richer, in-character line via LLM. Only called if you
  // wire an Anthropic client in and flip FEATURES.enableLLMDialogue.
  async generateSpeech(context) {
    if (!FEATURES.enableLLMDialogue || !this.anthropic) {
      return this.templateReply(context.intent, context.username);
    }
    try {
      const res = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 60,
        messages: [{
          role: 'user',
          content: `You are ${CHARACTER.name}, ${CHARACTER.bio}. ` +
            `Current mood: ${context.mood}. A player named ${context.username} just said: ` +
            `"${context.message}". Reply in one short in-character sentence, no quotes, no narration.`
        }]
      });
      return res.content.find(b => b.type === 'text')?.text?.trim() ?? null;
    } catch (err) {
      console.error('[BrocaArea] LLM dialogue failed, falling back to template:', err);
      return this.templateReply(context.intent, context.username);
    }
  }
}

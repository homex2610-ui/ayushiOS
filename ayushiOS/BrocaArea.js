// BrocaArea.js
// ─────────────────────────────────────────────────────────────
// LANGUAGE CENTERS
//   Wernicke-ish half: understand what a player said (simple intent detection)
//   Broca-ish half:    produce what Ayushi says
//
// Default mode is template-based (instant, free, offline-safe).
// This bot uses deterministic template replies only; no LLM or external
// model API calls are used by default in AyushiOS.
// ─────────────────────────────────────────────────────────────

import { CHARACTER } from './config.js';

const INTENT_PATTERNS = [
  { intent: 'greeting', re: /\b(hi|hello|hey|yo)\b/i },
  { intent: 'question', re: /\?\s*$/ },
  { intent: 'command_follow', re: /\bfollow me\b/i },
  { intent: 'command_come', re: /\bcome here\b/i },
  { intent: 'thanks', re: /\b(thanks|thank you|ty)\b/i },
  { intent: 'insult', re: /\b(stupid|dumb|useless|trash)\b/i },
];

export class BrocaArea {
  constructor(bus) {
    this.bus = bus;
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
    return this.templateReply(context.intent, context.username);
  }
}

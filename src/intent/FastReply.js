import { Intent } from './IntentTypes.js';

const QUICK_RESPONSES = {
    [Intent.FOLLOW]: ['omw!', 'coming!', 'on my way!', 'got it!', 'right behind you'],
    [Intent.GIVE_ITEM]: ['sec', 'got it', 'coming up', 'here you go'],
    [Intent.BUILD]: ['on it!', 'starting now', 'got it', 'time to build'],
    [Intent.MINE]: ['on it', 'starting', 'got it', 'mining time'],
    [Intent.CRAFT]: ['lemme see', 'on it', 'crafting now', 'gimme a sec'],
    [Intent.FARM]: ['starting the farm', 'on it', 'planting now', 'farming time'],
    [Intent.COLLECT]: ['on it', 'got it', 'gathering now'],
    [Intent.FIGHT]: ['on it', 'got it', 'time to fight', 'engaging'],
    [Intent.MOVE]: ['omw', 'coming', 'moving now', 'on my way'],
    [Intent.SLEEP]: ['okay', 'coming to bed', 'sure', 'night night'],
    [Intent.STOP]: ['okay', 'stopping', 'sure', 'got it'],
    [Intent.HELP]: [],
    [Intent.INSPECT]: [],
    [Intent.TASK_STATUS]: [],
    [Intent.CHAT]: [],
    [Intent.UNKNOWN]: []
};

const GREETINGS = [
    'hey', 'hi', 'hello', 'sup', 'yo', 'hey there', 'hi there',
    'hlo', 'helo', 'ello', 'heyy', 'heyo'
];

const GREETING_RESPONSES = [
    'hey', 'yo', 'sup', 'hey there', 'hi', 'heyo', 'whats up'
];

const COMMAND_ACKS = {
    'come': 'coming!',
    'follow': 'omw!',
    'go': 'on my way',
    'give': 'got it',
    'build': 'on it',
    'mine': 'starting',
    'sleep': 'okay',
    'stop': 'okay',
    'wait': 'okay',
    'craft': 'crafting',
    'farm': 'farming',
    'attack': 'attacking',
    'kill': 'fighting',
    'dig': 'digging',
    'collect': 'collecting',
    'place': 'placing',
    'hold': 'got it',
    'store': 'storing',
    'bring': 'omw',
    'drop': 'dropping',
    'eat': 'eating',
    'stay': 'okay',
    'defend': 'defending',
    'protect': 'protecting',
    'check': 'checking'
};

export class FastReply {
    constructor(agent) {
        this.agent = agent;
        this._enabled = true;
    }

    get enabled() { return this._enabled; }
    set enabled(v) { this._enabled = v; }

    async simulateTypingDelay() {
        const delay = 400 + Math.random() * 700;
        await new Promise(r => setTimeout(r, delay));
    }

    getReply(source, message) {
        if (!this._enabled) return null;
        if (source === 'system' || source === this.agent?.name) return null;

        const clean = message.trim().toLowerCase();

        const greeting = GREETINGS.find(g => clean === g || clean.startsWith(g + ' ') || clean.startsWith(g + '!'));
        if (greeting) {
            return GREETING_RESPONSES[Math.floor(Math.random() * GREETING_RESPONSES.length)];
        }

        for (const [cmd, ack] of Object.entries(COMMAND_ACKS)) {
            if (clean.startsWith(cmd)) return ack;
        }

        return null;
    }

    getReplyForIntent(intent) {
        const replies = QUICK_RESPONSES[intent];
        if (!replies || replies.length === 0) return null;
        return replies[Math.floor(Math.random() * replies.length)];
    }

    async sendFastReply(source, message) {
        const reply = this.getReply(source, message);
        if (!reply) return false;

        await this.simulateTypingDelay();
        console.log(`[FastReply] -> ${source}: ${reply}`);
        if (this.agent && this.agent.openChat) {
            try {
                this.agent.openChat(reply);
            } catch (e) {
                console.warn(`[FastReply] Send failed: ${e.message}`);
            }
        }
        return true;
    }

    async sendFastReplyForIntent(intent, source) {
        const reply = this.getReplyForIntent(intent);
        if (!reply) return false;

        await this.simulateTypingDelay();
        console.log(`[FastReply] -> ${source}: ${reply}`);
        if (this.agent && this.agent.openChat) {
            try {
                this.agent.openChat(reply);
            } catch (e) {}
        }
        return true;
    }
}

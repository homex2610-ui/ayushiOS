// deterministic_brain.js
// ─────────────────────────────────────────────────────────────
// Zero-LLM chat brain: RiveScript + node-nlp + Markov + RuleBrain
// Instant, bounded, no external calls, no GPU/RAM pressure.
// ─────────────────────────────────────────────────────────────

import { RuleBrain } from './rule_brain.js';
import { Persona } from '../brain/Persona.js';
import rivescriptPkg from 'rivescript';
import nodeNlpPkg from 'node-nlp';

// CJS interop: packages differ in whether the class sits at .default,
// .RiveScript/.NlpManager or is the export itself.
const RiveScript = rivescriptPkg.RiveScript ?? rivescriptPkg.default ?? rivescriptPkg;
const NlpManager = nodeNlpPkg.NlpManager ?? nodeNlpPkg.default?.NlpManager ?? nodeNlpPkg.default;

const MASTER_PLAYER = 'updesh'; // from settings

export class DeterministicBrain {
    constructor(agent) {
        this.agent = agent;

        // Core rule engine (existing command executor)
        this.ruleBrain = new RuleBrain(agent);
        
        // RiveScript: pattern→reply templates
        this.rs = new RiveScript({ utf8: true });
        this._loadRiveScript();
        
        // node-nlp: intent classification (trained once at startup)
        this.nlp = new NlpManager({ languages: ['en'], forceNER: true });
        this._trainNLP();
        
        // Markov: generative chat flavor from history
        this.markov = new MarkovChain(2);
        this._seedMarkov();

        // Persona: mood engine + proactive reactions + player memory
        this.persona = new Persona(agent);

        this.ready = false;
        this._initPromise = this._initAll();
    }
    

    // Bot is created later in agent.start() — always read it live.
    get bot() { return this.agent.bot; }
    async _initAll() {
        await this.nlp.train();
        this.ready = true;
    }
    
    _loadRiveScript() {
        // Core patterns — extendable via external .rive files later
        const brain = `
+ hello
- yo
- hey there
- what's up

+ hi
- hi
- hello
- hey

+ hey
- hey
- hi there

+ what is your name
- I'm <bot.name>
- My name is <bot.name>

+ who are you
- a bot that follows orders
- just a helpful bot

+ what can you do
- follow · come · mine X · craft X · farm · fish · eat · sleep · build shelter · attack mob · status · inventory · save base · go to base

+ help
- follow · come · mine X · craft X · farm · fish · eat · sleep · build shelter · attack mob · status · inventory · save base · go to base

+ thanks *
- np
- no problem
- anytime

+ thank you *
- you're welcome
- np
- happy to help

+ sorry *
- no worries
- it's fine
- all good

+ bye
- cya
- later
- see ya

+ good night
- night
- sleep well

+ how are you
- running at <bot.health> hp
- doing fine, <bot.health> hp
- alive and kicking

+ where are you
- <bot.pos.x> <bot.pos.y> <bot.pos.z>
- at <bot.pos.x> <bot.pos.y> <bot.pos.z>

+ what time is it
- <bot.time>
- currently <bot.time>

+ *
- got it
- okay
- understood
`;
        this.rs.stream(brain);
        this.rs.sortReplies();
    }
    
    _trainNLP() {
        // Intent patterns for complex queries RuleBrain doesn't cover
        const utterances = [
            // movement
            ['follow me', 'move.follow'],
            ['come here', 'move.come'],
            ['go to base', 'move.goto_base'],
            ['return to base', 'move.goto_base'],
            ['stay here', 'move.stay'],
            ['stop moving', 'move.stop'],
            // survival
            ['i am hungry', 'survival.eat'],
            ['eat something', 'survival.eat'],
            ['go to sleep', 'survival.sleep'],
            ['sleep now', 'survival.sleep'],
            // combat
            ['attack zombie', 'combat.attack'],
            ['kill creeper', 'combat.attack'],
            ['fight spider', 'combat.attack'],
            ['defend me', 'combat.defend'],
            // gathering
            ['mine iron', 'gather.mine'],
            ['get wood', 'gather.mine'],
            ['collect stone', 'gather.mine'],
            // crafting
            ['craft sword', 'craft.make'],
            ['make pickaxe', 'craft.make'],
            ['craft armor', 'craft.make'],
            // building
            ['build shelter', 'build.shelter'],
            ['make house', 'build.shelter'],
            // social
            ['hello bot', 'social.greet'],
            ['hi there', 'social.greet'],
            ['thanks', 'social.thanks'],
            ['goodbye', 'social.bye'],
        ];
        
        for (const [text, intent] of utterances) {
            this.nlp.addDocument('en', text, intent);
        }
        
        // Entity extraction for items/mobs
        this.nlp.addNamedEntityText('item', 'iron', ['en'], ['iron', 'iron_ore', 'iron ingot']);
        this.nlp.addNamedEntityText('item', 'diamond', ['en'], ['diamond', 'diamond_ore']);
        this.nlp.addNamedEntityText('item', 'wood', ['en'], ['wood', 'log', 'oak_log', 'birch_log']);
        this.nlp.addNamedEntityText('item', 'stone', ['en'], ['stone', 'cobblestone']);
        this.nlp.addNamedEntityText('item', 'coal', ['en'], ['coal', 'coal_ore']);
        this.nlp.addNamedEntityText('mob', 'zombie', ['en'], ['zombie']);
        this.nlp.addNamedEntityText('mob', 'creeper', ['en'], ['creeper']);
        this.nlp.addNamedEntityText('mob', 'spider', ['en'], ['spider']);
        this.nlp.addNamedEntityText('mob', 'skeleton', ['en'], ['skeleton']);
    }
    
    _seedMarkov() {
        // Seed with some base chatter so it has something to work with
        const seeds = [
            'yo what do you need',
            'following you now',
            'mining some iron',
            'crafting a pickaxe',
            'building shelter',
            'going to sleep',
            'hp twenty twenty',
            'food level full',
            'at base coordinates',
            'got it boss',
            'alright then',
            'no food on me',
            'engaging hostile',
            'crafting complete',
            'heading to base',
        ];
        for (const s of seeds) this.markov.seed(s);
    }
    
    async handle(sender, message) {
        // 0. PERSONA FIRST: mood-aware small talk + player memory.
        //    ("how's your day", "love you", jokes, "remember me", greetings)
        const personaReply = this.persona?.smallTalk(sender, message);
        if (personaReply) {
            this.persona.seePlayer(sender);
            return personaReply;
        }

        // 1. RuleBrain first — handles all actionable commands deterministically
        const ruleReply = this.ruleBrain.handle(sender, message);
        if (ruleReply !== 'got it') {
            // RuleBrain matched an action — add to markov and return
            this.markov.seed(message);
            this.persona?.seePlayer(sender);
            return ruleReply;
        }

        // 1.5 Vision questions — deterministic perception answers
        const visionReply = this._visionQuestion(message);
        if (visionReply) return visionReply;

        // 2. RiveScript for social / conversational patterns
        if (this.ready) {
            try {
                const rsReply = this.rs.reply(sender, message, {
                    'bot.name': this.agent.name,
                    'bot.health': this.bot?.health?.toFixed?.(0) ?? '?',
                    'bot.pos.x': this.bot?.entity?.position?.x?.toFixed?.(0) ?? '?',
                    'bot.pos.y': this.bot?.entity?.position?.y?.toFixed?.(0) ?? '?',
                    'bot.pos.z': this.bot?.entity?.position?.z?.toFixed?.(0) ?? '?',
                    'bot.time': this.bot?.time ? 
                        (this.bot.time.timeOfDay < 12500 ? 'daytime' : 
                         this.bot.time.timeOfDay < 23500 ? 'night' : 'almost dawn') : 'unknown',
                });
                if (rsReply && rsReply !== 'got it') {
                    this.markov.seed(message);
                    return rsReply;
                }
            } catch (e) {
                console.error('[DeterministicBrain] RiveScript error:', e.message);
            }
        }
        
        // 3. node-nlp for fuzzy intent classification
        if (this.ready) {
            try {
                const nlpResult = await this.nlp.process('en', message);
                if (nlpResult.intent && nlpResult.score > 0.55) {
                    // Map intent to a command or response
                    const cmdReply = this._intentToCommand(nlpResult, sender);
                    if (cmdReply) {
                        this.markov.seed(message);
                        return cmdReply;
                    }
                }
            } catch (e) {
                console.error('[DeterministicBrain] NLP error:', e.message);
            }
        }
        
        // 4. Markov chain for generative fallback (feels alive, not scripted)
        const markovReply = this.markov.generate(message.split(' ')[0] || 'yo');
        if (markovReply && markovReply.length > 2) {
            return markovReply;
        }
        
        // 5. Final fallback: ASK BACK like a friend would (never dead "got it")
        this.persona?.seePlayer(sender);
        return this.persona ? this.persona.confusedReply() : 'got it';
    }
    
    // Deterministic perception Q&A: "what do you see", "any trees nearby", ...
    _visionQuestion(message) {
        const vision = this.agent?.taskRunner?.vision;
        const m = (message || '').toLowerCase();
        if (!vision) return null;
        const asksSeeing = /what (do|can) you (see|hear)|look around|scan|anything (around|nearby)|surroundings/.test(m);
        // "can you see me" / "where am i" — player-visibility question
        const asksMe = /\b(can|do) you (see|spot) me\b|\bwhere am i\b|\bsee my\b/.test(m);
        const asksResource = /(see |any |find |spot )?(trees?|wood|logs?|animals?|mobs?|water|ores?|iron|coal|diamonds?|chests?)\b.*\b(nearby|around|near|close)|\bwhere.*(tree|wood|animal|water|ore|chest)/.test(m);
        if (!asksSeeing && !asksResource && !asksMe) return null;

        if (asksMe) {
            vision.scan(true);
            const botPos = this.bot?.entity?.position;
            const playerName = this.agent?.masterName || 'you';
            let player = null, bestD = Infinity;
            for (const e of Object.values(this.bot?.entities || {})) {
                if (e?.type !== 'player' || e.username === this.bot?.username) continue;
                const d = e.position.distanceTo(botPos);
                if (d < bestD) { bestD = d; player = e; }
            }
            return player ? `yes, I see ${player.username} ${bestD.toFixed(0)} blocks away` : 'no, I don\'t see any player right now';
        }

        const desc = vision.describe();
        console.log(`[Vision] ${desc}`);
        return desc.length > 90 ? desc.slice(0, 87) + '...' : desc;
    }

    _intentToCommand(nlp, sender) {
        const { intent, entities } = nlp;
        const bot = this.bot;
        if (!bot?.entity) return null;
        
        const item = entities?.find(e => e.entity === 'item')?.sourceText?.toLowerCase();
        const mob = entities?.find(e => e.entity === 'mob')?.sourceText?.toLowerCase();
        
        switch (intent) {
            case 'move.follow':
                this.ruleBrain.handle(sender, 'follow me');
                return 'following';
            case 'move.come':
                this.ruleBrain.handle(sender, 'come here');
                return 'coming';
            case 'move.goto_base':
                this.ruleBrain.handle(sender, 'go to base');
                return 'heading to base';
            case 'move.stay':
                this.ruleBrain.handle(sender, 'stay');
                return 'staying put';
            case 'move.stop':
                this.ruleBrain.handle(sender, 'stop');
                return 'alright';
            case 'survival.eat':
                this.ruleBrain.handle(sender, 'eat');
                return 'eating';
            case 'survival.sleep':
                this.ruleBrain.handle(sender, 'sleep');
                return 'sleeping';
            case 'combat.attack':
                const target = mob || 'hostile';
                this.ruleBrain.handle(sender, `attack ${target}`);
                return `hunting ${target}`;
            case 'combat.defend':
                this.ruleBrain.handle(sender, 'defend');
                return 'on defense';
            case 'gather.mine':
                const targetItem = item || 'stone';
                this.ruleBrain.handle(sender, `mine ${targetItem}`);
                return `mining ${targetItem}`;
            case 'craft.make':
                const craftItem = item || 'pickaxe';
                this.ruleBrain.handle(sender, `craft ${craftItem}`);
                return `crafting ${craftItem}`;
            case 'build.shelter':
                this.ruleBrain.handle(sender, 'build shelter');
                return 'building shelter';
            case 'social.greet':
                return 'yo';
            case 'social.thanks':
                return 'np';
            case 'social.bye':
                return 'cya';
        }
        return null;
    }
    
    // Feed the markov chain with live chat for ongoing learning
    learnFromChat(sender, message) {
        this.markov.seed(message);
    }
}

// Simple n-gram Markov chain
class MarkovChain {
    constructor(order = 2) {
        this.order = order;
        this.chain = new Map();
    }
    
    seed(text) {
        const words = text.toLowerCase().split(/\s+/).filter(w => w.length > 0);
        if (words.length < this.order) return;
        
        for (let i = 0; i <= words.length - this.order; i++) {
            const key = words.slice(i, i + this.order).join(' ');
            const next = words[i + this.order];
            if (!next) continue;
            
            if (!this.chain.has(key)) this.chain.set(key, []);
            this.chain.get(key).push(next);
        }
    }
    
    generate(seed = 'the', maxLen = 15) {
        const words = seed.toLowerCase().split(/\s+/);
        let context = words.slice(-this.order).join(' ');
        const result = [...words];
        
        for (let i = 0; i < maxLen; i++) {
            const options = this.chain.get(context);
            if (!options || options.length === 0) break;
            
            const next = options[Math.floor(Math.random() * options.length)];
            result.push(next);
            context = result.slice(-this.order).join(' ');
        }
        
        return result.slice(words.length).join(' ') || null;
    }
}
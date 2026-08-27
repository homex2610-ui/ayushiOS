import { Intent, IntentResult, IntentConfidence } from './IntentTypes.js';

const MASTER_PLAYER = 'updesh';

const PATTERNS = [
    {
        type: Intent.FOLLOW,
        confidence: IntentConfidence.HIGH,
        patterns: [
            /^(come|follow|goto|come here|come to me|follow me)\b/i,
            /^come\s+(here|to\s+me|with\s+me)/i,
            /^follow\s+(me|updesh)/i,
            // bare "go"/"let's go" follows the master — but "go to <place>" is a MOVE intent
            /^(lets?\s+)?go\b(?!\s+to\s)/i,
            /^teleport\s+to\s+me/i,
            /^tp\s+to\s+me/i
        ]
    },
    {
        type: Intent.GIVE_ITEM,
        confidence: IntentConfidence.HIGH,
        patterns: [
            /^(give|gimme|give me|hand me|drop)\s+(?:\d+\s+)?(.+)/i,
            /^(i\s+)?need\s+(?:\d+\s+)?(.+)/i,
            /^can\s+(i|you)\s+(have|get|give)\s+(?:\d+\s+)?(.+)/i
        ],
        extract: (match) => {
            const str = match[0];
            const countMatch = str.match(/(\d+)/);
            // Strip the verb phrase, then any dangling pronoun ("give ME 5 bread" -> "bread")
            let rest = str
                .replace(/^(give\s+me|gimme|hand\s+me|can\s+i|can\s+you|i\s+)?\s*(give|hand|drop|need|have|get)\b\s*/i, '')
                .replace(/^(me|us|them)\b\s*/i, '')
                .replace(/^\d+\s*/, '');
            return {
                item: rest.trim() || 'unknown',
                count: countMatch ? parseInt(countMatch[1]) : 1
            };
        }
    },
    {
        type: Intent.BUILD,
        confidence: IntentConfidence.MEDIUM,
        patterns: [
            /^(build|make|create|construct|place)\s+(a\s+|an\s+|the\s+)?(.+)/i,
            /^(can\s+you\s+)?(build|make|create)\s+(a\s+|an\s+|the\s+)?(.+?)(\s+(farm|house|base|wall|bridge|platform|shelter))?$/i,
            /^i\s+want\s+(a\s+|an\s+|the\s+)?(.+)/i
        ],
        extract: (match) => {
            const str = match[0];
            const structureType = ['farm', 'house', 'base', 'wall', 'bridge', 'platform', 'shelter', 'wheat farm', 'crop farm', 'animal farm']
                .find(t => str.toLowerCase().includes(t));
            return {
                structure: structureType || match[match.length - 1]?.trim() || 'unknown',
                type: structureType || 'generic'
            };
        }
    },
    {
        type: Intent.MINE,
        confidence: IntentConfidence.HIGH,
        patterns: [
            /^(mine|dig|break|get|collect)\s+(\d+\s+)?(\w+)/i,
            /^go\s+(mine|mining)\b/i,
            /^let's\s+(mine|dig)\b/i,
            /^(can\s+you\s+)?(mine|dig|collect)\s+(\d+\s+)?(\w+)/i
        ],
        extract: (match) => {
            const str = match[0];
            const countMatch = str.match(/(\d+)/);
            const blockMatch = str.match(/(?:mine|dig|break|get|collect)\s+(?:\d+\s+)?(.+)/i);
            return {
                block: blockMatch ? blockMatch[1].trim() : 'stone',
                count: countMatch ? parseInt(countMatch[1]) : 64
            };
        }
    },
    {
        type: Intent.CRAFT,
        confidence: IntentConfidence.MEDIUM,
        patterns: [
            /^(craft|make|create)\s+(a\s+|an\s+|the\s+)?(\w+)/i,
            /^(can\s+you\s+)?(craft|make)\s+(a\s+|an\s+|the\s+)?(\w+)/i,
            /^how\s+(do\s+|to\s+)?(craft|make)\b/i
        ],
        extract: (match) => {
            const str = match[0];
            const itemMatch = str.match(/(?:craft|make)\s+(?:a\s+|an\s+|the\s+)?(.+)/i);
            return { item: itemMatch ? itemMatch[1].trim() : 'unknown' };
        }
    },
    {
        type: Intent.FARM,
        confidence: IntentConfidence.MEDIUM,
        patterns: [
            /^(farm|plant|harvest|hoe|till)\b/i,
            /^(make|build|create)\s+(a\s+|an\s+|the\s+)?(wheat|crop|farm|farmland)/i,
            /^plant\s+(seeds|crops?|wheat|carrots?|potatoes?)/i
        ],
        extract: (match) => {
            const str = match[0].toLowerCase();
            if (str.includes('wheat')) return { crop: 'wheat', action: 'farm' };
            if (str.includes('carrot')) return { crop: 'carrot', action: 'farm' };
            if (str.includes('potato')) return { crop: 'potato', action: 'farm' };
            return { crop: 'wheat', action: 'farm' };
        }
    },
    {
        type: Intent.COLLECT,
        confidence: IntentConfidence.MEDIUM,
        patterns: [
            /^(collect|gather|pick\s+up|get)\s+(all\s+|the\s+)?(.+)/i,
            /^gather\s+(resources?|supplies?|items?|blocks?|wood|stone|dirt)/i,
            /^chop\s+(wood|tree|trees|logs?)/i
        ],
        extract: (match) => {
            const str = match[0];
            const resourceMatch = str.match(/(?:collect|gather|get|chop)\s+(?:\w+\s+)?(.+)/i);
            return { resource: resourceMatch ? resourceMatch[1].trim() : 'resources' };
        }
    },
    {
        type: Intent.FIGHT,
        confidence: IntentConfidence.MEDIUM,
        patterns: [
            /^(fight|kill|attack|hunt|combat)\b/i,
            /^protect\s+(me|updesh|us|the\s+base)/i,
            /^defend\s+(me|updesh|us|the\s+base|the\s+area)/i,
            /^(kill|attack)\s+(that|the\s+)?(zombie|skeleton|creeper|spider|mob|monster|player)/i
        ]
    },
    {
        type: Intent.MOVE,
        confidence: IntentConfidence.HIGH,
        patterns: [
            /^(go\s+to|move\s+to|walk\s+to|head\s+to|travel\s+to)\s+(.+)/i,
            /^(go|move|walk|come)\s+(there|here|over\s+there|this\s+way)/i,
            /^(teleport|tp)\s+(to\s+)?(.+)/i
        ],
        extract: (match) => {
            const str = match[0];
            const target = str.replace(/^(go\s+to|move\s+to|walk\s+to|head\s+to|travel\s+to|teleport|tp)\s+/i, '').trim();
            return { target: target || 'unknown' };
        }
    },
    {
        type: Intent.SLEEP,
        confidence: IntentConfidence.HIGH,
        patterns: [
            /^(sleep|go\s+to\s+bed|bed|sleeping)\b/i,
            /^(come\s+)?(to\s+)?(bed|sleep)/i,
            /^skip\s+(the\s+)?night/i,
            /^(it's|its)\s+(night|bedtime|time\s+to\s+sleep)/i
        ]
    },
    {
        type: Intent.STOP,
        confidence: IntentConfidence.HIGH,
        patterns: [
            /^(stop|halt|cease|freeze|stay|wait|hold\s+on|stop\s+that)\b/i,
            /^(come\s+)?back/i,
            /^(shut\s+up|be\s+quiet|silence)\b/i
        ]
    },
    {
        type: Intent.HELP,
        confidence: IntentConfidence.MEDIUM,
        patterns: [
            /^(help|what\s+can\s+you\s+do|what\s+are\s+your\s+commands|commands|how\s+(do|can))\b/i,
            /^what(\'s|s| is)\s+(up|new|happening)/i,
            /^(how\s+are\s+you|how's\s+it\s+going|whassup|sup)\b/i
        ]
    },
    {
        type: Intent.INSPECT,
        confidence: IntentConfidence.MEDIUM,
        patterns: [
            /^(check|look|inspect|examine|scan|search)\b/i,
            /^(what's|what is|where is|who is|how many)\b/i,
            /^(show|display|list)\s+(inventory|stats|status|health|hunger|armor|equipment|items?)/i,
            /^(how\s+are\s+you|are\s+you\s+ok|you\s+ok)\b/i
        ]
    },
    {
        type: Intent.TASK_STATUS,
        confidence: IntentConfidence.HIGH,
        patterns: [
            /^(what\s+are\s+you\s+doing|what\s+is\s+your\s+task|current\s+task|task\s+status|status|progress|are\s+you\s+busy)\b/i,
            /^(how\s+(is|are)\s+(it|things|the\s+work|the\s+task|your\s+task))\b/i,
            /^(are\s+you\s+(still\s+)?(working|doing|building|mining|crafting))\b/i
        ]
    }
];

const QUICK_REPLIES = {
    [Intent.FOLLOW]: ['omw!', 'coming!', 'on my way!', 'got it!'],
    [Intent.GIVE_ITEM]: ['sec', 'got it', 'coming up'],
    [Intent.BUILD]: ['on it!', 'starting now', 'got it'],
    [Intent.MINE]: ['on it', 'starting', 'got it'],
    [Intent.CRAFT]: ['lemme see', 'on it'],
    [Intent.FARM]: ['starting the farm', 'on it'],
    [Intent.COLLECT]: ['on it', 'got it'],
    [Intent.FIGHT]: ['on it', 'got it'],
    [Intent.MOVE]: ['omw', 'coming'],
    [Intent.SLEEP]: ['okay', 'coming to bed'],
    [Intent.STOP]: ['okay', 'stopping'],
    [Intent.HELP]: [],
    [Intent.INSPECT]: [],
    [Intent.TASK_STATUS]: [],
    [Intent.CHAT]: [],
    [Intent.UNKNOWN]: []
};

export class IntentParser {
    constructor() {
        this._patterns = PATTERNS;
        // P1 light-context slots: last concrete subject/place mentioned by
        // the master. Lets "it / that / there / same thing" resolve to real
        // targets instead of failing. Deliberately simple — no coreference
        // chains, just slot memory.
        this.context = { subject: null, place: null };
    }

    _rememberContext(intent, params) {
        const nouns = ['item', 'block', 'mob', 'crop', 'structure', 'resource'];
        for (const k of nouns) {
            if (params[k] && typeof params[k] === 'string' && !/^(unknown|it|that)$/i.test(params[k])) {
                this.context.subject = params[k];
            }
        }
        if (intent === Intent.MOVE && params.target && !/^(me|updesh|there)$/i.test(params.target)) {
            this.context.place = params.target;
        }
        if (params.place && typeof params.place === 'string') {
            this.context.place = params.place;
        }
    }

    /** Contextual fallback for a missing plan param. */
    _ctx(kind) {
        return kind === 'place' ? this.context.place : this.context.subject;
    }

    parse(message) {
        const clean = message.trim();
        if (!clean) return new IntentResult(Intent.CHAT, IntentConfidence.LOW, {}, clean);

        for (const rule of this._patterns) {
            for (const pattern of rule.patterns) {
                const match = clean.match(pattern);
                if (match) {
                    let params = rule.extract ? rule.extract(match) : {};
                    // P1: anaphora injection — "mine it" / "craft that" /
                    // "go back there" reuse the last remembered subject/place.
                    const wantsAnaphora = /\b(it|that|them|same thing|there|back)\b/i.test(clean);
                    if (wantsAnaphora) {
                        params = { ...params };
                        if ((rule.type === Intent.MINE || rule.type === Intent.COLLECT) && !params.block && !params.resource && this.context.subject) {
                            params.block = this.context.subject;
                            params.resource = this.context.subject;
                        } else if (rule.type === Intent.CRAFT && !params.item && this.context.subject) {
                            params.item = this.context.subject;
                        } else if (rule.type === Intent.MOVE && params.target && /^(there|back)$/i.test(params.target) && this.context.place) {
                            params.target = this.context.place;
                        }
                    }
                    this._rememberContext(rule.type, params);
                    return new IntentResult(rule.type, rule.confidence, params, clean);
                }
            }
        }

        if (clean.length < 5 && !clean.includes(' ') && !clean.match(/[.!?]/)) {
            return new IntentResult(Intent.CHAT, IntentConfidence.MEDIUM, {}, clean);
        }

        return new IntentResult(Intent.UNKNOWN, IntentConfidence.UNCERTAIN, {}, clean);
    }

    getQuickReply(intent) {
        const replies = QUICK_REPLIES[intent];
        if (!replies || replies.length === 0) return null;
        return replies[Math.floor(Math.random() * replies.length)];
    }

    isMasterCommand(message, username) {
        if (username !== MASTER_PLAYER) return false;
        const clean = message.trim().toLowerCase();
        return (
            clean.startsWith('!') ||
            clean.startsWith('/') ||
            clean === 'stop' ||
            clean === 'shut up' ||
            clean === 'come back' ||
            clean.startsWith('follow') ||
            clean.startsWith('go to') ||
            clean.startsWith('come ')
        );
    }

    generatePlan(intent, params) {
        // NOTE 1: every command here must exist in src/agent/commands/{actions,queries}.js.
        // NOTE 2: steps use the parser's function-call grammar "!name(\"str\", 123)" —
        // space-separated args are NOT parsed by parseCommandMessage(). TaskQueue
        // pre-validates each step against the real registry before running it.
        const q = (s) => `"${String(s).replace(/"/g, '')}"`;
        const plans = {
            [Intent.FOLLOW]: () => [`!goToPlayer(${q(params.target || 'updesh')}, 1)`],
            [Intent.GIVE_ITEM]: () => {
                const count = params.count || 1;
                const item = params.item || 'unknown';
                return [`!givePlayer(${q('updesh')}, ${q(item)}, ${count})`];
            },
            [Intent.BUILD]: () => {
                const structure = params.structure || 'unknown';
                if (structure.includes('farm') || structure.includes('wheat')) {
                    return [
                        '!collectBlocks("dirt", 32)',
                        '!plantAndHarvest("wheat_seeds")'
                    ];
                }
                return ['!buildShelter(5)'];
            },
            [Intent.MINE]: () => {
                const block = params.block || this._ctx('subject') || 'stone';
                const count = params.count || 64;
                return [`!collectBlocks(${q(block)}, ${count})`];
            },
            [Intent.CRAFT]: () => {
                const item = params.item || this._ctx('subject') || 'unknown';
                return [`!craftRecipe(${q(item)}, 1)`];
            },
            [Intent.FARM]: () => {
                const crop = params.crop || 'wheat';
                const seeds = crop === 'wheat' ? 'wheat_seeds' : `${crop}_seeds`;
                return [
                    '!collectBlocks("dirt", 16)',
                    `!plantAndHarvest(${q(seeds)})`
                ];
            },
            [Intent.COLLECT]: () => {
                const resource = params.resource || params.block || this._ctx('subject') || 'resources';
                return [`!collectBlocks(${q(resource)}, 64)`];
            },
            [Intent.FIGHT]: () => {
                const mob = params.mob || 'zombie';
                return ['!equip("iron_sword")', `!attack(${q(mob)})`];
            },
            [Intent.MOVE]: () => {
                const target = params.target || 'updesh';
                // Player names route to !goToPlayer; anything else is treated as
                // a remembered place (fails gracefully if not saved).
                if (/^(me|updesh)$/i.test(target)) return ['!goToPlayer("updesh", 1)'];
                return [`!goToRememberedPlace(${q(target)})`];
            },
            [Intent.SLEEP]: () => {
                return ['!goToBed'];
            },
            [Intent.STOP]: () => {
                return ['!stop'];
            },
            [Intent.HELP]: () => {
                return [];
            },
            [Intent.INSPECT]: () => {
                // Inspect-style requests are answered by the LLM/BT layer, not
                // by canned command sequences.
                return [];
            },
            [Intent.TASK_STATUS]: () => {
                return [];
            },
            [Intent.CHAT]: () => {
                return [];
            },
            [Intent.UNKNOWN]: () => {
                return [];
            }
        };

        const planner = plans[intent];
        if (!planner) return [];
        return planner();
    }
}

export const intentParser = new IntentParser();

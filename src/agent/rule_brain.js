// rule_brain.js
// ─────────────────────────────────────────────────────────────
// Deterministic zero-LLM brain: maps master chat to real command
// execution + state-aware replies. Pattern matching only — instant,
// bounded, no neural nets, no API calls.
//
// Used when settings.enable_llm === false (see agent.handleUserMessage).
// Commands run through the SAME executeCommand pipeline as the LLM
// path, so ActionManager locking, safety gates and history all apply.
// ─────────────────────────────────────────────────────────────

import { executeCommand } from './commands/index.js';
import mcData from 'minecraft-data';

const FOODS = [
    'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
    'golden_carrot', 'bread', 'baked_potato', 'pumpkin_pie', 'apple',
    'carrot', 'melon_slice', 'beef', 'porkchop', 'chicken',
];

const MOB_WORDS = {
    zombie: 'zombie', skeleton: 'skeleton', creeper: 'creeper',
    spider: 'spider', enderman: 'enderman', witch: 'witch',
    drowned: 'drowned', slime: 'slime', blaze: 'blaze',
    cow: 'cow', pig: 'pig', sheep: 'sheep', chicken: 'chicken',
    villager: 'villager',
};

function numFrom(text, def = 1) {
    const m = text.match(/\b(\d{1,3})\b/);
    if (m) return Math.max(1, parseInt(m[1], 10));
    if (/\ba\b|one\b|some\b/i.test(text)) return def;
    return def;
}

// pull an item-ish word after a trigger phrase
function itemAfter(text, triggers) {
    for (const t of triggers) {
        const re = new RegExp(`${t}\\s+(?:\\d{1,3}\\s+|a\\s+|an\\s+|some\\s+)*([a-z_]{2,32})`, 'i');
        const m = text.match(re);
        if (m) return m[1].replace(/s$/, '');
    }
    return null;
}

function resolveItem(word) {
    if (!word || !mcData.itemsByName) return null;
    const w = word.toLowerCase();
    if (mcData.itemsByName[w]) return w;
    if (mcData.blocksByName?.[w]) return w;
    // common aliases
    const alias = { wood: 'oak_log', log: 'oak_log', food: null };
    if (alias[w]) return alias[w];
    return null;
}

export class RuleBrain {
    constructor(agent) {
        this.agent = agent;
        this.lastPlace = null;
        this._busy = false;
    }

    _say(text) { return text; }

    /**
     * Handle one chat message deterministically.
     * @returns {string|null} reply to send (null → caller decides fallback)
     */
    handle(sender, message) {
        const raw = message.trim();
        const m = raw.toLowerCase();
        const bot = this.agent.bot;
        if (!bot?.entity) return 'not spawned yet';

        const run = (cmdStr) => {
            // fire-and-forget through the real command pipeline
            executeCommand(this.agent, cmdStr)
                .catch(e => console.error('[RuleBrain] cmd failed:', cmdStr, e.message));
        };

        // ── movement ────────────────────────────────────────────────
        if (/^(stop|halt|cancel|nevermind)/.test(m)) {
            run('!stop()');
            return this._say('alright');
        }
        if (/\b(stay|wait|hold position|don'?t move)\b/.test(m)) {
            run('!stay(60)');
            return this._say('staying put');
        }
        if (/\b(follow me|follow)\b/.test(m)) {
            run(`!followPlayer("${sender}", 2)`);
            return this._say('following');
        }
        if (/^(come|come here|come to me|over here)\b/.test(m) || /\b(come here|to me)\b/.test(m)) {
            run(`!goToPlayer("${sender}", 1)`);
            return this._say('coming');
        }

        // ── goto remembered places ─────────────────────────────────
        const goMatch = m.match(/(?:go to|goto|head to|return to)\s+(?:the\s+)?([a-z_]{2,20})/);
        if (goMatch) {
            const place = goMatch[1];
            if (['me', 'you', 'sleep', 'bed'].includes(place)) { /* fallthrough below */ }
            else {
                run(`!goToRememberedPlace("${place}")`);
                return this._say(`heading to ${place}`);
            }
        }
        const saveMatch = raw.match(/(?:save|remember)(?:\s+this)?(?:\s+(?:as|location))?[:\s]+([A-Za-z_]{2,20})/i);
        if (saveMatch) {
            run(`!rememberHere("${saveMatch[1]}")`);
            return this._say(`saved "${saveMatch[1]}"`);
        }

        // ── status / info queries ──────────────────────────────────
        if (/\b(status|how are you|hp|health)\b/.test(m)) {
            const p = bot.entity.position;
            return this._say(`hp ${bot.health.toFixed(0)}/20 · food ${bot.food}/20 · at ${p.x.toFixed(0)} ${p.y.toFixed(0)} ${p.z.toFixed(0)}`);
        }
        if (/\b(inventory|what do you have|whatcha got|show inv)\b/.test(m)) {
            const inv = bot.inventory.items();
            if (!inv.length) return this._say('empty pockets');
            return this._say(inv.slice(0, 8).map(i => `${i.count}x ${i.name}`).join(', ') + (inv.length > 8 ? ` +${inv.length - 8} more` : ''));
        }
        if (/\bwhere are you\b|\byour (pos|position|coords)|\blocation\b/.test(m)) {
            const p = bot.entity.position;
            return this._say(`${p.x.toFixed(0)} ${p.y.toFixed(0)} ${p.z.toFixed(0)}`);
        }
        if (/\b(time is it|day or night|is it night)\b/.test(m)) {
            const t = bot.time?.timeOfDay ?? 0;
            return this._say(t < 12500 ? 'daytime' : t < 23500 ? 'night' : 'almost dawn');
        }

        // ── survival actions ───────────────────────────────────────
        if (/\b(eat|hungry|i need food|eat something)\b/.test(m)) {
            const inv = bot.inventory.items();
            const food = FOODS.find(f => inv.some(i => i.name === f));
            if (food) { run(`!consume("${food}")`); return this._say(`eating ${food}`); }
            return this._say('no food on me');
        }
        if (/\b(sleep|go to bed|bedtime)\b/.test(m)) { run('!goToBed()'); return this._say('sleeping'); }

        // ── combat ─────────────────────────────────────────────────
        const fightMatch = m.match(/(?:attack|kill|fight)\s+(?:the\s+|a\s+)?([a-z]+)/);
        if (fightMatch) {
            const mob = MOB_WORDS[fightMatch[1]] || (fightMatch[1] === 'nearest' ? null : fightMatch[1]);
            if (mob) { run(`!attack("${mob}")`); return this._say(`hunting ${mob}`); }
            run('!attack("hostile")').catch?.(() => {});
            return this._say('engaging');
        }
        if (/\b(defend|protect me|danger)\b/.test(m)) {
            run('!attack("zombie")');
            return this._say('on defense');
        }

        // ── gather / craft / smelt ─────────────────────────────────
        const mineWord = itemAfter(m, ['mine', 'dig', 'collect', 'get', 'grab', 'gather']);
        if (mineWord) {
            const item = resolveItem(mineWord);
            if (item) {
                const n = numFrom(m, 8);
                run(`!collectBlocks("${item}", ${n})`);
                return this._say(`mining ${n}x ${item}`);
            }
            return this._say(`what's "${mineWord}"?`);
        }
        const craftWord = itemAfter(m, ['craft', 'make', 'create']);
        if (craftWord) {
            const item = resolveItem(craftWord);
            if (item) {
                const n = numFrom(m, 1);
                run(`!craftRecipe("${item}", ${n})`);
                return this._say(`crafting ${item}`);
            }
            return this._say(`can't craft "${craftWord}"`);
        }
        const smeltWord = itemAfter(m, ['smelt', 'cook', 'furnace']);
        if (smeltWord) {
            const item = resolveItem(smeltWord);
            if (item) { run(`!smeltItem("${item}", ${numFrom(m, 1)})`); return this._say(`smelting ${item}`); }
        }

        // ── give items ─────────────────────────────────────────────
        const giveMatch = raw.match(/give(?:\s+me)?\s+(\d{1,3}|a|an|some)?\s*([a-z_]{2,32})/i);
        if (giveMatch && sender) {
            const item = resolveItem(giveMatch[2]);
            if (item) {
                const n = giveMatch[1] ? numFrom(giveMatch[1], 1) : 1;
                run(`!givePlayer("${sender}", "${item}", ${n})`);
                return this._say(`here: ${n}x ${item}`);
            }
        }

        // ── building / farming / misc work ─────────────────────────
        if (/\b(build|make)\b.*\b(shelter|house|hut|base)\b/.test(m)) {
            run('!buildShelter(5)');
            return this._say('building shelter');
        }
        if (/\b(farm|harvest|plant|wheat|crop)\b/.test(m)) {
            const hasSeeds = (bot.inventory.items() || []).some(i => i.name === 'wheat_seeds');
            run(hasSeeds ? '!plantAndHarvest("wheat_seeds")' : '!plantAndHarvest()');
            return this._say('farming');
        }
        if (/\bfish(ing)?\b/.test(m)) { run('!goFishing(10)'); return this._say('fishing'); }
        if (/\b(light|torch(es)?)\b/.test(m)) { run('!lightSurroundings()'); return this._say('lighting up'); }
        const equipMatch = m.match(/\bequip(?:\s+(?:my|the))?\s+([a-z_]{2,20})/);
        if (equipMatch) {
            const item = resolveItem(equipMatch[1]);
            if (item) { run(`!equip("${item}")`); return this._say(`equipped ${item}`); }
        }

        // ── social ─────────────────────────────────────────────────
        if (/^(hi|hello|hey|yo|sup|heyy)\b/.test(m)) return this._say('yo');
        if (/\b(thanks|thank you|thx|ty)\b/.test(m)) return this._say('np');
        if (/\b(bye|cya|later)\b/.test(m)) return this._say('cya');
        if (/\bhelp\b|\bwhat can you do\b/.test(m)) {
            return this._say('follow · come · mine X · craft X · farm · fish · eat · sleep · build shelter · attack mob · status · inventory · save base · go to base');
        }

        // ── fallback ───────────────────────────────────────────────
        return this._say('got it');
    }
}

// item_families.js — canonical item-family resolution.
//
// PRINCIPLE: no gameplay code may hardcode a concrete species/variant when a
// FAMILY will do. A plan that says "log" means ANY log; "planks" any planks;
// "iron" the raw/ore/deepslate forms; "food" anything edible; "fuel" anything
// that burns. Concrete names always work too — family matching is additive.
//
// Consumers: TaskRunner (collect counting/adoption), SpatialVision (scan
// predicates), capabilities (plan-state resource checks), craft_planks,
// buildShelter. If you're about to write `_log` or `oak_` in new code — use
// this module instead.

// ── Wood family ────────────────────────────────────────────────
export function isWoodBlockName(n) {
    if (!n) return false;
    return n === 'log' || n.endsWith('_log') ||
        n === 'wood' || n.endsWith('_wood') ||
        n === 'stem' || n.endsWith('_stem') ||
        n === 'hyphae' || n.endsWith('_hyphae') ||
        n === 'bamboo_block';
}

// ── Edible items (curated vanilla set; autoEat/eatBestFood also accept
//    these names so counting here matches what she can actually eat) ──
const EDIBLE = new Set([
    'apple', 'golden_apple', 'enchanted_golden_apple',
    'bread', 'cookie', 'pumpkin_pie', 'cake',
    'melon_slice', 'sweet_berries', 'glow_berries', 'dried_kelp',
    'carrot', 'golden_carrot', 'potato', 'baked_potato', 'poisonous_potato',
    'beetroot', 'beetroot_soup', 'mushroom_stew', 'rabbit_stew', 'suspicious_stew',
    'chorus_fruit', 'honey_bottle', 'milk_bucket',
]);
const MEATS = [
    'beef', 'porkchop', 'chicken', 'rabbit', 'mutton', 'cod', 'salmon', 'tropical_fish',
];
function isFoodName(n) {
    if (!n) return false;
    if (EDIBLE.has(n)) return true;
    return MEATS.some(m => n === m || n === `cooked_${m}` || n === `raw_${m}`);
}

// ── Fuel family ────────────────────────────────────────────────
function isFuelName(n) {
    if (!n) return false;
    if (n === 'coal' || n === 'charcoal' || n === 'coal_block'
        || n === 'lava_bucket' || n === 'blaze_rod' || n === 'dried_kelp_block') return true;
    return isWoodBlockName(n) || n.endsWith('_planks');
}

// ── Ore/metal families ─────────────────────────────────────────
const METALS = ['iron', 'gold', 'copper'];
function isOreName(n) {
    return !!n && /(^|deepslate_)(iron|coal|gold|diamond|copper|redstone|lapis|emerald)_ore$/.test(n);
}
function isRawMetalName(n) {
    return !!n && (n === 'raw_iron' || n === 'raw_gold' || n === 'raw_copper'
        || n === 'ancient_debris');
}
function isIngotName(n) {
    return !!n && (n === 'iron_ingot' || n === 'gold_ingot' || n === 'copper_ingot'
        || n === 'netherite_ingot');
}

// ── Tool/armor tier families ───────────────────────────────────
const TOOL_KINDS = ['pickaxe', 'axe', 'shovel', 'hoe', 'sword'];
const TIERS = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'];
function isToolOfKind(n, kind) {
    if (!n || !n.endsWith(kind)) return false;
    const base = n.slice(0, -(kind.length + 1));
    return TIERS.includes(base);
}
function toolTierRank(n) {
    const base = n.split('_')[0];
    const i = TIERS.indexOf(base);
    return i === -1 ? -1 : i;
}

// ── Family table ───────────────────────────────────────────────
const FAMILIES = {
    log: isWoodBlockName,
    wood: isWoodBlockName,
    any_log: isWoodBlockName,
    planks: n => !!n && n.endsWith('_planks'),
    any_planks: n => !!n && n.endsWith('_planks'),
    food: isFoodName,
    fuel: isFuelName,
    ore: isOreName,
    raw_metal: isRawMetalName,
    ingot: isIngotName,
    sword: n => isToolOfKind(n, 'sword'),
    pickaxe: n => isToolOfKind(n, 'pickaxe'),
    axe: n => isToolOfKind(n, 'axe'),
    shovel: n => isToolOfKind(n, 'shovel'),
    hoe: n => isToolOfKind(n, 'hoe'),
};

/**
 * Does a concrete item/block name satisfy a request?
 * Exact name → true. Family word ('log','planks','food','fuel','ore',
 * 'sword', …) → true for every member of that family.
 */
export function matchesFamily(concreteName, request) {
    if (!concreteName || !request) return false;
    if (concreteName === request) return true;
    const fam = FAMILIES[request];
    return fam ? fam(concreteName) : false;
}

/** Total inventory count across every member satisfying the request. */
export function countMatching(inventoryCounts, request) {
    let total = 0;
    for (const [name, c] of Object.entries(inventoryCounts || {})) {
        if (matchesFamily(name, request)) total += c;
    }
    return total;
}

/**
 * Best (highest-tier / most relevant) member of a request family currently
 * in inventory, or null. Tiers matter only for tools.
 */
export function bestHeld(inventoryCounts, request) {
    let best = null, bestRank = -2, bestCount = 0;
    for (const [name, c] of Object.entries(inventoryCounts || {})) {
        if (!matchesFamily(name, request)) continue;
        const rank = TOOL_KINDS.some(k => request === k) ? toolTierRank(name) : 0;
        if (rank > bestRank || (rank === bestRank && c > bestCount)) {
            best = name; bestRank = rank; bestCount = c;
        }
    }
    return best;
}

/**
 * Inventory-count lookup that understands families AND common aliases:
 * iron → counts raw_iron + iron_ore + deepslate variants + iron_ingot,
 * coal → coal + deepslate_coal_ore (+charcoal for fuel semantics).
 */
export function countResource(inventoryCounts, request) {
    if (!request) return 0;
    // Direct/family hit first
    let total = countMatching(inventoryCounts, request);
    if (total > 0) return total;
    // Metal alias chains: bare metal name counts its raw + ore + ingot forms
    if (METALS.includes(request)) {
        for (const [name, c] of Object.entries(inventoryCounts || {})) {
            if (name === `raw_${request}` || name === `${request}_ingot`
                || isOreName(name) && name.includes(`_${request}_`)) total += c;
        }
    }
    // Gem/coal alias chain: bare name counts its ores too
    if (['coal', 'diamond', 'emerald', 'lapis_lazuli', 'redstone'].includes(request)) {
        const key = request === 'redstone' ? 'redstone' : request;
        for (const [name, c] of Object.entries(inventoryCounts || {})) {
            if (isOreName(name) && name.startsWith(`deepslate_${key}`)) total += c;
        }
    }
    return total;
}

export const FAMILIES_AVAILABLE = Object.keys(FAMILIES);

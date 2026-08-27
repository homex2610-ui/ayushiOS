export class ItemLoreAnalyzer {
    constructor(knowledgeBase, logger) {
        this.kb = knowledgeBase;
        this.log = logger || ((...a) => {});
    }

    feed(item) {
        if (!item?.lore?.length) return;
        const lore = item.lore.map(l => typeof l === 'object' ? l.text : String(l));
        const entry = {
            itemName: item.name,
            displayName: item.displayName?.text || item.displayName || item.name,
            count: item.count,
            lore,
            enchants: item.enchants || [],
            damage: item.damage,
            maxDamage: item.maxDamage,
            ts: Date.now(),
        };
        this.kb.push('itemLores', entry);

        this._classifyItem(item.name, lore, entry.displayName);
        this._extractPluginInfo(lore);
        this._extractEconomyInfo(lore);
    }

    _classifyItem(name, lore, displayName = name) {
        const lower = name.toLowerCase();
        const allText = lore.join(' ').toLowerCase();
        let category = 'misc';
        if (lower.includes('sword') || lower.includes('axe') || lower.includes('bow') || lower.includes('crossbow') || lower.includes('trident')) category = 'weapon';
        else if (lower.includes('helmet') || lower.includes('chestplate') || lower.includes('leggings') || lower.includes('boots')) category = 'armor';
        else if (lower.includes('pickaxe') || lower.includes('shovel') || lower.includes('hoe')) category = 'tool';
        else if (lower.includes('potion') || lower.includes('apple') || lower.includes('food')) category = 'consumable';
        else if (lower.includes('crate') || lower.includes('key') || lower.includes('token')) category = 'crate';
        else if (lower.includes('block') || lower.includes('plank') || lower.includes('stone') || lower.includes('ore') || lower.includes('ingot')) category = 'material';

        if (allText.includes('custom') || allText.includes('mythic') || allText.includes('legendary') || allText.includes('unique') || allText.includes('rare') || /\[[^\]]+\]/.test(displayName)) {
            const functions = [];
            if (/right.click|right click|use to|ability|activate/.test(allText)) functions.push('activated_ability');
            if (/damage|attack|strength/.test(allText)) functions.push('combat');
            if (/speed|haste|luck|health|regen/.test(allText)) functions.push('stat_bonus');
            if (/quest|mission|objective/.test(allText)) functions.push('quest_item');
            this.kb.push('customItems', { name, displayName, category, functions, lore: lore.slice(0, 3), ts: Date.now() });
        }
    }

    _extractPluginInfo(lore) {
        const allText = lore.join(' ').toLowerCase();
        const pluginSignals = [
            { plugin: 'mcMMO', signal: /mcmmo/i },
            { plugin: 'AureliumSkills', signal: /aureliumskills|skill level/i },
            { plugin: 'Jobs', signal: /job level|job boost/i },
            { plugin: 'ExcellentCrates', signal: /crate|key|excellentcrates/i },
            { plugin: 'CrazyCrates', signal: /crazycrates/i },
            { plugin: 'MythicMobs', signal: /mythic|mythical/i },
            { plugin: 'MMOItems', signal: /mmoitems|mmo item/i },
            { plugin: 'MythicLib', signal: /mythiclib/i },
        ];
        for (const ps of pluginSignals) {
            if (ps.signal.test(allText)) {
                const entry = this.kb.get('plugins.' + ps.plugin);
                if (entry) entry.confidence = Math.min(1, entry.confidence + 0.15);
                else this.kb.set('plugins.' + ps.plugin, { name: ps.plugin, confidence: 0.3, firstSeen: Date.now(), lastSeen: Date.now() });
            }
        }
    }

    _extractEconomyInfo(lore) {
        const allText = lore.join(' ');
        const priceMatch = allText.match(/(?:price|cost|worth|value)[:\s]*\$?(\d+[.,]?\d*)/i);
        if (priceMatch) {
            this.kb.set('economy.enabled', true);
            const price = parseFloat(priceMatch[1].replace(/,/g, ''));
            if (!isNaN(price)) {
                this.kb.push('observedPrices', { price, ts: Date.now() });
            }
        }
    }
}

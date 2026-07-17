export class GUIAnalyzer {
    constructor(knowledgeBase, logger) {
        this.kb = knowledgeBase;
        this.log = logger || ((...a) => {});
    }

    feed(window) {
        if (!window) return;
        try {
            const title = window.title?.text || window.title || 'unknown';
            const slots = [];
            let itemCount = 0;
            for (let i = 0; i < window.containerSize; i++) {
                const item = window.slots[i];
                if (item) {
                    itemCount++;
                    slots.push({
                        slot: i,
                        name: item.name,
                        count: item.count,
                        lore: item.lore?.map(l => typeof l === 'object' ? l.text : l) || [],
                        enchanted: !!item.enchants?.length,
                        damage: item.damage,
                    });
                }
            }
            const entry = {
                title,
                type: window.type,
                size: window.containerSize,
                itemCount,
                slots: slots.slice(0, 20),
                firstSeen: Date.now(),
                lastSeen: Date.now(),
            };
            this.kb.push('guiMenus', entry);
            this._classifyGUI(title, slots);
        } catch (_) {}
    }

    _classifyGUI(title, slots) {
        const lower = title.toLowerCase();
        let type = null;
        if (lower.includes('shop') || lower.includes('store') || lower.includes('buy') || lower.includes('sell') || lower.includes('price')) type = 'shop';
        else if (lower.includes('chest') || lower.includes('storage') || lower.includes('backpack')) type = 'storage';
        else if (lower.includes('crate') || lower.includes('key') || lower.includes('reward') || lower.includes('loot')) type = 'crate';
        else if (lower.includes('quest') || lower.includes('mission') || lower.includes('task')) type = 'quest';
        else if (lower.includes('auction') || lower.includes('ah') || lower.includes('market')) type = 'auction';
        else if (lower.includes('trade') || lower.includes('merchant') || lower.includes('npc') || lower.includes('villager')) type = 'trade';
        else if (lower.includes('craft') || lower.includes('recipe') || lower.includes('smith')) type = 'craft';
        else if (lower.includes('enchant') || lower.includes('anvil') || lower.includes('grindstone')) type = 'enchant';
        else if (lower.includes('furnace') || lower.includes('smelt') || lower.includes('cook')) type = 'furnace';
        else if (lower.includes('job') || lower.includes('profession') || lower.includes('career')) type = 'job';
        else if (lower.includes('skill') || lower.includes('ability') || lower.includes('perk') || lower.includes('talent')) type = 'skill';
        else if (lower.includes('eco') || lower.includes('bank') || lower.includes('balance') || lower.includes('atm')) type = 'economy';
        else if (lower.includes('warp') || lower.includes('teleport') || lower.includes('travel') || lower.includes('gate')) type = 'warp';
        else if (lower.includes('kit') || lower.includes('donation') || lower.includes('rank') || lower.includes('upgrade')) type = 'kit';
        else if (lower.includes('vote') || lower.includes('reward')) type = 'vote';

        if (type) {
            this.kb.push('knownGUITypes', { type, title, firstSeen: Date.now() });
        }

        for (const slot of slots) {
            if (slot.lore?.length > 0) {
                this.kb.push('itemLores', {
                    itemName: slot.name,
                    lore: slot.lore.slice(0, 5),
                    fromGUI: title,
                    ts: Date.now(),
                });
            }
        }
    }
}

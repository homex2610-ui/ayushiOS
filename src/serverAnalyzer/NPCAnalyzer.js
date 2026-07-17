export class NPCAnalyzer {
    constructor(knowledgeBase, logger) {
        this.kb = knowledgeBase;
        this.log = logger || ((...a) => {});
        this._knownNPCs = new Set();
    }

    observe(bot) {
        this._observePlayers(bot);
        this._observeEntities(bot);
    }

    _observePlayers(bot) {
        if (!bot?.players) return;
        for (const [name, player] of Object.entries(bot.players)) {
            if (!player.entity) continue;
            const pos = player.entity.position;
            if (!pos) continue;
            const isNPC = this._isLikelyNPC(player);
            if (isNPC && !this._knownNPCs.has(name)) {
                this._knownNPCs.add(name);
                const entry = {
                    name,
                    type: 'player_npc',
                    position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
                    firstSeen: Date.now(),
                    lastSeen: Date.now(),
                    skin: player.skinData?.url || null,
                    traits: this._extractTraits(player.name || ''),
                };
                this.kb.push('npcs', entry);
                this.log('[NPC] Detected player NPC:', name, 'at', entry.position);
            }
        }
    }

    _observeEntities(bot) {
        if (!bot?.entities) return;
        for (const [id, entity] of Object.entries(bot.entities)) {
            if (!entity.position || entity.type === 'player' || entity.type === 'mob') continue;
            const customName = entity.metadata?.[2]?.toString?.()?.replace(/§./g, '')?.trim();
            if (!customName) continue;
            const key = `entity_${id}`;
            if (!this._knownNPCs.has(key)) {
                this._knownNPCs.add(key);
                const traits = this._extractTraits(customName);
                const entry = {
                    name: customName,
                    entityId: parseInt(id),
                    type: entity.name || 'unknown',
                    entityType: entity.entityType,
                    position: { x: Math.round(entity.position.x), y: Math.round(entity.position.y), z: Math.round(entity.position.z) },
                    firstSeen: Date.now(),
                    lastSeen: Date.now(),
                    traits,
                };
                this.kb.push('npcs', entry);
                this.log('[NPC] Detected entity NPC:', customName, `(${entry.type})`, 'at', entry.position, 'traits:', traits.join(','));
            }
        }
    }

    _isLikelyNPC(player) {
        if (!player.entity) return false;
        const name = player.name || '';
        if (this._isNPCName(name)) return true;
        if (player.gamemode === 3) return true;
        if (player.entity.kind === 'NPC' || player.entity.type === 'npc') return true;
        if (player.entity.metadata?.[0] === 0x80) return true;
        return false;
    }

    _isNPCName(name) {
        const patterns = [
            /^\[NPC\]/, /^NPC$/i, /^Shop/, /^Merchant/, /^Villager/i,
            /^Guard/i, /^Banker/i, /^Blacksmith/i, /^Armorer/i,
            /^Weaponsmith/i, /^Toolsmith/i, /^Butcher/i, /^Librarian/i,
            /^Farmer/i, /^Fisherman/i, /^Fletcher/i, /^Leatherworker/i,
            /^Cleric/i, /^Cartographer/i, /^Mason/i, /^Shepherd/i,
        ];
        return patterns.some(p => p.test(name));
    }

    _extractTraits(name) {
        const traits = [];
        if (/shop|merchant|trade|buy|sell/i.test(name)) traits.push('shop');
        if (/quest|mission|task/i.test(name)) traits.push('quest_giver');
        if (/guard|soldier|knight|warrior/i.test(name)) traits.push('guard');
        if (/bank|eco|money|coin/i.test(name)) traits.push('banker');
        if (/portal|warp|travel|ride|horse|boat/i.test(name)) traits.push('travel');
        if (/farm|food|cook|bread|animal/i.test(name)) traits.push('food');
        if (/enchant|magic|potion|brew|alchemy/i.test(name)) traits.push('magic');
        if (/blacksmith|smith|anvil|repair|tool|weapon|armor/i.test(name)) traits.push('blacksmith');
        if (/survival|smp|earth|vanilla/i.test(name)) traits.push('survival');
        if (/pvp|pract|battle|combat|war/i.test(name)) traits.push('pvp');
        if (/kit|kitpvp|loadout|class/i.test(name)) traits.push('kit');
        if (/hub|lobby|menu|selector|mode/i.test(name)) traits.push('mode_selector');
        if (/minigame|game|event|parkour|bedwars|skywars/i.test(name)) traits.push('minigame');
        return traits;
    }

    getNPCsByTrait(trait) {
        const results = [];
        const npcs = this.kb.get('npcs') || [];
        for (const npc of npcs) {
            if (npc.traits?.includes(trait)) results.push(npc);
        }
        return results;
    }

    getNPCsByName(namePattern) {
        const results = [];
        const npcs = this.kb.get('npcs') || [];
        const regex = new RegExp(namePattern, 'i');
        for (const npc of npcs) {
            if (regex.test(npc.name)) results.push(npc);
        }
        return results;
    }
}

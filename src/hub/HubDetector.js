const SELECTOR_NAMES = ['compass', 'nether_star', 'slime_ball', 'clock', 'paper', 'book', 'writable_book'];

const MODE_KEYWORDS = ['survival', 'practice', 'lifesteal', 'kitpvp', 'bedwars', 'skywars', 'minigame', 'duel', 'arena', 'advertise', 'store', 'vote', 'discord', 'parkour'];

const HUB_SIGNALS = {
  scoreboardHub: {
    weight: 50,
    check: (bot) => {
      const title = String(bot.scoreboard?.sidebar?.title || '').toLowerCase();
      return title.includes('hub') || title.includes('lobby');
    }
  },
  scoreboardServerSelector: {
    weight: 30,
    check: (bot) => {
      const title = String(bot.scoreboard?.sidebar?.title || '').toLowerCase();
      return title.includes('practice') || title.includes('selector') || title.includes('minigame');
    }
  },
  hotbarSelectorItem: {
    weight: 45,
    check: (bot) => {
      const items = bot.inventory?.items() || [];
      const hotbarSlots = items.filter(i => i.slot >= 36 && i.slot <= 44);
      return hotbarSlots.some(item => {
        const name = item.name.toLowerCase().replace('minecraft:', '');
        return SELECTOR_NAMES.includes(name);
      });
    }
  },
  inventoryCompass: {
    weight: 25,
    check: (bot) => {
      const items = bot.inventory?.items() || [];
      return items.some(i => i.name === 'compass' || i.name === 'minecraft:compass');
    }
  },
  hotbarSelectorLore: {
    weight: 25,
    check: (bot) => {
      const items = bot.inventory?.items() || [];
      const hotbarSlots = items.filter(i => i.slot >= 36 && i.slot <= 44);
      return hotbarSlots.some(i => {
        const lore = i.lore?.map(l => String(l).toLowerCase().replace(/§./g, '')) || [];
        return lore.some(l => l.includes('server') || l.includes('selector') || l.includes('navigate') || l.includes('teleport') || l.includes('game menu') || l.includes('join') || l.includes('play') || l.includes('click'));
      });
    }
  },
  playersMany: {
    weight: 10,
    check: (bot) => Object.keys(bot.players || {}).length > 5
  },
  playersVeryMany: {
    weight: 15,
    check: (bot) => Object.keys(bot.players || {}).length > 20
  },
  modeEntityNearby: {
    weight: 55,
    check: (bot) => {
      const entities = Object.values(bot.entities || {});
      return entities.some(e => {
        // Real players never count as hub NPCs — only non-player entities may match keywords
        if (e.type === 'player') return false;
        const name = (e.displayName || e.name || e.username || '').toLowerCase().replace(/§./g, '');
        const customName = e.metadata?.[2]?.toString?.().replace(/§./g, '').toLowerCase().trim();
        const matchText = (name || customName || '');
        return MODE_KEYWORDS.some(k => matchText.includes(k));
      });
    }
  },
  bossbarHub: {
    weight: 20,
    check: (bot) => {
      const bars = bot.bossBars;
      if (!bars) return false;
      for (const bar of Object.values(bars)) {
        const title = (bar.title?.text || bar.title || '').toLowerCase();
        if (title.includes('hub') || title.includes('lobby')) return true;
      }
      return false;
    }
  },
  tablistHub: {
    weight: 15,
    check: (bot) => {
      const tl = bot.tablist;
      if (!tl) return false;
      const header = (tl.header?.text || '').toLowerCase();
      const footer = (tl.footer?.text || '').toLowerCase();
      return header.includes('hub') || header.includes('lobby') || footer.includes('hub') || footer.includes('lobby');
    }
  },
  canBreakBlocks: {
    weight: -10,
    check: (bot) => bot.game?.gameMode === 'survival' || bot.game?.gameMode === 'creative'
  },
  naturalTerrain: {
    weight: -15,
    check: (bot) => {
      const pos = bot.entity?.position;
      if (!pos) return false;
      for (let dx = -3; dx <= 3; dx += 2) {
        for (let dz = -3; dz <= 3; dz += 2) {
          const block = bot.blockAt({ x: Math.floor(pos.x) + dx, y: Math.floor(pos.y) - 1, z: Math.floor(pos.z) + dz });
          if (block) {
            const n = block.name.toLowerCase();
            if (n === 'grass_block' || n === 'dirt' || n === 'stone' || n === 'sand' || n === 'gravel') return true;
          }
        }
      }
      return false;
    }
  },
  inventoryTools: {
    weight: -5,
    check: (bot) => {
      const items = bot.inventory?.items() || [];
      return items.some(i => {
        const name = i.name || '';
        return name.includes('pickaxe') || name.includes('axe') || name.includes('shovel') || name.includes('hoe');
      });
    }
  },
  placedBlocksNearby: {
    weight: -10,
    check: (bot) => {
      const pos = bot.entity?.position;
      if (!pos) return false;
      let total = 0;
      for (let dx = -4; dx <= 4; dx += 2) {
        for (let dz = -4; dz <= 4; dz += 2) {
          const block = bot.blockAt({ x: Math.floor(pos.x) + dx, y: Math.floor(pos.y) - 1, z: Math.floor(pos.z) + dz });
          if (block && !block.name.includes('air')) total++;
        }
      }
      return total > 10;
    }
  },
  npcArmorStands: {
    weight: 20,
    check: (bot) => {
      const entities = Object.values(bot.entities || {});
      return entities.some(e => {
        if (e.name !== 'armor_stand' && e.entityType !== 30) return false;
        const customName = e.metadata?.[2]?.toString?.().replace(/§./g, '').toLowerCase().trim();
        return customName && customName.length > 0;
      });
    }
  },
  hasSword: {
    weight: -5,
    check: (bot) => {
      const items = bot.inventory?.items() || [];
      return items.some(i => (i.name || '').includes('sword'));
    }
  },
};

export function computeHubScore(bot) {
  if (!bot || !bot.entity || !bot.inventory) return { isHub: false, score: 0, signals: {} };

  const signals = {};
  let score = 0;

  for (const [key, signal] of Object.entries(HUB_SIGNALS)) {
    try {
      const triggered = signal.check(bot);
      signals[key] = triggered;
      if (triggered) score += signal.weight;
    } catch (e) {
      signals[key] = false;
    }
  }

  return {
    isHub: score >= 30,
    isPossibleHub: score >= 15 && score < 30,
    score,
    signals,
  };
}

export function isHub(bot) {
  return computeHubScore(bot).isHub;
}

export function debugHubScore(bot) {
  const result = computeHubScore(bot);
  const triggered = Object.entries(result.signals)
    .filter(([_, v]) => v)
    .map(([key, _]) => {
      const weight = HUB_SIGNALS[key]?.weight || 0;
      return `${key}(${weight > 0 ? '+' : ''}${weight})`;
    });
  const blocked = Object.entries(result.signals)
    .filter(([_, v]) => !v)
    .map(([key, _]) => {
      const weight = HUB_SIGNALS[key]?.weight || 0;
      if (weight < 0) return `${key}(${weight})`;
      return null;
    })
    .filter(Boolean);

  console.log(`[HubDetector] Score: ${result.score} | Hub: ${result.isHub} | Possible: ${result.isPossibleHub}`);
  if (triggered.length > 0) console.log(`[HubDetector] Active: ${triggered.join(', ')}`);
  if (blocked.length > 0) console.log(`[HubDetector] Inactive negatives: ${blocked.join(', ')}`);
  return result;
}

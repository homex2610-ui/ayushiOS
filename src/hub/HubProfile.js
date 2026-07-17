import * as fs from 'fs';
import * as path from 'path';

const PROFILES_DIR = 'bots/profiles';

export class HubProfile {
  constructor(bot) {
    this.bot = bot;
    this._ensureDir();
  }

  _ensureDir() {
    try {
      if (!fs.existsSync(PROFILES_DIR)) {
        fs.mkdirSync(PROFILES_DIR, { recursive: true });
      }
    } catch (e) {
      console.warn(`[HubProfile] Cannot create profiles dir: ${e.message}`);
    }
  }

  _getServerKey() {
    try {
      const host = this.bot._client?.socket?.remoteAddress || this.bot.host || 'unknown';
      return host.replace(/[.:]/g, '_').toLowerCase();
    } catch {
      return 'unknown';
    }
  }

  _profilePath() {
    return path.join(PROFILES_DIR, `${this._getServerKey()}.json`);
  }

  load() {
    try {
      const p = this._profilePath();
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        console.log(`[HubProfile] Loaded profile for ${data.server || this._getServerKey()}`);
        return data;
      }
    } catch (e) {
      console.warn(`[HubProfile] Load failed: ${e.message}`);
    }
    return null;
  }

  save(targetMode, extraData = {}) {
    try {
      const hotbar = this._getHotbarSummary();
      const profile = {
        server: this._getServerKey(),
        savedAt: Date.now(),
        hub: true,
        targetMode: targetMode || 'survival',
        selector: hotbar.selector || extraData.selectorItem || null,
        selectorSlot: hotbar.selectorSlot ?? extraData.selectorSlot ?? null,
        hotbar: hotbar.items,
        playerCount: Object.keys(this.bot.players || {}).length,
        guiSlot: extraData.guiSlot ?? null,
        guiTitle: extraData.guiTitle || null,
        hotbarIndex: extraData.hotbarIndex ?? null,
        hubLocked: extraData.hubLocked ?? false,
      };

      const p = this._profilePath();
      fs.writeFileSync(p, JSON.stringify(profile, null, 2), 'utf8');
      console.log(`[HubProfile] Saved profile to ${p}`);
      return true;
    } catch (e) {
      console.warn(`[HubProfile] Save failed: ${e.message}`);
      return false;
    }
  }

  lockHub() {
    const existing = this.load() || {};
    existing.hubLocked = true;
    try {
      const p = this._profilePath();
      fs.writeFileSync(p, JSON.stringify(existing, null, 2), 'utf8');
      console.log('[HubProfile] Hub marked as locked — navigation disabled for this server.');
      return true;
    } catch (e) {
      console.warn(`[HubProfile] Lock failed: ${e.message}`);
      return false;
    }
  }

  isHubLocked() {
    const data = this.load();
    return data && data.hubLocked === true;
  }

  _getHotbarSummary() {
    const items = this.bot.inventory?.items() || [];
    const hotbarItems = items.filter(i => i.slot >= 36 && i.slot <= 44).map(i => ({
      slot: i.slot - 36,
      name: i.name,
      displayName: i.displayName?.replace(/§./g, '') || i.name,
    }));

    const selectorItem = hotbarItems.find(i => {
      const name = i.name.toLowerCase();
      return name.includes('compass') || name.includes('nether_star') ||
             name.includes('slime_ball') || name.includes('clock');
    });

    return {
      items: hotbarItems,
      selector: selectorItem?.name || null,
      selectorSlot: selectorItem?.slot ?? null,
    };
  }

  delete() {
    try {
      const p = this._profilePath();
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.log(`[HubProfile] Deleted profile ${p}`);
        return true;
      }
    } catch (e) {
      console.warn(`[HubProfile] Delete failed: ${e.message}`);
    }
    return false;
  }
}

// dm/bootstrap.js — Device Management bootstrap client
// Loaded via <script> in popup.html / options.html ET via importScripts dans le
// service worker (background.js). Exposé sur globalThis pour couvrir window
// (popup/options) ET self (service worker).
// Config convention aligned with AssistantMiraiLibreOffice (snake_case keys)

globalThis.DMBootstrap = {
  _configCache: null,
  _localConfig: null,

  // Hardcoded fallback (= profil "prod")
  _fallbackConfig: {
    bootstrap_url: 'https://bootstrap.fake-domain.name',
    config_path: '/config/mirai-browser/config.json?profile=prod',
    keycloakIssuerUrl: 'https://sso.mirai.interieur.gouv.fr/realms/mirai',
    keycloakRealm: 'mirai',
    keycloakClientId: 'bootstrap-iassistant',
    apiBase: 'https://compte-rendu.mirai.interieur.gouv.fr/api',
    chatUrl: 'https://chat.mirai.interieur.gouv.fr/',
    resumeUrl: 'https://resume.mirai.interieur.gouv.fr/',
    compteRenduUrl: 'https://compte-rendu.mirai.interieur.gouv.fr/',
    aideUrl: 'https://mirai.interieur.gouv.fr/aide',
    comuUrl: 'https://webconf.comu.gouv.fr/',
    portal_url: 'https://mirai.interieur.gouv.fr',
    allowedKeywords: ['webconf', 'visio', 'comu', 'webinaire', 'webex', 'gmeet', 'teams'],
    telemetryEnabled: true
  },

  /**
   * Read slug, activeProfile and config from the local dm/config.json.
   * Merges default + activeProfile, same as AssistantMiraiLibreOffice.
   */
  _readLocalConfig() {
    if (this._localConfig) return this._localConfig;
    try {
      const B = (typeof browser !== 'undefined') ? browser : chrome;
      const configUrl = B.runtime.getURL('src/dm/config.json');
      const xhr = new XMLHttpRequest();
      xhr.open('GET', configUrl, false);
      xhr.send();
      if (xhr.status === 200) {
        const raw = JSON.parse(xhr.responseText);
        const profile = raw.activeProfile || 'int';
        const merged = Object.assign({}, raw.default || {}, raw[profile] || {});
        merged._slug = raw.slug || 'mirai-browser';
        merged._profile = profile;
        this._localConfig = merged;
        return merged;
      }
    } catch (e) {
      console.warn('[MirAI DM] Could not read local config.json:', e.message);
    }
    return null;
  },

  getSlug() {
    const local = this._readLocalConfig();
    return (local && local._slug) || 'mirai-browser';
  },

  getProfile() {
    const local = this._readLocalConfig();
    return (local && local._profile) || 'int';
  },

  getBootstrapUrl() {
    const local = this._readLocalConfig();
    return (local && local.bootstrap_url) || this._fallbackConfig.bootstrap_url;
  },

  getConfigPath() {
    const local = this._readLocalConfig();
    return (local && local.config_path) || this._fallbackConfig.config_path;
  },

  /**
   * Fetch config from DM bootstrap server.
   * Uses config_path from profile (same convention as LibreOffice).
   * Falls back to cache, then local config.json, then hardcoded defaults.
   */
  async fetchConfig(bootstrapUrl, slug, profile) {
    bootstrapUrl = bootstrapUrl || this.getBootstrapUrl();
    const configPath = this.getConfigPath();
    slug = slug || this.getSlug();
    profile = profile || this.getProfile();

    try {
      const B = (typeof browser !== 'undefined') ? browser : chrome;
      const { dmClientUUID } = await B.storage.local.get('dmClientUUID');
      const manifest = B.runtime.getManifest();

      // Use config_path if set (like LibreOffice), else build from slug+profile
      const fetchUrl = configPath
        ? `${bootstrapUrl}${configPath}`
        : `${bootstrapUrl}/config/${slug}/config.json?profile=${profile}`;

      const resp = await fetch(fetchUrl, {
        headers: {
          'X-Plugin-Version': manifest.version,
          'X-Client-UUID': dmClientUUID || '',
          'X-Platform-Type': (typeof browser !== 'undefined') ? 'firefox' : 'chrome',
          'X-Platform-Version': navigator.userAgent
        }
      });

      if (!resp.ok) throw new Error(`DM returned ${resp.status}`);

      const data = await resp.json();
      const base = this._readLocalConfig() || this._fallbackConfig;
      const merged = Object.assign({}, this._fallbackConfig, base, data.config || data);
      merged._slug = slug;
      merged._profile = profile;
      this._configCache = merged;

      await B.storage.local.set({
        dmConfig: merged,
        dmConfigLastFetch: Date.now(),
        dmConfigRaw: data
      });

      if (data.update && data.update.action === 'update') {
        await B.storage.local.set({ dmUpdateAvailable: data.update });
      }

      console.info('[MirAI DM] Config fetched and cached from', bootstrapUrl);
      return merged;
    } catch (err) {
      console.warn('[MirAI DM] fetchConfig failed, falling back to cache:', err.message);
      return this._loadCachedOrFallback();
    }
  },

  async _loadCachedOrFallback() {
    try {
      const B = (typeof browser !== 'undefined') ? browser : chrome;
      const { dmConfig } = await B.storage.local.get('dmConfig');
      if (dmConfig) {
        this._configCache = dmConfig;
        console.info('[MirAI DM] Using cached config.');
        return dmConfig;
      }
    } catch (e) {
      console.warn('[MirAI DM] Storage read error:', e.message);
    }
    const local = this._readLocalConfig();
    if (local) {
      console.info('[MirAI DM] Using local config.json profile:', local._profile);
      this._configCache = Object.assign({}, this._fallbackConfig, local);
      return this._configCache;
    }
    console.info('[MirAI DM] Using hardcoded fallback config.');
    this._configCache = Object.assign({}, this._fallbackConfig);
    return this._configCache;
  },

  getConfig() {
    if (this._configCache) return this._configCache;
    const local = this._readLocalConfig();
    if (local) return Object.assign({}, this._fallbackConfig, local);
    return Object.assign({}, this._fallbackConfig);
  },

  async getConfigAsync() {
    if (this._configCache) return this._configCache;
    return this._loadCachedOrFallback();
  },

  async getUpdate() {
    try {
      const B = (typeof browser !== 'undefined') ? browser : chrome;
      const { dmUpdateAvailable } = await B.storage.local.get('dmUpdateAvailable');
      return dmUpdateAvailable || null;
    } catch (e) {
      return null;
    }
  },

  getFeatures() {
    const cfg = this.getConfig();
    return cfg.features || {};
  },

  async init(bootstrapUrl) {
    bootstrapUrl = bootstrapUrl || this.getBootstrapUrl();
    if (bootstrapUrl) {
      await this.fetchConfig(bootstrapUrl);
    } else {
      await this._loadCachedOrFallback();
    }
    return this.getConfig();
  }
};

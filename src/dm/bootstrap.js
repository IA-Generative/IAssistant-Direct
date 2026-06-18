// dm/bootstrap.js — Device Management bootstrap client
// Loaded via <script> in popup.html / options.html ET via importScripts dans le
// service worker (background.js). Exposé sur globalThis pour couvrir window
// (popup/options) ET self (service worker).
// Config convention aligned with AssistantMiraiLibreOffice (snake_case keys)
//
// Multi-DM : le profil "prod" porte une LISTE ORDONNEE `bootstrap_urls` (ordre =
// priorite). Le bootstrap scanne (course echelonnee/hedged) et garde le premier DM
// qui repond ; CE DM sert ensuite toute la config runtime sous ?profile=prod.
// Ordre de resolution des candidats :
//   preference utilisateur (options) > liste poussee par le DM > liste bakee.
// Le gagnant est memorise (sticky) pour les refresh suivants.

globalThis.DMBootstrap = {
  _configCache: null,
  _localConfig: null,
  _lastFetchOk: false,

  // Hardcoded fallback (= profil "prod")
  _fallbackConfig: {
    bootstrap_url: 'https://bootstrap.fake-domain.name',
    bootstrap_urls: ['https://bootstrap.fake-domain.name'],
    bootstrap_stagger_ms: 800,
    bootstrap_timeout_ms: 4000,
    config_path: '/config/iassistant-direct-browser/config.json?profile=prod',
    keycloakIssuerUrl: 'https://sso.mirai.interieur.gouv.fr/realms/mirai',
    keycloakRealm: 'mirai',
    keycloakClientId: 'mirai-extension',
    apiBase: 'https://compte-rendu.mirai.interieur.gouv.fr/api',
    compteRenduUrl: 'https://compte-rendu.mirai.interieur.gouv.fr/',
    comuUrl: 'https://webconf.comu.gouv.fr/',
    portal_url: 'https://mirai.interieur.gouv.fr',
    allowedKeywords: ['webconf', 'visio', 'comu', 'webinaire', 'webex', 'gmeet', 'teams'],
    telemetryEnabled: true
  },

  _B() {
    return (typeof browser !== 'undefined') ? browser : chrome;
  },

  /**
   * Read slug, activeProfile and config from the local dm/config.json.
   * Merges default + activeProfile, same as AssistantMiraiLibreOffice.
   */
  _readLocalConfig() {
    if (this._localConfig) return this._localConfig;
    try {
      const B = this._B();
      const configUrl = B.runtime.getURL('src/dm/config.json');
      const xhr = new XMLHttpRequest();
      xhr.open('GET', configUrl, false);
      xhr.send();
      if (xhr.status === 200) {
        const raw = JSON.parse(xhr.responseText);
        const profile = raw.activeProfile || 'int';
        const merged = Object.assign({}, raw.default || {}, raw[profile] || {});
        merged._slug = raw.slug || 'iassistant-direct-browser';
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
    return (local && local._slug) || 'iassistant-direct-browser';
  },

  getProfile() {
    const local = this._readLocalConfig();
    return (local && local._profile) || 'int';
  },

  // Single bootstrap URL = premier candidat de la liste (compat retro).
  getBootstrapUrl() {
    return this.getBootstrapUrls()[0] || this._fallbackConfig.bootstrap_url;
  },

  // Liste ORDONNEE bakee (ordre = priorite). Profils dev/int : 1 seule URL.
  getBootstrapUrls() {
    const local = this._readLocalConfig() || {};
    if (Array.isArray(local.bootstrap_urls) && local.bootstrap_urls.length) {
      return local.bootstrap_urls.slice();
    }
    if (local.bootstrap_url) return [local.bootstrap_url];
    return this._fallbackConfig.bootstrap_urls.slice();
  },

  getConfigPath() {
    const local = this._readLocalConfig();
    return (local && local.config_path) || this._fallbackConfig.config_path;
  },

  getStaggerMs() {
    const local = this._readLocalConfig() || {};
    return Number(local.bootstrap_stagger_ms) || this._fallbackConfig.bootstrap_stagger_ms;
  },

  getTimeoutMs() {
    const local = this._readLocalConfig() || {};
    return Number(local.bootstrap_timeout_ms) || this._fallbackConfig.bootstrap_timeout_ms;
  },

  // ── Preference utilisateur (persistee) ────────────────────────────────
  async getPreferred() {
    try {
      const { dmPreferredBootstrap } = await this._B().storage.local.get('dmPreferredBootstrap');
      return dmPreferredBootstrap || null;
    } catch (e) { return null; }
  },

  async setPreferred(url) {
    try {
      if (url) await this._B().storage.local.set({ dmPreferredBootstrap: url });
      else await this._B().storage.local.remove('dmPreferredBootstrap');
      return true;
    } catch (e) { return false; }
  },

  async clearPreferred() { return this.setPreferred(null); },

  // ── Liste poussee a distance par le DM (phase 2, lecture seule ici) ────
  async _getPushedUrls() {
    try {
      const { dmPushedBootstrapUrls } = await this._B().storage.local.get('dmPushedBootstrapUrls');
      return Array.isArray(dmPushedBootstrapUrls) ? dmPushedBootstrapUrls : [];
    } catch (e) { return []; }
  },

  // Ordre final des candidats : preference > pousse DM > bakee. Dedupliquee.
  async _candidateOrder() {
    const out = [];
    const seen = new Set();
    const add = (u) => { if (u && !seen.has(u)) { seen.add(u); out.push(u); } };
    add(await this.getPreferred());
    (await this._getPushedUrls()).forEach(add);
    this.getBootstrapUrls().forEach(add);
    return out;
  },

  // ── Sonde un DM (GET sur config_path) ─────────────────────────────────
  async probeOne(url, timeoutMs) {
    timeoutMs = timeoutMs || this.getTimeoutMs();
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(`${url}${this.getConfigPath()}`, {
        method: 'GET',
        signal: ctrl.signal,
        headers: { 'X-Platform-Type': (typeof browser !== 'undefined') ? 'firefox' : 'chrome' }
      });
      clearTimeout(timer);
      return { url, ok: !!resp.ok, status: resp.status, ms: Date.now() - t0 };
    } catch (e) {
      clearTimeout(timer);
      const reason = (e && e.name === 'AbortError') ? 'timeout' : (e && e.message) || 'error';
      return { url, ok: false, status: 0, ms: Date.now() - t0, error: reason };
    }
  },

  // Sonde TOUS les candidats en parallele (pour l'UI options). Conserve l'ordre.
  async probeAll(opts = {}) {
    const order = await this._candidateOrder();
    const timeoutMs = opts.timeoutMs || this.getTimeoutMs();
    const results = await Promise.all(order.map((u) => this.probeOne(u, timeoutMs)));
    return results;
  },

  // ── Course echelonnee (hedged) : respecte l'ordre + bascule rapide ────
  // Lance le primaire tout de suite ; chaque secours est lance apres stagger ms
  // s'il n'y a pas encore de gagnant. Le premier 200 gagne. Memorise le gagnant.
  async resolveBootstrap(opts = {}) {
    const order = await this._candidateOrder();
    if (!order.length) return null;
    const timeoutMs = opts.timeoutMs || this.getTimeoutMs();
    const staggerMs = (opts.staggerMs != null) ? opts.staggerMs : this.getStaggerMs();

    const winner = await new Promise((resolve) => {
      let settled = false;
      let pending = order.length;
      const settle = (url) => { if (!settled) { settled = true; resolve(url); } };
      order.forEach((url, i) => {
        setTimeout(async () => {
          if (settled) { pending--; return; }
          const r = await this.probeOne(url, timeoutMs);
          pending--;
          if (r.ok) settle(url);
          else if (pending === 0) settle(null);
        }, i * staggerMs);
      });
    });

    if (winner) {
      try { await this._B().storage.local.set({ dmResolvedBootstrap: winner }); } catch (e) {}
    }
    return winner;
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
    this._lastFetchOk = false;

    try {
      const B = this._B();
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
      // Le DM gagnant devient le bootstrap_url effectif (sticky pour le refresh).
      merged.bootstrap_url = bootstrapUrl;
      this._configCache = merged;
      this._lastFetchOk = true;

      await B.storage.local.set({
        dmConfig: merged,
        dmConfigLastFetch: Date.now(),
        dmConfigRaw: data,
        dmResolvedBootstrap: bootstrapUrl
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
      const B = this._B();
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
      const B = this._B();
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

  // ── Masquage des valeurs sensibles pour affichage (options) ───────────
  _isSensitiveKey(k) {
    return /(secret|token|password|passwd|api[-_]?key|client[-_]?key|authoriz|cred|bearer|private)/i.test(k);
  },

  maskValue(v, visible = 4) {
    if (v == null) return '';
    if (typeof v !== 'string') v = String(v);
    if (v.length <= visible) return (v[0] || '') + '•••';
    const dots = '•'.repeat(Math.min(v.length - visible, 12));
    return v.slice(0, visible) + dots;
  },

  // Retourne une COPIE d'affichage : cles sensibles tronquees, cles _internes
  // et tableaux/objets ignores. URLs/identifiants publics laisses en clair.
  maskConfig(cfg, visible = 4) {
    const out = {};
    Object.keys(cfg || {}).forEach((k) => {
      if (k.startsWith('_')) return;
      const v = cfg[k];
      if (v && typeof v === 'object') return; // tableaux/objets non affiches a plat
      out[k] = this._isSensitiveKey(k) ? this.maskValue(v, visible) : v;
    });
    return out;
  },

  async init(bootstrapUrl) {
    // 1) URL explicite (tests / appel direct) : fetch direct.
    if (bootstrapUrl) {
      await this.fetchConfig(bootstrapUrl);
      return this.getConfig();
    }
    // 2) Sticky : reessaye le dernier DM resolu directement.
    let sticky = null;
    try {
      ({ dmResolvedBootstrap: sticky } = await this._B().storage.local.get('dmResolvedBootstrap'));
    } catch (e) {}
    if (sticky) {
      await this.fetchConfig(sticky);
      if (this._lastFetchOk) return this.getConfig();
    }
    // 3) Scan ordonne (hedged) puis fetch sur le gagnant.
    const winner = await this.resolveBootstrap();
    if (winner) await this.fetchConfig(winner);
    else await this._loadCachedOrFallback();
    return this.getConfig();
  }
};

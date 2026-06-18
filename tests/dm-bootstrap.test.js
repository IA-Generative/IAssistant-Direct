// tests/dm-bootstrap.test.js

beforeEach(() => {
  __resetChromeStorage();
  jest.clearAllMocks();
  delete window.DMBootstrap;

  const fs = require('fs');
  const code = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'dm', 'bootstrap.js'), 'utf8');
  eval(code);
});

describe('DMBootstrap', () => {

  describe('getConfig() — fallback sans DM', () => {
    test('retourne la config fallback par defaut', () => {
      const config = window.DMBootstrap.getConfig();
      expect(config).toBeDefined();
      expect(config.keycloakIssuerUrl).toBe('https://sso.mirai.interieur.gouv.fr/realms/mirai');
      expect(config.keycloakRealm).toBe('mirai');
      expect(config.keycloakClientId).toBe('mirai-extension');
      expect(config.apiBase).toBe('https://compte-rendu.mirai.interieur.gouv.fr/api');
      expect(config.bootstrap_url).toBe('https://bootstrap.fake-domain.name');
    });

    test('contient les URLs de raccourcis actives', () => {
      const config = window.DMBootstrap.getConfig();
      expect(config.compteRenduUrl).toBe('https://compte-rendu.mirai.interieur.gouv.fr/');
      expect(config.comuUrl).toBe('https://webconf.comu.gouv.fr/');
    });

    test('contient les allowedKeywords', () => {
      const config = window.DMBootstrap.getConfig();
      expect(config.allowedKeywords).toEqual(
        ['webconf', 'visio', 'comu', 'webinaire', 'webex', 'gmeet', 'teams']
      );
    });
  });

  describe('fetchConfig() — appel DM reussi', () => {
    test('merge la reponse DM avec les fallbacks', async () => {
      __seedChromeStorage({ dmClientUUID: 'test-uuid-123' });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          config: {
            apiBase: 'https://custom-api.example.com/api',
            comuUrl: 'https://custom-comu.example.com/'
          }
        })
      });

      const config = await window.DMBootstrap.fetchConfig(
        'https://bootstrap.test.com', 'iassistant-direct-browser', 'int'
      );

      expect(config.apiBase).toBe('https://custom-api.example.com/api');
      expect(config.comuUrl).toBe('https://custom-comu.example.com/');
      // Non-overridden values stay from fallback
      expect(config.keycloakIssuerUrl).toBe('https://sso.mirai.interieur.gouv.fr/realms/mirai');
      expect(config.keycloakRealm).toBe('mirai');
    });

    test('envoie les headers DM corrects', async () => {
      __seedChromeStorage({ dmClientUUID: 'uuid-abc' });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ config: {} })
      });

      await window.DMBootstrap.fetchConfig('https://dm.test', 'iassistant-direct-browser', 'int');

      const fetchUrl = global.fetch.mock.calls[0][0];
      expect(fetchUrl).toContain('https://dm.test');
      expect(fetchUrl).toContain('iassistant-direct-browser');
      const headers = global.fetch.mock.calls[0][1].headers;
      expect(headers['X-Plugin-Version']).toBe('1.2.1');
      expect(headers['X-Client-UUID']).toBe('uuid-abc');
      expect(headers['X-Platform-Type']).toBe('chrome');
    });

    test('persiste la config dans chrome.storage.local', async () => {
      __seedChromeStorage({ dmClientUUID: 'test-uuid' });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          config: { apiBase: 'https://new-api.test/api' }
        })
      });

      await window.DMBootstrap.fetchConfig('https://dm.test');

      const storage = __getChromeStorage();
      expect(storage.dmConfig).toBeDefined();
      expect(storage.dmConfig.apiBase).toBe('https://new-api.test/api');
      expect(storage.dmConfigLastFetch).toBeGreaterThan(0);
    });
  });

  describe('fetchConfig() — fallback sur erreur', () => {
    test('utilise le cache storage si DM echoue', async () => {
      __seedChromeStorage({
        dmClientUUID: 'test-uuid',
        dmConfig: {
          apiBase: 'https://cached-api.test/api',
          keycloakIssuerUrl: 'https://cached-sso.test/realms/test'
        }
      });

      global.fetch.mockRejectedValueOnce(new Error('Network error'));
      const config = await window.DMBootstrap.fetchConfig('https://dm.unreachable');

      expect(config.apiBase).toBe('https://cached-api.test/api');
      expect(config.keycloakIssuerUrl).toBe('https://cached-sso.test/realms/test');
    });

    test('utilise le fallback hardcode si DM echoue ET pas de cache', async () => {
      __seedChromeStorage({ dmClientUUID: 'test-uuid' });

      global.fetch.mockRejectedValueOnce(new Error('Network error'));
      const config = await window.DMBootstrap.fetchConfig('https://dm.unreachable');

      expect(config.apiBase).toBe('https://compte-rendu.mirai.interieur.gouv.fr/api');
      expect(config.keycloakIssuerUrl).toBe('https://sso.mirai.interieur.gouv.fr/realms/mirai');
    });

    test('retourne le fallback si DM repond 500', async () => {
      __seedChromeStorage({ dmClientUUID: 'test-uuid' });

      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: 'Internal Server Error' })
      });

      const config = await window.DMBootstrap.fetchConfig('https://dm.test');
      expect(config.keycloakIssuerUrl).toBe('https://sso.mirai.interieur.gouv.fr/realms/mirai');
    });
  });

  describe('init()', () => {
    test('sans arg : scanne (sonde + fetch) et applique la config du DM', async () => {
      __seedChromeStorage({ dmClientUUID: 'uuid-init' });

      // Nouveau flux : init() sonde les candidats puis fetch le gagnant
      // => au moins 2 appels fetch (sonde + fetchConfig). Mock persistant.
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ config: { apiBase: 'https://dm-default.test/api' } })
      });

      const config = await window.DMBootstrap.init();
      expect(global.fetch).toHaveBeenCalled();
      expect(config.apiBase).toBe('https://dm-default.test/api');
    });

    test('avec bootstrapUrl, appelle fetchConfig', async () => {
      __seedChromeStorage({ dmClientUUID: 'uuid-init' });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ config: { apiBase: 'https://dm-init.test/api' } })
      });

      const config = await window.DMBootstrap.init('https://dm.test');
      expect(global.fetch).toHaveBeenCalled();
      expect(config.apiBase).toBe('https://dm-init.test/api');
    });
  });

  describe('getUpdate()', () => {
    test('retourne null si pas de mise a jour', async () => {
      const update = await window.DMBootstrap.getUpdate();
      expect(update).toBeNull();
    });

    test('retourne la directive update si presente', async () => {
      __seedChromeStorage({
        dmUpdateAvailable: { action: 'update', target_version: '1.3.0', artifact_url: 'https://dl.test/v1.3.0.zip' }
      });

      const update = await window.DMBootstrap.getUpdate();
      expect(update).toBeDefined();
      expect(update.target_version).toBe('1.3.0');
    });
  });

  describe('getFeatures()', () => {
    test('retourne un objet vide par defaut', () => {
      const features = window.DMBootstrap.getFeatures();
      expect(features).toEqual({});
    });
  });

  // ── Multi-DM : liste, preference, scan, masquage ─────────────────────
  describe('getBootstrapUrls() — liste de candidats', () => {
    test('retourne le tableau fallback en l absence de config locale', () => {
      const urls = window.DMBootstrap.getBootstrapUrls();
      expect(Array.isArray(urls)).toBe(true);
      expect(urls).toContain('https://bootstrap.fake-domain.name');
      // getBootstrapUrl() = premier candidat
      expect(window.DMBootstrap.getBootstrapUrl()).toBe(urls[0]);
    });
  });

  describe('preference utilisateur', () => {
    test('setPreferred/getPreferred round-trip et persistance storage', async () => {
      await window.DMBootstrap.setPreferred('https://dm.prefere.test');
      expect(await window.DMBootstrap.getPreferred()).toBe('https://dm.prefere.test');
      expect(__getChromeStorage().dmPreferredBootstrap).toBe('https://dm.prefere.test');
      await window.DMBootstrap.clearPreferred();
      expect(await window.DMBootstrap.getPreferred()).toBeNull();
    });

    test('_candidateOrder : preference puis pousse-DM puis bakee, dedupliquee', async () => {
      __seedChromeStorage({
        dmPreferredBootstrap: 'https://pref.test',
        dmPushedBootstrapUrls: ['https://pousse.test', 'https://bootstrap.fake-domain.name']
      });
      const order = await window.DMBootstrap._candidateOrder();
      expect(order[0]).toBe('https://pref.test');
      expect(order[1]).toBe('https://pousse.test');
      // fake-domain present une seule fois (dedup baked vs pousse)
      expect(order.filter((u) => u === 'https://bootstrap.fake-domain.name').length).toBe(1);
    });
  });

  describe('probeAll() / resolveBootstrap()', () => {
    test('probeAll renvoie un statut ok par candidat', async () => {
      global.fetch.mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
      const results = await window.DMBootstrap.probeAll();
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].ok).toBe(true);
      expect(typeof results[0].ms).toBe('number');
    });

    test('resolveBootstrap respecte l ordre et bascule sur le 1er qui repond', async () => {
      __seedChromeStorage({
        dmPreferredBootstrap: 'https://down.test',     // primaire injoignable
        dmPushedBootstrapUrls: ['https://up.test']      // secours OK
      });
      // 1er fetch (sonde down) rejette, les suivants OK
      global.fetch
        .mockRejectedValueOnce(new Error('refused'))
        .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });

      const winner = await window.DMBootstrap.resolveBootstrap({ staggerMs: 0, timeoutMs: 1000 });
      expect(winner).toBe('https://up.test');
      // gagnant memorise (sticky)
      expect(__getChromeStorage().dmResolvedBootstrap).toBe('https://up.test');
    });

    test('resolveBootstrap renvoie null si aucun DM ne repond', async () => {
      global.fetch.mockRejectedValue(new Error('network down'));
      const winner = await window.DMBootstrap.resolveBootstrap({ staggerMs: 0, timeoutMs: 500 });
      expect(winner).toBeNull();
    });
  });

  describe('getConfigAsync() — relit le dmConfig persiste (fix issuer service worker)', () => {
    test('retourne l issuer SERVI par le DM (storage), pas le fallback sso.mirai', async () => {
      // Simule le service worker : _configCache vide (instance fraiche), pas de
      // _readLocalConfig possible (XHR KO en SW). La seule source fiable = le
      // dmConfig persiste par le login. getConfigAsync() doit le relire.
      __seedChromeStorage({
        dmConfig: {
          keycloakIssuerUrl: 'https://sso.dm-servi.example/realms/onprem',
          keycloakRealm: 'onprem'
        }
      });
      const cfg = await window.DMBootstrap.getConfigAsync();
      expect(cfg.keycloakIssuerUrl).toBe('https://sso.dm-servi.example/realms/onprem');
      expect(cfg.keycloakIssuerUrl).not.toContain('sso.mirai.interieur.gouv.fr');
    });
  });

  describe('masquage des creds', () => {
    test('maskValue garde les premiers caracteres', () => {
      expect(window.DMBootstrap.maskValue('s3cr3t-value-1234', 4)).toMatch(/^s3cr•+$/);
      expect(window.DMBootstrap.maskValue('ab', 4)).toBe('a•••');
    });

    test('maskConfig masque les cles sensibles, garde URLs/identifiants', () => {
      const masked = window.DMBootstrap.maskConfig({
        bootstrap_url: 'https://dm.test',
        keycloakClientId: 'mirai-extension',
        relayClientKey: 'AbCdEfGhIjKl',
        access_token: 'tok_should_hide_me',
        allowedKeywords: ['a', 'b'],     // objet/tableau -> ignore
        _profile: 'prod'                  // cle interne -> ignore
      });
      expect(masked.bootstrap_url).toBe('https://dm.test');
      expect(masked.keycloakClientId).toBe('mirai-extension');
      expect(masked.relayClientKey.startsWith('AbCd')).toBe(true);
      expect(masked.relayClientKey).toContain('•');
      expect(masked.access_token).toContain('•');
      expect(masked.allowedKeywords).toBeUndefined();
      expect(masked._profile).toBeUndefined();
    });
  });
});

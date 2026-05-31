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
      expect(config.keycloakClientId).toBe('bootstrap-iassistant');
      expect(config.apiBase).toBe('https://compte-rendu.mirai.interieur.gouv.fr/api');
      expect(config.bootstrap_url).toBe('https://bootstrap.fake-domain.name');
    });

    test('contient toutes les URLs de raccourcis', () => {
      const config = window.DMBootstrap.getConfig();
      expect(config.chatUrl).toBe('https://chat.mirai.interieur.gouv.fr/');
      expect(config.resumeUrl).toBe('https://resume.mirai.interieur.gouv.fr/');
      expect(config.compteRenduUrl).toBe('https://compte-rendu.mirai.interieur.gouv.fr/');
      expect(config.aideUrl).toBe('https://mirai.interieur.gouv.fr/aide');
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
            chatUrl: 'https://custom-chat.example.com/'
          }
        })
      });

      const config = await window.DMBootstrap.fetchConfig(
        'https://bootstrap.test.com', 'mirai-browser', 'int'
      );

      expect(config.apiBase).toBe('https://custom-api.example.com/api');
      expect(config.chatUrl).toBe('https://custom-chat.example.com/');
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

      await window.DMBootstrap.fetchConfig('https://dm.test', 'mirai-browser', 'int');

      const fetchUrl = global.fetch.mock.calls[0][0];
      expect(fetchUrl).toContain('https://dm.test');
      expect(fetchUrl).toContain('mirai-browser');
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
    test('utilise le fallback bootstrap_url et fetch', async () => {
      __seedChromeStorage({ dmClientUUID: 'uuid-init' });

      global.fetch.mockResolvedValueOnce({
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
});

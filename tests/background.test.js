// tests/background.test.js

// background.js uses `self.addEventListener` and `api.runtime.*` — we need to mock those
beforeEach(() => {
  __resetChromeStorage();
  jest.clearAllMocks();

  // Reset listeners
  global.self = global;
  global.self.skipWaiting = jest.fn();
  global.self.clients = { claim: jest.fn(() => Promise.resolve()) };

  // Collect event listeners
  self._listeners = {};
  self.addEventListener = jest.fn((event, handler) => {
    self._listeners[event] = handler;
  });

  // Reset chrome mock listeners
  chrome.runtime.onInstalled.addListener.mockClear();
  chrome.runtime.onMessage.addListener.mockClear();
  chrome.alarms.onAlarm.addListener.mockClear();
  chrome.alarms.create.mockClear();
});

function loadBackground() {
  const fs = require('fs');
  const code = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'background.js'), 'utf8');
  eval(code);
}

describe('background.js', () => {

  describe('Service Worker lifecycle', () => {
    test('enregistre les listeners install et activate', () => {
      loadBackground();

      expect(self.addEventListener).toHaveBeenCalledWith('install', expect.any(Function));
      expect(self.addEventListener).toHaveBeenCalledWith('activate', expect.any(Function));
    });

    test('skipWaiting est appele sur install', () => {
      loadBackground();
      const installHandler = self._listeners['install'];
      installHandler();
      expect(self.skipWaiting).toHaveBeenCalled();
    });
  });

  describe('Client UUID generation', () => {
    test('genere un UUID si absent', async () => {
      loadBackground();

      // Get the onInstalled handler
      const onInstalledHandler = chrome.runtime.onInstalled.addListener.mock.calls[0][0];
      await onInstalledHandler({ reason: 'install' });

      const storage = __getChromeStorage();
      expect(storage.dmClientUUID).toBe('mock-uuid-1234-5678-abcd');
    });

    test('ne remplace pas un UUID existant', async () => {
      __seedChromeStorage({ dmClientUUID: 'existing-uuid-preserved' });

      loadBackground();

      const onInstalledHandler = chrome.runtime.onInstalled.addListener.mock.calls[0][0];
      await onInstalledHandler({ reason: 'update' });

      const storage = __getChromeStorage();
      expect(storage.dmClientUUID).toBe('existing-uuid-preserved');
    });
  });

  describe('Config refresh alarm', () => {
    test('cree un alarm dm-config-refresh toutes les 30 min', async () => {
      loadBackground();

      const onInstalledHandler = chrome.runtime.onInstalled.addListener.mock.calls[0][0];
      await onInstalledHandler({ reason: 'install' });

      expect(chrome.alarms.create).toHaveBeenCalledWith(
        'dm-config-refresh',
        { periodInMinutes: 30 }
      );
    });

    test('le handler alarm appelle fetch avec les bons headers', async () => {
      __seedChromeStorage({ dmClientUUID: 'alarm-uuid' });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ apiBase: 'https://refreshed.test/api' })
      });

      loadBackground();

      const alarmHandler = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
      await alarmHandler({ name: 'dm-config-refresh' });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/config/iassistant-direct-browser/config.json?profile=prod'),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Plugin-Version': '1.2.1',
            'X-Client-UUID': 'alarm-uuid'
          })
        })
      );
    });

    test('ignore les alarms non-DM', async () => {
      loadBackground();

      const alarmHandler = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
      await alarmHandler({ name: 'some-other-alarm' });

      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('stocke la config rafraichie dans storage', async () => {
      __seedChromeStorage({ dmClientUUID: 'store-uuid' });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ apiBase: 'https://stored.test/api' })
      });

      loadBackground();

      const alarmHandler = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
      await alarmHandler({ name: 'dm-config-refresh' });

      const storage = __getChromeStorage();
      expect(storage.dmConfig).toBeDefined();
      expect(storage.dmConfigLastFetch).toBeGreaterThan(0);
    });

    test('ne plante pas si DM est injoignable', async () => {
      __seedChromeStorage({ dmClientUUID: 'fail-uuid' });

      global.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      loadBackground();

      const alarmHandler = chrome.alarms.onAlarm.addListener.mock.calls[0][0];

      await expect(
        alarmHandler({ name: 'dm-config-refresh' })
      ).resolves.not.toThrow();
    });
  });

  describe('Update notification', () => {
    test('cree une notification si update disponible', async () => {
      __seedChromeStorage({ dmClientUUID: 'update-uuid' });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          update: { action: 'update', target_version: '2.0.0' }
        })
      });

      loadBackground();

      const alarmHandler = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
      await alarmHandler({ name: 'dm-config-refresh' });

      expect(chrome.notifications.create).toHaveBeenCalledWith(
        'dm-update',
        expect.objectContaining({
          type: 'basic',
          title: 'Mise a jour disponible',
          message: expect.stringContaining('2.0.0')
        })
      );

      const storage = __getChromeStorage();
      expect(storage.dmUpdateAvailable).toBeDefined();
      expect(storage.dmUpdateAvailable.target_version).toBe('2.0.0');
    });

    test('ne notifie pas si la version est la meme', async () => {
      __seedChromeStorage({ dmClientUUID: 'same-version-uuid' });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          update: { action: 'update', target_version: '1.2.1' } // same as current
        })
      });

      loadBackground();

      const alarmHandler = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
      await alarmHandler({ name: 'dm-config-refresh' });

      expect(chrome.notifications.create).not.toHaveBeenCalled();
    });
  });

  describe('Message handler', () => {
    test('repond ok au message record:finished', () => {
      loadBackground();

      const messageHandler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
      const sendResponse = jest.fn();

      messageHandler({ type: 'record:finished', payload: { id: 42 } }, {}, sendResponse);

      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    });
  });
});

describe('PKCE : service worker redémarré pendant la connexion', () => {
  const ATTENTE = { verifier: 'verif', redirectUri: 'chrome-extension://id/src/callback.html', clientId: 'mirai-extension', tokenUrl: 'https://sso.fake-domain.name/realms/mirai/protocol/openid-connect/token' };
  const rappel = (msg) => new Promise((resolve) => {
    const handler = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    handler(msg, {}, resolve);
  });

  beforeEach(() => {
    global.TokenStore = { storeToken: jest.fn(async () => {}), getToken: jest.fn(async () => null) };
  });

  test('l\'état persisté sert à l\'échange du code, puis est effacé', async () => {
    __seedChromeStorage({ pkceEnAttente: { ...ATTENTE, t: Date.now() } });
    loadBackground();   // variables en mémoire vides, comme après un redémarrage
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'a', refresh_token: 'r', expires_in: 300 }) }));
    const r = await rappel({ type: 'pkce:callback', code: 'code-123' });
    expect(r).toEqual({ ok: true });
    const corps = global.fetch.mock.calls[0][1].body;
    expect(global.fetch.mock.calls[0][0]).toBe(ATTENTE.tokenUrl);
    expect(corps.get('code_verifier')).toBe('verif');
    expect(corps.get('code')).toBe('code-123');
    expect(TokenStore.storeToken).toHaveBeenCalled();
    expect(__getChromeStorage().pkceEnAttente).toBeUndefined();
  });

  test('échange refusé : l\'échec est rendu à la page de retour', async () => {
    __seedChromeStorage({ pkceEnAttente: { ...ATTENTE, t: Date.now() } });
    loadBackground();
    global.fetch = jest.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'Code not valid' }) }));
    const r = await rappel({ type: 'pkce:callback', code: 'code-123' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('invalid_grant : Code not valid');
    expect(TokenStore.storeToken).not.toHaveBeenCalled();
  });

  test('état trop ancien ou absent : code gardé pour le popup (pkce:getCode)', async () => {
    __seedChromeStorage({ pkceEnAttente: { ...ATTENTE, t: Date.now() - 11 * 60 * 1000 } });
    loadBackground();
    global.fetch = jest.fn();
    expect(await rappel({ type: 'pkce:callback', code: 'code-123' })).toEqual({ ok: true });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await rappel({ type: 'pkce:getCode' })).toEqual(expect.objectContaining({ code: 'code-123' }));
  });
});

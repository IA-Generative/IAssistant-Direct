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

  // Contrat d'agents MirAI : MesAgents simule (importScripts n'existe pas sous Jest)
  global.MesAgents = {
    setAuth: jest.fn(),
    viderCache: jest.fn(() => Promise.resolve()),
    listerAgents: jest.fn(() => Promise.resolve([])),
    lancerAgent: jest.fn(() => Promise.resolve({ texte: 'Réponse', model: 'a', id: null })),
    messageErreur: jest.fn((e) => e?.message || 'Erreur inattendue en contactant Mes agents.')
  };
  global.DMBootstrap = { _loadCachedOrFallback: jest.fn(() => Promise.resolve({})) };
});

afterEach(() => {
  delete global.MesAgents;
  delete global.DMBootstrap;
});

function loadBackground() {
  const fs = require('fs');
  const path = require('path');
  // crypto.js expose TokenStore (globalThis) — importScripts n'existe pas sous Jest.
  if (typeof globalThis.TokenStore === 'undefined') {
    eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'crypto.js'), 'utf8'));
  }
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
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
        expect.stringContaining('/config/mirai-browser/config.json?profile=int'),
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

  // ====================================================================
  // Agents MirAI — menus contextuels (contrat d'agents)
  // ====================================================================
  describe('Agents MirAI — menus contextuels', () => {
    const AGENTS = [
      { id: 'sel', name: 'Reformulateur', model: 'sel', inputs: ['text', 'selection'] },
      { id: 'pg', name: 'Résumeur de page & co', model: 'pg', inputs: ['page'] },
      { id: 'both', name: 'Polyvalent', model: 'both', inputs: ['selection', 'page'] },
      { id: 'txt', name: 'Texte seul', model: 'txt', inputs: ['text'] }
    ];

    function derniersHandlers() {
      const installed = chrome.runtime.onInstalled.addListener.mock.calls;
      const alarms = chrome.alarms.onAlarm.addListener.mock.calls;
      return {
        onInstalled: installed[installed.length - 1][0],
        onAlarm: alarms[alarms.length - 1][0],
        onMenuClick: chrome.contextMenus.onClicked.addListener.mock.calls[0][0],
        onStorageChanged: chrome.storage.onChanged.addListener.mock.calls[0][0]
      };
    }

    test('installe un adaptateur de jeton sur MesAgents et ecoute les menus, le stockage et le demarrage', () => {
      loadBackground();
      expect(global.MesAgents.setAuth).toHaveBeenCalledWith(expect.objectContaining({ obtenirJeton: expect.any(Function) }));
      expect(chrome.contextMenus.onClicked.addListener).toHaveBeenCalledTimes(1);
      expect(chrome.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
      expect(chrome.runtime.onStartup.addListener).toHaveBeenCalledTimes(1);
      expect(chrome.notifications.onClicked.addListener).toHaveBeenCalledTimes(1);
    });

    test('onInstalled cree une alarme mesagents-refresh toutes les 3 min sans toucher a dm-config-refresh', async () => {
      loadBackground();
      for (const call of chrome.runtime.onInstalled.addListener.mock.calls) await call[0]({ reason: 'install' });
      expect(chrome.alarms.create).toHaveBeenCalledWith('dm-config-refresh', { periodInMinutes: 30 });
      expect(chrome.alarms.create).toHaveBeenCalledWith('mesagents-refresh', { periodInMinutes: 3 });
    });

    test('l\'alarme mesagents-refresh reconstruit le menu : parent + un sous-menu par agent selon ses inputs', async () => {
      global.MesAgents.listerAgents.mockResolvedValue(AGENTS);
      loadBackground();
      const { onAlarm } = derniersHandlers();
      await onAlarm({ name: 'mesagents-refresh' });
      await flush();

      expect(global.MesAgents.listerAgents).toHaveBeenCalledWith({ force: true });
      expect(chrome.contextMenus.removeAll).toHaveBeenCalled();
      const creations = chrome.contextMenus.create.mock.calls.map(c => c[0]);
      const parent = creations.find(c => c.id === 'mirai-agents');
      expect(parent).toMatchObject({ title: 'Agents MirAI' });
      expect(parent.contexts.sort()).toEqual(['page', 'selection']);

      const parId = Object.fromEntries(creations.filter(c => c.parentId === 'mirai-agents').map(c => [c.id, c]));
      expect(Object.keys(parId).sort()).toEqual(['mirai-agent:both', 'mirai-agent:pg', 'mirai-agent:sel']);
      expect(parId['mirai-agent:sel'].contexts).toEqual(['selection']);
      expect(parId['mirai-agent:pg'].contexts).toEqual(['page']);
      expect(parId['mirai-agent:both'].contexts).toEqual(['selection', 'page']);
      // `&` echappe (accelerateur de menu), agent « text » seul absent
      expect(parId['mirai-agent:pg'].title).toBe('Résumeur de page && co');
      expect(parId['mirai-agent:txt']).toBeUndefined();
    });

    test('aucun menu si la liste echoue (fonction masquee) ou si aucun agent n\'accepte selection/page', async () => {
      global.MesAgents.listerAgents.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'invalid_token', masquer: true }));
      loadBackground();
      const { onAlarm } = derniersHandlers();
      await onAlarm({ name: 'mesagents-refresh' });
      await flush();
      expect(chrome.contextMenus.removeAll).toHaveBeenCalled();
      expect(chrome.contextMenus.create).not.toHaveBeenCalled();

      global.MesAgents.listerAgents.mockResolvedValueOnce([{ id: 'txt', name: 'T', model: 'txt', inputs: ['text'] }]);
      await onAlarm({ name: 'mesagents-refresh' });
      await flush();
      expect(chrome.contextMenus.create).not.toHaveBeenCalled();
    });

    test('ouverture / fermeture de session (jeton chiffre) reconstruit le menu ; simple rafraichissement non', async () => {
      loadBackground();
      const { onStorageChanged } = derniersHandlers();

      onStorageChanged({ miraiToken: { newValue: { iv: [1] } } }, 'local');           // login
      await flush();
      expect(global.MesAgents.viderCache).toHaveBeenCalledTimes(1);
      expect(chrome.contextMenus.removeAll).toHaveBeenCalledTimes(1);

      onStorageChanged({ miraiToken: { oldValue: { iv: [1] }, newValue: { iv: [2] } } }, 'local'); // refresh
      await flush();
      expect(chrome.contextMenus.removeAll).toHaveBeenCalledTimes(1);

      onStorageChanged({ miraiToken: { oldValue: { iv: [2] } } }, 'local');           // logout
      await flush();
      expect(chrome.contextMenus.removeAll).toHaveBeenCalledTimes(2);

      onStorageChanged({ dmConfig: { newValue: {} } }, 'local');
      await flush();
      expect(chrome.contextMenus.removeAll).toHaveBeenCalledTimes(2);
    });

    test('clic sur un agent avec selection : lit la selection par script, lance l\'agent, publie le resultat en session, ouvre le popup', async () => {
      global.MesAgents.listerAgents.mockResolvedValue(AGENTS);
      chrome.scripting.executeScript.mockResolvedValueOnce([{ result: 'Texte sélectionné\navec retour' }]);
      loadBackground();
      const { onMenuClick } = derniersHandlers();

      onMenuClick({ menuItemId: 'mirai-agent:sel', selectionText: 'Texte sélectionné avec retour' }, { id: 12, windowId: 3, url: 'https://ex.test/p', title: 'Page' });
      await flush();

      expect(chrome.action.openPopup).toHaveBeenCalledWith({ windowId: 3 });
      expect(chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 12 } }));
      expect(global.MesAgents.lancerAgent).toHaveBeenCalledWith({
        model: 'sel',
        consigne: expect.stringContaining('passage sélectionné'),
        contenu: 'Texte sélectionné\navec retour'
      });
      const res = __getSessionStorage().mesagentsResultat;
      expect(res).toMatchObject({ status: 'done', agent: { id: 'sel', name: 'Reformulateur' }, texte: 'Réponse' });
      expect(chrome.notifications.create).not.toHaveBeenCalled();
    });

    test('clic sans possibilite de script : replie sur info.selectionText', async () => {
      global.MesAgents.listerAgents.mockResolvedValue(AGENTS);
      chrome.scripting.executeScript.mockRejectedValueOnce(new Error('page privilegiee'));
      loadBackground();
      const { onMenuClick } = derniersHandlers();
      onMenuClick({ menuItemId: 'mirai-agent:sel', selectionText: 'repli' }, { id: 1, windowId: 1 });
      await flush();
      expect(global.MesAgents.lancerAgent).toHaveBeenCalledWith(expect.objectContaining({ contenu: 'repli' }));
    });

    test('clic sur une page : titre + URL + texte principal borne a 20 000 caracteres', async () => {
      global.MesAgents.listerAgents.mockResolvedValue(AGENTS);
      chrome.scripting.executeScript.mockResolvedValueOnce([{ result: { title: 'Ma page', url: 'https://ex.test/p', text: 'y'.repeat(30000) } }]);
      loadBackground();
      const { onMenuClick } = derniersHandlers();
      onMenuClick({ menuItemId: 'mirai-agent:pg' }, { id: 7, windowId: 1, url: 'https://ex.test/p', title: 'Ma page' });
      await flush();

      const appel = global.MesAgents.lancerAgent.mock.calls[0][0];
      expect(appel.model).toBe('pg');
      expect(appel.consigne).toContain('page web');
      expect(appel.contenu.startsWith('Titre : Ma page\nAdresse : https://ex.test/p\n\n')).toBe(true);
      expect(appel.contenu.length).toBeLessThanOrEqual(20000);
      // La fonction executee dans la page recoit la borne en argument
      expect(chrome.scripting.executeScript.mock.calls[0][0].args).toEqual([20000]);
    });

    test('popup impossible a ouvrir : notification a la fin, resultat quand meme en session', async () => {
      global.MesAgents.listerAgents.mockResolvedValue(AGENTS);
      chrome.action.openPopup.mockRejectedValueOnce(new Error('no active window'));
      chrome.scripting.executeScript.mockResolvedValueOnce([{ result: 'sel' }]);
      loadBackground();
      const { onMenuClick } = derniersHandlers();
      onMenuClick({ menuItemId: 'mirai-agent:sel', selectionText: 'sel' }, { id: 1, windowId: 1 });
      await flush();
      expect(__getSessionStorage().mesagentsResultat.status).toBe('done');
      expect(chrome.notifications.create).toHaveBeenCalledWith('mesagents-resultat', expect.objectContaining({
        type: 'basic', title: 'Réponse de « Reformulateur »'
      }));
    });

    test('erreur de l\'agent (422) : message publie tel quel, pas de reponse', async () => {
      global.MesAgents.listerAgents.mockResolvedValue(AGENTS);
      chrome.scripting.executeScript.mockResolvedValueOnce([{ result: 'sel' }]);
      global.MesAgents.lancerAgent.mockRejectedValueOnce(Object.assign(new Error('Consigne cachée détectée.'), { code: 'blocked_input' }));
      loadBackground();
      const { onMenuClick } = derniersHandlers();
      onMenuClick({ menuItemId: 'mirai-agent:sel', selectionText: 'sel' }, { id: 1, windowId: 1 });
      await flush();
      expect(__getSessionStorage().mesagentsResultat).toMatchObject({ status: 'error', code: 'blocked_input', message: 'Consigne cachée détectée.' });
    });

    test('agent disparu de la liste → « Cet agent n\'est plus accessible »', async () => {
      global.MesAgents.listerAgents.mockResolvedValue([]);
      loadBackground();
      const { onMenuClick } = derniersHandlers();
      onMenuClick({ menuItemId: 'mirai-agent:fantome', selectionText: 'x' }, { id: 1, windowId: 1 });
      await flush();
      expect(global.MesAgents.lancerAgent).not.toHaveBeenCalled();
      expect(__getSessionStorage().mesagentsResultat).toMatchObject({ status: 'error', code: 'model_not_found' });
    });

    test('ignore les clics sur d\'autres menus', async () => {
      loadBackground();
      const { onMenuClick } = derniersHandlers();
      onMenuClick({ menuItemId: 'autre' }, { id: 1 });
      await flush();
      expect(chrome.action.openPopup).not.toHaveBeenCalled();
      expect(global.MesAgents.listerAgents).not.toHaveBeenCalled();
    });

    test('l\'adaptateur de jeton rafraichit de force sur demande (401) et rend null hors session', async () => {
      loadBackground();
      const adaptateur = global.MesAgents.setAuth.mock.calls[0][0];
      expect(await adaptateur.obtenirJeton(false)).toBeNull(); // pas de token stocke

      await TokenStore.storeToken({ access_token: 'valide', refresh_token: 'r', expires_in: Date.now() + 3600000 });
      expect(await adaptateur.obtenirJeton(false)).toBe('valide');
      expect(global.fetch).not.toHaveBeenCalled();

      global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ access_token: 'neuf', refresh_token: 'r2', expires_in: 300 }) });
      expect(await adaptateur.obtenirJeton(true)).toBe('neuf');
      expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/protocol/openid-connect/token'), expect.objectContaining({ method: 'POST' }));
    });
  });
});

// Laisse se derouler les chaines de promesses du service worker.
async function flush() {
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
}

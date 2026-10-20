// tests/mescollections-background.test.js — injection de la bulle par l'arrière-plan

require('../src/mescollections/correspond.js');
require('../src/mescollections/doublure.js');
require('../src/mescollections/sites.js');

const LISTE = {
  ttl_s: 3600,
  sites: [{ motif: 'https://www.legifrance.gouv.fr/codes/*', cibles: [{ type: 'collection', id: 'c1', titre: 'C1' }] }]
};

let surOngletMaj;

function chargerBackground() {
  const fs = require('fs');
  const code = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'background.js'), 'utf8');
  eval(code);
}

beforeEach(() => {
  __resetChromeStorage();
  jest.clearAllMocks();
  global.self = global;
  self.addEventListener = jest.fn();
  global.TokenStore = { getToken: jest.fn(async () => ({ access_token: 'jeton', expires_in: Date.now() + 3600000 })) };
  __seedChromeStorage({ dmConfigRaw: { config: { mycollectionsApiBase: 'https://mescollections.fake-domain.name' } } });

  chrome.alarms.clear = jest.fn();
  chrome.scripting = { executeScript: jest.fn(async () => [{}]) };
  chrome.tabs.sendMessage = jest.fn(async () => undefined);
  chrome.tabs.onUpdated = { addListener: jest.fn((f) => { surOngletMaj = f; }) };
  chrome.tabs.onRemoved = { addListener: jest.fn() };
  chrome.storage.onChanged = { addListener: jest.fn() };
  chrome.runtime.onStartup = { addListener: jest.fn() };

  global.fetch = jest.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => LISTE }));
  chargerBackground();
});

afterEach(() => {
  delete chrome.scripting;
});

test('page déclarée : bulle injectée dans le cadre principal, avec ses cibles', async () => {
  await MesCollectionsSites.lire();
  await surOngletMaj(7, { status: 'complete' }, { url: 'https://www.legifrance.gouv.fr/codes/article/1' });
  expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 7, frameIds: [0] }, files: ['/src/mescollections/bulle.js'] });
  expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, { type: 'mescollections:afficher', cibles: LISTE.sites[0].cibles, etat: 'connecte' }, { frameId: 0 });
});

test('échec d\'injection rendu dans le résultat (Firefox) : aucun message envoyé', async () => {
  chrome.scripting.executeScript = jest.fn(async () => [{ frameId: 0, error: 'Unable to load script' }]);
  await MesCollectionsSites.lire();
  await surOngletMaj(7, { status: 'complete' }, { url: 'https://www.legifrance.gouv.fr/codes/article/1' });
  expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
});

test('autre page : rien n\'est injecté', async () => {
  await MesCollectionsSites.lire();
  await surOngletMaj(8, { status: 'complete' }, { url: 'https://exemple.fake-domain.name/' });
  expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
});

test('Mes collections tombe : la bulle est retirée des onglets porteurs', async () => {
  await MesCollectionsSites.lire();
  await surOngletMaj(7, { status: 'complete' }, { url: 'https://www.legifrance.gouv.fr/codes/article/1' });
  global.fetch = jest.fn(async () => { throw new TypeError('Failed to fetch'); });
  await MesCollectionsSites.lire();
  await surOngletMaj(7, { url: 'https://www.legifrance.gouv.fr/codes/article/2' }, { url: 'https://www.legifrance.gouv.fr/codes/article/2' });
  expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(7, { type: 'mescollections:retirer' }, { frameId: 0 });
});

test('aucun appel réseau à la navigation : la comparaison est locale', async () => {
  await MesCollectionsSites.lire();
  const appels = global.fetch.mock.calls.length;
  await surOngletMaj(9, { url: 'https://www.legifrance.gouv.fr/codes/prive' }, { url: 'https://www.legifrance.gouv.fr/codes/prive' });
  expect(global.fetch.mock.calls.length).toBe(appels);
});

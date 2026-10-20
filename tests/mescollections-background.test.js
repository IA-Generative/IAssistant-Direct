// tests/mescollections-background.test.js — injection de la bulle par l'arrière-plan

require('../src/mescollections/correspond.js');
require('../src/mescollections/doublure.js');
require('../src/mescollections/sites.js');
require('../src/mescollections/api.js');

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

describe('questions depuis la bulle', () => {
  const ecouteurs = () => chrome.runtime.onMessage.addListener.mock.calls.map((c) => c[0]);
  const envoyer = (msg, sender) => new Promise((resolve) => {
    let traite = false;
    for (const f of ecouteurs()) {
      if (f(msg, sender, resolve) === true) traite = true;
    }
    if (!traite) resolve('ignore');
  });
  const ONGLET = { tab: { id: 7, url: 'https://www.legifrance.gouv.fr/codes/article/1' }, frameId: 0 };

  beforeEach(async () => {
    await MesCollectionsSites.lire();
    await surOngletMaj(7, { status: 'complete' }, { url: ONGLET.tab.url });
    global.fetch = jest.fn(async (url) => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => (String(url).includes('/search') ? { results: [{ title: 'T', url: 'https://x.fake-domain.name/1', hits: [{ snippet: 'E' }], context: { collection: { id: 'c1', title: 'C1' } } }] } : LISTE)
    }));
  });

  test('question sur une cible de la page : réponse et conversation gardée pour l\'onglet', async () => {
    const r = await envoyer({ type: 'mescollections:demander', cibles: [{ type: 'collection', id: 'c1' }], question: 'q' }, ONGLET);
    expect(r.ok).toBe(true);
    expect(r.echange.blocs[0].passages[0].titre).toBe('T');
    const c = await envoyer({ type: 'mescollections:conversation' }, ONGLET);
    expect(c.conversation).toHaveLength(1);
  });

  test('cible absente de la page : refusée sans appel', async () => {
    const avant = global.fetch.mock.calls.length;
    const r = await envoyer({ type: 'mescollections:demander', cibles: [{ type: 'collection', id: 'autre' }], question: 'q' }, ONGLET);
    expect(r.ok).toBe(false);
    expect(global.fetch.mock.calls.length).toBe(avant);
  });

  test('cadre secondaire ou onglet non porteur : ignoré', async () => {
    expect(await envoyer({ type: 'mescollections:demander', cibles: [], question: 'q' }, { ...ONGLET, frameId: 3 })).toBe('ignore');
    const r = await envoyer({ type: 'mescollections:demander', cibles: [{ type: 'collection', id: 'c1' }], question: 'q' }, { tab: { id: 99, url: ONGLET.tab.url }, frameId: 0 });
    expect(r.erreur.code).toBe('interdit');
  });

  test('effacer vide la conversation de l\'onglet', async () => {
    await envoyer({ type: 'mescollections:demander', cibles: [{ type: 'collection', id: 'c1' }], question: 'q' }, ONGLET);
    await envoyer({ type: 'mescollections:effacer' }, ONGLET);
    expect((await envoyer({ type: 'mescollections:conversation' }, ONGLET)).conversation).toEqual([]);
  });
});

test('déconnexion : toutes les conversations sont effacées', async () => {
  __seedChromeStorage({ 'mescollectionsConversation:7': [{ question: 'q' }], 'mescollectionsConversation:8': [{ question: 'r' }], autre: 1 });
  const surChangement = chrome.storage.onChanged.addListener.mock.calls[0][0];
  surChangement({ miraiToken: { oldValue: 'chiffre', newValue: undefined } }, 'local');
  await new Promise((r) => setTimeout(r, 0));
  const st = __getChromeStorage();
  expect(st['mescollectionsConversation:7']).toBeUndefined();
  expect(st['mescollectionsConversation:8']).toBeUndefined();
  expect(st.autre).toBe(1);
});

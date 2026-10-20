// tests/mescollections-sites.test.js — sites déclarés : états, retry, mode anonyme

require('../src/mescollections/correspond.js');
require('../src/mescollections/doublure.js');
const Sites = require('../src/mescollections/sites.js');

const BASE = 'https://mescollections.fake-domain.name';
const LISTE = {
  ttl_s: 1800,
  anonyme: false,
  sites: [
    { motif: 'https://www.legifrance.gouv.fr/codes/*', cibles: [{ type: 'assistant', id: 'a1', titre: 'A1' }, { type: 'collection', id: 'c1', titre: 'C1' }] }
  ]
};

function reponse(status, corps, entetes = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (n) => entetes[n.toLowerCase()] ?? null }, json: async () => corps };
}

let maintenant;
let fetchMc;
let jetons;   // file des jetons rendus par obtenirJeton, ou fonction

beforeEach(() => {
  __resetChromeStorage();
  jest.clearAllMocks();
  chrome.alarms.clear = jest.fn();
  maintenant = 1_000_000;
  fetchMc = jest.fn();
  jetons = jest.fn(async () => 'jeton-valide');
  __seedChromeStorage({ dmConfigRaw: { config: { mycollectionsApiBase: BASE + '/' } } });
  Sites.configurer({
    fetch: fetchMc,
    obtenirJeton: (forcer) => jetons(forcer),
    maintenant: () => maintenant,
    hasard: () => 0.5,          // gigue nulle
    surChangement: jest.fn()
  });
});

const entetesDe = (i) => fetchMc.mock.calls[i][1].headers;

describe('lecture connectée', () => {
  test('200 : état connecte, liste nettoyée, relecture planifiée à ttl_s', async () => {
    fetchMc.mockResolvedValueOnce(reponse(200, LISTE));
    const e = await Sites.lire();
    expect(fetchMc.mock.calls[0][0]).toBe(BASE + '/api/v1/sites');
    expect(entetesDe(0).Authorization).toBe('Bearer jeton-valide');
    expect(fetchMc.mock.calls[0][1].credentials).toBe('omit');
    expect(e.etat).toBe('connecte');
    expect(e.sites).toHaveLength(1);
    expect(chrome.alarms.create).toHaveBeenCalledWith(Sites.ALARME, { when: maintenant + 1800 * 1000 });
  });

  test('aucune adresse visitée n\'est envoyée : seule la route /sites est appelée', async () => {
    fetchMc.mockResolvedValueOnce(reponse(200, LISTE));
    await Sites.lire();
    const { cibles } = await Sites.ciblesPour('https://www.legifrance.gouv.fr/codes/secret?q=perso');
    expect(cibles.map((c) => c.id)).toEqual(['a1', 'c1']);
    expect(fetchMc).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetchMc.mock.calls)).not.toContain('secret');
  });

  test('motifs invalides et cibles mal formées écartés', async () => {
    fetchMc.mockResolvedValueOnce(reponse(200, {
      ttl_s: 3600,
      sites: [
        { motif: 'https://*/*', cibles: [{ type: 'collection', id: 'x', titre: 'X' }] },
        { motif: 'https://ok.fake-domain.name/*', cibles: [{ type: 'inconnu', id: 'y', titre: 'Y' }, { type: 'collection', id: '', titre: 'Z' }, { type: 'collection', id: 'z', titre: 'Z' }] }
      ]
    }));
    const e = await Sites.lire();
    expect(e.sites).toEqual([{ motif: 'https://ok.fake-domain.name/*', cibles: [{ type: 'collection', id: 'z', titre: 'Z' }] }]);
  });
});

describe('inerte si Mes collections ne répond pas', () => {
  test('erreur réseau : injoignable, aucune cible, retry dans 1 min', async () => {
    fetchMc.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const e = await Sites.lire();
    expect(e.etat).toBe('injoignable');
    expect(e.echecs).toBe(1);
    expect(chrome.alarms.create).toHaveBeenLastCalledWith(Sites.ALARME, { when: maintenant + 60000 });
    expect((await Sites.ciblesPour('https://www.legifrance.gouv.fr/codes/1')).cibles).toEqual([]);
  });

  test('une liste valide disparaît dès que le service tombe', async () => {
    fetchMc.mockResolvedValueOnce(reponse(200, LISTE)).mockResolvedValueOnce(reponse(503, {}));
    await Sites.lire();
    expect((await Sites.ciblesPour('https://www.legifrance.gouv.fr/codes/1')).cibles).toHaveLength(2);
    await Sites.lire();
    expect((await Sites.ciblesPour('https://www.legifrance.gouv.fr/codes/1')).cibles).toEqual([]);
  });

  test('recul exponentiel plafonné à 60 min', async () => {
    fetchMc.mockRejectedValue(new TypeError('Failed to fetch'));
    const delais = [];
    for (let i = 0; i < 9; i++) {
      await Sites.lire();
      delais.push((chrome.alarms.create.mock.calls.at(-1)[1].when - maintenant) / 60000);
    }
    expect(delais).toEqual([1, 2, 4, 8, 16, 32, 60, 60, 60]);
  });

  test('gigue de ±20 %', () => {
    Sites.configurer({ hasard: () => 0 });
    expect(Sites.recul(3)).toBe(4 * 60000 * 0.8);
    Sites.configurer({ hasard: () => 1 });
    expect(Sites.recul(3)).toBe(4 * 60000 * 1.2);
  });

  test('429 : Retry-After respecté s\'il est plus long', async () => {
    fetchMc.mockResolvedValueOnce(reponse(429, {}, { 'retry-after': '300' }));
    const e = await Sites.lire();
    expect(e.etat).toBe('injoignable');
    expect(chrome.alarms.create).toHaveBeenLastCalledWith(Sites.ALARME, { when: maintenant + 300000 });
  });

  test('délai dépassé : la requête est annulée au bout de 5 s', async () => {
    jest.useFakeTimers();
    fetchMc.mockImplementationOnce((url, init) => new Promise((_, rejeter) => {
      init.signal.addEventListener('abort', () => rejeter(new Error('aborted')));
    }));
    const p = Sites.lire();
    await jest.advanceTimersByTimeAsync(5000);
    const e = await p;
    jest.useRealTimers();
    expect(e.etat).toBe('injoignable');
  });

  test('réponse illisible : injoignable', async () => {
    fetchMc.mockResolvedValueOnce(reponse(200, { autre: true }));
    expect((await Sites.lire()).etat).toBe('injoignable');
  });

  test('retour du service : connecte, compteur remis à zéro', async () => {
    fetchMc.mockRejectedValueOnce(new TypeError('x')).mockResolvedValueOnce(reponse(200, LISTE));
    await Sites.lire();
    const e = await Sites.lire();
    expect(e.etat).toBe('connecte');
    expect(e.echecs).toBe(0);
  });

  test('liste périmée (2 × ttl sans relecture) : plus de cibles, relecture lancée', async () => {
    fetchMc.mockResolvedValue(reponse(200, LISTE));
    await Sites.lire();
    maintenant += 2 * 1800 * 1000 + 1;
    expect((await Sites.ciblesPour('https://www.legifrance.gouv.fr/codes/1')).cibles).toEqual([]);
    await Sites.lire();   // rejoint la relecture lancée par ciblesPour
    expect(fetchMc).toHaveBeenCalledTimes(2);
  });
});

describe('mode anonyme', () => {
  test('pas de jeton : appel sans Authorization ; 200 ⇒ anonyme, sans assistant', async () => {
    jetons = jest.fn(async () => null);
    fetchMc.mockResolvedValueOnce(reponse(200, { ttl_s: 3600, anonyme: true, sites: LISTE.sites }));
    const e = await Sites.lire();
    expect(entetesDe(0).Authorization).toBeUndefined();
    expect(e.etat).toBe('anonyme');
    expect(e.sites[0].cibles).toEqual([{ type: 'collection', id: 'c1', titre: 'C1' }]);
  });

  test('pas de jeton et anonyme fermé (401) : inactif, aucune relecture planifiée', async () => {
    jetons = jest.fn(async () => null);
    fetchMc.mockResolvedValueOnce(reponse(401, {}));
    const e = await Sites.lire();
    expect(e.etat).toBe('inactif');
    expect(chrome.alarms.create).not.toHaveBeenCalled();
    expect(chrome.alarms.clear).toHaveBeenCalledWith(Sites.ALARME);
  });

  test('401 avec jeton : rafraîchissement forcé puis nouvelle tentative', async () => {
    jetons = jest.fn(async (forcer) => (forcer ? 'jeton-neuf' : 'jeton-perime'));
    fetchMc.mockResolvedValueOnce(reponse(401, {})).mockResolvedValueOnce(reponse(200, LISTE));
    const e = await Sites.lire();
    expect(jetons).toHaveBeenCalledWith(true);
    expect(entetesDe(1).Authorization).toBe('Bearer jeton-neuf');
    expect(e.etat).toBe('connecte');
  });

  test('401 persistant après rafraîchissement : bascule sans jeton', async () => {
    fetchMc.mockResolvedValueOnce(reponse(401, {})).mockResolvedValueOnce(reponse(401, {}))
      .mockResolvedValueOnce(reponse(200, { ttl_s: 3600, anonyme: true, sites: LISTE.sites }));
    const e = await Sites.lire();
    expect(fetchMc).toHaveBeenCalledTimes(3);
    expect(entetesDe(2).Authorization).toBeUndefined();
    expect(e.etat).toBe('anonyme');
  });

  test('rafraîchissement impossible : bascule sans jeton', async () => {
    jetons = jest.fn(async (forcer) => (forcer ? null : 'jeton-perime'));
    fetchMc.mockResolvedValueOnce(reponse(401, {})).mockResolvedValueOnce(reponse(401, {}));
    const e = await Sites.lire();
    expect(entetesDe(1).Authorization).toBeUndefined();
    expect(e.etat).toBe('inactif');
  });
});

describe('403 audience_mismatch', () => {
  test('état refuse avec diagnostic, sans bascule anonyme', async () => {
    fetchMc.mockResolvedValueOnce(reponse(403, { detail: { code: 'audience_mismatch', message: '…' } }));
    const e = await Sites.lire();
    expect(fetchMc).toHaveBeenCalledTimes(1);
    expect(e.etat).toBe('refuse');
    expect(e.raison).toContain('audience_mismatch');
    expect((await Sites.ciblesPour('https://www.legifrance.gouv.fr/codes/1')).cibles).toEqual([]);
  });
});

describe('configuration', () => {
  test('adresse vide : inactif, aucun appel', async () => {
    __seedChromeStorage({ dmConfigRaw: { config: { mycollectionsApiBase: '' } } });
    const e = await Sites.lire();
    expect(e.etat).toBe('inactif');
    expect(fetchMc).not.toHaveBeenCalled();
  });

  test('clé servie par le DM prioritaire, barre finale retirée', async () => {
    expect((await Sites.configuration()).base).toBe(BASE);
  });

  test('lectures concurrentes : un seul appel', async () => {
    fetchMc.mockResolvedValue(reponse(200, LISTE));
    await Promise.all([Sites.lire(), Sites.lire(), Sites.lire()]);
    expect(fetchMc).toHaveBeenCalledTimes(1);
  });

  test('réinitialiser remet le compteur d\'échecs à zéro', async () => {
    fetchMc.mockRejectedValue(new TypeError('x'));
    await Sites.lire();
    await Sites.lire();
    const e = await Sites.reinitialiser();
    expect(e.echecs).toBe(1);
  });
});

describe('doublure', () => {
  beforeEach(() => {
    const vraie = require('../src/mescollections/doublure.json');
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => vraie }));
  });

  test.each([
    ['normal', 'jeton', 'connecte'],
    ['normal', null, 'inactif'],
    ['anonyme', null, 'anonyme'],
    ['refuse', 'jeton', 'refuse'],
    ['limite', 'jeton', 'injoignable'],
    ['panne', 'jeton', 'injoignable']
  ])('mode %s, jeton %s ⇒ %s', async (mode, jeton, attendu) => {
    __seedChromeStorage({ mescollectionsDoublure: mode });
    jetons = jest.fn(async () => jeton);
    const e = await Sites.lire();
    expect(e.etat).toBe(attendu);
    expect(fetchMc).not.toHaveBeenCalled();
  });

  test('anonyme : seules les collections publiques, aucun assistant', async () => {
    __seedChromeStorage({ mescollectionsDoublure: 'anonyme' });
    jetons = jest.fn(async () => null);
    const e = await Sites.lire();
    const cibles = e.sites.flatMap((s) => s.cibles);
    expect(cibles.length).toBeGreaterThan(0);
    expect(cibles.every((c) => c.type === 'collection')).toBe(true);
  });
});

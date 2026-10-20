// tests/mescollections-api.test.js — questions : assistants, collections, règles de retry

require('../src/mescollections/doublure.js');
const Api = require('../src/mescollections/api.js');

const CFG = { base: 'https://mescollections.fake-domain.name', doublure: '' };
const ASSISTANT = { type: 'assistant', id: 'sejour', titre: 'Séjour' };
const C1 = { type: 'collection', id: 'ceseda', titre: 'CESEDA' };
const C2 = { type: 'collection', id: 'crpa', titre: 'CRPA' };

function reponse(status, corps, entetes = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (n) => entetes[n.toLowerCase()] ?? null }, json: async () => corps };
}

let fetchMc, jetons, attendre;
beforeEach(() => {
  fetchMc = jest.fn();
  jetons = jest.fn(async () => 'jeton');
  attendre = jest.fn(async () => {});
  Api.configurer({ fetch: fetchMc, obtenirJeton: (f) => jetons(f), attendre });
});

describe('appels', () => {
  test('assistant : POST executer {question, canal: api}, réponse normalisée', async () => {
    fetchMc.mockResolvedValueOnce(reponse(200, {
      reponse: 'Voir [1].',
      plan: ['étape'],
      passages: [{ titre: 'Art. 1', texte: 'Texte', url: 'https://mescollections.fake-domain.name/e/1?sig=x', source: 'ceseda' },
        { titre: 'Art. 2', texte: 'Texte', url: null, source: 'ceseda', etape: 2 },
        { titre: 'Piège', texte: 'x', url: 'javascript:alert(1)' }]
    }));
    const { blocs } = await Api.demander(CFG, [ASSISTANT], '  Quelle durée ?  ');
    const [url, init] = fetchMc.mock.calls[0];
    expect(url).toBe(CFG.base + '/api/v1/assistants/sejour/executer');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ question: 'Quelle durée ?', canal: 'api' });
    expect(init.headers.Authorization).toBe('Bearer jeton');
    expect(init.credentials).toBe('omit');
    expect(blocs[0].reponse).toBe('Voir [1].');
    expect(blocs[0].plan).toEqual(['étape']);
    expect(blocs[0].passages[2].url).toBeNull();   // seuls les liens https sont gardés
    expect(blocs[0].passages[0].etape).toBeUndefined();
    expect(blocs[0].passages[1].etape).toBe(2);         // étape du plan conservée
  });

  test('collections : une seule recherche, scope = toutes les collections cochées', async () => {
    fetchMc.mockResolvedValueOnce(reponse(200, { source: 'mycollections', total: 1, results: [{
      id: 'ceseda:1', title: 'T', date: null, url: 'https://x.fake-domain.name/1', score: 0.8,
      hits: [{ snippet: 'E', highlights: [], field: 'content', url: 'https://x.fake-domain.name/1' }, { snippet: 'F' }],
      context: { collection: { id: 'ceseda', title: 'CESEDA' }, right: 'lecture' }
    }] }));
    const { blocs } = await Api.demander(CFG, [C1, C2], 'titre de séjour');
    expect(fetchMc).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMc.mock.calls[0][0]);
    expect(url.pathname).toBe('/api/v1/search');
    expect(url.searchParams.get('q')).toBe('titre de séjour');
    expect(url.searchParams.get('scope')).toBe('ceseda,crpa');
    expect(url.searchParams.get('limit')).toBe('8');
    expect(blocs[0]).toMatchObject({ type: 'collections', passages: [{ titre: 'T', texte: 'E … F', url: 'https://x.fake-domain.name/1', source: 'CESEDA' }] });
  });

  test('assistant + collections : un bloc par appel', async () => {
    fetchMc.mockResolvedValue(reponse(200, { results: [], passages: [] }));
    const { blocs } = await Api.demander(CFG, [ASSISTANT, C1], 'q');
    expect(blocs.map((b) => b.type)).toEqual(['assistant', 'collections']);
  });

  test('question vide : aucun appel', async () => {
    expect((await Api.demander(CFG, [C1], '   ')).blocs).toEqual([]);
    expect(fetchMc).not.toHaveBeenCalled();
  });
});

describe('erreurs et retry', () => {
  test('jamais anonyme : sans jeton, aucun appel', async () => {
    jetons = jest.fn(async () => null);
    const { blocs } = await Api.demander(CFG, [C1], 'q');
    expect(fetchMc).not.toHaveBeenCalled();
    expect(blocs[0].erreur.code).toBe('connexion');
  });

  test('401 : rafraîchissement forcé et une nouvelle tentative', async () => {
    jetons = jest.fn(async (f) => (f ? 'neuf' : 'vieux'));
    fetchMc.mockResolvedValueOnce(reponse(401, {})).mockResolvedValueOnce(reponse(200, { results: [] }));
    const { blocs } = await Api.demander(CFG, [C1], 'q');
    expect(fetchMc.mock.calls[1][1].headers.Authorization).toBe('Bearer neuf');
    expect(blocs[0].erreur).toBeUndefined();
  });

  test('401 persistant : reconnexion demandée', async () => {
    fetchMc.mockResolvedValue(reponse(401, {}));
    const { blocs } = await Api.demander(CFG, [C1], 'q');
    expect(fetchMc).toHaveBeenCalledTimes(2);
    expect(blocs[0].erreur.code).toBe('connexion');
  });

  test('503 : une nouvelle tentative après 2 s, puis panne signalée', async () => {
    fetchMc.mockResolvedValue(reponse(503, {}));
    const { blocs } = await Api.demander(CFG, [C1], 'q');
    expect(fetchMc).toHaveBeenCalledTimes(2);
    expect(attendre).toHaveBeenCalledWith(2000);
    expect(blocs[0].erreur).toMatchObject({ code: 'indisponible', panne: true });
  });

  test('503 avec Retry-After: 10 (moteur en panne) : attente respectée', async () => {
    fetchMc.mockResolvedValueOnce(reponse(503, { detail: 'moteur en panne' }, { 'retry-after': '10' })).mockResolvedValueOnce(reponse(200, { passages: [] }));
    const { blocs } = await Api.demander(CFG, [ASSISTANT], 'q');
    expect(attendre).toHaveBeenCalledWith(10000);
    expect(blocs[0].erreur).toBeUndefined();
  });

  test('403 au format FastAPI {detail: chaîne} : accès refusé générique', async () => {
    fetchMc.mockResolvedValueOnce(reponse(403, { detail: 'Interdit' }));
    const { blocs } = await Api.demander(CFG, [ASSISTANT], 'q');
    expect(blocs[0].erreur.code).toBe('forbidden');
  });

  test('erreur réseau puis succès', async () => {
    fetchMc.mockRejectedValueOnce(new TypeError('x')).mockResolvedValueOnce(reponse(200, { results: [] }));
    const { blocs } = await Api.demander(CFG, [C1], 'q');
    expect(blocs[0].erreur).toBeUndefined();
  });

  test('429 avec Retry-After ≤ 30 s : attente respectée, une tentative', async () => {
    fetchMc.mockResolvedValueOnce(reponse(429, {}, { 'retry-after': '12' })).mockResolvedValueOnce(reponse(200, { results: [] }));
    await Api.demander(CFG, [C1], 'q');
    expect(attendre).toHaveBeenCalledWith(12000);
    expect(fetchMc).toHaveBeenCalledTimes(2);
  });

  test('429 avec Retry-After > 30 s : message immédiat', async () => {
    fetchMc.mockResolvedValueOnce(reponse(429, {}, { 'retry-after': '120' }));
    const { blocs } = await Api.demander(CFG, [C1], 'q');
    expect(fetchMc).toHaveBeenCalledTimes(1);
    expect(blocs[0].erreur.code).toBe('limite');
  });

  test('404 : cible à retirer', async () => {
    fetchMc.mockResolvedValueOnce(reponse(404, {}));
    const { blocs } = await Api.demander(CFG, [ASSISTANT], 'q');
    expect(blocs[0].erreur).toMatchObject({ code: 'introuvable', retirer: true });
  });

  test('403 audience_mismatch (format {error}) : message de configuration', async () => {
    fetchMc.mockResolvedValueOnce(reponse(403, { error: { code: 'audience_mismatch', message: '…' } }));
    const { blocs } = await Api.demander(CFG, [C1], 'q');
    expect(blocs[0].erreur.code).toBe('audience_mismatch');
    expect(blocs[0].erreur.message).toMatch(/configuration/);
  });

  test('délai de 30 s dépassé : requête annulée', async () => {
    jest.useFakeTimers();
    Api.configurer({ attendre: async () => {} });
    fetchMc.mockImplementation((u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))));
    const p = Api.demander(CFG, [C1], 'q');
    await jest.advanceTimersByTimeAsync(30000);
    await jest.advanceTimersByTimeAsync(30000);
    const { blocs } = await p;
    jest.useRealTimers();
    expect(blocs[0].erreur.code).toBe('indisponible');
  });
});

describe('doublure', () => {
  beforeEach(() => {
    const vraie = require('../src/mescollections/doublure.json');
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => vraie }));
  });

  test('assistant et collections répondent depuis la doublure, sans réseau', async () => {
    const { blocs } = await Api.demander({ base: '', doublure: 'normal' }, [ASSISTANT, C1], 'q');
    expect(fetchMc).not.toHaveBeenCalled();
    expect(blocs[0].passages.length).toBeGreaterThan(0);
    expect(blocs[0].plan).toBeTruthy();
    expect(blocs[1].passages.length).toBeGreaterThan(0);
  });

  test('refuse : 403 audience_mismatch sur les questions', async () => {
    const { blocs } = await Api.demander({ base: '', doublure: 'refuse' }, [C1], 'q');
    expect(blocs[0].erreur.code).toBe('audience_mismatch');
  });
});

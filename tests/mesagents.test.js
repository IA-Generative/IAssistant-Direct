// tests/mesagents.test.js — Consommation du contrat d'agents MirAI (src/mesagents.js)

const fs = require('fs');
const path = require('path');

const CFG_ACTIF = { mesagentsBaseUrl: 'https://mesagents.test/', features: { agents: true } };

function reponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k] || null },
    json: () => (body === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(body))
  };
}

function fiche(id, extra = {}) {
  return Object.assign({
    id, name: `Agent ${id}`, description: 'desc', origin: 'shared', inputs: ['text'],
    outputs: ['text'], model: id, status: 'published', url: `https://mesagents.test/catalog/${id}`
  }, extra);
}

let jetons;

beforeEach(() => {
  __resetChromeStorage();
  jest.clearAllMocks();
  delete globalThis.MesAgents;
  delete window.MiraiAuth;

  // DMBootstrap minimal : config active par defaut
  window.DMBootstrap = {
    _cfg: { ...CFG_ACTIF },
    getConfig() { return this._cfg; },
    async getConfigAsync() { return this._cfg; },
    getFeatures() { return this._cfg.features || {}; }
  };

  eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'mesagents.js'), 'utf8'));

  // Adaptateur de jeton injecte : 'j1' puis, si rafraichi, 'j2'
  jetons = { courant: 'j1', rafraichi: 0 };
  globalThis.MesAgents.setAuth({
    obtenirJeton: jest.fn(async (forcer) => {
      if (forcer) { jetons.rafraichi++; jetons.courant = 'j2'; }
      return jetons.courant;
    })
  });
});

describe('MesAgents — configuration', () => {
  test('baseUrl normalise et rejette vide / placeholder non resolu / non http', () => {
    const MA = globalThis.MesAgents;
    expect(MA.baseUrl({ mesagentsBaseUrl: 'https://mesagents.test/' })).toBe('https://mesagents.test');
    expect(MA.baseUrl({ mesagentsBaseUrl: '' })).toBe('');
    expect(MA.baseUrl({})).toBe('');
    expect(MA.baseUrl({ mesagentsBaseUrl: '${{MESAGENTS_BASE_URL}}' })).toBe('');
    expect(MA.baseUrl({ mesagentsBaseUrl: 'mesagents.test' })).toBe('');
  });

  test('estActif exige la cle DM ; features.agents absent = actif, faux (bool ou texte) = inactif', () => {
    const MA = globalThis.MesAgents;
    expect(MA.estActif({ mesagentsBaseUrl: 'https://m.test' })).toBe(true);
    expect(MA.estActif({ mesagentsBaseUrl: 'https://m.test', features: { agents: true } })).toBe(true);
    expect(MA.estActif({ mesagentsBaseUrl: 'https://m.test', features: { agents: false } })).toBe(false);
    expect(MA.estActif({ mesagentsBaseUrl: 'https://m.test', features: { agents: 'false' } })).toBe(false);
    expect(MA.estActif({ mesagentsBaseUrl: 'https://m.test', features: { agents: '0' } })).toBe(false);
    expect(MA.estActif({ mesagentsBaseUrl: '', features: { agents: true } })).toBe(false);
  });

  test('buildScope ajoute mesagents-agents seulement si la fonction est active', () => {
    const MA = globalThis.MesAgents;
    const base = 'openid profile email offline_access';
    expect(MA.buildScope(base, CFG_ACTIF)).toBe('openid profile email offline_access mesagents-agents');
    expect(MA.buildScope(base, { mesagentsBaseUrl: '' })).toBe(base);
    expect(MA.buildScope(base, { mesagentsBaseUrl: 'https://m.test', features: { agents: false } })).toBe(base);
    // idempotent
    expect(MA.buildScope(base + ' mesagents-agents', CFG_ACTIF)).toBe('openid profile email offline_access mesagents-agents');
  });

  test('_lireConfig passe par DMBootstrap.getFeatures()', async () => {
    const spy = jest.spyOn(window.DMBootstrap, 'getFeatures');
    const cfg = await globalThis.MesAgents._lireConfig();
    expect(spy).toHaveBeenCalled();
    expect(cfg.features).toEqual({ agents: true });
    expect(cfg.mesagentsBaseUrl).toBe('https://mesagents.test/');
  });
});

describe('MesAgents — construction du message', () => {
  test('consigne + contenu delimite par <<< et >>>', () => {
    const m = globalThis.MesAgents.construireMessage('Reformule le passage suivant.', 'Bonjour le monde');
    expect(m).toBe('Reformule le passage suivant.\n\n<<<\nBonjour le monde\n>>>');
  });

  test('neutralise les delimiteurs presents dans le contenu', () => {
    const MA = globalThis.MesAgents;
    const contenu = 'a <<< b >>> c <<<<< d >>>>';
    const n = MA.neutraliser(contenu);
    expect(n).not.toContain('<<<');
    expect(n).not.toContain('>>>');
    expect(n).toContain('‹‹‹');
    expect(n).toContain('›››');
    const m = MA.construireMessage('C.', contenu);
    // Un seul ouvrant et un seul fermant : ceux du consommateur
    expect(m.split('<<<').length).toBe(2);
    expect(m.split('>>>').length).toBe(2);
  });

  test('borne le message a 100 000 caracteres (contrat) avec une marque de troncature et le dit', () => {
    const MA = globalThis.MesAgents;
    expect(MA.MAX_MESSAGE_CHARS).toBe(100000);
    const { message, tronque } = MA.composerMessage('Consigne.', 'x'.repeat(150000));
    expect(tronque).toBe(true);
    expect(message.length).toBeLessThanOrEqual(MA.MAX_MESSAGE_CHARS);
    expect(message).toContain('[… contenu tronqué]');
    expect(message.endsWith('\n>>>')).toBe(true);
    expect(MA.composerMessage('C.', 'court').tronque).toBe(false);
  });

  test('accepte un contenu vide ou non textuel sans planter', () => {
    const MA = globalThis.MesAgents;
    expect(MA.construireMessage('C.', null)).toBe('C.\n\n<<<\n\n>>>');
    expect(MA.construireMessage('C.', 42)).toBe('C.\n\n<<<\n42\n>>>');
  });
});

describe('MesAgents — fiches et filtrage', () => {
  test('normaliserListe ignore les fiches sans id/nom et les valeurs inconnues de inputs/outputs', () => {
    const MA = globalThis.MesAgents;
    const liste = MA.normaliserListe({ agents: [
      fiche('a', { inputs: ['text', 'inconnu', 'selection'], outputs: ['text', 'magie'], origin: 'bizarre', url: 'http://pas-https' }),
      { id: 'sans-nom' },
      { name: 'sans-id' },
      'pas-un-objet'
    ] });
    expect(liste).toHaveLength(1);
    expect(liste[0].inputs).toEqual(['text', 'selection']);
    expect(liste[0].outputs).toEqual(['text']);
    expect(liste[0].origin).toBe('shared');
    expect(liste[0].url).toBe('');
  });

  test('normaliserAgent borne les tailles et prend id comme model par defaut', () => {
    const MA = globalThis.MesAgents;
    const a = MA.normaliserAgent({ id: 'z', name: 'n'.repeat(500), description: 'd'.repeat(5000), model: '' });
    expect(a.name).toHaveLength(200);
    expect(a.description).toHaveLength(2000);
    expect(a.model).toBe('z');
  });

  test('filtrerAgents filtre sur inputs cote client ; valeur inconnue → vide ; sans input → tout', () => {
    const MA = globalThis.MesAgents;
    const liste = [fiche('a', { inputs: ['text'] }), fiche('b', { inputs: ['selection', 'page'] }), fiche('c', { inputs: ['page'] })];
    expect(MA.filtrerAgents(liste, 'selection').map(a => a.id)).toEqual(['b']);
    expect(MA.filtrerAgents(liste, 'page').map(a => a.id)).toEqual(['b', 'c']);
    expect(MA.filtrerAgents(liste, 'text').map(a => a.id)).toEqual(['a']);
    expect(MA.filtrerAgents(liste, 'inconnu')).toEqual([]);
    expect(MA.filtrerAgents(liste)).toHaveLength(3);
  });
});

describe('MesAgents — normalisation des erreurs', () => {
  const cas = [
    [401, { error: { code: 'invalid_token', message: 'x' } }, 'invalid_token', true],
    [403, { error: { code: 'audience_mismatch', message: 'x' } }, 'audience_mismatch', true],
    [403, { error: { code: 'forbidden', message: 'x' } }, 'forbidden', true],
    [404, { error: { code: 'model_not_found', message: 'x' } }, 'model_not_found', false],
    [429, { error: { code: 'rate_limited', message: 'x' } }, 'rate_limited', false],
    [502, { error: { code: 'llm_unavailable', message: 'x' } }, 'llm_unavailable', false],
    [400, { error: { code: 'invalid_query', message: 'x' } }, 'invalid_query', false],
    [503, undefined, 'indisponible', false]
  ];

  test.each(cas)('statut %i → code %s (masquer=%s)', async (status, body, code, masquer) => {
    const err = await globalThis.MesAgents.normaliserErreur(reponse(status, body));
    expect(err).toBeInstanceOf(globalThis.MesAgents.MesAgentsError);
    expect(err.code).toBe(code);
    expect(err.masquer).toBe(masquer);
    expect(err.status).toBe(status);
  });

  test('404 → « Cet agent n\'est plus accessible » ; 429 → « Réessayez dans un moment »', async () => {
    const MA = globalThis.MesAgents;
    expect((await MA.normaliserErreur(reponse(404, {}))).message).toBe("Cet agent n'est plus accessible.");
    const e429 = await MA.normaliserErreur(reponse(429, {}, { 'Retry-After': '7' }));
    expect(e429.message).toBe('Réessayez dans un moment.');
    expect(e429.retryAfter).toBe('7');
  });

  test('422 blocked_input / blocked_output : error.message affiche tel quel', async () => {
    const MA = globalThis.MesAgents;
    const e1 = await MA.normaliserErreur(reponse(422, { error: { code: 'blocked_input', message: 'Votre texte contient une consigne cachée.', type: 'invalid_request_error' } }));
    expect(e1.code).toBe('blocked_input');
    expect(e1.message).toBe('Votre texte contient une consigne cachée.');
    const e2 = await MA.normaliserErreur(reponse(422, { error: { code: 'blocked_output', message: 'Réponse retenue.' } }));
    expect(e2.code).toBe('blocked_output');
    expect(e2.message).toBe('Réponse retenue.');
  });

  test('messageErreur rend le message normalise, jamais un corps brut', () => {
    const MA = globalThis.MesAgents;
    expect(MA.messageErreur(new MA.MesAgentsError('x', 'Lisible.'))).toBe('Lisible.');
    expect(MA.messageErreur(new TypeError('Failed to fetch'))).toBe('Erreur inattendue en contactant Mes agents.');
  });
});

describe('MesAgents.listerAgents()', () => {
  test('appelle GET /api/v1/agents avec le jeton, normalise, filtre et met en cache (storage.session)', async () => {
    const MA = globalThis.MesAgents;
    global.fetch.mockResolvedValueOnce(reponse(200, { source: 'mesagents', total: 2, agents: [
      fiche('a', { inputs: ['text', 'selection'] }), fiche('b', { inputs: ['page'] })
    ] }));

    const liste = await MA.listerAgents({ input: 'text' });
    expect(liste.map(a => a.id)).toEqual(['a']);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://mesagents.test/api/v1/agents?limit=200');
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer j1');

    // Cache partage via storage.session
    const session = __getSessionStorage();
    expect(session.mesagentsCache.agents).toHaveLength(2);

    // Deuxieme appel (autre filtre) : pas de nouveau fetch
    const pages = await MA.listerAgents({ input: 'page' });
    expect(pages.map(a => a.id)).toEqual(['b']);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // force → nouveau fetch
    global.fetch.mockResolvedValueOnce(reponse(200, { agents: [fiche('c')] }));
    const forcee = await MA.listerAgents({ force: true });
    expect(forcee.map(a => a.id)).toEqual(['c']);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('cache expire apres 3 minutes', async () => {
    const MA = globalThis.MesAgents;
    const t0 = Date.now();
    const spyNow = jest.spyOn(Date, 'now').mockReturnValue(t0);
    global.fetch.mockResolvedValueOnce(reponse(200, { agents: [fiche('a')] }));
    await MA.listerAgents();
    spyNow.mockReturnValue(t0 + MA.CACHE_TTL_MS + 1);
    global.fetch.mockResolvedValueOnce(reponse(200, { agents: [fiche('b')] }));
    const liste = await MA.listerAgents();
    expect(liste.map(a => a.id)).toEqual(['b']);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    spyNow.mockRestore();
  });

  test('fonction desactivee (cle DM vide) → erreur desactive, masquer, aucun appel reseau', async () => {
    window.DMBootstrap._cfg = { mesagentsBaseUrl: '' };
    await expect(globalThis.MesAgents.listerAgents()).rejects.toMatchObject({ code: 'desactive', masquer: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sans jeton → invalid_token masque, aucun appel reseau', async () => {
    globalThis.MesAgents.setAuth({ obtenirJeton: async () => null });
    await expect(globalThis.MesAgents.listerAgents()).rejects.toMatchObject({ code: 'invalid_token', masquer: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('service injoignable → erreur injoignable masquee', async () => {
    global.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(globalThis.MesAgents.listerAgents()).rejects.toMatchObject({ code: 'injoignable', masquer: true });
  });

  test('403 audience_mismatch → erreur masquee', async () => {
    global.fetch.mockResolvedValueOnce(reponse(403, { error: { code: 'audience_mismatch', message: 'aud' } }));
    await expect(globalThis.MesAgents.listerAgents()).rejects.toMatchObject({ code: 'audience_mismatch', masquer: true });
  });

  test('sur 401, rafraichit le jeton une fois et reessaie une fois', async () => {
    const MA = globalThis.MesAgents;
    global.fetch
      .mockResolvedValueOnce(reponse(401, { error: { code: 'invalid_token', message: 'expired' } }))
      .mockResolvedValueOnce(reponse(200, { agents: [fiche('a')] }));

    const liste = await MA.listerAgents();
    expect(liste.map(a => a.id)).toEqual(['a']);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer j1');
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer j2');
    expect(jetons.rafraichi).toBe(1);
  });

  test('401 persistant apres rafraichissement → invalid_token masque, pas de troisieme essai', async () => {
    global.fetch
      .mockResolvedValueOnce(reponse(401, { error: { code: 'invalid_token' } }))
      .mockResolvedValueOnce(reponse(401, { error: { code: 'invalid_token' } }));
    await expect(globalThis.MesAgents.listerAgents()).rejects.toMatchObject({ code: 'invalid_token', masquer: true });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(jetons.rafraichi).toBe(1);
  });

  test('ne journalise jamais le jeton', async () => {
    const logs = [];
    const spies = ['log', 'info', 'warn', 'error'].map(m => jest.spyOn(console, m).mockImplementation((...a) => logs.push(a.join(' '))));
    global.fetch
      .mockResolvedValueOnce(reponse(401, {}))
      .mockResolvedValueOnce(reponse(500, {}));
    await globalThis.MesAgents.listerAgents().catch(() => {});
    expect(logs.join('\n')).not.toMatch(/j1|j2|Bearer/);
    spies.forEach(s => s.mockRestore());
  });
});

describe('MesAgents.lancerAgent()', () => {
  test('POST /v1/chat/completions avec model, message user construit et stream:false', async () => {
    const MA = globalThis.MesAgents;
    global.fetch.mockResolvedValueOnce(reponse(200, {
      id: 'chatcmpl-1', choices: [{ message: { role: 'assistant', content: 'Voici la reformulation.' } }]
    }));

    const r = await MA.lancerAgent({ model: '7f3c', consigne: 'Reformule le passage suivant.', contenu: 'Texte <<< piege >>>' });
    expect(r.texte).toBe('Voici la reformulation.');
    expect(r.model).toBe('7f3c');
    expect(r.id).toBe('chatcmpl-1');
    expect(r.tronque).toBe(false);

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://mesagents.test/v1/chat/completions');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(opts.headers.Authorization).toBe('Bearer j1');
    expect(opts.signal).toBeDefined();
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('7f3c');
    expect(body.stream).toBe(false);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toBe('Reformule le passage suivant.\n\n<<<\nTexte ‹‹‹ piege ›››\n>>>');
    // Pas de message system : le prompt systeme de l'agent fait foi.
    expect(body.messages.some(m => m.role === 'system')).toBe(false);
  });

  test('422 blocked_input → message de la garde tel quel', async () => {
    global.fetch.mockResolvedValueOnce(reponse(422, { error: { code: 'blocked_input', message: 'Consigne cachée détectée.', type: 'invalid_request_error' } }));
    await expect(globalThis.MesAgents.lancerAgent({ model: 'a', consigne: 'c', contenu: 'x' }))
      .rejects.toMatchObject({ code: 'blocked_input', message: 'Consigne cachée détectée.', masquer: false });
  });

  test('404 model_not_found → « Cet agent n\'est plus accessible »', async () => {
    global.fetch.mockResolvedValueOnce(reponse(404, { error: { code: 'model_not_found', message: 'nope' } }));
    await expect(globalThis.MesAgents.lancerAgent({ model: 'a', consigne: 'c', contenu: 'x' }))
      .rejects.toMatchObject({ code: 'model_not_found', message: "Cet agent n'est plus accessible." });
  });

  test('429 → « Réessayez dans un moment »', async () => {
    global.fetch.mockResolvedValueOnce(reponse(429, { error: { code: 'rate_limited' } }, { 'Retry-After': '30' }));
    await expect(globalThis.MesAgents.lancerAgent({ model: 'a', consigne: 'c', contenu: 'x' }))
      .rejects.toMatchObject({ code: 'rate_limited', message: 'Réessayez dans un moment.' });
  });

  test('502 llm_unavailable → « L\'agent ne répond pas »', async () => {
    global.fetch.mockResolvedValueOnce(reponse(502, { error: { code: 'llm_unavailable' } }));
    await expect(globalThis.MesAgents.lancerAgent({ model: 'a', consigne: 'c', contenu: 'x' }))
      .rejects.toMatchObject({ code: 'llm_unavailable', message: "L'agent ne répond pas." });
  });

  test('sur 401, rafraichit et renvoie la meme requete une fois', async () => {
    global.fetch
      .mockResolvedValueOnce(reponse(401, { error: { code: 'invalid_token' } }))
      .mockResolvedValueOnce(reponse(200, { choices: [{ message: { content: 'ok' } }] }));
    const r = await globalThis.MesAgents.lancerAgent({ model: 'a', consigne: 'c', contenu: 'x' });
    expect(r.texte).toBe('ok');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual(JSON.parse(global.fetch.mock.calls[1][1].body));
    expect(global.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer j2');
  });

  test('reponse sans choices → reponse_invalide', async () => {
    global.fetch.mockResolvedValueOnce(reponse(200, { choices: [] }));
    await expect(globalThis.MesAgents.lancerAgent({ model: 'a', consigne: 'c', contenu: 'x' }))
      .rejects.toMatchObject({ code: 'reponse_invalide' });
  });

  test('model absent → invalid_query sans appel reseau', async () => {
    await expect(globalThis.MesAgents.lancerAgent({ consigne: 'c', contenu: 'x' })).rejects.toMatchObject({ code: 'invalid_query' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('delai de 120 s : abandon → erreur delai (non masquee)', async () => {
    jest.useFakeTimers();
    const MA = globalThis.MesAgents;
    global.fetch.mockImplementationOnce((url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    }));
    const p = MA.lancerAgent({ model: 'a', consigne: 'c', contenu: 'x' });
    const attente = expect(p).rejects.toMatchObject({ code: 'delai', masquer: false });
    // Laisse la chaine async (config, jeton, cache) atteindre fetch() avant d'avancer l'horloge.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(MA.DELAI_LANCEMENT_MS + 1);
    await attente;
    jest.useRealTimers();
  });
});

describe('MesAgents — adaptateur de jeton par defaut (popup : MiraiAuth)', () => {
  test('utilise MiraiAuth.getValidToken puis _refreshToken sur rafraichissement force', async () => {
    const MA = globalThis.MesAgents;
    MA.setAuth(null);
    window.MiraiAuth = {
      getValidToken: jest.fn(async () => 'valide'),
      _getStoredToken: jest.fn(async () => ({ refresh_token: 'r' })),
      _getAuthConfig: jest.fn(() => ({})),
      _refreshToken: jest.fn(async () => ({ access_token: 'neuf' }))
    };
    expect(await MA._jeton(false)).toBe('valide');
    expect(await MA._jeton(true)).toBe('neuf');
    expect(window.MiraiAuth._refreshToken).toHaveBeenCalledWith({}, 'r');
  });
});

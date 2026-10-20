// mescollections/api.js — poser une question à Mes collections (assistants, collections).
// Sans DOM. Chargé dans l'arrière-plan et par les tests. Le jeton de la personne, jamais
// un jeton de service ; questions jamais anonymes (contrat : 401 sans jeton).
// Règles (docs/plan-bulle-mes-collections.md §5.2) :
//   - délai 30 s par requête ;
//   - 401 : rafraîchissement forcé du jeton, une nouvelle tentative, puis « reconnectez-vous » ;
//   - 429 : Retry-After respecté s'il est inférieur à 30 s, sinon (absent) une tentative après 2 s ;
//   - 503 ou réseau : une tentative après 2 s, puis « réessayez dans un instant » (panne signalée) ;
//   - 404 : la cible n'est plus lisible, elle est à retirer ;
//   - 403 audience_mismatch : message de configuration.

(function () {
  const DELAI_REQUETE_MS = 30000;
  const ATTENTE_MS = 2000;
  const RETRY_AFTER_MAX_S = 30;
  const LIMITE_RECHERCHE = 8;
  const MAX_QUESTION = 4000, MAX_TEXTE = 2000, MAX_TITRE = 300, MAX_REPONSE = 20000, MAX_PLAN = 8000, MAX_PASSAGES = 20;

  const deps = {
    fetch: (...a) => fetch(...a),
    obtenirJeton: async () => null,           // (forcer) => access token ou null
    attendre: (ms) => new Promise((r) => setTimeout(r, ms))
  };
  function configurer(d) { Object.assign(deps, d); }

  const texte = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const https = (u) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null);

  function erreur(code, message, extra = {}) {
    return { erreur: Object.assign({ code, message }, extra) };
  }

  async function corps(rep) {
    try { return await rep.json(); } catch (e) { return null; }
  }

  async function envoyer(cfg, route, chemin, init, jeton) {
    if (cfg.doublure) return globalThis.MesCollectionsDoublure.repondre(route, { mode: cfg.doublure, jeton });
    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(), DELAI_REQUETE_MS);
    try {
      return await deps.fetch(cfg.base + chemin, Object.assign({}, init, {
        headers: Object.assign({ Accept: 'application/json', Authorization: 'Bearer ' + jeton }, init.headers || {}),
        signal: ctrl.signal, credentials: 'omit', cache: 'no-store'
      }));
    } finally {
      clearTimeout(minuteur);
    }
  }

  /** Un appel avec les règles de retry ; rend { donnees } ou { erreur }. */
  async function appeler(cfg, route, chemin, init) {
    let jeton = await deps.obtenirJeton(false);
    if (!jeton) return erreur('connexion', 'Connectez-vous pour poser une question.');
    let reessaye = false, rafraichi = false;
    for (;;) {
      let rep;
      try {
        rep = await envoyer(cfg, route, chemin, init, jeton);
      } catch (e) {
        if (!reessaye) { reessaye = true; await deps.attendre(ATTENTE_MS); continue; }
        return erreur('indisponible', 'Mes collections ne répond pas. Réessayez dans un instant.', { panne: true });
      }
      if (rep.ok) {
        const d = await corps(rep);
        return d ? { donnees: d } : erreur('illisible', 'Réponse illisible de Mes collections.');
      }
      if (rep.status === 401) {
        if (!rafraichi) {
          rafraichi = true;
          jeton = await deps.obtenirJeton(true);
          if (jeton) continue;
        }
        return erreur('connexion', 'Votre session a expiré : reconnectez-vous pour poser une question.');
      }
      if (rep.status === 403) {
        const d = await corps(rep);
        const code = (d && ((d.error && d.error.code) || (d.detail && d.detail.code))) || 'forbidden';
        return code === 'audience_mismatch'
          ? erreur(code, 'Mes collections n\'accepte pas encore le jeton de l\'extension (configuration à corriger).')
          : erreur(code, 'Accès refusé par Mes collections.');
      }
      if (rep.status === 404) return erreur('introuvable', 'Cette source n\'est plus accessible.', { retirer: true });
      if (rep.status === 429) {
        const ra = Number(rep.headers && rep.headers.get('retry-after'));
        if (!reessaye && (!ra || ra <= RETRY_AFTER_MAX_S)) {
          reessaye = true;
          await deps.attendre(ra ? ra * 1000 : ATTENTE_MS);
          continue;
        }
        return erreur('limite', 'Trop de questions d\'affilée. Réessayez dans un instant.');
      }
      if (rep.status >= 500) {
        if (!reessaye) { reessaye = true; await deps.attendre(ATTENTE_MS); continue; }
        return erreur('indisponible', 'Mes collections est indisponible. Réessayez dans un instant.', { panne: true });
      }
      return erreur('inattendu', `Réponse inattendue de Mes collections (${rep.status}).`);
    }
  }

  function plan(p) {
    if (p === null || p === undefined) return null;
    try {
      const brut = JSON.stringify(p);
      return brut.length > MAX_PLAN ? null : JSON.parse(brut);
    } catch (e) { return null; }
  }

  function passage(p, champTexte) {
    if (!p || typeof p !== 'object') return null;
    const titre = texte(p.titre, MAX_TITRE);
    const extrait = texte(p[champTexte], MAX_TEXTE);
    if (!titre && !extrait) return null;
    return { titre, texte: extrait, url: https(p.url), source: texte(p.source || p.collection, MAX_TITRE) };
  }

  async function executer(cfg, cible, question) {
    const r = await appeler(cfg, 'executer', '/api/v1/assistants/' + encodeURIComponent(cible.id) + '/executer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, canal: 'api' })
    });
    const bloc = { type: 'assistant', cibles: [cible] };
    if (r.erreur) return Object.assign(bloc, r);
    const d = r.donnees;
    return Object.assign(bloc, {
      reponse: typeof d.reponse === 'string' ? d.reponse.slice(0, MAX_REPONSE) : null,
      passages: (Array.isArray(d.passages) ? d.passages : []).map((p) => passage(p, 'texte')).filter(Boolean).slice(0, MAX_PASSAGES),
      plan: plan(d.plan)
    });
  }

  async function chercher(cfg, cibles, question) {
    const params = new URLSearchParams({ q: question, scope: cibles.map((c) => c.id).join(','), limit: String(LIMITE_RECHERCHE) });
    const r = await appeler(cfg, 'search', '/api/v1/search?' + params, { method: 'GET' });
    const bloc = { type: 'collections', cibles };
    if (r.erreur) return Object.assign(bloc, r);
    const d = r.donnees;
    return Object.assign(bloc, {
      reponse: null,
      passages: (Array.isArray(d.results) ? d.results : []).map((p) => passage(p, 'extrait')).filter(Boolean).slice(0, MAX_PASSAGES),
      plan: null
    });
  }

  /**
   * Pose `question` aux cibles cochées : un appel par assistant, une recherche pour
   * l'ensemble des collections. Rend { blocs: [...] } (un bloc par appel, erreur incluse).
   */
  async function demander(cfg, cibles, question) {
    const q = String(question || '').trim().slice(0, MAX_QUESTION);
    if (!q) return { blocs: [] };
    const assistants = cibles.filter((c) => c.type === 'assistant');
    const collections = cibles.filter((c) => c.type === 'collection');
    const appels = assistants.map((c) => executer(cfg, c, q));
    if (collections.length) appels.push(chercher(cfg, collections, q));
    return { blocs: await Promise.all(appels) };
  }

  const api = { configurer, demander };
  globalThis.MesCollectionsApi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

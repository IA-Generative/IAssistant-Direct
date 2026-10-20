// mescollections/doublure.js — faux serveur Mes collections pour développer sans réseau.
// Rend des réponses au format de fetch (ok, status, headers.get, json) à partir de
// doublure.json, selon un mode choisi dans la page d'options :
//   normal   : avec jeton → 200 ; sans jeton → 401 (comportement par défaut du serveur)
//   anonyme  : comme normal, mais /sites sans jeton → 200 anonyme (MYCOLLECTIONS_SITES_ANONYMES=true)
//   refuse   : avec jeton → 403 audience_mismatch ; sans jeton → 401
//   limite   : 429 avec Retry-After
//   panne    : erreur réseau (le service ne répond pas)
// Les questions (search, executer) ne sont jamais anonymes : 401 sans jeton.

(function () {
  const MODES = ['normal', 'anonyme', 'refuse', 'limite', 'panne'];
  let _donnees = null;

  async function donnees() {
    if (_donnees) return _donnees;
    const B = (typeof browser !== 'undefined') ? browser : chrome;
    const resp = await fetch(B.runtime.getURL('src/mescollections/doublure.json'));
    _donnees = await resp.json();
    return _donnees;
  }

  function reponse(status, corps, entetes = {}) {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (nom) => entetes[String(nom).toLowerCase()] ?? null },
      json: async () => JSON.parse(JSON.stringify(corps))
    };
  }

  const ERREUR_401 = { error: { code: 'unauthorized', message: 'Jeton absent ou invalide' } };

  /** Liste anonyme : collections « _public » seulement, aucun assistant. */
  function sitesAnonymes(sites) {
    return {
      ttl_s: sites.ttl_s,
      anonyme: true,
      sites: sites.sites
        .map((s) => ({ motif: s.motif, cibles: s.cibles.filter((c) => c.type === 'collection' && c._public) }))
        .filter((s) => s.cibles.length)
    };
  }

  /**
   * @param {'sites'|'search'|'executer'} route
   * @param {{mode: string, jeton: string|null}} contexte
   */
  async function repondre(route, { mode, jeton }) {
    if (mode === 'panne') throw new TypeError('Failed to fetch (doublure : panne)');
    if (mode === 'limite') {
      return reponse(429, { error: { code: 'rate_limited', message: 'Trop de requêtes' } }, { 'retry-after': '30' });
    }
    const d = await donnees();

    if (route === 'sites') {
      if (!jeton) return mode === 'anonyme' ? reponse(200, sitesAnonymes(d.sites)) : reponse(401, { detail: ERREUR_401.error });
      if (mode === 'refuse') {
        return reponse(403, { detail: { code: 'audience_mismatch', message: "Le jeton ne porte pas l'audience attendue" } });
      }
      return reponse(200, d.sites);
    }

    if (!jeton) return reponse(401, ERREUR_401);
    if (mode === 'refuse') return reponse(403, { error: { code: 'audience_mismatch', message: "Le jeton ne porte pas l'audience attendue" } });
    return reponse(200, route === 'executer' ? d.executer : d.search);
  }

  const api = { MODES, repondre };
  globalThis.MesCollectionsDoublure = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

// mescollections/sites.js — « sites déclarés » de Mes collections : lecture, cache, état.
// Sans DOM. Chargé dans l'arrière-plan (importScripts / background.scripts) et par les tests.
// Voir docs/plan-bulle-mes-collections.md §5 (pannes, retry, mode anonyme).
//
// Règles :
//   - Mes collections ne répond pas (réseau, délai, 5xx, 429) ⇒ état « injoignable » :
//     plus aucune bulle, nouvelle tentative par recul exponentiel (1 → 60 min, gigue ±20 %).
//   - Jeton absent, ou refusé même après rafraîchissement (401) ⇒ nouvel appel SANS jeton
//     (mode anonyme). 401 sans jeton ⇒ « inactif » jusqu'à la prochaine connexion.
//   - 403 audience_mismatch ⇒ « refuse » (erreur de configuration rendue visible, pas masquée).
//   - Aucune adresse visitée n'est envoyée : la comparaison aux motifs se fait ici.

(function () {
  const CLE_ETAT = 'mescollectionsEtat';
  const CLE_DOUBLURE = 'mescollectionsDoublure';
  const ALARME = 'mescollections-sites';
  const DELAI_REQUETE_MS = 5000;
  const RECUL_MAX_MIN = 60;
  const GIGUE = 0.2;
  const TTL_DEFAUT_S = 3600, TTL_MIN_S = 60, TTL_MAX_S = 86400;
  const RELECTURE_REFUSE_MIN = 60;
  const MAX_SITES = 500, MAX_CIBLES = 50, MAX_TEXTE = 200;
  const MONTRABLES = ['connecte', 'anonyme'];

  const B = () => ((typeof browser !== 'undefined') ? browser : chrome);
  const Correspond = () => globalThis.MesCollectionsCorrespond;

  // Dépendances remplaçables (tests, arrière-plan).
  const deps = {
    fetch: (...a) => fetch(...a),
    obtenirJeton: async () => null,  // (forcer) => access token ou null
    maintenant: () => Date.now(),
    hasard: () => Math.random(),
    surChangement: () => {}          // (etat) => void, appelé après chaque mise à jour
  };
  function configurer(d) { Object.assign(deps, d); }

  // ── Configuration ────────────────────────────────────────────────────
  // Priorité : clé servie par le DM (issue #5) > config bakée (profil actif) > repli.
  let _bakee = null;
  async function configBakee() {
    if (_bakee) return _bakee;
    try {
      const raw = await (await fetch(B().runtime.getURL('src/dm/config.json'))).json();
      const profil = raw.activeProfile || 'prod';
      _bakee = Object.assign({}, raw.default || {}, raw[profil] || {});
    } catch (e) {
      _bakee = {};
    }
    return _bakee;
  }

  async function configuration() {
    const st = await B().storage.local.get({ dmConfigRaw: null, [CLE_DOUBLURE]: '' });
    const servie = (st.dmConfigRaw && (st.dmConfigRaw.config || st.dmConfigRaw)) || {};
    let base = servie.mycollectionsApiBase;
    if (base === undefined) base = (await configBakee()).mycollectionsApiBase;
    if (base === undefined && globalThis.DMBootstrap) base = globalThis.DMBootstrap._fallbackConfig.mycollectionsApiBase;
    const doublure = globalThis.MesCollectionsDoublure && globalThis.MesCollectionsDoublure.MODES.includes(st[CLE_DOUBLURE])
      ? st[CLE_DOUBLURE] : '';
    return { base: (base || '').replace(/\/+$/, ''), doublure };
  }

  // ── Appel ────────────────────────────────────────────────────────────
  async function appeler(cfg, jeton) {
    if (cfg.doublure) return globalThis.MesCollectionsDoublure.repondre('sites', { mode: cfg.doublure, jeton });
    const entetes = { Accept: 'application/json' };
    if (jeton) entetes.Authorization = 'Bearer ' + jeton;
    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(), DELAI_REQUETE_MS);
    try {
      return await deps.fetch(cfg.base + '/api/v1/sites', {
        headers: entetes, signal: ctrl.signal, credentials: 'omit', cache: 'no-store'
      });
    } finally {
      clearTimeout(minuteur);
    }
  }

  async function corps(rep) {
    try { return await rep.json(); } catch (e) { return null; }
  }

  // ── Nettoyage de la réponse ──────────────────────────────────────────
  const texte = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_TEXTE) : null);

  function nettoyer(sites, anonyme) {
    if (!Array.isArray(sites)) return [];
    const propres = [];
    for (const s of sites.slice(0, MAX_SITES)) {
      if (!s || !Correspond().valide(s.motif)) continue;
      const cibles = (Array.isArray(s.cibles) ? s.cibles : [])
        .filter((c) => c && (c.type === 'collection' || (c.type === 'assistant' && !anonyme)))
        .map((c) => ({ type: c.type, id: texte(c.id), titre: texte(c.titre) }))
        .filter((c) => c.id && c.titre)
        .slice(0, MAX_CIBLES);
      if (cibles.length) propres.push({ motif: s.motif, cibles });
    }
    return propres;
  }

  // ── État ─────────────────────────────────────────────────────────────
  async function etat() {
    const st = await B().storage.local.get({ [CLE_ETAT]: null });
    return st[CLE_ETAT] || { etat: 'inactif', raison: 'Jamais interrogé', echecs: 0, sites: [] };
  }

  function planifier(delaiMs) {
    const alarms = B().alarms;
    if (delaiMs === null) {
      if (alarms.clear) alarms.clear(ALARME);
      return null;
    }
    const quand = deps.maintenant() + Math.max(30000, Math.round(delaiMs));
    alarms.create(ALARME, { when: quand });
    return quand;
  }

  async function enregistrer(nouvel, delaiMs) {
    nouvel.prochaineTentative = planifier(delaiMs);
    nouvel.derniereTentative = deps.maintenant();
    await B().storage.local.set({ [CLE_ETAT]: nouvel });
    try { deps.surChangement(nouvel); } catch (e) { /* l'observateur ne bloque pas */ }
    return nouvel;
  }

  /** Délai avant la prochaine tentative après `echecs` échecs consécutifs (ms). */
  function recul(echecs, retryAfterS) {
    const minutes = Math.min(RECUL_MAX_MIN, Math.pow(2, Math.max(0, echecs - 1)));
    const avecGigue = minutes * 60000 * (1 + (deps.hasard() * 2 - 1) * GIGUE);
    const impose = Number(retryAfterS) > 0 ? Number(retryAfterS) * 1000 : 0;
    return Math.max(avecGigue, impose);
  }

  async function echec(precedent, raison, retryAfterS) {
    const echecs = (precedent.etat === 'injoignable' ? precedent.echecs || 0 : 0) + 1;
    return enregistrer({ etat: 'injoignable', raison, echecs, sites: [], derniereReponse: precedent.derniereReponse || null },
      recul(echecs, retryAfterS));
  }

  // ── Lecture ──────────────────────────────────────────────────────────
  async function _lire() {
    const precedent = await etat();
    const cfg = await configuration();
    if (!cfg.base && !cfg.doublure) {
      return enregistrer({ etat: 'inactif', raison: 'Adresse de Mes collections non configurée', echecs: 0, sites: [] }, null);
    }

    let jeton = null;
    let rep;
    try {
      jeton = await deps.obtenirJeton(false);
      if (jeton) {
        rep = await appeler(cfg, jeton);
        if (rep.status === 401) {
          jeton = await deps.obtenirJeton(true);
          rep = jeton ? await appeler(cfg, jeton) : null;
          if (!rep || rep.status === 401) { jeton = null; rep = null; }
        }
      }
      if (!jeton) rep = await appeler(cfg, null);
    } catch (e) {
      return echec(precedent, 'Mes collections ne répond pas', null);
    }

    const anonyme = !jeton;
    if (rep.ok) {
      const donnees = await corps(rep);
      if (!donnees || !Array.isArray(donnees.sites)) return echec(precedent, 'Réponse illisible de Mes collections', null);
      const ttl = Math.min(TTL_MAX_S, Math.max(TTL_MIN_S, Number(donnees.ttl_s) || TTL_DEFAUT_S));
      return enregistrer({
        etat: anonyme ? 'anonyme' : 'connecte',
        raison: anonyme ? 'Mode anonyme : connectez-vous pour poser une question' : '',
        echecs: 0,
        ttl_s: ttl,
        sites: nettoyer(donnees.sites, anonyme),
        derniereReponse: deps.maintenant()
      }, ttl * 1000);
    }

    if (rep.status === 401) {
      // Sans jeton : le serveur n'accepte pas l'anonyme. Rien avant la prochaine connexion.
      return enregistrer({ etat: 'inactif', raison: 'Connexion requise (mode anonyme non ouvert)', echecs: 0, sites: [], derniereReponse: deps.maintenant() }, null);
    }
    if (rep.status === 403) {
      const d = await corps(rep);
      const code = (d && d.detail && d.detail.code) || 'forbidden';
      const raison = code === 'audience_mismatch' ? 'Jeton non accepté par Mes collections (audience_mismatch)' : `Accès refusé par Mes collections (${code})`;
      return enregistrer({ etat: 'refuse', raison, echecs: 0, sites: [], derniereReponse: deps.maintenant() }, RELECTURE_REFUSE_MIN * 60000);
    }
    if (rep.status === 429) {
      return echec(precedent, 'Mes collections limite les requêtes (429)', rep.headers && rep.headers.get('retry-after'));
    }
    return echec(precedent, `Mes collections indisponible (${rep.status})`, null);
  }

  // Une seule lecture à la fois : les appels concurrents partagent la même promesse.
  let _enCours = null;
  function lire() {
    if (!_enCours) _enCours = _lire().finally(() => { _enCours = null; });
    return _enCours;
  }

  /** Remet le compteur d'échecs à zéro (connexion, « Réessayer maintenant ») puis relit. */
  async function reinitialiser() {
    const e = await etat();
    await B().storage.local.set({ [CLE_ETAT]: Object.assign({}, e, { echecs: 0 }) });
    return lire();
  }

  /**
   * Cibles de la page `url` selon le dernier état connu. [] si la bulle ne doit pas
   * apparaître (état non montrable, liste périmée). Aucun appel réseau, sauf relecture
   * en arrière-plan quand la liste est périmée.
   */
  async function ciblesPour(url) {
    const e = await etat();
    if (!MONTRABLES.includes(e.etat)) return { cibles: [], etat: e.etat };
    const perimee = !e.derniereReponse || deps.maintenant() - e.derniereReponse > 2 * (e.ttl_s || TTL_DEFAUT_S) * 1000;
    if (perimee) {
      lire();
      return { cibles: [], etat: e.etat };
    }
    return { cibles: Correspond().ciblesPour(url, e.sites), etat: e.etat };
  }

  const api = {
    ALARME, CLE_ETAT, CLE_DOUBLURE, MONTRABLES,
    configurer, configuration, lire, reinitialiser, etat, ciblesPour, recul, nettoyer
  };
  globalThis.MesCollectionsSites = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

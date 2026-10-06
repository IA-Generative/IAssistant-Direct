// mesagents.js — Consommation du contrat d'agents MirAI (service « Mes agents »)
//
// Contrat de référence : myagents-contrat/docs/contrats/contrat-agents-mirai.md (v1, 2026-10-06).
//   - GET  {mesagentsBaseUrl}/api/v1/agents      → liste des agents accessibles à la personne
//   - POST {mesagentsBaseUrl}/v1/chat/completions → lance un agent (format OpenAI, `model` = agent)
//
// Chargé via <script> dans popup.html (après crypto.js, dm/bootstrap.js, auth.js)
// ET dans le background (importScripts côté Chrome, background.scripts côté Firefox).
// Exposé sur globalThis pour couvrir window (popup) et self (service worker).
//
// Règles tenues ici :
//   - le jeton n'est JAMAIS journalisé ;
//   - le contenu des fiches est une donnée non fiable : chaînes bornées, à afficher par textContent ;
//   - la fonction est invisible si `mesagentsBaseUrl` est vide ou si `features.agents` est faux ;
//   - sur 401, un seul rafraîchissement silencieux puis une seule nouvelle tentative.

(function (root) {
  'use strict';

  const CACHE_TTL_MS = 3 * 60 * 1000;        // « garder la liste au plus quelques minutes »
  const DELAI_LANCEMENT_MS = 120 * 1000;     // « délai d'au moins 120 s »
  const DELAI_LISTE_MS = 20 * 1000;
  const MAX_MESSAGE_CHARS = 100000;          // le contrat tronque au-delà de 100 000 « en le disant à la personne » (plafond serveur : 120 000)
  const LIMITE_LISTE = 200;
  const PORTEE_KEYCLOAK = 'mesagents-agents';
  const CLE_CACHE = 'mesagentsCache';
  const ENTREES_CONNUES = ['text', 'selection', 'document', 'email', 'thread', 'meeting', 'collection', 'page'];
  const SORTIES_CONNUES = ['text', 'replacement', 'insertion'];
  const MARQUE_TRONCATURE = '\n[… contenu tronqué]';

  /**
   * Erreur normalisée. `masquer` = la section « Agents » doit disparaître sans bloquer
   * l'écran (jeton invalide, audience absente, service injoignable, fonction désactivée).
   */
  class MesAgentsError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = 'MesAgentsError';
      this.code = code;
      this.status = details.status || 0;
      this.masquer = !!details.masquer;
      this.retryAfter = details.retryAfter || null;
    }
  }

  function _navigateur() {
    return (typeof browser !== 'undefined') ? browser : chrome;
  }

  function _chaine(v, max) {
    if (typeof v !== 'string') return '';
    return max && v.length > max ? v.slice(0, max) : v;
  }

  const MesAgents = {
    MesAgentsError,
    PORTEE_KEYCLOAK,
    CACHE_TTL_MS,
    DELAI_LANCEMENT_MS,
    MAX_MESSAGE_CHARS,
    ENTREES_CONNUES,

    _auth: null,
    _memo: null,

    // ──────────────────────────────────────────────
    // Configuration (clé DM + flag de fonctionnalité)
    // ──────────────────────────────────────────────

    /** URL de base normalisée, ou '' si vide / placeholder `${{...}}` non résolu / non http(s). */
    baseUrl(cfg) {
      const u = String(cfg?.mesagentsBaseUrl || '').trim();
      if (!/^https?:\/\/[^\s/$]/i.test(u)) return '';
      return u.replace(/\/+$/, '');
    },

    estConfigure(cfg) {
      return !!this.baseUrl(cfg);
    },

    /**
     * Flag `features.agents` (lu via DMBootstrap.getFeatures()). Absent = actif : la clé
     * `mesagentsBaseUrl` fait foi, le flag est un interrupteur de coupure côté DM.
     * Les valeurs textuelles ("false", "0", "off", "non") sont acceptées car les
     * placeholders DM sont substitués en chaînes.
     */
    featureActive(cfg) {
      const v = cfg?.features?.agents;
      if (v === undefined || v === null || v === '') return true;
      if (typeof v === 'string') return !['false', '0', 'off', 'non', 'no'].includes(v.trim().toLowerCase());
      return !!v;
    },

    estActif(cfg) {
      return this.estConfigure(cfg) && this.featureActive(cfg);
    },

    /**
     * Portée OIDC à demander : ajoute `mesagents-agents` (audience `mesagents` + groupes en
     * chemins complets) uniquement quand la fonction est active — sinon Keycloak répondrait
     * `invalid_scope` et casserait la connexion.
     */
    buildScope(base, cfg) {
      const portees = String(base || '').split(/\s+/).filter(Boolean);
      if (this.estActif(cfg) && !portees.includes(PORTEE_KEYCLOAK)) portees.push(PORTEE_KEYCLOAK);
      return portees.join(' ');
    },

    async _lireConfig() {
      const DM = root.DMBootstrap;
      if (!DM) return {};
      let cfg = {};
      try {
        cfg = (DM.getConfigAsync ? await DM.getConfigAsync() : DM.getConfig()) || {};
      } catch (e) {
        cfg = (DM.getConfig && DM.getConfig()) || {};
      }
      const features = (DM.getFeatures && DM.getFeatures()) || cfg.features || {};
      return Object.assign({}, cfg, { features });
    },

    // ──────────────────────────────────────────────
    // Jeton — adaptateur injectable (popup : MiraiAuth ; background : _ensureTokenFresh)
    // ──────────────────────────────────────────────

    /** @param {{obtenirJeton: (forcer: boolean) => Promise<string|null>}} adaptateur */
    setAuth(adaptateur) {
      this._auth = adaptateur && typeof adaptateur.obtenirJeton === 'function' ? adaptateur : null;
      return this;
    },

    async _jeton(forcer) {
      if (this._auth) return this._auth.obtenirJeton(!!forcer);

      // Popup / options : MiraiAuth (auth.js) porte le rafraîchissement silencieux.
      const A = root.MiraiAuth;
      if (A && typeof A.getValidToken === 'function') {
        if (!forcer) return A.getValidToken();
        const stored = await A._getStoredToken();
        if (!stored?.refresh_token) return null;
        const r = await A._refreshToken(A._getAuthConfig(), stored.refresh_token);
        return r?.access_token || null;
      }

      // Dernier recours (sans rafraîchissement) : TokenStore seul.
      const TS = root.TokenStore;
      if (!TS) return null;
      const t = await TS.getToken();
      return (t?.access_token && t.expires_in > Date.now()) ? t.access_token : null;
    },

    // ──────────────────────────────────────────────
    // Cache de la liste (mémoire + storage.session, repli storage.local)
    // ──────────────────────────────────────────────

    _store() {
      const B = _navigateur();
      return B?.storage?.session || B?.storage?.local || null;
    },

    async _cacheLire() {
      const now = Date.now();
      if (this._memo && now - this._memo.fetchedAt < CACHE_TTL_MS) return this._memo.agents;
      try {
        const store = this._store();
        if (!store) return null;
        const got = await store.get({ [CLE_CACHE]: null });
        const c = got?.[CLE_CACHE];
        if (c && Array.isArray(c.agents) && now - c.fetchedAt < CACHE_TTL_MS) {
          this._memo = c;
          return c.agents;
        }
      } catch (e) { /* cache indisponible : on refait l'appel */ }
      return null;
    },

    async _cacheEcrire(agents) {
      this._memo = { agents, fetchedAt: Date.now() };
      try {
        const store = this._store();
        if (store) await store.set({ [CLE_CACHE]: this._memo });
      } catch (e) { /* non bloquant */ }
    },

    async viderCache() {
      this._memo = null;
      try {
        const store = this._store();
        if (store) await store.remove(CLE_CACHE);
      } catch (e) { /* non bloquant */ }
    },

    // ──────────────────────────────────────────────
    // Fiches : normalisation (données non fiables) et filtrage
    // ──────────────────────────────────────────────

    normaliserAgent(a) {
      if (!a || typeof a !== 'object') return null;
      const id = _chaine(a.id, 200);
      const name = _chaine(a.name, 200).trim();
      if (!id || !name) return null;
      const inputs = Array.isArray(a.inputs) ? a.inputs.filter(i => ENTREES_CONNUES.includes(i)) : [];
      const outputs = Array.isArray(a.outputs) ? a.outputs.filter(o => SORTIES_CONNUES.includes(o)) : [];
      const url = _chaine(a.url, 2000);
      return {
        id,
        name,
        description: _chaine(a.description, 2000),
        origin: a.origin === 'mine' ? 'mine' : 'shared',
        status: _chaine(a.status, 20),
        inputs,
        outputs,
        model: _chaine(a.model, 200) || id,
        url: /^https:\/\//i.test(url) ? url : ''
      };
    },

    normaliserListe(data) {
      const brut = Array.isArray(data?.agents) ? data.agents : [];
      return brut.map(a => this.normaliserAgent(a)).filter(Boolean);
    },

    filtrerAgents(agents, input) {
      const liste = Array.isArray(agents) ? agents : [];
      if (!input) return liste;
      if (!ENTREES_CONNUES.includes(input)) return [];
      return liste.filter(a => Array.isArray(a.inputs) && a.inputs.includes(input));
    },

    // ──────────────────────────────────────────────
    // Message : consigne + contenu délimité, délimiteurs neutralisés, taille bornée
    // ──────────────────────────────────────────────

    neutraliser(texte) {
      return String(texte ?? '').replace(/<<</g, '‹‹‹').replace(/>>>/g, '›››');
    },

    /** @returns {{message: string, tronque: boolean}} */
    composerMessage(consigne, contenu) {
      const tete = String(consigne || '').trim() + '\n\n<<<\n';
      const pied = '\n>>>';
      let corps = this.neutraliser(contenu);
      const place = MAX_MESSAGE_CHARS - tete.length - pied.length;
      let tronque = false;
      if (corps.length > place) {
        corps = corps.slice(0, Math.max(0, place - MARQUE_TRONCATURE.length)) + MARQUE_TRONCATURE;
        tronque = true;
      }
      return { message: tete + corps + pied, tronque };
    },

    construireMessage(consigne, contenu) {
      return this.composerMessage(consigne, contenu).message;
    },

    // ──────────────────────────────────────────────
    // Erreurs normalisées
    // ──────────────────────────────────────────────

    async normaliserErreur(resp) {
      let corps = null;
      try { corps = await resp.json(); } catch (e) { corps = null; }
      const err = corps?.error || {};
      const code = typeof err.code === 'string' ? err.code : '';
      const msg = typeof err.message === 'string' ? err.message : '';
      const status = resp.status;

      switch (status) {
        case 400:
          return new MesAgentsError(code || 'invalid_query', 'Requête refusée par Mes agents.', { status });
        case 401:
          return new MesAgentsError('invalid_token', 'Session MirAI invalide ou expirée.', { status, masquer: true });
        case 403:
          return new MesAgentsError(code || 'forbidden', 'Accès aux agents refusé.', { status, masquer: true });
        case 404:
          return new MesAgentsError('model_not_found', "Cet agent n'est plus accessible.", { status });
        case 422:
          // `message` est à afficher tel quel à la personne (garde anti-injection).
          return new MesAgentsError(code || 'blocked_input', msg || 'Contenu refusé par la garde de Mes agents.', { status });
        case 429:
          return new MesAgentsError('rate_limited', 'Réessayez dans un moment.', {
            status, retryAfter: resp.headers?.get ? resp.headers.get('Retry-After') : null
          });
        case 502:
          return new MesAgentsError(code || 'llm_unavailable', "L'agent ne répond pas.", { status });
        default:
          if (status >= 500) {
            return new MesAgentsError(code || 'indisponible', 'Mes agents est indisponible pour le moment.', { status });
          }
          return new MesAgentsError(code || 'erreur', `Erreur Mes agents (${status}).`, { status });
      }
    },

    /** Message lisible pour une erreur quelconque (jamais le corps brut, jamais le jeton). */
    messageErreur(e) {
      if (e instanceof MesAgentsError) return e.message;
      if (e && e.name === 'MesAgentsError' && e.message) return e.message;
      return 'Erreur inattendue en contactant Mes agents.';
    },

    // ──────────────────────────────────────────────
    // Transport
    // ──────────────────────────────────────────────

    async _fetch(url, { method, body, jeton, timeoutMs }) {
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      const headers = { 'Authorization': `Bearer ${jeton}`, 'Accept': 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      try {
        return await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: ctrl ? ctrl.signal : undefined,
          cache: 'no-store'
        });
      } catch (e) {
        if (e && e.name === 'AbortError') {
          throw new MesAgentsError('delai', `L'agent n'a pas répondu dans le délai imparti (${Math.round(timeoutMs / 1000)} s).`);
        }
        throw new MesAgentsError('injoignable', 'Mes agents est injoignable.', { masquer: true });
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    /** Appel authentifié ; sur 401, rafraîchit le jeton une fois et réessaie une fois. */
    async _requete(cfg, method, chemin, body, options = {}) {
      const base = this.baseUrl(cfg);
      if (!base) throw new MesAgentsError('desactive', 'Fonction « Agents » désactivée.', { masquer: true });
      const url = base + chemin;
      const timeoutMs = options.timeoutMs || DELAI_LISTE_MS;

      let jeton = await this._jeton(false);
      if (!jeton) throw new MesAgentsError('invalid_token', 'Non connecté (SSO).', { status: 401, masquer: true });

      let resp = await this._fetch(url, { method, body, jeton, timeoutMs });
      if (resp.status === 401) {
        jeton = await this._jeton(true);
        if (!jeton) throw new MesAgentsError('invalid_token', 'Session MirAI expirée.', { status: 401, masquer: true });
        resp = await this._fetch(url, { method, body, jeton, timeoutMs });
      }
      if (!resp.ok) throw await this.normaliserErreur(resp);
      try {
        return await resp.json();
      } catch (e) {
        throw new MesAgentsError('reponse_invalide', 'Réponse illisible de Mes agents.');
      }
    },

    // ──────────────────────────────────────────────
    // API publique
    // ──────────────────────────────────────────────

    /**
     * Liste les agents accessibles (cache 3 min), filtrés côté client sur `inputs`.
     * @param {{input?: string, force?: boolean}} options
     */
    async listerAgents(options = {}) {
      const { input = null, force = false } = options;
      const cfg = await this._lireConfig();
      if (!this.estActif(cfg)) throw new MesAgentsError('desactive', 'Fonction « Agents » désactivée.', { masquer: true });

      let agents = force ? null : await this._cacheLire();
      if (!agents) {
        const data = await this._requete(cfg, 'GET', `/api/v1/agents?limit=${LIMITE_LISTE}`);
        agents = this.normaliserListe(data);
        await this._cacheEcrire(agents);
      }
      return this.filtrerAgents(agents, input);
    },

    /**
     * Lance un agent sur un contenu : dernier message `user` = consigne + contenu délimité.
     * @param {{model: string, consigne: string, contenu: string}} params
     * @returns {Promise<{texte: string, model: string, id: string|null, tronque: boolean}>}
     *   `tronque` : le contenu a été coupé à MAX_MESSAGE_CHARS — à dire à la personne.
     */
    async lancerAgent(params = {}) {
      const { model, consigne, contenu } = params;
      const cfg = await this._lireConfig();
      if (!this.estActif(cfg)) throw new MesAgentsError('desactive', 'Fonction « Agents » désactivée.', { masquer: true });
      if (!model || typeof model !== 'string') throw new MesAgentsError('invalid_query', 'Agent non précisé.');

      const { message, tronque } = this.composerMessage(consigne, contenu);
      const data = await this._requete(cfg, 'POST', '/v1/chat/completions', {
        model,
        messages: [{ role: 'user', content: message }],
        stream: false
      }, { timeoutMs: DELAI_LANCEMENT_MS });

      const texte = data?.choices?.[0]?.message?.content;
      if (typeof texte !== 'string') throw new MesAgentsError('reponse_invalide', "Réponse inattendue de l'agent.");
      return { texte, model, id: typeof data.id === 'string' ? data.id : null, tronque };
    }
  };

  root.MesAgents = MesAgents;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : window));

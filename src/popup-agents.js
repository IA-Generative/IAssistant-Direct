// popup-agents.js — Section « Agents MirAI » du popup + vue « Résultat »
// Chargé via <script> dans popup.html après mesagents.js, avant popup.js.
//
// - Section « Agents » : liste des agents qui acceptent un texte saisi (inputs ∋ text),
//   champ texte, bouton « Lancer ». Absente si la fonction est désactivée, la personne
//   déconnectée, l'audience refusée ou le service injoignable (erreurs `masquer`).
// - Vue « Résultat » : nom de l'agent, réponse en texte (textContent, jamais HTML),
//   bouton « Copier ». Alimentée par le popup lui-même ou par le service worker via
//   storage.session (`mesagentsResultat`), lu à l'ouverture et sur storage.onChanged.

(function (root) {
  'use strict';

  const CLE_RESULTAT = 'mesagentsResultat';
  const MAX_TEXTE_SAISI = 100000; // aligne sur MesAgents.MAX_MESSAGE_CHARS (le module tronque et le dit)

  function _navigateur() {
    return (typeof browser !== 'undefined') ? browser : chrome;
  }

  const PopupAgents = {
    _els: null,
    _agents: [],
    _resultat: null,
    _doc: null,

    // ──────────────────────────────────────────────
    // Initialisation
    // ──────────────────────────────────────────────

    init(doc) {
      this._doc = doc || document;
      const $ = (id) => this._doc.getElementById(id);
      this._els = {
        bloc: $('agents-block'),
        form: $('agents-form'),
        select: $('agents-select'),
        description: $('agents-description'),
        texte: $('agents-text'),
        lancer: $('agents-launch'),
        statut: $('agents-status'),
        vide: $('agents-empty'),
        rafraichir: $('agents-refresh'),
        resultat: $('agents-result'),
        resultatNom: $('agents-result-name'),
        resultatStatut: $('agents-result-status'),
        resultatTexte: $('agents-result-text'),
        resultatCopier: $('agents-result-copy'),
        resultatCopie: $('agents-result-copied'),
        resultatFermer: $('agents-result-close')
      };
      const e = this._els;
      if (!e.bloc) return this;

      if (e.select) e.select.addEventListener('change', () => this._afficherDescription());
      if (e.lancer) e.lancer.addEventListener('click', () => this.lancer());
      if (e.rafraichir) e.rafraichir.addEventListener('click', () => this.charger({ force: true }));
      if (e.resultatCopier) e.resultatCopier.addEventListener('click', () => this.copier());
      if (e.resultatFermer) e.resultatFermer.addEventListener('click', () => this.fermerResultat());
      if (e.texte) {
        e.texte.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); this.lancer(); }
        });
      }

      // Résultat publié par le service worker (menu contextuel) : à l'ouverture puis en direct.
      this._lireResultatStocke().catch(() => {});
      try {
        const B = _navigateur();
        if (B?.storage?.onChanged) {
          B.storage.onChanged.addListener((changes, area) => this._onStorageChanged(changes, area));
        }
      } catch (err) { /* écoute facultative */ }
      return this;
    },

    _store() {
      const B = _navigateur();
      return B?.storage?.session || B?.storage?.local || null;
    },

    async _lireResultatStocke() {
      const store = this._store();
      if (!store) return;
      const got = await store.get({ [CLE_RESULTAT]: null });
      const r = got?.[CLE_RESULTAT];
      if (r && r.status) this.afficherResultat(r);
    },

    _onStorageChanged(changes, area) {
      if (!changes || !changes[CLE_RESULTAT]) return;
      if (area !== 'session' && area !== 'local') return;
      const r = changes[CLE_RESULTAT].newValue;
      if (r && r.status) this.afficherResultat(r);
      else if (!r) this._masquerResultat();
    },

    // ──────────────────────────────────────────────
    // Section « Agents » (texte saisi)
    // ──────────────────────────────────────────────

    _masquerSection() {
      if (this._els?.bloc) this._els.bloc.style.display = 'none';
    },

    _afficherSection() {
      if (this._els?.bloc) this._els.bloc.style.display = 'block';
    },

    _statut(texte, type) {
      const el = this._els?.statut;
      if (!el) return;
      el.textContent = texte || '';
      el.className = 'agents-status' + (type ? ' ' + type : '');
    },

    _afficherDescription() {
      const e = this._els;
      if (!e?.select || !e.description) return;
      const agent = this._agents.find(a => a.id === e.select.value);
      e.description.textContent = agent ? (agent.description || '') : '';
    },

    /**
     * Charge la liste des agents « texte » et affiche la section si elle a un sens.
     * Appelée après l'init de la config DM (dmInit dans popup.js).
     */
    async charger(options = {}) {
      const e = this._els;
      if (!e?.bloc) return;
      const MA = root.MesAgents;
      if (!MA) { this._masquerSection(); return; }

      let cfg = {};
      try { cfg = await MA._lireConfig(); } catch (err) { cfg = {}; }
      if (!MA.estActif(cfg)) { this._masquerSection(); return; }

      this._afficherSection();
      this._statut('Chargement des agents…', 'busy');
      if (e.lancer) e.lancer.disabled = true;

      try {
        this._agents = await MA.listerAgents({ input: 'text', force: !!options.force });
      } catch (err) {
        if (err?.masquer) {
          console.info('[MirAI Agents] Section masquée :', err.code);
          this._masquerSection();
        } else {
          this._statut(MA.messageErreur(err), 'err');
        }
        return;
      }

      this._rendreListe();
      this._statut('', '');
    },

    _rendreListe() {
      const e = this._els;
      if (!e?.select) return;
      e.select.textContent = '';
      for (const a of this._agents) {
        const opt = this._doc.createElement('option');
        opt.value = a.id;
        opt.textContent = (a.origin === 'mine' ? '★ ' : '') + a.name;
        opt.title = a.origin === 'mine' ? 'Le vôtre' : 'Partagé par des collègues';
        e.select.appendChild(opt);
      }
      const aucun = this._agents.length === 0;
      if (e.form) e.form.style.display = aucun ? 'none' : 'block';
      if (e.vide) e.vide.style.display = aucun ? 'block' : 'none';
      if (e.lancer) e.lancer.disabled = aucun;
      this._afficherDescription();
    },

    async lancer() {
      const e = this._els;
      const MA = root.MesAgents;
      if (!e?.select || !MA) return;
      const agent = this._agents.find(a => a.id === e.select.value);
      if (!agent) { this._statut('Choisissez un agent.', 'err'); return; }
      const texte = String(e.texte?.value || '').trim().slice(0, MAX_TEXTE_SAISI);
      if (!texte) { this._statut('Saisissez un texte à confier à l\'agent.', 'err'); if (e.texte) e.texte.focus(); return; }

      if (e.lancer) e.lancer.disabled = true;
      this._statut('Agent en cours…', 'busy');
      const fiche = { id: agent.id, name: agent.name };
      this.afficherResultat({ status: 'pending', agent: fiche });

      try {
        const r = await MA.lancerAgent({
          model: agent.model,
          consigne: 'Voici le texte à traiter. Applique ta mission à ce texte.',
          contenu: texte
        });
        this.afficherResultat({ status: 'done', agent: fiche, texte: r.texte, tronque: !!r.tronque });
        this._statut('', '');
      } catch (err) {
        const message = MA.messageErreur(err);
        this.afficherResultat({ status: 'error', agent: fiche, message });
        if (err?.masquer) this._masquerSection(); else this._statut(message, 'err');
      } finally {
        if (e.lancer) e.lancer.disabled = false;
      }
    },

    // ──────────────────────────────────────────────
    // Vue « Résultat »
    // ──────────────────────────────────────────────

    afficherResultat(r) {
      const e = this._els;
      if (!e?.resultat) return;
      this._resultat = r;
      e.resultat.style.display = 'block';
      if (e.resultatNom) e.resultatNom.textContent = r.agent?.name || 'Agent MirAI';
      if (e.resultatCopie) e.resultatCopie.textContent = '';

      if (r.status === 'pending') {
        if (e.resultatStatut) { e.resultatStatut.textContent = 'En attente de la réponse…'; e.resultatStatut.className = 'agents-status busy'; }
        if (e.resultatTexte) e.resultatTexte.textContent = '';
        if (e.resultatCopier) e.resultatCopier.disabled = true;
      } else if (r.status === 'done') {
        if (e.resultatStatut) {
          e.resultatStatut.textContent = r.tronque ? 'Contenu tronqué avant envoi (limite du contrat).' : '';
          e.resultatStatut.className = 'agents-status';
        }
        if (e.resultatTexte) e.resultatTexte.textContent = String(r.texte || '');
        if (e.resultatCopier) e.resultatCopier.disabled = !r.texte;
      } else {
        if (e.resultatStatut) { e.resultatStatut.textContent = r.message || 'Erreur.'; e.resultatStatut.className = 'agents-status err'; }
        if (e.resultatTexte) e.resultatTexte.textContent = '';
        if (e.resultatCopier) e.resultatCopier.disabled = true;
      }
    },

    _masquerResultat() {
      const e = this._els;
      this._resultat = null;
      if (e?.resultat) e.resultat.style.display = 'none';
      if (e?.resultatTexte) e.resultatTexte.textContent = '';
    },

    async fermerResultat() {
      this._masquerResultat();
      try {
        const store = this._store();
        if (store) await store.remove(CLE_RESULTAT);
      } catch (err) { /* non bloquant */ }
    },

    async copier() {
      const e = this._els;
      const texte = this._resultat?.status === 'done' ? String(this._resultat.texte || '') : '';
      if (!texte) return;
      let ok = false;
      try {
        if (root.navigator?.clipboard?.writeText) { await root.navigator.clipboard.writeText(texte); ok = true; }
      } catch (err) { ok = false; }
      if (!ok && e?.resultatTexte && this._doc.execCommand) {
        try {
          const sel = this._doc.getSelection();
          const range = this._doc.createRange();
          range.selectNodeContents(e.resultatTexte);
          sel.removeAllRanges(); sel.addRange(range);
          ok = this._doc.execCommand('copy');
          sel.removeAllRanges();
        } catch (err) { ok = false; }
      }
      if (e?.resultatCopie) {
        e.resultatCopie.textContent = ok ? 'Copié.' : 'Copie impossible.';
        setTimeout(() => { if (e.resultatCopie) e.resultatCopie.textContent = ''; }, 2500);
      }
      return ok;
    }
  };

  root.PopupAgents = PopupAgents;
})(typeof window !== 'undefined' ? window : globalThis);

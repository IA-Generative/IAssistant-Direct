// mescollections/correspond.js — motifs d'adresse des « sites déclarés » de Mes collections.
// Fonctions pures, sans DOM ni réseau. Chargé par importScripts (service worker),
// background.scripts (Firefox) et require (tests). Exposé sur globalThis.
//
// Règle = celle des match patterns d'extension, restreinte par le contrat de
// Mes collections (docs/plan-bulle-mes-collections.md §4.1) :
//   - schéma https exact ;
//   - hôte explicite en minuscules, ni port ni identifiant ; « *. » en tête possible
//     sur au moins deux niveaux (*.gouv.fr oui, *.fr non), et couvre aussi le domaine nu ;
//   - chemin comparé AVEC la query, « * » = n'importe quelle suite ; #fragment jamais comparé.

(function () {
  const MAX_MOTIF = 2048;
  const RE_MOTIF = /^https:\/\/([^/]+)(\/.*)$/;
  const RE_HOTE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

  const echapper = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

  /**
   * Compile un motif en expression régulière, ou null s'il ne respecte pas la règle.
   * L'expression s'applique à `https://hote` + chemin + query.
   */
  function compiler(motif) {
    if (typeof motif !== 'string' || motif.length > MAX_MOTIF) return null;
    const m = RE_MOTIF.exec(motif);
    if (!m) return null;
    let hote = m[1];
    const chemin = m[2];

    let prefixeHote = '';
    if (hote.startsWith('*.')) {
      hote = hote.slice(2);
      prefixeHote = '(?:[a-z0-9-]+\\.)*';
    }
    // RE_HOTE exige au moins deux niveaux, refuse « * », port (:), identifiant (@) et majuscules.
    if (!RE_HOTE.test(hote)) return null;

    const reChemin = chemin.split('*').map(echapper).join('.*');
    return new RegExp('^https://' + prefixeHote + echapper(hote) + reChemin + '$');
  }

  function valide(motif) {
    return compiler(motif) !== null;
  }

  /** Forme comparée d'une adresse : https://hote + chemin + query, sans fragment. */
  function normaliser(url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return 'https://' + u.hostname + u.pathname + u.search;
  }

  /** L'adresse `url` correspond-elle au motif ? Un motif invalide ne correspond à rien. */
  function correspond(url, motif) {
    const re = compiler(motif);
    const cible = normaliser(url);
    return !!(re && cible !== null && re.test(cible));
  }

  /**
   * Cibles de toutes les entrées `sites` dont un motif correspond à `url`,
   * sans doublon (type + id), dans l'ordre de la liste.
   */
  function ciblesPour(url, sites) {
    const cible = normaliser(url);
    if (cible === null || !Array.isArray(sites)) return [];
    const vues = new Set();
    const resultat = [];
    for (const site of sites) {
      const re = compiler(site && site.motif);
      if (!re || !re.test(cible)) continue;
      for (const c of site.cibles || []) {
        const cle = c.type + ':' + c.id;
        if (vues.has(cle)) continue;
        vues.add(cle);
        resultat.push(c);
      }
    }
    return resultat;
  }

  const api = { compiler, valide, normaliser, correspond, ciblesPour };
  globalThis.MesCollectionsCorrespond = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();

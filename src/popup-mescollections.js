// popup-mescollections.js — Mes collections dans le popup.
// Sur une page déclarée dans Mes collections qui n'est pas une visio, les informations de
// conférence (bouton REC, onglets visio, dernières conférences, raccourcis) laissent la place
// aux sources de la page et aux réglages de la bulle « + IA » (affichage sur ce site,
// opacité au repos). Une ligne « Mettre à jour la liste » relit les sites déclarés.
// L'adresse de l'onglet est comparée par l'arrière-plan : elle ne sort pas de l'extension.

(function () {
  const B = (typeof browser !== 'undefined') ? browser : chrome;
  const CLE_PREFS = 'mescollectionsBulle';            // partagée avec mescollections/bulle.js
  const OPACITE_DEFAUT = 0.35;
  // Mêmes mots-clés que popup.js pour reconnaître une visio.
  const MOTS_VISIO = (typeof allowedKeywords !== 'undefined')
    ? allowedKeywords : ['webconf', 'visio', 'comu', 'webinaire', 'webex', 'gmeet', 'teams'];

  const $ = (id) => document.getElementById(id);
  const LIBELLES = {
    connecte: ['actif', ''],
    anonyme: ['mode anonyme', 'neutre'],
    injoignable: ['ne répond pas', 'ko'],
    refuse: ['jeton refusé', 'ko'],
    inactif: ['inactif', 'neutre']
  };

  const envoyer = (msg) => new Promise((resolve) => {
    try {
      const r = B.runtime.sendMessage(msg, (rep) => { void B.runtime.lastError; resolve(rep || null); });
      if (r && typeof r.then === 'function') r.then(resolve, () => resolve(null));
    } catch (e) { resolve(null); }
  });

  async function lirePrefs() {
    const st = await B.storage.local.get({ [CLE_PREFS]: null });
    return Object.assign({ positions: {}, masques: [], taille: null, opacite: OPACITE_DEFAUT }, st[CLE_PREFS] || {});
  }

  async function modifierPrefs(modifier) {
    const prefs = await lirePrefs();
    modifier(prefs);
    await B.storage.local.set({ [CLE_PREFS]: prefs });
  }

  const heure = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');

  function rendreLigneMaj(etat) {
    const ligne = $('mc-maj');
    // Masquée si Mes collections n'est pas configuré dans l'extension.
    ligne.hidden = !etat || (etat.etat === 'inactif' && /non configurée/.test(etat.raison || ''));
    const [libelle] = LIBELLES[etat?.etat] || [etat?.etat || ''];
    $('mc-maj-texte').textContent = `Mes collections : ${libelle}, liste du ${heure(etat?.derniereReponse)}`;
  }

  function rendreSection(cibles, etat, hote, prefs) {
    const [libelle, classe] = LIBELLES[etat.etat] || [etat.etat, 'neutre'];
    const pastille = $('mc-etat');
    pastille.textContent = libelle;
    pastille.className = 'mc-etat' + (classe ? ' ' + classe : '');
    $('mc-aide').textContent = etat.etat === 'anonyme'
      ? 'Connectez-vous pour poser une question. Les sources ouvertes à tous restent visibles dans la bulle.'
      : 'Cliquez sur la bulle « + IA » en bas à droite de la page pour interroger ces sources.';

    const liste = $('mc-cibles');
    liste.textContent = '';
    for (const c of cibles) {
      const li = document.createElement('li');
      li.append(c.titre);
      if (c.type === 'assistant') {
        const s = document.createElement('small');
        s.textContent = ' · assistant';
        li.append(s);
      }
      liste.append(li);
    }

    $('mc-afficher').checked = !prefs.masques.includes(hote);
    const pourcent = Math.round((Number(prefs.opacite) || OPACITE_DEFAUT) * 100);
    $('mc-opacite').value = String(pourcent);
    $('mc-opacite-valeur').textContent = pourcent + ' %';
  }

  async function actualiser() {
    let url = '';
    try {
      const [onglet] = await B.tabs.query({ active: true, currentWindow: true });
      url = (onglet && onglet.url) || '';
    } catch (e) { /* sans onglet actif */ }

    const rep = await envoyer({ type: 'mescollections:page', url });
    if (!rep || !rep.ok) { $('mc-maj').hidden = true; return; }
    rendreLigneMaj(rep.etat);

    const estVisio = MOTS_VISIO.some((k) => url.toLowerCase().includes(k));
    const pageDeclaree = rep.cibles.length > 0 && !estVisio;
    $('mc-section').hidden = !pageDeclaree;
    document.querySelectorAll('.conference').forEach((el) => el.classList.toggle('mc-cache', pageDeclaree));
    if (!pageDeclaree) return;

    let hote = '';
    try { hote = new URL(url).hostname; } catch (e) { /* adresse illisible */ }
    rendreSection(rep.cibles, rep.etat, hote, await lirePrefs());

    $('mc-afficher').onchange = (e) => modifierPrefs((p) => {
      p.masques = p.masques.filter((h) => h !== hote);
      if (!e.target.checked) p.masques.push(hote);
    });
    $('mc-opacite').oninput = (e) => {
      $('mc-opacite-valeur').textContent = e.target.value + ' %';
      modifierPrefs((p) => { p.opacite = Number(e.target.value) / 100; });
    };
  }

  document.addEventListener('DOMContentLoaded', () => {
    const bouton = $('mc-maj-btn');
    if (!bouton) return;
    bouton.addEventListener('click', async () => {
      bouton.disabled = true;
      bouton.textContent = 'Mise à jour…';
      await envoyer({ type: 'mescollections:reessayer' });
      await actualiser();
      bouton.textContent = 'Mettre à jour la liste';
      bouton.disabled = false;
    });
    actualiser();
  });
})();

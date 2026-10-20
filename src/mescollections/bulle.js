// mescollections/bulle.js — bulle « + IA » et panneau conversationnel, injectés par
// l'arrière-plan dans les onglets dont l'adresse correspond à un site déclaré dans
// Mes collections. Interface dans un Shadow DOM fermé, sans innerHTML : tout est créé
// par le DOM, le texte reçu ne devient jamais du balisage. Ne lit ni le contenu ni
// l'adresse de la page, sauf geste explicite (« Utiliser la sélection »).
// Mécanique du panneau reprise de la fenêtre DGEF (IA-Generative/dgef-eligibilite,
// demo/intranet/fenetre.js) : poignée, bornes, setPointerCapture, clavier, rendu Markdown.

(function () {
  if (globalThis.__mesCollectionsBulle) return;   // une seule instance par document
  globalThis.__mesCollectionsBulle = true;

  const B = (typeof browser !== 'undefined') ? browser : chrome;
  const CLE_PREFS = 'mescollectionsBulle';        // storage.local : positions, sites masqués, taille
  const HOTE = location.hostname;                 // clé de mémoire par site, jamais envoyée
  const LARGEUR_DEFAUT = 380, HAUTEUR_DEFAUT = 520, LARGEUR_MIN = 300, HAUTEUR_MIN = 320, MARGE = 16;
  const APPUI_LONG_MS = 600;
  const LIENS_VALIDES_MS = 12 * 3600 * 1000;      // durée des liens signés (contrat)

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .racine {
      --plein: #000091; --bleu: #000091; --bleu-clair: #e3e3fd; --fond: #fff; --fond-2: #f5f5fe; --texte: #161616;
      --texte-2: #3a3a3a; --bord: #c4c4c4; --lui: #f0f0f0; --alerte: #fff4f4; --rouge: #ce0500; --focus: #0a76f6;
      font-family: Marianne, system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.5; color: var(--texte);
    }
    @media (prefers-color-scheme: dark) {
      .racine {
        --plein: #1212a8; --bleu: #8585f6; --bleu-clair: #26265a; --fond: #1e1e1e; --fond-2: #262636; --texte: #eee;
        --texte-2: #ccc; --bord: #555; --lui: #2c2c2c; --alerte: #3a1f1f; --rouge: #ff6b6b;
      }
    }
    button, textarea, input { font: inherit; color: inherit; }
    :focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }

    .bulle {
      position: fixed; right: ${MARGE}px; z-index: 2147483646; width: 44px; height: 44px; border-radius: 50%;
      border: 0; padding: 0; display: flex; align-items: center; justify-content: center; gap: 1px;
      background: rgba(0, 0, 145, .7); color: #fff; font-weight: 700; font-size: 11px; white-space: nowrap; cursor: pointer;
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); box-shadow: 0 2px 8px rgba(0, 0, 0, .25);
      touch-action: none; user-select: none; transition: background-color .15s;
    }
    .bulle:hover, .bulle:focus-visible { background: rgb(0, 0, 145); }
    .bulle.anonyme { background: rgba(102, 102, 102, .7); }
    .bulle.anonyme:hover, .bulle.anonyme:focus-visible { background: rgb(102, 102, 102); }
    .bulle img { width: 12px; height: 12px; }
    .bulle[hidden], .panneau[hidden], .menu[hidden], [hidden] { display: none !important; }

    .menu { position: fixed; right: ${MARGE + 52}px; z-index: 2147483647; background: var(--fond); color: var(--texte);
      border: 1px solid var(--bord); border-radius: 6px; box-shadow: 0 4px 16px rgba(0, 0, 0, .25); padding: 4px; display: flex; flex-direction: column; }
    .menu button { background: none; border: 0; text-align: left; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
    .menu button:hover { background: var(--fond-2); }

    .panneau {
      position: fixed; right: ${MARGE}px; bottom: ${MARGE}px; z-index: 2147483647; display: flex; flex-direction: column;
      width: ${LARGEUR_DEFAUT}px; height: ${HAUTEUR_DEFAUT}px; max-width: calc(100vw - ${2 * MARGE}px); max-height: calc(100vh - ${2 * MARGE}px);
      background: var(--fond); border-radius: 10px; overflow: hidden; box-shadow: 0 12px 40px rgba(0, 0, 18, .35);
    }
    .poignee { position: absolute; top: 0; left: 0; width: 18px; height: 18px; cursor: nwse-resize; touch-action: none; z-index: 2; }
    .poignee::before { content: ""; position: absolute; top: 4px; left: 4px; width: 8px; height: 8px;
      border-top: 2px solid rgba(255, 255, 255, .8); border-left: 2px solid rgba(255, 255, 255, .8); opacity: .5; }
    .poignee:hover::before, .poignee:focus-visible::before, .redimensionne .poignee::before { opacity: 1; }
    .redimensionne, .redimensionne * { user-select: none; cursor: nwse-resize; }

    .tete { background: var(--plein); color: #fff; padding: 10px 12px 10px 22px; display: flex; align-items: center; gap: 8px; }
    .tete strong { flex: 1; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tete button { background: transparent; border: 1px solid rgba(255, 255, 255, .6); color: #fff; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 12px; }
    .tete button.reduire { border: 0; font-size: 20px; line-height: 1; }

    .cibles { margin: 0; padding: 8px 12px; border: 0; border-bottom: 1px solid var(--bleu-clair); background: var(--fond-2);
      display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .cibles legend { float: left; padding: 0; margin-right: 4px; font-size: 12px; color: var(--texte-2); }
    .puce { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border: 1px solid var(--bord); border-radius: 14px;
      background: var(--fond); font-size: 12.5px; cursor: pointer; }
    .puce input { margin: 0; accent-color: var(--bleu); cursor: pointer; }
    .puce:has(input:checked) { border-color: var(--bleu); background: var(--bleu-clair); }
    .puce small { color: var(--texte-2); }

    .fil { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
    .msg { max-width: 92%; padding: 8px 11px; border-radius: 10px; overflow-wrap: anywhere; }
    .msg.moi { align-self: flex-end; background: var(--plein); color: #fff; white-space: pre-wrap; border-bottom-right-radius: 2px; }
    .msg.lui { align-self: stretch; max-width: none; background: var(--lui); border-bottom-left-radius: 2px; }
    .msg.info { align-self: stretch; max-width: none; background: var(--fond-2); border-left: 4px solid var(--bleu); }
    .msg.alerte { align-self: stretch; max-width: none; background: var(--alerte); border-left: 4px solid var(--rouge); }
    .msg > * { margin: 0 0 8px; } .msg > *:last-child { margin-bottom: 0; }
    .msg a { color: var(--bleu); }
    .msg.moi a { color: #fff; }
    .msg .etiquette { font-size: 12px; font-weight: 700; color: var(--texte-2); }
    .msg .titre { font-weight: 700; font-size: 14.5px; }
    .msg ul, .msg ol { padding-left: 20px; }
    .msg code { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; background: var(--bord); padding: 0 3px; border-radius: 3px; }
    .msg blockquote { border-left: 3px solid var(--bord); padding-left: 10px; margin-left: 0; color: var(--texte-2); }
    .msg .cit { font-size: 11px; vertical-align: super; text-decoration: none; }
    .carte { background: var(--fond); border: 1px solid var(--bord); border-radius: 6px; padding: 7px 9px; }
    .carte strong { display: block; font-size: 13px; }
    .carte p { margin: 3px 0; font-size: 12.5px; color: var(--texte-2); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .carte .pied { display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--texte-2); }
    .carte a { font-weight: 700; }
    details.plan summary { cursor: pointer; font-size: 12.5px; font-weight: 700; color: var(--bleu); }
    details.plan ul, details.plan dl { font-size: 12.5px; margin: 4px 0 0; }
    details.plan dt { font-weight: 700; } details.plan dd { margin: 0 0 4px 10px; }
    .attente { align-self: flex-start; color: var(--texte-2); font-style: italic; }
    .bouton-lien { background: none; border: 0; padding: 0; color: var(--bleu); text-decoration: underline; cursor: pointer; }

    .saisie { border-top: 1px solid var(--bord); padding: 8px; display: flex; flex-direction: column; gap: 6px; background: var(--fond); }
    .saisie .ligne { display: flex; gap: 8px; }
    .saisie textarea { flex: 1; resize: none; height: 52px; padding: 7px; border: 1px solid var(--bord); border-radius: 4px; background: var(--fond); }
    .saisie button.envoyer { padding: 0 14px; border: 0; border-radius: 4px; background: var(--plein); color: #fff; font-weight: 700; cursor: pointer; }
    .saisie button:disabled { opacity: .5; cursor: default; }
    .saisie .selection { align-self: flex-start; font-size: 12px; }
    .connexion { padding: 10px 12px; border-top: 1px solid var(--bord); display: flex; gap: 10px; align-items: center; font-size: 13px; }
    .connexion button { padding: 5px 12px; border: 0; border-radius: 4px; background: var(--plein); color: #fff; font-weight: 700; cursor: pointer; }
  `;

  const el = (balise, attrs = {}, texte) => {
    const e = document.createElement(balise);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className' || k === 'type' || k === 'hidden' || k === 'title' || k === 'href' || k === 'target' || k === 'rel' || k === 'value' || k === 'name' || k === 'checked') e[k] = v;
      else e.setAttribute(k, v);
    }
    if (texte !== undefined) e.textContent = texte;
    return e;
  };
  const lien = (href, texte, className) => el('a', { href, target: '_blank', rel: 'noopener noreferrer', className: className || '' }, texte);
  const estHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u);
  const envoyerMessage = (msg) => new Promise((resolve) => {
    try {
      const r = B.runtime.sendMessage(msg, (rep) => { void (B.runtime.lastError); resolve(rep); });
      if (r && typeof r.then === 'function') r.then(resolve, () => resolve(null));
    } catch (e) { resolve(null); }
  });

  // ── Préférences (storage.local de l'extension, pas celui de la page) ──
  let prefs = { positions: {}, masques: [], taille: null };
  const lirePrefs = async () => {
    try {
      const st = await B.storage.local.get({ [CLE_PREFS]: null });
      prefs = Object.assign({ positions: {}, masques: [], taille: null }, st[CLE_PREFS] || {});
    } catch (e) { /* valeurs par défaut */ }
  };
  const garderPrefs = () => { try { B.storage.local.set({ [CLE_PREFS]: prefs }); } catch (e) { /* sans mémoire */ } };

  // ── État ─────────────────────────────────────────────────────────────
  let cibles = [];
  let etat = 'connecte';
  let occupe = false;
  let racineDom = null;
  let ui = null;

  // ── Construction ─────────────────────────────────────────────────────
  function habiller(racine) {
    // Feuille construite : non soumise à la CSP de la page. Firefox refuse l'affectation
    // depuis un content script (« Xray wrapper ») : repli sur un élément <style>.
    try {
      const f = new CSSStyleSheet();
      f.replaceSync(STYLE);
      racine.adoptedStyleSheets = [f];
      return;
    } catch (e) { /* repli ci-dessous */ }
    racine.append(el('style', {}, STYLE));
  }

  function construire() {
    const hote = document.createElement('mescollections-bulle');
    const ombre = hote.attachShadow({ mode: 'closed' });
    habiller(ombre);
    const racine = el('div', { className: 'racine' });
    ombre.append(racine);

    // Bulle
    const bulle = el('button', { type: 'button', className: 'bulle', 'aria-haspopup': 'dialog' });
    const icone = el('img', { alt: '' });
    icone.addEventListener('error', () => icone.remove());
    icone.src = B.runtime.getURL('icons/icon16.png');
    bulle.append(icone, document.createTextNode('+ IA'));

    // Menu « Masquer sur ce site »
    const menu = el('div', { className: 'menu', role: 'menu', hidden: true });
    const masquer = el('button', { type: 'button', role: 'menuitem' }, 'Masquer sur ce site');
    const annuler = el('button', { type: 'button', role: 'menuitem' }, 'Annuler');
    menu.append(masquer, annuler);

    // Panneau
    const panneau = el('section', { className: 'panneau', role: 'dialog', 'aria-label': 'Mes collections', hidden: true });
    const poignee = el('div', { className: 'poignee', role: 'separator', tabindex: '0', title: 'Tirer pour agrandir (double-clic : taille maximale, ou retour)', 'aria-label': 'Taille de la fenêtre' });
    const tete = el('div', { className: 'tete' });
    const titre = el('strong', {}, 'Mes collections');
    const effacer = el('button', { type: 'button', title: 'Nouvelle conversation' }, 'Effacer');
    const reduire = el('button', { type: 'button', className: 'reduire', title: 'Réduire', 'aria-label': 'Réduire la fenêtre' }, '×');
    tete.append(titre, effacer, reduire);
    const choix = el('fieldset', { className: 'cibles' });
    const fil = el('div', { className: 'fil', 'aria-live': 'polite' });
    const saisie = el('form', { className: 'saisie' });
    const ligne = el('div', { className: 'ligne' });
    const champ = el('textarea', { 'aria-label': 'Votre question', placeholder: 'Votre question…' });
    const envoyer = el('button', { type: 'submit', className: 'envoyer' }, 'Envoyer');
    ligne.append(champ, envoyer);
    const selection = el('button', { type: 'button', className: 'bouton-lien selection', hidden: true }, 'Utiliser la sélection');
    saisie.append(ligne, selection);
    const connexion = el('div', { className: 'connexion', hidden: true });
    const seConnecter = el('button', { type: 'button' }, 'Se connecter');
    connexion.append(el('span', {}, 'Connectez-vous pour poser une question.'), seConnecter);
    panneau.append(poignee, tete, choix, fil, saisie, connexion);

    racine.append(bulle, menu, panneau);
    (document.body || document.documentElement).append(hote);
    racineDom = hote;
    ui = { bulle, menu, masquer, annuler, panneau, poignee, titre, effacer, reduire, choix, fil, saisie, champ, envoyer, selection, connexion, seConnecter };
    brancher();
  }

  // ── Bulle : clic, glisser vertical, appui long, menu ─────────────────
  function placerBulle() {
    const bas = prefs.positions[HOTE];
    const max = window.innerHeight - 44 - MARGE;
    ui.bulle.style.bottom = Math.max(MARGE, Math.min(max, typeof bas === 'number' ? bas : MARGE)) + 'px';
  }

  function ouvrirMenu() {
    ui.menu.style.bottom = ui.bulle.style.bottom;
    ui.menu.hidden = false;
    ui.masquer.focus();
  }

  function brancher() {
    const { bulle, menu, masquer, annuler, panneau, poignee, effacer, reduire, saisie, champ, selection, seConnecter } = ui;
    let prise = null, appui = null;

    bulle.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      prise = { y0: e.clientY, bas0: parseFloat(bulle.style.bottom) || MARGE, bouge: false };
      appui = setTimeout(() => { appui = null; if (prise && !prise.bouge) { prise = null; ouvrirMenu(); } }, APPUI_LONG_MS);
      try { bulle.setPointerCapture(e.pointerId); } catch (err) { /* pointeur relâché */ }
    });
    bulle.addEventListener('pointermove', (e) => {
      if (!prise) return;
      const dy = prise.y0 - e.clientY;
      if (!prise.bouge && Math.abs(dy) < 5) return;
      prise.bouge = true;
      clearTimeout(appui);
      prefs.positions[HOTE] = prise.bas0 + dy;
      placerBulle();
    });
    const lacher = () => {
      clearTimeout(appui);
      if (!prise) return;
      const p = prise;
      prise = null;
      if (p.bouge) garderPrefs();
      else ouvrir(true);
    };
    bulle.addEventListener('pointerup', lacher);
    bulle.addEventListener('pointercancel', () => { clearTimeout(appui); prise = null; });
    bulle.addEventListener('keydown', (e) => {   // clavier : Entrée/Espace ouvrent (clic natif), menu par Maj+F10
      if (e.key === 'F10' && e.shiftKey) { e.preventDefault(); ouvrirMenu(); }
    });
    bulle.addEventListener('click', (e) => { if (e.detail === 0) ouvrir(true); });   // activation clavier
    bulle.addEventListener('contextmenu', (e) => { e.preventDefault(); ouvrirMenu(); });

    masquer.addEventListener('click', () => {
      if (!prefs.masques.includes(HOTE)) prefs.masques.push(HOTE);
      garderPrefs();
      menu.hidden = true;
      retirer();
    });
    annuler.addEventListener('click', () => { menu.hidden = true; bulle.focus(); });
    menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { menu.hidden = true; bulle.focus(); } });

    reduire.addEventListener('click', () => ouvrir(false));
    panneau.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); ouvrir(false); } });
    effacer.addEventListener('click', async () => {
      await envoyerMessage({ type: 'mescollections:effacer' });
      ui.fil.textContent = '';
      accueil();
      champ.focus();
    });

    saisie.addEventListener('submit', (e) => { e.preventDefault(); poser(); });
    champ.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); poser(); }
    });

    // « Utiliser la sélection » : visible si du texte est sélectionné hors de la bulle ;
    // le texte n'est lu qu'au clic.
    document.addEventListener('selectionchange', () => {
      const s = document.getSelection();
      selection.hidden = !s || s.isCollapsed || (racineDom && racineDom.contains(s.anchorNode));
    });
    selection.addEventListener('click', () => {
      const s = document.getSelection();
      const t = s ? s.toString().trim().slice(0, 4000) : '';
      if (t) { champ.value = t; champ.focus(); }
    });

    seConnecter.addEventListener('click', () => envoyerMessage({ type: 'overlay:pkceLogin' }));

    brancherPoignee();
  }

  // ── Panneau : ouverture, taille, poignée du coin haut gauche ─────────
  const bornes = () => ({
    lMax: Math.max(LARGEUR_MIN, window.innerWidth - 2 * MARGE),
    hMax: Math.max(HAUTEUR_MIN, window.innerHeight - 2 * MARGE)
  });

  function dimensionner(l, h, memoriser = true) {
    const { lMax, hMax } = bornes();
    const largeur = Math.round(Math.min(lMax, Math.max(LARGEUR_MIN, l)));
    const hauteur = Math.round(Math.min(hMax, Math.max(HAUTEUR_MIN, h)));
    ui.panneau.style.width = largeur + 'px';
    ui.panneau.style.height = hauteur + 'px';
    ui.poignee.setAttribute('aria-valuetext', `${largeur} × ${hauteur} pixels`);
    if (memoriser) { prefs.taille = { l: largeur, h: hauteur }; garderPrefs(); }
  }

  const tailleActuelle = () => {
    const r = ui.panneau.getBoundingClientRect();
    return { l: r.width || LARGEUR_DEFAUT, h: r.height || HAUTEUR_DEFAUT };
  };

  function brancherPoignee() {
    const { poignee, panneau } = ui;
    let prise = null;
    poignee.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      const t = tailleActuelle();
      prise = { x0: e.clientX, y0: e.clientY, l0: t.l, h0: t.h };
      panneau.classList.add('redimensionne');
      try { poignee.setPointerCapture(e.pointerId); } catch (err) { /* pointeur relâché */ }
      e.preventDefault();
    });
    poignee.addEventListener('pointermove', (e) => {
      if (prise) dimensionner(prise.l0 + (prise.x0 - e.clientX), prise.h0 + (prise.y0 - e.clientY), false);
    });
    const lacher = () => {
      if (!prise) return;
      prise = null;
      panneau.classList.remove('redimensionne');
      const t = tailleActuelle();
      dimensionner(t.l, t.h);
    };
    poignee.addEventListener('pointerup', lacher);
    poignee.addEventListener('pointercancel', lacher);
    poignee.addEventListener('dblclick', () => {
      const { lMax, hMax } = bornes();
      const t = tailleActuelle();
      const auMax = t.l >= lMax - 1 && t.h >= hMax - 1;
      dimensionner(auMax ? LARGEUR_DEFAUT : lMax, auMax ? HAUTEUR_DEFAUT : hMax);
    });
    // Clavier : flèches haut/bas (hauteur), gauche/droite (largeur, gauche agrandit),
    // Maj = par 100 px ; Origine = taille minimale, Fin = taille maximale.
    poignee.addEventListener('keydown', (e) => {
      const pas = e.shiftKey ? 100 : 20;
      const t = tailleActuelle();
      const { lMax, hMax } = bornes();
      let l = t.l, h = t.h;
      if (e.key === 'ArrowUp') h += pas;
      else if (e.key === 'ArrowDown') h -= pas;
      else if (e.key === 'ArrowLeft') l += pas;
      else if (e.key === 'ArrowRight') l -= pas;
      else if (e.key === 'Home') { l = LARGEUR_MIN; h = HAUTEUR_MIN; }
      else if (e.key === 'End') { l = lMax; h = hMax; }
      else return;
      e.preventDefault();
      dimensionner(l, h);
    });
  }

  async function ouvrir(oui) {
    ui.menu.hidden = true;
    ui.panneau.hidden = !oui;
    ui.bulle.hidden = oui;
    if (oui) {
      if (prefs.taille) dimensionner(prefs.taille.l, prefs.taille.h, false);
      await chargerConversation();
      (etat === 'anonyme' ? ui.seConnecter : ui.champ).focus();
    } else {
      ui.bulle.focus();
    }
  }

  // ── Cibles ───────────────────────────────────────────────────────────
  const cle = (c) => c.type + ':' + c.id;
  const cochees = () => [...ui.choix.querySelectorAll('input:checked')].map((i) => cibles.find((c) => cle(c) === i.value)).filter(Boolean);

  function rendreCibles() {
    const avant = new Set([...ui.choix.querySelectorAll('input:checked')].map((i) => i.value));
    ui.choix.textContent = '';
    ui.choix.append(el('legend', {}, 'Chercher dans :'));
    for (const c of cibles) {
      const puce = el('label', { className: 'puce' });
      const coche = el('input', { type: 'checkbox', value: cle(c), checked: avant.size ? avant.has(cle(c)) : true });
      coche.addEventListener('change', () => {
        if (!cochees().length) coche.checked = true;   // au moins une cible cochée
        majTitre();
      });
      puce.append(coche, el('span', {}, c.titre), el('small', {}, c.type === 'assistant' ? ' · assistant' : ''));
      ui.choix.append(puce);
    }
    if (!cochees().length) {
      const premiere = ui.choix.querySelector('input');
      if (premiere) premiere.checked = true;
    }
    majTitre();
  }

  function majTitre() {
    const c = cochees();
    ui.titre.textContent = c.length === 1 ? c[0].titre : c.length > 1 ? `${c.length} sources` : 'Mes collections';
  }

  function retirerCible(c) {
    cibles = cibles.filter((x) => cle(x) !== cle(c));
    if (!cibles.length) { retirer(); return; }
    rendreCibles();
  }

  // ── Fil : rendu Markdown sans innerHTML ──────────────────────────────
  // Repris de la fenêtre DGEF : titres, gras, italique, code, listes, citations, liens https ;
  // « [n] » devient un appel de note vers le passage n quand il a une adresse https.
  function enLigne(parent, texte, passages) {
    const motif = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(\*[^*\s][^*]*?\*)|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)|(https:\/\/[^\s)\]<>]+)|\[(\d+)\]/g;
    let fin = 0, m;
    while ((m = motif.exec(texte))) {
      if (m.index > fin) parent.append(texte.slice(fin, m.index));
      fin = motif.lastIndex;
      if (m[1]) parent.append(el('code', {}, m[1].slice(1, -1)));
      else if (m[2]) { const b = el('strong'); enLigne(b, m[2].slice(2, -2), passages); parent.append(b); }
      else if (m[3]) { const i = el('em'); enLigne(i, m[3].slice(1, -1), passages); parent.append(i); }
      else if (m[5]) parent.append(lien(m[5], m[4]));
      else if (m[6]) {
        const url = m[6].replace(/[.,;:!?]+$/, '');
        parent.append(lien(url, url));
        fin -= m[6].length - url.length;
        motif.lastIndex = fin;
      } else if (m[7]) {
        const p = passages && passages[Number(m[7]) - 1];
        if (p && estHttps(p.url)) { const a = lien(p.url, `[${m[7]}]`, 'cit'); a.title = p.titre || ''; parent.append(a); }
        else parent.append(m[0]);
      }
    }
    if (fin < texte.length) parent.append(texte.slice(fin));
  }

  const RE_LISTE = /^\s*([-*+]|\d+[.)])\s+(.*)$/, RE_TITRE = /^(#{1,6})\s+(.*?)\s*#*$/;
  function markdown(bloc, brut, passages) {
    const lignes = String(brut).replace(/\r/g, '').split('\n');
    const debut = (i) => !lignes[i].trim() || RE_TITRE.test(lignes[i]) || RE_LISTE.test(lignes[i]) || /^\s*>/.test(lignes[i]);
    let i = 0;
    while (i < lignes.length) {
      const ligne = lignes[i];
      if (!ligne.trim()) { i++; continue; }
      const titre = ligne.match(RE_TITRE);
      if (titre) { const t = el('p', { className: 'titre' }); enLigne(t, titre[2], passages); bloc.append(t); i++; continue; }
      if (RE_LISTE.test(ligne)) {
        const liste = el(/^\s*\d/.test(ligne) ? 'ol' : 'ul');
        while (i < lignes.length && RE_LISTE.test(lignes[i])) {
          const li = el('li');
          enLigne(li, lignes[i].match(RE_LISTE)[2], passages);
          liste.append(li);
          i++;
        }
        bloc.append(liste);
        continue;
      }
      if (/^\s*>/.test(ligne)) {
        const contenu = [];
        while (i < lignes.length && /^\s*>/.test(lignes[i])) contenu.push(lignes[i++].replace(/^\s*>\s?/, ''));
        const q = el('blockquote');
        enLigne(q, contenu.join(' '), passages);
        bloc.append(q);
        continue;
      }
      const p = el('p');
      let premier = true;
      while (i < lignes.length && (premier || !debut(i))) {
        if (!premier) p.append(el('br'));
        enLigne(p, lignes[i++].trim(), passages);
        premier = false;
      }
      bloc.append(p);
    }
  }

  // Le plan d'un assistant : rendu générique (texte, liste, ou paires clé/valeur).
  function rendrePlan(parent, plan) {
    if (plan === null || plan === undefined) return;
    if (typeof plan === 'string') { parent.append(el('p', {}, plan)); return; }
    if (Array.isArray(plan)) {
      const ul = el('ul');
      for (const x of plan) {
        const li = el('li');
        if (x && typeof x === 'object') rendrePlan(li, x);
        else li.textContent = String(x);
        ul.append(li);
      }
      parent.append(ul);
      return;
    }
    if (typeof plan === 'object') {
      const dl = el('dl');
      for (const [k, v] of Object.entries(plan)) {
        dl.append(el('dt', {}, k));
        const dd = el('dd');
        if (v && typeof v === 'object') rendrePlan(dd, v);
        else dd.textContent = String(v);
        dl.append(dd);
      }
      parent.append(dl);
      return;
    }
    parent.append(el('p', {}, String(plan)));
  }

  function carte(p) {
    const c = el('div', { className: 'carte' });
    if (p.titre) c.append(el('strong', {}, p.titre));
    if (p.texte) c.append(el('p', {}, p.texte));
    const pied = el('div', { className: 'pied' });
    pied.append(el('span', {}, p.source || ''));
    if (estHttps(p.url)) pied.append(lien(p.url, 'Ouvrir ↗'));
    c.append(pied);
    return c;
  }

  function rendreBloc(bloc, plusieurs, t) {
    const m = el('div', { className: bloc.erreur ? 'msg alerte' : 'msg lui' });
    if (plusieurs) m.append(el('div', { className: 'etiquette' }, bloc.cibles.map((c) => c.titre).join(', ')));
    if (bloc.erreur) {
      m.append(el('p', {}, bloc.erreur.message));
      if (bloc.erreur.retirer) bloc.cibles.forEach(retirerCible);
      return m;
    }
    const passages = bloc.passages || [];
    if (bloc.reponse) {
      const r = el('div');
      markdown(r, bloc.reponse, passages);
      m.append(r);
    }
    if (passages.length) {
      if (bloc.reponse) m.append(el('div', { className: 'etiquette' }, 'Sources'));
      passages.forEach((p) => m.append(carte(p)));
      if (t && Date.now() - t > LIENS_VALIDES_MS) {
        m.append(el('p', { className: 'etiquette' }, 'Ces liens ont expiré : reposez la question pour en obtenir de nouveaux.'));
      }
    }
    if (!bloc.reponse && !passages.length) m.append(el('p', {}, 'Rien de pertinent trouvé dans cette source.'));
    if (bloc.plan) {
      const d = el('details', { className: 'plan' });
      d.append(el('summary', {}, 'Comment l\'assistant a cherché'));
      rendrePlan(d, bloc.plan);
      m.append(d);
    }
    return m;
  }

  function rendreEchange(echange) {
    ui.fil.append(el('div', { className: 'msg moi' }, echange.question));
    const plusieurs = echange.blocs.length > 1;
    for (const b of echange.blocs) ui.fil.append(rendreBloc(b, plusieurs, echange.t));
  }

  function accueil() {
    const texte = etat === 'anonyme'
      ? 'Mode anonyme : vous voyez les sources ouvertes à tous pour cette page. Connectez-vous pour poser une question.'
      : 'Posez une question : la réponse cite les passages trouvés dans les sources cochées, selon vos droits.';
    ui.fil.append(el('div', { className: 'msg info' }, texte));
  }

  async function chargerConversation() {
    const r = await envoyerMessage({ type: 'mescollections:conversation' });
    ui.fil.textContent = '';
    accueil();
    for (const e of (r && r.conversation) || []) rendreEchange(e);
    ui.fil.scrollTop = ui.fil.scrollHeight;
  }

  async function poser() {
    const question = ui.champ.value.trim();
    if (!question || occupe || etat !== 'connecte') return;
    occupe = true;
    ui.envoyer.disabled = true;
    ui.champ.value = '';
    const attente = el('div', { className: 'attente' }, 'Recherche en cours…');
    ui.fil.append(el('div', { className: 'msg moi' }, question), attente);
    ui.fil.scrollTop = ui.fil.scrollHeight;
    const r = await envoyerMessage({ type: 'mescollections:demander', cibles: cochees().map((c) => ({ type: c.type, id: c.id })), question });
    attente.remove();
    if (r && r.ok) {
      const plusieurs = r.echange.blocs.length > 1;
      for (const b of r.echange.blocs) ui.fil.append(rendreBloc(b, plusieurs, r.echange.t));
    } else {
      const m = el('div', { className: 'msg alerte' });
      m.append(el('p', {}, (r && r.erreur && r.erreur.message) || 'L\'extension ne répond pas. Réessayez dans un instant.'));
      ui.fil.append(m);
    }
    ui.fil.scrollTop = ui.fil.scrollHeight;
    occupe = false;
    ui.envoyer.disabled = false;
    ui.champ.focus();
  }

  // ── Afficher / retirer (messages de l'arrière-plan) ──────────────────
  async function afficher(nouvelles, nouvelEtat) {
    await lirePrefs();
    if (prefs.masques.includes(HOTE)) return;
    if (!ui) construire();
    cibles = nouvelles;
    etat = nouvelEtat;
    ui.bulle.classList.toggle('anonyme', etat === 'anonyme');
    const libelle = (etat === 'anonyme' ? 'Mes collections (mode anonyme) : ' : 'Mes collections : ') + cibles.map((c) => c.titre).join(', ');
    ui.bulle.title = libelle;
    ui.bulle.setAttribute('aria-label', libelle);
    ui.saisie.hidden = etat === 'anonyme';
    ui.connexion.hidden = etat !== 'anonyme';
    placerBulle();
    rendreCibles();
  }

  function retirer() {
    if (racineDom) racineDom.remove();
    racineDom = null;
    ui = null;
  }

  B.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'mescollections:afficher' && Array.isArray(msg.cibles)) afficher(msg.cibles, msg.etat);
    else if (msg?.type === 'mescollections:retirer') retirer();
  });
})();

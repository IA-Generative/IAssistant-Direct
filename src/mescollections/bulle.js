// mescollections/bulle.js — bulle « + IA » injectée par l'arrière-plan dans les onglets
// dont l'adresse correspond à un site déclaré dans Mes collections.
// Interface dans un Shadow DOM fermé, sans innerHTML. Ne lit ni le contenu ni l'adresse
// de la page : les cibles arrivent de l'arrière-plan.
// Phase 2 : simple marqueur ; le panneau conversationnel arrive en phase 3.

(function () {
  if (globalThis.__mesCollectionsBulle) return;   // une seule instance par document
  globalThis.__mesCollectionsBulle = true;

  const B = (typeof browser !== 'undefined') ? browser : chrome;

  const STYLE = `
    :host { all: initial; }
    .bulle {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
      width: 44px; height: 44px; border-radius: 50%; border: 0; padding: 0;
      background: rgba(0, 0, 145, .7); color: #fff;
      font: 600 13px/1 system-ui, sans-serif; cursor: pointer;
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
      box-shadow: 0 2px 8px rgba(0, 0, 0, .25);
      transition: background-color .15s;
    }
    .bulle:hover, .bulle:focus-visible { background: rgb(0, 0, 145); outline: 2px solid #fff; outline-offset: -4px; }
    .bulle.anonyme { background: rgba(102, 102, 102, .7); }
    .bulle.anonyme:hover, .bulle.anonyme:focus-visible { background: rgb(102, 102, 102); }
  `;

  let hote = null;
  let bouton = null;

  // Feuille construite (adoptedStyleSheets) : non soumise à la CSP de la page. Firefox refuse
  // l'affectation depuis un content script (« Xray wrapper ») : repli sur un élément <style>.
  function habiller(racine) {
    try {
      const f = new CSSStyleSheet();
      f.replaceSync(STYLE);
      racine.adoptedStyleSheets = [f];
      return;
    } catch (e) { /* repli ci-dessous */ }
    const s = document.createElement('style');
    s.textContent = STYLE;
    racine.append(s);
  }

  function creer() {
    const h = document.createElement('mescollections-bulle');
    const racine = h.attachShadow({ mode: 'closed' });
    habiller(racine);

    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bulle';
    b.textContent = '+ IA';
    racine.append(b);
    (document.body || document.documentElement).append(h);
    hote = h;
    bouton = b;
  }

  function afficher(cibles, etat) {
    if (!hote) creer();
    const titres = cibles.map((c) => c.titre).join(', ');
    bouton.classList.toggle('anonyme', etat === 'anonyme');
    bouton.title = (etat === 'anonyme' ? 'Mes collections (mode anonyme) : ' : 'Mes collections : ') + titres;
    bouton.setAttribute('aria-label', bouton.title);
  }

  function retirer() {
    if (hote) hote.remove();
    hote = null;
    bouton = null;
  }

  B.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'mescollections:afficher' && Array.isArray(msg.cibles)) afficher(msg.cibles, msg.etat);
    else if (msg?.type === 'mescollections:retirer') retirer();
  });
})();

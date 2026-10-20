// scenarios.mjs — scénarios de recette de la bulle « + IA », communs à Chrome et Firefox.
// Chaque pilote (chrome.mjs, firefox.mjs) fournit les primitives ; ce fichier dit quoi
// vérifier. Pages d'essai : example.org (déclarée dans la doublure d'essai) et example.com
// (non déclarée). Le jeton est FACTICE, stocké dans un profil jetable : la doublure ne le
// vérifie pas, aucun service réel n'est appelé.

export const PAGE_DECLAREE = 'https://example.org/';
export const PAGE_AUTRE = 'https://example.com/';

const JETON_FACTICE = `TokenStore.storeToken({access_token:'jeton-factice-recette',refresh_token:'',expires_in:Date.now()+3600e3})`;

/**
 * @param {object} p primitives du navigateur :
 *   options(expr) → valeur, évaluée dans la page d'options de l'extension ;
 *   aller(url), page(expr) → valeur, clic(x, y), taper(texte), entree(), echap(),
 *   glisser(x0, y0, x1, y1), capture(nom), taille() → [largeur, hauteur]
 * @param {string} api 'chrome' ou 'browser' (espace de noms des API d'extension)
 */
export async function jouer(p, api) {
  const resultats = [];
  const verifier = (nom, ok, detail = '') => {
    resultats.push({ nom, ok });
    console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${nom}${detail ? ' — ' + detail : ''}`);
  };
  const preparer = async (mode, jeton) => {
    const j = jeton ? JETON_FACTICE : 'TokenStore.clearToken()';
    return p.options(`${j}.then(()=>${api}.storage.local.set({mescollectionsDoublure:${JSON.stringify(mode)}}))`
      + `.then(()=>${api}.runtime.sendMessage({type:'mescollections:reessayer'})).then(r=>r.etat.etat)`);
  };
  const bulle = async (url) => { await p.aller(url); return p.page(`!!document.querySelector('mescollections-bulle')`); };

  // 1. Détection
  verifier('anonyme : état', (await preparer('anonyme', false)) === 'anonyme');
  verifier('anonyme : bulle sur la page déclarée', (await bulle(PAGE_DECLAREE)) === true);
  await p.capture('1-bulle-anonyme.png');
  verifier('anonyme : pas de bulle ailleurs', (await bulle(PAGE_AUTRE)) === false);

  // 2. Inerte si Mes collections ne répond pas, retour automatique
  verifier('panne : état injoignable', (await preparer('panne', false)) === 'injoignable');
  verifier('panne : aucune bulle', (await bulle(PAGE_DECLAREE)) === false);
  const prochaine = await p.options(`${api}.runtime.sendMessage({type:'mescollections:etat'}).then(r=>r.etat.prochaineTentative-Date.now())`);
  verifier('panne : nouvelle tentative planifiée', prochaine > 0 && prochaine <= 2 * 60000, `${Math.round(prochaine / 1000)} s`);
  await preparer('anonyme', false);
  verifier('retour du service : bulle revenue', (await bulle(PAGE_DECLAREE)) === true);

  // 3. Jeton refusé, anonyme fermé
  verifier('jeton refusé : état refuse', (await preparer('refuse', true)) === 'refuse');
  verifier('jeton refusé : aucune bulle', (await bulle(PAGE_DECLAREE)) === false);
  verifier('anonyme fermé : état inactif', (await preparer('normal', false)) === 'inactif');

  // 4. Panneau connecté : question, réponse, redimensionnement, Échap
  verifier('connecté : état', (await preparer('normal', true)) === 'connecte');
  verifier('connecté : bulle', (await bulle(PAGE_DECLAREE)) === true);
  const [L, H] = await p.taille();
  await p.clic(L - 38, H - 38);
  await p.pause(800);
  await p.taper('Quelle est la durée du titre de séjour ?');
  await p.entree();
  await p.pause(1500);
  await p.capture('2-reponse.png');
  const echanges = await p.options(`${api}.storage.session.get(null).then(s=>Object.entries(s).filter(([k])=>k.startsWith('mescollectionsConversation:')).map(([,v])=>v.length).reduce((a,b)=>a+b,0))`);
  verifier('question posée et conversation gardée pour l\'onglet', echanges === 1, `${echanges} échange(s)`);
  await p.aller(PAGE_DECLAREE);   // retour sur la page de l'onglet de test
  await p.clic(L - 38, H - 38);
  await p.pause(800);
  const x0 = L - 16 - 380 + 8, y0 = H - 16 - 520 + 8;
  await p.glisser(x0, y0, x0 - 150, y0 - 100);
  await p.pause(500);
  await p.capture('3-agrandi.png');
  const taille = await p.options(`${api}.storage.local.get('mescollectionsBulle').then(x=>x.mescollectionsBulle&&x.mescollectionsBulle.taille)`);
  verifier('redimensionnement par le coin, taille mémorisée', !!taille && taille.l > 380 && taille.h > 520, JSON.stringify(taille));
  await p.echap();
  await p.pause(300);
  await p.capture('4-reduit.png');

  // 5. Déconnexion : la conversation est effacée
  await preparer('anonyme', false);
  const restants = await p.options(`${api}.storage.session.get(null).then(s=>Object.keys(s).filter(k=>k.startsWith('mescollectionsConversation:')).length)`);
  verifier('déconnexion : conversations effacées', restants === 0, `${restants} restante(s)`);

  const echecs = resultats.filter((r) => !r.ok).length;
  console.log(`\n${resultats.length - echecs}/${resultats.length} vérifications passées.`);
  return echecs;
}

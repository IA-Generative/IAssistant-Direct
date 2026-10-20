// tests/mescollections-bulle.test.js — rendu du panneau (jsdom, Shadow DOM ouvert pour l'inspection)

const fs = require('fs');
const path = require('path');

const PLAN = {
  assistant: 'sejour', version: 1, planificateur: 'regles', consigne: 'titre-de-sejour', score_consigne: 0.82,
  reponse_fiable: null,
  etapes: [
    { n: 1, source: 'ceseda', question: 'durée', poids: 1, attend: [], avec: null },
    { n: 2, source: 'crpa', question: 'recours', poids: 0.5, attend: [1], avec: null }
  ],
  sources_ignorees: 2, a_valider: false
};
const ECHANGE = {
  question: 'Quelle durée ?',
  t: Date.now(),
  blocs: [{
    type: 'assistant', cibles: [{ type: 'assistant', id: 'sejour', titre: 'Séjour' }],
    reponse: 'Voir [1] <b>tel quel</b>',
    passages: [
      { titre: 'Art. 1', texte: 'Extrait', url: 'https://x.fake-domain.name/1', source: 'ceseda', etape: 1 },
      { titre: 'Art. 2', texte: 'Extrait', url: 'https://x.fake-domain.name/2', source: 'ceseda', etape: 1 }
    ],
    plan: PLAN
  }]
};

let racine, surMessage;
const attachShadow = Element.prototype.attachShadow;

beforeAll(() => {
  Element.prototype.attachShadow = function () { racine = attachShadow.call(this, { mode: 'open' }); return racine; };
});
afterAll(() => { Element.prototype.attachShadow = attachShadow; });

beforeEach(() => {
  __resetChromeStorage();
  delete globalThis.__mesCollectionsBulle;
  document.body.textContent = '';
  chrome.runtime.onMessage.addListener.mockClear();
  chrome.runtime.sendMessage = jest.fn((msg, cb) => {
    const rep = msg.type === 'mescollections:conversation' ? { ok: true, conversation: [ECHANGE] } : { ok: true };
    if (cb) cb(rep);
    return undefined;
  });
  eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'mescollections', 'bulle.js'), 'utf8'));
  surMessage = chrome.runtime.onMessage.addListener.mock.calls[0][0];
});

const attendre = () => new Promise((r) => setTimeout(r, 0));
const CIBLES = [{ type: 'assistant', id: 'sejour', titre: 'Séjour' }, { type: 'collection', id: 'ceseda', titre: 'CESEDA' }];

async function ouvrir(etat = 'connecte') {
  surMessage({ type: 'mescollections:afficher', cibles: CIBLES, etat });
  await attendre();
  racine.querySelector('.bulle').dispatchEvent(new MouseEvent('click', { detail: 0, bubbles: true }));
  await attendre();
}

test('une seule bulle par document, retirée sur demande', async () => {
  surMessage({ type: 'mescollections:afficher', cibles: CIBLES, etat: 'connecte' });
  await attendre();
  expect(document.querySelectorAll('mescollections-bulle')).toHaveLength(1);
  surMessage({ type: 'mescollections:retirer' });
  expect(document.querySelector('mescollections-bulle')).toBeNull();
});

test('plan rendu selon le contrat : consigne, étapes, sources ignorées comptées', async () => {
  await ouvrir();
  const plan = racine.querySelector('details.plan').textContent;
  expect(plan).toContain('Consigne retenue : titre-de-sejour (ressemblance 82 %)');
  expect(plan).toContain('Étape 1 : CESEDA — 2 passages');
  expect(plan).toContain('Étape 2 : crpa — 0 passage — après les étapes 1 (à partir de ce qu\'elles ont trouvé)');
  expect(plan).toContain('2 sources non interrogées');
});

test('réponse en texte simple : ni balise interprétée, ni crochets transformés', async () => {
  await ouvrir();
  const r = racine.querySelector('.reponse');
  expect(r.textContent).toBe('Voir [1] <b>tel quel</b>');
  expect(r.querySelector('b, a')).toBeNull();
});

test('passages en cartes avec lien « Ouvrir » https', async () => {
  await ouvrir();
  const liens = [...racine.querySelectorAll('.carte a')];
  expect(liens.map((a) => a.href)).toEqual(['https://x.fake-domain.name/1', 'https://x.fake-domain.name/2']);
  expect(liens.every((a) => a.rel.includes('noopener'))).toBe(true);
});

test('mode anonyme : pas de saisie, bouton de connexion', async () => {
  await ouvrir('anonyme');
  expect(racine.querySelector('.saisie').hidden).toBe(true);
  expect(racine.querySelector('.connexion').hidden).toBe(false);
});

test('site masqué : aucune bulle', async () => {
  __seedChromeStorage({ mescollectionsBulle: { masques: [location.hostname], positions: {}, taille: null } });
  surMessage({ type: 'mescollections:afficher', cibles: CIBLES, etat: 'connecte' });
  await attendre();
  expect(document.querySelector('mescollections-bulle')).toBeNull();
});

test('aucun innerHTML dans le code de la bulle', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'mescollections', 'bulle.js'), 'utf8');
  expect(code).not.toMatch(/\.innerHTML|insertAdjacentHTML|outerHTML\s*=/);
});

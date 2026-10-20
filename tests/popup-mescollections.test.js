// tests/popup-mescollections.test.js — Mes collections dans le popup

const fs = require('fs');
const path = require('path');

const DOM = `
  <div class="rec-row conference" id="rec"></div>
  <div class="tabs-block conference" id="onglets"></div>
  <section id="mc-section" hidden>
    <span id="mc-etat"></span><p id="mc-aide"></p><ul id="mc-cibles"></ul>
    <input type="checkbox" id="mc-afficher">
    <input type="range" id="mc-opacite" min="10" max="100"><span id="mc-opacite-valeur"></span>
  </section>
  <div id="mc-maj" hidden><span id="mc-maj-texte"></span><button id="mc-maj-btn">Mettre à jour la liste</button></div>`;

const CIBLES = [{ type: 'collection', id: 'c1', titre: 'Guerre de Cent Ans' }, { type: 'assistant', id: 'a1', titre: 'Historien' }];
const ETAT = { etat: 'connecte', raison: '', derniereReponse: Date.now() };
let reponses;

async function charger(url) {
  document.body.innerHTML = DOM;
  chrome.tabs.query = jest.fn(async () => [{ url }]);
  chrome.runtime.sendMessage = jest.fn((msg, cb) => { cb(reponses[msg.type] || null); return undefined; });
  eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'popup-mescollections.js'), 'utf8'));
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}
const $ = (id) => document.getElementById(id);

beforeEach(() => {
  __resetChromeStorage();
  reponses = {
    'mescollections:page': { ok: true, cibles: CIBLES, etat: ETAT },
    'mescollections:reessayer': { ok: true, etat: ETAT }
  };
});

test('page déclarée, pas une visio : conférence masquée, sources et réglages affichés', async () => {
  await charger('https://fr.wikipedia.org/wiki/Guerre_de_Cent_Ans');
  expect($('mc-section').hidden).toBe(false);
  expect($('rec').classList.contains('mc-cache')).toBe(true);
  expect($('onglets').classList.contains('mc-cache')).toBe(true);
  expect($('mc-cibles').textContent).toContain('Guerre de Cent Ans');
  expect($('mc-cibles').textContent).toContain('assistant');
  expect($('mc-afficher').checked).toBe(true);
  expect($('mc-opacite').value).toBe('35');
});

test('page de visio : la conférence reste affichée', async () => {
  await charger('https://webconf.numerique.gouv.fr/salle');
  expect($('mc-section').hidden).toBe(true);
  expect($('rec').classList.contains('mc-cache')).toBe(false);
});

test('page non déclarée : conférence affichée, ligne de mise à jour visible', async () => {
  reponses['mescollections:page'] = { ok: true, cibles: [], etat: ETAT };
  await charger('https://exemple.fake-domain.name/');
  expect($('mc-section').hidden).toBe(true);
  expect($('mc-maj').hidden).toBe(false);
});

test('Mes collections non configuré : ligne de mise à jour masquée', async () => {
  reponses['mescollections:page'] = { ok: true, cibles: [], etat: { etat: 'inactif', raison: 'Adresse de Mes collections non configurée' } };
  await charger('https://exemple.fake-domain.name/');
  expect($('mc-maj').hidden).toBe(true);
});

test('« Mettre à jour la liste » relit les sites', async () => {
  await charger('https://fr.wikipedia.org/wiki/Guerre_de_Cent_Ans');
  $('mc-maj-btn').click();
  await new Promise((r) => setTimeout(r, 0));
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'mescollections:reessayer' }, expect.any(Function));
});

test('masquer sur ce site puis régler l\'opacité : réglages de la bulle enregistrés', async () => {
  await charger('https://fr.wikipedia.org/wiki/Guerre_de_Cent_Ans');
  $('mc-afficher').checked = false;
  $('mc-afficher').dispatchEvent(new Event('change'));
  await new Promise((r) => setTimeout(r, 0));
  $('mc-opacite').value = '60';
  $('mc-opacite').dispatchEvent(new Event('input'));
  await new Promise((r) => setTimeout(r, 0));
  const prefs = __getChromeStorage().mescollectionsBulle;
  expect(prefs.masques).toEqual(['fr.wikipedia.org']);
  expect(prefs.opacite).toBe(0.6);
  expect($('mc-opacite-valeur').textContent).toBe('60 %');
});

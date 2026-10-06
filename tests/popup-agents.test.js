// tests/popup-agents.test.js — Section « Agents » et vue « Résultat » du popup (src/popup-agents.js)
// Le DOM est celui de popup.html (balises <script> retirées : jsdom ne les exécute pas).

const fs = require('fs');
const path = require('path');

function chargerDom() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup.html'), 'utf8');
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').match(/<body>([\s\S]*)<\/body>/)[1];
  document.body.innerHTML = body;
}

function agent(id, extra = {}) {
  return Object.assign({ id, name: `Agent ${id}`, description: `Description ${id}`, origin: 'shared', inputs: ['text'], model: id }, extra);
}

let MA;

beforeEach(() => {
  __resetChromeStorage();
  jest.clearAllMocks();
  chargerDom();
  delete window.PopupAgents;

  // MesAgents simule : actif par defaut, liste et lancement controles par chaque test
  MA = {
    _cfg: { mesagentsBaseUrl: 'https://mesagents.test', features: { agents: true } },
    _lireConfig: jest.fn(async () => MA._cfg),
    estActif: jest.fn((cfg) => !!cfg.mesagentsBaseUrl && cfg.features?.agents !== false),
    listerAgents: jest.fn(async () => [agent('a'), agent('b', { origin: 'mine' })]),
    lancerAgent: jest.fn(async () => ({ texte: 'Réponse de l\'agent', model: 'a', id: null })),
    messageErreur: jest.fn((e) => e?.message || 'Erreur inattendue en contactant Mes agents.')
  };
  window.MesAgents = MA;

  eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'popup-agents.js'), 'utf8'));
});

const $ = (id) => document.getElementById(id);
const tick = () => new Promise(r => setTimeout(r, 0));

describe('PopupAgents — section « Agents »', () => {
  test('la section est absente par defaut et le reste si la fonction est desactivee', async () => {
    MA._cfg = { mesagentsBaseUrl: '' };
    window.PopupAgents.init(document);
    expect($('agents-block').style.display).toBe('none');
    await window.PopupAgents.charger();
    expect($('agents-block').style.display).toBe('none');
    expect(MA.listerAgents).not.toHaveBeenCalled();
  });

  test('liste les agents « text » dans le select avec origine et description en texte', async () => {
    window.PopupAgents.init(document);
    await window.PopupAgents.charger();

    expect(MA.listerAgents).toHaveBeenCalledWith({ input: 'text', force: false });
    expect($('agents-block').style.display).toBe('block');
    const options = Array.from($('agents-select').options);
    expect(options.map(o => o.value)).toEqual(['a', 'b']);
    expect(options[1].textContent).toBe('★ Agent b');
    expect($('agents-description').textContent).toBe('Description a');
    expect($('agents-launch').disabled).toBe(false);

    $('agents-select').value = 'b';
    $('agents-select').dispatchEvent(new Event('change'));
    expect($('agents-description').textContent).toBe('Description b');
  });

  test('description affichee par textContent : jamais interpretee comme HTML', async () => {
    MA.listerAgents.mockResolvedValueOnce([agent('x', { description: '<img src=x onerror=alert(1)>', name: '<b>gras</b>' })]);
    window.PopupAgents.init(document);
    await window.PopupAgents.charger();
    expect($('agents-description').querySelector('img')).toBeNull();
    expect($('agents-description').textContent).toBe('<img src=x onerror=alert(1)>');
    expect($('agents-select').options[0].textContent).toBe('<b>gras</b>');
  });

  test('aucun agent « text » → message vide, formulaire masque', async () => {
    MA.listerAgents.mockResolvedValueOnce([]);
    window.PopupAgents.init(document);
    await window.PopupAgents.charger();
    expect($('agents-block').style.display).toBe('block');
    expect($('agents-form').style.display).toBe('none');
    expect($('agents-empty').style.display).toBe('block');
  });

  test('erreur masquante (jeton invalide, audience, injoignable) → section retiree', async () => {
    MA.listerAgents.mockRejectedValueOnce(Object.assign(new Error('aud'), { code: 'audience_mismatch', masquer: true }));
    window.PopupAgents.init(document);
    await window.PopupAgents.charger();
    expect($('agents-block').style.display).toBe('none');
  });

  test('erreur lisible non masquante → statut affiche, section conservee', async () => {
    MA.listerAgents.mockRejectedValueOnce(Object.assign(new Error('Réessayez dans un moment.'), { code: 'rate_limited', masquer: false }));
    window.PopupAgents.init(document);
    await window.PopupAgents.charger();
    expect($('agents-block').style.display).toBe('block');
    expect($('agents-status').textContent).toBe('Réessayez dans un moment.');
    expect($('agents-status').className).toContain('err');
  });

  test('« Rafraîchir » recharge la liste en forcant le cache', async () => {
    window.PopupAgents.init(document);
    await window.PopupAgents.charger();
    $('agents-refresh').click();
    await tick();
    expect(MA.listerAgents).toHaveBeenLastCalledWith({ input: 'text', force: true });
  });
});

describe('PopupAgents — « Lancer » et vue « Résultat »', () => {
  test('lance l\'agent choisi avec le texte saisi et affiche la reponse', async () => {
    window.PopupAgents.init(document);
    await window.PopupAgents.charger();
    $('agents-select').value = 'b';
    $('agents-text').value = '  Mon texte à traiter  ';
    await window.PopupAgents.lancer();

    expect(MA.lancerAgent).toHaveBeenCalledWith({
      model: 'b',
      consigne: 'Voici le texte à traiter. Applique ta mission à ce texte.',
      contenu: 'Mon texte à traiter'
    });
    expect($('agents-result').style.display).toBe('block');
    expect($('agents-result-name').textContent).toBe('Agent b');
    expect($('agents-result-text').textContent).toBe('Réponse de l\'agent');
    expect($('agents-result-copy').disabled).toBe(false);
    expect($('agents-launch').disabled).toBe(false);
  });

  test('contenu tronque : la vue « Résultat » le dit a la personne', async () => {
    MA.lancerAgent.mockResolvedValueOnce({ texte: 'ok', tronque: true });
    window.PopupAgents.init(document);
    await window.PopupAgents.charger();
    $('agents-text').value = 'x';
    await window.PopupAgents.lancer();
    expect($('agents-result-text').textContent).toBe('ok');
    expect($('agents-result-status').textContent).toMatch(/tronqué/);
  });

  test('etat d\'attente pendant l\'appel', async () => {
    let resoudre;
    MA.lancerAgent.mockImplementationOnce(() => new Promise(r => { resoudre = r; }));
    window.PopupAgents.init(document);
    await window.PopupAgents.charger();
    $('agents-text').value = 'x';
    const p = window.PopupAgents.lancer();
    await tick();
    expect($('agents-launch').disabled).toBe(true);
    expect($('agents-result-status').textContent).toBe('En attente de la réponse…');
    expect($('agents-result-copy').disabled).toBe(true);
    resoudre({ texte: 'fini' });
    await p;
    expect($('agents-result-text').textContent).toBe('fini');
  });

  test('texte vide → invite a saisir, aucun appel', async () => {
    window.PopupAgents.init(document);
    await window.PopupAgents.charger();
    $('agents-text').value = '   ';
    await window.PopupAgents.lancer();
    expect(MA.lancerAgent).not.toHaveBeenCalled();
    expect($('agents-status').textContent).toMatch(/Saisissez un texte/);
  });

  test('422 : le message de la garde est affiche tel quel dans le resultat', async () => {
    MA.lancerAgent.mockRejectedValueOnce(Object.assign(new Error('Votre texte contient une consigne cachée.'), { code: 'blocked_input', masquer: false }));
    window.PopupAgents.init(document);
    await window.PopupAgents.charger();
    $('agents-text').value = 'x';
    await window.PopupAgents.lancer();
    expect($('agents-result-status').textContent).toBe('Votre texte contient une consigne cachée.');
    expect($('agents-result-status').className).toContain('err');
    expect($('agents-result-copy').disabled).toBe(true);
    expect($('agents-block').style.display).toBe('block');
  });

  test('erreur masquante au lancement → section retiree, resultat en erreur', async () => {
    MA.lancerAgent.mockRejectedValueOnce(Object.assign(new Error('Session MirAI expirée.'), { code: 'invalid_token', masquer: true }));
    window.PopupAgents.init(document);
    await window.PopupAgents.charger();
    $('agents-text').value = 'x';
    await window.PopupAgents.lancer();
    expect($('agents-block').style.display).toBe('none');
    expect($('agents-result-status').textContent).toBe('Session MirAI expirée.');
  });

  test('« Copier » place la reponse dans le presse-papiers', async () => {
    const writeText = jest.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText } });
    window.PopupAgents.init(document);
    await window.PopupAgents.charger();
    $('agents-text').value = 'x';
    await window.PopupAgents.lancer();
    const ok = await window.PopupAgents.copier();
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('Réponse de l\'agent');
    expect($('agents-result-copied').textContent).toBe('Copié.');
  });

  test('« Fermer » masque le resultat et purge storage.session', async () => {
    __seedSessionStorage({ mesagentsResultat: { status: 'done', agent: { id: 'a', name: 'Agent a' }, texte: 'stocke' } });
    window.PopupAgents.init(document);
    await tick();
    expect($('agents-result').style.display).toBe('block');
    await window.PopupAgents.fermerResultat();
    expect($('agents-result').style.display).toBe('none');
    expect(__getSessionStorage().mesagentsResultat).toBeUndefined();
  });
});

describe('PopupAgents — resultat publie par le service worker (menu contextuel)', () => {
  test('a l\'ouverture, lit storage.session et affiche la reponse', async () => {
    __seedSessionStorage({ mesagentsResultat: { status: 'done', agent: { id: 'a', name: 'Rédacteur' }, texte: 'Réponse du menu' } });
    window.PopupAgents.init(document);
    await tick();
    expect($('agents-result').style.display).toBe('block');
    expect($('agents-result-name').textContent).toBe('Rédacteur');
    expect($('agents-result-text').textContent).toBe('Réponse du menu');
  });

  test('suit les changements de storage.session : attente puis reponse', async () => {
    window.PopupAgents.init(document);
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalled();
    const listener = chrome.storage.onChanged.addListener.mock.calls[0][0];

    listener({ mesagentsResultat: { newValue: { status: 'pending', agent: { id: 'a', name: 'Agent a' } } } }, 'session');
    expect($('agents-result').style.display).toBe('block');
    expect($('agents-result-status').textContent).toBe('En attente de la réponse…');

    listener({ mesagentsResultat: { newValue: { status: 'done', agent: { id: 'a', name: 'Agent a' }, texte: 'Voilà' } } }, 'session');
    expect($('agents-result-text').textContent).toBe('Voilà');

    listener({ mesagentsResultat: { newValue: { status: 'error', agent: { id: 'a', name: 'Agent a' }, message: "Cet agent n'est plus accessible." } } }, 'session');
    expect($('agents-result-status').textContent).toBe("Cet agent n'est plus accessible.");

    listener({ mesagentsResultat: { newValue: undefined } }, 'session');
    expect($('agents-result').style.display).toBe('none');
  });

  test('ignore les changements d\'autres cles', () => {
    window.PopupAgents.init(document);
    const listener = chrome.storage.onChanged.addListener.mock.calls[0][0];
    listener({ miraiToken: { newValue: {} } }, 'local');
    expect($('agents-result').style.display).toBe('none');
  });
});

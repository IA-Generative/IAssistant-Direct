// tests/mescollections-correspond.test.js — motifs d'adresse des sites déclarés

const { valide, correspond, normaliser, ciblesPour } = require('../src/mescollections/correspond.js');

describe('valide(motif) — règle du contrat Mes collections', () => {
  test.each([
    'https://www.legifrance.gouv.fr/codes/*',
    'https://www.legifrance.gouv.fr/',
    'https://*.gouv.fr/*',
    'https://*.fake-domain.name/*',
    'https://exemple.fake-domain.name/a/*/b?x=*'
  ])('accepte %s', (m) => expect(valide(m)).toBe(true));

  test.each([
    ['*', 'joker seul'],
    ['<all_urls>', 'toutes les adresses'],
    ['http://www.legifrance.gouv.fr/*', 'http'],
    ['*://www.legifrance.gouv.fr/*', 'schéma joker'],
    ['https://*/*', 'hôte joker'],
    ['https://*.fr/*', '« *. » sur un seul niveau'],
    ['https://localhost/*', 'hôte sans point'],
    ['https://www.legifrance.gouv.fr:8443/*', 'port'],
    ['https://user@www.legifrance.gouv.fr/*', 'identifiant'],
    ['https://WWW.Legifrance.gouv.fr/*', 'majuscules'],
    ['https://www.legifrance.gouv.fr', 'chemin absent'],
    ['https://www.*.gouv.fr/*', 'joker au milieu de l\'hôte'],
    [42, 'pas une chaîne'],
    [null, 'absent']
  ])('refuse %s (%s)', (m) => expect(valide(m)).toBe(false));
});

describe('correspond(url, motif)', () => {
  const codes = 'https://www.legifrance.gouv.fr/codes/*';

  test('chemin couvert par le joker', () => {
    expect(correspond('https://www.legifrance.gouv.fr/codes/texte_lc/LEGITEXT000006070158', codes)).toBe(true);
  });

  test('la query est comparée', () => {
    expect(correspond('https://www.legifrance.gouv.fr/codes/?a=1', codes)).toBe(true);
    expect(correspond('https://ex.fake-domain.name/p?x=1', 'https://ex.fake-domain.name/p')).toBe(false);
    expect(correspond('https://ex.fake-domain.name/p?x=1', 'https://ex.fake-domain.name/p?x=*')).toBe(true);
  });

  test('le fragment n\'est jamais comparé', () => {
    expect(correspond('https://ex.fake-domain.name/p#section', 'https://ex.fake-domain.name/p')).toBe(true);
    expect(correspond('https://ex.fake-domain.name/p#x', 'https://ex.fake-domain.name/p#x')).toBe(false);
  });

  test('autre chemin, autre hôte, http : pas de correspondance', () => {
    expect(correspond('https://www.legifrance.gouv.fr/jorf/id/1', codes)).toBe(false);
    expect(correspond('https://legifrance.gouv.fr/codes/1', codes)).toBe(false);
    expect(correspond('http://www.legifrance.gouv.fr/codes/1', codes)).toBe(false);
  });

  test('« *. » couvre le domaine nu et ses sous-domaines', () => {
    const m = 'https://*.fake-domain.name/*';
    expect(correspond('https://fake-domain.name/x', m)).toBe(true);
    expect(correspond('https://a.b.fake-domain.name/x', m)).toBe(true);
    expect(correspond('https://fake-domain.name.attaquant.example/x', m)).toBe(false);
    expect(correspond('https://autrefake-domain.name/x', m)).toBe(false);
  });

  test('l\'hôte de l\'adresse est comparé en minuscules', () => {
    expect(correspond('https://WWW.LEGIFRANCE.GOUV.FR/codes/1', codes)).toBe(true);
  });

  test('les points du motif ne sont pas des jokers', () => {
    expect(correspond('https://wwwXlegifrance.gouv.fr/codes/1', codes)).toBe(false);
  });

  test('adresse invalide ou avec identifiant : pas de correspondance', () => {
    expect(correspond('pas une adresse', codes)).toBe(false);
    expect(correspond('https://u:p@www.legifrance.gouv.fr/codes/1', codes)).toBe(false);
  });

  test('motif invalide : ne correspond à rien', () => {
    expect(correspond('https://www.legifrance.gouv.fr/codes/1', 'https://*/*')).toBe(false);
  });
});

describe('normaliser(url)', () => {
  test('retire le fragment, garde chemin et query', () => {
    expect(normaliser('https://Ex.fake-domain.name/a?b=1#c')).toBe('https://ex.fake-domain.name/a?b=1');
  });
  test('refuse les adresses non https', () => {
    expect(normaliser('chrome://extensions')).toBeNull();
  });
});

describe('ciblesPour(url, sites)', () => {
  const sites = [
    { motif: 'https://www.legifrance.gouv.fr/codes/*', cibles: [{ type: 'assistant', id: 'a1', titre: 'A1' }, { type: 'collection', id: 'c1', titre: 'C1' }] },
    { motif: 'https://*.gouv.fr/*', cibles: [{ type: 'collection', id: 'c1', titre: 'C1' }, { type: 'collection', id: 'c2', titre: 'C2' }] },
    { motif: 'https://*/*', cibles: [{ type: 'collection', id: 'piege', titre: 'Piège' }] }
  ];

  test('réunit les cibles de tous les motifs qui correspondent, sans doublon', () => {
    expect(ciblesPour('https://www.legifrance.gouv.fr/codes/1', sites).map((c) => c.id)).toEqual(['a1', 'c1', 'c2']);
  });

  test('aucune cible ailleurs ; un motif invalide est ignoré', () => {
    expect(ciblesPour('https://exemple.fake-domain.name/', sites)).toEqual([]);
  });

  test('entrées absentes ou mal formées : liste vide', () => {
    expect(ciblesPour('https://www.legifrance.gouv.fr/codes/1', null)).toEqual([]);
    expect(ciblesPour('https://www.legifrance.gouv.fr/codes/1', [null, {}])).toEqual([]);
  });
});

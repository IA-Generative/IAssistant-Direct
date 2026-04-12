// tests/manifest-html.test.js
// Verifie les fichiers de configuration et HTML

const fs = require('fs');
const path = require('path');

const readRoot = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const readSrc = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
const readRootJSON = (name) => JSON.parse(readRoot(name));
const readSrcJSON = (name) => JSON.parse(readSrc(name));

describe('manifest.json', () => {
  const manifest = readRootJSON('manifest.json');

  test('contient la permission alarms', () => {
    expect(manifest.permissions).toContain('alarms');
  });

  test('contient la permission notifications', () => {
    expect(manifest.permissions).toContain('notifications');
  });

  test('conserve les permissions existantes', () => {
    expect(manifest.permissions).toContain('tabs');
    expect(manifest.permissions).toContain('storage');
    expect(manifest.permissions).toContain('identity');
    expect(manifest.permissions).toContain('activeTab');
  });

  test('est en manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  test('background est un service worker', () => {
    expect(manifest.background.service_worker).toBe('src/background.js');
  });
});

describe('dm/config.json', () => {
  const config = readSrcJSON('dm/config.json');

  test('a un configVersion', () => {
    expect(config.configVersion).toBe(1);
  });

  test('contient les profils dev, int, prod-scaleway, prod-dgx', () => {
    expect(config.dev).toBeDefined();
    expect(config.int).toBeDefined();
    expect(config['prod-scaleway']).toBeDefined();
    expect(config['prod-dgx']).toBeDefined();
  });

  test('contient slug et activeProfile', () => {
    expect(config.slug).toBe('mirai-browser');
    expect(config.activeProfile).toBeDefined();
  });

  test('profil int contient toutes les URLs attendues', () => {
    expect(config.int.keycloakIssuerUrl).toBeDefined();
    expect(config.int.keycloakRealm).toBeDefined();
    expect(config.int.keycloakClientId).toBeDefined();
    expect(config.int.apiBase).toBe('https://compte-rendu.mirai.interieur.gouv.fr/api');
    expect(config.int.chatUrl).toBeDefined();
    expect(config.int.resumeUrl).toBeDefined();
    expect(config.int.compteRenduUrl).toBeDefined();
    expect(config.int.comuUrl).toBeDefined();
  });

  test('profil prod-scaleway pointe Keycloak sur sso.mirai.interieur.gouv.fr', () => {
    expect(config['prod-scaleway'].keycloakIssuerUrl).toContain('sso.mirai.interieur.gouv.fr');
    expect(config['prod-scaleway'].keycloakRealm).toBe('mirai');
    expect(config['prod-scaleway'].bootstrap_url).toBe('https://bootstrap.fake-domain.name');
  });

  test('profil prod-dgx pointe Keycloak via le relay (flux sortants bloques)', () => {
    // Sur DGX, Chromium ne peut pas joindre directement sso.mirai.interieur.gouv.fr.
    // L'extension pointe donc l'issuer sur le relay-assistant qui reverse-proxy Keycloak.
    expect(config['prod-dgx'].keycloakIssuerUrl).toBe(
      'https://onyxia.gpu.minint.fr/bootstrap/relay-assistant/keycloak'
    );
    // keycloakRealm vide pour ne pas que _normalizeRealmBase ajoute /realms/mirai
    // dans le path (le relay nginx expose /keycloak/protocol/... sans segment realm).
    expect(config['prod-dgx'].keycloakRealm).toBe('');
    expect(config['prod-dgx'].bootstrap_url).toBe('https://onyxia.gpu.minint.fr/bootstrap');
  });

  test('les deux profils prod partagent le meme client Keycloak', () => {
    expect(config['prod-scaleway'].keycloakClientId).toBe('mirai-extension');
    expect(config['prod-dgx'].keycloakClientId).toBe('mirai-extension');
  });

  test('chaque profil a un bootstrap_url et config_path', () => {
    for (const p of ['dev', 'int', 'prod-scaleway', 'prod-dgx']) {
      expect(config[p].bootstrap_url).toBeDefined();
      expect(config[p].config_path).toBeDefined();
    }
  });

  test('default contient les allowedKeywords', () => {
    expect(config.default.allowedKeywords).toEqual(
      ['webconf', 'comu', 'webinaire', 'webex', 'gmeet', 'teams']
    );
  });
});

describe('dm/manifest.json', () => {
  const manifest = readSrcJSON('dm/manifest.json');

  test('a le slug mirai-browser', () => {
    expect(manifest.slug).toBe('mirai-browser');
  });

  test('a le device_type chrome', () => {
    expect(manifest.device_type).toBe('chrome');
  });

  test('a un changelog avec la version courante', () => {
    expect(manifest.changelog.length).toBeGreaterThanOrEqual(1);
    expect(manifest.changelog[0].version).toBe('1.2.1');
  });

  test('a les key_features', () => {
    expect(manifest.key_features.length).toBeGreaterThanOrEqual(3);
  });
});

describe('popup.html', () => {
  const html = readSrc('popup.html');

  test('charge dm/bootstrap.js avant recording.js et popup.js', () => {
    const bootstrapIdx = html.indexOf('dm/bootstrap.js');
    const recordingIdx = html.indexOf('recording.js');
    const popupIdx = html.indexOf('popup.js');

    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeLessThan(recordingIdx);
    expect(bootstrapIdx).toBeLessThan(popupIdx);
  });

  test('charge dm/telemetry.js', () => {
    expect(html).toContain('<script src="dm/telemetry.js"></script>');
  });

  test('charge auth.js avant popup.js', () => {
    const authIdx = html.indexOf('auth.js');
    const popupIdx = html.indexOf('popup.js');
    expect(authIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeLessThan(popupIdx);
  });

  test('contient le bandeau de mise a jour', () => {
    expect(html).toContain('id="dm-update-banner"');
    expect(html).toContain('id="dm-update-version"');
    expect(html).toContain('id="dm-update-link"');
    expect(html).toContain('id="dm-update-dismiss"');
  });
});

describe('options.html', () => {
  const html = readSrc('options.html');

  test('charge dm/bootstrap.js avant options.js', () => {
    const bootstrapIdx = html.indexOf('dm/bootstrap.js');
    const optionsIdx = html.indexOf('options.js');

    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeLessThan(optionsIdx);
  });

  test('charge auth.js avant options.js', () => {
    const authIdx = html.indexOf('auth.js');
    const optionsIdx = html.indexOf('options.js');
    expect(authIdx).toBeGreaterThan(-1);
    expect(authIdx).toBeLessThan(optionsIdx);
  });
});

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

  test('background.scripts (Firefox ESR) : fichiers existants, background.js en dernier', () => {
    const scripts = manifest.background.scripts;
    expect(Array.isArray(scripts)).toBe(true);
    expect(scripts[scripts.length - 1]).toBe('src/background.js');
    for (const f of scripts) {
      expect(fs.existsSync(path.join(__dirname, '..', f))).toBe(true);
    }
  });

  test('background.scripts couvre les modules importés par le service worker', () => {
    const bg = readSrc('background.js');
    const importes = [...bg.matchAll(/importScripts\(([^)]*)\)/g)]
      .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((a) => 'src/' + a[1]));
    expect(importes.length).toBeGreaterThan(0);
    for (const f of importes) {
      expect(manifest.background.scripts).toContain(f);
    }
  });

  test('importScripts est garde (absent sous Firefox)', () => {
    expect(readSrc('background.js')).toMatch(/typeof importScripts === 'function'/);
  });
});

describe('dm/config.json', () => {
  const config = readSrcJSON('dm/config.json');

  test('a un configVersion', () => {
    expect(config.configVersion).toBe(1);
  });

  test('contient les profils dev, int, prod (UN seul prod multi-DM)', () => {
    expect(config.dev).toBeDefined();
    expect(config.int).toBeDefined();
    expect(config.prod).toBeDefined();
    // Les anciens profils par environnement sont supprimes (collapse en prod unique).
    expect(config['prod-scaleway']).toBeUndefined();
    expect(config['prod-dgx']).toBeUndefined();
    expect(config['prod-onprem']).toBeUndefined();
  });

  test('contient slug et activeProfile', () => {
    expect(config.slug).toBe('iassistant-direct-browser');
    expect(config.activeProfile).toBeDefined();
  });

  test('config bakee : aucun placeholder ${{}} (les placeholders vivent dans dm-config.json)', () => {
    expect(JSON.stringify(config)).not.toContain('${{');
  });

  test('profil int contient toutes les URLs attendues', () => {
    expect(config.int.keycloakIssuerUrl).toBeDefined();
    expect(config.int.keycloakRealm).toBeDefined();
    expect(config.int.keycloakClientId).toBeDefined();
    expect(config.int.apiBase).toBe('https://compte-rendu.mirai.interieur.gouv.fr/api');
    expect(config.int.compteRenduUrl).toBeDefined();
    expect(config.int.comuUrl).toBeDefined();
  });

  test('profil prod : liste ORDONNEE bootstrap_urls (scaleway/dgx/onprem)', () => {
    const urls = config.prod.bootstrap_urls;
    expect(Array.isArray(urls)).toBe(true);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    // Les 3 environnements sont presents dans la liste candidate.
    expect(urls).toContain('https://bootstrap.apps.ocpbm02s2.cores.r2.pi2.minint.fr');
    expect(urls).toContain('https://onyxia.gpu.minint.fr/bootstrap');
    expect(urls).toContain('https://bootstrap.fake-domain.name');
  });

  test('profil prod : Keycloak SSO + parametres de scan', () => {
    expect(config.prod.keycloakIssuerUrl).toContain('sso.mirai.interieur.gouv.fr');
    expect(config.prod.keycloakRealm).toBe('mirai');
    expect(config.prod.keycloakClientId).toBe('mirai-extension');
    expect(config.prod.relayAssistantBaseUrl).toBeUndefined();
    // Parametres de la course echelonnee.
    expect(typeof config.prod.bootstrap_stagger_ms).toBe('number');
    expect(typeof config.prod.bootstrap_timeout_ms).toBe('number');
  });

  test('le config_path de prod pointe sur ?profile=prod (resolu par le DM gagnant)', () => {
    expect(config.prod.config_path).toContain('profile=prod');
  });

  test('chaque profil a de quoi joindre un DM (bootstrap_url ou bootstrap_urls) + config_path', () => {
    // dev/int : URL unique ; prod : liste.
    expect(config.dev.bootstrap_url).toBeDefined();
    expect(config.int.bootstrap_url).toBeDefined();
    expect(config.prod.bootstrap_urls).toBeDefined();
    for (const p of ['dev', 'int', 'prod']) {
      expect(config[p].config_path).toBeDefined();
    }
  });

  test('default contient les allowedKeywords', () => {
    expect(config.default.allowedKeywords).toEqual(
      ['webconf', 'visio', 'comu', 'webinaire', 'webex', 'gmeet', 'teams']
    );
  });
});

describe('dm/dm-config.json (template DM)', () => {
  const tpl = readSrcJSON('dm/dm-config.json');
  const ENV_KEYS = ['keycloakIssuerUrl', 'keycloakRealm',
    'keycloak_redirect_uri', 'keycloak_allowed_redirect_uri', 'apiBase'];

  test('a le bon slug et configVersion', () => {
    expect(tpl.slug).toBe('iassistant-direct-browser');
    expect(tpl.configVersion).toBe(1);
  });

  test('chaque cle env des profils non-default est un placeholder ${{}}', () => {
    for (const [prof, val] of Object.entries(tpl)) {
      if (['configVersion', 'slug', '_description', 'default'].includes(prof)) continue;
      if (typeof val !== 'object') continue;
      for (const k of ENV_KEYS) {
        if (val[k] === undefined) continue;
        expect(val[k]).toMatch(/^\$\{\{.+\}\}$/);
      }
    }
  });

  test('keycloakClientId est mirai-extension en dur dans tous les profils', () => {
    // ${{KEYCLOAK_CLIENT_ID}} est le client du DM (bootstrap-iassistant) : servi à l'extension,
    // il cassait la connexion (403 à l'échange du code) et le rafraîchissement du jeton.
    for (const prof of ['dev', 'int', 'prod']) {
      expect(tpl[prof].keycloakClientId).toBe('mirai-extension');
    }
  });
});

describe('dm/manifest.json', () => {
  const manifest = readSrcJSON('dm/manifest.json');

  test('a le slug iassistant-direct-browser', () => {
    expect(manifest.slug).toBe('iassistant-direct-browser');
  });

  test('a le device_type chrome', () => {
    expect(manifest.device_type).toBe('chrome');
  });

  test('a un changelog avec la version courante', () => {
    expect(manifest.changelog.length).toBeGreaterThanOrEqual(1);
    expect(manifest.changelog[0].version).toBe('1.2.4');
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

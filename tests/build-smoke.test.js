// tests/build-smoke.test.js
// ─────────────────────────────────────────────────────────────────────────────
// SMOKE TEST DU BUILD (extension)
// Exécute réellement scripts/build.sh --target=prod puis vérifie que
// dist/extension/ est un paquet d'extension MV3 cohérent et CHARGEABLE :
//   - le build se termine sans erreur ;
//   - manifest.json valide (MV3) et toutes ses références existent dans le paquet ;
//   - content_scripts (overlay) + fichiers source clés copiés ;
//   - fichiers Device Management présents à la racine du paquet ;
//   - version buildée == version source ; profil baké == prod.
//
// But : attraper toute casse de packaging AVANT déploiement (références mortes,
// fichier oublié, manifest invalide, mauvais profil). Indépendant du contenu
// métier — on valide la SORTIE du build, pas les règles plateformes.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'extension');
const BUILD_TIMEOUT_MS = 120000;

let buildError = null;
let buildOutput = '';

beforeAll(() => {
  try {
    buildOutput = execFileSync('bash', ['scripts/build.sh', '--target=prod'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: BUILD_TIMEOUT_MS,
    });
  } catch (e) {
    buildError = e;
    buildOutput = `${e.stdout || ''}\n${e.stderr || ''}`;
  }
}, BUILD_TIMEOUT_MS + 15000);

const distPath = (rel) => path.join(DIST, rel);
const distExists = (rel) => fs.existsSync(distPath(rel));
const distJSON = (rel) => JSON.parse(fs.readFileSync(distPath(rel), 'utf8'));

describe('build.sh — smoke (extension, target=prod)', () => {
  test('le build se termine sans erreur', () => {
    if (buildError) {
      throw new Error(`build.sh a échoué (code ${buildError.status}):\n${buildOutput}`);
    }
    // build.sh imprime cette ligne après avoir validé les références du manifest.
    expect(buildOutput).toContain('Manifest OK');
  });

  test('produit un manifest.json valide en Manifest V3', () => {
    expect(distExists('manifest.json')).toBe(true);
    const m = distJSON('manifest.json');
    expect(m.manifest_version).toBe(3);
    expect(typeof m.name).toBe('string');
    expect(typeof m.version).toBe('string');
    expect(m.version).toMatch(/^\d+\.\d+/);
  });

  test('toutes les références du manifest existent dans le paquet', () => {
    const m = distJSON('manifest.json');
    const refs = [
      m.background.service_worker,
      m.action.default_popup,
      m.options_ui.page,
      ...Object.values(m.icons),
    ];
    const missing = refs.filter((r) => !distExists(r));
    expect(missing).toEqual([]);
  });

  test('content_scripts: overlay injecté avec au moins un match', () => {
    const m = distJSON('manifest.json');
    expect(Array.isArray(m.content_scripts)).toBe(true);
    expect(m.content_scripts.length).toBeGreaterThan(0);
    const cs = m.content_scripts[0];
    expect(Array.isArray(cs.matches)).toBe(true);
    expect(cs.matches.length).toBeGreaterThan(0);
    const missingJs = cs.js.filter((j) => !distExists(j));
    expect(missingJs).toEqual([]);
  });

  test('fichiers source clés copiés dans le paquet', () => {
    const keyFiles = [
      'src/background.js',
      'src/auth.js',
      'src/crypto.js',
      'src/overlay.js',
      'src/popup.js',
      'src/recording.js',
      'src/dm/bootstrap.js',
    ];
    const missing = keyFiles.filter((f) => !distExists(f));
    expect(missing).toEqual([]);
  });

  test('fichiers Device Management présents à la racine du paquet', () => {
    expect(distExists('dm-manifest.json')).toBe(true);
    expect(distExists('dm-config.json')).toBe(true);
    expect(distExists('assets/icon128.png')).toBe(true);
  });

  test('version du manifest buildé == version source', () => {
    const built = distJSON('manifest.json').version;
    const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;
    expect(built).toBe(src);
  });

  test('profil baké: activeProfile=prod dans dm/config.json', () => {
    const cfg = distJSON('src/dm/config.json');
    expect(cfg.activeProfile).toBe('prod');
  });

  test('aucun placeholder ${{...}} résiduel dans la config bakée client', () => {
    const cfg = JSON.stringify(distJSON('src/dm/config.json'));
    expect(cfg).not.toContain('${{');
  });
});

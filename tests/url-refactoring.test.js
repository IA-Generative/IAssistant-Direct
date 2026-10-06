// tests/url-refactoring.test.js
// Verifie que les URLs hardcodees sont bien remplacees par les lookups DMBootstrap

const fs = require('fs');
const path = require('path');

const readFile = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');

describe('URL refactoring — recording.js', () => {
  test('API_BASE utilise DMBootstrap avec fallback', () => {
    const code = readFile('recording.js');
    // recording.js runs in both popup (window) and service worker (self),
    // so the lookup goes through a _global alias instead of window directly.
    expect(code).toContain('.DMBootstrap?.getConfig()?.apiBase');
    expect(code).toContain("|| 'https://compte-rendu.mirai.interieur.gouv.fr/api'");
  });

  test('contient l\'instrumentation telemetrie recording.start', () => {
    const code = readFile('recording.js');
    expect(code).toContain("DMTelemetry.sendSpan('recording.start'");
  });

  test('contient l\'instrumentation telemetrie recording.stop', () => {
    const code = readFile('recording.js');
    expect(code).toContain("DMTelemetry.sendSpan('recording.stop'");
  });

  test('contient l\'instrumentation telemetrie meeting.create', () => {
    const code = readFile('recording.js');
    expect(code).toContain("DMTelemetry.sendSpan('meeting.create'");
  });

  test('ne journalise jamais le jeton (fuite corrigee)', () => {
    const code = readFile('recording.js');
    expect(code).not.toMatch(/console\.\w+\([^)]*Token récupéré/);
    expect(code).not.toMatch(/console\.\w+\([^)]*,\s*token\s*\)/);
  });
});

describe('Contrat d\'agents MirAI — aucune journalisation du jeton', () => {
  test.each(['mesagents.js', 'popup-agents.js', 'background.js', 'auth.js', 'recording.js'])('%s ne passe jamais une variable de jeton a console.*', (name) => {
    const code = readFile(name);
    // Une variable de jeton passee en argument (`, token)`) ou interpolee (`${token}`) dans un console.*
    expect(code).not.toMatch(/console\.\w+\([^)]*,\s*(token|jeton|accessToken|access_token|tokenData|miraiToken|refresh_token)\s*\)/);
    expect(code).not.toMatch(/console\.\w+\([^)]*\$\{\s*(token|jeton|accessToken|tokenData|miraiToken)\b/);
  });

  test('background.js branche MesAgents sur le rafraichissement silencieux existant', () => {
    const code = readFile('background.js');
    expect(code).toContain('MesAgents.setAuth(');
    expect(code).toContain('_ensureTokenFresh({ force: forcer })');
  });

  test('auth.js et background.js construisent la portee via MesAgents.buildScope', () => {
    expect(readFile('auth.js')).toContain('MesAgents.buildScope');
    expect(readFile('background.js')).toContain('MesAgents.buildScope');
  });
});

describe('URL refactoring — popup.js', () => {
  const code = readFile('popup.js');

  test('checkKeycloakSession delegue a MiraiAuth', () => {
    expect(code).toContain('MiraiAuth.login');
  });

  test('startRecording utilise MiraiAuth.ensureAuthenticated', () => {
    expect(code).toContain('MiraiAuth.ensureAuthenticated');
  });

  test('meeting viewer URL utilise compteRenduUrl depuis config', () => {
    expect(code).toContain("DMBootstrap?.getConfig()?.compteRenduUrl");
    expect(code).toContain("|| 'https://compte-rendu.mirai.interieur.gouv.fr/'");
  });

  test('raccourcis utilisent les URLs depuis config', () => {
    expect(code).toContain("_sc.compteRenduUrl || 'https://compte-rendu.mirai.interieur.gouv.fr/'");
    expect(code).toContain("_sc.comuUrl || 'https://webconf.comu.gouv.fr/'");
    expect(code).toContain("_sc.visioUrl || 'https://visio.numerique.gouv.fr/'");
  });

  test('raccourcis utilisent MiraiAuth.ensureAuthenticated', () => {
    expect(code).toContain('MiraiAuth.ensureAuthenticated');
  });

  test('contient l\'instrumentation telemetrie shortcut', () => {
    expect(code).toContain("DMTelemetry.sendSpan('shortcut.click'");
  });

  test('contient le bloc d\'init DM + update banner', () => {
    expect(code).toContain('async function dmInit()');
    expect(code).toContain('DMBootstrap.init()');
    expect(code).toContain('DMTelemetry.init(');
    expect(code).toContain('dm-update-banner');
  });
});

describe('URL refactoring — options.js', () => {
  const code = readFile('options.js');

  test('utilise MiraiAuth au lieu du password grant', () => {
    expect(code).toContain('MiraiAuth.getValidToken');
    expect(code).not.toContain("grant_type: 'password'");
  });

  test('raccourcis options utilisent DMBootstrap', () => {
    expect(code).toContain("_sc.compteRenduUrl || 'https://compte-rendu.mirai.interieur.gouv.fr/'");
    expect(code).toContain("_sc.comuUrl || 'https://webconf.comu.gouv.fr/'");
    expect(code).toContain("_sc.visioUrl || 'https://visio.numerique.gouv.fr/'");
  });
});

describe('URL refactoring — auth.js', () => {
  const code = readFile('auth.js');

  test('utilise le flow PKCE avec code_challenge S256', () => {
    expect(code).toContain('code_challenge_method');
    expect(code).toContain("'S256'");
    expect(code).toContain('code_verifier');
  });

  test('contient l\'enrollment DM', () => {
    expect(code).toContain('_enrollInDM');
    expect(code).toContain('/enroll');
    expect(code).toContain('dm.enrollment');
  });

  test('supporte le relay DM (convention LibreOffice)', () => {
    expect(code).toContain('relayFetch');
    expect(code).toContain('relayAssistantBaseUrl');
    expect(code).toContain('X-Relay-Client');
    expect(code).toContain('X-Relay-Key');
  });
});

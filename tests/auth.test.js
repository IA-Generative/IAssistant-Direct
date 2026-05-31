// tests/auth.test.js

beforeEach(() => {
  __resetChromeStorage();
  jest.clearAllMocks();
  delete window.MiraiAuth;
  delete window.miraiUserUUID;

  // Mock crypto.subtle for PKCE (not available in jsdom)
  if (!global.crypto.subtle) {
    global.crypto.subtle = {};
  }
  global.crypto.subtle.digest = jest.fn(() => Promise.resolve(new ArrayBuffer(32)));

  // Polyfill TextEncoder for jsdom
  if (typeof TextEncoder === 'undefined') {
    global.TextEncoder = class { encode(s) { return new Uint8Array([...s].map(c => c.charCodeAt(0))); } };
  }

  // Mock CompatAPI
  window.CompatAPI = {
    getRedirectURL: jest.fn(() => 'https://test-extension-id.chromiumapp.org/'),
    storageGet: jest.fn((keys) => {
      return new Promise(resolve => chrome.storage.local.get(keys, resolve));
    }),
    storageSet: jest.fn((items) => {
      return new Promise(resolve => chrome.storage.local.set(items, resolve));
    }),
    storageRemove: jest.fn((keys) => {
      return new Promise(resolve => chrome.storage.local.remove(keys, resolve));
    }),
    launchWebAuthFlow: jest.fn()
  };

  // Mock DMBootstrap (convention LibreOffice: keycloakIssuerUrl includes /realms/{realm})
  window.DMBootstrap = {
    getConfig: () => ({
      keycloakIssuerUrl: 'https://sso.test.example.com/realms/test-realm',
      keycloakRealm: 'test-realm',
      keycloakClientId: 'test-client',
      bootstrap_url: 'https://relay.test.example.com'
    })
  };

  // Mock DMTelemetry
  window.DMTelemetry = { sendSpan: jest.fn() };

  // Load crypto.js FIRST (expose TokenStore globally), then auth.js — same order
  // as popup.html / options.html. auth.js stocke le token chiffré via TokenStore.
  const fs = require('fs');
  const path = require('path');
  eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'crypto.js'), 'utf8'));
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'auth.js'), 'utf8');
  eval(code);
});

describe('MiraiAuth', () => {

  describe('PKCE helpers', () => {
    test('_generateCodeVerifier retourne une chaine hex de 64 chars', () => {
      const verifier = window.MiraiAuth._generateCodeVerifier();
      expect(verifier).toHaveLength(64);
      expect(verifier).toMatch(/^[0-9a-f]+$/);
    });

    test('_generateCodeChallenge retourne un hash base64url', async () => {
      const verifier = 'test-verifier-123';
      const challenge = await window.MiraiAuth._generateCodeChallenge(verifier);
      expect(challenge).toBeTruthy();
      expect(challenge).not.toContain('+');
      expect(challenge).not.toContain('/');
      expect(challenge).not.toContain('=');
      expect(global.crypto.subtle.digest).toHaveBeenCalledWith('SHA-256', expect.any(Uint8Array));
    });

    test('_decodeJWT decode un token valide', () => {
      const payload = { sub: 'user-uuid-123', email: 'test@example.com' };
      const fakeJWT = 'header.' + btoa(JSON.stringify(payload)) + '.signature';
      const decoded = window.MiraiAuth._decodeJWT(fakeJWT);
      expect(decoded.sub).toBe('user-uuid-123');
      expect(decoded.email).toBe('test@example.com');
    });

    test('_decodeJWT retourne null si token invalide', () => {
      const decoded = window.MiraiAuth._decodeJWT('not-a-jwt');
      expect(decoded).toBeNull();
    });
  });

  describe('_getAuthConfig()', () => {
    test('retourne la config depuis DMBootstrap', () => {
      const cfg = window.MiraiAuth._getAuthConfig();
      expect(cfg.issuerUrl).toBe('https://sso.test.example.com/realms/test-realm');
      expect(cfg.clientId).toBe('test-client');
      expect(cfg.bootstrap_url).toBe('https://relay.test.example.com');
      expect(cfg.redirectUri).toBe('https://test-extension-id.chromiumapp.org/');
    });

    test('utilise les fallbacks si DMBootstrap absent', () => {
      delete window.DMBootstrap;
      const cfg = window.MiraiAuth._getAuthConfig();
      expect(cfg.issuerUrl).toBe('https://sso.mirai.interieur.gouv.fr/realms/mirai');
      expect(cfg.clientId).toBe('bootstrap-iassistant');
    });
  });

  describe('Token storage', () => {
    test('_storeToken et _getStoredToken round-trip', async () => {
      const token = { access_token: 'abc', refresh_token: 'def', expires_in: Date.now() + 3600000 };
      await window.MiraiAuth._storeToken(token);
      const stored = await window.MiraiAuth._getStoredToken();
      expect(stored.access_token).toBe('abc');
      expect(stored.refresh_token).toBe('def');
    });

    test('_clearToken supprime le token', async () => {
      __seedChromeStorage({ miraiToken: { access_token: 'old' } });
      await window.MiraiAuth._clearToken();
      const stored = await window.MiraiAuth._getStoredToken();
      expect(stored).toBeNull();
    });
  });

  describe('login() — token en cache valide', () => {
    test('retourne le token sans appel reseau', async () => {
      __seedChromeStorage({
        miraiToken: {
          access_token: 'cached-token',
          refresh_token: 'cached-refresh',
          expires_in: Date.now() + 3600000
        }
      });

      const token = await window.MiraiAuth.login();
      expect(token).toBe('cached-token');
      expect(global.fetch).not.toHaveBeenCalled();
      expect(window.CompatAPI.launchWebAuthFlow).not.toHaveBeenCalled();
    });
  });

  describe('login() — refresh token', () => {
    test('rafraichit le token si expire', async () => {
      __seedChromeStorage({
        miraiToken: {
          access_token: 'expired-token',
          refresh_token: 'valid-refresh',
          expires_in: Date.now() - 1000 // expired
        }
      });

      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          access_token: 'new-token',
          refresh_token: 'new-refresh',
          expires_in: 3600
        })
      });

      const token = await window.MiraiAuth.login();
      expect(token).toBe('new-token');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://sso.test.example.com/realms/test-realm/protocol/openid-connect/token',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('login() — PKCE flow complet', () => {
    test('lance le flow interactif si pas de token', async () => {
      // Silent attempt (launchWebAuthFlow interactive:false) fails...
      window.CompatAPI.launchWebAuthFlow
        .mockRejectedValueOnce(new Error('silent failed'));
      // ...then interactive flow opens a normal tab (v1.2.2: login via onglet
      // normal pour compatibilite gestionnaire de mots de passe).
      jest.spyOn(window.MiraiAuth, '_openTabAndWaitForCode')
        .mockResolvedValueOnce('AUTH_CODE_123');

      const fakePayload = { sub: 'user-uuid-abc' };
      const fakeJWT = 'h.' + btoa(JSON.stringify(fakePayload)) + '.s';
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({
            access_token: fakeJWT, refresh_token: 'new-refresh', expires_in: 3600
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ relay_token: 'relay-abc' })
        });

      const token = await window.MiraiAuth.login();

      expect(token).toBe(fakeJWT);
      expect(window.miraiUserUUID).toBe('user-uuid-abc');
      // Only the silent attempt goes through launchWebAuthFlow now.
      expect(window.CompatAPI.launchWebAuthFlow).toHaveBeenCalledTimes(1);
      expect(window.MiraiAuth._openTabAndWaitForCode).toHaveBeenCalledTimes(1);
      const interactiveUrl = window.MiraiAuth._openTabAndWaitForCode.mock.calls[0][0];
      expect(interactiveUrl).toContain('code_challenge');
      expect(interactiveUrl).toContain('S256');
      expect(window.DMTelemetry.sendSpan).toHaveBeenCalledWith('login.success', { method: 'pkce' });
    });

    test('retourne null si l\'utilisateur refuse l\'auth', async () => {
      window.CompatAPI.launchWebAuthFlow
        .mockRejectedValueOnce(new Error('silent failed'));
      jest.spyOn(window.MiraiAuth, '_openTabAndWaitForCode')
        .mockResolvedValueOnce(null);

      const token = await window.MiraiAuth.login();
      expect(token).toBeNull();
    });
  });

  describe('login({ force: true })', () => {
    test('supprime le token avant de relancer', async () => {
      __seedChromeStorage({
        miraiToken: { access_token: 'old', refresh_token: 'old-r', expires_in: Date.now() + 3600000 }
      });

      window.CompatAPI.launchWebAuthFlow
        .mockRejectedValueOnce(new Error('silent'));
      jest.spyOn(window.MiraiAuth, '_openTabAndWaitForCode')
        .mockResolvedValueOnce('NEW_CODE');

      const fakeJWT = 'h.' + btoa(JSON.stringify({ sub: 'u' })) + '.s';
      global.fetch
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: fakeJWT, refresh_token: 'r', expires_in: 3600 })
        })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

      const token = await window.MiraiAuth.login({ force: true });
      expect(token).toBe(fakeJWT);
      // force=true a bien purgé l'ancien token puis stocké le nouveau (chiffré).
      const stored = await window.MiraiAuth._getStoredToken();
      expect(stored.access_token).toBe(fakeJWT);
    });
  });

  describe('DM enrollment', () => {
    test('envoie les bons headers et stocke relayClientId/Key', async () => {
      __seedChromeStorage({ dmClientUUID: 'client-uuid-xyz' });
      global.fetch.mockReset();
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          ok: true,
          relayClientId: 'rc-123',
          relayClientKey: 'rk-456',
          relayKeyExpiresAt: 9999999999
        })
      });

      const result = await window.MiraiAuth._enrollInDM('my-access-token');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://relay.test.example.com/enroll',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'Bearer my-access-token',
            'X-Client-UUID': 'client-uuid-xyz'
          })
        })
      );

      // Verify enrollment body uses LibreOffice convention
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.device_name).toBe('mirai-browser');
      expect(body.plugin_uuid).toBe('client-uuid-xyz');

      const storage = __getChromeStorage();
      expect(storage.dmEnrollment).toBeDefined();
      expect(storage.dmEnrollment.enrolled).toBe(true);
      expect(storage.dmEnrollment.relayClientId).toBe('rc-123');
      expect(storage.dmEnrollment.relayClientKey).toBe('rk-456');
    });

    test('skip si pas de dmRelayUrl', async () => {
      global.fetch.mockReset();
      window.DMBootstrap = { getConfig: () => ({}) };
      const result = await window.MiraiAuth._enrollInDM('token');
      expect(result).toBeNull();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('ne plante pas si le relay echoue', async () => {
      global.fetch.mockReset();
      global.fetch.mockRejectedValueOnce(new Error('Network error'));
      const result = await window.MiraiAuth._enrollInDM('token');
      expect(result).toBeNull();
    });
  });

  describe('getValidToken()', () => {
    test('retourne le token si valide', async () => {
      __seedChromeStorage({
        miraiToken: { access_token: 'valid', expires_in: Date.now() + 3600000 }
      });
      const token = await window.MiraiAuth.getValidToken();
      expect(token).toBe('valid');
    });

    test('retourne null si pas de token', async () => {
      const token = await window.MiraiAuth.getValidToken();
      expect(token).toBeNull();
    });
  });

  describe('verifyToken()', () => {
    test('retourne true si userinfo ok', async () => {
      global.fetch.mockReset();
      global.fetch.mockResolvedValueOnce({ ok: true });
      const valid = await window.MiraiAuth.verifyToken('token');
      expect(valid).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://sso.test.example.com/realms/test-realm/protocol/openid-connect/userinfo',
        expect.objectContaining({ headers: { Authorization: 'Bearer token' } })
      );
    });

    test('retourne false si 401', async () => {
      global.fetch.mockReset();
      global.fetch.mockResolvedValueOnce({ ok: false, status: 401 });
      const valid = await window.MiraiAuth.verifyToken('bad-token');
      expect(valid).toBe(false);
    });
  });

  describe('logout()', () => {
    test('supprime token et enrollment', async () => {
      __seedChromeStorage({
        miraiToken: { access_token: 'x' },
        dmEnrollment: { enrolled: true }
      });

      await window.MiraiAuth.logout();

      const storage = __getChromeStorage();
      expect(storage.miraiToken).toBeUndefined();
      expect(storage.dmEnrollment).toBeUndefined();
      expect(window.DMTelemetry.sendSpan).toHaveBeenCalledWith('logout', {});
    });
  });

  describe('isDMEnrolled()', () => {
    test('retourne true si enrolled', async () => {
      __seedChromeStorage({ dmEnrollment: { enrolled: true } });
      expect(await window.MiraiAuth.isDMEnrolled()).toBe(true);
    });

    test('retourne false si pas enrolled', async () => {
      expect(await window.MiraiAuth.isDMEnrolled()).toBe(false);
    });
  });
});

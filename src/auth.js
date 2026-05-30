// src/auth.js — Shared PKCE authentication + DM enrollment
// Loaded via <script> in popup.html and options.html (after compat.js and dm/bootstrap.js)

window.MiraiAuth = {

  // ──────────────────────────────────────────────
  // PKCE helpers
  // ──────────────────────────────────────────────

  _generateCodeVerifier() {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map(b => ('0' + b.toString(16)).slice(-2)).join('');
  },

  async _generateCodeChallenge(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode.apply(null, new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },

  _decodeJWT(token) {
    try {
      return JSON.parse(atob(token.split('.')[1]));
    } catch (e) {
      console.warn('[MirAI Auth] Failed to decode JWT:', e);
      return null;
    }
  },

  // ──────────────────────────────────────────────
  // Config helpers
  // ──────────────────────────────────────────────

  _getAuthConfig() {
    const cfg = window.DMBootstrap?.getConfig() || {};
    const issuerUrl = this._normalizeRealmBase(
      cfg.keycloakIssuerUrl || 'https://sso.mirai.interieur.gouv.fr/realms/mirai',
      cfg.keycloakRealm || ''
    );
    return {
      issuerUrl: issuerUrl,
      clientId: cfg.keycloakClientId || 'bootstrap-iassistant',
      redirectUri: window.CompatAPI.getRedirectURL(),
      bootstrap_url: cfg.bootstrap_url || null
    };
  },

  /**
   * Normalize Keycloak issuer URL.
   * Same logic as AssistantMiraiLibreOffice._normalize_keycloak_realm_base:
   * - If URL already contains /realms/, use as-is (realm param ignored)
   * - If URL has no /realms/ and realm is provided, append /realms/{realm}
   */
  _normalizeRealmBase(baseUrl, realm) {
    const base = (baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) return '';
    if (base.includes('/realms/')) return base;
    if (realm) return `${base}/realms/${realm.trim()}`;
    return base;
  },

  _buildAuthEndpoint(cfg) {
    return `${cfg.issuerUrl}/protocol/openid-connect/auth`;
  },

  _buildTokenEndpoint(cfg) {
    return `${cfg.issuerUrl}/protocol/openid-connect/token`;
  },

  _buildUserinfoEndpoint(cfg) {
    return `${cfg.issuerUrl}/protocol/openid-connect/userinfo`;
  },

  // ──────────────────────────────────────────────
  // Token storage
  // ──────────────────────────────────────────────

  // Token stocké CHIFFRÉ au repos via TokenStore (crypto.js). TokenStore gère
  // aussi la migration transparente d'un éventuel ancien token en clair.
  async _getStoredToken() {
    return await TokenStore.getToken();
  },

  async _storeToken(tokenData) {
    await TokenStore.storeToken(tokenData);
  },

  async _clearToken() {
    await TokenStore.clearToken();
  },

  // ──────────────────────────────────────────────
  // Tab-based auth (opens normal tab, waits for callback)
  // ──────────────────────────────────────────────

  /**
   * Open a normal browser tab for Keycloak login.
   * callback.html sends the auth code to background.js.
   * We poll background.js until the code arrives or timeout.
   */
  _openTabAndWaitForCode(authUrl) {
    return new Promise((resolve) => {
      const B = (typeof browser !== 'undefined') ? browser : chrome;

      // Open the login tab
      B.tabs.create({ url: authUrl });

      // Poll background.js for the code every 500ms, timeout 120s
      const maxAttempts = 240;
      let attempts = 0;

      const poll = setInterval(() => {
        attempts++;
        B.runtime.sendMessage({ type: 'pkce:getCode' }, (response) => {
          if (response?.code) {
            clearInterval(poll);
            console.info('[MirAI Auth] Auth code received from background.');
            resolve(response.code);
          } else if (attempts >= maxAttempts) {
            clearInterval(poll);
            console.warn('[MirAI Auth] Tab auth timeout (120s).');
            resolve(null);
          }
        });
      }, 500);
    });
  },

  // ──────────────────────────────────────────────
  // Token refresh (silent)
  // ──────────────────────────────────────────────

  async _refreshToken(cfg, refreshToken) {
    const resp = await fetch(this._buildTokenEndpoint(cfg), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: cfg.clientId,
        refresh_token: refreshToken
      })
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    const tokenData = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || refreshToken,
      expires_in: Date.now() + (data.expires_in * 1000)
    };
    await this._storeToken(tokenData);
    console.info('[MirAI Auth] Token refreshed silently.');
    return tokenData;
  },

  // ──────────────────────────────────────────────
  // Code exchange (PKCE)
  // ──────────────────────────────────────────────

  async _exchangeCodeForToken(cfg, authCode, codeVerifier) {
    const resp = await fetch(this._buildTokenEndpoint(cfg), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: cfg.clientId,
        code: authCode,
        redirect_uri: cfg.redirectUri,
        code_verifier: codeVerifier
      })
    });

    if (!resp.ok) {
      console.warn('[MirAI Auth] Token exchange failed:', resp.status);
      return null;
    }

    const data = await resp.json();
    if (!data.access_token) {
      console.warn('[MirAI Auth] No access_token in response.');
      return null;
    }

    const tokenData = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: Date.now() + (data.expires_in * 1000)
    };
    await this._storeToken(tokenData);
    return tokenData;
  },

  // ──────────────────────────────────────────────
  // DM Enrollment
  // ──────────────────────────────────────────────

  async _enrollInDM(accessToken) {
    const cfg = window.DMBootstrap?.getConfig() || {};
    const bootstrapUrl = cfg.bootstrap_url;
    if (!bootstrapUrl) {
      console.info('[MirAI Auth] No bootstrap_url configured, skipping enrollment.');
      return null;
    }

    try {
      const { dmClientUUID } = await window.CompatAPI.storageGet({ dmClientUUID: null });
      const B = (typeof browser !== 'undefined') ? browser : chrome;
      const manifest = B.runtime.getManifest();

      const resp = await fetch(`${bootstrapUrl}/enroll`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'X-Client-UUID': dmClientUUID || '',
          'X-Plugin-Version': manifest.version,
          'X-Platform-Type': (typeof browser !== 'undefined') ? 'firefox' : 'chrome'
        },
        body: JSON.stringify({
          device_name: 'mirai-browser',
          plugin_uuid: dmClientUUID,
          email: '',
          plugin_version: manifest.version
        })
      });

      if (resp.ok) {
        const payload = await resp.json();
        // Store relay credentials (same convention as LibreOffice)
        const relay = payload.relay || {};
        const relayClientId = payload.relayClientId || relay.client_id || '';
        const relayClientKey = payload.relayClientKey || relay.client_key || '';
        const relayExpiresAt = payload.relayKeyExpiresAt || relay.expires_at || 0;

        await window.CompatAPI.storageSet({
          dmEnrollment: {
            enrolled: true,
            enrolledAt: Date.now(),
            relayClientId: relayClientId,
            relayClientKey: relayClientKey,
            relayKeyExpiresAt: relayExpiresAt
          }
        });
        console.info('[MirAI Auth] DM enrollment successful.');
        if (window.DMTelemetry) window.DMTelemetry.sendSpan('dm.enrollment', { status: 'success' });
        return payload;
      } else {
        console.warn('[MirAI Auth] DM enrollment failed:', resp.status);
        if (window.DMTelemetry) window.DMTelemetry.sendSpan('dm.enrollment', { status: 'failed', code: resp.status });
        return null;
      }
    } catch (err) {
      console.warn('[MirAI Auth] DM enrollment error:', err.message);
      return null;
    }
  },

  // ──────────────────────────────────────────────
  // Main PKCE flow
  // ──────────────────────────────────────────────

  /**
   * Authenticate via Keycloak PKCE + enroll in DM.
   *
   * @param {Object} options
   * @param {boolean} options.force    - Force re-authentication (clear stored token)
   * @param {string}  options.loginHint - Pre-fill login field in Keycloak
   * @returns {Promise<string|null>}   - access_token or null
   */
  async login(options = {}) {
    const { force = false, loginHint = '' } = options;

    try {
      const cfg = this._getAuthConfig();

      // Force: clear stored token
      if (force) {
        console.info('[MirAI Auth] Forced re-authentication.');
        await this._clearToken();
      }

      // 1. Check if stored token is still valid
      const stored = await this._getStoredToken();
      if (stored && stored.access_token && stored.expires_in > Date.now()) {
        console.info('[MirAI Auth] Valid token found in storage.');
        return stored.access_token;
      }

      // 2. Try refresh via refresh_token
      if (stored && stored.refresh_token) {
        const refreshed = await this._refreshToken(cfg, stored.refresh_token);
        if (refreshed) return refreshed.access_token;
        console.warn('[MirAI Auth] Refresh failed, starting PKCE flow.');
      }

      // 3. Generate PKCE challenge
      const codeVerifier = this._generateCodeVerifier();
      const codeChallenge = await this._generateCodeChallenge(codeVerifier);

      // Callback URL = extension page that receives the auth code
      const B = (typeof browser !== 'undefined') ? browser : chrome;
      const callbackUrl = B.runtime.getURL('src/callback.html');

      const silentParams = {
        client_id: cfg.clientId,
        response_type: 'code',
        scope: 'openid profile email offline_access',
        redirect_uri: cfg.redirectUri,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      };

      const tabParams = {
        client_id: cfg.clientId,
        response_type: 'code',
        scope: 'openid profile email offline_access',
        redirect_uri: callbackUrl,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256'
      };

      // 4. Try silent auth via launchWebAuthFlow (SSO cookie, no UI)
      let authCode = null;
      let usedRedirectUri = cfg.redirectUri; // track which redirect_uri was used
      try {
        const silentUrl = this._buildAuthEndpoint(cfg) + '?' +
          new URLSearchParams({ ...silentParams, prompt: 'none' });
        console.info('[MirAI Auth] Silent auth URL:', silentUrl);
        const silentResponse = await window.CompatAPI.launchWebAuthFlow({
          url: silentUrl,
          interactive: false
        });
        if (silentResponse) {
          const code = new URL(silentResponse).searchParams.get('code');
          if (code) {
            authCode = code;
            usedRedirectUri = cfg.redirectUri;
            console.info('[MirAI Auth] Silent auth succeeded.');
          } else {
            console.info('[MirAI Auth] Silent auth returned error:', new URL(silentResponse).searchParams.get('error') || 'no code');
          }
        }
      } catch (e) {
        console.info('[MirAI Auth] Silent auth failed:', e.message);
      }

      // 5. Interactive auth: open a normal tab (password manager works)
      if (!authCode) {
        console.info('[MirAI Auth] Starting interactive PKCE flow (tab)...');
        const interactiveTabParams = { ...tabParams, prompt: 'login' };
        if (loginHint) interactiveTabParams.login_hint = loginHint;

        const interactiveUrl = this._buildAuthEndpoint(cfg) + '?' +
          new URLSearchParams(interactiveTabParams);
        console.info('[MirAI Auth] Interactive auth URL:', interactiveUrl);

        authCode = await this._openTabAndWaitForCode(interactiveUrl);
        usedRedirectUri = callbackUrl;
      }

      if (!authCode) {
        console.warn('[MirAI Auth] No auth code received.');
        return null;
      }

      // 7. Exchange code for token (must use same redirect_uri as auth request)
      const tokenData = await this._exchangeCodeForToken(
        { ...cfg, redirectUri: usedRedirectUri }, authCode, codeVerifier
      );
      if (!tokenData) return null;

      // 8. Extract user UUID from JWT
      const payload = this._decodeJWT(tokenData.access_token);
      if (payload?.sub) {
        window.miraiUserUUID = payload.sub;
        console.info('[MirAI Auth] User UUID:', payload.sub);
      }

      // 9. Enroll in DM (non-blocking)
      this._enrollInDM(tokenData.access_token).catch(() => {});

      console.info('[MirAI Auth] PKCE authentication successful.');
      if (window.DMTelemetry) window.DMTelemetry.sendSpan('login.success', { method: 'pkce' });
      return tokenData.access_token;

    } catch (err) {
      console.error('[MirAI Auth] PKCE error:', err);
      if (window.DMTelemetry) window.DMTelemetry.sendSpan('login.failure', { error: err.message });
      return null;
    }
  },

  // ──────────────────────────────────────────────
  // Convenience methods
  // ──────────────────────────────────────────────

  /**
   * Get a valid token (refresh if needed, no interactive prompt).
   * Returns null if no valid session exists.
   */
  async getValidToken() {
    const stored = await this._getStoredToken();
    if (!stored) return null;

    if (stored.access_token && stored.expires_in > Date.now()) {
      return stored.access_token;
    }

    if (stored.refresh_token) {
      const cfg = this._getAuthConfig();
      const refreshed = await this._refreshToken(cfg, stored.refresh_token);
      return refreshed ? refreshed.access_token : null;
    }

    return null;
  },

  /**
   * Ensure a valid token exists, prompting login if needed.
   */
  async ensureAuthenticated(options = {}) {
    const token = await this.getValidToken();
    if (token) return token;
    return this.login(options);
  },

  /**
   * Verify token against Keycloak userinfo endpoint.
   */
  async verifyToken(accessToken) {
    const cfg = this._getAuthConfig();
    try {
      const resp = await fetch(this._buildUserinfoEndpoint(cfg), {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      return resp.ok;
    } catch {
      return false;
    }
  },

  /**
   * Logout: clear token + DM enrollment.
   */
  async logout() {
    await this._clearToken();
    await window.CompatAPI.storageRemove('dmEnrollment');
    console.info('[MirAI Auth] Logged out.');
    if (window.DMTelemetry) window.DMTelemetry.sendSpan('logout', {});
  },

  /**
   * Check if enrolled in DM.
   */
  async isDMEnrolled() {
    const { dmEnrollment } = await window.CompatAPI.storageGet({ dmEnrollment: null });
    return !!(dmEnrollment && dmEnrollment.enrolled);
  },

  /**
   * Get relay headers if enrolled (same convention as LibreOffice).
   * Returns { X-Relay-Client, X-Relay-Key } or empty object.
   */
  async _getRelayHeaders() {
    const { dmEnrollment } = await window.CompatAPI.storageGet({ dmEnrollment: null });
    if (!dmEnrollment?.relayClientId || !dmEnrollment?.relayClientKey) return {};
    return {
      'X-Relay-Client': dmEnrollment.relayClientId,
      'X-Relay-Key': dmEnrollment.relayClientKey
    };
  },

  /**
   * Make an authenticated fetch through the DM relay-assistant (if available).
   * Uses relayAssistantBaseUrl from DM config + relay credentials from enrollment.
   * Falls back to direct fetch if no relay configured.
   */
  async relayFetch(path, options = {}) {
    const cfg = window.DMBootstrap?.getConfig() || {};
    const token = await this.getValidToken();

    if (!token) throw new Error('Not authenticated');

    const headers = {
      ...options.headers,
      'Authorization': `Bearer ${token}`
    };

    // Use relay-assistant if URL configured and enrolled
    const relayBaseUrl = cfg.relayAssistantBaseUrl;
    if (relayBaseUrl) {
      const relayHeaders = await this._getRelayHeaders();
      Object.assign(headers, relayHeaders);
      const url = `${relayBaseUrl.replace(/\/+$/, '')}${path}`;
      return fetch(url, { ...options, headers });
    }

    // Direct fallback (no relay)
    const apiBase = cfg.apiBase || 'https://compte-rendu.mirai.interieur.gouv.fr/api';
    return fetch(`${apiBase}${path}`, { ...options, headers });
  }
};

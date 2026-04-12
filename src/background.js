// background.js — service worker (pas de DOM ici)
const api = typeof browser !== 'undefined' ? browser : chrome;

// Import recording.js functions (shared with popup)
try { importScripts('recording.js'); } catch (e) { console.warn('[MirAI] importScripts recording.js:', e.message); }

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// ======================================================================
// DM — Client UUID + periodic config refresh
// ======================================================================
api.runtime.onInstalled.addListener(async (details) => {
  // Generate client UUID on first install
  const { dmClientUUID } = await api.storage.local.get('dmClientUUID');
  if (!dmClientUUID) {
    await api.storage.local.set({ dmClientUUID: crypto.randomUUID() });
    console.info('[MirAI DM] Client UUID generated.');
  }

  // Create alarm for periodic config refresh (every 30 min)
  api.alarms.create('dm-config-refresh', { periodInMinutes: 30 });
  console.info('[MirAI DM] Config refresh alarm created (every 30 min).');
});

// Handle config refresh alarm
api.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'dm-config-refresh') return;

  console.info('[MirAI DM] Alarm triggered: refreshing config...');
  try {
    const { dmClientUUID, dmConfig: cachedConfig } = await api.storage.local.get(['dmClientUUID', 'dmConfig']);
    const manifest = api.runtime.getManifest();

    // Read DM params from cached config (set by bootstrap.js at popup init)
    const bootstrapUrl = cachedConfig?.bootstrap_url || 'https://bootstrap.fake-domain.name';
    const configPath = cachedConfig?.config_path || '/config/mirai-browser/config.json?profile=int';

    const resp = await fetch(`${bootstrapUrl}${configPath}`, {
      headers: {
        'X-Plugin-Version': manifest.version,
        'X-Client-UUID': dmClientUUID || '',
        'X-Platform-Type': (typeof browser !== 'undefined') ? 'firefox' : 'chrome',
        'X-Platform-Version': navigator.userAgent
      }
    });

    if (resp.ok) {
      const config = await resp.json();
      await api.storage.local.set({ dmConfig: config, dmConfigLastFetch: Date.now() });
      console.info('[MirAI DM] Config refreshed from DM.');

      // Check for update directive
      if (config.update && config.update.action === 'update') {
        const currentVersion = manifest.version;
        if (config.update.target_version && config.update.target_version !== currentVersion) {
          api.notifications.create('dm-update', {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'Mise a jour disponible',
            message: `MirAI Recorder ${config.update.target_version} est disponible.`
          });
          await api.storage.local.set({ dmUpdateAvailable: config.update });
        }
      }
    } else {
      console.warn('[MirAI DM] Config refresh failed:', resp.status);
    }
  } catch (err) {
    console.warn('[MirAI DM] Config refresh error (DM unreachable):', err.message);
  }
});

// ======================================================================
// Messages
// ======================================================================
// ======================================================================
// Token refresh helper (used by overlay handlers)
// ======================================================================
async function _ensureTokenFresh() {
  let { miraiToken } = await api.storage.local.get({ miraiToken: null });
  if (!miraiToken?.access_token) throw new Error('Non connecte (SSO)');

  if (miraiToken.expires_in < Date.now() && miraiToken.refresh_token) {
    console.info('[MirAI] Token expired, refreshing...');
    const { dmConfig } = await api.storage.local.get({ dmConfig: null });
    const issuerUrl = (dmConfig?.keycloakIssuerUrl || 'https://sso.mirai.interieur.gouv.fr').replace(/\/+$/, '');
    // Realm must NOT fall back to 'mirai' when explicitly empty (DGX relay
    // exposes /keycloak/protocol/... without a realm segment in the path;
    // the real realm is injected server-side via RELAY_KEYCLOAK_UPSTREAM).
    const realm = dmConfig?.keycloakRealm;
    const clientId = dmConfig?.keycloakClientId || 'mirai-extension';
    let tokenUrl = issuerUrl;
    if (!issuerUrl.includes('/realms/') && realm) {
      tokenUrl = `${issuerUrl}/realms/${realm}`;
    }
    tokenUrl += '/protocol/openid-connect/token';

    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: miraiToken.refresh_token
      })
    });
    if (resp.ok) {
      const data = await resp.json();
      miraiToken = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || miraiToken.refresh_token,
        expires_in: Date.now() + (data.expires_in * 1000)
      };
      await api.storage.local.set({ miraiToken });
      console.info('[MirAI] Token refreshed in background.');
    } else {
      throw new Error('Refresh token echoue');
    }
  }
}

// Store pending PKCE state
let _pendingPkceCode = null;
let _pendingPkceVerifier = null;
let _pendingPkceRedirectUri = null;
let _pendingPkceClientId = null;
let _pendingPkceTokenUrl = null;

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'record:finished') {
    console.log('[MirAI] Enregistrement terminé', msg.payload);
    sendResponse({ ok: true });
    return;
  }

  if (msg?.type === 'pkce:callback' && msg.code) {
    console.info('[MirAI] PKCE callback received, code:', msg.code.substring(0, 8) + '...');
    _pendingPkceCode = msg.code;

    // If we have a pending verifier (from overlay:pkceLogin), exchange immediately
    if (_pendingPkceVerifier && _pendingPkceTokenUrl) {
      (async () => {
        try {
          const resp = await fetch(_pendingPkceTokenUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              client_id: _pendingPkceClientId,
              code: msg.code,
              redirect_uri: _pendingPkceRedirectUri,
              code_verifier: _pendingPkceVerifier
            })
          });
          if (resp.ok) {
            const data = await resp.json();
            await api.storage.local.set({
              miraiToken: {
                access_token: data.access_token,
                refresh_token: data.refresh_token,
                expires_in: Date.now() + (data.expires_in * 1000)
              }
            });
            console.info('[MirAI] Token obtained via overlay PKCE login.');
          }
        } catch (e) {
          console.error('[MirAI] Token exchange failed:', e);
        }
        _pendingPkceVerifier = null;
        _pendingPkceRedirectUri = null;
        _pendingPkceClientId = null;
        _pendingPkceTokenUrl = null;
      })();
    }

    sendResponse({ ok: true });
    return;
  }

  if (msg?.type === 'pkce:getCode') {
    const code = _pendingPkceCode;
    _pendingPkceCode = null;
    sendResponse({ code: code || null });
    return;
  }

  // Overlay: start recording — delegates to recording.js (imported via importScripts)
  if (msg?.type === 'overlay:startRecording' && msg.data) {
    (async () => {
      try {
        // Ensure token is fresh (refresh if expired)
        await _ensureTokenFresh();

        const result = await startMiraiRecording(msg.data);
        if (result && result.id) {
          // Save to recordings storage
          const { recordings = [] } = await api.storage.local.get({ recordings: [] });
          recordings.unshift({
            id: result.id,
            ts: new Date().toISOString(),
            url: msg.data.url,
            platform: msg.data.platform,
            login: msg.data.login,
            status: 'CAPTURE_IN_PROGRESS',
            meeting_id: result.id
          });
          await api.storage.local.set({ recordings: recordings.slice(0, 20) });
          console.info('[MirAI] Overlay: recording started', result.id);
          sendResponse({ ok: true, meetingId: result.id });
        } else {
          sendResponse({ ok: false, error: 'Echec demarrage' });
        }
      } catch (err) {
        console.error('[MirAI] Overlay: start error', err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // Overlay: stop recording — delegates to recording.js
  if (msg?.type === 'overlay:stopRecording' && msg.url) {
    (async () => {
      try {
        await _ensureTokenFresh();

        const { recordings = [] } = await api.storage.local.get({ recordings: [] });
        const rec = recordings.find(r => r.url === msg.url && (r.status === 'CAPTURE_IN_PROGRESS' || r.status === 'CAPTURE_PENDING'));
        if (!rec?.id) {
          sendResponse({ ok: false, error: 'Aucun enregistrement en cours' });
          return;
        }

        const stopped = await stopMiraiRecording({ meeting_id: rec.id });
        rec.status = 'STOPPED';
        rec.durationMs = Date.now() - new Date(rec.ts).getTime();
        await api.storage.local.set({ recordings });

        console.info('[MirAI] Overlay: recording stopped', rec.id);
        sendResponse({ ok: true });
      } catch (err) {
        console.error('[MirAI] Overlay: stop error', err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // Overlay: sync recordings with API
  if (msg?.type === 'overlay:syncRecordings') {
    (async () => {
      try {
        await _ensureTokenFresh();
        await syncRecordingsWithAPI();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }

  // Overlay: check if a recording is active for this platform/url via API
  if (msg?.type === 'overlay:checkActive') {
    (async () => {
      try {
        await _ensureTokenFresh();
        const { miraiToken } = await api.storage.local.get({ miraiToken: null });
        const { dmConfig } = await api.storage.local.get({ dmConfig: null });
        const apiBase = dmConfig?.apiBase || 'https://compte-rendu.mirai.interieur.gouv.fr/api';
        const token = miraiToken?.access_token;
        if (!token) { sendResponse({ active: false }); return; }

        const resp = await fetch(`${apiBase}/meetings?per_page=100`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!resp.ok) { sendResponse({ active: false }); return; }

        const data = await resp.json();
        const meetings = Array.isArray(data) ? data : (data.data || []);
        const platform = (msg.platform || '').toUpperCase();
        const login = msg.login || '';
        const pageUrl = msg.url || '';

        const active = meetings.find(m => {
          if (m.status !== 'CAPTURE_IN_PROGRESS' && m.status !== 'CAPTURE_PENDING') return false;
          const mp = (m.name_platform || '').toUpperCase();
          if (mp === platform) return true;
          if (m.meeting_platform_id && m.meeting_platform_id === login) return true;
          if (m.url && pageUrl.includes(m.url)) return true;
          return false;
        });

        if (active) {
          // Update local storage too
          const { recordings = [] } = await api.storage.local.get({ recordings: [] });
          const exists = recordings.some(r => r.id === active.id);
          if (!exists) {
            recordings.unshift({
              id: active.id, meeting_id: active.id,
              ts: active.creation_date || new Date().toISOString(),
              url: pageUrl, platform: platform.toLowerCase(),
              login: active.meeting_platform_id || login,
              status: active.status
            });
            await api.storage.local.set({ recordings: recordings.slice(0, 20) });
          } else {
            const rec = recordings.find(r => r.id === active.id);
            if (rec && rec.status !== active.status) {
              rec.status = active.status;
              await api.storage.local.set({ recordings });
            }
          }
          sendResponse({ active: true, meetingId: active.id, ts: active.creation_date });
        } else {
          sendResponse({ active: false });
        }
      } catch (e) {
        console.warn('[MirAI] overlay:checkActive error:', e.message);
        sendResponse({ active: false });
      }
    })();
    return true;
  }

  // Overlay: trigger PKCE login directly (opens Keycloak in a tab)
  if (msg?.type === 'overlay:pkceLogin') {
    (async () => {
      try {
        const { dmConfig } = await api.storage.local.get({ dmConfig: null });
        const issuerUrl = (dmConfig?.keycloakIssuerUrl || 'https://sso.mirai.interieur.gouv.fr').replace(/\/+$/, '');
        // Realm must NOT fall back to 'mirai' when explicitly empty (DGX relay
        // exposes /keycloak/protocol/... without a realm segment in the path;
        // the real realm is injected server-side via RELAY_KEYCLOAK_UPSTREAM).
        const realm = dmConfig?.keycloakRealm;
        const clientId = dmConfig?.keycloakClientId || 'mirai-extension';
        let authBase = issuerUrl;
        if (!issuerUrl.includes('/realms/') && realm) {
          authBase = `${issuerUrl}/realms/${realm}`;
        }

        const callbackUrl = api.runtime.getURL('src/callback.html');

        // Generate PKCE
        const verifierBytes = new Uint8Array(32);
        crypto.getRandomValues(verifierBytes);
        const codeVerifier = Array.from(verifierBytes).map(b => ('0' + b.toString(16)).slice(-2)).join('');
        const challengeBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
        const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(challengeBuffer)))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

        const authUrl = `${authBase}/protocol/openid-connect/auth?` + new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          scope: 'openid profile email',
          redirect_uri: callbackUrl,
          code_challenge: codeChallenge,
          code_challenge_method: 'S256',
          prompt: 'login'
        });

        // Store verifier for token exchange when callback arrives
        _pendingPkceVerifier = codeVerifier;
        _pendingPkceRedirectUri = callbackUrl;
        _pendingPkceClientId = clientId;
        _pendingPkceTokenUrl = `${authBase}/protocol/openid-connect/token`;

        api.tabs.create({ url: authUrl });
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[MirAI] overlay:pkceLogin error:', e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
});
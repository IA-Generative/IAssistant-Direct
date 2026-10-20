// background.js — service worker (pas de DOM ici)
const api = typeof browser !== 'undefined' ? browser : chrome;

// Chrome (service worker) : les modules partagés sont importés ici.
// Firefox ESR (pas de service worker) : ils sont listés dans manifest `background.scripts`
// AVANT background.js, et importScripts n'existe pas dans une page d'arrière-plan.
if (typeof importScripts === 'function') {
  // Import crypto.js (TokenStore) FIRST — recording.js et les handlers token en dépendent.
  try { importScripts('crypto.js'); } catch (e) { console.warn('[MirAI] importScripts crypto.js:', e.message); }
  // Import DMBootstrap (client config DM) — source unique de la config (issuer/realm…)
  try { importScripts('dm/bootstrap.js'); } catch (e) { console.warn('[MirAI] importScripts bootstrap.js:', e.message); }
  // Import recording.js functions (shared with popup)
  try { importScripts('recording.js'); } catch (e) { console.warn('[MirAI] importScripts recording.js:', e.message); }
  // Mes collections (bulle « + IA ») : motifs, doublure, sites déclarés
  try { importScripts('mescollections/correspond.js', 'mescollections/doublure.js', 'mescollections/sites.js', 'mescollections/api.js'); } catch (e) { console.warn('[MirAI] importScripts mescollections:', e.message); }
}

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

  // Premier lancement : page de bienvenue (onboarding + invite a se connecter).
  if (details.reason === 'install') {
    try {
      api.tabs.create({ url: api.runtime.getURL('src/welcome.html') });
      console.info('[MirAI] First launch : welcome page opened.');
    } catch (e) {
      console.warn('[MirAI] Could not open welcome page:', e.message);
    }
  }
});

// Handle config refresh alarm
api.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'dm-config-refresh') return;

  console.info('[MirAI DM] Alarm triggered: refreshing config...');
  try {
    const { dmClientUUID, dmConfig: cachedConfig } = await api.storage.local.get(['dmClientUUID', 'dmConfig']);
    const manifest = api.runtime.getManifest();

    // Resout le DM a interroger : URL collante (dernier resolu) si elle repond,
    // sinon scan ordonne (preference > pousse DM > liste bakee). Retombe sur la
    // config cachee si DMBootstrap indisponible.
    let bootstrapUrl = null;
    try {
      if (typeof DMBootstrap !== 'undefined') {
        bootstrapUrl = await DMBootstrap.resolveBootstrap();
      }
    } catch (e) {
      console.warn('[MirAI DM] resolveBootstrap failed:', e.message);
    }
    bootstrapUrl = bootstrapUrl || cachedConfig?.bootstrap_url || 'https://bootstrap.fake-domain.name';
    const configPath = cachedConfig?.config_path || '/config/iassistant-direct-browser/config.json?profile=prod';

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
      // Stocke la config APLATIE (keycloak* au top-level), cohérent avec bootstrap.js
      // et avec ce que lisent overlay:pkceLogin / _ensureTokenFresh / DMBootstrap.
      const flat = config.config || config;
      await api.storage.local.set({ dmConfig: flat, dmConfigLastFetch: Date.now() });
      console.info('[MirAI DM] Config refreshed from DM.');

      // Directive d'update lue sur l'objet brut (sibling de `config`)
      if (config.update && config.update.action === 'update') {
        const currentVersion = manifest.version;
        if (config.update.target_version && config.update.target_version !== currentVersion) {
          api.notifications.create('dm-update', {
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: 'Mise a jour disponible',
            message: `IAssistant-Direct (by Mirai) ${config.update.target_version} est disponible.`
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
/**
 * Garantit un jeton d'accès frais (rafraîchissement silencieux si expiré).
 * @param {{force?: boolean}} options - force : rafraîchit même si non expiré (401 reçu).
 * @returns {Promise<object>} le token déchiffré {access_token, refresh_token, expires_in}
 */
async function _ensureTokenFresh(options = {}) {
  let miraiToken = await TokenStore.getToken();
  if (!miraiToken?.access_token) throw new Error('Non connecte (SSO)');

  const doitRafraichir = !!options.force || miraiToken.expires_in < Date.now();
  if (doitRafraichir && miraiToken.refresh_token) {
    console.info('[MirAI] Token expired or refresh forced, refreshing...');
    // Config via DMBootstrap en ASYNC : dans le service worker, _configCache peut
    // etre vide (SW relance) et _readLocalConfig (XHR sync) n'existe pas en SW —
    // getConfigAsync() relit le dmConfig PERSISTE (valeurs servies par le DM, ex.
    // l'issuer resolu), au lieu de retomber sur le fallback hardcode sso.mirai.
    let dmConfig = {};
    try { dmConfig = await DMBootstrap.getConfigAsync(); } catch (_) {}
    const issuerUrl = (dmConfig?.keycloakIssuerUrl || 'https://sso.mirai.interieur.gouv.fr/realms/mirai').replace(/\/+$/, '');
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
      await TokenStore.storeToken(miraiToken);
      console.info('[MirAI] Token refreshed in background.');
    } else {
      throw new Error('Refresh token echoue');
    }
  }
  return miraiToken;
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
            await TokenStore.storeToken({
              access_token: data.access_token,
              refresh_token: data.refresh_token,
              expires_in: Date.now() + (data.expires_in * 1000)
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

  // Overlay: check auth status (non-interactive — refresh si expire, sinon authed:false)
  if (msg?.type === 'overlay:checkAuth') {
    (async () => {
      try {
        await _ensureTokenFresh();
        sendResponse({ authed: true });
      } catch (e) {
        sendResponse({ authed: false });
      }
    })();
    return true;
  }

  // Overlay: check if a recording is active for this platform/url via API
  if (msg?.type === 'overlay:checkActive') {
    (async () => {
      try {
        await _ensureTokenFresh();
        const miraiToken = await TokenStore.getToken();
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
        // Config via DMBootstrap (MÊME source que le popup) — issuer/realm fiables :
        // fetch DM si possible, sinon config locale bakée, sinon fallback (tous avec realm).
        let dmConfig = {};
        try { dmConfig = await DMBootstrap.init(); }
        catch (_) { try { dmConfig = await DMBootstrap.getConfigAsync(); } catch (_2) {} }
        const issuerUrl = (dmConfig?.keycloakIssuerUrl || 'https://sso.mirai.interieur.gouv.fr/realms/mirai').replace(/\/+$/, '');
        const realm = dmConfig?.keycloakRealm;
        const clientId = dmConfig?.keycloakClientId || 'mirai-extension';
        // issuer servi (= sso.mirai sans /realms) + realm -> ajoute /realms/{realm} ;
        // issuer fallback contient déjà /realms/mirai -> laissé tel quel.
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
          scope: 'openid profile email offline_access',
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

// ======================================================================
// Mes collections — bulle « + IA » sur les pages déclarées
// ======================================================================
// La liste des motifs est lue par MesCollectionsSites (mescollections/sites.js) et
// comparée ICI à l'adresse des onglets : aucune adresse visitée ne sort de l'extension.
// La bulle n'est injectée que dans les onglets qui correspondent (cadre principal).
// Mes collections ne répond pas ⇒ aucune bulle (état « injoignable »), retry planifié.
const MC_CLE_ONGLETS = 'mescollectionsOnglets';
// Chemin absolu : Firefox résout un chemin relatif depuis la page appelante.
const MC_SCRIPT_BULLE = '/src/mescollections/bulle.js';
let _mcSignature = null;

function _mcDisponible() {
  return typeof MesCollectionsSites !== 'undefined' && !!api.scripting && !!api.tabs;
}

function _mcSession() {
  return api.storage.session || api.storage.local;
}

async function _mcJeton(forcer) {
  try {
    const t = await _ensureTokenFresh({ force: forcer });
    return t?.access_token || null;
  } catch (e) {
    return null;
  }
}

async function _mcLireOnglets() {
  const st = await _mcSession().get({ [MC_CLE_ONGLETS]: {} });
  return st[MC_CLE_ONGLETS] || {};
}

async function _mcEvaluerOnglet(tabId, url) {
  if (!_mcDisponible() || typeof tabId !== 'number' || !url) return;
  const { cibles, etat } = await MesCollectionsSites.ciblesPour(url);
  const onglets = await _mcLireOnglets();
  if (cibles.length) {
    try {
      const resultats = await api.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [MC_SCRIPT_BULLE] });
      // Firefox rend l'échec dans le résultat au lieu de rejeter la promesse.
      if (resultats?.[0]?.error) throw new Error(String(resultats[0].error));
      await api.tabs.sendMessage(tabId, { type: 'mescollections:afficher', cibles, etat }, { frameId: 0 });
      onglets[tabId] = true;
    } catch (e) {
      // Page où l'injection est interdite (pages du navigateur, magasin, visionneuse PDF…) : rien.
    }
  } else if (onglets[tabId]) {
    try { await api.tabs.sendMessage(tabId, { type: 'mescollections:retirer' }, { frameId: 0 }); } catch (e) { /* onglet déjà rechargé */ }
    delete onglets[tabId];
  } else {
    return;
  }
  await _mcSession().set({ [MC_CLE_ONGLETS]: onglets });
}

const MC_MAX_ECHANGES = 30;

function _mcCleConversation(tabId) {
  return 'mescollectionsConversation:' + tabId;
}

async function _mcEffacerConversations() {
  try {
    const tout = await _mcSession().get(null);
    const cles = Object.keys(tout || {}).filter((k) => k.startsWith('mescollectionsConversation:'));
    if (cles.length) await _mcSession().remove(cles);
  } catch (e) { /* rien à effacer */ }
}

async function _mcDemander(tabId, url, msg) {
  const onglets = await _mcLireOnglets();
  if (!onglets[tabId]) return { ok: false, erreur: { code: 'interdit', message: 'Bulle inactive sur cette page.' } };
  const { cibles, etat } = await MesCollectionsSites.ciblesPour(url);
  if (etat !== 'connecte') {
    return { ok: false, erreur: { code: 'connexion', message: 'Connectez-vous pour poser une question.' } };
  }
  const voulues = Array.isArray(msg.cibles) ? msg.cibles : [];
  const choisies = cibles.filter((c) => voulues.some((v) => v && v.type === c.type && v.id === c.id));
  if (!choisies.length) return { ok: false, erreur: { code: 'cibles', message: 'Aucune source cochée pour cette page.' } };

  const cfg = await MesCollectionsSites.configuration();
  const { blocs } = await MesCollectionsApi.demander(cfg, choisies, msg.question);
  // Panne pendant une question : relecture immédiate des sites (la bulle se retire si elle échoue aussi).
  if (blocs.some((b) => b.erreur && b.erreur.panne)) MesCollectionsSites.lire();

  const echange = { question: String(msg.question || '').trim().slice(0, 4000), blocs, t: Date.now() };
  const cle = _mcCleConversation(tabId);
  const st = await _mcSession().get({ [cle]: [] });
  const conversation = (st[cle] || []).concat([echange]).slice(-MC_MAX_ECHANGES);
  await _mcSession().set({ [cle]: conversation });
  return { ok: true, echange };
}

async function _mcEvaluerTous() {
  if (!_mcDisponible()) return;
  let onglets = [];
  try { onglets = await api.tabs.query({}); } catch (e) { return; }
  for (const t of onglets) {
    if (t.url) await _mcEvaluerOnglet(t.id, t.url);
  }
}

if (_mcDisponible()) {
  MesCollectionsSites.configurer({
    obtenirJeton: _mcJeton,
    surChangement(etat) {
      // Ne réévalue les onglets que si l'état ou la liste a changé.
      const signature = JSON.stringify([etat.etat, etat.sites]);
      if (signature === _mcSignature) return;
      _mcSignature = signature;
      _mcEvaluerTous();
    }
  });

  api.runtime.onInstalled.addListener(() => { MesCollectionsSites.lire(); });
  if (api.runtime.onStartup) api.runtime.onStartup.addListener(() => { MesCollectionsSites.lire(); });

  api.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === MesCollectionsSites.ALARME) MesCollectionsSites.lire();
  });

  // Connexion / déconnexion : apparition ou disparition du jeton (pas son simple rafraîchissement).
  if (api.storage.onChanged) {
    api.storage.onChanged.addListener((changes, zone) => {
      if (zone !== 'local' || !changes.miraiToken) return;
      const avant = !!changes.miraiToken.oldValue;
      const apres = !!changes.miraiToken.newValue;
      if (avant === apres) return;
      if (!apres) _mcEffacerConversations();   // déconnexion : rien de la session précédente ne reste affiché
      MesCollectionsSites.reinitialiser();
    });
  }

  api.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // url : navigation, y compris dans une application monopage ; complete : nouveau document.
    if (changeInfo.url || changeInfo.status === 'complete') return _mcEvaluerOnglet(tabId, tab?.url || changeInfo.url);
  });

  if (api.tabs.onRemoved) {
    api.tabs.onRemoved.addListener(async (tabId) => {
      // La conversation de l'onglet est effacée avec lui.
      await _mcSession().remove(_mcCleConversation(tabId));
      const onglets = await _mcLireOnglets();
      if (!onglets[tabId]) return;
      delete onglets[tabId];
      await _mcSession().set({ [MC_CLE_ONGLETS]: onglets });
    });
  }

  if (typeof MesCollectionsApi !== 'undefined') MesCollectionsApi.configurer({ obtenirJeton: _mcJeton });

  // Bulle (content script) : questions et conversation de l'onglet. Cadre principal d'un
  // onglet porteur seulement ; les cibles demandées sont recoupées avec celles de la page.
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const types = ['mescollections:demander', 'mescollections:conversation', 'mescollections:effacer'];
    if (!types.includes(msg?.type)) return;
    const tabId = sender?.tab?.id;
    if (typeof tabId !== 'number' || sender.frameId !== 0) return;
    (async () => {
      try {
        const cle = _mcCleConversation(tabId);
        if (msg.type === 'mescollections:effacer') {
          await _mcSession().remove(cle);
          sendResponse({ ok: true });
          return;
        }
        if (msg.type === 'mescollections:conversation') {
          const st = await _mcSession().get({ [cle]: [] });
          sendResponse({ ok: true, conversation: st[cle] || [] });
          return;
        }
        sendResponse(await _mcDemander(tabId, sender.tab.url, msg));
      } catch (e) {
        sendResponse({ ok: false, erreur: { code: 'interne', message: 'Erreur interne de l\'extension.' } });
      }
    })();
    return true;
  });

  // Pages de l'extension (options, popup) : diagnostic, « Mettre à jour la liste », cibles de
  // l'onglet actif. Réservé aux pages de l'extension.
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const types = ['mescollections:etat', 'mescollections:reessayer', 'mescollections:page'];
    if (!types.includes(msg?.type)) return;
    if (!sender?.url || !sender.url.startsWith(api.runtime.getURL(''))) return;
    (async () => {
      try {
        if (msg.type === 'mescollections:page') {
          // Popup : cibles de l'onglet actif, comparées ici comme pour la bulle.
          const { cibles } = await MesCollectionsSites.ciblesPour(String(msg.url || ''));
          sendResponse({ ok: true, cibles, etat: await MesCollectionsSites.etat() });
          return;
        }
        const etat = msg.type === 'mescollections:reessayer'
          ? await MesCollectionsSites.reinitialiser()
          : await MesCollectionsSites.etat();
        sendResponse({ ok: true, etat });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  });

  // Service worker réveillé : relit si l'état est absent ou périmé (l'alarme couvre le reste).
  MesCollectionsSites.etat().then((e) => {
    if (!e.derniereTentative) MesCollectionsSites.lire();
  });
}

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
  // Import mesagents.js (contrat d'agents MirAI : liste + lancement)
  try { importScripts('mesagents.js'); } catch (e) { console.warn('[MirAI] importScripts mesagents.js:', e.message); }
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
    // Config via DMBootstrap (cache/local/fallback — tous avec realm).
    let dmConfig = {};
    try { dmConfig = DMBootstrap.getConfig(); } catch (_) {}
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
        catch (_) { try { dmConfig = DMBootstrap.getConfig(); } catch (_2) {} }
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

        // Portée : + `mesagents-agents` (audience Mes agents) si la fonction Agents est active.
        const scope = (typeof MesAgents !== 'undefined' && MesAgents.buildScope)
          ? MesAgents.buildScope('openid profile email offline_access', dmConfig)
          : 'openid profile email offline_access';

        const authUrl = `${authBase}/protocol/openid-connect/auth?` + new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          scope: scope,
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
// Agents MirAI — menus contextuels + lancement (contrat d'agents MirAI)
// ======================================================================
// Un menu « Agents MirAI » (contexte sélection ou page) liste les agents accessibles
// à la personne ; le clic lit la sélection (ou titre + URL + texte principal de la
// page, borné) et lance l'agent. Le résultat est publié dans storage.session
// (`mesagentsResultat`) : le popup l'affiche (ouvert par programme si possible,
// sinon notification). Rien du contenu ni du jeton n'est journalisé.
const MENU_AGENTS_PARENT = 'mirai-agents';
const MENU_AGENT_PREFIXE = 'mirai-agent:';
const ALARME_AGENTS = 'mesagents-refresh';
const CLE_RESULTAT_AGENTS = 'mesagentsResultat';
const MAX_CONTENU_PAGE = 20000;
const MAX_TITRE_MENU = 60;

function _agentsDisponibles() {
  return typeof MesAgents !== 'undefined' && !!api.contextMenus;
}

function _storeSession() {
  return api.storage.session || api.storage.local;
}

if (typeof MesAgents !== 'undefined' && MesAgents.setAuth) {
  // Le background rafraîchit lui-même le jeton (pas de MiraiAuth hors popup).
  MesAgents.setAuth({
    async obtenirJeton(forcer) {
      try {
        const t = await _ensureTokenFresh({ force: forcer });
        return t?.access_token || null;
      } catch (e) {
        return null;
      }
    }
  });
}

function _titreMenu(nom) {
  let t = String(nom || '').replace(/\s+/g, ' ').trim();
  if (t.length > MAX_TITRE_MENU) t = t.slice(0, MAX_TITRE_MENU - 1) + '…';
  return t.replace(/&/g, '&&'); // `&` est un accélérateur dans les menus Chrome/Windows
}

function _creerMenu(props) {
  try {
    api.contextMenus.create(props, () => { void api.runtime.lastError; });
  } catch (e) {
    console.warn('[MirAI Agents] contextMenus.create:', e.message);
  }
}

/**
 * (Re)construit le menu « Agents MirAI » : un sous-menu par agent, dans les contextes
 * qu'il accepte (`selection` → inputs ∋ selection, `page` → inputs ∋ page).
 * Aucun menu si la fonction est inactive, la personne déconnectée ou le service injoignable.
 */
async function reconstruireMenusAgents(options = {}) {
  if (!_agentsDisponibles()) return;
  try { await api.contextMenus.removeAll(); } catch (e) { /* rien à retirer */ }

  // Relit la config DM stockée (le service worker ne survit pas entre deux réveils).
  try { if (typeof DMBootstrap !== 'undefined' && DMBootstrap._loadCachedOrFallback) await DMBootstrap._loadCachedOrFallback(); } catch (e) { /* fallback */ }

  let agents = [];
  try {
    agents = await MesAgents.listerAgents({ force: !!options.force });
  } catch (e) {
    if (!e?.masquer) console.warn('[MirAI Agents] Liste indisponible :', e?.code || e?.message);
    return;
  }

  const eligibles = agents
    .map(a => ({ a, contexts: ['selection', 'page'].filter(c => a.inputs.includes(c)) }))
    .filter(x => x.contexts.length > 0);
  if (eligibles.length === 0) return;

  const contextesParent = Array.from(new Set(eligibles.flatMap(x => x.contexts)));
  _creerMenu({ id: MENU_AGENTS_PARENT, title: 'Agents MirAI', contexts: contextesParent });
  for (const { a, contexts } of eligibles) {
    _creerMenu({ id: MENU_AGENT_PREFIXE + a.id, parentId: MENU_AGENTS_PARENT, title: _titreMenu(a.name), contexts });
  }
  console.info(`[MirAI Agents] Menu construit : ${eligibles.length} agent(s).`);
}

async function _publierResultatAgent(resultat) {
  try {
    await _storeSession().set({ [CLE_RESULTAT_AGENTS]: Object.assign({ ts: Date.now() }, resultat) });
  } catch (e) {
    console.warn('[MirAI Agents] Publication du résultat impossible :', e.message);
  }
}

/** Ouvre le popup par programme (Chrome ≥ 127, Firefox ≥ 106) ; false si impossible. */
async function _ouvrirPopup(tab) {
  try {
    if (!api.action?.openPopup) return false;
    const details = tab?.windowId !== undefined ? { windowId: tab.windowId } : undefined;
    await api.action.openPopup(details);
    return true;
  } catch (e) {
    return false;
  }
}

// Exécutée DANS la page : doit rester autonome (sérialisée par scripting.executeScript).
function _extraireSelectionDansPage() {
  try { return String(window.getSelection ? window.getSelection().toString() : ''); } catch (e) { return ''; }
}

function _extrairePageDansPage(max) {
  try {
    const racine = document.querySelector('main, article, [role="main"]') || document.body;
    const texte = String((racine && racine.innerText) || '').replace(/\n{3,}/g, '\n\n').trim();
    return { title: String(document.title || ''), url: String(location.href || ''), text: texte.slice(0, max) };
  } catch (e) {
    return { title: String(document.title || ''), url: String(location.href || ''), text: '' };
  }
}

async function _executerDansOnglet(tab, func, args) {
  if (!api.scripting?.executeScript || tab?.id === undefined || tab.id < 0) return undefined;
  try {
    const res = await api.scripting.executeScript({ target: { tabId: tab.id }, func, args: args || [] });
    return Array.isArray(res) && res[0] ? res[0].result : undefined;
  } catch (e) {
    return undefined; // page privilégiée, onglet fermé… → repli
  }
}

async function _lireSelection(tab, info) {
  const parScript = await _executerDansOnglet(tab, _extraireSelectionDansPage);
  const texte = (typeof parScript === 'string' && parScript.trim()) ? parScript : String(info?.selectionText || '');
  return texte.slice(0, MAX_CONTENU_PAGE);
}

async function _lirePage(tab) {
  const page = await _executerDansOnglet(tab, _extrairePageDansPage, [MAX_CONTENU_PAGE]);
  if (page && typeof page === 'object') return page;
  return { title: String(tab?.title || ''), url: String(tab?.url || ''), text: '' };
}

async function lancerAgentDepuisMenu(agentId, info, tab, popupOuvertPromise) {
  let agent = null;
  try {
    const agents = await MesAgents.listerAgents();
    agent = agents.find(a => a.id === agentId) || null;
  } catch (e) {
    await _publierResultatAgent({ status: 'error', message: MesAgents.messageErreur(e), code: e?.code || 'erreur' });
    return;
  }
  if (!agent) {
    await _publierResultatAgent({ status: 'error', message: "Cet agent n'est plus accessible.", code: 'model_not_found' });
    return;
  }

  const modeSelection = !!(info?.selectionText) && agent.inputs.includes('selection');
  const fiche = { id: agent.id, name: agent.name };
  await _publierResultatAgent({ status: 'pending', agent: fiche, mode: modeSelection ? 'selection' : 'page' });

  let consigne, contenu;
  if (modeSelection) {
    contenu = await _lireSelection(tab, info);
    consigne = 'Voici un passage sélectionné dans mon navigateur. Applique ta mission à ce passage.';
  } else {
    const page = await _lirePage(tab);
    contenu = `Titre : ${page.title}\nAdresse : ${page.url}\n\n${page.text}`.slice(0, MAX_CONTENU_PAGE);
    consigne = 'Voici la page web que je consulte (titre, adresse, texte principal). Applique ta mission à cette page.';
  }

  if (!contenu.trim()) {
    await _publierResultatAgent({ status: 'error', agent: fiche, message: 'Rien à transmettre : la sélection ou la page est vide.', code: 'vide' });
    return;
  }

  let resultat;
  try {
    const r = await MesAgents.lancerAgent({ model: agent.model, consigne, contenu });
    resultat = { status: 'done', agent: fiche, texte: r.texte, tronque: !!r.tronque };
  } catch (e) {
    resultat = { status: 'error', agent: fiche, message: MesAgents.messageErreur(e), code: e?.code || 'erreur' };
    if (e?.masquer) reconstruireMenusAgents().catch(() => {});
  }
  await _publierResultatAgent(resultat);

  const popupOuvert = popupOuvertPromise ? await popupOuvertPromise : false;
  if (!popupOuvert && api.notifications?.create) {
    try {
      api.notifications.create('mesagents-resultat', {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: resultat.status === 'done' ? `Réponse de « ${agent.name} »` : `Agent « ${agent.name} »`,
        message: resultat.status === 'done'
          ? "La réponse est prête : cliquez sur l'icône IAssistant-Direct pour la lire."
          : resultat.message
      });
    } catch (e) { /* notification facultative */ }
  }
}

if (api.contextMenus?.onClicked) {
  api.contextMenus.onClicked.addListener((info, tab) => {
    const id = String(info?.menuItemId || '');
    if (!id.startsWith(MENU_AGENT_PREFIXE) || !_agentsDisponibles()) return;
    // Ouvre le popup dès le geste utilisateur ; le résultat lui parvient par storage.session.
    const popupOuvert = _ouvrirPopup(tab);
    lancerAgentDepuisMenu(id.slice(MENU_AGENT_PREFIXE.length), info, tab, popupOuvert)
      .catch(e => console.warn('[MirAI Agents] Lancement échoué :', e?.message));
  });
}

if (api.notifications?.onClicked) {
  api.notifications.onClicked.addListener((notifId) => {
    if (notifId !== 'mesagents-resultat') return;
    _ouvrirPopup().then((ok) => { if (!ok) console.info('[MirAI Agents] Ouvrez le popup pour lire la réponse.'); });
    try { api.notifications.clear(notifId); } catch (e) { /* ignore */ }
  });
}

// Rafraîchissement : installation, démarrage du navigateur, toutes les 3 min, et à
// chaque ouverture/fermeture de session (apparition/disparition du jeton chiffré).
api.runtime.onInstalled.addListener(() => {
  api.alarms.create(ALARME_AGENTS, { periodInMinutes: 3 });
  reconstruireMenusAgents({ force: true }).catch(() => {});
});

if (api.runtime.onStartup) {
  api.runtime.onStartup.addListener(() => {
    reconstruireMenusAgents({ force: true }).catch(() => {});
  });
}

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARME_AGENTS) return;
  reconstruireMenusAgents({ force: true }).catch(() => {});
});

if (api.storage.onChanged) {
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.miraiToken) return;
    const avant = changes.miraiToken.oldValue !== undefined;
    const apres = changes.miraiToken.newValue !== undefined;
    if (avant === apres) return; // simple rafraîchissement du jeton : rien à refaire
    if (typeof MesAgents !== 'undefined') MesAgents.viderCache().catch(() => {});
    reconstruireMenusAgents({ force: true }).catch(() => {});
  });
}

# MirAI Recorder -- Device Management Integration Plan

> ⚠️ **Document HISTORIQUE (2026-03-29, v1.2.1)** — conserve comme trace de la
> conception initiale de l'integration DM. Depuis : le plug-in est renomme
> **IAssistant-Direct (by Mirai)** (slug `mirai-browser` inchange), DGX est en
> acces Keycloak/mcr direct, config runtime servie sous `?profile=prod`, session
> offline 6 mois. Se referer au README et a `adr-dgx-deployment.md` pour l'etat courant.

> Date: 2026-03-29
> Plugin: MirAI Recorder (Chrome/Firefox WebExtension)
> Version actuelle: 1.2.1
> Manifest version: 3

---

## 1. Current State Analysis

### 1.1 Configuration

All configuration values are **hardcoded** across multiple files. There is no centralized config file, no remote config fetch, and no environment-based profiling.

| Parameter | Value | File | Line |
|-----------|-------|------|------|
| Keycloak SSO base URL | `https://sso.mirai.interieur.gouv.fr` | `popup.js` | 900 |
| Keycloak realm | `mirai` | `popup.js` | 901 |
| Keycloak client ID | `mirai-extension` | `popup.js` | 902 |
| Keycloak SSO base URL (options) | `https://sso.mirai.interieur.gouv.fr/auth/realms/mirai/protocol/openid-connect/token` | `options.js` | 185 |
| Keycloak client ID (options) | `mirai-extension` | `options.js` | 192 |
| Meeting API base | `https://compte-rendu.mirai.interieur.gouv.fr/api` | `recording.js` | 1 |
| Userinfo endpoint | `https://sso.mirai.interieur.gouv.fr/realms/mirai/protocol/openid-connect/userinfo` | `popup.js` | 370, 383 |
| Chat URL | `https://chat.mirai.interieur.gouv.fr/` | `popup.js` | 1144 |
| Resume URL | `https://resume.mirai.interieur.gouv.fr/` | `popup.js` | 1145 |
| Compte-rendu URL | `https://compte-rendu.mirai.interieur.gouv.fr/` | `popup.js` | 1146 |
| Aide URL | `https://mirai.interieur.gouv.fr/aide` | `popup.js` | 1147 |
| COMU URL | `https://webconf.comu.gouv.fr/` | `popup.js` | 1148 |
| Meeting viewer URL | `https://compte-rendu.mirai.interieur.gouv.fr/meetings/{id}` | `popup.js` | 737 |
| Crypto secret key | `mirai-local-secret` | `options.js` | 1 |
| Allowed keywords | `['webconf', 'comu', 'webinaire', 'webex', 'gmeet', 'teams']` | `popup.js` | 42 |

### 1.2 Authentication

- **Keycloak OIDC with PKCE** is fully implemented in `popup.js` (function `checkKeycloakSession`, ~240 lines).
- Flow: silent auth (prompt=none) -> refresh_token -> interactive PKCE flow.
- Tokens (access_token, refresh_token, expires_in) are persisted in `chrome.storage.local` under key `miraiToken`.
- User credentials (login/password) are stored encrypted (AES-GCM via `crypto.js`) under key `encryptedCreds` for login_hint pre-fill and legacy password-grant flow in `options.js`.
- The `options.js` file also uses a **direct password grant** (`grant_type: password`) to Keycloak -- this is a separate, older auth path.
- User UUID is extracted from the JWT `sub` claim and stored in memory (`miraiUserUUID`).

### 1.3 Telemetry

- **No telemetry exists.** There is no OpenTelemetry, no analytics, no usage tracking of any kind.
- Only `console.log/info/warn/error` calls throughout the codebase.

### 1.4 Versioning and Updates

- Version is declared in `manifest.json` as `"version": "1.2.1"`.
- **No auto-update mechanism.** No `update_url` in manifest.json. Distribution is manual.
- Alternate manifests exist (`manifest.v2.json` at 1.2.0, `manifest.v3.json` at 1.2.0) but are not active.

### 1.5 Architecture

- **Entry points**: `background.js` (service worker, minimal -- just listens for `record:finished` messages), `popup.js` (main UI logic), `options.js` (credentials page), `recording.js` (meeting API calls).
- **Compatibility layer**: `compat.js` provides `CompatAPI` object abstracting Chrome/Firefox differences (tabs, storage, identity).
- **Crypto**: `crypto.js` provides PBKDF2 + AES-GCM encrypt/decrypt.
- **No module system**: All scripts are loaded via `<script>` tags, using `window.*` globals for inter-file communication.
- **Browser support**: Chrome (MV3) + Firefox ESR 128+ (via `browser_specific_settings.gecko`).

### 1.6 Client UUID

- A **Keycloak user UUID** (`miraiUserUUID`) is extracted from the JWT token, but this is the *user* identity, not a *device/installation* UUID.
- **No client/device UUID** is generated or persisted. This is required by DM.

---

## 2. Gap Analysis

| DM Requirement | Current State | Gap |
|----------------|---------------|-----|
| `dm-config.json` in package | Does not exist | Must create |
| `dm-manifest.json` in package | Does not exist | Must create |
| Bootstrap module (fetch config at startup) | No remote config fetch | Must implement in `background.js` |
| Config cache with fallback | All hardcoded | Must implement storage-based cache |
| Client UUID (device-level, persistent) | Only user UUID from JWT | Must generate and persist a unique installation UUID |
| `X-Plugin-Version` header on config calls | Not sent | Must add |
| `X-Platform-Type` header | Not sent | Must add (`chrome` or `firefox`) |
| Update directive handling | No auto-update | Must implement download + install flow |
| Telemetry (OTLP JSON to DM endpoint) | None | Must implement from scratch |
| Telemetry token refresh | None | Must implement |
| Enrollment flow (POST /enroll) | Not implemented | Must implement (optional but needed for LLM secrets) |
| `X-Relay-Client` / `X-Relay-Key` headers | Not stored or sent | Must implement after enrollment |
| Feature flags support | None | Must implement |
| `deploy-release.sh` script | Does not exist | Must create |
| `host_permissions` for DM server | `<all_urls>` already set | **No gap** -- already permissive |
| Centralized config consumption | 6+ hardcoded URLs across 3 files | Must refactor all URL references to use config object |

---

## 3. dm-config.json Draft

```json
{
  "configVersion": 1,
  "default": {
    "enabled": true,
    "telemetryEnabled": true,
    "telemetrylogJson": true,
    "telemetryAuthorizationType": "Bearer",
    "authHeaderName": "Authorization",
    "authHeaderPrefix": "Bearer ",
    "allowedKeywords": ["webconf", "comu", "webinaire", "webex", "gmeet", "teams"],
    "cryptoSecretKey": "mirai-local-secret",
    "keycloakScope": "openid profile email"
  },
  "local": {
    "_description": "Dev autonome, sans DM, sans Keycloak",
    "config_path": "",
    "bootstrap_url": "",
    "ssoBaseUrl": "https://sso.mirai.interieur.gouv.fr",
    "keycloakRealm": "mirai",
    "keycloakClientId": "mirai-extension",
    "apiBase": "http://localhost:8080/api",
    "chatUrl": "http://localhost:3000/",
    "resumeUrl": "http://localhost:3001/",
    "compteRenduUrl": "http://localhost:8080/",
    "aideUrl": "http://localhost:3002/aide",
    "comuUrl": "https://webconf.comu.gouv.fr/",
    "meetingViewerUrlTemplate": "http://localhost:8080/meetings/{id}",
    "telemetryEnabled": false
  },
  "dev": {
    "_description": "Dev avec DM Docker Compose local",
    "ssoBaseUrl": "${{KEYCLOAK_ISSUER_URL}}",
    "keycloakRealm": "${{KEYCLOAK_REALM}}",
    "keycloakClientId": "${{KEYCLOAK_CLIENT_ID}}",
    "apiBase": "${{MIRAI_API_BASE}}",
    "chatUrl": "${{MIRAI_CHAT_URL}}",
    "resumeUrl": "${{MIRAI_RESUME_URL}}",
    "compteRenduUrl": "${{MIRAI_COMPTE_RENDU_URL}}",
    "aideUrl": "${{MIRAI_AIDE_URL}}",
    "comuUrl": "${{MIRAI_COMU_URL}}",
    "meetingViewerUrlTemplate": "${{MIRAI_COMPTE_RENDU_URL}}/meetings/{id}"
  },
  "int": {
    "_description": "Integration / recette",
    "ssoBaseUrl": "https://sso.mirai.interieur.gouv.fr",
    "keycloakRealm": "mirai",
    "keycloakClientId": "mirai-extension",
    "apiBase": "https://compte-rendu.mirai.interieur.gouv.fr/api",
    "chatUrl": "https://chat.mirai.interieur.gouv.fr/",
    "resumeUrl": "https://resume.mirai.interieur.gouv.fr/",
    "compteRenduUrl": "https://compte-rendu.mirai.interieur.gouv.fr/",
    "aideUrl": "https://mirai.interieur.gouv.fr/aide",
    "comuUrl": "https://webconf.comu.gouv.fr/",
    "meetingViewerUrlTemplate": "https://compte-rendu.mirai.interieur.gouv.fr/meetings/{id}"
  },
  "prod": {
    "_description": "Production",
    "ssoBaseUrl": "https://sso.mirai.interieur.gouv.fr",
    "keycloakRealm": "mirai",
    "keycloakClientId": "mirai-extension",
    "apiBase": "https://compte-rendu.mirai.interieur.gouv.fr/api",
    "chatUrl": "https://chat.mirai.interieur.gouv.fr/",
    "resumeUrl": "https://resume.mirai.interieur.gouv.fr/",
    "compteRenduUrl": "https://compte-rendu.mirai.interieur.gouv.fr/",
    "aideUrl": "https://mirai.interieur.gouv.fr/aide",
    "comuUrl": "https://webconf.comu.gouv.fr/",
    "meetingViewerUrlTemplate": "https://compte-rendu.mirai.interieur.gouv.fr/meetings/{id}"
  }
}
```

---

## 4. dm-manifest.json Draft

```json
{
  "slug": "mirai-recorder",
  "name": "MirAI Recorder -- Capture et transcription de reunions",
  "description": "Extension Chrome/Firefox pour capturer, enregistrer et transcrire les reunions en ligne (Webconf, COMU, Webex, Google Meet, Teams). Integration SSO Keycloak, gestion securisee des identifiants, et lancement rapide des services MirAI.",
  "intent": "Permettre aux agents de capturer et transcrire automatiquement leurs reunions en ligne via une extension navigateur integree a l'ecosysteme MirAI.",
  "device_type": "chrome",
  "category": "productivity",
  "publisher": "DTNUM",
  "visibility": "public",
  "homepage_url": "https://github.com/mirai-assistant",
  "support_email": "support@mirai.interieur.gouv.fr",
  "icon_url": "icons/icon128.png",
  "doc_url": "https://mirai.interieur.gouv.fr/aide",
  "license": "MPL-2.0",
  "key_features": [
    "Capture et enregistrement de reunions en ligne (Webconf, COMU, Webex, GMeet, Teams)",
    "Authentification SSO Keycloak avec PKCE et rafraichissement silencieux",
    "Compatibilite Chrome (MV3) et Firefox ESR 128+",
    "Stockage chiffre des identifiants (AES-GCM)",
    "Raccourcis rapides vers les services MirAI (Chat, Resume, Compte-rendu)",
    "Detection automatique des plateformes de visioconference"
  ],
  "changelog": [
    {
      "version": "1.2.1",
      "date": "2026-03-29",
      "changes": [
        "Version courante avant integration Device Management"
      ]
    }
  ]
}
```

---

## 5. Implementation Plan

### Step 1: Create `dm-config.json` and `dm-manifest.json`

**Files to create:**
- `dm-config.json` (root of extension) -- content as in Section 3
- `dm-manifest.json` (root of extension) -- content as in Section 4

**What to do:**
- Place both files at the root of the chrome-extension directory.
- They will be included in the ZIP/CRX package and extracted by DM on upload.

---

### Step 2: Generate and persist a Client UUID

**Files to modify:**
- `background.js`

**What to change:**
- On `install` event (service worker), generate a UUID v4 using `crypto.randomUUID()` and store it in `chrome.storage.local` under key `dmClientUUID`.
- On `activate` event, read and cache the UUID. If missing (upgrade from older version), generate one.
- Export a helper function or message handler so popup.js / recording.js can retrieve it.

---

### Step 3: Create a DM bootstrap module

**Files to create:**
- `dm-bootstrap.js` (new file, ~100-150 lines)

**What to implement:**
1. `async function fetchDMConfig(bootstrapUrl, slug, profile)` -- calls `GET {bootstrap_url}/config/{slug}/config.json?profile={profile}` with the required headers (`X-Plugin-Version`, `X-Client-UUID`, `X-Platform-Type`, `X-Platform-Version`, `X-User-Email`, `X-Relay-Client`, `X-Relay-Key`).
2. Cache the response in `chrome.storage.local` under key `dmConfig`.
3. Return the merged config object.
4. On failure (network error, DM unreachable), fall back to cached config or hardcoded defaults from `dm-config.json` `local` section.
5. Handle the `update` directive in the response (compare versions, notify user).
6. Handle the `features` object (store feature flags).
7. Extract `telemetryEndpoint` and `telemetryKey` from the response for telemetry setup.

**Files to modify:**
- `background.js` -- call `fetchDMConfig()` on service worker startup and on periodic alarm (e.g., every 30 minutes via `chrome.alarms`).
- `manifest.json` -- add `"alarms"` to `permissions` array.

---

### Step 4: Create a centralized config accessor

**Files to create:**
- `dm-config-accessor.js` (new file, ~50 lines)

**What to implement:**
- `async function getConfig()` -- reads `dmConfig` from storage, returns the merged config.
- Getters for each config key: `getApiBase()`, `getSsoBaseUrl()`, `getKeycloakRealm()`, `getKeycloakClientId()`, etc.
- Fallback chain: DM config -> cached config -> hardcoded defaults.

---

### Step 5: Refactor hardcoded URLs to use the config accessor

**Files to modify:**

#### `recording.js`
- **Line 1**: Replace `const API_BASE = 'https://compte-rendu.mirai.interieur.gouv.fr/api';` with a dynamic lookup: `let API_BASE; (async () => { const cfg = await getConfig(); API_BASE = cfg.apiBase; })();`
- Alternatively, make `startMiraiRecording`, `findActiveMeeting`, `createMeeting`, `startCreatedMeeting`, `stopMiraiRecording` all call `getConfig()` at invocation time rather than relying on a module-level constant.

#### `popup.js`
- **Lines 900-902**: Replace hardcoded `ssoBase`, `realm`, `clientId` in `checkKeycloakSession()` with config lookups.
- **Lines 370, 383**: Replace hardcoded userinfo endpoint with config-derived URL.
- **Lines 1143-1148**: Replace hardcoded shortcut URLs object with config-derived values.
- **Line 737**: Replace hardcoded meeting viewer URL template with config value.

#### `options.js`
- **Line 185**: Replace hardcoded SSO token URL with config-derived URL.
- **Line 192**: Replace hardcoded `client_id: 'mirai-extension'` with config value.
- **Line 1**: Consider making `SECRET_KEY` configurable via DM config (`cryptoSecretKey`).

---

### Step 6: Implement telemetry module

**Files to create:**
- `dm-telemetry.js` (new file, ~100-120 lines)

**What to implement:**
1. `initTelemetry(config)` -- checks `telemetryEnabled`, stores `telemetryEndpoint` and `telemetryKey`.
2. `sendSpan(name, attributes)` -- builds an OTLP JSON payload and POSTs it to the telemetry endpoint.
3. `refreshTelemetryToken()` -- calls `GET {bootstrap_url}/telemetry/token?device={slug}&profile={profile}` to renew the short-lived token.
4. Instrument key user actions: start recording, stop recording, open shortcut, login success/failure.

**Files to modify:**
- `popup.js` -- add `sendSpan()` calls at key interaction points (rec start, rec stop, shortcut clicks).
- `recording.js` -- add `sendSpan()` calls for API interactions (meeting create, capture start/stop).
- `background.js` -- initialize telemetry on startup after config fetch.

---

### Step 7: Implement enrollment (optional, for secrets)

**Files to create:**
- `dm-enrollment.js` (new file, ~80 lines)

**What to implement:**
1. `async function enroll(bootstrapUrl, slug, accessToken, email, clientUUID)` -- POSTs to `/enroll`.
2. Persist `relay_client_id` and `relay_key` in `chrome.storage.local`.
3. Expose them for the bootstrap module to include in headers.
4. UI trigger: add an "Enroll" button in options page or handle enrollment silently after first successful Keycloak login.

**Files to modify:**
- `options.html` -- add enrollment status indicator and button.
- `options.js` -- add enrollment UI logic.

---

### Step 8: Implement update handling

**Files to modify:**
- `dm-bootstrap.js` (extend the existing module)
- `background.js`

**What to implement:**
1. When the config response contains `update != null`, compare `update.target_version` with the current version from `chrome.runtime.getManifest().version`.
2. If an update is available, notify the user via `chrome.notifications` (add `"notifications"` to permissions).
3. For Chrome: direct the user to the download URL or Chrome Web Store update page.
4. For Firefox: use `browser.runtime.reload()` if sideloaded, or direct to AMO page.
5. Store update state to avoid repeated notifications.

---

### Step 9: Create deployment script

**Files to create:**
- `scripts/deploy-release.sh`

**What to implement:**
- Package the extension as a ZIP (include dm-config.json, dm-manifest.json, all source files).
- Upload to DM via `POST /api/plugins/{slug}/deploy`.
- Accept `BOOTSTRAP_URL` and `DM_ADMIN_TOKEN` as environment variables.

---

### Step 10: Add `dm-config.json` and `dm-manifest.json` to the build/package

**Files to modify:**
- Any existing build/package script (if one exists), or document in README that these files must be at the root of the ZIP.
- Ensure `.web-extension-id` or similar Firefox build artifacts do not conflict.

---

## 6. Estimated Effort

| Step | Description | Effort |
|------|-------------|--------|
| 1 | Create dm-config.json + dm-manifest.json | 0.5 day |
| 2 | Client UUID generation and persistence | 0.5 day |
| 3 | DM bootstrap module | 1-1.5 days |
| 4 | Centralized config accessor | 0.5 day |
| 5 | Refactor hardcoded URLs (3 files, ~15 locations) | 1-1.5 days |
| 6 | Telemetry module (OTLP JSON, token refresh, instrumentation) | 1.5-2 days |
| 7 | Enrollment flow (optional) | 1 day |
| 8 | Update directive handling | 1 day |
| 9 | Deployment script | 0.5 day |
| 10 | Build/package integration | 0.5 day |
| -- | **Testing and debugging** | 2-3 days |
| -- | **Total** | **9-11 days** |

---

## 7. Risks and Considerations

### 7.1 CORS

- **Current state**: `host_permissions` is set to `<all_urls>`, which means the extension can already make cross-origin requests to any URL. This covers DM server calls.
- **Risk**: If `host_permissions` is tightened in the future (e.g., to specific domains), the DM bootstrap URL must be explicitly listed.
- **Mitigation**: When adding the DM bootstrap URL, explicitly add it to `host_permissions` even if `<all_urls>` is present, for documentation clarity and forward compatibility.

### 7.2 Service Worker Lifecycle (MV3)

- Chrome MV3 service workers are **ephemeral** -- they can be terminated after 30 seconds of inactivity.
- The DM bootstrap fetch must complete quickly or use `chrome.alarms` for periodic refresh rather than relying on the service worker staying alive.
- Telemetry batching must account for service worker termination: flush spans before shutdown or persist them to storage for later sending.
- **Mitigation**: Use `chrome.alarms` API for periodic config refresh. Persist telemetry spans to storage and flush on next wake-up.

### 7.3 Backwards Compatibility

- **Critical**: The extension must continue to work if DM is unreachable (network error, server down, no DM deployed).
- The fallback chain must be: DM config -> cached config -> hardcoded defaults (current values).
- The `local` profile in dm-config.json serves this purpose.
- **Recommendation**: Keep hardcoded defaults as a final fallback in `dm-config-accessor.js` for at least 2 release cycles after DM integration.

### 7.4 Dual Auth Flows

- `popup.js` uses PKCE (modern, secure).
- `options.js` uses direct password grant (legacy, less secure, but required for Keycloak session pre-check).
- Both flows hardcode the same SSO base URL and client ID but in different places and with slightly different URL formats (`/auth/realms/` in options.js vs `/realms/` in popup.js -- note the `/auth/` prefix difference).
- **Risk**: The URL difference (`/auth/realms/mirai/...` in options.js vs `/realms/mirai/...` in popup.js) suggests either a Keycloak version migration path or a bug. This must be resolved before centralizing the config.
- **Mitigation**: Verify which URL format is correct for the target Keycloak version and standardize.

### 7.5 Firefox Compatibility

- The extension supports Firefox ESR 128+ via `compat.js`.
- `crypto.randomUUID()` is available in Firefox 95+, so UUID generation is safe.
- `chrome.alarms` API is available in Firefox as `browser.alarms`. The compat layer may need extension.
- Firefox does not support the `key` field in manifest.json (Chrome-only for extension ID stability). This is already handled by `browser_specific_settings.gecko.id`.

### 7.6 Secret Exposure

- `options.js` line 1 contains `const SECRET_KEY = 'mirai-local-secret'` -- a hardcoded encryption key. This is a local-only symmetric key for credential storage, not a server secret, but it should ideally be device-unique.
- DM integration could improve this by deriving the key from the client UUID or a DM-provided seed.

### 7.7 Token in URL

- `popup.js` line 1163 passes the Keycloak access token as a URL query parameter (`?auth_token=...`) when opening shortcuts. This is a security concern (tokens in browser history, server logs, referrer headers).
- This is outside DM scope but worth noting as a pre-existing issue.

### 7.8 No Build Pipeline

- There is no visible build system (no package.json, no webpack, no build script). The extension appears to be distributed as raw source files zipped into a CRX/XPI.
- The deployment script (Step 9) must account for this -- it will simply ZIP the directory contents.
- New files (`dm-bootstrap.js`, `dm-telemetry.js`, etc.) must be added as `<script>` tags in `popup.html` and/or referenced in `background.js` via `importScripts()` or dynamic import.

### 7.9 Global Scope Pollution

- The codebase relies heavily on `window.*` globals for inter-module communication (e.g., `window.startMiraiRecording`, `window.CompatAPI`, `window.encrypt`).
- New DM modules should follow the same pattern for consistency, even though ES modules would be preferable.
- The service worker (`background.js`) has `"type": "module"` declared in manifest.json but does not use any imports. This could be leveraged for DM modules in the service worker context.

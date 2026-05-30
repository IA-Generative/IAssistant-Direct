# Prompt — Integrer MirAI Recorder (Chrome Extension) avec Device Management

> ⚠️ **Document HISTORIQUE (2026-03-31)** — prompt utilise pour l'integration DM
> initiale. Le plug-in est depuis renomme **IAssistant-Direct (by Mirai)** ; voir
> README + `adr-dgx-deployment.md` pour l'etat courant (DGX direct, `?profile=prod`,
> session offline 6 mois).

> Version : 1.0 — 2026-03-31
> Repo : /Users/etiquet/Documents/GitHub/mirai-assistant/chrome-extension
> Prerequis : DM deploye sur https://bootstrap.fake-domain.name avec le slug `mirai-recorder`
> Reference : dm-integration-plan.md (analyse complete dans ce meme repo)

---

## Objectif

Modifier la base de code de l'extension Chrome/Firefox MirAI Recorder pour :
1. Recuperer sa configuration depuis Device Management au lieu de la hardcoder
2. Recevoir et appliquer les directives de mise a jour
3. Envoyer de la telemetrie d'usage
4. Supporter l'enrollment pour recevoir les secrets

Le plugin doit continuer a fonctionner si DM est indisponible (fallback sur les valeurs actuelles).

---

## Contexte technique

- Extension WebExtension Manifest V3 (Chrome) + Firefox ESR 128+
- Vanilla JavaScript, pas de build system, modules via `<script>` tags et `window.*` globals
- Service worker `background.js` (ephemere en MV3 — utiliser `chrome.alarms` pour les taches periodiques)
- Couche de compatibilite Chrome/Firefox dans `compat.js` (`window.CompatAPI`)
- Auth Keycloak PKCE deja implementee dans `popup.js`
- Aucune telemetrie, aucun remote config, aucun auto-update actuellement

---

## Contraintes

- Ne PAS casser le fonctionnement existant — tout doit marcher si DM est indisponible
- Suivre le pattern existant : `window.*` globals, pas d'ES modules dans popup/options (le service worker peut utiliser `importScripts`)
- Les fichiers `dm-config.json` et `dm-manifest.json` a la racine seront retires du package par DM lors de l'upload
- Ajouter les nouveaux scripts dans `popup.html` via `<script>` tags
- Garder la compatibilite Firefox via `compat.js`

---

## Tache 1 — Fichiers DM (5 min)

Creer a la racine de l'extension :

### `dm-config.json`

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
    "allowedKeywords": ["webconf", "comu", "webinaire", "webex", "gmeet", "teams"]
  },
  "local": {
    "_description": "Dev autonome, sans DM",
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
    "telemetryEnabled": false
  },
  "dev": {
    "_description": "Dev avec DM",
    "ssoBaseUrl": "${{KEYCLOAK_ISSUER_URL}}",
    "keycloakRealm": "${{KEYCLOAK_REALM}}",
    "keycloakClientId": "${{KEYCLOAK_CLIENT_ID}}",
    "apiBase": "${{MIRAI_API_BASE}}",
    "chatUrl": "${{MIRAI_CHAT_URL}}",
    "resumeUrl": "${{MIRAI_RESUME_URL}}",
    "compteRenduUrl": "${{MIRAI_COMPTE_RENDU_URL}}",
    "aideUrl": "${{MIRAI_AIDE_URL}}",
    "comuUrl": "${{MIRAI_COMU_URL}}"
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
    "comuUrl": "https://webconf.comu.gouv.fr/"
  },
  "prod": {
    "_description": "Production"
  }
}
```

### `dm-manifest.json`

```json
{
  "slug": "mirai-recorder",
  "name": "MirAI Recorder — Capture et transcription de reunions",
  "description": "Extension Chrome/Firefox pour capturer, enregistrer et transcrire les reunions en ligne (Webconf, COMU, Webex, Google Meet, Teams).",
  "intent": "Permettre aux agents de capturer et transcrire automatiquement leurs reunions en ligne.",
  "device_type": "chrome",
  "category": "productivity",
  "publisher": "DTNUM",
  "visibility": "public",
  "homepage_url": "https://github.com/mirai-assistant",
  "support_email": "fabrique-numerique@interieur.gouv.fr",
  "icon_url": "icons/icon128.png",
  "doc_url": "https://mirai.interieur.gouv.fr/aide",
  "license": "MPL-2.0",
  "key_features": [
    "Capture de reunions (Webconf, COMU, Webex, GMeet, Teams)",
    "Authentification SSO Keycloak PKCE",
    "Compatibilite Chrome et Firefox ESR 128+",
    "Stockage chiffre des identifiants (AES-GCM)",
    "Raccourcis vers les services MirAI",
    "Detection automatique des plateformes"
  ],
  "changelog": [
    {
      "version": "1.2.1",
      "date": "2026-03-29",
      "changes": ["Version courante avant integration Device Management"]
    }
  ]
}
```

---

## Tache 2 — Client UUID (background.js)

Modifier `background.js` pour generer et persister un UUID d'installation unique :

```javascript
// Au debut de background.js
chrome.runtime.onInstalled.addListener(async (details) => {
  // Generate client UUID on first install
  const { dmClientUUID } = await chrome.storage.local.get('dmClientUUID');
  if (!dmClientUUID) {
    await chrome.storage.local.set({ dmClientUUID: crypto.randomUUID() });
  }
});
```

---

## Tache 3 — Module bootstrap DM (dm-bootstrap.js, nouveau fichier)

Creer `dm-bootstrap.js` (charge via `<script>` dans popup.html) :

**Responsabilites** :
- `window.DMBootstrap.fetchConfig(bootstrapUrl, slug, profile)` — appelle `GET {url}/config/{slug}/config.json?profile={profile}` avec les headers DM
- Cache la reponse dans `chrome.storage.local` sous cle `dmConfig`
- Fallback : cache local → valeurs hardcodees (profil `int` du dm-config.json)
- Expose `window.DMBootstrap.getConfig()` — retourne la config mergee
- Expose `window.DMBootstrap.getUpdate()` — retourne la directive update ou null
- Expose `window.DMBootstrap.getFeatures()` — retourne les feature flags

**Headers a envoyer** :
```
X-Plugin-Version: {chrome.runtime.getManifest().version}
X-Client-UUID: {dmClientUUID from storage}
X-Platform-Type: {chrome ou firefox, detecte via compat.js}
X-Platform-Version: {navigator.userAgent version}
```

**Gestion du service worker** : utiliser `chrome.alarms` pour rafraichir la config toutes les 30 min.
Ajouter `"alarms"` dans `permissions` du manifest.json.

---

## Tache 4 — Refactorer les URLs hardcodees

Remplacer les valeurs hardcodees par des lookups `DMBootstrap.getConfig()` dans :

### `recording.js` (1 endroit)
- Ligne 1 : `const API_BASE = '...'` → `const API_BASE = window.DMBootstrap?.getConfig()?.apiBase || 'https://compte-rendu.mirai.interieur.gouv.fr/api'`

### `popup.js` (5 endroits)
- Lignes 900-902 : `ssoBase`, `realm`, `clientId` dans `checkKeycloakSession()` → lookup config
- Lignes 370, 383 : userinfo endpoint → construire depuis `config.ssoBaseUrl + '/realms/' + config.keycloakRealm + '/protocol/openid-connect/userinfo'`
- Lignes 1143-1148 : URLs raccourcis (chat, resume, etc.) → lookup config
- Ligne 737 : URL meeting viewer → lookup config

### `options.js` (2 endroits)
- Ligne 185 : SSO token URL → construire depuis config
- Ligne 192 : `client_id` → lookup config

**Pattern de fallback** : toujours utiliser `config?.key || 'valeur_hardcodee_actuelle'` pour que le plugin fonctionne sans DM.

---

## Tache 5 — Telemetrie (dm-telemetry.js, nouveau fichier)

Creer `dm-telemetry.js` :

```javascript
window.DMTelemetry = {
  _endpoint: null,
  _token: null,
  _slug: 'mirai-recorder',
  _buffer: [],

  init(config) { /* lire telemetryEndpoint, telemetryKey depuis config */ },

  sendSpan(name, attributes) {
    /* Construire payload OTLP JSON, ajouter au buffer */
    /* Flush si buffer > 5 spans ou toutes les 30s */
  },

  async flush() {
    /* POST vers _endpoint avec Authorization: Bearer _token */
    /* Fallback X-Client-UUID si pas de token */
  },

  async refreshToken(bootstrapUrl, slug, profile) {
    /* GET {bootstrapUrl}/telemetry/token?device={slug}&profile={profile} */
  }
};
```

**Instrumentation** — ajouter `DMTelemetry.sendSpan()` dans :
- `popup.js` : login success/failure, shortcut clicks
- `recording.js` : recording start/stop, meeting create

---

## Tache 6 — Gestion des mises a jour

Dans `dm-bootstrap.js`, apres le fetch config :

```javascript
const update = response.update;
if (update && update.action === 'update') {
  const currentVersion = chrome.runtime.getManifest().version;
  // Comparer les versions
  if (needsUpdate(currentVersion, update.target_version)) {
    // Notifier l'utilisateur via chrome.notifications
    chrome.notifications.create('dm-update', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Mise a jour disponible',
      message: `MirAI Recorder ${update.target_version} est disponible.`,
    });
    // Stocker l'URL de telechargement pour affichage dans le popup
    await chrome.storage.local.set({ dmUpdateAvailable: update });
  }
}
```

Ajouter `"notifications"` dans `permissions` du manifest.json.

Dans `popup.html/popup.js` : afficher un bandeau si `dmUpdateAvailable` existe dans le storage, avec un lien vers `update.artifact_url`.

---

## Tache 7 — Script de deploiement

Creer `scripts/deploy-release.sh` :

```bash
#!/usr/bin/env bash
set -euo pipefail
SLUG="mirai-recorder"
BOOTSTRAP_URL="${BOOTSTRAP_URL:-https://bootstrap.fake-domain.name}"
ADMIN_TOKEN="${DM_ADMIN_TOKEN:-}"
[ -n "$ADMIN_TOKEN" ] || { echo "ERROR: DM_ADMIN_TOKEN not set"; exit 1; }

# Package
DIST_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ZIP_PATH="/tmp/${SLUG}.zip"
cd "$DIST_DIR"
zip -r "$ZIP_PATH" . -x "*.git*" "prompts/*" "scripts/*" "*.crx" "dm-integration-plan.md" "*.DS_Store"

echo "Deploying $SLUG..."
curl -s -X POST "${BOOTSTRAP_URL}/api/plugins/${SLUG}/deploy" \
  -H "X-Admin-Token: ${ADMIN_TOKEN}" \
  -F "binary=@${ZIP_PATH}" \
  -F "strategy=canary" | python3 -m json.tool

rm "$ZIP_PATH"
```

---

## Tache 8 — Mise a jour du manifest.json

Ajouter dans `permissions` :
```json
"permissions": ["tabs", "storage", "identity", "alarms", "notifications"]
```

---

## Ordre d'execution recommande

```
1. dm-config.json + dm-manifest.json          (5 min, aucun risque)
2. Client UUID dans background.js              (15 min)
3. dm-bootstrap.js + integration background    (2-3h)
4. Refactoring URLs hardcodees                 (2-3h)
5. dm-telemetry.js + instrumentation           (2-3h)
6. Gestion mises a jour                        (1-2h)
7. Script deploy                               (30 min)
8. Test complet (Chrome + Firefox)             (2-3h)
```

**Total estime : 2-3 jours**

---

## Test de validation

```bash
# 1. Enregistrer le plugin dans DM
export DM_ADMIN_TOKEN="change-me-queue-admin-token"
./scripts/deploy-release.sh

# 2. Verifier la fiche catalogue
curl -s https://bootstrap.fake-domain.name/catalog/api/plugins/mirai-recorder | python3 -m json.tool

# 3. Verifier la config
curl -s https://bootstrap.fake-domain.name/config/mirai-recorder/config.json?profile=int | python3 -m json.tool

# 4. Charger l'extension dans Chrome, verifier :
#    - La config est recuperee depuis DM (console log)
#    - Les URLs fonctionnent (raccourcis, SSO, recording)
#    - La telemetrie est envoyee (verifier dans DM admin)
#    - La directive update s'affiche si version < target
```

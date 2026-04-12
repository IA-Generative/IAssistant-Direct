# ADR : Deploiement on-premise DGX

> Date : 2026-04-12
> Statut : accepte
> Contexte : deploiement de MirAI Browser sur l'infrastructure DGX (onyxia.gpu.minint.fr)

## Probleme

L'extension MirAI Browser doit etre deployee sur deux infrastructures distinctes :
- **Scaleway** (cloud) — acces reseau direct vers les services externes
- **DGX** (on-premise ministeriel) — flux sortants bloques depuis les postes Chromium

Les services externes concernes : Keycloak SSO (`sso.mirai.interieur.gouv.fr`), API compte-rendu, bootstrap DM.

## Decisions

### 1. Build multi-cible via `--target`

Deux profils de configuration (`prod-scaleway`, `prod-dgx`) dans `src/dm/config.json`.
Les scripts `build.sh` et `deploy-release.sh` acceptent un flag `--target=dgx|scaleway`
qui patche `activeProfile`, les fallbacks hardcodes (`bootstrap.js`, `background.js`)
et suffixe les artefacts (`mirai-browser-1.2.2-dgx.crx`).

Les **sources git ne sont jamais modifiees** par le build — seules les copies dans `dist/`
sont patchees. Un build par defaut (sans flag) produit la cible Scaleway.

### 2. Authentification Keycloak via le relay-assistant (DGX)

Sur DGX, Chromium ne peut pas joindre `sso.mirai.interieur.gouv.fr` directement. Le
Device Management expose un reverse-proxy nginx (`relay-assistant`) qui sort via le
proxy corporate DGX et atteint Keycloak.

Configuration du profil `prod-dgx` :

    keycloakIssuerUrl : https://onyxia.gpu.minint.fr/bootstrap/relay-assistant/keycloak
    keycloakRealm     : "" (vide — le realm est dans l'upstream cote nginx)

Le realm est volontairement vide : le relay nginx expose
`/keycloak/protocol/openid-connect/{auth,token,userinfo}` sans segment `/realms/mirai`
dans le path. Le realm reel est injecte cote serveur via la variable
`RELAY_KEYCLOAK_UPSTREAM=https://sso.mirai.interieur.gouv.fr/realms/mirai`.

### 3. Endpoints Keycloak publics sur le relay (pas d'auth_request)

Les 3 endpoints OIDC (`/auth`, `/token`, `/userinfo`) etaient proteges par
`auth_request /__relay_auth` dans nginx, exigeant des headers `X-Relay-Client` /
`X-Relay-Key`. Cela creait un poulet-oeuf au premier login : les credentials relay
sont distribues par `POST /enroll` qui lui-meme necessite un token Keycloak.

L'`auth_request` a ete retire sur ces 3 routes. Justification securite :
- `/auth` : endpoint public par design (redirect navigateur)
- `/token` : protege par PKCE (`code_verifier`)
- `/userinfo` : protege par le Bearer token

Keycloak valide nativement ces 3 endpoints. L'`auth_request` ajoutait du filtrage
de flotte, pas de la securite cryptographique.

### 4. Bypass proxy corporate dans `relay_assistant_proxy`

Le pod `device-management` a des variables `HTTP_PROXY` / `HTTPS_PROXY` pour les
appels sortants (Keycloak, compte-rendu...). Le client `httpx.AsyncClient()` les lit
par defaut et tente de router les appels vers `relay-assistant` (service K8s interne)
via le proxy corporate, ce qui timeout.

Fix : `transport=httpx.AsyncHTTPTransport()` + `trust_env=False` sur le client httpx
utilise uniquement dans `relay_assistant_proxy`. Les autres appels httpx continuent
d'honorer le proxy corporate.

Bug secondaire corrige dans la meme passe : le code lisait `DM_RELAY_ASSISTANT_UPSTREAM`
mais le secret K8s s'appelle `DM_RELAY_ASSISTANT_URL`. Ajout d'un lookup en cascade
(`DM_RELAY_ASSISTANT_URL` → `DM_RELAY_ASSISTANT_UPSTREAM` → default docker-compose).

### 5. Icone du catalogue DM embarquee dans le package

Le DM extrait automatiquement l'icone d'un plugin depuis le zip a l'upload, en cherchant
les fichiers `{logo.png, icon128.png, icon48.png}` dans un dossier `assets/` (convention
AssistantMiraiLibreOffice, voir `app/admin/router.py:1531-1541`).

`build.sh` copie `icons/icon128.png` vers `dist/extension/assets/icon128.png` pour que
le DM puisse l'extraire. L'icone est convertie en data URL base64 et stockee en base,
sans appel reseau sortant (critique sur DGX ou github.com est injoignable).

### 6. Meme cle PEM pour les deux cibles

Les deux builds (DGX et Scaleway) partagent la meme cle PEM et donc le meme Extension
ID Chrome (`cjaokgcdmdeakhkplbifninjcdklhokf`). Consequence : impossible d'installer
les deux cotes-a-cote sur le meme poste. Acceptable car un poste est soit DGX soit
Scaleway, jamais les deux.

## Fichiers impactes

### Repo mirai-assistant-navigateur
- `src/dm/config.json` — profils `prod-scaleway` et `prod-dgx`
- `src/dm/manifest.json` — metadata catalogue DM (nom, icone, install_instructions)
- `src/background.js` — fix fallback `keycloakRealm || 'mirai'` → defensive
- `scripts/build.sh` — flag `--target`, patches post-copy, renommage artefacts
- `scripts/deploy-release.sh` — idem
- `src/popup.html` / `src/popup.js` / `src/options.js` — raccourcis simplifies

### Repo device-management
- `deploy/k8s/base/manifests/25-relay-assistant-configmap.yaml` — retrait auth_request Keycloak
- `deploy/docker/relay-assistant.conf.template` — idem
- `app/main.py` — bypass proxy httpx + fix env var name pour relay_assistant_proxy

## Verification

```bash
# Build DGX
scripts/build.sh --target=dgx --crx --xpi

# Verifier la config embarquee
unzip -p dist/mirai-browser-1.2.2-dgx.xpi dm-config.json | python3 -m json.tool

# Verifier l'icone dans le zip
unzip -l dist/mirai-browser-1.2.2-dgx.crx | grep assets/

# Build Scaleway
scripts/build.sh --target=scaleway --crx --xpi

# Tests
npm test
```

## Ordre de deploiement DGX

1. Deployer le patch nginx relay-assistant (configmap + rollout restart)
2. Deployer le patch main.py device-management (rollout restart)
3. Uploader le CRX via l'admin UI DM (`/admin/catalog`)
4. Les utilisateurs installent le CRX et se connectent via le relay

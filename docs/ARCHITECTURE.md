# Architecture & Capitalisation — IAssistant-Direct (by Mirai)

> Doc d'**onboarding** : comprendre le système en 20 min, connaître les **prérequis
> entreprise** indispensables, et savoir concevoir une **architecture redondante**.
> Fédère les enseignements du projet. Pour le détail opérationnel, voir les docs
> liées en §9.

---

## 1. Vision

Le plug-in n'est **pas qu'un enregistreur de réunions** : c'est une **base navigateur
pour des actions assistées par IA dans les applications web** de l'utilisateur.
Le socle mutualisable — authentification SSO, **session longue durée**, relais
sécurisé, Device Management, télémétrie, raccourcis contextuels — permet de brancher
de nouvelles actions sur d'autres applications métier sans re-développer l'auth,
l'enrôlement ni la distribution. La **capture/transcription de réunions** est la
première de ces actions.

---

## 2. Composants

```
 ┌─────────────────────── Poste utilisateur (navigateur) ───────────────────────┐
 │  Extension MV3 « IAssistant-Direct (by Mirai) » (slug mirai-browser)          │
 │   • overlay.js    content script sur les pages visio → bouton REC + wizard    │
 │   • popup / options                                                           │
 │   • welcome.html  page de bienvenue (1er lancement)                           │
 │   • background.js service worker : config (DMBootstrap), token, PKCE relais   │
 │   • crypto.js     TokenStore (token chiffré au repos)                         │
 └───────────┬───────────────────────┬───────────────────────┬──────────────────┘
             │ config / enroll        │ login PKCE (offline)   │ API réunions
             ▼                        ▼                        ▼
   ┌──────────────────┐     ┌──────────────────┐     ┌──────────────────────┐
   │ Device Management│     │ Keycloak (SSO)   │     │ mcr / compte-rendu   │
   │ (FastAPI + PG)   │     │ realm « mirai »  │     │ API (création/capture│
   │ catalogue, config│     │ PKCE, offline    │     │  de réunions)        │
   │ /profil, enroll, │     │ tokens 6 mois    │     └──────────────────────┘
   │ relay, télémétrie│     └──────────────────┘
   │ auto-update      │            ▲
   └──────────────────┘            │ (serveur) JWKS / token
        repo: device-management    │ via wireguard-proxy si egress restreint
```

- **Extension** (ce repo) : MV3, Chrome/Chromium/Edge + Firefox ESR. ID Chrome stable
  `cjaokgcdmdeakhkplbifninjcdklhokf` (clé PEM interne).
- **Device Management (DM)** (repo `device-management`) : catalogue de plug-ins,
  **config servie par profil**, enrôlement, relais, télémétrie OTLP, auto-update.
- **Keycloak** : SSO ministériel, realm `mirai`, client `mirai-extension`.
- **mcr / compte-rendu** : API qui crée et lance la capture des réunions.
- **relay-assistant / wireguard-proxy** : accès serveur à Keycloak/LLM quand l'egress
  est restreint.

---

## 3. Flux clés

1. **Config** — l'extension demande `GET {bootstrap_url}/config/mirai-browser/config.json?profile=prod`.
   Chaque DM **résout ses propres valeurs d'environnement** (placeholders `${{…}}`).
   Source unique côté client : `DMBootstrap` (popup **et** service worker).
2. **Auth / session** — PKCE (S256) dans un onglet normal → access token + **offline
   token** (scope `offline_access`) → **refresh silencieux sans re-login ~6 mois** →
   token **chiffré au repos** (AES-GCM). Le realm est dans l'URL (`/realms/mirai`).
3. **Enrôlement / relais** — après login, `POST /enroll` → credentials relais
   (essentiels sur DGX). La validation du token côté DM lit les **JWKS** Keycloak.
4. **Enregistrement** — bouton REC (overlay) → API mcr (`createMeeting`,
   `startCapture`).

---

## 4. Environnements & profils

| Profil | Rôle | Particularité |
|---|---|---|
| `dev` | build local | DM/Keycloak localhost |
| `int` | build intégration | placeholders résolus par le DM Scaleway |
| **`prod`** | **profil servi au runtime** (`?profile=prod`) | générique, placeholders `${{…}}` résolus par **chaque** DM |
| `prod-scaleway` | build cible cloud | bootstrap = DM Scaleway |
| `prod-dgx` | build cible on-prem | bootstrap = DM DGX (onyxia) |

Les cibles de build ne diffèrent que par leur **`bootstrap_url`** (quel DM joindre) ;
elles pointent toutes `config_path=?profile=prod`. **Sur DGX, Keycloak et l'API (mcr)
sont en accès direct** (egress navigateur ouvert) — l'ancien modèle « Keycloak via
relais / realm vide » est **obsolète** (voir `adr-dgx-deployment.md`).

---

## 5. Prérequis entreprise (INDISPENSABLES)

Rien ne fonctionne sans ces conditions, **fournies par l'IT / l'équipe SSO / le réseau**.

### 5.1 Keycloak / SSO
- Realm `mirai`, client **`mirai-extension`** : public, **PKCE (S256)**.
- **Valid redirect URIs** doivent inclure `chrome-extension://cjaokgcdmdeakhkplbifninjcdklhokf/*`
  (et le redirect silencieux `https://cjaokgcdmdeakhkplbifninjcdklhokf.chromiumapp.org/`).
- **Client scope `offline_access`** assigné (Default ou Optional).
- **Offline Session Idle / Max = 180 j** (session 6 mois sans re-login). Voir
  `keycloak-offline-tokens.md`.
- Le **navigateur** doit pouvoir joindre Keycloak (direct sur DGX/Scaleway).

### 5.2 Navigateur / poste
- Chromium/Edge ou Firefox ESR (≥ 128).
- **Installation** — 3 voies, par ordre de robustesse :
  1. **Force-install self-hosted** (recommandé) : policy `ExtensionInstallForcelist`
     pointant l'`update_url` du DM. **Aucune dépendance Internet/Web Store.**
     Voir `demande-changement-deploiement-navigateur.md`.
  2. **Mode développeur** : glisser le `.crx` téléchargé du DM (si dev-mode autorisé).
  3. ~~Chrome Web Store~~ : **impossible en air-gap** (exige les serveurs Google).
- ⚠️ Chrome ≥ 137 **ignore `--load-extension`** ; sur poste verrouillé, vérifier que
  le Mode développeur ou la force-install est autorisé.

### 5.3 Réseau / DNS / VPN
- Le **poste** doit joindre : le **DM** (bootstrap), **Keycloak**, l'**API mcr**.
- **Air-gap** : seul le DM est joignable → distribution + auto-update via le DM ;
  pas de flux Google/Internet.
- Hôtes internes résolus par **DNS interne / VPN** (ex. `*.interieur.gouv.fr`,
  `onyxia.gpu.minint.fr`).
- **Côté serveur** : le DM valide les tokens via les **JWKS** Keycloak ; si l'egress
  serveur est restreint, passage par **`wireguard-proxy`** (tunnel WG → SSO).

### 5.4 Device Management déployé
- DM (FastAPI + PostgreSQL) déployé ; plug-in **uploadé au catalogue** ; config par
  profil renseignée (les placeholders `${{…}}` résolus via les variables d'env du pod).
- **Registry d'images** accessible depuis le cluster (DockerHub / Scaleway).

### 5.5 Secrets
- Aucun secret dans le repo : `.env`, `secret-patch.yaml` **gitignorés** + `.example`
  fournis. **Rotation** régulière. En cas de fuite : scrub d'historique + rotation.

---

## 6. Architecture redondante (2 régions, sans load balancer global)

**Hypothèse retenue** : on déploie la stack (DM + API mcr) sur **2 régions**, **sans
GSLB / LB global automatique**. → C'est le **client (l'extension) qui fait le load
balancing / failover**.

```
          Région A                         Région B
   ┌──────────────────┐            ┌──────────────────┐
   │ DM-A  +  mcr-A    │            │ DM-B  +  mcr-B    │
   └────────▲─────────┘            └────────▲─────────┘
            │   ┌───────────────────────────┘
            │   │   le CLIENT essaie A, bascule sur B si A KO
   ┌────────┴───┴─────┐
   │  Extension       │   ───────────►  Keycloak SSO (CENTRAL, partagé)
   │  (client-side LB)│
   └──────────────────┘
```

### 6.1 Principe
Le client connaît une **liste ordonnée d'endpoints régionaux** (DM, API) et **bascule**
en cas d'échec/timeout. Pas besoin d'IP anycast ni de GSLB.

### 6.2 Côté client (extension)
- `config.json` : faire évoluer `bootstrap_url` (et `apiBase`) vers une **liste**
  `["https://dm-a…","https://dm-b…"]`. `DMBootstrap.fetchConfig` essaie A, puis B sur
  timeout/erreur. Idem pour les appels API mcr.
- **Politique de failover** : timeout court (2–5 s) + bascule ; **stickiness** (mémoriser
  la région saine en storage) ; re-essai de la région primaire en arrière-plan
  (retour à A quand A revient).
- Avantage : détecte les pannes **applicatives réelles** (pas juste réseau), contrairement
  à un simple DNS round-robin.

### 6.3 SSO (Keycloak)
- **Préférer un Keycloak central unique** (un seul realm). L'**offline token est valable
  quelle que soit la région applicative** → le failover DM/mcr **n'affecte pas l'auth**.
- Si 2 Keycloak (pour la résilience SSO) : nécessite **réplication des sessions/utilisateurs**
  (cross-DC Infinispan) — complexe. Compromis recommandé : **SSO central résilient en
  interne**, **applications régionales**.

### 6.4 Données (le vrai point dur)
- Le DM stocke **enrôlements + état des réunions** en PostgreSQL. Deux options :
  - **DB répliquée cross-région** (ex. réplication logique / primary+standby) → failover
    transparent, mais latence d'écriture + complexité.
  - **Région-locale + re-enrôlement idempotent** au failover : si le client bascule sur
    B, il **re-enrôle** (nouveaux credentials relais B). Plus simple, mais état partiellement
    dupliqué ; impose que l'enrôlement soit **idempotent** côté DM.
- mcr : une réunion lancée sur A n'est pas connue de B → soit état partagé, soit accepter
  qu'un failover en cours de réunion interrompe la capture (à documenter).

### 6.5 DNS
- Sans LB global, le **DNS multi-A (round-robin)** est une option *complémentaire* mais
  **ne fait pas de failover intelligent** (renvoie des IP mortes). Le **client-side LB**
  reste le mécanisme de bascule fiable.

### 6.6 Limites & recommandation
- Pas de LB global ⇒ la **bascule est détectée par le client** (latence de failover de
  quelques secondes) ; risque d'**état « split »** (enrôlement A vs B).
- **Recommandation** : Keycloak **central** + DB DM **répliquée** (ou région-affine avec
  **re-enrôlement idempotent**) + **failover client-side** sur DM et mcr, avec stickiness.

---

## 7. Enseignements / pièges (capitalisation)

| Sujet | Piège rencontré | Solution |
|---|---|---|
| **Injection overlay** | `matches` ne couvrait pas toutes les URLs (COMU intranet `comu.din.gouv.fr` absent) | Lister **toutes** les URLs plateforme (internet **et** intranet) |
| **URL Keycloak** | Le DM sert un issuer **sans** `/realms/{realm}` → URL d'auth cassée | Composer `issuer/realms/{realm}` ; **source unique = `DMBootstrap`** (popup ET service worker) |
| **Structure config** | `bootstrap.js` aplatit (`data.config`), le SW stockait l'objet brut → `keycloakRealm` absent | Stocker **aplati** partout |
| **Service worker** | pas de `XMLHttpRequest`, pas de `window` | utiliser `fetch` ; exposer les modules sur **`globalThis`** + `importScripts` |
| **Session longue** | — | `offline_access` + Offline Session 180 j + token chiffré ; révocation côté Keycloak |
| **Relay 401 à froid** (serveur) | JWKS via tunnel WG lent → 504 → token non vérifiable → 401 sur `/enroll` | nginx `upstream keepalive` + `proxy_connect_timeout 60` + pod **warmer** + `PyJWKClient(timeout=60)` |
| **Chrome ≥ 137/148** | `--load-extension` ignoré | Dev-mode, ou `Extensions.loadUnpacked` via CDP **pipe** (`--remote-debugging-pipe`) |
| **Air-gap install** | Web Store exige Internet | Force-install self-hosted via DM, ou dev-mode manuel |
| **Onboarding utilisateur** | l'utilisateur ne savait pas se connecter | **wizard** overlay (page visio) + **page de bienvenue** (1er lancement) |
| **Health-check DM** | sondait l'URL publique + mauvais port → faux `degraded` | sonder les vrais endpoints (proxy/realm, port du service) |
| **Secrets** | valeurs réelles committées | gitignore + `.example` ; scrub d'historique + **rotation** |
| **Erreur `redirect_uri` vide** | venait d'une **app web** (client `bootstrap-iassistant`), pas de l'extension | corriger le `redirect_uri` + Valid URIs **côté app web**, pas l'extension |

---

## 8. Démarrage rapide (onboarding)

```sh
# Extension (ce repo)
npm install
npm test                                  # suite Jest
scripts/build.sh --target=scaleway --crx --xpi   # ou --target=dgx
```

- **Charger en dev** : `chrome://extensions` → Mode développeur → charger `dist/extension/`.
- **Recette** (validation d'un DM) : `scripts/recette.py` (exécutable in-cluster via `kubectl exec`).
- **Déployer** : `scripts/deploy-release.sh --target=…` (upload CRX/XPI + manifestes au DM).
- **DM** : repo `device-management` (FastAPI + PostgreSQL + overlays K8s `dev/scaleway/dgx`).

---

## 9. Références

- `README.md` — présentation, build, config, déploiement.
- `adr-dgx-deployment.md` — décisions on-premise DGX (et bascule en accès direct).
- `keycloak-offline-tokens.md` — config realm pour la session 6 mois.
- `demande-changement-deploiement-navigateur.md` — force-install (distribution entreprise).
- `recette.py` + `recette-dgx-handoff.md` — recette automatique (intégration & DGX air-gap).
- `TESTING.md` — guide de test local.

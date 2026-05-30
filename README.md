# IAssistant-Direct (by Mirai) — v1.2.3

> Slug technique / device : `mirai-browser`

Extension Chrome/Firefox pour capturer et transcrire automatiquement les reunions
en ligne.

## Finalite

Au-dela de la capture de reunions, **ce plug-in est concu comme une base pour
permettre d'autres actions assistees (IA) directement dans les applications web**
de l'utilisateur. Le socle technique — authentification SSO, session longue duree,
relais securise, Device Management, telemetrie, raccourcis contextuels — est mutualisable
pour brancher de nouvelles actions assistees sur d'autres applications metier, sans
re-developper l'enrolement, l'auth ni la distribution. La capture de reunions est
la premiere de ces actions.

## Nouveautes v1.2.3

- Renommage du nom visible : **IAssistant-Direct (by Mirai)** (slug `mirai-browser` inchange)
- **Session longue duree** : offline token Keycloak (`offline_access`) — pas de re-login pendant ~6 mois
- **Token chiffre au repos** (AES-GCM via `crypto.js` / `TokenStore`)
- Overlay flottant sur les pages de visio (draggable, auto-minimize, position memorisee)
- Login PKCE via onglet normal (gestionnaire de mots de passe compatible)
- Support `visio.numerique.gouv.fr`
- Badge REC sur l'icone extension
- Sync des enregistrements avec le serveur au chargement
- Reconnexion SSO directe depuis l'overlay
- Refresh token automatique periodique
- **Build multi-cible on-premise** : cibles `prod-scaleway` et `prod-dgx` (flag `--target`),
  config runtime servie par chaque DM sous `?profile=prod`. Sur DGX, Keycloak et l'API (mcr)
  sont desormais en **acces direct** (egress navigateur ouvert) — plus de relais pour l'extension.

## Fonctionnalites

- **Enregistrement de reunions** — Webconf, Visio, COMU, Webinaire, Webex, Google Meet, Teams
- **Detection automatique** — detecte la plateforme et l'identifiant de reunion depuis l'URL
- **Overlay flottant** — bouton REC superpose sur les pages de visio, draggable, auto-minimize
- **Authentification SSO** — PKCE Keycloak avec login dans un onglet normal (gestionnaire de mots de passe compatible)
- **Session longue duree (offline)** — scope `offline_access` : le token est rafraichi silencieusement, sans re-login, jusqu'a ~6 mois (gouverne par les *Offline Session* Keycloak). Token stocke chiffre (AES-GCM)
- **Reconnexion automatique** — refresh token silencieux, lien "Se reconnecter" en cas d'expiration
- **Sync avec le serveur** — detecte les enregistrements en cours au chargement de la page
- **Badge REC** — indicateur rouge sur l'icone de l'extension quand un enregistrement est actif
- **Raccourcis MirAI** — acces rapide a Chat, Resume, Compte rendu, Comu, Aide
- **Multi-profils** — config centralisee dans `src/dm/config.json` ; cibles de build `prod-scaleway` / `prod-dgx` (flag `--target`) ; profil `prod` generique servi au runtime par chaque DM
- **Device Management** — enrollment, relay, telemetrie OTLP, auto-update

## Structure

```
manifest.json                 # Chrome MV3 + Firefox ESR
package.json / jest.config.js
src/
  popup.html / popup.js / popup.css   # Interface popup
  options.html / options.js           # Page options
  overlay.js                          # Bouton REC flottant (content script)
  callback.html / callback.js        # Page retour SSO
  auth.js                            # PKCE + enrollment DM
  background.js                      # Service worker
  recording.js                       # API meetings (start/stop/sync)
  compat.js                          # Bridge Chrome/Firefox
  crypto.js                          # Chiffrement AES-GCM
  dm/
    config.json                      # Config multi-profils
    manifest.json                    # Metadata DM
    bootstrap.js                     # Client config DM
    telemetry.js                     # Telemetrie OTLP
icons/                               # Icones extension
tests/                               # 106 tests Jest
scripts/
  build.sh                           # Build + packaging CRX/XPI
  deploy-release.sh                  # Deploy vers le DM
  register-dm.sh                     # Enregistrement du plugin dans le DM
  recette.py                         # Jeu de recette automatique (stdlib, in-cluster ou distant)
docs/
  adr-dgx-deployment.md              # ADR deploiement on-premise DGX
  keycloak-offline-tokens.md         # Config Keycloak session 6 mois (offline tokens)
  demande-changement-deploiement-navigateur.md  # Demande de changement IT (force-install)
  recette-dgx-handoff.md             # Handoff recette pour le DGX (air-gap)
```

## Installation dev

```bash
# Installer les dependances (tests)
npm install

# Charger dans Chrome
# chrome://extensions → Mode developpeur → Charger l'extension non empaquetee → dossier racine

# Charger dans Firefox ESR
# about:debugging#/runtime/this-firefox → Charger un module temporaire → manifest.json
```

## Tests

```bash
npm test              # 106 tests
npm run test:watch    # mode watch
npm run test:coverage # couverture
```

## Build

Les builds sont **parametres par cible de deploiement** via `--target=scaleway|dgx`
(defaut : `scaleway`). Les artefacts sont suffixes par la cible.

```bash
# Scaleway (cloud, defaut)
scripts/build.sh --target=scaleway --crx --xpi
# -> dist/mirai-browser-1.2.3-scaleway.crx
# -> dist/mirai-browser-1.2.3-scaleway.xpi

# DGX (on-premise onyxia.gpu.minint.fr)
scripts/build.sh --target=dgx --crx --xpi
# -> dist/mirai-browser-1.2.3-dgx.crx
# -> dist/mirai-browser-1.2.3-dgx.xpi

scripts/build.sh --target=dgx         # extension non empaquetee uniquement
```

Le `.crx` est signe avec `private/mirai-browser-key.pem` (non versionne). La meme
cle PEM est utilisee pour les deux cibles : Scaleway et DGX partagent donc le
meme Extension ID Chrome.

## Configuration

Les profils sont definis dans `src/dm/config.json`. Le build.sh patche
automatiquement `activeProfile` dans les copies distribuees selon `--target` ;
il n'est **pas** necessaire d'editer le fichier a la main pour changer de cible.

| Profil | role | bootstrap_url | Keycloak (fallback) |
|--------|------|--------------|----------|
| dev | build local | `http://localhost:3001` | `localhost:8082/realms/openwebui` |
| int | build integration | `https://bootstrap.fake-domain.name` | placeholders DM |
| **prod** | **profil servi au runtime** (`?profile=prod`) | — | `${{KEYCLOAK_ISSUER_URL}}` (resolu par chaque DM) |
| prod-scaleway | build cible Scaleway | `https://bootstrap.fake-domain.name` | `sso.mirai.interieur.gouv.fr/realms/mirai` |
| prod-dgx | build cible DGX | `https://onyxia.gpu.minint.fr/bootstrap` | `sso.mirai.interieur.gouv.fr/realms/mirai` |

**Resolution de la config au runtime** : les cibles `prod-scaleway` et `prod-dgx`
ne different plus que par leur `bootstrap_url` (quel DM joindre). Leur `config_path`
pointe sur **`?profile=prod`** : chaque DM (Scaleway / DGX) sert alors **ses propres
valeurs liees a l'environnement** (placeholders `${{...}}` resolus cote serveur).
Les valeurs Keycloak baties dans la cible servent uniquement de **fallback** si le
DM est injoignable.

> **DGX — acces direct** : l'egress navigateur DGX vers Keycloak et l'API (mcr)
> etant desormais ouvert, le profil DGX pointe Keycloak **directement**
> (`sso.mirai.interieur.gouv.fr`, realm `mirai`), comme Scaleway. Le `relayAssistantBaseUrl`
> et l'indirection `relay-assistant/keycloak` (ancien ADR §2/§3) ne sont **plus utilises
> par l'extension**.

## Deploy

```bash
# Deploy vers le DM Scaleway
DM_ADMIN_TOKEN=xxx scripts/deploy-release.sh --target=scaleway

# Deploy vers le DM DGX
DM_ADMIN_TOKEN=xxx scripts/deploy-release.sh --target=dgx

# Override de l'endpoint d'upload (ex: staging)
BOOTSTRAP_URL=https://dm-staging.example DM_ADMIN_TOKEN=xxx \
  scripts/deploy-release.sh --target=dgx
```

## Plateformes supportees

| Plateforme | URL | Mot de passe |
|-----------|-----|-------------|
| Webconf | `webconf.numerique.gouv.fr` | Non |
| Visio | `visio.numerique.gouv.fr` | Non |
| COMU | `webconf.comu.gouv.fr` | Oui (6 chiffres) |
| Webinaire | `webinaire.numerique.gouv.fr` | Non |

## Licence

MPL-2.0

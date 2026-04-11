# MirAI Browser v1.2.2

Extension Chrome/Firefox pour capturer et transcrire automatiquement les reunions en ligne.

## Nouveautes v1.2.2

- Overlay flottant sur les pages de visio (draggable, auto-minimize, position memorisee)
- Login PKCE via onglet normal (gestionnaire de mots de passe compatible)
- Support `visio.numerique.gouv.fr`
- Badge REC sur l'icone extension
- Sync des enregistrements avec le serveur au chargement
- Reconnexion SSO directe depuis l'overlay
- Refresh token automatique periodique
- **Build multi-cible on-premise** : profils `prod-scaleway` et `prod-dgx`, flag `--target` sur `build.sh` et `deploy-release.sh`

## Fonctionnalites

- **Enregistrement de reunions** — Webconf, Visio, COMU, Webinaire, Webex, Google Meet, Teams
- **Detection automatique** — detecte la plateforme et l'identifiant de reunion depuis l'URL
- **Overlay flottant** — bouton REC superpose sur les pages de visio, draggable, auto-minimize
- **Authentification SSO** — PKCE Keycloak avec login dans un onglet normal (gestionnaire de mots de passe compatible)
- **Reconnexion automatique** — refresh token silencieux, lien "Se reconnecter" en cas d'expiration
- **Sync avec le serveur** — detecte les enregistrements en cours au chargement de la page
- **Badge REC** — indicateur rouge sur l'icone de l'extension quand un enregistrement est actif
- **Raccourcis MirAI** — acces rapide a Chat, Resume, Compte rendu, Comu, Aide
- **Multi-profils** — configuration dev / int / prod-scaleway / prod-dgx centralisee dans `src/dm/config.json`, selectionnable au build via `--target`
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
tests/                               # 103 tests Jest
scripts/
  build.sh                           # Build + packaging CRX/XPI
  deploy-release.sh                  # Deploy vers le DM
  register-dm.sh                     # Enregistrement du plugin dans le DM
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
npm test              # 103 tests
npm run test:watch    # mode watch
npm run test:coverage # couverture
```

## Build

Les builds sont **parametres par cible de deploiement** via `--target=scaleway|dgx`
(defaut : `scaleway`). Les artefacts sont suffixes par la cible.

```bash
# Scaleway (cloud, defaut)
scripts/build.sh --target=scaleway --crx --xpi
# -> dist/mirai-browser-1.2.2-scaleway.crx
# -> dist/mirai-browser-1.2.2-scaleway.xpi

# DGX (on-premise onyxia.gpu.minint.fr)
scripts/build.sh --target=dgx --crx --xpi
# -> dist/mirai-browser-1.2.2-dgx.crx
# -> dist/mirai-browser-1.2.2-dgx.xpi

scripts/build.sh --target=dgx         # extension non empaquetee uniquement
```

Le `.crx` est signe avec `private/mirai-browser-key.pem` (non versionne). La meme
cle PEM est utilisee pour les deux cibles : Scaleway et DGX partagent donc le
meme Extension ID Chrome.

## Configuration

Les profils sont definis dans `src/dm/config.json`. Le build.sh patche
automatiquement `activeProfile` dans les copies distribuees selon `--target` ;
il n'est **pas** necessaire d'editer le fichier a la main pour changer de cible.

| Profil | bootstrap_url | Keycloak |
|--------|--------------|----------|
| dev | `http://localhost:3001` | `localhost:8082/realms/openwebui` |
| int | `https://bootstrap.fake-domain.name` | placeholders DM |
| prod-scaleway | `https://bootstrap.fake-domain.name` | `sso.mirai.interieur.gouv.fr/realms/mirai` |
| prod-dgx | `https://onyxia.gpu.minint.fr/bootstrap` | `sso.mirai.interieur.gouv.fr/realms/mirai` |

Seuls `bootstrap_url` et `relayAssistantBaseUrl` changent entre les deux cibles
prod ; toutes les autres URLs (Keycloak, apiBase, chat, resume, compte-rendu)
sont identiques.

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

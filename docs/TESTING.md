# Guide de test complet — IAssistant-Direct (by Mirai)

## Vue d'ensemble

```
                Tests unitaires     Debug navigateur     Deploy DM
                (local, Jest)       (VSCode, Chrome)     (script, serveur)
                     |                    |                    |
  npm test ──────────┘                    |                    |
  F5 dans VSCode ─────────────────────────┘                    |
  scripts/deploy-release.sh ───────────────────────────────────┘
```

---

## Etape 1 — Tests unitaires (Jest)

### 1.1 Lancer les tests

```bash
npm test                # 101 tests, ~1s
npm run test:watch      # relance a chaque modif
npm run test:coverage   # rapport de couverture
```

### 1.2 Ce qui est couvert

| Fichier test              | Ce qu'il valide                                          |
|---------------------------|----------------------------------------------------------|
| `auth.test.js`            | PKCE flow, refresh, enrollment DM, relay, logout         |
| `background.test.js`      | Service worker, UUID, alarm 30min, notifications update  |
| `dm-bootstrap.test.js`    | Config fetch, cache, fallback, merge, headers DM         |
| `dm-telemetry.test.js`    | Spans OTLP, buffer, flush, retry, token refresh          |
| `manifest-html.test.js`   | Structure manifest, profils config, ordre des scripts    |
| `url-refactoring.test.js` | Migration URLs hardcodees vers config DM + auth.js       |

### 1.3 Ajouter un test

Les tests chargent les fichiers source via `eval()` avec les mocks Chrome definis dans `tests/setup.js`. Pour ajouter un test :

```js
// tests/mon-test.test.js
beforeEach(() => {
  __resetChromeStorage();
  jest.clearAllMocks();
  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'mon-fichier.js'), 'utf8');
  eval(code);
});
```

---

## Etape 2 — Debug dans le navigateur

### 2.1 Prerequis

| Navigateur | Installation |
|------------|-------------|
| Chromium (recommande) | `brew install --cask chromium` |
| Chrome stable | Deja installe — mais `--load-extension` bloque |
| Firefox ESR | `brew install --cask firefox` |

### 2.2 Methode A — Chromium via VSCode (automatique)

1. Ouvrir le projet dans VSCode
2. **Run & Debug** (Ctrl+Shift+D) → **"Debug IAssistant-Direct (by Mirai) — (Chromium)"**
3. Appuyer sur **F5**
4. Chromium s'ouvre avec l'extension chargee automatiquement
5. L'icone MirAI apparait dans la barre d'outils

### 2.3 Methode B — Chrome stable (chargement manuel)

1. **Run & Debug** → **"Debug IAssistant-Direct (by Mirai) — (Chrome — manual load)"**
2. **F5** → Chrome s'ouvre sur `chrome://extensions`
3. Activer le **Mode developpeur** (toggle en haut a droite)
4. Cliquer **"Charger l'extension non empaquetee"**
5. Selectionner le dossier racine du projet : `mirai-assistant-navigateur/`
6. L'extension apparait dans la liste

### 2.4 Methode C — Firefox ESR

1. **Run & Debug** → **"Debug IAssistant-Direct (by Mirai) — (Firefox ESR)"**
2. **F5** → Firefox s'ouvre
3. L'extension est chargee temporairement (perdue a la fermeture)

### 2.5 Verifier que l'extension fonctionne

Apres le chargement, verifier ces points :

| Verification | Comment |
|---|---|
| Extension visible | Icone MirAI dans la barre d'outils |
| Popup s'ouvre | Cliquer sur l'icone |
| Pas d'erreurs | `chrome://extensions` → pas de bouton "Erreurs" rouge |
| Service worker actif | `chrome://extensions` → "Inspecter les vues : Service Worker" |

### 2.6 Tester le flow PKCE

1. Ouvrir le popup MirAI
2. Cliquer sur un raccourci (ex: "MirAI Chat")
3. Une fenetre Keycloak doit s'ouvrir
4. Se connecter avec ses identifiants MirAI
5. La fenetre se ferme et le raccourci s'ouvre

**Verifier le token dans la console** (F12 dans le popup) :
```js
chrome.storage.local.get(['miraiToken', 'dmEnrollment'], console.log)
```

Resultat attendu :
```js
{
  miraiToken: {
    access_token: "eyJ...",
    refresh_token: "eyJ...",
    expires_in: 1711872000000
  },
  dmEnrollment: {
    enrolled: true,
    enrolledAt: 1711868400000,
    relayToken: "..."  // seulement si relay DM configure
  }
}
```

### 2.7 Tester l'enregistrement

1. Ouvrir un onglet sur une plateforme supportee :
   - `https://webconf.numerique.gouv.fr/...`
   - `https://webconf.comu.gouv.fr/...`
2. Ouvrir le popup MirAI
3. La plateforme et l'identifiant doivent etre detectes automatiquement
4. Cliquer sur le bouton REC (rond rouge)
5. Le chronometre demarre, le bouton pulse
6. Re-cliquer pour arreter

### 2.8 Inspecter les logs

| Contexte | Ou regarder |
|---|---|
| Popup | Clic droit sur l'icone → "Inspecter l'element du popup" |
| Service worker | `chrome://extensions` → "Inspecter les vues : Service Worker" |
| Options | Ouvrir la page options → F12 |
| Telemetrie | Onglet Network dans le DevTools du popup (appels OTLP) |

Les logs sont prefixes :
- `[MirAI Auth]` — authentification PKCE
- `[MirAI DM]` — Device Management config
- `[MirAI Telemetry]` — spans OTLP
- `[MirAI Compat]` — bridge Chrome/Firefox

---

## Etape 3 — Test du deploiement DM

### 3.1 Dry-run local (sans serveur)

Valider que le packaging fonctionne sans envoyer au serveur :

```bash
# Simuler le build
SLUG="mirai-recorder"
BUILD_DIR="/tmp/${SLUG}-build"
OUT_DIR="/tmp/${SLUG}-release"
rm -rf "$BUILD_DIR" "$OUT_DIR"
mkdir -p "$BUILD_DIR" "$OUT_DIR/updates"

# Copier les fichiers
cp manifest.json package.json "$BUILD_DIR/"
cp -r src/ "$BUILD_DIR/src/"
cp -r icons/ "$BUILD_DIR/icons/"

# Verifier le contenu
echo "=== Fichiers dans le build ==="
find "$BUILD_DIR" -type f | sort

# Verifier qu'il n'y a pas de fichiers parasites
echo ""
echo "=== Verification ==="
for bad in tests docs design scripts private node_modules .vscode; do
  [ -d "$BUILD_DIR/$bad" ] && echo "ERREUR: $bad present!" || echo "OK: pas de $bad"
done

# Nettoyer
rm -rf "$BUILD_DIR" "$OUT_DIR"
```

### 3.2 Build CRX + XPI (sans upload)

```bash
# Necessite la cle PEM dans private/
PRIVATE_DIR="$(pwd)/private"
PEM_KEY="$PRIVATE_DIR/mirai-recorder-key.pem"

# Build CRX (necessite Chromium installe)
"/Applications/Chromium.app/Contents/MacOS/Chromium" \
  --pack-extension="$BUILD_DIR" \
  --pack-extension-key="$PEM_KEY"

# Build XPI
cd "$BUILD_DIR" && zip -r "$OUT_DIR/mirai-recorder.xpi" .
```

### 3.3 Deploy complet vers un serveur DM

```bash
export BOOTSTRAP_URL="https://dm.ton-domaine.gouv.fr"
export DM_ADMIN_TOKEN="ton-token-admin"

scripts/deploy-release.sh
```

Le script :
1. Cree un build propre (src/ + icons/ + manifest.json)
2. Injecte les `update_url` dans le manifest
3. Genere le `.crx` signe et le `.xpi`
4. Genere les manifests d'auto-update (XML + JSON)
5. Upload tout vers le serveur DM
6. Affiche un resume avec les URLs

### 3.4 Verifier le deploiement

Apres le deploy, verifier ces endpoints sur le serveur :

```bash
# Config DM accessible ?
curl -s "$BOOTSTRAP_URL/config/mirai-recorder/config.json?profile=int" | python3 -m json.tool

# Manifest d'update Chrome ?
curl -s "$BOOTSTRAP_URL/updates/mirai-recorder.xml"

# Manifest d'update Firefox ?
curl -s "$BOOTSTRAP_URL/updates/mirai-recorder.json"

# Artifact telechargeable ?
curl -sI "$BOOTSTRAP_URL/releases/mirai-recorder-1.2.1.crx"
curl -sI "$BOOTSTRAP_URL/releases/mirai-recorder-1.2.1.xpi"
```

---

## Etape 4 — Test du Keycloak local (optionnel)

Pour tester le flow PKCE sans le SSO de production.

### 4.1 Lancer Keycloak

```bash
docker run -d --name keycloak \
  -p 8443:8443 -p 8080:8080 \
  -e KEYCLOAK_ADMIN=admin \
  -e KEYCLOAK_ADMIN_PASSWORD=admin \
  quay.io/keycloak/keycloak:latest start-dev
```

### 4.2 Configurer le realm

1. Ouvrir `http://localhost:8080/admin` (admin/admin)
2. Creer un realm : **mirai**
3. Creer un client :
   - Client ID : **mirai-extension**
   - Client authentication : **OFF** (public client)
   - Standard flow : **ON**
   - Valid redirect URIs : `https://*.chromiumapp.org/*`
   - Web origins : `*`
4. Dans les parametres avances du client :
   - Proof Key for Code Exchange : **S256**
5. Creer un utilisateur test : `test@example.com` / `password`

### 4.3 Pointer l'extension vers le Keycloak local

Modifier `src/dm/config.json`, profil `local` :

```json
"local": {
  "ssoBaseUrl": "http://localhost:8080",
  "keycloakRealm": "mirai",
  "keycloakClientId": "mirai-extension",
  ...
}
```

Puis dans `src/dm/bootstrap.js`, changer temporairement `_defaultProfile` :

```js
_defaultProfile: 'local',
```

Recharger l'extension et tester le login.

---

## Etape 5 — CI/CD avec GitHub Actions (optionnel)

Le projet n'a pas encore de CI. Voici un workflow de base :

Creer `.github/workflows/test.yml` :

```yaml
name: Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm test

  package:
    runs-on: ubuntu-latest
    needs: test
    if: github.ref == 'refs/heads/main'
    steps:
      - uses: actions/checkout@v4
      - name: Build XPI
        run: |
          mkdir -p dist
          cp manifest.json package.json dist/
          cp -r src/ dist/src/
          cp -r icons/ dist/icons/
          cd dist && zip -r ../mirai-recorder.xpi .
      - uses: actions/upload-artifact@v4
        with:
          name: mirai-recorder-xpi
          path: mirai-recorder.xpi
```

---

## Checklist rapide

```
[ ] npm test                          → 101 tests passent
[ ] F5 dans VSCode                    → extension chargee, pas d'erreurs
[ ] Popup s'ouvre                     → URL detectee, boutons visibles
[ ] Flow PKCE                         → fenetre SSO, token stocke
[ ] Raccourcis                        → ouvrent les services MirAI
[ ] Enregistrement                    → demarre/arrete sur plateforme supportee
[ ] Build CRX/XPI                     → artifacts generes sans erreur
[ ] Deploy DM                         → endpoints accessibles sur le serveur
[ ] Auto-update                       → manifest XML/JSON publies
```

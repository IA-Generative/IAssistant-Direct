#!/usr/bin/env bash
# smoke-deploy.sh — Pipeline build + smoke test + packaging de l'extension,
# avec instructions de déploiement.
#
# Le CHARGEMENT dans un navigateur n'est pas automatisable de façon fiable
# (MV3 + politiques d'entreprise) : c'est l'étape manuelle finale, détaillée
# dans tests/TEST-MANUEL-utilisateur.md (recette par un utilisateur).
#
# Usage: scripts/smoke-deploy.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> [1/4] Smoke tests + suite Jest"
npx jest --silent

echo ""
echo "==> [2/4] Build prod (extension non empaquetée + .xpi)"
BUILD_ARGS=(--target=prod --xpi)
if [ -f "$ROOT_DIR/private/mirai-browser-key.pem" ]; then
  BUILD_ARGS+=(--crx)
  echo "    clé PEM trouvée -> .crx signé inclus"
else
  echo "    pas de clé PEM -> .crx ignoré (unpacked + .xpi seulement)"
fi
scripts/build.sh "${BUILD_ARGS[@]}"

echo ""
echo "==> [3/4] Vérification des artefacts"
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
[ -f "dist/extension/manifest.json" ] || { echo "KO: extension non buildée"; exit 1; }
[ -f "dist/iassistant-direct-browser-${VERSION}-prod.xpi" ] || { echo "KO: XPI manquant"; exit 1; }
echo "    OK extension v${VERSION} (dist/extension/ + .xpi)"

echo ""
echo "==> [4/4] Déploiement"
cat <<EOF
  Déploiement navigateur = ÉTAPE MANUELLE (non automatisable headless) :
   - Chrome/Chromium : chrome://extensions -> activer le mode développeur
       -> "Charger l'extension non empaquetée" -> ${ROOT_DIR}/dist/extension/
   - Firefox : about:debugging#/runtime/this-firefox
       -> "Charger un module temporaire" -> dist/iassistant-direct-browser-${VERSION}-prod.xpi
   - Flotte : publication via Device Management (catalogue DM).
  Recette utilisateur : tests/TEST-MANUEL-utilisateur.md
EOF
echo ""
echo "SMOKE-DEPLOY OK (extension)"

#!/usr/bin/env bash
# register-dm.sh — Enregistre le plugin mirai-browser dans le Device Management
#
# Usage:
#   scripts/register-dm.sh                         → DM local (localhost:3001)
#   DM_URL=https://dm.example.gouv.fr scripts/register-dm.sh  → DM distant
#
# Prerequis:
#   - Le serveur DM doit etre accessible
#   - Les fichiers src/dm/manifest.json et src/dm/config.json doivent exister
#   - Optionnel: dist/mirai-browser-*.crx pour upload du binaire

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DM_URL="${DM_URL:-http://localhost:3001}"
MANIFEST="$ROOT_DIR/src/dm/manifest.json"
CONFIG="$ROOT_DIR/src/dm/config.json"

[ -f "$MANIFEST" ] || { echo "ERREUR: $MANIFEST introuvable"; exit 1; }
[ -f "$CONFIG" ] || { echo "ERREUR: $CONFIG introuvable"; exit 1; }

SLUG=$(python3 -c "import json; print(json.load(open('$MANIFEST'))['slug'])")
VERSION=$(python3 -c "import json; print(json.load(open('$ROOT_DIR/manifest.json'))['version'])")

echo "============================================"
echo " Enregistrement plugin dans Device Management"
echo "============================================"
echo " DM URL  : $DM_URL"
echo " Slug    : $SLUG"
echo " Version : $VERSION"
echo ""

# ──────────────────────────────────────────────
# 1. Verifier que le DM est accessible
# ──────────────────────────────────────────────
echo -n "Verification DM... "
if ! curl -sf --max-time 5 "$DM_URL/" > /dev/null 2>&1; then
  echo "ERREUR"
  echo ""
  echo "Le serveur DM n'est pas accessible sur $DM_URL"
  echo ""
  echo "Pour lancer le DM en local :"
  echo "  cd /Users/etiquet/Documents/GitHub/device-management/deploy/docker"
  echo "  docker compose up -d"
  echo ""
  exit 1
fi
echo "OK"

# ──────────────────────────────────────────────
# 2. Verifier si le plugin existe deja
# ──────────────────────────────────────────────
echo -n "Verification plugin existant... "
EXISTING=$(curl -sf "$DM_URL/config/$SLUG/config.json?profile=dev" 2>/dev/null || echo "")
if [ -n "$EXISTING" ]; then
  echo "EXISTE DEJA"
  echo "  Le plugin $SLUG est deja enregistre dans le DM."
  echo "  Pour mettre a jour la config, utilisez scripts/deploy-release.sh"
  echo ""
  echo "Config actuelle :"
  echo "$EXISTING" | python3 -m json.tool 2>/dev/null || echo "$EXISTING"
  exit 0
fi
echo "nouveau plugin"

# ──────────────────────────────────────────────
# 3. Fusionner manifest + config_template
# ──────────────────────────────────────────────
echo -n "Preparation du payload... "

# Construire le JSON pour l'API admin /admin/catalog/new
PAYLOAD=$(python3 -c "
import json

manifest = json.load(open('$MANIFEST'))
config = json.load(open('$CONFIG'))

# Le DM attend config_template = le contenu du dm-config.json
payload = {
    'slug': manifest['slug'],
    'name': manifest['name'],
    'description': manifest['description'],
    'intent': manifest.get('intent', ''),
    'device_type': manifest.get('device_type', 'chrome'),
    'category': manifest.get('category', 'productivity'),
    'publisher': manifest.get('publisher', 'DTNUM'),
    'visibility': manifest.get('visibility', 'public'),
    'homepage_url': manifest.get('homepage_url', ''),
    'support_email': manifest.get('support_email', ''),
    'icon_url': manifest.get('icon_url', ''),
    'doc_url': manifest.get('doc_url', ''),
    'license': manifest.get('license', ''),
    'key_features': manifest.get('key_features', []),
    'install_instructions': manifest.get('install_instructions', {}),
    'changelog': manifest.get('changelog', []),
    'config_template': config
}

print(json.dumps(payload, ensure_ascii=False))
")
echo "OK"

# ──────────────────────────────────────────────
# 4. Enregistrer via l'API
# ──────────────────────────────────────────────
echo ""
echo "Envoi au DM..."
echo ""

# Methode 1: API REST directe (si disponible)
RESPONSE=$(curl -sf -X POST "$DM_URL/catalog/api/plugins" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>&1 || echo "API_ERROR")

if [ "$RESPONSE" = "API_ERROR" ]; then
  # Methode 2: Essayer l'endpoint admin
  RESPONSE=$(curl -sf -X POST "$DM_URL/admin/catalog/new" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" 2>&1 || echo "ADMIN_ERROR")
fi

if [[ "$RESPONSE" == *"ERROR"* ]]; then
  echo "L'enregistrement automatique a echoue."
  echo ""
  echo "========================================="
  echo " ENREGISTREMENT MANUEL"
  echo "========================================="
  echo ""
  echo "1. Ouvrir l'admin DM :"
  echo "   $DM_URL/admin/catalog/new"
  echo ""
  echo "2. Remplir les champs :"
  echo "   Slug         : $SLUG"
  echo "   Name         : $(python3 -c "import json; print(json.load(open('$MANIFEST'))['name'])")"
  echo "   Device type  : chrome"
  echo "   Description  : (copier depuis src/dm/manifest.json)"
  echo "   Intent       : (copier depuis src/dm/manifest.json)"
  echo ""
  echo "3. Dans le champ 'Config template', coller le contenu de :"
  echo "   src/dm/config.json"
  echo ""
  echo "4. Optionnel — uploader le binaire :"
  CRX=$(ls "$ROOT_DIR/dist/mirai-browser-"*.crx 2>/dev/null | head -1)
  if [ -n "$CRX" ]; then
    echo "   $CRX"
  else
    echo "   (lancer scripts/build.sh --crx d'abord)"
  fi
  echo ""
  echo "========================================="
  echo ""
  echo "Ou copier-coller cette commande curl :"
  echo ""
  echo "curl -X POST '$DM_URL/admin/catalog/new' \\"
  echo "  -H 'Content-Type: application/json' \\"
  echo "  -d '$(echo "$PAYLOAD" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)))")'"
  echo ""
else
  echo "Reponse DM :"
  echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
  echo ""
  echo "Plugin $SLUG enregistre avec succes."
fi

# ──────────────────────────────────────────────
# 5. Verifier
# ──────────────────────────────────────────────
echo ""
echo -n "Verification... "
sleep 1
CHECK=$(curl -sf "$DM_URL/config/$SLUG/config.json?profile=dev" 2>/dev/null || echo "")
if [ -n "$CHECK" ]; then
  echo "OK — le plugin repond sur /config/$SLUG/config.json"
else
  echo "Le plugin n'est pas encore visible (normal si enregistrement manuel)"
fi

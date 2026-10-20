#!/usr/bin/env bash
# deploy-release.sh — Package, sign and deploy MirAI Recorder to Device Manager
# Usage:
#   BOOTSTRAP_URL=https://dm.example.gouv.fr DM_ADMIN_TOKEN=xxx \
#     scripts/deploy-release.sh --target=dgx
#
# Targets:
#   --target=prod (default) → profile prod (UN package, liste bootstrap_urls scannee)
# Le DM cible de l'upload = $BOOTSTRAP_URL (override l'endpoint par defaut ci-dessous).
#
# Produces:
#   - ${SLUG}-${VERSION}-${TARGET}.crx   (Chrome, signed with PEM key)
#   - ${SLUG}-${VERSION}-${TARGET}.xpi   (Firefox ESR)
#   - updates/${SLUG}/${TARGET}.xml  (Chrome auto-update manifest)
#   - updates/${SLUG}/${TARGET}.json (Firefox auto-update manifest)
#   - Uploads everything to the DM bootstrap server at $BOOTSTRAP_URL

set -euo pipefail

# ──────────────────────────────────────────────
# Parse --target
# ──────────────────────────────────────────────
TARGET="prod"
for arg in "$@"; do
  case "$arg" in
    --target=*) TARGET="${arg#--target=}" ;;
  esac
done

# TARGET_BOOTSTRAP = endpoint d'upload par defaut (le DM cible). Surchargeable par
# BOOTSTRAP_URL pour publier le MEME package vers chaque DM (scaleway/dgx/onprem).
case "$TARGET" in
  prod) PROFILE="prod" ; TARGET_BOOTSTRAP="https://bootstrap.apps.ocpbm02s2.cores.r2.pi2.minint.fr" ;;
  *) echo "ERROR: unknown target '$TARGET' (expected: prod)" >&2 ; exit 1 ;;
esac

# ──────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────
SLUG="iassistant-direct-browser"
GECKO_ID="mirai-assistant@interieur.gouv.fr"

# --- Pipeline catalogue DM (le DM genere les manifests d'update) ---
# Le client = autorite version/changelog/binaire ; le DM = autorite manifests/URLs.
# Valeurs confirmees par l'agent DM (image 0.6.x). Override possible par env.
TOKEN_HEADER="${TOKEN_HEADER:-x-admin-token}"        # comparé constant-time, insensible casse
DISTRIBUTION_MODE="${DISTRIBUTION_MODE:-managed}"    # managed|download_link|store|manual
# platform_variant = "<engine>-<target>" (chromium-${TARGET} / gecko-${TARGET}).
# C'est la cle que le DM cherche pour generer chaque manifest d'update :
#   /updates/{slug}/{target}.xml  -> chromium-${TARGET}
#   /updates/{slug}/{target}.json -> gecko-${TARGET}
# Un variant DISTINCT par moteur => les .crx et .xpi coexistent sous 1 plugin_version
# (sinon ON CONFLICT sur (version,variant) ecrase l'un par l'autre). Voir main.py:_UPDATE_ENGINE_BY_EXT.
ENVIRONMENT="${ENVIRONMENT:-prod}"                   # dev|int|prod (defaut DM = dev)
# plugin_id = id ENTIER du catalogue (PAS le slug) ; resolu via GET /catalog/api/plugins.
# Surchargeable par env (CI / tests hors-ligne).
PLUGIN_ID="${PLUGIN_ID:-}"
# BOOTSTRAP_URL = DM cible de l'upload (= le DM de la region TARGET). Override staging possible.
BOOTSTRAP_URL="${BOOTSTRAP_URL:-$TARGET_BOOTSTRAP}"
# Token de service CI : x-admin-token = <DM_QUEUE_ADMIN_TOKEN> (fallback DM_ADMIN_TOKEN).
ADMIN_TOKEN="${DM_QUEUE_ADMIN_TOKEN:-${DM_ADMIN_TOKEN:-}}"
[ -n "$ADMIN_TOKEN" ] || { echo "ERROR: DM_QUEUE_ADMIN_TOKEN not set"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PRIVATE_DIR="$EXT_DIR/private"
PEM_KEY="$PRIVATE_DIR/mirai-browser-key.pem"
[ -f "$PEM_KEY" ] || { echo "ERROR: PEM key not found at $PEM_KEY"; exit 1; }

BUILD_DIR="/tmp/${SLUG}-build"
OUT_DIR="/tmp/${SLUG}-release"

# Read version from manifest.json
VERSION=$(python3 -c "import json; print(json.load(open('$EXT_DIR/manifest.json'))['version'])")
# Release notes = changelog de la version courante (src/dm/manifest.json), pour le DM
RELEASE_NOTES=$(python3 -c "
import json
cl = json.load(open('$EXT_DIR/src/dm/manifest.json')).get('changelog', [{}])[0]
print('; '.join(cl.get('changes', [])))
")
echo "Building $SLUG v$VERSION (target=$TARGET, profile=$PROFILE)..."
echo "  Target bootstrap (baked into artefact) : $TARGET_BOOTSTRAP"
echo "  Upload endpoint  (DM server)           : $BOOTSTRAP_URL"

# Derive Chrome extension ID from PEM key
EXTENSION_ID=$(openssl rsa -in "$PEM_KEY" -pubout -outform DER 2>/dev/null | python3 -c "
import sys, hashlib
der = sys.stdin.buffer.read()
digest = hashlib.sha256(der).hexdigest()[:32]
print(''.join(chr(ord('a') + int(c, 16)) for c in digest))
")
echo "Extension ID: $EXTENSION_ID"

# ──────────────────────────────────────────────
# 1. Prepare clean build directory
# ──────────────────────────────────────────────
rm -rf "$BUILD_DIR" "$OUT_DIR"
mkdir -p "$BUILD_DIR" "$OUT_DIR"

# Copy only what the extension needs
cp "$EXT_DIR/manifest.json" "$BUILD_DIR/"
cp "$EXT_DIR/package.json" "$BUILD_DIR/"
cp "$EXT_DIR/README.md" "$BUILD_DIR/" 2>/dev/null || true
cp -r "$EXT_DIR/src/" "$BUILD_DIR/src/"
cp -r "$EXT_DIR/icons/" "$BUILD_DIR/icons/"

# DM icon: see build.sh for rationale. Duplicate icons/icon128.png into
# assets/icon128.png at ZIP root so device-management can extract it and
# render it as a base64 data URL in the catalog.
mkdir -p "$BUILD_DIR/assets"
cp "$EXT_DIR/icons/icon128.png" "$BUILD_DIR/assets/icon128.png"

# Inject update_url into manifest.json for auto-update.
# Vise le DM de PRODUCTION de la cible (TARGET_BOOTSTRAP), pas l'endpoint d'upload
# (BOOTSTRAP_URL, override-able vers un DM de staging). Routes GÉNÉRÉES par le DM.
python3 -c "
import json
m = json.load(open('$BUILD_DIR/manifest.json'))
m['update_url'] = '${TARGET_BOOTSTRAP}/updates/${SLUG}/${TARGET}.xml'
m['browser_specific_settings']['gecko']['update_url'] = '${TARGET_BOOTSTRAP}/updates/${SLUG}/${TARGET}.json'
json.dump(m, open('$BUILD_DIR/manifest.json', 'w'), indent=2, ensure_ascii=False)
"

# Target-specific patches on the copied sources (same as build.sh §2.b)
python3 - <<PYEOF
import json, re
profile = "$PROFILE"
bootstrap_url = "$TARGET_BOOTSTRAP"

# 1. Patch src/dm/config.json: select activeProfile
cfg_path = "$BUILD_DIR/src/dm/config.json"
with open(cfg_path) as f:
    d = json.load(f)
d["activeProfile"] = profile
with open(cfg_path, "w") as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
    f.write("\n")

# 2. Patch hardcoded fallback in bootstrap.js
bp = "$BUILD_DIR/src/dm/bootstrap.js"
with open(bp) as f:
    txt = f.read()
txt = re.sub(
    r"bootstrap_url:\s*'[^']*'",
    f"bootstrap_url: '{bootstrap_url}'",
    txt, count=1,
)
with open(bp, "w") as f:
    f.write(txt)

# 3. Patch hardcoded fallback in background.js
bg = "$BUILD_DIR/src/background.js"
with open(bg) as f:
    txt = f.read()
txt = re.sub(
    r"(cachedConfig\?\.bootstrap_url\s*\|\|\s*)'[^']*'",
    lambda m: m.group(1) + f"'{bootstrap_url}'",
    txt, count=1,
)
with open(bg, "w") as f:
    f.write(txt)

print(f"  activeProfile baked = {profile}")
print(f"  bootstrap_url baked = {bootstrap_url}")
PYEOF

echo "Build directory ready ($(find "$BUILD_DIR" -type f | wc -l | tr -d ' ') files)"

# ──────────────────────────────────────────────
# 2. Package CRX (Chrome)
# ──────────────────────────────────────────────
echo "Packaging CRX..."

# Check for Chrome/Chromium
CHROME_BIN=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "$(which google-chrome 2>/dev/null || true)" \
  "$(which chromium 2>/dev/null || true)"; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    CHROME_BIN="$candidate"
    break
  fi
done

if [ -n "$CHROME_BIN" ]; then
  "$CHROME_BIN" --pack-extension="$BUILD_DIR" --pack-extension-key="$PEM_KEY" 2>/dev/null || true
  # Chrome outputs the .crx next to the build dir
  if [ -f "${BUILD_DIR}.crx" ]; then
    mv "${BUILD_DIR}.crx" "$OUT_DIR/${SLUG}-${VERSION}-${TARGET}.crx"
    echo "  OK  ${SLUG}-${VERSION}-${TARGET}.crx"
  else
    echo "  WARN  CRX packaging failed, skipping"
  fi
else
  echo "  WARN  Chrome/Chromium not found, skipping CRX packaging"
fi

# ──────────────────────────────────────────────
# 3. Package XPI (Firefox)
# ──────────────────────────────────────────────
echo "Packaging XPI..."
(cd "$BUILD_DIR" && zip -r -q "$OUT_DIR/${SLUG}-${VERSION}-${TARGET}.xpi" .)
echo "  OK  ${SLUG}-${VERSION}-${TARGET}.xpi"

# ──────────────────────────────────────────────
# 4. Publier les artefacts au pipeline catalogue DM
#    Le DM enregistre 1 plugin_version + N artefacts et GÉNÈRE lui-même les manifests
#    d'update (gupdate XML / Mozilla JSON). Endpoint : POST /admin/catalog/{plugin_id}/versions/upload
#    (plugin_id = id ENTIER, resolu depuis le catalogue ; le format vient de l'extension .crx/.xpi).
#    La cible scaleway/dgx = QUEL DM (BOOTSTRAP_URL), pas un champ d'upload.
# ──────────────────────────────────────────────
echo ""
echo "Publishing to $BOOTSTRAP_URL (catalog pipeline)..."

# Resoudre le plugin_id (entier) depuis le catalogue du DM cible, si non fourni par env.
if [ -z "$PLUGIN_ID" ]; then
  echo -n "  Resolving plugin_id for slug '$SLUG'... "
  PLUGIN_ID=$(curl -sf "${BOOTSTRAP_URL}/catalog/api/plugins" 2>/dev/null \
    | python3 -c "import sys,json; ps=json.load(sys.stdin).get('plugins',[]); print(next((p['id'] for p in ps if p.get('slug')=='$SLUG'), ''))" 2>/dev/null)
  if [ -z "$PLUGIN_ID" ]; then
    echo "ECHEC"
    echo "ERROR: plugin_id introuvable pour slug '$SLUG' via ${BOOTSTRAP_URL}/catalog/api/plugins"
    echo "       (plugin non enregistre ? sinon passer PLUGIN_ID=<id> en env)"
    exit 1
  fi
  echo "id=$PLUGIN_ID"
fi

# .crx -> Chromium (Chrome/Edge/Brave/Opera) ; .xpi -> Gecko (Firefox/Thunderbird).
# Même version + même release_notes : 1 plugin_version, N artefacts.
# platform_variant distinct par moteur (chromium-${TARGET} / gecko-${TARGET}) => coexistence.
upload_variant() {
  local file="$1" label="$2" variant="$3"
  if [ ! -f "$file" ]; then
    echo "  SKIP ${label} ($(basename "$file") absent)"
    return 0
  fi
  echo -n "  Upload ${label} ($(basename "$file"), variant=${variant})... "
  if curl -sf -X POST "${BOOTSTRAP_URL}/admin/catalog/${PLUGIN_ID}/versions/upload" \
       -H "${TOKEN_HEADER}: ${ADMIN_TOKEN}" \
       -F "version=${VERSION}" \
       -F "platform_variant=${variant}" \
       -F "distribution_mode=${DISTRIBUTION_MODE}" \
       -F "environment=${ENVIRONMENT}" \
       -F "release_notes=${RELEASE_NOTES}" \
       -F "binary=@${file}" >/dev/null; then
    echo "OK"
  else
    echo "FAILED"
  fi
}

upload_variant "$OUT_DIR/${SLUG}-${VERSION}-${TARGET}.crx" "chromium .crx" "chromium-${TARGET}"
upload_variant "$OUT_DIR/${SLUG}-${VERSION}-${TARGET}.xpi" "gecko .xpi"     "gecko-${TARGET}"

# ──────────────────────────────────────────────
# 7. Summary
# ──────────────────────────────────────────────
echo ""
echo "========================================="
echo " Release $SLUG v$VERSION (target=$TARGET)"
echo "========================================="
echo " Extension ID : $EXTENSION_ID"
echo " Gecko ID     : $GECKO_ID"
echo ""
echo " Artifacts:"
ls -lh "$OUT_DIR/"*.crx "$OUT_DIR/"*.xpi 2>/dev/null | awk '{print "   " $NF " (" $5 ")"}'
echo ""
echo " Update endpoints (manifests GENERES par le DM) :"
echo "   Chrome/Edge        : ${TARGET_BOOTSTRAP}/updates/${SLUG}/${TARGET}.xml"
echo "   Firefox/Thunderbird: ${TARGET_BOOTSTRAP}/updates/${SLUG}/${TARGET}.json"
echo ""
echo " Artefacts publies (plugin_id=${PLUGIN_ID}, env=${ENVIRONMENT}) :"
echo "   .crx variant=chromium-${TARGET} + .xpi variant=gecko-${TARGET} ; download interne au DM"
echo ""
echo " Auto-update: navigateurs verifient periodiquement"
echo "   Chrome  ~5h  | Firefox ~24h"
echo "========================================="

# Cleanup
rm -rf "$BUILD_DIR"
echo "Done."

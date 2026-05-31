#!/usr/bin/env bash
# deploy-release.sh — Package, sign and deploy MirAI Recorder to Device Manager
# Usage:
#   BOOTSTRAP_URL=https://dm.example.gouv.fr DM_ADMIN_TOKEN=xxx \
#     scripts/deploy-release.sh --target=dgx
#
# Targets:
#   --target=scaleway (default) → profile prod-scaleway
#   --target=dgx                → profile prod-dgx
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
TARGET="scaleway"
for arg in "$@"; do
  case "$arg" in
    --target=*) TARGET="${arg#--target=}" ;;
  esac
done

case "$TARGET" in
  scaleway) PROFILE="prod-scaleway" ; TARGET_BOOTSTRAP="https://bootstrap.fake-domain.name" ;;
  dgx)      PROFILE="prod-dgx"      ; TARGET_BOOTSTRAP="https://onyxia.gpu.minint.fr/bootstrap" ;;
  *) echo "ERROR: unknown target '$TARGET' (expected: scaleway|dgx)" >&2 ; exit 1 ;;
esac

# ──────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────
SLUG="iassistant-direct-browser"
GECKO_ID="mirai-assistant@interieur.gouv.fr"

# --- Pipeline catalogue DM (le DM genere les manifests d'update) ---
# Le client = autorite version/changelog/binaire ; le DM = autorite manifests/URLs.
# Valeurs a confirmer avec l'agent DM (override possible par env).
PLUGIN_ID="${PLUGIN_ID:-$SLUG}"                       # plugin_id == slug ?
UPLOAD_AUTH_HEADER="${UPLOAD_AUTH_HEADER:-x-admin-token}"  # header du token de service CI ?
DISTRIBUTION_MODE="${DISTRIBUTION_MODE:-canary}"      # canary | stable ?
# BOOTSTRAP_URL = where we UPLOAD artefacts (DM server endpoint).
# Defaults to the target's own bootstrap URL but can be overridden, e.g. to a staging DM.
BOOTSTRAP_URL="${BOOTSTRAP_URL:-$TARGET_BOOTSTRAP}"
ADMIN_TOKEN="${DM_ADMIN_TOKEN:-}"
[ -n "$ADMIN_TOKEN" ] || { echo "ERROR: DM_ADMIN_TOKEN not set"; exit 1; }

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
#    Le DM enregistre 1 plugin_version + N artefacts (variantes) et GÉNÈRE lui-même
#    les manifests d'update (gupdate XML / Mozilla JSON). On n'uploade plus de .xml/.json
#    ni de binaires par PUT : tout passe par /catalog/{plugin_id}/versions/upload.
# ──────────────────────────────────────────────
echo ""
echo "Publishing to $BOOTSTRAP_URL (catalog pipeline)..."

# .crx -> Chromium (Chrome/Edge/Brave/Opera) ; .xpi -> Gecko (Firefox/Thunderbird).
# Même version + même release_notes pour les deux : 1 plugin_version, N variantes.
upload_variant() {
  local file="$1" engine="$2" variant
  if [ ! -f "$file" ]; then
    echo "  SKIP ${engine}-${TARGET} ($(basename "$file") absent)"
    return 0
  fi
  variant="${engine}-${TARGET}"
  echo -n "  Upload ${variant} ($(basename "$file"))... "
  if curl -sf -X POST "${BOOTSTRAP_URL}/catalog/${PLUGIN_ID}/versions/upload" \
       -H "${UPLOAD_AUTH_HEADER}: ${ADMIN_TOKEN}" \
       -F "version=${VERSION}" \
       -F "release_notes=${RELEASE_NOTES}" \
       -F "distribution_mode=${DISTRIBUTION_MODE}" \
       -F "platform_variant=${variant}" \
       -F "binary=@${file}" >/dev/null; then
    echo "OK"
  else
    echo "FAILED"
  fi
}

upload_variant "$OUT_DIR/${SLUG}-${VERSION}-${TARGET}.crx" "chromium"
upload_variant "$OUT_DIR/${SLUG}-${VERSION}-${TARGET}.xpi" "gecko"

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
echo " Variantes publiees : chromium-${TARGET}, gecko-${TARGET} (download interne au DM)"
echo ""
echo " Auto-update: navigateurs verifient periodiquement"
echo "   Chrome  ~5h  | Firefox ~24h"
echo "========================================="

# Cleanup
rm -rf "$BUILD_DIR"
echo "Done."

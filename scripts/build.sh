#!/usr/bin/env bash
# build.sh — Compile le plugin Chrome/Firefox avec les fichiers DM
# Usage:
#   scripts/build.sh                              → build prod (defaut)
#   scripts/build.sh --target=prod                → build prod (explicite)
#   scripts/build.sh --target=int                 → build integration (profil int)
#   scripts/build.sh --target=local               → build DM local (localhost:8089, profil dev)
#   scripts/build.sh --target=prod --crx --xpi    → prod + .crx signe + .xpi
#   scripts/build.sh --all --crx --xpi            → TOUS les profils, un dossier par cible
#                                                   (dist/prod/  dist/int/  dist/local/)
#
# UN SEUL package prod : le profil "prod" porte la LISTE ORDONNEE bootstrap_urls
# (scaleway/dgx/onprem). L'extension scanne et garde le DM qui repond — plus besoin
# d'un build par environnement. Voir src/dm/config.json et src/dm/bootstrap.js.
#
# Les artefacts sont suffixes par la cible :
#   cible unique : dist/iassistant-direct-browser-${VERSION}-${TARGET}.crx
#   mode --all   : dist/<target>/iassistant-direct-browser-${VERSION}-${TARGET}.crx
# Surcharge possible du dossier de sortie via la variable d'env DIST_DIR.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# DIST_DIR surchargeable par env (utilise par le mode --all pour isoler chaque cible).
DIST_DIR="${DIST_DIR:-$ROOT_DIR/dist}"
EXT_DIR="$DIST_DIR/extension"
# Chemin relatif (affichage) : reflete le vrai dossier, y compris en mode --all (dist/<target>).
DIST_REL="${DIST_DIR#"$ROOT_DIR"/}"
VERSION=$(python3 -c "import json; print(json.load(open('$ROOT_DIR/manifest.json'))['version'])")

# ──────────────────────────────────────────────
# Mode --all : build chaque cible dans son propre dossier dist/<target>/
# (re-invoque ce script par cible avec DIST_DIR isole ; aucune ne s'ecrase).
# ──────────────────────────────────────────────
ALL_TARGETS="prod int local"
if [[ " $* " == *" --all "* ]]; then
  PASSTHRU=()
  for a in "$@"; do
    case "$a" in --all|--target=*) ;; *) PASSTHRU+=("$a") ;; esac
  done
  echo "Building ALL profiles ($ALL_TARGETS) — un dossier par cible..."
  for t in $ALL_TARGETS; do
    echo ""
    echo "==================== target=$t ===================="
    DIST_DIR="$ROOT_DIR/dist/$t" "$0" --target="$t" ${PASSTHRU[@]+"${PASSTHRU[@]}"}
  done
  echo ""
  echo "========================================="
  echo " Tous les profils construits :"
  for t in $ALL_TARGETS; do echo "   dist/$t/"; done
  echo "========================================="
  exit 0
fi

# ──────────────────────────────────────────────
# Parse --target
# ──────────────────────────────────────────────
TARGET="prod"
for arg in "$@"; do
  case "$arg" in
    --target=*) TARGET="${arg#--target=}" ;;
  esac
done

# BOOTSTRAP_URL = fallback hardcode de DERNIER recours (si lecture config.json KO).
# En prod la liste bootstrap_urls (config.json) fait foi ; on bake le primaire ici.
case "$TARGET" in
  prod)   PROFILE="prod" ; BOOTSTRAP_URL="https://bootstrap.apps.ocpbm02s2.cores.r2.pi2.minint.fr" ;;
  int)    PROFILE="int"  ; BOOTSTRAP_URL="https://bootstrap.fake-domain.name" ;;
  local)  PROFILE="dev"  ; BOOTSTRAP_URL="http://localhost:8089" ;;
  *)      echo "ERREUR: target inconnue '$TARGET' (attendu: prod|int|local, ou --all)" >&2 ; exit 1 ;;
esac

echo "Building MirAI Recorder v$VERSION (target=$TARGET, profile=$PROFILE)..."
echo ""

# ──────────────────────────────────────────────
# 1. Clean
# ──────────────────────────────────────────────
rm -rf "$DIST_DIR"
mkdir -p "$EXT_DIR"

# ──────────────────────────────────────────────
# 2. Copy extension files
# ──────────────────────────────────────────────
# Manifest (racine — requis par Chrome)
cp "$ROOT_DIR/manifest.json" "$EXT_DIR/"
cp "$ROOT_DIR/package.json" "$EXT_DIR/"

# Source (tout src/)
cp -r "$ROOT_DIR/src/" "$EXT_DIR/src/"

# Icons
cp -r "$ROOT_DIR/icons/" "$EXT_DIR/icons/"

# DM files at ZIP root (required by Device Management)
# DM auto-detects and strips them from the distributed binary
cp "$ROOT_DIR/src/dm/manifest.json" "$EXT_DIR/dm-manifest.json"
# dm-config.json = TEMPLATE DM (placeholders ${{...}}), uploade comme config_template.
# A ne pas confondre avec src/dm/config.json (config bakee client, vraies valeurs).
cp "$ROOT_DIR/src/dm/dm-config.json" "$EXT_DIR/dm-config.json"

# DM icon: convention device-management is to look up basenames
# {logo.png, icon128.png, icon48.png} inside an assets/ directory at
# the ZIP root. See app/admin/router.py:1531-1541 in device-management.
# We duplicate icons/icon128.png into assets/icon128.png so the DM can
# extract it at upload time and render it as a base64 data URL in the
# catalog, without needing outbound network access from the admin UI
# (critical on closed networks like DGX).
mkdir -p "$EXT_DIR/assets"
cp "$ROOT_DIR/icons/icon128.png" "$EXT_DIR/assets/icon128.png"

# ──────────────────────────────────────────────
# 2.b Target-specific patches (dist/ only, sources untouched)
# ──────────────────────────────────────────────
echo "Applying target patches for '$TARGET' (profile=$PROFILE)..."
python3 - <<PYEOF
import json, re
profile = "$PROFILE"
bootstrap_url = "$BOOTSTRAP_URL"

# 1. Patch activeProfile UNIQUEMENT sur la config bakee client (src/dm/config.json).
#    Le template DM ($EXT_DIR/dm-config.json) n'a pas d'activeProfile (servi par profil).
for p in ["$EXT_DIR/src/dm/config.json"]:
    with open(p) as f:
        d = json.load(f)
    d["activeProfile"] = profile
    with open(p, "w") as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
        f.write("\n")

# 2. Patch hardcoded fallback in bootstrap.js
bp = "$EXT_DIR/src/dm/bootstrap.js"
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
bg = "$EXT_DIR/src/background.js"
with open(bg) as f:
    txt = f.read()
txt = re.sub(
    r"(cachedConfig\?\.bootstrap_url\s*\|\|\s*)'[^']*'",
    lambda m: m.group(1) + f"'{bootstrap_url}'",
    txt, count=1,
)
with open(bg, "w") as f:
    f.write(txt)

print(f"  activeProfile  = {profile}")
print(f"  bootstrap_url  = {bootstrap_url}")
PYEOF

# ──────────────────────────────────────────────
# 3. Verification
# ──────────────────────────────────────────────
echo "Fichiers dans ${DIST_REL}/extension/ :"
find "$EXT_DIR" -type f | sed "s|$EXT_DIR/||" | sort | while read f; do
  echo "  $f"
done

FILE_COUNT=$(find "$EXT_DIR" -type f | wc -l | tr -d ' ')
echo ""
echo "$FILE_COUNT fichiers prets."

# Verifier les references du manifest
python3 -c "
import json, os, sys
os.chdir('$EXT_DIR')
m = json.load(open('manifest.json'))
errors = []
refs = [m['background']['service_worker'], m['action']['default_popup'], m['options_ui']['page']]
refs += m['background'].get('scripts', [])  # Firefox ESR (pas de service worker)
for f in refs:
    if not os.path.isfile(f): errors.append(f)
for s, p in m['icons'].items():
    if not os.path.isfile(p): errors.append(p)
if errors:
    print('ERREUR — fichiers manquants :', errors)
    sys.exit(1)
print('Manifest OK — toutes les references existent.')
"

# ──────────────────────────────────────────────
# 4. CRX (optionnel)
# ──────────────────────────────────────────────
if [[ " $* " == *" --crx "* ]]; then
  PEM_KEY="$ROOT_DIR/private/mirai-browser-key.pem"
  if [ ! -f "$PEM_KEY" ]; then
    echo "ERREUR: Cle PEM non trouvee ($PEM_KEY)"
    exit 1
  fi

  CHROME_BIN=""
  for candidate in \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "$(which chromium 2>/dev/null || true)" \
    "$(which google-chrome 2>/dev/null || true)"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      CHROME_BIN="$candidate"
      break
    fi
  done

  if [ -z "$CHROME_BIN" ]; then
    echo "ERREUR: Chrome/Chromium non trouve"
    exit 1
  fi

  echo ""
  echo "Packaging CRX..."
  "$CHROME_BIN" --pack-extension="$EXT_DIR" --pack-extension-key="$PEM_KEY" 2>/dev/null || true

  if [ -f "${EXT_DIR}.crx" ]; then
    mv "${EXT_DIR}.crx" "$DIST_DIR/iassistant-direct-browser-${VERSION}-${TARGET}.crx"
    CRX_SIZE=$(du -h "$DIST_DIR/iassistant-direct-browser-${VERSION}-${TARGET}.crx" | cut -f1)
    echo "  OK  ${DIST_REL}/iassistant-direct-browser-${VERSION}-${TARGET}.crx ($CRX_SIZE)"
  else
    echo "  ERREUR: CRX non genere"
  fi
fi

# ──────────────────────────────────────────────
# 5. XPI (optionnel)
# ──────────────────────────────────────────────
if [[ " $* " == *" --xpi "* ]]; then
  echo ""
  echo "Packaging XPI..."
  (cd "$EXT_DIR" && zip -r -q "$DIST_DIR/iassistant-direct-browser-${VERSION}-${TARGET}.xpi" .)
  XPI_SIZE=$(du -h "$DIST_DIR/iassistant-direct-browser-${VERSION}-${TARGET}.xpi" | cut -f1)
  echo "  OK  ${DIST_REL}/iassistant-direct-browser-${VERSION}-${TARGET}.xpi ($XPI_SIZE)"
fi

# ──────────────────────────────────────────────
# 6. Resume
# ──────────────────────────────────────────────
echo ""
echo "========================================="
echo " Build MirAI Recorder v$VERSION (target=$TARGET)"
echo "========================================="
echo " ${DIST_REL}/extension/                  → extension non empaquetee"
echo "                                           (chargeable dans chrome://extensions)"
[ -f "$DIST_DIR/iassistant-direct-browser-${VERSION}-${TARGET}.crx" ] && echo " ${DIST_REL}/iassistant-direct-browser-${VERSION}-${TARGET}.crx → Chrome signe"
[ -f "$DIST_DIR/iassistant-direct-browser-${VERSION}-${TARGET}.xpi" ] && echo " ${DIST_REL}/iassistant-direct-browser-${VERSION}-${TARGET}.xpi → Firefox"
echo ""
echo " Contenu DM inclus :"
echo "   src/dm/dm-config.json → template DM (placeholders, uploade au catalogue)"
echo "   src/dm/config.json    → config bakee client (vraies valeurs, fallback)"
echo "   src/dm/manifest.json → metadata DM"
echo "   src/dm/bootstrap.js  → client config DM"
echo "   src/dm/telemetry.js  → telemetrie OTLP"
echo "   src/auth.js          → PKCE + enrollment DM"
echo "========================================="

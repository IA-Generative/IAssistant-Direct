#!/usr/bin/env bash
# recette.sh — recette automatique de la bulle « + IA » sous Chrome et Firefox ESR.
#
#   scripts/recette-bulle/recette.sh [chrome|firefox|tout]
#
# Prépare une copie de l'extension dont la doublure déclare example.org (page d'essai),
# puis joue les scénarios de scenarios.mjs. Aucun service réel n'est appelé : doublure
# + jeton factice dans un profil jetable. Captures dans le dossier affiché à la fin.
#
# Prérequis : node ≥ 22, Google Chrome ≥ 137 (variable CHROME pour un autre chemin),
# Firefox ESR ≥ 128 (variable FIREFOX), web-ext.
set -euo pipefail

ICI="$(cd "$(dirname "$0")" && pwd)"
RACINE="$(cd "$ICI/../.." && pwd)"
CIBLE="${1:-tout}"
SORTIE="$(mktemp -d)"
EXT="$SORTIE/extension"
FIREFOX="${FIREFOX:-/Applications/Firefox 128.11.0.app/Contents/MacOS/firefox}"
PORT_BIDI="${PORT_BIDI:-9333}"

mkdir -p "$EXT"
cp -R "$RACINE/manifest.json" "$RACINE/src" "$RACINE/icons" "$EXT/"
python3 - "$EXT/src/mescollections/doublure.json" <<'PYEOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["sites"]["sites"].append({"motif": "https://example.org/*", "cibles": [
    {"type": "assistant", "id": "sejour-des-etrangers", "titre": "Séjour des étrangers"},
    {"type": "collection", "id": "ceseda", "titre": "CESEDA", "_public": True}]})
json.dump(d, open(p, "w"), ensure_ascii=False)
PYEOF

ECHEC=0
if [[ "$CIBLE" == chrome || "$CIBLE" == tout ]]; then
  echo "== Chrome"
  node "$ICI/chrome.mjs" "$EXT" "$SORTIE" || ECHEC=1
fi

if [[ "$CIBLE" == firefox || "$CIBLE" == tout ]]; then
  echo "== Firefox ESR"
  web-ext run --source-dir "$EXT" --firefox="$FIREFOX" --no-reload --no-input \
    --args="--remote-debugging-port=$PORT_BIDI" > "$SORTIE/web-ext.log" 2>&1 &
  WEBEXT=$!
  for _ in $(seq 1 30); do grep -q "Installed" "$SORTIE/web-ext.log" 2>/dev/null && break; sleep 1; done
  sleep 4
  node "$ICI/firefox.mjs" "$PORT_BIDI" "$SORTIE" || ECHEC=1
  kill "$WEBEXT" 2>/dev/null || true
fi

echo "Captures : $SORTIE"
exit "$ECHEC"

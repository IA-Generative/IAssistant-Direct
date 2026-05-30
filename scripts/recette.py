#!/usr/bin/env python3
"""
recette.py — Jeu de recette automatique du plug-in IAssistant-Direct (by Mirai)
              servi par le Device Management (mirai-browser).

Conçu pour être AUTONOME (stdlib uniquement, aucun paquet à installer) afin de
tourner :
  - en INTÉGRATION (Scaleway) : via `kubectl exec` dans le pod device-management,
        kubectl exec -n bootstrap deploy/device-management -- \
          python3 - < scripts/recette.py -- --in-cluster
    (les pods n'ont pas `curl` ; ils ont `python3`)
  - à DISTANCE / DGX (air-gap) : transmettre CE FICHIER au coding assistant local,
    qui l'exécute dans le cluster cible avec --profile prod-dgx.

Chaque vérification affiche PASS / FAIL / SKIP. Code de sortie non nul si un
FAIL bloquant est rencontré (utilisable en CI / gate de déploiement).

Exemples :
  # Smoke in-cluster (depuis le pod DM) — profil intégration
  python3 recette.py --in-cluster --profile int

  # Contre une URL publique (hors cluster) — checks internes auto-SKIP
  python3 recette.py --base https://bootstrap.example --profile prod-dgx

  # Avec test d'enrollment de bout en bout (nécessite un token Keycloak valide)
  python3 recette.py --in-cluster --token "$KC_ACCESS_TOKEN"
"""
import argparse
import json
import sys
import urllib.request
import urllib.error

# ── Attentes par défaut (alignées sur manifest.json / src/dm/manifest.json) ──
DEFAULT_SLUG = "mirai-browser"
DEFAULT_VERSION = "1.2.2"
DEFAULT_NAME = "IAssistant-Direct (by Mirai)"
DEFAULT_REALM = "mirai"

# Hôtes internes au cluster (services K8s) — utilisés uniquement avec --in-cluster
WIREGUARD_PROXY = "http://wireguard-proxy"        # nginx → Keycloak via tunnel WG
RELAY_INTERNAL = "http://relay-assistant"          # service port 80 (target 8080)

GREEN, RED, YELLOW, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[0m"

results = []  # (name, status, detail)  status ∈ {PASS, FAIL, SKIP, WARN}


def record(name, status, detail=""):
    results.append((name, status, detail))
    color = {"PASS": GREEN, "FAIL": RED, "SKIP": YELLOW, "WARN": YELLOW}.get(status, "")
    print(f"  {color}{status:4}{RESET}  {name}" + (f"  — {detail}" if detail else ""))


def http_get(url, timeout=8, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


def http_post(url, data: bytes, timeout=10, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read().decode("utf-8", "replace")


# ──────────────────────────────────────────────────────────────────────────
# Vérifications
# ──────────────────────────────────────────────────────────────────────────
def check_service_health(base):
    try:
        st, body = http_get(f"{base}/healthz")
        j = json.loads(body)
        db = j.get("checks", {}).get("db", {}).get("status")
        if st == 200 and db == "ok":
            record("Santé service DM (/healthz, db)", "PASS", f"HTTP {st}, db={db}")
        else:
            record("Santé service DM (/healthz, db)", "FAIL", f"HTTP {st}, db={db}")
    except Exception as e:
        record("Santé service DM (/healthz, db)", "FAIL", repr(e)[:140])


def check_catalog(base, slug, expect_version, expect_name):
    try:
        st, body = http_get(f"{base}/catalog/api/plugins")
        plugins = json.loads(body).get("plugins", [])
        p = next((x for x in plugins if x.get("slug") == slug), None)
        if not p:
            record(f"Plug-in '{slug}' présent au catalogue", "FAIL", "absent")
            return
        record(f"Plug-in '{slug}' présent au catalogue", "PASS",
               f"device={p.get('device_type')}")
        # Version
        lv = p.get("latest_version")
        record("Version publiée == attendue", "PASS" if lv == expect_version else "FAIL",
               f"catalogue={lv} attendu={expect_version}")
        # Nom visible
        nm = p.get("name")
        record("Nom visible == attendu", "PASS" if nm == expect_name else "FAIL",
               f"catalogue={nm!r} attendu={expect_name!r}")
    except Exception as e:
        record(f"Plug-in '{slug}' présent au catalogue", "FAIL", repr(e)[:140])


def check_config(base, slug, profile, expect_realm):
    try:
        st, body = http_get(f"{base}/config/{slug}/config.json?profile={profile}")
        j = json.loads(body)
        if st != 200:
            record(f"Config servie (profile={profile})", "FAIL", f"HTTP {st}")
            return
        record(f"Config servie (profile={profile})", "PASS",
               f"schema_v{j.get('meta', {}).get('schema_version')}")
        cfg = j.get("config", {})
        # Champs requis non vides et sans placeholders ${{...}}.
        # bootstrap_url est une valeur de BUILD (connue de l'extension), pas servie
        # par le profil generique `prod` ; relayAssistantBaseUrl est vestigial
        # (Keycloak/API en direct) -> aucun des deux n'est requis dans la config servie.
        required = ["keycloakIssuerUrl", "keycloakRealm", "keycloakClientId", "apiBase"]
        missing = [k for k in required if not cfg.get(k)]
        placeholders = [k for k in required
                        if isinstance(cfg.get(k), str) and "${{" in cfg.get(k)]
        if missing:
            record("Champs config requis présents", "FAIL", f"manquants={missing}")
        elif placeholders:
            record("Champs config requis présents", "FAIL",
                   f"placeholders non résolus={placeholders}")
        else:
            record("Champs config requis présents", "PASS", "tous résolus")
        # Realm attendu
        realm = cfg.get("keycloakRealm")
        record("keycloakRealm == attendu", "PASS" if realm == expect_realm else "WARN",
               f"servi={realm!r} attendu={expect_realm!r}")
    except Exception as e:
        record(f"Config servie (profile={profile})", "FAIL", repr(e)[:140])


def check_keycloak_via_proxy(in_cluster, realm, probe_url=""):
    """Keycloak joignable via le reverse-proxy (chemin RÉEL du flux).

    Sur Scaleway/int : via wireguard-proxy/realms/{realm}/...
    Sur DGX : passer --keycloak-probe-url (le relay expose Keycloak sans segment
    /realms/{realm}, le realm étant injecté côté serveur — voir ADR DGX §2)."""
    if not in_cluster and not probe_url:
        record("Keycloak via proxy (well-known)", "SKIP", "hors cluster")
        return
    url = probe_url or f"{WIREGUARD_PROXY}/realms/{realm}/.well-known/openid-configuration"
    try:
        st, body = http_get(url, timeout=8)
        iss = json.loads(body).get("issuer", "")
        # Si un realm est attendu, l'issuer doit le refléter. Sur DGX (realm vide),
        # on valide juste que le well-known répond avec un issuer cohérent.
        ok = st == 200 and (iss.endswith(f"/realms/{realm}") if realm else bool(iss))
        record("Keycloak via proxy (well-known)", "PASS" if ok else "FAIL",
               f"HTTP {st}, issuer={iss}")
        # certs (JWKS) — nécessaire à la validation des tokens. On dérive depuis
        # l'URL du PROXY (pas le jwks_uri du discovery doc, qui pointe vers le SSO
        # public injoignable depuis le cluster).
        certs = url.replace(".well-known/openid-configuration", "protocol/openid-connect/certs")
        st2, body2 = http_get(certs, timeout=8)
        nkeys = len(json.loads(body2).get("keys", []))
        record("Keycloak JWKS (certs) via proxy", "PASS" if st2 == 200 and nkeys else "FAIL",
               f"HTTP {st2}, {nkeys} clé(s)")
    except Exception as e:
        record("Keycloak via proxy (well-known)", "FAIL", repr(e)[:140])


def check_relay_health(in_cluster, relay_url=""):
    if not in_cluster and not relay_url:
        record("Relay-assistant (/healthz)", "SKIP", "hors cluster")
        return
    base = (relay_url or RELAY_INTERNAL).rstrip("/")
    try:
        st, body = http_get(f"{base}/healthz", timeout=5)
        ok = st == 200 and body.strip().lower() == "ok"
        record("Relay-assistant (/healthz)", "PASS" if ok else "FAIL",
               f"HTTP {st}, body={body.strip()[:20]!r}")
    except Exception as e:
        record("Relay-assistant (/healthz)", "FAIL", repr(e)[:140])


def check_enroll(base, token):
    """E2E optionnel : enrollment DM avec un token Keycloak réel → credentials relay."""
    if not token:
        record("Enrollment DM (E2E)", "SKIP", "pas de --token fourni")
        return
    try:
        payload = json.dumps({"client_uuid": "recette-e2e"}).encode()
        st, body = http_post(
            f"{base}/enroll", payload,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
        j = json.loads(body)
        has_relay = bool(j.get("relayClientId") or j.get("relay", {}).get("client_id"))
        record("Enrollment DM (E2E)", "PASS" if st in (200, 201) and has_relay else "FAIL",
               f"HTTP {st}, relay_creds={has_relay}")
    except urllib.error.HTTPError as e:
        record("Enrollment DM (E2E)", "FAIL", f"HTTP {e.code}")
    except Exception as e:
        record("Enrollment DM (E2E)", "FAIL", repr(e)[:140])


def main():
    ap = argparse.ArgumentParser(description="Recette automatique IAssistant-Direct / mirai-browser")
    ap.add_argument("--base", default="http://localhost:3001",
                    help="URL de base du DM (défaut: http://localhost:3001 pour exec in-pod)")
    ap.add_argument("--profile", default="int", help="profil de config (int|prod-dgx|prod-scaleway)")
    ap.add_argument("--in-cluster", action="store_true",
                    help="active les checks internes (wireguard-proxy, relay-assistant)")
    ap.add_argument("--slug", default=DEFAULT_SLUG)
    ap.add_argument("--expect-version", default=DEFAULT_VERSION)
    ap.add_argument("--expect-name", default=DEFAULT_NAME)
    ap.add_argument("--expect-realm", default=DEFAULT_REALM,
                    help="realm attendu dans la config servie (DGX: passer --expect-realm '')")
    ap.add_argument("--keycloak-probe-url", default="",
                    help="URL well-known à sonder (override DGX: .../relay-assistant/keycloak/.well-known/openid-configuration)")
    ap.add_argument("--relay-url", default="",
                    help="URL de base du relay-assistant (override si nom de service différent)")
    ap.add_argument("--token", default="", help="token Keycloak pour le test d'enrollment E2E (optionnel)")
    args = ap.parse_args()

    print(f"\n=== Recette IAssistant-Direct (by Mirai) — base={args.base} "
          f"profile={args.profile} in_cluster={args.in_cluster} ===\n")

    check_service_health(args.base)
    check_catalog(args.base, args.slug, args.expect_version, args.expect_name)
    check_config(args.base, args.slug, args.profile, args.expect_realm)
    check_keycloak_via_proxy(args.in_cluster, args.expect_realm, args.keycloak_probe_url)
    check_relay_health(args.in_cluster, args.relay_url)
    check_enroll(args.base, args.token)

    n_pass = sum(1 for _, s, _ in results if s == "PASS")
    n_fail = sum(1 for _, s, _ in results if s == "FAIL")
    n_skip = sum(1 for _, s, _ in results if s in ("SKIP", "WARN"))
    print(f"\n=== Résultat : {n_pass} PASS, {n_fail} FAIL, {n_skip} SKIP/WARN ===\n")
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()

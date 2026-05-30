# Handoff — Recette automatique IAssistant-Direct (by Mirai) sur le DGX (air-gap)

Document à transmettre au **coding assistant côté DGX** (onyxia.gpu.minint.fr),
accompagné du fichier **`scripts/recette.py`** (autonome, stdlib Python uniquement).

---

## Prompt à donner à l'assistant DGX

> Tu interviens sur le cluster Kubernetes **air-gap du DGX** (`onyxia.gpu.minint.fr`),
> namespace du Device Management (probablement `bootstrap` — vérifie avec
> `kubectl get ns`). Le plug-in navigateur **IAssistant-Direct (by Mirai)**
> (slug technique `mirai-browser`, v1.2.2, device `chrome`) doit être validé
> avant ouverture de la beta aux ambassadeurs.
>
> Tu disposes du script de recette `recette.py` (joint). Les pods n'ont pas
> `curl` mais ont `python3`. Procède ainsi :
>
> **1. Découverte de l'environnement** (ne devine pas les URLs, lis-les) :
> ```bash
> DM=$(kubectl get pods -n bootstrap | awk '/^device-management-[0-9a-f]/{print $1; exit}')
> kubectl exec -n bootstrap "$DM" -- sh -c 'env | grep -iE "KEYCLOAK_ISSUER|OIDC_ISSUER|JWKS|RELAY_KEYCLOAK|RELAY_ASSISTANT|DM_RELAY.*URL" | grep -ivE "SECRET|TOKEN|KEY="'
> kubectl get svc -n bootstrap relay-assistant -o jsonpath='{.spec.ports[*].port}'
> ```
> Note l'URL du proxy Keycloak interne (souvent `ADMIN_OIDC_ISSUER_URL` ou
> `RELAY_KEYCLOAK_UPSTREAM`) et l'URL well-known à sonder.
>
> **2. Lance la recette in-cluster** (profil `prod`, realm `mirai`) :
> ```bash
> kubectl exec -n bootstrap "$DM" -i -- python3 - \
>   --in-cluster --profile prod --expect-realm mirai \
>   --keycloak-probe-url '<URL_WELL_KNOWN_INTERNE>' \
>   < recette.py
> ```
> Depuis 2026-05-30, l'egress navigateur DGX est ouvert : Keycloak est en **acces
> direct** (`sso.mirai.interieur.gouv.fr`, realm `mirai`), plus de relais. La config
> runtime est servie sous **`?profile=prod`** (chaque DM resout son env).
> `<URL_WELL_KNOWN_INTERNE>` = le chemin par lequel le **DM (serveur)** joint Keycloak
> (souvent encore via `wireguard-proxy/realms/mirai/.well-known/...` cote serveur).
> Critère de succès : **0 FAIL** (l'enrollment E2E reste SKIP sans `--token`).
>
> **3. Si la recette signale un FAIL**, ne le masque pas : reporte la ligne exacte
> et la cause (config non résolue, proxy injoignable, mauvais port relay…).
> Croise avec `GET /ops/health/full` (servi sur le port du conteneur, 3001) comme
> signal secondaire.

---

## Valeurs attendues côté DGX (référence — ADR `docs/adr-dgx-deployment.md`)

Config servie par `GET /config/mirai-browser/config.json?profile=prod` (chaque DM
resout ses placeholders d'env) :

| Champ | Valeur attendue DGX (acces direct) |
|---|---|
| `keycloakIssuerUrl` | `https://sso.mirai.interieur.gouv.fr/` (+ realm => `/realms/mirai`) |
| `keycloakRealm` | `mirai` |
| `keycloakClientId` | `mirai-extension` |
| `bootstrap_url` | `https://onyxia.gpu.minint.fr/bootstrap` (cible build DGX) |
| `apiBase` (mcr) | `https://compte-rendu.mirai.interieur.gouv.fr/api` |
| `relayAssistantBaseUrl` | _absent_ (relais non utilise par l'extension) |

Nom visible attendu au catalogue : **`IAssistant-Direct (by Mirai)`** (le `name`
est stocké en base ; si le catalogue affiche encore l'ancien nom après upload,
mettre à jour la colonne `plugins.name` ou via l'admin UI `/catalog/{id}/edit`).

✅ **Depuis 2026-05-30, DGX = comme Scaleway** pour l'auth : Keycloak direct, realm
`mirai`. L'ancienne particularite (relay keycloak, realm vide — ADR §2/§3) ne
s'applique plus a l'extension. Pour `--keycloak-probe-url`, vise le SSO direct
(`https://sso.mirai.interieur.gouv.fr/realms/mirai/.well-known/openid-configuration`)
si le pod le joint, sinon le chemin serveur via `wireguard-proxy`.

---

## Checks couverts par la recette

1. Santé service DM (`/healthz`, db)
2. Présence du plug-in `mirai-browser` au catalogue (device chrome)
3. Version publiée == 1.2.2
4. Nom visible == `IAssistant-Direct (by Mirai)`
5. Config servie (schema_v2) + champs requis résolus (pas de placeholder `${{...}}`)
6. `keycloakRealm` == attendu (WARN seulement)
7. Keycloak joignable via proxy (well-known + JWKS/certs)
8. Relay-assistant `/healthz` == "ok"
9. *(optionnel)* Enrollment E2E avec `--token <JWT Keycloak>` → credentials relay

---

## Résultat de référence (intégration Scaleway, 2026-05-30)

`10 PASS / 0 FAIL / 1 SKIP` (enrollment E2E non exécuté faute de token).
La recette DGX doit atteindre le même niveau avant ouverture de la beta.

## Note exploitation — health-check `/ops/health/full`

Deux faux positifs ont été corrigés dans `device-management/app/main.py`
(keycloak testait l'URL publique sans `/realms` ; relay testait le port 8080 au
lieu de 80). **Ce correctif ne prend effet qu'après rebuild + rollout de l'image
device-management.** Tant que l'image n'est pas redéployée, `/ops/health/full`
reportera `degraded` à tort sur `keycloak` et `relay` — se fier à la recette,
pas à `/ops/health/full`, jusqu'au rollout.

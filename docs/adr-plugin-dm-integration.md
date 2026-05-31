# ADR : Modèle d'intégration d'un plug-in avec le Device Management

> Date : 2026-05-31
> Statut : accepté
> Contexte : formaliser comment un plug-in (extension navigateur **et** plug-in
> LibreOffice) consomme sa configuration du Device Management (DM), après un
> incident `redirect_uri` vide en production et un nettoyage de la config DM.
> Supersede la note de [README.md](../README.md) qui figeait le slug `mirai-browser`.

## Problème

La config d'un plug-in vit à **plusieurs endroits** (template uploadé au DM, config
bakée dans le binaire, fallback codé en dur). Sans règle claire :

- des valeurs spécifiques à l'environnement se retrouvaient **en dur** dans le template
  uploadé au DM, neutralisant la substitution serveur ;
- inversement, des `${{placeholders}}` non résolus pouvaient être lus comme fallback ;
- un `${{KEYCLOAK_REDIRECT_URI}}` non renseigné côté déploiement DM produisait un
  `redirect_uri=` vide → rejet Keycloak (« Paramètre invalide : redirect_uri »).

## Décision

### 1. Deux artefacts de config, deux rôles distincts

| Artefact | Rôle | Contenu | Substitution |
|---|---|---|---|
| **Template DM** (`src/dm/dm-config.json` côté extension ; `dm-config.json` côté LibreOffice) | Uploadé au DM comme `config_template` | `default` (défauts stables, non secrets) + profils `dev/int/prod` avec **uniquement** des `${{...}}` pour toute clé spécifique à l'environnement | Résolu **côté serveur DM** |
| **Config bakée client** (`src/dm/config.json` + `_fallbackConfig` ; `config/config.default*.json` côté LibreOffice) | Init au 1er lancement + fallback hors-ligne | **Vraies valeurs**, jamais de `${{...}}` | Aucune |

**Invariants** (vérifiés par `scripts/recette.py --repo-root .` et les tests Jest) :
- le template ne contient **aucune** valeur métier en dur dans les profils d'env ;
- la config bakée ne contient **aucun** `${{...}}`.

### 2. Substitution côté serveur

Les `${{VARNAME}}` du template sont résolus par le DM au `GET /config/{slug}/config.json?profile={prof}`
à partir de ses variables d'environnement. Le DM merge `default` puis le profil demandé.
**Le client ne voit jamais de placeholder.** L'interface entre le plug-in et le DM est la
**liste des noms de variables** ; elle doit être identique des deux côtés.

Variables attendues (extension) : `KEYCLOAK_ISSUER_URL`, `KEYCLOAK_REALM`,
`KEYCLOAK_CLIENT_ID`, `API_BASE`, `RELAY_ASSISTANT_BASE_URL`, `COMPTE_RENDU_URL`,
`COMU_URL`, `TELEMETRY_ENDPOINT`, `TELEMETRY_KEY`.

> `KEYCLOAK_REDIRECT_URI` / `KEYCLOAK_ALLOWED_REDIRECT_URI` ne figurent **pas** dans le
> template de l'extension : celle-ci calcule son redirect via `chrome.identity` (cf. §6).
> Ces deux clés servent le plug-in LibreOffice (client `bootstrap-iassistant`), qui les
> porte dans son propre template DM. `LLM_*` / `DEFAULT_MODEL_NAME` sont également LibreOffice.

### 3. Profils

`default` (commun) + profils `dev` / `int` / `prod` (+ cibles de build `prod-scaleway` /
`prod-dgx` côté extension, dont le `config_path` pointe sur `?profile=prod`). Chaque DM
sert ses propres valeurs sous `prod`.

### 4. Le slug est un contrat inter-systèmes

Le slug (`iassistant-direct-browser`) apparaît dans : la route `GET /config/{slug}/...`,
l'entrée catalogue DM, les URLs d'auto-update, le nom des artefacts. **Le renommer impose
une migration coordonnée** (voir §Migration). Cette ADR acte le passage de `mirai-browser`
à `iassistant-direct-browser`.

### 5. Chaîne de fallback client

`DM (frais)` → `cache chrome.storage` → `config bakée (src/dm/config.json)` →
`_fallbackConfig (bootstrap.js)`. Objectif : rester fonctionnel même DM injoignable.

### 6. Redirect Keycloak

L'extension calcule son `redirect_uri` via `chrome.identity.getRedirectURL()` — elle ne
lit **pas** `keycloak_redirect_uri` (présent seulement dans le template, pour le service
bootstrap serveur). Les *Valid redirect URIs* Keycloak utilisent l'**Extension ID** stable
(`chrome-extension://<id>/*`), pas le slug.

## Cycle de vie

1. **Build** (`scripts/build.sh --target=…`) : copie le template en `dm-config.json` (racine
   ZIP), patche `activeProfile` + `bootstrap_url` **uniquement** sur la config bakée.
2. **Enregistrement** (`scripts/register-dm.sh`) : uploade `src/dm/dm-config.json` comme
   `config_template`.
3. **Release** (`scripts/deploy-release.sh`) : signe/empaquette (clé PEM **jamais
   régénérée** → Extension ID stable), publie binaires + manifests d'update.
4. **Runtime** : le client fetch sa config au DM, sinon fallback (§5).

## Migration (lors d'un changement de slug)

Séquence **dual-serve** pour ne pas casser les postes déployés (détail côté DM) :
1. servir l'ancienne **et** la nouvelle route `/config/{slug}/...` ;
2. publier les nouvelles URLs d'update en gardant les anciennes actives ;
3. pousser la nouvelle release via l'**ancienne** URL d'update ;
4. basculer la policy managée `<id>;<update_url>` (l'**ID ne change pas**) ;
5. retirer l'ancien une fois tous les postes migrés.

## Conséquences

- Config maintenable : une seule source de vérité par environnement (le DM), des
  fallbacks explicites et validés en CI.
- Le travail serveur (substitution, dual-serve) est porté par le repo `device-management`.
- Tout nouveau plug-in suit ce modèle.

## Références

- [ARCHITECTURE.md](ARCHITECTURE.md) — vue d'ensemble de l'extension.
- [adr-dgx-deployment.md](adr-dgx-deployment.md) — déploiement on-premise DGX.
- `AssistantMiraiLibreOffice/docs/PLUGIN_DEVELOPER_GUIDE.md` — contrat DM côté serveur.
- `scripts/recette.py` — validation statique des invariants (`--repo-root`).

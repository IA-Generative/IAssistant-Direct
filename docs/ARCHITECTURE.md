# Architecture — IAssistant-Direct (by Mirai)

> Extension Chrome/Edge (Manifest V3, service worker) et Firefox ESR ≥ 128 (Manifest V3,
> page d'arrière-plan). JavaScript sans bundler, tests Jest (jsdom). Pour le setup, le
> build et le déploiement, voir [README.md](../README.md) ; pour l'historique DGX, voir
> [adr-dgx-deployment.md](adr-dgx-deployment.md).

## Contextes d'exécution

| Contexte | Fichiers | Rôle |
|---|---|---|
| Arrière-plan | `src/background.js` (+ `crypto.js`, `dm/bootstrap.js`, `recording.js`, `mesagents.js`) | Alarmes DM, callback PKCE, messages de l'overlay, **menus contextuels « Agents MirAI »** |
| Popup | `src/popup.html`, `popup.js`, `popup-agents.js` | Enregistrement, raccourcis, **section « Agents » et vue « Résultat »** |
| Options / bienvenue / callback | `src/options.*`, `welcome.*`, `callback.*` | Identifiants, premier lancement, retour SSO |
| Content script | `src/overlay.js` | Bouton REC flottant sur les pages de visio |

Les modules partagés s'exposent sur `globalThis` (`TokenStore`, `DMBootstrap`,
`MesAgents`) pour vivre à la fois dans `window` (pages) et `self` (service worker).

### Chrome et Firefox : un seul manifest

`background` déclare **les deux** clés : `service_worker` (Chrome, qui ignore `scripts`
depuis Chrome 121) et `scripts` (Firefox, qui ne supporte pas les service workers).
Conséquence : `background.js` n'appelle `importScripts` que s'il existe ; sous Firefox, les
dépendances sont listées **avant** lui dans `background.scripts`, dans l'ordre
`crypto.js → dm/bootstrap.js → recording.js → mesagents.js → background.js`.

## Configuration (Device Management)

`src/dm/config.json` = profils (`default` + `activeProfile`). Les cibles de build
`prod-scaleway` / `prod-dgx` pointent `config_path` sur `?profile=prod` : le DM sert le
profil `prod` avec ses placeholders `${{...}}` résolus. Les valeurs bakées servent de
repli hors-ligne. `DMBootstrap.getFeatures()` expose `features.*`.

Clés du contrat d'agents :

| Clé | Profil servi (`int`, `prod`) | Repli bakés | Effet |
|---|---|---|---|
| `mesagentsBaseUrl` | `${{MESAGENTS_BASE_URL}}` | `""` | Vide ou placeholder non résolu ⇒ fonction **invisible** |
| `features.agents` | `true` | `true` (via `default`) | `false` (ou `"false"`, `"0"`) ⇒ coupe la fonction sans retirer l'URL ; absent ⇒ actif |

## Authentification

PKCE Keycloak, client public (`keycloakClientId`, `mirai-extension` en prod), portée
`openid profile email offline_access` **+ `mesagents-agents` quand la fonction Agents est
active** (`MesAgents.buildScope`). Le jeton est chiffré au repos (`TokenStore`, AES-GCM).
Deux rafraîchissements silencieux coexistent : `MiraiAuth` (pages) et `_ensureTokenFresh`
(arrière-plan, accepte `{ force }` pour rejouer après un 401). Aucun jeton n'est journalisé.

## Contrat d'agents MirAI

Référence : `myagents-contrat/docs/contrats/contrat-agents-mirai.md` (v1). Module
`src/mesagents.js`, sans dépendance au DOM.

```
                 ┌──────────────── popup ─────────────────┐
                 │ popup-agents.js                        │
                 │  section « Agents » (inputs ∋ text)    │
                 │  vue « Résultat » (nom, texte, Copier) │
                 └───────┬───────────────────▲────────────┘
     listerAgents/lancer │                   │ storage.session.mesagentsResultat
                         ▼                   │ (+ storage.onChanged)
                 ┌─────────────┐     ┌───────┴────────────────────────────┐
                 │ mesagents.js│◄────│ background.js                      │
                 │ cache 3 min │     │  menu « Agents MirAI »              │
                 │ 401→refresh │     │   selection → inputs ∋ selection    │
                 │ erreurs     │     │   page      → inputs ∋ page         │
                 └──────┬──────┘     │  clic : scripting.executeScript    │
                        │            │   (sélection, ou titre+URL+texte   │
                        ▼            │    principal, borné à 20 000 car.) │
          GET  /api/v1/agents        │  action.openPopup() sinon          │
          POST /v1/chat/completions  │  notification                      │
                 (Mes agents)        └────────────────────────────────────┘
```

Règles tenues :

- **Lister** : `GET /api/v1/agents?limit=200`, cache 3 min partagé via `storage.session`
  (`mesagentsCache`), filtrage `inputs` côté client, fiches normalisées (tailles bornées,
  vocabulaire fermé, `url` https seulement), affichage par `textContent` uniquement.
- **Lancer** : `POST /v1/chat/completions`, `model` = `agent.model`, un seul message `user`
  = consigne courte + `\n\n<<<\n` + contenu + `\n>>>`, les `<<<` / `>>>` du contenu étant
  neutralisés (`‹‹‹` / `›››`). `stream: false`, délai 120 s (`AbortController`). Message
  borné à 100 000 caractères ; la troncature est dite à la personne (`tronque`).
- **Jeton** : rafraîchissement silencieux avant l'appel ; sur `401`, un rafraîchissement
  forcé puis une seule nouvelle tentative.
- **Erreurs** (`MesAgentsError{code, status, masquer}`) : `invalid_token`,
  `audience_mismatch`, `forbidden`, injoignable, fonction désactivée ⇒ `masquer` (section et
  menus disparaissent sans bloquer) ; `422 blocked_input/blocked_output` ⇒ `error.message`
  affiché tel quel ; `404` ⇒ « Cet agent n'est plus accessible » ; `429` ⇒ « Réessayez dans
  un moment » ; `502` ⇒ « L'agent ne répond pas ».
- **Menus** : reconstruits à l'installation, au démarrage du navigateur, toutes les 3 min
  (alarme `mesagents-refresh`) et à l'apparition/disparition du jeton chiffré
  (`storage.onChanged` sur `miraiToken`). Identifiants `mirai-agents` (parent) et
  `mirai-agent:<id>`.
- **Résultat** : publié dans `storage.session` (`mesagentsResultat`, états `pending` /
  `done` / `error`), lu par le popup à l'ouverture et en direct. Le popup est ouvert par
  programme dès le clic (`action.openPopup`, Chrome ≥ 127 / Firefox ≥ 106) ; à défaut, une
  notification invite à l'ouvrir.
- **Permissions** : `contextMenus`, `scripting` (+ `activeTab`, accordé par le clic sur le
  menu : suffisant même sans permission d'hôte sous Firefox), hôte via `<all_urls>`.

## Tests

`npm test` — Jest/jsdom, sources chargées par `eval()` avec les mocks de `tests/setup.js`
(`chrome.storage.local/session`, `contextMenus`, `scripting`, `action`, `alarms`…).
Suites du contrat : `tests/mesagents.test.js` (module), `tests/popup-agents.test.js`
(section et vue du popup), ainsi que les ajouts dans `background`, `auth`, `manifest-html`
et `url-refactoring`.

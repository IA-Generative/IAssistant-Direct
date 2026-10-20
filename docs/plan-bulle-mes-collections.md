# Plan — la bulle « + IA » de Mes collections

> Phase 1 du chantier : confronter la demande au code réel, fixer le contrat et
> les règles de comportement, lister les fichiers touchés. **Rien n'est codé avant
> validation de ce plan.**

---

## 1. Objet

Sur les pages **déclarées pertinentes** dans Mes collections (une fiche de collection
ou d'assistant porte une liste de motifs d'adresse, par exemple
`https://www.legifrance.gouv.fr/codes/*`), une bulle « + IA » translucide flotte dans
un coin. Au clic, elle ouvre un petit panneau conversationnel redimensionnable qui
interroge une ou plusieurs collections, ou un assistant de recherche, **avec les
droits de la personne connectée**. Ailleurs, rien.

C'est la deuxième « action assistée » du socle décrit dans `ARCHITECTURE.md` §1,
après la capture de réunions.

## 2. Principes

1. **REST, pas MCP** : l'extension sait quoi appeler.
2. **Rien ne part de la page** : la liste des motifs est téléchargée et comparée à
   l'adresse courante **dans l'extension**. Aucune adresse visitée n'est envoyée. Le
   contenu de la page n'est lu que sur geste explicite (« Utiliser la sélection »).
3. **Le jeton de la personne, jamais un jeton de service** : appels en direct depuis
   l'arrière-plan, comme `src/recording.js`.
4. **Isolation de la page hôte** : interface dans un Shadow DOM fermé ; aucun
   `innerHTML` dans le code neuf (rendu par création d'éléments).
5. **Inerte si Mes collections ne répond pas** : aucune bulle, aucun message sur la
   page, aucune erreur visible en dehors de la page d'options. La fonction revient
   seule quand le service revient (§5).
6. **Aucune nouvelle permission** au-delà de celles déjà demandées (§7.1).

## 3. Confrontation au code réel

| Point de la demande | Ce que dit le code | Conséquence |
|---|---|---|
| Appels depuis l'arrière-plan avec le jeton | `src/auth.js` dépend de `window` ; l'arrière-plan a son propre rafraîchissement (`src/background.js:105-150`, `TokenStore` + `refresh_token`). | Réutiliser le helper de l'arrière-plan, pas `auth.js`. |
| « Relais sécurisé » | `relayFetch` (`src/auth.js:479`) n'est appelé nulle part ; `relayAssistantBaseUrl` absent du profil `prod`. | Non utilisé. Appel direct. |
| Firefox ESR | Sur cette branche, le manifeste ne déclare que `background.service_worker`, emballé tel quel en `.xpi` (`scripts/build.sh:229-234`). Firefox n'exécute pas de service worker d'extension : **aucun arrière-plan sous Firefox**. | Bloquant pour la bulle comme pour l'enregistrement. La PR #3 corrige déjà ce point (`service_worker` **et** `scripts`). Voir §8. |
| Détecteur statique sur `<all_urls>` | `host_permissions` = `<all_urls>` ; permission `tabs` déjà présente. La PR #3 ajoute `scripting`. | Avec `scripting` : **aucun script sur les pages non concernées** (détection dans l'arrière-plan, injection à la demande). Sans : détecteur statique minuscule. Voir §7.1. |
| Navigation des sites monopages | Un content script à `document_idle` ne tourne qu'au chargement. | Écouter `tabs.onUpdated` (changement d'`url`) dans l'arrière-plan. |
| Shadow DOM et polices | Un `@font-face` déclaré dans un shadow root est ignoré. | Marianne empaquetée et déclarée au niveau du document, sinon repli police système (suffisant en phase 3). |
| Styles dans la page hôte | Un `<style>` inline peut être bloqué par la CSP de la page (Firefox surtout). | `adoptedStyleSheets` (feuilles construites). |
| Conversation par onglet | `storage.session` : Chrome ≥ 102, Firefox ≥ 115. Inaccessible aux content scripts par défaut. | L'arrière-plan range la conversation par identifiant d'onglet ; la purge à `tabs.onRemoved`. |
| Code existant sans `innerHTML` | `src/overlay.js:68` en utilise un. | Non copié, non corrigé dans ce chantier. |
| URL de Mes collections fournie par le DM | Le DM ne sert pas encore cette clé. | Valeur **bakée** pour l'instant ; passage par le DM suivi par une issue de TODO (§6.3). |

## 4. Contrat avec Mes collections

Contrat convenu avec l'équipe Mes collections ; il est la référence côté serveur
(`docs/clients.md` de Mes collections, section « Sites déclarés », PR
IA-Generative/mycollections#98). Aucun champ n'est inventé ici.

### 4.1 Sites déclarés

```
GET {mycollectionsApiBase}/api/v1/sites
Authorization: Bearer <access token de la personne>     (absent en mode anonyme, §5.3)

200 { "ttl_s": 3600,
      "anonyme": false,
      "sites": [ { "motif": "https://www.legifrance.gouv.fr/codes/*",
                   "cibles": [ { "type": "assistant",  "id": "…", "titre": "…" },
                               { "type": "collection", "id": "…", "titre": "…" } ] } ] }
```

- Seules les cibles que la personne **lit** sont rendues. Un assistant jamais publié
  n'apparaît que pour qui le gère ; aucun assistant si le drapeau assistants est
  éteint côté serveur.
- Lue au démarrage, toutes les `ttl_s` secondes (une heure par défaut) et à chaque
  connexion.
- **Motifs** : règle exacte des *match patterns* d'extension. Schéma `https` exact,
  hôte explicite en minuscules, `*.` en tête possible sur au moins deux niveaux
  (`*.gouv.fr` oui, `*.fr` non), ni port ni identifiant ; chemin comparé **avec la
  query**, `#fragment` jamais comparé. `*` seul et `<all_urls>` refusés côté serveur ;
  vingt motifs au plus par fiche. L'extension applique la même règle et ignore un
  motif qui ne la respecte pas.
- **Erreurs** : 401 sans jeton valide ; 403 au format
  `{"detail": {"code": "audience_mismatch", "message": "…"}}`.

### 4.2 Poser une question

- **Assistant** : `POST /api/v1/assistants/{id}/executer` `{"question": "…", "canal": "api"}`
  → `passages[]` (titre, texte, url signée, source), `plan` (trace), `reponse` (texte
  rédigé, ou `null`).
- **Collections** : `GET /api/v1/search?q=…&scope=a,b&limit=8` → `results[]` (titre,
  extrait, url signée, collection).

Rendu : `reponse` présente ⇒ l'afficher avec ses citations ; sinon les passages
trouvés, cités et cliquables. Recherche citée, pas conversation inventée.

Ces deux routes ne sont **jamais anonymes** (401 sans jeton). Leurs erreurs suivent
le format `{"error": {"code": "…", "message": "…"}}`.

### 4.3 Liens signés

Valables **12 h** (`?exp=&sig=`). Un fil gardé dans `storage.session` reste donc
valide. Si l'ouverture d'un lien rend 401 ou 403 (lien expiré), le panneau propose de
reposer la question pour obtenir un lien neuf. Il n'existe pas de route « redonner un
lien ».

### 4.4 Prérequis SSO

- Jeton de `mirai-extension` accepté par Mes collections : soit `mirai-extension`
  ajouté à `MYCOLLECTIONS_RECHERCHE_AUDIENCE` (court terme), soit mapper d'audience
  `mycollections-front` sur le client (à vérifier avec l'API compte-rendu).
- Claim `groups` en **chemins complets** (`/g/...`), sinon les droits par collection
  ne s'appliquent pas. À contrôler sur un jeton réel.

## 5. Comportement face aux pannes

### 5.1 États

L'arrière-plan tient un état unique, `mescollectionsEtat`, dans `storage.local` :

| État | Signification | Bulle |
|---|---|---|
| `inactif` | Pas d'URL configurée, fonction coupée, ou anonyme refusé (§5.3) | Jamais |
| `refuse` | 403 `audience_mismatch` : le jeton existe mais Mes collections ne l'accepte pas | Jamais — diagnostic « jeton non accepté par Mes collections » |
| `connecte` | `/sites` a répondu avec le jeton de la personne (`anonyme: false`) | Sur les pages qui correspondent |
| `anonyme` | `/sites` a répondu sans jeton (`anonyme: true`, §5.3) | Sur les pages qui correspondent, marquée « mode anonyme », sans question possible |
| `injoignable` | Pas de réponse, délai dépassé, 5xx, ou 429 persistant | **Jamais** — inerte, nouvelle tentative programmée |

Champs associés : `raison` (texte court pour le diagnostic), `derniereReponse`
(horodatage), `echecs` (compteur), `prochaineTentative` (horodatage), `motifs`
(dernière liste valide), `ttl_s`.

### 5.2 Retry

**Lecture de `/sites`** :

- Délai par requête : 5 s (`AbortController`).
- Échec (réseau, délai, 5xx, 429) ⇒ état `injoignable`, la liste en cache n'est plus
  utilisée, la bulle disparaît des onglets ouverts.
- Nouvelle tentative par **recul exponentiel avec gigue** :
  1 min, 2, 4, 8, 16, 32, puis 60 min au plus ; gigue de ±20 %. Sur 429, le
  `Retry-After` remplace le délai calculé s'il est plus long.
- Planification par `chrome.alarms` (une seule alarme `mescollections-sites`), pour
  survivre à l'arrêt du service worker.
- Remise à zéro du compteur sur succès, à la connexion, et au réveil du poste
  (`idle` n'est pas demandé : l'alarme suffit).

**Questions (`executer`, `search`)** :

- Délai par requête : 30 s.
- 429 : respecter `Retry-After` s'il est présent et inférieur à 30 s, sinon une
  seule nouvelle tentative après 2 s, puis message « réessayez dans un instant ».
- 503 ou erreur réseau : une seule nouvelle tentative après 2 s, puis le même
  message. Deux échecs de suite ⇒ l'arrière-plan relance immédiatement la lecture de
  `/sites` ; si elle échoue aussi, état `injoignable` et la bulle disparaît.
- 404 : la cible n'est plus lisible, elle est retirée des puces.

### 5.3 Mode anonyme

Si Mes collections **répond** mais que le jeton n'est pas actif, l'extension relit
`/sites` **sans en-tête `Authorization`**. Ce mode sert au débogage.

- **Déclencheurs** : pas de jeton stocké ; rafraîchissement par le `refresh_token`
  en échec ; 401 persistant après un rafraîchissement forcé et une nouvelle tentative.
- **Pas de bascule sur 403 `audience_mismatch`** : le jeton est actif mais refusé,
  c'est une erreur de configuration à rendre visible, pas à masquer. État `refuse`
  et diagnostic.
- **Côté serveur** : `/sites` sans jeton rend 401 par défaut. Avec
  `MYCOLLECTIONS_SITES_ANONYMES=true` (débogage, coupé en production), il rend 200
  avec `anonyme: true`, les seules collections ouvertes à tous (non archivées) et
  aucun assistant.
- Réponse 200 sans jeton ⇒ état `anonyme`. La bulle s'affiche, le panneau montre
  les cibles et dit « Connectez-vous pour poser une question » avec un bouton de
  connexion. **Aucun appel de question n'est tenté** : `search` et `executer` ne
  sont jamais anonymes.
- Réponse 401 sans jeton ⇒ état `inactif` jusqu'à la prochaine connexion. Pas de
  nouvelle tentative en boucle.
- Le retour au mode connecté se fait à la connexion suivante, ou au prochain cycle
  si un jeton valide réapparaît.

### 5.4 Diagnostic

La page d'options affiche une ligne « Mes collections » : état, dernière réponse,
nombre d'échecs, prochaine tentative, et un bouton « Réessayer maintenant ». C'est le
seul endroit où une panne est visible.

## 6. Architecture dans l'extension

### 6.1 Fichiers nouveaux

| Fichier | Rôle |
|---|---|
| `src/mescollections/correspond.js` | Fonction pure `correspond(url, motif)` : match pattern → expression régulière, fragment ignoré. |
| `src/mescollections/sites.js` | Lecture de `/sites`, cache, état (§5.1), recul exponentiel (§5.2), mode anonyme (§5.3). Sans DOM. |
| `src/mescollections/api.js` | `executer`, `search`, avec les règles de §5.2. Sans DOM. |
| `src/mescollections/bulle.js` | Bulle + panneau dans un Shadow DOM fermé, injecté dans les onglets qui correspondent. Styles embarqués : `adoptedStyleSheets` sous Chrome, repli `<style>` sous Firefox (qui refuse l'affectation depuis un content script). |
| `src/mescollections/doublure.js` | Faux serveur rendant `doublure.json` selon un mode (normal, anonyme, refuse, limite, panne). |
| `src/mescollections/doublure.json` | Réponse fictive de `/sites` et des questions, données en `fake-domain.name`, pour développer sans serveur. |
| `tests/mescollections-*.test.js` | `correspond` (table de cas), `sites` (états, recul, anonyme), `api` (429, 503, 404, 401). |

### 6.2 Fichiers modifiés

| Fichier | Modification |
|---|---|
| `src/background.js` | `importScripts` des modules ; `tabs.onUpdated` / `tabs.onRemoved` ; messages `mescollections:demander`, `mescollections:conversation` ; alarme `mescollections-sites`. |
| `src/dm/config.json` | Clé `mycollectionsApiBase` (valeur bakée) et option `mycollectionsDoublure`. |
| `src/dm/bootstrap.js` | Même clé dans `_fallbackConfig`. |
| `src/options.html` / `src/options.js` | Ligne de diagnostic (§5.4), case « Utiliser la doublure ». |
| `manifest.json` | `web_accessible_resources` pour la feuille et la police si empaquetée. Aucune nouvelle permission (§7.1). |
| `tests/setup.js` | Mocks `storage.session`, `alarms`, `tabs.onUpdated` si absents. |
| `docs/ARCHITECTURE.md` | Section « Actions assistées : Mes collections ». |

### 6.3 Configuration

- `mycollectionsApiBase` est **bakée** dans `src/dm/config.json` et dans
  `_fallbackConfig`. Vide ⇒ état `inactif`. Valeurs en attendant le DM (il n'existe
  qu'une instance déployée) :

  | Profil | Valeur |
  |---|---|
  | `dev` | `http://localhost:8200` (backend local) |
  | `int`, `prod` | `https://mescollections.numerique-interieur.com` |
- **TODO** : la faire servir par le Device Management (placeholder
  `${{MYCOLLECTIONS_API_BASE}}` dans `src/dm/dm-config.json`, variable d'environnement
  côté DM, liste des variables dans `docs/adr-plugin-dm-integration.md`). Suivi
  dans l'issue #5.
- `mycollectionsDoublure: true` ⇒ `sites.js` et `api.js` lisent `doublure.json`
  (`runtime.getURL`) au lieu du réseau.

### 6.4 Flux

1. Démarrage, connexion ou alarme ⇒ `sites.js` lit `/sites` et met à jour l'état.
2. `tabs.onUpdated` (url changée) ⇒ l'arrière-plan compare `tab.url` aux motifs.
   Aucun appel réseau à cette étape.
3. Correspondance et état `connecte` ou `anonyme` ⇒ injection de `bulle.js` dans
   l'onglet (cadre principal seulement, un seul exemplaire), avec les cibles
   présélectionnées.
4. Question ⇒ message `mescollections:demander` `{ cibles, question }` à
   l'arrière-plan ⇒ `api.js` ⇒ réponse rendue dans le panneau.
5. Conversation rangée par l'arrière-plan dans `storage.session`, sous l'identifiant
   d'onglet ; effacée à `tabs.onRemoved`.
6. Passage à `injoignable` ou `inactif` ⇒ message aux onglets porteurs ⇒ la bulle se
   retire.

## 7. Contraintes

### 7.1 Permissions et injection

- **Avec `scripting`** (apporté par la PR #3) : détection dans l'arrière-plan,
  injection par `scripting.executeScript` uniquement dans les onglets qui
  correspondent. Aucun script sur les autres pages. **Option retenue.**
- **Sans `scripting`** : content script statique « détecteur » sur `<all_urls>`,
  moins de 2 Ko, qui ne fait rien tant que l'arrière-plan ne lui répond pas
  « cibles ». Repli si la PR #3 n'est pas fusionnée.
- Ajouter une permission déclenche une nouvelle demande d'approbation à la mise à
  jour : la bulle n'en ajoute aucune elle-même.

### 7.2 Divers

- CSP des pages d'extension : `script-src 'self'` ; aucun script distant ni inline.
- `storage.local` sans `unlimitedStorage` : ne garder que la liste des motifs,
  jamais les résultats.
- Arrière-plan : pas de `window`, pas de XHR (`ARCHITECTURE.md` §7).
- Ni jeton, ni nom de personne, ni identifiant d'infrastructure, ni chemin de poste
  dans le code, la doc ou les journaux.

## 8. Dépendance avec la PR #3

La PR #3 (contrat d'agents, brouillon, basée sur `main`) touche les mêmes fichiers
(`background.js`, `bootstrap.js`, `config.json`, `manifest.json`, `tests/setup.js`)
et apporte déjà :

- l'arrière-plan sous Firefox (`background.scripts` en plus de `service_worker`) ;
- la permission `scripting` ;
- un rafraîchissement forcé du jeton avec une seule nouvelle tentative sur 401 ;
- les mocks `storage.session` ;
- le modèle « fonction invisible tant que la clé est vide ».

Elle crée aussi un `docs/ARCHITECTURE.md` différent de celui de la PR #2, et ne
connaît pas la séparation `dm-config.json` / `config.json` de cette branche.

**Proposition** : extraire de la PR #3 la correction Firefox dans une PR courte,
fusionnée en premier, puis baser la phase 2 dessus. À défaut, la phase 2 commence par
vérifier Firefox ESR sur cette branche et reprend la même correction.

## 9. Phases

Une PR en brouillon par phase, sans fusion.

1. **Plan** — ce document.
2. **Détection** — d'abord la vérification Firefox ESR (§8) ; puis config,
   `correspond()` et ses tests, `sites.js` sur la doublure avec états, recul et mode
   anonyme, détection par onglet. Critère : la bulle (un simple marqueur à ce stade)
   apparaît sur une page déclarée, nulle part ailleurs, disparaît quand la doublure
   simule une panne, et revient seule.
3. **Interface** — bulle, panneau en Shadow DOM, redimensionnement par le coin haut
   gauche, clavier, thèmes, rendu des passages sur la doublure. Mécanique reprise de
   `demo/intranet/fenetre.js` et `fenetre.css` du dépôt `IA-Generative/dgef-eligibilite`
   (poignée, bornes, `setPointerCapture`, clavier ; rendu Markdown sans `innerHTML` ;
   puces à cocher).
4. **Branchement réel** — contre la bêta de Mes collections, une fois le prérequis
   d'audience réglé et `/api/v1/sites` livré.
5. **Recette** — Chrome et Firefox ESR, pages de test fictives, données d'exemple en
   `fake-domain.name`, scénarios de panne (service coupé, 429, 503, jeton expiré).

## 10. Design (rappel, phase 3)

- **Bulle** : pastille ronde de 44 px en bas à droite, « + IA » ; bleu France à 70 %
  d'opacité, `backdrop-filter: blur(8px)`, ombre légère ; opaque au survol et au
  focus ; déplaçable verticalement, position mémorisée par site ; « Masquer sur ce
  site » par menu contextuel ou clic long.
- **Panneau** : 380 × 520 px par défaut, ancré en bas à droite ; redimensionnable par
  la poignée du coin haut gauche ; flèches, Maj + flèches, Origine, Fin ; double-clic
  pour agrandir ou revenir ; taille mémorisée.
- **En-tête** : titre de la cible, Effacer, Réduire ; puces à cocher des cibles (au
  moins une cochée).
- **Fil** : carte compacte par passage (titre, extrait, « Ouvrir ») ; repli « Comment
  l'assistant a cherché » avec le plan.
- **Saisie** : Entrée envoie, Maj + Entrée va à la ligne ; « Utiliser la sélection »
  si du texte est sélectionné.
- Thèmes clair et sombre ; Marianne avec repli système ; `role="dialog"`, Échap
  réduit, focus rendu à la bulle, `aria-live` sur le fil.

## 11. Questions

Ouverte :

1. Ordre de fusion avec la PR #3 (§8).

Tranchées avec Mes collections :

2. Réponse anonyme : liste seule, collections publiques, derrière un interrupteur
   serveur ; questions jamais anonymes (§5.3).
3. 403 `audience_mismatch` : état `refuse` avec diagnostic, pas de bascule anonyme
   (§5.1).
4. Valeurs bakées de `mycollectionsApiBase` : §6.3.

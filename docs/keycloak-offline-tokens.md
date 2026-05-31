# Keycloak — Configuration pour session 6 mois sans re-login (offline tokens)

Réglages à appliquer sur le realm **`mirai`** de `sso.mirai.interieur.gouv.fr`
pour que l'extension IAssistant-Direct (by Mirai) ne redemande **pas** de login
interactif pendant ~6 mois.

> Côté extension, c'est **déjà fait** : le scope demandé est désormais
> `openid profile email offline_access` (auth.js + background.js), et le token
> est stocké chiffré au repos. **Mais sans les réglages serveur ci-dessous,
> l'offline token n'atteindra pas 6 mois.**

## 1. Client `mirai-extension`

- **Client scopes** : `offline_access` doit être assigné au client en **Default**
  ou **Optional** (l'extension le demande explicitement → *Optional* suffit).
  - Admin console → Clients → `mirai-extension` → *Client scopes* → *Add* →
    `offline_access` (type *Optional*).
- **Consent required** : si activé, l'utilisateur verra un écran de consentement
  « accès hors ligne » au 1er login. Acceptable, mais à désactiver si on veut
  zéro friction (Clients → `mirai-extension` → Settings → *Consent required* OFF).
- Public client + PKCE (S256) : déjà le cas, ne pas changer.

## 2. Realm `mirai` → Sessions (onglet *Sessions*)

Les **offline sessions** sont indépendantes des *SSO Session* (online). C'est ce
qui permet de survivre à l'expiration de la session SSO classique (30 min / 10 h).

| Paramètre | Valeur cible | Effet |
|---|---|---|
| **Offline Session Idle** | `180 jours` | Durée de survie de l'offline token **sans utilisation**. À ≥ 6 mois pour ne pas mourir entre deux usages. |
| **Offline Session Max Limited** | `ON` | Active un plafond absolu de durée de vie. |
| **Offline Session Max** | `180 jours` | Plafond absolu → re-login forcé au bout de 6 mois (= ton « ou tous les 6 mois »). |

> Si tu veux « jamais de re-login » plutôt que « tous les 6 mois » : mettre
> *Offline Session Max Limited* = OFF (seul l'idle de 180 j gouverne, repoussé à
> chaque usage). La cible « tous les 6 mois » correspond à Max Limited = ON.

## 3. Realm `mirai` → Tokens (onglet *Tokens*)

- **Access Token Lifespan** : laisser court (ex. `5 min`). Il est rafraîchi
  silencieusement via l'offline token — inutile et déconseillé de l'allonger.
- **Revoke Refresh Token** / **Refresh Token Max Reuse** : si *Revoke Refresh
  Token* est activé avec rotation, vérifier que l'offline token est bien
  ré-émis à chaque refresh (comportement standard). En cas de doute, laisser les
  valeurs par défaut.

## 4. Vérification

1. Login PKCE depuis l'extension → vérifier dans Keycloak :
   *Sessions* → l'utilisateur a une **Offline session** (pas seulement online).
2. Attendre l'expiration de la session SSO online (ou la révoquer) → l'extension
   doit continuer à rafraîchir le token **sans re-login**.
3. Contrôler la durée : l'offline session affiche une expiration ~180 j.

## Validation (2026-05-30)

Testé end-to-end sur l'extension (build Scaleway, login PKCE réel) :
- Scope accordé : `openid profile email groups roles offline_access` ✅ (offline token émis)
- Token stocké chiffré, relu via `TokenStore` ✅
- **Refresh silencieux confirmé** : l'access token (30 min) a expiré (`expMin` 0) puis a
  été renouvelé automatiquement (`[MirAI Auth] Token refreshed silently.`) **sans
  nouveau login PKCE** → preuve du fonctionnement offline.

Avec *Client Offline Session Idle = 180 j* (relevé côté client `mirai-extension`),
le besoin « pas de re-login pendant ~6 mois » est satisfait.

## 5. Révocation (rappel)

- Côté **utilisateur/poste** : `logout()` de l'extension supprime le token local.
- Côté **Keycloak** : *Users* → *Sessions* → *Sign out* (révoque l'offline
  session), ou révocation en masse via *Realm* → *Sessions*. La prochaine tentative
  de refresh échoue → l'extension repasse en login interactif.

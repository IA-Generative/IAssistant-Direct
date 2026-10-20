# Recette de la bulle « + IA » (Mes collections)

Plan et contrat : [`docs/plan-bulle-mes-collections.md`](../../docs/plan-bulle-mes-collections.md).

## Recette automatique

```sh
scripts/recette-bulle/recette.sh          # Chrome puis Firefox ESR
scripts/recette-bulle/recette.sh chrome
scripts/recette-bulle/recette.sh firefox
```

Le script prépare une copie de l'extension. Dans cette copie, la doublure déclare
`https://example.org/*` (page d'essai réservée à la documentation). `https://example.com/`
sert de page non déclarée. Aucun service réel n'est appelé : la doublure tient lieu de
Mes collections, et un jeton **factice** est stocké dans un profil de navigateur jetable.
Le script s'arrête en erreur si une vérification échoue. Les captures sont écrites
dans le dossier temporaire affiché à la fin.

Prérequis :

- node ≥ 22 ;
- Google Chrome ≥ 137 (variable `CHROME` pour un autre chemin), chargé par
  `Extensions.loadUnpacked` en CDP, car `--load-extension` est ignoré ;
- Firefox ESR ≥ 128 (variable `FIREFOX`) et `web-ext`, piloté par WebDriver BiDi.

| # | Scénario | Attendu |
|---|---|---|
| 1 | Doublure anonyme, sans jeton | État `anonyme` ; bulle sur la page déclarée, aucune ailleurs |
| 2 | Doublure en panne | État `injoignable`, aucune bulle, nouvelle tentative dans moins de 2 min ; la bulle revient quand le service revient |
| 3 | Jeton refusé (403 `audience_mismatch`) | État `refuse`, aucune bulle |
| 4 | Anonyme fermé (401 sans jeton) | État `inactif` |
| 5 | Connecté | Bulle → panneau → question → réponse gardée pour l'onglet ; agrandissement par le coin, taille mémorisée ; Échap réduit |
| 6 | Déconnexion | Conversations effacées |

## Recette manuelle (non automatisée)

À faire avant le branchement réel (phase 4) et à chaque version :

- [ ] **Vraie connexion SSO** (`mirai-extension`) puis bulle sur une page déclarée dans la
      bêta de Mes collections. Il faut au préalable que l'audience `mycollections-front` soit
      réglée et qu'un gestionnaire ait déclaré un motif dans « Publication ».
- [ ] Claim `groups` du jeton en chemins complets (`/g/...`) : décoder un jeton réel.
- [ ] Question réelle à un assistant et à une collection ; « Ouvrir ↗ » ouvre le passage
      signé.
- [ ] Lecteur d'écran (VoiceOver ou NVDA) : bulle annoncée, panneau `dialog`, fil
      `aria-live`, puces au clavier.
- [ ] Clavier seul : Tab jusqu'à la bulle, Entrée ouvre, poignée aux flèches, Échap rend
      le focus à la bulle, Maj+F10 ouvre le menu « Masquer sur ce site ».
- [ ] Site avec une CSP stricte sous Firefox : la bulle reste stylée (repli `<style>`).
- [ ] Application monopage : la bulle apparaît ou disparaît quand l'adresse change sans
      rechargement.
- [ ] Thème sombre du système.

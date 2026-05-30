# Demande de changement — Déploiement de l'extension navigateur « IAssistant-Direct (by Mirai) »

| | |
|---|---|
| **Objet** | Autoriser l'installation forcée (self-hosted) d'une extension Chromium/Edge/Firefox interne, distribuée par le Device Management interne, sans accès Internet ni Chrome Web Store |
| **Demandeur** | Eric Tiquet — Fabrique numérique / DTNUM |
| **Date** | 2026-05-30 |
| **Criticité** | Moyenne — bloquante pour la campagne de beta avec le réseau d'ambassadeurs |
| **Type** | Exception de configuration navigateur (policy gérée) — périmètre restreint |
| **Environnement cible** | Postes Chromium/Edge (et Firefox ESR) du périmètre ambassadeurs, **air-gap** (pas d'accès Internet ; seul le DM interne est joignable) |

---

## 1. Contexte & besoin

L'extension **IAssistant-Direct (by Mirai)** (capture et transcription des réunions
en ligne) doit être déployée aux ambassadeurs pour une campagne de beta.

Deux contraintes structurantes :
1. **Les postes n'ont pas d'accès Internet** — ils ne peuvent joindre que le
   Device Management (DM) interne. Le **Chrome Web Store est donc inutilisable**
   (il exige les serveurs Google pour l'installation et la mise à jour).
2. **Pas de possibilité de pousser une politique générale** dans des délais
   courts (gel IT).

Le mécanisme **supporté par Chromium/Edge/Firefox pour ce cas exact** est
l'installation forcée *self-hosted* : le navigateur installe et met à jour
l'extension depuis un `update_url` interne (le DM), **sans aucune dépendance
Google ni Internet**. C'est l'objet de cette demande, sur un **périmètre
restreint** (groupe ambassadeurs) et pour **une seule extension** explicitement
identifiée.

---

## 2. Changement demandé

Ajouter, pour le **groupe de postes ambassadeurs uniquement**, une politique
navigateur autorisant l'installation forcée de l'extension identifiée ci-dessous,
avec un `update_url` pointant vers le DM interne.

**Aucune autre extension n'est concernée. Aucune AC custom, aucun proxy, aucun
flux Internet ne sont demandés.**

---

## 3. Valeurs techniques

### Identifiants de l'extension

| | Valeur |
|---|---|
| Nom visible | `IAssistant-Direct (by Mirai)` |
| Extension ID (Chromium/Edge) | `cjaokgcdmdeakhkplbifninjcdklhokf` |
| Gecko ID (Firefox ESR) | `mirai-assistant@interieur.gouv.fr` |
| Version | 1.2.2 |
| Signature | CRX signé avec la clé PEM interne (DTNUM) — ID stable |

### URLs du DM (à utiliser dans la policy)

> ⚠️ **Bascule prévue** : la beta démarre sur l'URL **temporaire** ; une **URL
> définitive** prendra le relais quand le DM cible sera disponible. Les deux sont
> listées ici ; il faudra **mettre à jour la policy** au moment de la bascule
> (même Extension ID, seul l'hôte change).

| Phase | Base DM | `update_url` Chromium/Edge | `update_url` / XPI Firefox |
|---|---|---|---|
| **Temporaire** (beta) | `https://onyxia.gpu.minint.fr/bootstrap` | `https://onyxia.gpu.minint.fr/bootstrap/updates/mirai-browser-dgx.xml` | `https://onyxia.gpu.minint.fr/bootstrap/updates/mirai-browser-dgx.json` |
| **Définitive** | `https://device-manager.mirai.interieur.rie.gouv.fr/bootstrap` | `https://device-manager.mirai.interieur.rie.gouv.fr/bootstrap/updates/mirai-browser-dgx.xml` | `https://device-manager.mirai.interieur.rie.gouv.fr/bootstrap/updates/mirai-browser-dgx.json` |

CRX téléchargé automatiquement par le navigateur via le manifeste d'update :
`<base>/releases/mirai-browser-1.2.2-dgx.crx` (Chromium) /
`<base>/releases/mirai-browser-1.2.2-dgx.xpi` (Firefox).

---

## 4. Implémentation (à appliquer par l'IT)

### 4.1 Chromium / Google Chrome

**Option recommandée — `ExtensionSettings`** (granulaire, une seule extension) :

```json
{
  "cjaokgcdmdeakhkplbifninjcdklhokf": {
    "installation_mode": "force_installed",
    "update_url": "https://onyxia.gpu.minint.fr/bootstrap/updates/mirai-browser-dgx.xml"
  }
}
```

**Option simple — `ExtensionInstallForcelist`** (1 entrée) :

```
cjaokgcdmdeakhkplbifninjcdklhokf;https://onyxia.gpu.minint.fr/bootstrap/updates/mirai-browser-dgx.xml
```

Emplacements :
- **Windows (GPO/registre)** : `HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist`
  (valeur `1` = la chaîne ci-dessus), ou `...\Chrome\ExtensionSettings` (JSON).
- **Linux** : `/etc/opt/chrome/policies/managed/iassistant.json`
- **macOS** : profil de configuration / `com.google.Chrome` `ExtensionInstallForcelist`.

### 4.2 Microsoft Edge (Chromium)

Mêmes valeurs, sous l'espace de noms Edge :
- **Windows** : `HKLM\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist`
- Entrée identique : `cjaokgcdmdeakhkplbifninjcdklhokf;https://onyxia.gpu.minint.fr/bootstrap/updates/mirai-browser-dgx.xml`

### 4.3 Firefox ESR

`policies.json` (`<firefox>/distribution/policies.json` ou GPO Firefox) :

```json
{
  "policies": {
    "ExtensionSettings": {
      "mirai-assistant@interieur.gouv.fr": {
        "installation_mode": "force_installed",
        "install_url": "https://onyxia.gpu.minint.fr/bootstrap/releases/mirai-browser-1.2.2-dgx.xpi"
      }
    }
  }
}
```

### 4.4 Pré-requis à NE PAS oublier

- L'hôte du DM (`onyxia.gpu.minint.fr`) doit être **joignable depuis les postes**
  (déjà le cas — c'est l'endpoint applicatif). Aucun autre flux requis.
- L'extension **ne doit pas** figurer dans `ExtensionInstallBlocklist` (ou `*`
  bloquant) sans exception ; si une blocklist `*` existe, ajouter cet ID à
  `ExtensionInstallAllowlist`.
- Aucune connectivité vers `*.google.com` / Chrome Web Store n'est nécessaire.

---

## 5. Justification sécurité

- **Périmètre minimal** : une seule extension explicitement identifiée par son ID,
  sur un groupe de postes restreint (ambassadeurs).
- **Intégrité** : CRX signé par la clé PEM interne (DTNUM) ; l'Extension ID
  (`cjaok…hokf`) est dérivé de cette clé → tout binaire non signé par cette clé
  est rejeté par le navigateur.
- **Aucune surface réseau ajoutée** : pas d'AC custom, pas de proxy, pas
  d'ouverture Internet. Le seul flux est vers le DM interne déjà autorisé.
- **Réversible** : suppression de l'entrée de policy → l'extension est désinstallée
  au prochain rafraîchissement de politique.
- **Auditable** : la distribution et les versions sont tracées côté DM
  (catalogue, campagnes, télémétrie OTLP).

---

## 6. Périmètre, bascule & rollback

- **Périmètre** : groupe AD/MDM « ambassadeurs » (à préciser avec l'IT).
- **Bascule temporaire → définitive** : lorsque le DM définitif est en service,
  mettre à jour la valeur `update_url` de la policy (Extension ID inchangé).
  Aucun redéploiement du CRX côté poste : le navigateur récupère la nouvelle
  version via le nouveau `update_url` au prochain cycle d'update.

  Entrée `ExtensionInstallForcelist` (Chromium/Edge) après bascule :
  ```
  cjaokgcdmdeakhkplbifninjcdklhokf;https://device-manager.mirai.interieur.rie.gouv.fr/bootstrap/updates/mirai-browser-dgx.xml
  ```
  `install_url` Firefox ESR après bascule :
  ```
  https://device-manager.mirai.interieur.rie.gouv.fr/bootstrap/releases/mirai-browser-1.2.2-dgx.xpi
  ```
- **Rollback** : retirer l'entrée `ExtensionInstallForcelist` / `ExtensionSettings`
  → désinstallation automatique.

---

## 7. Validation après application (côté demandeur)

1. Sur un poste pilote, vérifier dans `chrome://extensions` (ou `edge://extensions`)
   que « IAssistant-Direct (by Mirai) » apparaît **installée et activée**, sans
   intervention de l'utilisateur.
2. Vérifier l'icône dans la barre d'outils et le login SSO via le relay.
3. Confirmer la remontée de l'enrôlement côté DM (catalogue / télémétrie).

---

## 8. Contacts

- Demandeur / technique : Eric Tiquet — eric.tiquet@gmail.com
- Support produit : fabrique-numerique@interieur.gouv.fr

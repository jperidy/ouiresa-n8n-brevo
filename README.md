# n8n local - Import contacts CN Roscoff vers Brevo

Pipeline n8n local (Docker) qui segmente les clients du club (export ouiresa)
par catégorie et synchronise les contacts vers Brevo avec les bonnes listes,
attributs (adresse, licence, statut de cotisation) et un fichier de contrôle
avant tout appel API.

## Prérequis

- Docker + Docker Compose, `make`
- Un compte Brevo avec une clé API (Brevo > Paramètres du compte > Clés API/SMTP)
- Accès à `https://cn-roscoff.ouiresa.fr/manager/client` pour exporter les CSV sources

## Commandes

```
make help
```

```
up                 Demarre n8n + Postgres
down               Arrete les conteneurs (garde les donnees)
reset              Arrete et SUPPRIME les volumes (repart de zero) -- destructif
ps                 Statut des conteneurs
logs               Suit les logs de n8n
shell              Ouvre un shell dans le conteneur n8n
psql               Ouvre un client psql sur la base n8n
import             Importe/met a jour les workflows depuis workflows/*.json
run-generate       Etape 1: genere brevo_import.csv / non_categorise.csv / a_verifier.csv
run-import         Etape 2: envoie brevo_import.csv vers l'API Brevo
test               Teste le script de segmentation en local (sans Docker) sur les vrais CSV
db-backup          Dump complet de la base Postgres vers backup_<date>.sql
db-restore         Restaure un dump (usage: make db-restore FILE=backup_xxx.sql)
workflows-backup   Exporte workflows + credentials au format n8n dans workflows/
```

## 1. Setup depuis zéro

```bash
git clone <ce repo>
cd n8n
cp .env.example .env
```

Édite `.env` :
- `N8N_BASIC_AUTH_USER` / `N8N_BASIC_AUTH_PASSWORD` : identifiants d'accès à l'éditeur n8n
- `N8N_ENCRYPTION_KEY` : génère avec `openssl rand -hex 32` — **ne la change plus une fois des credentials enregistrés dans n8n** (Brevo notamment), sinon ils deviennent indéchiffrables
- `POSTGRES_PASSWORD` : génère avec `openssl rand -base64 24`
- Le reste peut rester tel quel pour un usage local

```bash
make up
make ps   # postgres et n8n doivent etre "healthy"
```

n8n est disponible sur http://localhost:5678 (identifiants Basic Auth
ci-dessus). Au premier accès, n8n demande aussi de créer un compte "owner"
(email + mot de passe) dans l'éditeur — mécanisme séparé du Basic Auth,
utilise l'adresse de ton choix.

## 2. Récupérer les fichiers sources

Les deux CSV viennent de `https://cn-roscoff.ouiresa.fr/manager/client` :

| Fichier | Où l'exporter | Dossier de destination |
|---|---|---|
| `liste_clients.csv` | Menu **Clients** → **Liste des clients** → export | `data/imports/liste_clients/` |
| `cotisants.csv` | Menu **Clients** → **Cotisations** → **Licences achetées** → export | `data/imports/cotisants/` |

Dépose les fichiers exportés tels quels (encodage Windows-1252 d'origine, ne
pas les réenregistrer/convertir) dans ces deux dossiers. Le nom exact du
fichier n'a pas d'importance, seul le dossier compte — évite juste d'en
laisser plusieurs à la fois dans un même dossier. Contenu jamais commité
(`.gitignore`).

## 3. Importer les workflows

```bash
make import
```

Importe `workflows/01-generer-fichiers-brevo.json` et
`workflows/02-importer-contacts-brevo.json`. Les deux JSON ont un `id` fixe
(`seg0000001brevo` et `imp0000002brevo`) : relancer cette commande après une
modification **met à jour les workflows existants dans n8n** plutôt que d'en
créer des doublons.

## 4. Configurer le credential Brevo

Le nœud HTTP qui appelle Brevo utilise une authentification générique par
en-tête (pas le nœud Brevo dédié, plus simple à maintenir dans le temps) :

1. Brevo → Paramètres du compte → **Clés API/SMTP** → récupère ta clé API.
2. n8n → **Credentials** → **New** → **Header Auth**.
3. Le formulaire a deux "name" différents, à ne pas confondre :
   - Le nom du **credential** (champ en haut du formulaire, pour le retrouver
     dans la liste n8n) : mets ce que tu veux, ex. `Brevo API Key`.
   - Les champs **Name** / **Value** du couple header à envoyer : Name =
     `api-key` (littéral, c'est le nom du header HTTP que Brevo attend), Value
     = ta clé API Brevo (commence en général par `xkeysib-...`).
4. Dans le workflow `02 - Importer contacts vers Brevo`, ouvre le nœud
   **Brevo - Upsert contact** et sélectionne ce credential (le JSON importé
   référence le nom mais pas l'ID technique, à rattacher manuellement une fois).

## 5. Créer les listes et attributs dans Brevo

Deux types de listes, car les cotisants changent chaque année mais on veut
garder l'historique (voir §8) :

- **Listes structurelles** (`ecole`, `entreprise`, `autre`) : pas liées à
  une année, un contact y est ajouté/retiré à chaque run selon son état
  actuel. À créer une fois pour toutes.
- **Listes de cotisation, une paire par année** (`Cotisant annuel 2026`,
  `Cotisant saisonnier 2026`) : un contact y est seulement ajouté, jamais
  retiré automatiquement — c'est un instantané figé de qui était cotisant
  cette année-là. **À créer chaque saison** (voir §5bis).

Crée ces listes dans **Brevo → Contacts → Listes**, note leurs IDs (visibles
dans l'URL de chaque liste), puis renseigne-les dans le nœud **Préparer
payload Brevo** du workflow 2 (en haut du code) :

```js
const STRUCTURE_LIST_IDS = {
  ecole: 2,        // <- ID reel de ta liste "Ecole"
  entreprise: 3,    // <- ID reel de ta liste "Entreprise"
  autre: 6,         // <- ID reel de ta liste "Autre"
};

const COTISATION_LIST_IDS_BY_YEAR = {
  2026: { cotisant_annuel: 4, cotisant_saisonnier: 5 }, // <- IDs reels des listes 2026
};
```

### 5bis. Chaque nouvelle saison

1. Crée deux nouvelles listes dans Brevo : `Cotisant annuel <année>` et
   `Cotisant saisonnier <année>`.
2. Ajoute une entrée dans `COTISATION_LIST_IDS_BY_YEAR` avec leurs IDs :
   ```js
   const COTISATION_LIST_IDS_BY_YEAR = {
     2026: { cotisant_annuel: 4, cotisant_saisonnier: 5 },
     2027: { cotisant_annuel: 7, cotisant_saisonnier: 8 }, // nouvelle annee
   };
   ```
3. `make import` pour republier le workflow modifié.

Si tu oublies cette étape, le contact est quand même importé (la cotisation
et la catégorie restent correctes) mais n'est ajouté à aucune liste
Brevo de cotisation cette année-là — le nœud "Résumé import" le signale
dans `avertissements_config`.

Crée aussi ces attributs de contact **personnalisés** (**Brevo → Contacts →
Paramètres → Attributs de contact** → choisis bien "Personnalisé", pas
"Standard"), sinon Brevo les ignorera silencieusement à l'import :

| Attribut | Type Brevo | Exemple |
|---|---|---|
| `NOM` | Texte | `DUPONT` |
| `PRENOM` | Texte | `Marie` |
| `ADRESSE` | Texte | `12 rue du Port` |
| `CODE_POSTAL` | Texte | `29680` |
| `VILLE` | Texte | `ROSCOFF` |
| `PAYS` | Texte | `FR` |
| `COTISATION_A_JOUR` | Booléen | `true` |
| `ANNEE_COTISATION` | Texte ou Nombre | `2026` |
| `TYPE_LICENCE` | Texte | `Passeport voile; Licence FFV + 18 ans` |
| `NB_PERSONNES_LIEES` | Nombre | `3` |
| `AUTRES_PERSONNES` | Texte | `PIERRE DUPONT; LEA DUPONT` |

`SMS` (et `EMAIL`) ne sont **pas** à créer : ce sont des attributs
**Standard** déjà présents nativement dans tout compte Brevo, utilisés pour
le SMS marketing — Brevo les traite comme identifiants uniques du contact
(voir §8) sans configuration de ta part.

## 6. Exécuter le pipeline

**Étape 1 — Générer les fichiers (aucun appel Brevo à ce stade)**

```bash
make run-generate
```

Vérifie d'abord que les deux CSV source ont bien les colonnes attendues
(échec explicite sinon — voir §12), puis produit trois fichiers dans
`data/output/` :
- `brevo_import.csv` : contacts prêts pour Brevo
- `non_categorise.csv` : lignes **exclues** (email manquant/invalide/suspect), avec la raison en dernière colonne — rien de ça ne part vers Brevo
- `a_verifier.csv` : lignes **incluses** dans `brevo_import.csv` mais avec un avertissement à vérifier (colonne `AVERTISSEMENT`) — typiquement un téléphone non normalisable, un type de cotisation inconnu, ou un téléphone partagé par deux contacts (le doublon est alors vidé automatiquement pour l'un des deux, voir §9)

**Relis `brevo_import.csv` et `a_verifier.csv` avant de continuer**
(Excel/LibreOffice, séparateur `;`, encodage UTF-8) — c'est le fichier de
contrôle : tu peux corriger ou supprimer des lignes à la main avant l'envoi
réel à Brevo.

**Étape 2 — Envoyer vers Brevo**

```bash
make run-import
```

Relit `brevo_import.csv` et fait un appel API Brevo (upsert, voir §8) par
contact, avec ajout/retrait de listes selon la catégorie actuelle. Les
appels sont espacés de 400ms (throttling natif du nœud HTTP) pour éviter les
coupures réseau (`ECONNRESET`) observées en enchaînant les requêtes sans
pause. Produit `data/output/erreurs_brevo.csv` : une ligne par échec API ou
avertissement de config (ex: année sans liste Brevo configurée), colonnes
`EMAIL;TYPE;DETAIL` — vide si tout s'est bien passé.

## 7. Logique de catégorisation

Colonnes de `brevo_import.csv` :

| Colonne | Contenu |
|---|---|
| `CATEGORIES` | Une ou plusieurs valeurs parmi `ecole`, `entreprise`, `cotisant_annuel`, `cotisant_saisonnier`, `autre`, séparées par `;` |
| `COTISATION_A_JOUR` | `oui` si le contact a payé une cotisation (annuelle ou estivale) **pour l'année civile en cours**, recalculé à chaque exécution |
| `TYPE_LICENCE` | Passeport voile / Licence FFV, si présent dans `cotisants.csv` |
| `NB_PERSONNES_LIEES` / `AUTRES_PERSONNES` | Quand plusieurs personnes du club partagent un même email (couple, fratrie), Brevo ne peut stocker qu'un contact par email : les infos sont fusionnées sur une ligne, ces colonnes te permettent de vérifier qui est rattaché |

Règles :
- **Catégories multiples** : école/entreprise (type de structure) et
  cotisant annuel/saisonnier (statut de paiement) ne s'excluent pas — un
  contact peut appartenir à plusieurs listes Brevo en même temps.
- **`autre`** uniquement si aucune des 4 autres catégories ne s'applique.
- **À jour = année civile courante uniquement.** Un cotisant qui ne renouvelle
  pas l'année suivante repasse `COTISATION_A_JOUR = non` au prochain export,
  et le workflow 2 le **retire activement** des listes `cotisant_annuel` /
  `cotisant_saisonnier` dans Brevo (`unlinkListIds`) — la synchronisation
  reflète toujours l'état courant, pas un historique cumulatif.
- **Emails exclus par défaut** : `blabla@gmail.com` (placeholder détecté dans
  l'export réel, partagé par 17 personnes sans lien) et les formes évidentes
  (`test@`, `xxx@`, `none@`...). Liste modifiable dans
  `workflows/scripts/segmenter.js` (`EMAIL_BLOCKLIST` / `PLACEHOLDER_LOCAL_PARTS`).

## 8. Scénarios de synchronisation avec Brevo

Le workflow 2 fait un upsert (`updateEnabled: true`) par ligne de
`brevo_import.csv`, avec ajout (`listIds`) et retrait (`unlinkListIds`).
Les listes **structurelles** (`ecole`, `entreprise`, `autre`) et les listes
**de cotisation par année** (§5) ne suivent pas la même règle :

| Scénario | Comportement |
|---|---|
| **Contact absent de Brevo** | Créé avec les attributs du CSV, ajouté aux listes de `listIds`. `unlinkListIds` ne fait rien (il n'était dans aucune liste). |
| **Contact existant, infos différentes** (adresse, statut cotisation...) | Les attributs envoyés (`NOM`, `ADRESSE`, `COTISATION_A_JOUR`...) **écrasent** la valeur Brevo actuelle — le CSV est source de vérité pour ces champs. |
| **Contact existant, listes structurelles différentes** | Resynchronisation complète à chaque run : ajouté aux listes qui s'appliquent maintenant, **retiré** de celles qui ne s'appliquent plus (`ecole`/`entreprise`/`autre` uniquement). |
| **Contact existant, statut de cotisation différent** | Ajouté à la liste `Cotisant <categorie> <année>` de l'année en cours si applicable, mais **jamais retiré** d'une liste de cotisation d'une année passée — ces listes sont des instantanés historiques figés, pas un statut courant (voir §5). Un non-renouvellement n'efface donc pas la trace "cotisant en 2026". |
| **Contact dans Brevo mais absent du CSV** (supprimé côté ouiresa, ou exclu par le filtre email) | **Rien ne se passe.** Le workflow ne fait qu'un POST par ligne présente dans `brevo_import.csv` — aucune suppression ni désabonnement automatique côté Brevo. Le contact reste tel quel indéfiniment. |
| **Contact désabonné manuellement dans Brevo** (`emailBlacklisted`) | Pas touché : ce champ n'est pas envoyé, un désabonnement reste donc respecté même après mise à jour. |
| **Erreur API sur une ligne** (quota, coupure réseau...) | `continueOnFail` + 3 tentatives automatiques, appels espacés de 400ms : une erreur sur un contact n'interrompt pas les suivants. Le détail atterrit dans `data/output/erreurs_brevo.csv` (colonnes `EMAIL;TYPE;DETAIL`). |
| **Année de cotisation sans liste configurée** | Le contact est quand même créé/mis à jour avec ses attributs, mais n'est ajouté à aucune liste de cotisation cette année-là. Signalé dans `erreurs_brevo.csv` (voir §5bis). |

Point important : ce n'est **pas un miroir strict**. Le workflow pousse et
met à jour, mais ne supprime jamais un contact ni ne le désabonne côté
Brevo — un nettoyage (ex: un adhérent parti depuis 3 ans) reste une action
manuelle. Une liste que tu gères à la main dans Brevo (ex: "Newsletter
mensuelle") n'est jamais touchée, seules celles listées dans
`STRUCTURE_LIST_IDS` / `COTISATION_LIST_IDS_BY_YEAR` le sont.

## 9. Validation des données

Deux niveaux de contrôle, en plus de la validation email (§7) :

- **Colonnes attendues** (`REQUIRED_CLIENT_COLUMNS` / `REQUIRED_COTISANT_COLUMNS`
  dans `segmenter.js`) : si l'export ouiresa change de format (colonne
  renommée/supprimée), le workflow 1 **échoue immédiatement** avec un message
  listant les colonnes manquantes, plutôt que de tourner en silence avec des
  valeurs vides et de mal catégoriser tout le monde.
- **Téléphone** : Brevo traite l'attribut `SMS` comme un **identifiant
  unique**, au même titre que l'email (confirmé dans la doc officielle Brevo)
  — envoyer le même numéro pour deux contacts différents fait échouer
  l'appel API du second (`duplicate_identifiers`). Le numéro (`Mobile` sinon
  `Téléphone`) est normalisé en E.164 (`+33...`) : préfixe `00` converti en
  `+`, format local français (`0...`) converti en `+33...` uniquement si le
  pays du contact est FR (sinon on ne devine pas), numéros placeholder
  (`0000000000`, `1111111...`) écartés. Un numéro non normalisable est laissé
  vide. Un numéro normalisé identique sur deux emails différents n'est gardé
  que sur le **premier contact rencontré** — vidé sur les suivants pour
  éviter l'échec API systématique. Dans les deux cas la ligne part aussi dans
  `a_verifier.csv` pour que tu puisses vérifier/corriger à la main lequel des
  deux devrait garder le numéro. Ça ne couvre que les doublons **entre
  lignes de ton CSV** — un numéro qui entre en conflit avec un contact déjà
  présent dans Brevo (créé avant ce pipeline, ou lors d'un run précédent)
  n'est pas détectable localement ; l'échec atterrit dans `erreurs_brevo.csv`
  après coup (§6).
- **Types de cotisation inconnus** : si `cotisants.csv` contient une valeur
  de colonne `Type` qui n'est pas dans la liste connue
  (`KNOWN_COTISATION_TYPES`), le contact est quand même importé mais signalé
  dans `a_verifier.csv`.

## 10. Modifier la logique de segmentation

Le nœud **Segmenter et categoriser** du workflow 1 contient tout le code de
jointure/catégorisation. Pour le modifier sans risquer de casser le workflow :

1. Édite `workflows/scripts/segmenter.js` (logique pure, sans dépendance n8n).
2. `make test` — affiche les répartitions par catégorie, les rejets, sur les
   vrais fichiers de `data/imports/`.
3. Une fois satisfait, colle le contenu des fonctions (tout sauf le bloc
   `module.exports`) dans le nœud Code du workflow, à la suite du code de
   lecture des fichiers déjà présent, puis `make import`.

Pourquoi du code plutôt que des nœuds natifs : le nœud natif "Extract From
File" de n8n n'a pas d'option d'encodage et suppose de l'UTF-8, alors que les
exports ouiresa sont en Windows-1252 (accents/apostrophes cassés sinon). Le
reste (jointure par email, fusion de plusieurs personnes sous un même email,
licences agrégées) serait faisable en nœuds natifs mais demanderait 15-20
nœuds chaînés pour une logique qui tient en une fonction claire.

## 11. Base de données et backups

n8n utilise Postgres comme backend (service `postgres`, volume nommé
`postgres_data`) plutôt que le SQLite par défaut, pour faciliter les backups.

```bash
make db-backup                        # -> backup_<date>.sql
make db-restore FILE=backup_xxx.sql   # sur une base vide, conteneurs demarres
make workflows-backup                 # workflows + credentials au format n8n, dans workflows/
```

Ces backups ne protègent que si tu les copies **ailleurs** que dans ce
dossier de projet — un fichier généré ici reste exposé aux mêmes accidents
(`rm -rf`, `git clean -fdx`) que le reste du repo.

```bash
make down    # arrete les conteneurs, garde les donnees
make reset   # arrete et supprime aussi les volumes -- destructif, repart de zero
```

## 12. Dépannage

- **"Access to the file is not allowed."** : n8n restreint l'accès disque par
  défaut à `~/.n8n-files`. Ce projet autorise explicitement `/files`,
  `/workflows` et `/output` via `N8N_RESTRICT_FILE_ACCESS_TO` dans
  `docker-compose.yml`. Si tu ajoutes un nouveau dossier monté, ajoute-le à
  cette variable (séparateur `;`) puis `make up`.
- **"Colonnes manquantes dans ..."** : le workflow 1 a échoué au démarrage
  car une colonne attendue n'existe plus dans l'export ouiresa. Regarde le
  message d'erreur, compare avec le header réel du CSV, et mets à jour
  `REQUIRED_CLIENT_COLUMNS`/`REQUIRED_COTISANT_COLUMNS` dans
  `workflows/scripts/segmenter.js` si le renommage est volontaire (§10).
- **Accents cassés dans Brevo** : vérifie que le CSV source est toujours en
  Windows-1252 (ne pas le réenregistrer en UTF-8 avant import).
- **`n8n Task Broker's port 5679 is already in use`** : n'utilise pas
  `docker compose exec n8n n8n execute` directement (conflit avec le
  conteneur déjà démarré) — `make run-generate` / `make run-import` gèrent
  déjà ça correctement via `docker compose run --rm`.
- **Un contact garde une ancienne catégorie dans Brevo** : relance
  `make run-generate` puis `make run-import` — la logique est idempotente et
  recalcule `listIds`/`unlinkListIds` à chaque passage.

## Arborescence

```
Makefile
docker-compose.yml
.env                                    # secrets locaux (jamais commité)
data/imports/liste_clients/             # source: export "Liste des clients"
data/imports/cotisants/                 # source: export "Licences achetées"
data/output/                            # généré par les workflows 1 et 2 (jamais commité)
workflows/01-generer-fichiers-brevo.json
workflows/02-importer-contacts-brevo.json
workflows/scripts/segmenter.js          # logique de segmentation, testable en Node
workflows/scripts/test-segmenter.js     # script de test contre les vrais CSV
```

## Sécurité

- Ne commite jamais `.env`, `data/imports/**/*.csv` ni `data/output/**/*.csv`
  (déjà dans `.gitignore`) — ce sont des données personnelles de membres du club.
- `N8N_ENCRYPTION_KEY` chiffre les credentials stockés par n8n (dont la clé
  Brevo) : si tu la perds ou la changes, les credentials existants deviennent
  illisibles et devront être recréés.

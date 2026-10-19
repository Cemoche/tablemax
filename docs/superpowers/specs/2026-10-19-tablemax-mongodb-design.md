# TableMax — MongoDB, première version (lecture seule)

Date : 2026-10-19 · Statut : à valider · Epic : #7 · Spec parente : `2026-10-16-tablemax-design.md`

## 1. Intention et pourquoi

Ajouter MongoDB à TableMax pour qu'un utilisateur puisse **lire une base Mongo** dans le même
outil que ses bases SQL : se connecter, parcourir les bases et les collections, voir les
documents, les filtrer, ouvrir un document en entier et voir les index.

- **Pourquoi** (Cem) : élargir TableMax au-delà du SQL ; Cem n'utilise pas Mongo lui-même, la
  cible est « un utilisateur qui veut lire sa base, tout simplement ».
- **Succès** : quelqu'un qui a une base Mongo (locale, sur un serveur via SSH, ou hébergée sur
  Atlas avec une URI `mongodb+srv://`) la connecte, retrouve une collection avec `Ctrl+P`,
  filtre les documents, en ouvre un, et voit les index — avec les mêmes gestes, raccourcis et
  garanties de sécurité que pour PostgreSQL ou MySQL.
- C'est aussi le premier moteur non SQL : il pose la **couche « capacités »** que Redis (#6)
  réutilisera (voir `docs/notes/team-setup.md` et l'epic #6).

## 2. Objectifs

### Connexion
- Nouveau driver « MongoDB » dans le formulaire de connexion.
- Deux façons de saisir : les champs habituels (hôte, port 27017, utilisateur, base) ou une
  **URI** `mongodb://…` / `mongodb+srv://…` collée (import d'URL existant étendu à ces deux
  schémas ; l'export d'URL ne met jamais le mot de passe).
- Authentification par utilisateur / mot de passe (SCRAM, le mécanisme par défaut du serveur).
  Base d'authentification : `admin` par défaut, modifiable (`authSource`).
- Mot de passe : trousseau ou « demander à chaque fois », comme les autres drivers. **Un mot de
  passe présent dans une URI collée n'est jamais enregistré avec la connexion** : il est
  proposé pour le trousseau (l'URI elle-même n'est pas stockée, voir §4).
- TLS et tunnel SSH, comme les autres drivers (détails §4).
- Tag d'environnement, couleur et groupe comme les autres connexions.

### Parcourir
- Barre latérale : les **bases Mongo jouent le rôle des schémas** (même sélecteur que MySQL), et
  sous la base choisie les **collections** (comme des tables) et les **vues** (comme des vues),
  avec un nombre de documents estimé.
- Palette `Ctrl+P` / `Ctrl+K` : trouve les collections et les vues, comme les tables.
- Restauration de session : les onglets de collection reviennent comme les onglets de table.

### Onglet collection
- Les documents dans la **grille existante**, une ligne par document :
  - colonnes = les champs de premier niveau, `_id` en premier ; un champ absent d'un document
    est une cellule vide distincte de `null` ;
  - objets et tableaux imbriqués : JSON compact sur une ligne, comme les colonnes JSON SQL ;
  - correspondance des types BSON au §4.
- **Pagination** avec la taille de page des réglages, **tri** par clic sur l'en-tête de colonne
  (un champ, ascendant ou descendant), **nombre de documents** (estimé sans filtre, exact avec un
  filtre jusqu'au seuil des réglages, au-delà « plus de N »).
- **Filtre** : une barre où l'on tape un filtre de requête Mongo, par exemple
  `{ "status": "paid", "total": { "$gt": 100 } }`, validé par Entrée ; erreur de syntaxe
  affichée sous la barre sans requête envoyée. La syntaxe acceptée est au §4.
- **Détail du document** (`Ctrl+I`, le panneau de détail existant) : le document entier, indenté
  et coloré, chargé en entier depuis le serveur s'il a été tronqué dans la grille.
- **Copier** : une cellule, une ligne en JSON, le document entier en JSON (Extended JSON relaxed).
- Onglet **Structure** (`Alt+2`) : la liste des **index** (nom, clés, unique, sparse, TTL, filtre
  partiel) et les options de la collection utiles à la lecture (capped, validateur en JSON).
  Pas de DDL.

### Tests et démo
- MongoDB dans la stack de test (`docker-compose.test.yml`), avec authentification, une variante
  TLS et un accès à travers le sshd de test, comme PostgreSQL et MySQL ; testé en CI.
- `pnpm demo:db` ajoute une base Mongo `shop` (clients, commandes avec sous-documents et
  tableaux) et une connexion « Demo · MongoDB ».

## 3. Non-objectifs et anti-objectifs

### Non-objectifs de cette version (plus tard si le besoin existe)
- **Toute écriture** : insérer, modifier, supprimer des documents, créer ou supprimer des
  collections ou des index. Pas de panneau « modifications en attente » pour Mongo.
- Pipelines d'agrégation, shell Mongo, onglet de requête libre, `explain`.
- Projection personnalisée, tri sur plusieurs champs, analyse de schéma, GridFS, change streams,
  utilisateurs et rôles, import / export de fichiers.
- Authentification X.509, LDAP, Kerberos, AWS IAM, OIDC ; certificat client TLS.
- Helpers du shell dans les filtres (`ObjectId("…")`, `ISODate("…")`) : on utilise la forme
  Extended JSON (`{"$oid": "…"}`, `{"$date": "…"}`).
- Import des connexions Mongo depuis un export TablePlus.

### Anti-objectifs (échec même si « ça marche »)
- **TableMax écrit dans une base Mongo.** Aucune commande d'écriture n'existe côté Mongo dans
  cette version ; la couche de capacités le garantit aussi côté interface (pas de bouton
  d'édition, pas de `Ctrl+S` qui fait quelque chose).
- Un mot de passe se retrouve dans `app.db`, dans une URI enregistrée, dans un message d'erreur
  ou dans les logs.
- L'interface gèle sur une grosse collection ou un gros document (jusqu'à 16 Mo) : les requêtes
  restent asynchrones et annulables, les cellules sont tronquées comme aujourd'hui.
- Les drivers SQL régressent : toute la suite existante reste verte, et l'interface SQL ne
  change pas pour l'utilisateur.
- Une dépendance tire `aws-lc` ou OpenSSL (règle du projet : rustls avec `ring` uniquement).

## 4. Le comment déjà décidé

### Ce qui a été tranché avec Cem
- Lecture seule pour commencer ; le périmètre ci-dessus.

### Choix de Claude (à relire)
- **Bibliothèque** : crate officiel `mongodb` 3.x avec `default-features = false` et les
  features `compat-3-0-0`, `rustls-tls`, `dns-resolver`. Vérifié le 2026-10-19 sur 3.9.1 :
  `rustls` avec `ring`, aucun `aws-lc` ni OpenSSL dans l'arbre de dépendances.
- **Modèle** : base Mongo = schéma TableMax, collection = table, vue = vue. On réutilise ainsi la
  barre latérale, le sélecteur de schéma, la palette, le catalogue, les onglets et la
  restauration de session sans les réécrire.
- **Couche de capacités** : chaque session déclare ce qu'elle sait faire, et l'interface
  s'appuie sur ces capacités au lieu de supposer du SQL partout. Au minimum : éditeur SQL
  (non pour Mongo), édition de la grille (non), routines (non), DDL (non), type de filtre (SQL
  ou requête de documents), changement de base PostgreSQL (non). Les drivers SQL déclarent leurs
  capacités actuelles, sans changement de comportement. La forme exacte (méthodes du trait,
  trait séparé pour les sessions « documents », champ dans `WorkspaceInfo`) est laissée au
  constructeur, avec une contrainte : le cycle de vie commun du `SessionManager` (secrets,
  trousseau, tunnel SSH, annulation, connexion perdue, tag d'environnement) sert Mongo tel quel.
- **Correspondance des types BSON** vers les valeurs de cellule existantes (`value.rs`) :
  - String → `Text` / `LongText` (même troncature) ; Boolean → `Bool` ; Null → `Null` ;
  - Int32 / Int64 → `Int`, ou `BigInt` au-delà de 2^53 ; Double → `Float` ;
    Decimal128 → `Decimal` ;
  - DateTime → `Temporal` (ISO 8601 UTC) ; ObjectId → texte hexadécimal (24 caractères) ;
  - Binary → `Bytes` (UUID en texte) ;
  - Document et Array → `Json` (Extended JSON relaxed, même plafond que le JSON SQL) ;
  - autres types (Timestamp, Regex, MinKey, MaxKey, Code, Symbol, DBPointer, Undefined) → texte
    de leur forme Extended JSON canonique ;
  - champ absent → un état « absent » distinct de `Null` (le constructeur choisit comment le
    représenter, mais la grille ne doit pas afficher `NULL` pour un champ qui n'existe pas).
- **Colonnes** : à l'ouverture de l'onglet, les champs de premier niveau d'un échantillon des
  100 premiers documents (ordre naturel), `_id` en premier puis dans l'ordre de première
  apparition ; un champ rencontré plus tard sur une page est ajouté à la fin. Les colonnes ne
  disparaissent pas en changeant de page.
- **Syntaxe du filtre** : JSON avec la tolérance de JSON5 (clés sans guillemets, guillemets
  simples, virgules finales), interprété en **Extended JSON relaxed** (`{"$oid": …}`,
  `{"$date": …}`, `{"$numberLong": …}`). Vide = tous les documents. Le filtre doit être un
  objet. Les opérateurs exécutant du code côté serveur (`$where`, `$function`, `$accumulator`)
  sont refusés avec un message clair.
- **Pagination** : `skip` / `limit`. Le tri de la grille ajoute `_id` en second critère pour un
  ordre stable entre les pages.
- **Annulation** : comme les autres drivers, le bouton Annuler arrête l'attente immédiatement
  (abandon de la requête côté client, le curseur est fermé) ; côté serveur, chaque lecture porte
  un `maxTimeMS` pour qu'aucune requête abandonnée ne tourne indéfiniment.
- **TLS** : celui du crate `mongodb` (rustls + `ring`). Vérifié dans les sources 3.9.1 : avec
  rustls, il ne sait pas vérifier un certificat sans vérifier le nom d'hôte, se connecte
  toujours au nom qu'il vérifie (pas d'équivalent de notre `ConnectParams::dial`), et utilise
  les racines Mozilla ou, à la place, le fichier CA. D'où :
  - modes proposés pour Mongo : `disable`, `require` (TLS sans vérification du certificat),
    `verify-full` (tout vérifié). **Pas de `verify-ca`** (même situation que MySQL aujourd'hui)
    et pas de `prefer` (Mongo n'a pas de TLS opportuniste) ;
  - défaut : `verify-full` pour un hôte distant en direct, `disable` en local ou à travers un
    tunnel SSH ; `mongodb+srv://` impose TLS (`verify-full` par défaut) ;
  - racines : celles de Mozilla, ou le fichier CA s'il est donné. **Écart assumé** avec les
    drivers SQL (qui lisent d'abord les certificats du système) : un serveur signé par une CA
    d'entreprise demande le fichier CA ; le README le dit. Pas de certificat client.
- **SSH** : le tunnel générique existant vers `hôte:port`, avec une connexion directe au
  serveur. Le crate vérifie alors le nom `127.0.0.1` : à travers SSH, TLS est limité à
  `disable` (défaut) ou `require` ; `verify-full` à travers SSH est refusé avec un message clair
  (le tunnel chiffre et authentifie déjà le chemin jusqu'au serveur SSH). Une URI
  `mongodb+srv://`, plusieurs hôtes ou un `replicaSet` ne sont pas joignables par tunnel dans
  cette version : refus avec un message clair qui explique pourquoi. (Écarté pour l'instant :
  un relais TLS maison, ou un proxy SOCKS5 au-dessus du tunnel SSH ; à rouvrir si le besoin
  « Atlas à travers un bastion » apparaît.)
- **Topologie** : un seul hôte saisi → **connexion directe** à cet hôte (pas de découverte du
  replica set, dont les membres annoncent souvent des noms internes injoignables depuis le
  poste) ; découverte du replica set seulement pour `mongodb+srv://`, plusieurs hôtes ou un
  `replicaSet` donné. Préférence de lecture `primaryPreferred`, pour lire même sur un membre
  secondaire ou quand le primaire est indisponible.
- **Enregistrement** : pas d'URI brute dans `app.db`. Une URI collée est découpée en champs
  typés : les champs actuels (hôte, port, utilisateur, base, TLS) plus des réglages Mongo
  optionnels : `srv` (oui/non), `authSource`, `replicaSet`, hôtes supplémentaires. Options de
  l'URI :
  - comprises et reprises : `tls` / `ssl`, `tlsCAFile`, `authSource`, `replicaSet`,
    `directConnection` ;
  - hors périmètre qui changeraient l'accès (`authMechanism` autre que SCRAM,
    `tlsCertificateKeyFile` et autres options de certificat client, `tlsInsecure`,
    `tlsAllowInvalidHostnames`) : **import refusé**, avec la liste des options en cause ;
  - toutes les autres (`appName`, `retryWrites`, `w`, `readPreference`, délais…) : ignorées, et
    listées dans l'avertissement de l'import ;
  - le mot de passe éventuel n'est jamais enregistré dans la config (trousseau ou « demander ») ;
  - l'export d'URL reconstruit une URI à partir des champs, sans mot de passe.
- **Charger un document entier** par son `_id` typé (ObjectId, nombre, chaîne…), pas par sa
  forme affichée dans la grille.

## 5. Laissé au constructeur

- La forme exacte de la couche de capacités et des commandes Tauri pour les documents (nouvelles
  commandes ou extension de `table_page` / `table_count`), dans le respect de la règle « une
  commande = `commands.rs` + `lib.rs` + `ipc.ts` + `types.ts` + `types.shape.test.ts` ».
- Comment l'onglet de table choisit sa variante « documents » (barre de filtre JSON au lieu de
  la barre SQL, pas de panneau de modifications, Structure sans DDL ni clés étrangères).
- La représentation du « champ absent », le plafond exact des JSON en cellule, la valeur de
  `maxTimeMS`.
- Les versions de MongoDB testées (au minimum 7.0 en standalone ; 8.0 si le coût CI reste
  raisonnable). La découverte de replica set peut être couverte par des tests unitaires de
  construction des options plutôt que par un replica set dans la stack de test.
- Le comportement quand l'utilisateur n'a pas le droit de lister les bases (repli sur la base
  de la connexion), les comptes sur les vues, les formats de copie.
- Le découpage en tâches, une issue GitHub par tâche, rattachées à l'epic #7.

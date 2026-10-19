# TableMax — MongoDB : feuille de route vers la parité Compass, et étape 1 « Lecture »

Date : 2026-10-19 · Statut : à valider · Epic : #7 · Spec parente : `2026-10-16-tablemax-design.md`
Référence fonctionnelle : `docs/research/2026-10-19-mongodb-compass-analysis.md` (inventaire de
MongoDB Compass 1.53.0, 138 fonctionnalités, identifiants C1…, D1…, etc.).

## 1. Intention et pourquoi

Ajouter MongoDB à TableMax avec **au moins les fonctionnalités de MongoDB Compass**, le client
officiel et gratuit de MongoDB.

- **Pourquoi** (Cem) : élargir TableMax au-delà du SQL. Cem n'utilise pas Mongo lui-même ; la
  cible est « un utilisateur pour lire la base, tout simplement », puis tout ce que fait Compass.
- **Référence** : Compass (Cem : « c'est officiel, gratuit, je veux au moins les mêmes
  features »). Compass est sous licence SSPL : il sert à **comprendre** les fonctionnalités, comme
  TablePlus ; aucun code, texte d'interface ou asset n'en est repris.
- **Succès de l'étape 1** : quelqu'un qui a une base Mongo (locale, sur un serveur via SSH, ou
  hébergée sur Atlas avec une URI `mongodb+srv://`) la connecte, retrouve une collection avec
  `Ctrl+P`, l'interroge avec la barre de requête, lit les documents en table, en JSON ou en
  arbre, comprend une requête lente avec explain, voit index et règles de validation, et exporte
  un résultat — avec les mêmes gestes et garanties que pour PostgreSQL ou MySQL. En gros : ce que
  fait l'édition « readonly » de Compass.
- C'est aussi le premier moteur non SQL : il pose la **couche « capacités »** que Redis (#6)
  réutilisera (voir `docs/notes/team-setup.md` et l'epic #6).

## 2. Feuille de route (validée par Cem le 2026-10-19)

Chaque étape est utilisable seule, a sa propre conception courte (sauf l'étape 1, décrite ici),
son plan et ses issues rattachées à l'epic #7.

| # | Étape | Contenu principal (identifiants de l'inventaire Compass entre parenthèses quand utile) |
|---|---|---|
| 1 | **Lecture** (≈ Compass readonly) | Connexion complète (URI ↔ formulaire, SCRAM et LDAP, TLS, SSH, options avancées) ; arbre avec statistiques ; barre de requête complète ; vues table, JSON et arbre ; tous les types BSON ; historique et favoris de requêtes ; copie Shell / Extended JSON ; index avec usage ; règles de validation ; explain (résumé et brut) ; export JSON / CSV. Détails §3. |
| 2 | **Écriture**, sous un safe mode Mongo à 3 niveaux | Insérer, modifier (y compris le type d'un champ), cloner, supprimer des documents ; mises à jour et suppressions en masse avec aperçu ; créer / supprimer / renommer bases et collections (options time-series, clustered, collation) ; créer / supprimer / masquer des index ; éditer la validation ; import JSON / CSV. Les 3 niveaux reprennent le modèle Compass : lecture seule, écriture des données, tout (index et suppression de collections). |
| 3 | **Agrégations** | Éditeur étape par étape et mode texte, aperçus par étape, pipelines sauvegardés, création de vue, export des résultats, export de requête / pipeline vers 8 langages. |
| 4 | **Analyse** | Analyse de schéma (échantillon, types, fréquences, graphiques, carte sans tuiles distantes), export JSON Schema, génération des règles de validation ; explain en arbre visuel ; onglet Performance (graphiques `serverStatus`, collections les plus actives, opérations lentes, Kill Op **protégé par le safe mode**). |
| 5 | **Compléments** | Authentification X.509 (certificat client), Kerberos, AWS IAM, OIDC ; proxy SOCKS5 ; import / export de connexions ; shell (lancer le `mongosh` installé dans un terminal intégré) ; modélisation de données (à fusionner avec l'epic diagrammes ER #9). |
| — | **Exclu** | Tout ce qui dépend du cloud ou envoie des données hors de la base (règles du projet) : IA (requêtes, pipelines, explain, données factices, assistant), télémétrie, mises à jour automatiques de Compass, fonctions Atlas (index roulants, Global Writes, liens Atlas). Chiffrement In-Use (CSFLE / Queryable Encryption) : reporté sans date (dépend de libmongocrypt). |

## 3. Étape 1 « Lecture » : objectifs

### Connexion
- Nouveau driver « MongoDB » dans le formulaire de connexion, avec les réglages habituels (nom,
  couleur, groupe, tag d'environnement).
- **URI et formulaire synchronisés** : un champ URI `mongodb://…` / `mongodb+srv://…` éditable,
  tenu à jour avec les champs (hôte(s), port 27017, utilisateur, base, TLS, options), dans les
  deux sens ; l'URI affichée ne contient jamais le mot de passe. L'import d'URL et « Copier l'URL »
  existants gèrent les deux schémas.
- **Authentification** : utilisateur / mot de passe avec SCRAM (mécanisme par défaut, ou
  SCRAM-SHA-1 / SCRAM-SHA-256 explicite) et LDAP (`PLAIN`, base `$external`). Base
  d'authentification `admin` par défaut, modifiable. Mot de passe : trousseau ou « demander à
  chaque fois » ; **un mot de passe présent dans une URI collée n'est jamais enregistré avec la
  connexion** (il est proposé pour le trousseau).
- **TLS, tunnel SSH, topologie** : voir §5.
- **Options avancées** : préférence de lecture (et ses tags, `maxStalenessSeconds`), nom
  d'application, délais (connexion, sélection du serveur, socket, heartbeat), taille du pool,
  `retryReads`. Liste exacte au §5.

### Parcourir
- Barre latérale : les **bases Mongo jouent le rôle des schémas** (même sélecteur que MySQL), et
  sous la base choisie les **collections** (comme des tables) et les **vues** (comme des vues),
  avec un nombre de documents estimé. Statistiques de base (taille, nombre de collections) et de
  collection (documents, taille des données, taille moyenne, stockage, nombre et taille des
  index, capped ou non) visibles sans ouvrir d'onglet.
- Si l'utilisateur n'a pas le droit de lister les bases, la liste vient de ses privilèges
  (`connectionStatus`) ou, à défaut, de la base de la connexion.
- Palette `Ctrl+P` / `Ctrl+K` : trouve les collections et les vues ; restauration de session des
  onglets de collection comme pour les tables.

### Onglet collection
- **Barre de requête** : filtre, projection, tri, collation, hint (nom d'index ou clés), skip,
  limit, `maxTimeMS` ; les options au-delà du filtre sont repliées par défaut. Entrée ou
  « Rechercher » exécute ; « Réinitialiser » vide. Erreur de syntaxe affichée sous le champ
  concerné, sans requête envoyée. **Autocomplétion** dans le filtre, la projection et le tri :
  noms de champs (de l'échantillon) et opérateurs de requête. Le clic sur un en-tête de colonne
  met à jour le tri de la barre.
- **Historique et favoris** de requêtes par collection : les 20 dernières requêtes exécutées
  (sans doublon) et des favoris nommés, rappelables en un clic, effaçables.
- **Trois vues** du résultat, au choix dans la barre d'outils de l'onglet, mémorisé par onglet :
  - **Table** : la grille existante, une ligne par document (colonnes au §5) ;
  - **JSON** : chaque document en Extended JSON relaxed, indenté et coloré, en lecture seule ;
  - **Arbre** : chaque document dépliable champ par champ, avec le type BSON de chaque valeur.
  Les trois sont virtualisées : l'interface ne gèle pas sur une page de gros documents.
- **Pagination** avec la taille de page des réglages ; **nombre de documents** asynchrone
  (estimé sans filtre, exact avec un filtre jusqu'au seuil des réglages, au-delà « plus de N »).
- **Tous les types BSON** affichés fidèlement (correspondance au §5), y compris UUID.
- **Menu contextuel d'une valeur** : filtrer par cette valeur (ajoute la condition au filtre),
  copier la valeur, copier le chemin du champ.
- **Copier un document** en Extended JSON relaxed, en Extended JSON canonique ou en syntaxe du
  shell (`ObjectId("…")`, `ISODate("…")`).
- **Détail du document** (`Ctrl+I`) : le document entier, chargé depuis le serveur s'il a été
  tronqué.
- **Explain** : bouton de la barre de requête ; lance un `explain` en mode `executionStats` de la
  requête courante et affiche un **résumé** (documents renvoyés et examinés, clés examinées,
  durée, index utilisé ou parcours complet de la collection signalé, tri en mémoire) et la
  **sortie brute**.
- **Export** du résultat de la requête courante (filtre, projection, tri) : tous les documents
  correspondants ou la page affichée, en **JSON** (tableau Extended JSON relaxed ou canonique) ou
  en **CSV** (choix des champs ; champs imbriqués aplatis en chemins `a.b.c`, tableaux en JSON),
  vers un fichier choisi dans une boîte de dialogue ; en flux, avec progression et annulation.
- Onglet **Structure** (`Alt+2`) :
  - **index** : nom, clés, type, propriétés (unique, sparse, TTL, partiel, caché, collation),
    taille, **usage** (nombre d'accès et depuis quand) ;
  - **validation** : règles du validateur (JSON), niveau et action ;
  - options de la collection (capped, taille max, time-series, collation, vue : collection
    source et pipeline). Pas de DDL ni de clés étrangères.

### Tests et démo
- MongoDB dans la stack de test (`docker-compose.test.yml`), avec authentification, une variante
  TLS et un accès à travers le sshd de test ; testé en CI comme PostgreSQL et MySQL.
- `pnpm demo:db` ajoute une base Mongo `shop` (clients, commandes avec sous-documents et
  tableaux, une vue, des index dont un TTL et un partiel, un validateur) et une connexion
  « Demo · MongoDB ».

## 4. Non-objectifs et anti-objectifs de l'étape 1

### Non-objectifs (étapes suivantes ou exclus, §2)
- **Toute écriture** (étape 2) : documents, collections, bases, index, validation, import. Pas de
  panneau « modifications en attente » pour Mongo.
- Agrégations, export vers un langage (étape 3) ; analyse de schéma, explain visuel,
  Performance, Kill Op (étape 4) ; X.509 et certificat client, Kerberos, AWS, OIDC, SOCKS5,
  shell, modélisation (étape 5).
- Helpers du shell **dans la saisie** des filtres (`ObjectId("…")` tapé) : on saisit la forme
  Extended JSON (`{"$oid": "…"}`) ; la copie en syntaxe shell, elle, existe.
- Import des connexions Mongo depuis un export TablePlus.

### Anti-objectifs (échec même si « ça marche »)
- **TableMax écrit dans une base Mongo à l'étape 1.** Aucune commande d'écriture n'existe côté
  Mongo ; la couche de capacités le garantit aussi côté interface (pas de bouton d'édition, pas
  de `Ctrl+S` actif). `explain` ne lance que des lectures.
- Un mot de passe se retrouve dans `app.db`, dans une URI affichée ou copiée, dans l'historique,
  dans un message d'erreur ou dans les logs.
- L'interface gèle (grosse collection, document de 16 Mo, export de millions de documents) :
  requêtes asynchrones, annulables, résultats et exports en flux.
- Une donnée part ailleurs que vers la base de l'utilisateur (télémétrie, service d'IA, tuiles de
  carte…).
- Les drivers SQL régressent : toute la suite existante reste verte, l'interface SQL ne change
  pas pour l'utilisateur.
- Une dépendance tire `aws-lc` ou OpenSSL (règle du projet : rustls avec `ring` uniquement).

## 5. Le comment déjà décidé

### Avec Cem
- Parité Compass comme objectif, feuille de route du §2, exclusions du §2, étape 1 en lecture
  seule.

### Choix de Claude (à relire)
- **Bibliothèque** : crate officiel `mongodb` 3.x, `default-features = false`, features
  `compat-3-0-0`, `rustls-tls`, `dns-resolver`. Vérifié le 2026-10-19 sur 3.9.1 : `rustls` avec
  `ring`, ni `aws-lc` ni OpenSSL dans l'arbre de dépendances. Toute feature ajoutée plus tard
  refait cette vérification.
- **Modèle** : base Mongo = schéma TableMax, collection = table, vue = vue. On réutilise la barre
  latérale, le sélecteur de schéma, la palette, le catalogue, les onglets et la restauration de
  session.
- **Couche de capacités** : chaque session déclare ce qu'elle sait faire et l'interface s'appuie
  sur ces capacités au lieu de supposer du SQL. Au minimum : éditeur SQL (non pour Mongo),
  édition de la grille (non), routines (non), DDL (non), langage de requête de l'onglet (SQL ou
  requête de documents), changement de base PostgreSQL (non). Les drivers SQL déclarent leurs
  capacités actuelles sans changement de comportement. Contrainte : le cycle de vie commun du
  `SessionManager` (secrets, trousseau, tunnel SSH, annulation, connexion perdue, tag
  d'environnement) sert Mongo tel quel.
- **Correspondance des types BSON** vers les valeurs de cellule (`value.rs`), pour la vue table :
  - String → `Text` / `LongText` (même troncature) ; Boolean → `Bool` ; Null → `Null` ;
  - Int32 / Int64 → `Int`, ou `BigInt` au-delà de 2^53 ; Double → `Float` ;
    Decimal128 → `Decimal` ;
  - DateTime → `Temporal` (ISO 8601, UTC) ; ObjectId → texte hexadécimal (24 caractères) ;
  - Binary → `Bytes`, sauf sous-type 4 (UUID) affiché comme UUID ;
  - Document et Array → `Json` (Extended JSON relaxed, même plafond que le JSON SQL) ;
  - autres types (Timestamp, Regex, MinKey, MaxKey, Code, Symbol, DBPointer, Undefined) → texte
    de leur forme Extended JSON canonique ;
  - champ absent → un état « absent » distinct de `Null` (la grille n'affiche pas `NULL` pour un
    champ qui n'existe pas).
  Les vues JSON et arbre affichent les valeurs BSON elles-mêmes (Extended JSON), sans passer par
  cette correspondance.
- **Colonnes de la vue table** : à l'ouverture, les champs de premier niveau d'un échantillon
  des 100 premiers documents (ordre naturel), `_id` en premier puis dans l'ordre de première
  apparition ; un champ rencontré plus tard est ajouté à la fin ; les colonnes ne disparaissent
  pas en changeant de page. Avec une projection, les colonnes suivent la projection. Le même
  échantillon nourrit l'autocomplétion des noms de champs.
- **Syntaxe de saisie** (filtre, projection, tri, collation, hint) : JSON avec la tolérance de
  JSON5 (clés sans guillemets, guillemets simples, virgules finales), interprété en Extended JSON
  relaxed (`{"$oid": …}`, `{"$date": …}`, `{"$numberLong": …}`). Chaque champ doit être un objet
  (le hint peut aussi être un nom d'index). Les opérateurs qui exécutent du code côté serveur
  (`$where`, `$function`, `$accumulator`) sont refusés avec un message clair.
- **Pagination** : `skip` / `limit`. Sans tri de l'utilisateur, une collection est triée par
  `{_id: 1}` (index toujours présent : ordre stable entre les pages pour un coût nul) et une vue
  garde son ordre naturel. **Un tri donné par l'utilisateur est envoyé tel quel**, sans `_id`
  ajouté (qui empêcherait le serveur d'utiliser l'index de ce tri) : l'ordre des documents à
  égalité sur les clés du tri n'est alors pas garanti d'une page à l'autre, comme dans Compass.
  Le skip / limit de la barre de requête s'applique à la requête, la pagination se fait à
  l'intérieur. **Explain** analyse exactement la requête envoyée pour la page affichée.
- **Historique et favoris** : dans `app.db` (nouvelle table), par connexion + base + collection ;
  « Effacer l'historique » comme pour l'historique SQL.
- **Annulation** : le bouton Annuler arrête l'attente immédiatement (abandon côté client, curseur
  fermé) ; chaque lecture porte un `maxTimeMS` (celui de la barre de requête, sinon une valeur par
  défaut) pour qu'aucune requête abandonnée ne tourne indéfiniment côté serveur.
- **TLS** : celui du crate `mongodb` (rustls + `ring`). Vérifié dans les sources 3.9.1 : avec
  rustls, il ne sait pas vérifier un certificat sans vérifier le nom d'hôte, se connecte toujours
  au nom qu'il vérifie (pas d'équivalent de notre `ConnectParams::dial`), et utilise les racines
  Mozilla ou, à la place, le fichier CA. D'où :
  - modes proposés pour Mongo : `disable`, `require` (TLS sans vérification du certificat),
    `verify-full` (tout vérifié). Pas de `verify-ca` (même situation que MySQL aujourd'hui) ni de
    `prefer` (Mongo n'a pas de TLS opportuniste) ;
  - dans l'URI : `disable` ↔ `tls=false` ; `verify-full` ↔ `tls=true` ; `require` ↔
    `tls=true&tlsAllowInvalidCertificates=true` (écrit ainsi par TableMax ; à la lecture,
    `tlsInsecure=true` donne aussi `require`). `tlsAllowInvalidHostnames` seul (certificat vérifié
    sans le nom, impossible avec rustls) est refusé ;
  - défaut : `verify-full` pour un hôte distant en direct, `disable` en local ou à travers un
    tunnel SSH ; `mongodb+srv://` impose TLS (`verify-full` par défaut) ;
  - racines : celles de Mozilla, ou le fichier CA s'il est donné. Écart assumé avec les drivers
    SQL (qui lisent d'abord les certificats du système) : un serveur signé par une CA
    d'entreprise demande le fichier CA ; le README le dit. Pas de certificat client à l'étape 1.
- **SSH** : le tunnel générique existant vers `hôte:port`, avec une connexion directe. Le crate
  vérifie alors le nom `127.0.0.1` : à travers SSH, TLS est limité à `disable` (défaut) ou
  `require` ; `verify-full` à travers SSH est refusé avec un message clair (le tunnel chiffre et
  authentifie déjà le chemin jusqu'au serveur SSH). `mongodb+srv://`, plusieurs hôtes ou un
  `replicaSet` ne sont pas joignables par tunnel : refus avec un message qui explique pourquoi.
  (Écartés pour l'instant : un relais TLS maison ou un proxy SOCKS5 au-dessus du tunnel ; le
  SOCKS5 revient à l'étape 5.)
- **Topologie** : un seul hôte saisi → connexion directe à cet hôte (les membres d'un replica set
  annoncent souvent des noms internes injoignables depuis le poste) ; découverte du replica set
  seulement pour `mongodb+srv://`, plusieurs hôtes ou un `replicaSet` donné. Préférence de lecture
  par défaut `primaryPreferred`, sauf si la connexion en précise une.
- **Enregistrement** : pas d'URI brute dans `app.db`. La connexion garde ses champs typés (hôte,
  port, utilisateur, base, TLS) plus des réglages Mongo : `srv`, hôtes supplémentaires,
  `authSource`, mécanisme d'authentification (SCRAM par défaut, SCRAM-SHA-1, SCRAM-SHA-256,
  PLAIN), `replicaSet`, et une liste d'**options avancées autorisées** (clé / valeur) :
  `readPreference`, `readPreferenceTags`, `maxStalenessSeconds`, `appName`, `connectTimeoutMS`,
  `serverSelectionTimeoutMS`, `socketTimeoutMS`, `heartbeatFrequencyMS`, `localThresholdMS`,
  `maxPoolSize`, `minPoolSize`, `maxIdleTimeMS`, `retryReads`, `directConnection`. Pour une URI
  collée ou tapée :
  - options ci-dessus et `tls` / `ssl`, `tlsCAFile`, `tlsAllowInvalidCertificates`,
    `tlsInsecure` (voir TLS) : reprises ;
  - options qui changeraient l'accès et relèvent des étapes suivantes (`authMechanism` hors
    SCRAM / PLAIN, `authMechanismProperties`, `tlsCertificateKeyFile` et autres options de
    certificat client, `tlsAllowInvalidHostnames`, `proxyHost`…, options de chiffrement) :
    **refusées**, avec la liste des options en cause ;
  - toutes les autres (`retryWrites`, `w`, `journal`, `compressors`…) : ignorées et listées dans
    un avertissement.
- **Base d'authentification** : comme le standard des URI MongoDB, `authSource` s'il est
  donné, sinon la base écrite dans l'URI, sinon `admin` (et `$external` pour LDAP). Elle est
  enregistrée dans son propre champ, toujours écrite explicitement dans l'URI générée ; le champ
  « base » de la connexion n'est que la base sélectionnée à l'ouverture.
- **LDAP sans TLS** envoie le mot de passe en clair : autorisé (serveurs internes), avec un
  avertissement dans le formulaire.
- **Versions de serveur** : le crate 3.9.1 refuse les serveurs antérieurs à MongoDB 4.4 ; le
  README le dit, et l'erreur de connexion l'explique.
- **Visibilité pendant la construction** : tant que l'étape 1 n'est pas complète, le driver
  MongoDB n'apparaît dans le formulaire que si un réglage expérimental est activé (désactivé par
  défaut, donc absent des releases) ; la dernière tâche de l'étape retire ce réglage. Chaque
  tâche mergée respecte malgré tout les anti-objectifs (pas d'écriture, pas de secret exposé,
  pas de gel).
- **Charger un document entier** par son `_id` typé (ObjectId, nombre, chaîne…), pas par sa forme
  affichée.
- **Export** : le fichier est écrit par le backend (boîte de dialogue ouverte depuis Rust, comme
  `commands::file_pick`, sans permission Tauri supplémentaire), document par document.

## 6. Laissé au constructeur

- La forme exacte de la couche de capacités et des commandes Tauri pour les documents, dans le
  respect de la règle « une commande = `commands.rs` + `lib.rs` + `ipc.ts` + `types.ts` +
  `types.shape.test.ts` ».
- Comment l'onglet de table choisit sa variante « documents » (barre de requête Mongo au lieu de
  la barre de filtres SQL, pas de panneau de modifications, Structure adaptée).
- Le composant des vues JSON et arbre, la représentation du « champ absent », le plafond exact
  des JSON en cellule, la valeur par défaut de `maxTimeMS`, l'emplacement des statistiques
  (infobulles, en-tête de l'onglet Structure…).
- Les versions de MongoDB testées (au minimum 7.0 en standalone ; 8.0 si le coût CI reste
  raisonnable). La découverte de replica set et le LDAP peuvent être couverts par des tests
  unitaires de construction des options plutôt que par des services dans la stack de test.
- Les comptes sur les vues, la présentation de l'explain, l'ordre des tâches.
- Le découpage en tâches, une issue GitHub par tâche, rattachées à l'epic #7.

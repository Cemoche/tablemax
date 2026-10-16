# TableMax — document de conception (v1)

Date : 2026-10-16 · Statut : brouillon à valider

## 1. Intention et pourquoi

TableMax est un client de bases de données de bureau, gratuit, inspiré de TablePlus.

- **Pourquoi** : TablePlus convient à l'utilisateur sur le fond, mais les mises à jour passent par
  une licence payante annuelle, et rester sur une version non mise à jour fait craindre des failles
  de sécurité. TableMax doit être un outil à soi, maintenable et à jour.
- **Projet perso**, qui sert aussi de terrain d'essai pour REA (rétro-ingénierie). L'analyse de
  TablePlus est dans `docs/research/2026-10-16-tableplus-linux-analysis.md`. Elle sert uniquement
  à comprendre : aucun code, nom, icône ou asset de TablePlus n'est repris.
- **Succès v1** : l'utilisateur peut faire son travail quotidien sur MySQL/MariaDB (Magento),
  PostgreSQL et SQLite, y compris via un tunnel SSH, sans ouvrir TablePlus.

## 2. Objectifs v1

### Moteurs
MySQL, MariaDB, PostgreSQL, SQLite. L'architecture « driver » (trait Rust) doit permettre d'en
ajouter d'autres sans toucher à l'UI.

### Connexions
- Formulaire : nom, couleur, **tag d'environnement** (local / dev / staging / prod), driver,
  host/socket, port, user, mot de passe, base, options SSL (mode + fichiers clé/cert/CA).
- **Tunnel SSH** : host, port, user, authentification par mot de passe, clé privée (avec
  passphrase) ou agent SSH.
- **Secrets** (mots de passe DB, mots de passe SSH, passphrases) stockés **uniquement dans le
  trousseau de l'OS**, jamais en clair sur disque. Ils ne repassent jamais du backend vers le
  frontend une fois enregistrés.
- Boutons Test, Save, Connect ; groupes de connexions ; recherche dans la liste ; import et export
  d'une connexion sous forme d'URL (`mysql://…`, sans mot de passe).
- **Import de fichiers `.tableplusconnection`** (export de TablePlus) : l'utilisateur choisit le
  fichier et saisit le mot de passe d'export. Le fichier est déchiffré (RNCryptor v3, format
  public), puis un **aperçu** liste les connexions trouvées : on coche celles à importer, et les
  doublons sont signalés. Les mots de passe contenus vont directement dans le trousseau. Les champs
  non gérés (drivers hors v1, options inconnues) sont ignorés avec un avertissement, sans échec
  global. L'utilisateur n'a pas de fichier d'exemple : **le constructeur génère les fixtures**
  avec le TablePlus Linux installé (`/opt/tableplus`), en exportant des connexions factices
  (MySQL, MariaDB, PG, SQLite, avec et sans SSH/SSL, avec groupe), et déduit le schéma du contenu
  de cet export et de la décompilation REA de l'export/import (`connection_service_*`,
  `rn_cryptor_v3_*`, `export_connection_option_dialog`). Le schéma observé est consigné dans
  `docs/research/`.

### Navigation
- **Workspaces** : un par connexion ouverte, plusieurs en parallèle.
- **Onglets illimités** dans chaque workspace :
  - Onglet **aperçu** : un simple clic sur une table remplace l'onglet aperçu courant (titre en
    italique). Un double-clic, ou une modification, l'épingle.
  - **Ctrl+Tab** parcourt les onglets dans l'ordre d'utilisation récente (MRU).
  - **Recherche parmi les onglets ouverts**.
  - **Restauration de session** au redémarrage : workspaces, onglets et requêtes non sauvegardées.
    Les reconnexions se font à la demande, à l'activation de l'onglet.
- **Sidebar** des objets : bases/schémas → tables, vues, routines, avec filtre texte. Changement de
  base ou de schéma dans la connexion courante.
- **Palette de commandes (Ctrl+K)** unique : objets (tables, vues…), connexions, onglets ouverts
  **et** actions (nouvel onglet, safe mode, changer de base, réglages…), avec recherche floue.
  Ctrl+P ouvre la même palette, filtrée sur les objets.

### Données (grille)
- Grille virtualisée, pagination serveur (taille de page configurable, 300 par défaut), tri par
  colonne côté serveur, comptage total (estimé au-delà d'un seuil configurable).
- **Édition inline** (cellule, insertion de ligne, suppression, duplication). Les modifications
  restent en attente jusqu'au **Commit (Ctrl+S)** ou au **Discard**.
- **Panneau « modifications en attente »** : liste de chaque changement avec le SQL généré.
  On peut annuler un changement individuellement. Le commit exécute tout dans une transaction.
- Édition interdite (lecture seule, avec explication) sur une table sans clé primaire ni index
  unique, et sur les vues.
- Détail de ligne dans la sidebar droite (formulaire vertical, JSON mis en forme).
- **Navigation par clé étrangère** : une valeur FK a un lien qui ouvre la ligne référencée
  (filtrée) dans le même onglet. Un **fil d'Ariane** permet de revenir en arrière.
- **Filtres** :
  - Constructeur de filtres : colonne (ou « toutes colonnes »), opérateur (`=`, `<>`, `<`, `>`,
    `<=`, `>=`, `IN`, `NOT IN`, `BETWEEN`, `NOT BETWEEN`, `LIKE`, `NOT LIKE`, `ILIKE` (PG),
    contient, ne contient pas, `IS NULL`, `IS NOT NULL`, SQL brut), plusieurs conditions en AND.
  - **Barre de filtre rapide** : saisie libre de type `status = paid and total > 100`,
    transformée en conditions (et donc éditable ensuite dans le constructeur).
- Copie de la sélection (bonus v1) en TSV, CSV, JSON ou `INSERT` SQL.

### Structure (lecture seule en v1)
Colonnes (type, nullable, défaut, extra/commentaire), index, clés étrangères, DDL de la
table ou de la vue.

### Éditeur SQL
- Coloration et **complétion** (mots-clés, tables, colonnes de la base courante, alias simples).
- Exécution de la requête sous le curseur, de la sélection ou de tout l'éditeur. Plusieurs
  instructions donnent un onglet de résultat par instruction. Affichage du temps d'exécution et du
  nombre de lignes. **Annulation** de la requête en cours.
- LIMIT automatique optionnel sur les SELECT sans LIMIT.
- Formatage (beautify), commentaire/décommentaire, historique des requêtes exécutées, requêtes
  sauvegardées (fichiers `.sql` nommés par connexion).

### Sécurité par environnement / Safe mode
- La couleur du tag (prod = rouge…) **teinte la bordure et la barre de titre** du workspace.
- Niveaux de Safe mode par connexion : désactivé / confirmer toute requête / confirmer tout sauf
  `SELECT`/`EXPLAIN`/`SHOW`. Le niveau par défaut dépend du tag : **prod = confirmer les
  écritures**, sinon désactivé.
- Le safe mode s'applique aussi au **Commit** de la grille, avec affichage du SQL qui va partir.

### Réglages
Thème clair/sombre/système, police et taille de l'éditeur, taille de page, seuil de comptage
estimé, LIMIT auto, raccourcis clavier personnalisables.

## 3. Non-objectifs v1 (prévus plus tard)

Autres drivers (SQL Server, Redis, MongoDB, ClickHouse…), diagrammes ER, metrics boards, chat
IA, import/export de fichiers (CSV/JSON/SQL/Excel), backup/restore, gestion des utilisateurs,
liste des process, édition de structure (ALTER via UI), split view, plusieurs fenêtres,
mise à jour automatique, packaging macOS/Windows.

## 4. Anti-objectifs (échec même si « ça marche »)

- Un secret écrit en clair sur disque, dans les logs ou envoyé au frontend après enregistrement.
- Une écriture sur une base « prod » sans confirmation quand le safe mode est actif.
- Une UI qui gèle sur une grosse table ou une requête lente : tout I/O DB est asynchrone et
  annulable, et la grille est virtualisée.
- Du code, un nom, une icône ou un asset repris de TablePlus.
- Une app qui charge du contenu distant ou expose plus de permissions Tauri que nécessaire.

## 5. Contraintes

- **Stack imposée** : Tauri 2, React, TypeScript, Rust.
- **Plateformes** : Linux d'abord (développement et tests sur Ubuntu 26.04, Wayland). Le code doit
  rester portable vers macOS et Windows : pas d'API Linux-only hors abstraction.
- Gestionnaire de paquets JS : pnpm. Langue de l'UI : anglais (comme les outils du domaine),
  avec des chaînes centralisées pour une traduction future.
- Dépôt git local, branche `main` (projet perso, hors workflow ham05/Azure).

## 6. Choix techniques (mes choix, validés implicitement par l'utilisateur via « stack ok »)

| Sujet | Choix | Raison |
|---|---|---|
| Drivers | `tokio-postgres` (+ rustls), `mysql_async`, `rusqlite` (bundled) derrière un trait `Driver` | Contrôle fin : métadonnées de types, annulation (cancel token PG, `KILL QUERY` MySQL, `interrupt` SQLite) |
| SSH | `russh` (pur Rust) avec port forwarding local `direct-tcpip` | Portable, sans dépendance système |
| Trousseau | crate `keyring` (Secret Service / Keychain / Credential Manager) | Multi-OS |
| Stockage app | SQLite local dans le répertoire de données de l'app (connexions sans secrets, historique, requêtes, session) | Simple, transactionnel |
| Frontend | React + TS + Vite, Zustand, Tailwind + composants Radix/shadcn, `cmdk` pour la palette | Standard, rapide |
| Grille | Glide Data Grid (canvas) | Fluide sur gros volumes, édition intégrée |
| Éditeur | CodeMirror 6 + `@codemirror/lang-sql` | Léger, complétion extensible |
| IPC | Commandes Tauri + `Channel` pour streamer les résultats | Pas de blocage UI |
| Valeurs | Enum typée sérialisée (Null, Bool, Int en chaîne si > 2^53, Float, Decimal en chaîne, Text, Bytes avec aperçu hex, Json, Date/Time en chaîne ISO) | Aucune perte de précision |
| Tests | Rust : unitaires + intégration contre MySQL 8, MariaDB 11 et PostgreSQL 16 en Docker, SQLite en fichier temporaire. Front : Vitest | Bases réelles disponibles en local |

## 6 bis. Décisions prises par moi après relecture (à contester si besoin)

- **Sessions et transactions** : chaque onglet d'éditeur SQL a **sa propre connexion dédiée**.
  `BEGIN` puis `COMMIT` sur plusieurs exécutions, `USE`, `SET` et les tables temporaires persistent
  donc dans l'onglet. La navigation (grilles, sidebar, complétion) utilise un petit pool partagé
  par workspace. Fermer un onglet avec une transaction ouverte demande Commit ou Rollback. La
  restauration de session ne restaure pas les transactions. L'annulation passe par une connexion
  séparée (`KILL QUERY` MySQL, cancel token PG, `interrupt` SQLite).
- **Résultats de l'éditeur SQL en lecture seule en v1.** L'édition reste réservée aux onglets de
  table ; l'édition de résultats de requête viendra plus tard.
- **Vérification de la clé d'hôte SSH** contre `~/.ssh/known_hosts`. Pour un hôte inconnu,
  l'empreinte est affichée et l'utilisateur confirme ; elle est alors ajoutée à un `known_hosts`
  propre à l'app. **Un mismatch bloque la connexion.** Formats de clé : OpenSSH (y compris
  chiffrées) et PEM, en RSA, ECDSA et ed25519.
- **Alias `~/.ssh/config`** (réponse utilisateur) : le champ hôte SSH accepte un alias de
  `~/.ssh/config`, avec auto-complétion des alias. `HostName`, `User`, `Port` et `IdentityFile`
  sont lus depuis la config, et ce qui est saisi dans le formulaire prime. Pas de
  ProxyJump ni de bastion (non utilisés).
- **Versions de serveurs** (réponse utilisateur) : la v1 vise et teste MySQL 8, MariaDB 11 et
  PostgreSQL 16. **Ajouter une version doit être rapide** : la matrice de tests d'intégration est
  une simple liste d'images Docker (une ligne par version), et chaque driver détecte la version du
  serveur à la connexion. Les requêtes de métadonnées qui diffèrent sont isolées par version dans
  le driver.
- **Trousseau indisponible ou verrouillé** : message clair. Option par connexion « ne pas
  enregistrer, demander à chaque connexion », qui est aussi la solution de repli. Jamais de
  stockage en clair.
- **Packaging Linux v1** : `.deb` et AppImage via le bundler Tauri (pas de Flatpak en v1).

## 7. Laissé au constructeur

Structure exacte des dossiers et crates, design visuel détaillé (sobre, dense, proche des outils
du domaine), nom des commandes IPC, format des fichiers de session, stratégie de cache des
métadonnées pour la complétion, détails du parser de la barre de filtre rapide (grammaire
minimale : `col op valeur`, `and`, guillemets), raccourcis par défaut (inspirés des conventions
courantes : Ctrl+T, Ctrl+W, Ctrl+Enter, Ctrl+S…).

## 8. Prérequis à installer avant de construire

`libwebkit2gtk-4.1-dev` et les dépendances système Tauri 2 pour Ubuntu (absentes actuellement).
Node 22, pnpm 10, Rust 1.96 et Docker sont déjà présents.

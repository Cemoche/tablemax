# TableMax — MongoDB étape 1 « Lecture » — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lire une base MongoDB dans TableMax comme l'édition « readonly » de Compass : connexion complète, navigation, barre de requête, vues table / JSON / arbre, historique et favoris, structure (index, validation, statistiques), explain et export — sans aucune écriture.

**Architecture:** Backend : une couche de capacités sépare ce que toute session sait faire (`SessionBase` : lister, compter, annuler, fermer) du SQL (`Session`) et des documents (`DocumentSession`) ; `connect()` renvoie une `AnySession`, et le `SessionManager` garde son cycle de vie commun (secrets, tunnel SSH, annulation, connexion perdue). Le driver `driver/mongo/` s'appuie sur le crate officiel `mongodb`. Frontend : `WorkspaceInfo.capabilities` décide de l'interface ; un onglet de collection Mongo est un `DocumentTab` (barre de requête, trois vues) au lieu du `TableDataTab`.

**Tech Stack:** Rust `mongodb` 3.9 (rustls + ring), `json5` 1.3 ; frontend `@codemirror/lang-json` ; image Docker `mongo:7.0` pour les tests.

**Spec:** `docs/superpowers/specs/2026-10-19-tablemax-mongodb-design.md` (§3 objectifs, §4 non- et anti-objectifs, §5 décisions) · référence : `docs/research/2026-10-19-mongodb-compass-analysis.md` · epic #7.

## Global Constraints

- Tout ce qui précède reste valable : `CLAUDE.md`, `src/CLAUDE.md`, `src-tauri/CLAUDE.md` (chaînes dans `src/lib/strings.ts`, I/O asynchrones et annulables, secrets seulement dans le trousseau, capabilities Tauri `core:default`, une commande = `commands.rs` + `lib.rs` + `ipc.ts` + `types.ts` + `types.shape.test.ts`).
- **Lecture seule** : aucune commande d'écriture Mongo n'existe dans le code de cette étape. Les tests d'intégration des lectures tournent avec l'utilisateur `reader` (rôle `read` sur `tablemax_test`) : un test qui aurait besoin d'écrire échouerait.
- **Drapeau expérimental** jusqu'à la Task 12 : MongoDB n'existe pour l'utilisateur que si la variable d'environnement `TABLEMAX_EXPERIMENTAL` contient `mongodb` (liste séparée par des virgules). Sans elle, le formulaire ne propose pas MongoDB et le backend refuse d'ouvrir une connexion Mongo (`Invalid`, « MongoDB support is experimental »). La Task 12 retire le drapeau.
- Crate `mongodb = { version = "3.9", default-features = false, features = ["compat-3-0-0", "rustls-tls", "dns-resolver"] }` ; `grep -c aws-lc src-tauri/Cargo.lock` doit afficher `0`, aucun `openssl` dans `cargo tree`.
- Serveurs MongoDB ≥ 4.4 (minimum du crate) ; message d'erreur explicite en dessous.
- TLS Mongo : modes `disable`, `require`, `verifyFull` seulement. Défaut : `verifyFull` pour un hôte distant en direct ou `srv`, `disable` en local ou derrière SSH. URI : `disable` ↔ `tls=false`, `verifyFull` ↔ `tls=true`, `require` ↔ `tls=true&tlsAllowInvalidCertificates=true` (en lecture, `tlsInsecure=true` → `require`). Racines Mozilla ou fichier CA. Pas de certificat client.
- SSH : connexion directe à travers le tunnel ; refus (`Invalid`, message qui explique) de `verifyFull`, `srv`, plusieurs hôtes ou `replicaSet` derrière SSH.
- Topologie : un seul hôte → `directConnection=true` ; découverte seulement avec `srv`, plusieurs hôtes ou `replicaSet`. Préférence de lecture par défaut `primaryPreferred`.
- Authentification : SCRAM (défaut serveur, SCRAM-SHA-1, SCRAM-SHA-256) et `PLAIN` (LDAP, base `$external`). Base d'authentification : `authSource`, sinon la base de l'URI, sinon `admin`.
- Options avancées autorisées (et seules enregistrées) : `readPreference`, `readPreferenceTags`, `maxStalenessSeconds`, `appName`, `connectTimeoutMS`, `serverSelectionTimeoutMS`, `socketTimeoutMS`, `heartbeatFrequencyMS`, `localThresholdMS`, `maxPoolSize`, `minPoolSize`, `maxIdleTimeMS`, `retryReads`, `directConnection`. Refusées : `authMechanism` hors SCRAM / PLAIN, `authMechanismProperties`, `tlsCertificateKeyFile`, `tlsCertificateKeyFilePassword`, `tlsAllowInvalidHostnames`, `proxyHost`, `proxyPort`, `proxyUsername`, `proxyPassword`, `autoEncryption*`. Toute autre : ignorée et signalée.
- Saisie (filtre, projection, tri, collation, hint) : JSON5 interprété en Extended JSON relaxed ; objet requis (hint : objet ou nom d'index) ; `$where`, `$function`, `$accumulator` refusés à toute profondeur. Erreur `Invalid` au format `"<champ>: <détail>"`, `<champ>` ∈ `filter`, `project`, `sort`, `collation`, `hint`, `skip`, `limit`, `maxTimeMS`.
- Pagination : sans tri, collection triée par `{_id: 1}`, vue dans son ordre naturel ; un tri de l'utilisateur est envoyé tel quel. `maxTimeMS` par défaut **60000** si la barre n'en donne pas.
- Historique : 20 dernières requêtes par connexion + base + collection, sans doublon ; favoris nommés ; effaçable.
- Aucune donnée ne quitte la machine ailleurs que vers la base de l'utilisateur.
- Pile de test : service `mongo7` (`mongo:7.0`), port hôte `${TABLEMAX_TEST_MONGO_PORT:-27117}`, utilisateurs `root` / `tablemax` (admin) et `reader` / `tablemax` (`read` sur `tablemax_test`) ; `TLS` accepté et facultatif (`--tlsMode preferTLS`).

## Review Focus

1. **Collection hétérogène et noms de champs bizarres** (même champ avec des types différents, champ absent ou `null`, noms contenant `.`, commençant par `$`, chaîne vide) : la grille distingue absent / `null`, les colonnes restent stables, « filtrer par cette valeur » produit un filtre qui vise bien ce champ (`$getField` pour un nom avec `.` ou `$`) → tests `heterogeneous_fields_and_odd_names` (Task 5) et `filter_with_escapes_odd_names` (Task 4).
2. **`_id` qui n'est pas un ObjectId** (entier, chaîne, UUID, document, Decimal128) : le document entier se recharge par son `_id` typé → test `typed_ids_round_trip` (Task 5).
3. **Documents énormes ou très imbriqués** (chaîne de 15 Mo, 100 niveaux) : la page arrive, la cellule est tronquée, le document trop gros est différé et chargé à la demande, rien ne gèle → tests `oversized_document_is_deferred` (Task 5) et `deep_document_renders_lazily` (Task 7).
4. **Utilisateur aux droits restreints** (`reader` : pas de `listDatabases` global) : la liste des bases vient des bases autorisées, rien ne casse → test `restricted_user_lists_authorized_databases` (Task 3).
5. **Requête lente** (tri sans index sur 200 000 documents) : Annuler rend la main en moins d'une seconde et la session reste utilisable ; un `maxTimeMS` dépassé donne un message clair → tests `cancel_slow_find` et `max_time_ms_expired_is_reported` (Task 5).

---

### Task 1: Couche de capacités (aucun changement visible)

**Files:**
- Modify: `src-tauri/src/driver/mod.rs`, `src-tauri/src/driver/{postgres,mysql,sqlite}.rs` (découper les `impl`), `src-tauri/src/manager.rs`, `src-tauri/src/commands.rs`, `src/lib/types.ts`, `src/lib/types.shape.test.ts`, `src/stores/workspaces.ts`, `src/features/workspace/WorkspaceView.tsx`, `src/features/workspace/ObjectSidebar.tsx`, `src/features/palette/actions.ts`
- Test: `src-tauri/src/driver/mod.rs` (tests), `src/features/workspace/WorkspaceView.test.tsx`, `src/features/palette/actions.test.ts`

**Interfaces:**
- Produces (Rust, `driver/mod.rs`) :
  - `#[async_trait] pub trait SessionBase: Send + Sync` avec, déplacées depuis `Session` sans changer leur signature : `server_version`, `list_schemas`, `list_objects`, `count_rows`, `canceller`, `close`, `is_lost`, `catalog`, `list_databases`.
  - `pub trait Session: SessionBase` garde le reste (`dialect`, `query`, `query_full`, `apply`, `table_info`, `table_ddl`, `execute`, `list_routines`).
  - `pub trait DocumentSession: SessionBase {}` (vide ici ; Tasks 3 à 11 y ajoutent leurs méthodes).
  - `#[derive(Clone)] pub enum AnySession { Sql(Arc<dyn Session>), Documents(Arc<dyn DocumentSession>) }` avec `fn base(&self) -> &dyn SessionBase`, `fn sql(&self) -> AppResult<&Arc<dyn Session>>` et `fn documents(&self) -> AppResult<&Arc<dyn DocumentSession>>` (mauvaise famille → `Invalid`, « not supported by this connection »).
  - `#[derive(Serialize, Clone, Copy, PartialEq, Debug)] #[serde(rename_all = "camelCase")] pub struct Capabilities { pub sql_editor: bool, pub grid_editing: bool, pub routines: bool, pub ddl: bool, pub foreign_keys: bool, pub documents: bool, pub database_switch: bool }` et `pub fn capabilities(kind: DriverKind) -> Capabilities` (SQL : tout vrai sauf `documents` ; `database_switch` seulement PostgreSQL).
  - `pub async fn connect(params) -> AppResult<AnySession>`.
- Produces (manager) : les entrées de workspace gardent une `AnySession` ; `WorkspaceInfo` gagne `capabilities: Capabilities`, et `dialect` devient `Option<Dialect>` (`None` pour les documents).
- Produces (TS) : `export interface Capabilities { sqlEditor; gridEditing; routines; ddl; foreignKeys; documents; databaseSwitch: boolean }` ; `WorkspaceInfo.dialect: Dialect | null` ; `WorkspaceInfo.capabilities` ; le store `workspaces` les garde sur chaque workspace.

- [ ] **Step 1: Tests qui échouent.** Rust : `capabilities_per_kind` (PG : `database_switch` vrai ; MySQL / SQLite : faux ; aucune : `documents`), `any_session_family_errors` (`sql()` sur `Documents` → `Invalid`). TS : avec `capabilities.sqlEditor === false`, l'action `query.new` et « New SQL tab » sont absentes de la palette, la section Routines et le sélecteur de base sont masqués ; avec les capacités SQL, rien ne change (tests existants verts).
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib` → Expected: FAIL sur les nouveaux tests.
- [ ] **Step 3: Implémenter.** Le manager appelle `entry.session.sql()?` là où il utilise une méthode SQL, `base()` ailleurs. Le frontend lit `capabilities` (jamais `dialect === null`) pour décider ; les composants SQL reçoivent toujours un `Dialect` non nul.
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint && pnpm test:rust` → Expected: PASS, aucun test existant modifié hors types.
- [ ] **Step 5: Commit** — `🏗️ refactor(driver): capability layer (SessionBase, AnySession, Capabilities)`

---

### Task 2: Modèle de connexion MongoDB, URI et drapeau expérimental

**Files:**
- Create: `src-tauri/src/flags.rs`, `src/lib/mongoUri.ts`, `src/lib/mongoUri.test.ts`
- Modify: `src-tauri/src/driver/mod.rs` (`DriverKind::MongoDb`, `ConnectParams.mongo`), `src-tauri/src/store.rs`, `src-tauri/src/driver/tls.rs` (`ssl_modes_for`), `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/lib/types.ts`, `src/lib/types.shape.test.ts`, `src/lib/ipc.ts`, `src/lib/ssl.ts`, `src/lib/connectionUrl.ts` (délègue `mongodb:` / `mongodb+srv:` à `mongoUri.ts`)

**Interfaces:**
- Produces (Rust) :
  - `DriverKind::MongoDb` (wire `"mongoDb"`), `capabilities(MongoDb)` = seulement `documents: true`.
  - `store.rs` : `#[serde(rename_all = "camelCase")] pub struct MongoSettings { pub srv: bool, pub extra_hosts: Vec<String> /* "host:port" */, pub auth_source: Option<String>, pub auth_mechanism: MongoAuth /* Default | ScramSha1 | ScramSha256 | Plain */, pub replica_set: Option<String>, pub options: Vec<(String, String)> }` ; `ConnectionConfig` gagne `#[serde(default)] pub mongo: Option<MongoSettings>` (ancienne config → `None`) ; `ConnectParams` gagne `mongo: Option<MongoSettings>`.
  - `flags.rs` : `pub fn experimental_in(value: Option<&str>, feature: &str) -> bool` (liste séparée par des virgules, espaces ignorés) et `pub fn experimental(feature: &str) -> bool` (= `experimental_in` sur `TABLEMAX_EXPERIMENTAL`) ; `pub fn ensure_mongodb_enabled(enabled: bool) -> AppResult<()>` (`Invalid`, « MongoDB support is experimental… ») appelé à la sauvegarde et à l'ouverture d'une connexion Mongo avec `experimental("mongodb")` ; commande `app_flags() -> AppFlags { mongodb: bool }`.
  - `scripts/test-dbs.sh env` exporte aussi `TABLEMAX_EXPERIMENTAL=mongodb` (retiré à la Task 12), si bien que la CI et `pnpm test:rust` l'ont.
- Produces (TS, `mongoUri.ts`) :
  - `parseMongoUri(uri: string): { patch: Partial<ConnectionConfig>; password: string | null; ignored: string[]; refused: string[] }` (`refused` non vide = import impossible, l'appelant affiche la liste) ;
  - `toMongoUri(cfg: ConnectionConfig): string` (sans mot de passe ; `authSource` toujours écrit ; TLS selon la table des Global Constraints) ;
  - `MONGO_ALLOWED_OPTIONS`, `MONGO_REFUSED_OPTIONS` (listes des Global Constraints).

- [ ] **Step 1: Tests qui échouent.** TS : `parses_standard_and_srv` (hôtes multiples, port par défaut 27017, base, `authSource` ; `srv` → TLS `verifyFull`) ; `auth_source_follows_the_standard` (`mongodb://u@h/shop` → `shop` ; `?authSource=admin` gagne ; sans base → `admin`) ; `tls_options_map_to_modes` (`tls=true&tlsAllowInvalidCertificates=true` → `require`, `tlsInsecure=true` → `require`, `tls=false` → `disable`) ; `refused_and_ignored_options_are_reported` (`authMechanism=MONGODB-X509` et `tlsAllowInvalidHostnames=true` dans `refused`, `retryWrites=true` dans `ignored`) ; `password_never_in_output` (`toMongoUri` après un `parseMongoUri` avec mot de passe ne contient ni le mot de passe ni `:@`) ; `round_trip` (config → URI → config identique). Rust : `old_config_has_no_mongo_settings`, `experimental_flag_parsing` (`experimental_in` avec `"mongodb"`, `" sql , mongodb "`, `""`, `None`), `ensure_mongodb_enabled_refuses_when_off`, `ssl_modes_for_mongo` (`disable`, `require`, `verifyFull`).
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint && cargo test --manifest-path src-tauri/Cargo.toml --lib` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(mongo): connection settings, URI parsing and the experimental flag`

---

### Task 3: Driver MongoDB — connexion, bases, collections (pile de test incluse)

**Files:**
- Create: `src-tauri/src/driver/mongo/mod.rs`, `src-tauri/src/driver/mongo/options.rs`, `tests/docker/mongo-init.js`, `src-tauri/tests/mongo_driver.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/src/driver/mod.rs` (`connect`), `src-tauri/src/manager.rs` (connexion, tunnel, refus SSH), `docker-compose.test.yml` (service `mongo7`), `scripts/test-dbs.sh` (port, URLs, `env`), `scripts/test-secrets.sh` (SAN `mongo7`, `mongo.pem` = certificat + clé ; régénère le certificat serveur si son SAN ne contient pas `mongo7`), `src-tauri/tests/common/mod.rs` (`mongo_urls()`, `mongo_reader_url()`), `README.md` (« Two worktrees side by side » : `TABLEMAX_TEST_MONGO_PORT` ; MongoDB ≥ 4.4)

**Interfaces:**
- Consumes : `MongoSettings`, `ConnectParams.mongo`, `flags::experimental` (Task 2) ; `SessionBase`, `DocumentSession`, `AnySession` (Task 1).
- Produces :
  - `options.rs` : `pub fn client_options(p: &ConnectParams) -> AppResult<mongodb::options::ClientOptions>` (hôtes, `srv` via `ClientOptions::parse` d'une URI construite sans mot de passe puis `credential` posé à part, TLS, topologie, préférence de lecture, options autorisées) et `pub fn check_tunnel(p: &ConnectParams) -> AppResult<()>` (les refus SSH).
  - `mod.rs` : `pub async fn connect_mongo(p: &ConnectParams) -> AppResult<AnySession>` (ping `{hello: 1}`, version serveur, refus < 4.4) ; `MongoSession` implémente `SessionBase` : `list_schemas` = bases (`list_database_names` avec `authorizedDatabases: true`, puis repli sur la base de la connexion), `list_objects` = collections (`ObjectKind::Table`) et vues (`ObjectKind::View`) sans les `system.*`, `count_rows` = `estimated_document_count` (`Estimate`) pour une collection, `count_documents` borné pour une vue, `catalog` = collections et vues sans colonnes, `list_databases` = `list_schemas`, `canceller` (annule les opérations en cours de la session), `close`, `is_lost`.
  - Variables de test : `TABLEMAX_TEST_MONGO_URLS` (root), `TABLEMAX_TEST_MONGO_READER_URL`.

- [ ] **Step 1: Pile de test.** Service `mongo7` (`mongo:7.0`, `MONGO_INITDB_ROOT_USERNAME=root`, `MONGO_INITDB_ROOT_PASSWORD=tablemax`, `--tlsMode preferTLS --tlsCertificateKeyFile /tls/mongo.pem --tlsCAFile /tls/ca.pem --tlsAllowConnectionsWithoutCertificates`, healthcheck `mongosh --quiet --eval 'db.runCommand({ping:1}).ok'`) ; `mongo-init.js` crée `tablemax_test` (collections `orders`, `customers`, une vue `paid_orders`) et l'utilisateur `reader`. Run: `bash scripts/test-dbs.sh up && bash scripts/test-dbs.sh env | grep MONGO` → Expected: services sains, deux variables `TABLEMAX_TEST_MONGO_*`.
- [ ] **Step 2: Tests qui échouent** (`tests/mongo_driver.rs`, chaque test boucle sur les URLs) : `connects_and_reports_version` ; `lists_databases_collections_and_views` ; `restricted_user_lists_authorized_databases` (`reader` voit `tablemax_test`, sans erreur) ; `tls_verify_full_with_ca_file` et `tls_verify_full_without_ca_fails` ; `tls_require_accepts_unknown_ca` ; `through_ssh_tunnel` (hôte `mongo7`, port 27017 vu du sshd) ; `ssh_refuses_verify_full_srv_and_multi_host` (unitaire, `check_tunnel`) ; `wrong_password_is_auth_error` (`ErrorKind::Auth`, message sans le mot de passe) ; `server_too_old_is_explained` (unitaire sur la fonction qui lit la version du `hello` : `maxWireVersion` < 9 → message « MongoDB 4.4 or newer »). Unitaires `options.rs` : `single_host_is_direct`, `replica_set_or_hosts_discover`, `auth_source_and_plain_mechanism`, `read_preference_default_primary_preferred`, `allowed_options_applied`. Run: `eval "$(scripts/test-dbs.sh env)" && cargo test --manifest-path src-tauri/Cargo.toml --test mongo_driver` → Expected: FAIL.
- [ ] **Step 3: Implémenter.** Dépendance avec les features des Global Constraints ; vérifier `grep -c aws-lc src-tauri/Cargo.lock` → `0`.
- [ ] **Step 4: Vérifier** — Run: `pnpm test:rust && pnpm lint` → Expected: PASS ; `grep -c aws-lc src-tauri/Cargo.lock` → `0`.
- [ ] **Step 5: Commit** — `✨ feat(mongo): driver connection, databases, collections and views`

---

### Task 4: Valeurs BSON, formats JSON et saisie des requêtes

**Files:**
- Create: `src-tauri/src/driver/mongo/bson_value.rs`, `src-tauri/src/driver/mongo/input.rs`
- Modify: `src-tauri/src/value.rs` (`CellValue::Absent`), `src-tauri/Cargo.toml` (`json5 = "1.3"`), `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/lib/types.ts`, `src/lib/types.shape.test.ts`, `src/lib/ipc.ts`, `src/features/grid/cellContent.ts` (+ test)

**Interfaces:**
- Produces :
  - `CellValue::Absent` (wire `{t:"absent"}`) ; `cellContent` l'affiche vide avec le style « absent » (différent de `NULL`).
  - `bson_value.rs` : `pub fn cell(v: &Bson) -> CellValue` (correspondance du §5 de la spec ; UUID = Binary sous-type 4 → texte UUID) ; `pub enum DocFormat { RelaxedJson, CanonicalJson, Shell }` (serde camelCase) ; `pub fn format_document(d: &Document, f: DocFormat) -> String` (indenté de 2 espaces ; `Shell` : `ObjectId("…")`, `ISODate("…")`, `NumberLong("…")`, `NumberDecimal("…")`, `UUID("…")`, `BinData(n, "…")`, `Timestamp(t, i)`, `/re/flags`).
  - `input.rs` : `pub fn parse_object(field: &str, text: &str) -> AppResult<Option<Document>>` (vide → `None` ; JSON5 → Extended JSON relaxed → `Document` ; refus des opérateurs interdits ; erreur `"<field>: <détail>"`) ; `pub fn parse_hint(text: &str) -> AppResult<Option<mongodb::options::Hint>>` (objet → `Hint::Keys`, chaîne JSON ou texte nu → `Hint::Name`) ; `pub fn filter_with(filter: &str, path: &[String], value_ejson: &str) -> AppResult<String>` (ajoute la condition ; filtre existant combiné par `$and` s'il contient déjà ce champ ; chemin dont un segment contient `.` ou commence par `$` → `{$expr: {$eq: [{$getField: …}, value]}}`) ; commande `documents_filter_with(filter, path, value) -> String`.

- [ ] **Step 1: Tests qui échouent** (unitaires) : `every_bson_type_maps_to_a_cell` (un cas par type de la spec, `Int64` au-delà de 2^53 → `BigInt`) ; `shell_format_examples` (un document couvrant chaque helper) ; `relaxed_and_canonical_formats` ; `parse_accepts_json5_and_extended_json` (`{status: 'paid', total: {$gt: 100},}`, `{"_id": {"$oid": "…"}}`) ; `parse_rejects_non_object_and_reports_field` (`[1]` → `"filter: …"`) ; `forbidden_operators_rejected_at_any_depth` (`$where`, `$function` dans `$expr`, `$accumulator`) ; `filter_with_escapes_odd_names` (`["a.b"]`, `["$x"]`, `[""]`, chemin imbriqué `["a","b"]` → `"a.b"`) ; TS `absent_cell_is_blank_not_null`.
- [ ] **Step 2: Vérifier l'échec** — Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib mongo && pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib && pnpm test && pnpm lint` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(mongo): BSON cell values, document formats and query input parsing`

---

### Task 5: Requêtes de documents (backend)

**Files:**
- Create: `src-tauri/src/driver/mongo/query.rs`
- Modify: `src-tauri/src/driver/mod.rs` (méthodes de `DocumentSession`), `src-tauri/src/driver/mongo/mod.rs`, `src-tauri/src/manager.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/lib/types.ts`, `src/lib/types.shape.test.ts`, `src/lib/ipc.ts`, `tests/docker/mongo-init.js` (jeux de données des tests), `src-tauri/tests/mongo_driver.rs`

**Interfaces:**
- Consumes : `parse_object`, `parse_hint`, `cell`, `format_document`, `DocFormat` (Task 4).
- Produces :
  - `#[serde(rename_all = "camelCase", default)] pub struct DocumentQuery { pub filter: String, pub project: String, pub sort: String, pub collation: String, pub hint: String, pub skip: Option<u64>, pub limit: Option<u64>, pub max_time_ms: Option<u64> }`.
  - `pub struct PageDoc { pub ejson: Option<String> /* relaxed, None si > 512 KiB */, pub size: u64 }` ; `pub struct DocumentPage { pub columns: Vec<String>, pub rows: Vec<Vec<CellValue>>, pub docs: Vec<PageDoc>, pub ids: Vec<String> /* _id en Extended JSON canonique */ }`.
  - `DocumentSession` : `async fn find_page(&self, obj: &ObjectRef, q: &DocumentQuery, offset: u64, limit: u32, known_columns: &[String]) -> AppResult<DocumentPage>` ; `async fn count(&self, obj, q, exact_threshold: u64) -> AppResult<RowCount>` (sans filtre : `Estimate` ; avec : `count_documents` borné à `exact_threshold + 1`, au-delà `Estimate(exact_threshold)`) ; `async fn sample_fields(&self, obj) -> AppResult<Vec<String>>` (champs de premier niveau des 100 premiers documents, `_id` d'abord) ; `async fn get_document(&self, obj, id_canonical: &str, f: DocFormat) -> AppResult<String>`.
  - Commandes : `documents_page(workspaceId, object, query, offset, limit, knownColumns)`, `documents_count(workspaceId, object, query)` (seuil des réglages), `documents_fields(workspaceId, object)`, `document_get(workspaceId, object, id, format)`. L'annulation passe par la commande d'annulation existante de l'onglet de table.
  - Colonnes : `known_columns` puis les nouveaux champs de la page, dans l'ordre de première apparition ; avec une projection, les champs de la projection.

- [ ] **Step 1: Tests qui échouent** (intégration, utilisateur `reader`) : `pages_follow_id_order_without_sort` ; `user_sort_is_sent_as_is` ; `filter_projection_collation_hint_skip_limit` (un cas chacun) ; `heterogeneous_fields_and_odd_names` (absent → `Absent`, `null` → `Null`, colonnes `a.b`, `$x`, `""` présentes et stables entre deux pages) ; `typed_ids_round_trip` (int, chaîne, UUID, document, Decimal128, ObjectId → `get_document` renvoie le bon) ; `oversized_document_is_deferred` (chaîne de 15 Mo : cellule tronquée, `docs[i].ejson == None`, `get_document` le rend en entier) ; `counts_estimate_then_capped_exact` ; `view_pages_and_counts` ; `cancel_slow_find` (200 000 documents, tri sur un champ sans index, annulation → `Cancelled` en < 1 s, puis une page normale réussit) ; `max_time_ms_expired_is_reported` (`maxTimeMS: 1` → `Query`, message contenant `maxTimeMS`) ; `invalid_input_names_the_field` (`sort: "[1]"` → `Invalid`, `"sort: …"`).
- [ ] **Step 2: Vérifier l'échec** — Run: `eval "$(scripts/test-dbs.sh env)" && cargo test --manifest-path src-tauri/Cargo.toml --test mongo_driver` → Expected: FAIL.
- [ ] **Step 3: Implémenter.** Le jeu de 200 000 documents est créé par le test dans une collection propre (droits `root`), lue avec `reader`.
- [ ] **Step 4: Vérifier** — Run: `pnpm test:rust && pnpm lint && pnpm test` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(mongo): paged document queries, counts, typed document loading and cancel`

---

### Task 6: Formulaire de connexion MongoDB

**Files:**
- Create: `src/features/connections/MongoSection.tsx` (+ test)
- Modify: `src/features/connections/ConnectionForm.tsx` (+ test), `src/features/connections/connectionDraft.ts` (+ test), `src/features/connections/UrlImportDialog.tsx`, `src/lib/strings.ts`, `src/App.tsx` (lecture de `appFlags`)

**Interfaces:**
- Consumes : `parseMongoUri`, `toMongoUri`, `ipc.appFlags()`, `sslModesFor("mongoDb")` (Task 2).
- Produces : pour `kind === "mongoDb"`, le formulaire montre : champ URI éditable synchronisé dans les deux sens avec les champs (une saisie invalide dans l'URI est signalée sans effacer les champs), hôte(s), port 27017 par défaut, `srv`, utilisateur, mot de passe (trousseau / demander), base, base d'authentification, mécanisme (Défaut, SCRAM-SHA-1, SCRAM-SHA-256, LDAP), `replicaSet`, options avancées (liste clé / valeur limitée aux options autorisées), TLS (3 modes, fichier CA), SSH. Avertissements : LDAP sans TLS (mot de passe en clair) ; option refusée (liste) ; options ignorées (liste). Les combinaisons interdites derrière SSH sont désactivées avec leur explication. « Copier l'URL » utilise `toMongoUri`.

- [ ] **Step 1: Tests qui échouent** : `mongo_hidden_without_flag` ; `uri_and_fields_stay_in_sync` (taper l'URI remplit les champs, changer un champ réécrit l'URI) ; `pasted_password_goes_to_password_field_not_uri` ; `refused_option_blocks_save_with_list` ; `ldap_without_tls_warns` ; `ssh_disables_verify_full_and_srv` ; `default_port_and_tls_by_host`.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS. Vérification manuelle (`TABLEMAX_EXPERIMENTAL=mongodb pnpm dev`) : créer « Mongo local » vers `127.0.0.1:27117` (`root` / `tablemax`), se connecter, voir les bases et collections ; notes et capture dans la PR.
- [ ] **Step 5: Commit** — `✨ feat(mongo): connection form with URI sync, auth, TLS and SSH rules`

---

### Task 7: Onglet de collection — barre de requête et vue table

**Files:**
- Create: `src/features/documents/DocumentTab.tsx`, `src/features/documents/QueryBar.tsx`, `src/features/documents/useDocumentPage.ts`, `src/features/documents/queryCompletion.ts` (+ tests de chacun)
- Modify: `src/features/workspace/WorkspaceView.tsx` (onglet de table → `DocumentTab` quand `capabilities.documents`), `src/features/grid/RowDetailPanel.tsx` (variante document), `src/lib/strings.ts`, `package.json` (`@codemirror/lang-json`), `pnpm-lock.yaml`

**Interfaces:**
- Consumes : `documents_page`, `documents_count`, `documents_fields`, `document_get` (Task 5) ; la grille existante (`DataGrid`) en lecture seule.
- Produces :
  - `QueryBar` : filtre (toujours visible) ; options repliables : projection, tri, collation, hint, skip, limit, maxTimeMS ; Entrée ou « Find » exécute, « Reset » vide ; erreur `"<champ>: …"` affichée sous le champ concerné ; autocomplétion (`queryCompletion.ts`) des noms de champs (`documents_fields` + colonnes connues) et des opérateurs de requête (`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$type`, `$regex`, `$and`, `$or`, `$nor`, `$not`, `$all`, `$elemMatch`, `$size`, `$expr`, `$getField`, `$text`, `$mod`) ; prop `onRun(query: DocumentQuery)`.
  - `useDocumentPage(workspaceId, object, query, page)` : page, colonnes cumulées, compte, chargement, erreur, annulation.
  - Clic sur un en-tête de colonne → tri `{champ: 1}` puis `-1` puis aucun, reflété dans le champ tri.
  - `Ctrl+I` : détail du document (`document_get`, format relaxed) ; aucune action d'édition ; `Ctrl+S` inactif.

- [ ] **Step 1: Tests qui échouent** : `runs_query_on_enter_and_shows_page` ; `field_error_shown_under_the_right_input` ; `options_collapsed_by_default` ; `completion_offers_fields_and_operators` ; `header_click_cycles_sort_and_updates_sort_field` ; `no_edit_actions_on_documents` ; `deep_document_renders_lazily` (document de 100 niveaux : la page s'affiche, le détail ne déplie qu'à la demande) ; `cancel_button_cancels_running_page`.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS. Manuel : filtrer `orders` par `{status: 'paid'}`, trier par `total`, ouvrir un document ; notes et capture.
- [ ] **Step 5: Commit** — `✨ feat(mongo): collection tab with query bar, table view and document detail`

---

### Task 8: Vues JSON et arbre, menu des valeurs, copie

**Files:**
- Create: `src/features/documents/DocumentJsonView.tsx`, `src/features/documents/DocumentTreeView.tsx`, `src/features/documents/ValueMenu.tsx` (+ tests)
- Modify: `src/features/documents/DocumentTab.tsx`, `src/lib/strings.ts`

**Interfaces:**
- Consumes : `DocumentPage.docs` et `ids` (Task 5), `document_get` avec `DocFormat`, `documents_filter_with` (Task 4).
- Produces : sélecteur de vue Table / JSON / Arbre (mémorisé par onglet, restauré avec la session) ; JSON : un bloc CodeMirror en lecture seule par document, virtualisé ; Arbre : documents dépliables, type BSON affiché par valeur, enfants rendus seulement une fois dépliés ; un document différé (`ejson: null`) affiche « Load document » qui appelle `document_get`. Menu d'une valeur (table et arbre) : « Filter by this value » (`documents_filter_with` puis exécution), « Copy value », « Copy field path ». Copie d'un document : Extended JSON relaxed, canonique, syntaxe shell.

- [ ] **Step 1: Tests qui échouent** : `switching_views_keeps_page_and_query` ; `json_view_is_read_only_and_virtualized` (300 documents → peu de nœuds montés) ; `tree_shows_bson_types_and_expands_lazily` ; `deferred_document_loads_on_demand` ; `filter_by_value_appends_condition_and_runs` ; `copy_document_in_three_formats` ; `view_choice_restored_with_session`.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS ; manuel : les trois vues sur `orders`, « Filter by this value » sur un sous-champ ; notes et capture.
- [ ] **Step 5: Commit** — `✨ feat(mongo): JSON and tree views, value menu and document copy formats`

---

### Task 9: Historique et favoris de requêtes

**Files:**
- Modify: `src-tauri/src/store.rs` (migration `user_version` suivante : table `mongo_queries`), `src-tauri/src/manager.rs` (enregistrement après une première page réussie), `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/lib/types.ts`, `src/lib/types.shape.test.ts`, `src/lib/ipc.ts`
- Create: `src/features/documents/QueryHistory.tsx` (+ test)

**Interfaces:**
- Produces : table `mongo_queries(id INTEGER PRIMARY KEY, connection_id TEXT NOT NULL, database TEXT NOT NULL, collection TEXT NOT NULL, query_json TEXT NOT NULL, favorite_name TEXT, used_at INTEGER NOT NULL)` ; une requête (`DocumentQuery` sérialisée) exécutée à l'offset 0 est enregistrée ou remonte en tête (sans doublon) ; 20 non-favorites gardées par (connexion, base, collection) ; commandes `mongo_queries_list(connectionId, database, collection) -> Vec<SavedMongoQuery { id, query, favoriteName, usedAt }>`, `mongo_query_favorite(id, name: Option<String>)`, `mongo_queries_clear(connectionId, database, collection)` (garde les favoris) ; suppression d'une connexion → ses requêtes supprimées. UI : bouton « History » de la barre de requête : récentes, favoris, « Save as favorite », « Clear history ».

- [ ] **Step 1: Tests qui échouent** : Rust `records_dedups_and_keeps_20`, `favorites_survive_clear`, `deleting_connection_deletes_its_queries`, `migration_from_previous_version` ; TS `history_popover_recalls_and_runs`, `save_and_rename_favorite`.
- [ ] **Step 2: Vérifier l'échec** — Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib store && pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint && pnpm test:rust` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(mongo): recent and favorite queries per collection`

---

### Task 10: Structure — index, validation, statistiques

**Files:**
- Create: `src-tauri/src/driver/mongo/info.rs`, `src/features/documents/CollectionStructure.tsx` (+ test)
- Modify: `src-tauri/src/driver/mod.rs` (`DocumentSession::collection_info`, `database_stats`), `src-tauri/src/driver/mongo/mod.rs`, `src-tauri/src/manager.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/lib/types.ts`, `src/lib/types.shape.test.ts`, `src/lib/ipc.ts`, `src/features/documents/DocumentTab.tsx` (`Alt+2`), `src/features/workspace/ObjectSidebar.tsx` (infobulles), `src-tauri/tests/mongo_driver.rs`

**Interfaces:**
- Produces :
  - `pub struct IndexInfoDoc { name, keys_ejson: String, kind: String /* regular, text, 2dsphere, hashed, wildcard… */, unique, sparse, hidden: bool, ttl_seconds: Option<i64>, partial_filter_ejson: Option<String>, collation_ejson: Option<String>, size_bytes: Option<u64>, ops: Option<u64>, since: Option<String> }` ;
  - `pub struct CollectionInfo { kind: ObjectKind, stats: Option<CollStats { count, size, avg_obj_size, storage_size, nindexes, total_index_size, capped }>, indexes: Vec<IndexInfoDoc>, validator_ejson: Option<String>, validation_level: Option<String>, validation_action: Option<String>, options_ejson: String, view_on: Option<String>, pipeline_ejson: Option<String> }` ;
  - `DocumentSession::collection_info(obj) -> AppResult<CollectionInfo>` (`listCollections`, `listIndexes`, `$collStats` / `$indexStats` ; une statistique refusée par les droits → `None`, sans échec global) ; `database_stats(db) -> AppResult<Option<DbStats { collections, data_size, storage_size, indexes }>>`.
  - Commandes `collection_info(workspaceId, object)`, `database_stats(workspaceId, database)`.
  - UI : onglet Structure du `DocumentTab` (index avec usage et taille, validation, options ou définition de la vue) ; infobulles de la barre latérale pour bases et collections.

- [ ] **Step 1: Tests qui échouent** (intégration avec index TTL, partiel, unique, texte, caché et un validateur dans `mongo-init.js`) : `indexes_with_properties_and_usage` ; `validation_rules_level_and_action` ; `view_shows_source_and_pipeline` ; `stats_missing_rights_degrade_gracefully` (`reader`) ; TS `structure_tab_sections`, `sidebar_tooltip_shows_stats`.
- [ ] **Step 2: Vérifier l'échec** — Run: `eval "$(scripts/test-dbs.sh env)" && cargo test --manifest-path src-tauri/Cargo.toml --test mongo_driver && pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test:rust && pnpm test && pnpm lint` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(mongo): indexes with usage, validation rules and collection statistics`

---

### Task 11: Explain et export

**Files:**
- Create: `src-tauri/src/driver/mongo/explain.rs`, `src-tauri/src/driver/mongo/export.rs`, `src/features/documents/ExplainPanel.tsx`, `src/features/documents/ExportDialog.tsx` (+ tests)
- Modify: `src-tauri/src/driver/mod.rs` (`DocumentSession::explain`, `export`), `src-tauri/src/driver/mongo/mod.rs`, `src-tauri/src/manager.rs`, `src-tauri/src/commands.rs` (`FilePurpose::ExportJson`, `FilePurpose::ExportCsv` en boîte d'enregistrement), `src-tauri/src/lib.rs`, `src/lib/types.ts`, `src/lib/types.shape.test.ts`, `src/lib/ipc.ts`, `src/features/documents/QueryBar.tsx`, `src/lib/strings.ts`, `src-tauri/tests/mongo_driver.rs`

**Interfaces:**
- Produces :
  - `pub struct ExplainSummary { returned: u64, docs_examined: u64, keys_examined: u64, millis: u64, index: Option<String>, collection_scan: bool, in_memory_sort: bool }` ; `pub struct ExplainResult { summary: ExplainSummary, raw_ejson: String }` ; `DocumentSession::explain(obj, q, offset, limit) -> AppResult<ExplainResult>` (commande `explain` en `executionStats` de **la requête envoyée pour la page**) ; commande `documents_explain(workspaceId, object, query, offset, limit)`.
  - `pub enum ExportScope { All, Page { offset: u64, limit: u32 } }` ; `pub enum ExportFormat { JsonRelaxed, JsonCanonical, Csv { fields: Vec<String> } }` ; `DocumentSession::export(obj, q, scope, format, out: &mut (dyn std::io::Write + Send), progress: &(dyn Fn(u64) + Sync)) -> AppResult<u64>` (curseur lu document par document ; JSON = tableau ; CSV = en-tête puis une ligne par document, chemins `a.b.c`, tableaux et sous-documents en JSON, échappement RFC 4180) ; commande `documents_export(workspaceId, object, query, scope, format, onEvent: Channel<ExportEvent>) -> Option<u64>` (boîte d'enregistrement ouverte côté Rust, `None` si annulée ; événements `progress { written }`, `finished { written }`, `failed { error }` ; fichier écrit dans un fichier temporaire voisin puis renommé ; annulation → fichier temporaire supprimé).
  - UI : bouton « Explain » (panneau résumé + sortie brute, parcours complet et tri en mémoire signalés) ; bouton « Export » (portée, format, champs CSV pré-cochés avec les colonnes, progression, annuler).

- [ ] **Step 1: Tests qui échouent** : `explain_reports_index_or_collscan` ; `explain_is_the_sent_query` (tri utilisateur inclus) ; `export_json_all_streams` (200 000 documents écrits sans tout charger : mémoire du processus bornée, vérifiée par le nombre et la validité du JSON) ; `export_csv_flattens_and_escapes` (virgules, guillemets, retours à la ligne, tableaux) ; `export_page_scope` ; `export_cancel_leaves_no_file` ; TS `explain_panel_flags_collscan`, `export_dialog_progress_and_cancel`.
- [ ] **Step 2: Vérifier l'échec** — Run: `eval "$(scripts/test-dbs.sh env)" && cargo test --manifest-path src-tauri/Cargo.toml --test mongo_driver && pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test:rust && pnpm test && pnpm lint` → Expected: PASS ; manuel : explain d'un tri sans index (parcours complet signalé), export CSV de `orders` ouvert dans un tableur ; notes et captures.
- [ ] **Step 5: Commit** — `✨ feat(mongo): explain summary and streamed JSON / CSV export`

---

### Task 12: Démo, documentation, fin du drapeau expérimental

**Files:**
- Modify: `scripts/demo-db.sh` (base Mongo `shop` : `customers`, `orders` avec sous-documents et tableaux, vue `paid_orders`, index TTL et partiel, validateur ; connexion « Demo · MongoDB »), `docs/DEMO.md` (étape MongoDB), `README.md` (section MongoDB : fonctions, TLS et SSH, versions ≥ 4.4, CA d'entreprise), `CLAUDE.md` et `src-tauri/CLAUDE.md` (module `driver/mongo/`, couche de capacités), `src-tauri/src/flags.rs` et ses usages (retrait du drapeau `mongodb`), `src/features/connections/ConnectionForm.tsx`, `scripts/test-dbs.sh` (plus d'export de `TABLEMAX_EXPERIMENTAL`)
- Create: `docs/notes/mongodb-01-manual-check.md`, `docs/notes/mongodb-01-followups.md`

**Interfaces:**
- Consumes : tout ce qui précède.
- Produces : MongoDB visible sans drapeau ; `flags.rs` reste pour de futures fonctions expérimentales (liste vide).

- [ ] **Step 1: Tests qui échouent** : `mongo_visible_without_flag` (TS) et `mongo_connects_without_flag` (Rust) ; `demo-db` : `bash scripts/demo-db.sh --no-register` crée la base `shop` (vérifié par `mongosh` dans le conteneur : 2 collections, 1 vue).
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test && pnpm test:rust` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint && pnpm test:rust` → Expected: PASS ; parcours manuel complet de l'étape 1 dans `docs/notes/mongodb-01-manual-check.md` (connexion directe, TLS, SSH, URI `mongodb+srv://` refusée derrière SSH, requêtes, trois vues, historique, structure, explain, export, annulation d'une requête lente) avec captures.
- [ ] **Step 5: Commit** — `✨ feat(mongo): demo data, docs, and MongoDB out of the experimental flag`

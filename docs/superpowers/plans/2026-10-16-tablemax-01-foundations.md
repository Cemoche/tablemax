# TableMax — Plan 1 : Fondations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une app Tauri 2 qui enregistre des connexions MySQL/MariaDB/PostgreSQL/SQLite (mots de passe dans le trousseau), ouvre des workspaces, liste les objets, affiche une table en grille paginée et triable (lecture seule) dans des onglets illimités, et exécute du SQL avec annulation.

**Architecture:** Backend Rust : un trait `Session` implémenté par trois drivers (`tokio-postgres`, `mysql_async`, `rusqlite`), un `SessionManager` qui tient les connexions ouvertes (une connexion « navigation » par workspace + une connexion dédiée par onglet SQL), un `ConnectionStore` SQLite local sans secrets et un `SecretStore` adossé à `keyring`. Le frontend React parle au backend par des commandes Tauri typées à la main (`src/lib/ipc.ts`), avec un `Channel` pour streamer l'exécution SQL.

**Tech Stack:** Tauri 2.12 (`tauri = "2"`, `@tauri-apps/api@^2.12`), Rust 1.96 (edition 2024), tokio 1, tokio-postgres 0.7 + `tokio-postgres-rustls`, mysql_async 0.37 (feature `default-rustls`), rusqlite 0.40 (`bundled`), keyring 4.2 (feature par défaut `v1`), async-trait, serde, thiserror 2, uuid ; React 19, TypeScript, Vite, Tailwind 4, Zustand 5, `@glideapps/glide-data-grid` 6, `@uiw/react-codemirror` 4 + `@codemirror/lang-sql` 6, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-16-tablemax-design.md` (+ contexte : `docs/research/2026-10-16-tableplus-linux-analysis.md`)

## Feuille de route (plans suivants, hors de ce plan)

1. **Fondations** (ce plan)
2. Connexions avancées : SSL, tunnel SSH (`russh`, alias `~/.ssh/config`, `known_hosts`), groupes, URL import/export, import `.tableplusconnection`, mode « demander le mot de passe »
3. Données : édition inline, panneau des modifications en attente, commit/discard, navigation FK + fil d'Ariane, constructeur de filtres + barre rapide, détail de ligne, copie TSV/CSV/JSON/INSERT, vue Structure
4. Onglets & éditeur : onglet aperçu, Ctrl+Tab MRU, recherche d'onglets, restauration de session, palette Ctrl+K, complétion SQL, formatage, historique, requêtes sauvegardées, LIMIT auto
5. Sécurité & finitions : safe mode, teinte par environnement, réglages, keymap, thème, packaging `.deb`/AppImage

## Global Constraints

- Stack imposée : Tauri 2, React, TypeScript, Rust. **Ne pas** utiliser Tauri 3 (alpha).
- Linux d'abord (Ubuntu 26.04, Wayland) ; aucune API Linux-only hors abstraction (portable macOS/Windows).
- Gestionnaire JS : pnpm. Langue de l'UI : anglais ; toutes les chaînes visibles passent par `src/lib/strings.ts`.
- Secrets **uniquement** dans le trousseau OS ; jamais sur disque, dans les logs, ni renvoyés au frontend après enregistrement.
- Tout I/O base de données est asynchrone et annulable ; aucune commande Tauri ne bloque le thread principal.
- Aucun code, nom, icône ni asset de TablePlus.
- Pas de contenu distant ; permissions Tauri (capabilities) minimales ; CSP stricte.
- Versions testées : MySQL 8, MariaDB 11, PostgreSQL 16 ; ajouter une version = une ligne dans `docker-compose.test.yml` + une URL dans `scripts/test-dbs.sh`.
- Commits : `<emoji> <type>(<scope>): <description>` (✨ feat, 🐛 fix, 🏗️ refactor, 🔥 chore, 📝 docs, ✅ test), branche `main`.
- Constantes : `DEFAULT_PAGE_SIZE = 300`, `EXACT_COUNT_THRESHOLD = 500_000` (au-delà : estimation), `TEXT_PREVIEW_CHARS = 10_000`, `BYTES_PREVIEW = 64`.

## Review Focus

1. **Identifiants piégeux** (table `order`, `My "Table"`, `` we`ird ``, majuscules, espaces) : la grille s'ouvre et trie correctement → tests de quoting (Task 2) + test d'intégration SQLite sur une table `"My ""Table"""` (Task 3).
2. **Erreur au milieu d'un lot** (`select 1; select * from nope; select 2`) : les résultats précédents restent affichés, l'erreur indique l'index de l'instruction, l'exécution s'arrête → test `execute_batch_stops_at_error` (Task 7).
3. **Connexion perdue** (serveur redémarré, backend tué) : erreur `ConnectionLost` claire, l'app ne gèle pas, on peut rouvrir → test `pg_terminated_backend_reports_connection_lost` (Task 4).
4. **Valeurs extrêmes** : `DECIMAL(38,10)`, `BIGINT UNSIGNED` max, `NaN`/`Infinity` (PG float), NULL vs chaîne vide, BLOB/bytea non UTF-8 → aucune perte de précision, NULL distinct de `''` → tests de mapping (Tasks 3, 4, 5).
5. **Cellules énormes** (TEXT de plusieurs Mo) : la page arrive tronquée (`LongText`) sans geler la grille → test `long_text_is_truncated` (Task 3).

---

### Task 1: Scaffold Tauri 2 + React + outillage de test

**Files:**
- Create: projet Tauri à la racine (`package.json`, `index.html`, `vite.config.ts`, `tsconfig.json`, `src/`, `src-tauri/`), `src/lib/strings.ts`, `vitest.config.ts`, `src/test/setup.ts`, `docker-compose.test.yml`, `scripts/test-dbs.sh`, `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: scripts pnpm `dev` (`tauri dev`), `test` (vitest run), `test:rust` (`scripts/test-dbs.sh up && eval "$(scripts/test-dbs.sh env)" && cargo test --manifest-path src-tauri/Cargo.toml`), `lint` (`tsc --noEmit && cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings`). Crate Rust nommée `tablemax` (lib `tablemax_lib`), identifiant d'app `dev.tablemax.app`, productName `TableMax`.
- `scripts/test-dbs.sh env` imprime `export TABLEMAX_TEST_PG_URLS=...` et `export TABLEMAX_TEST_MYSQL_URLS=...` (listes séparées par des virgules).

- [ ] **Step 1: Installer les dépendances système Tauri**

Run: `sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
Expected: `pkg-config --modversion webkit2gtk-4.1` affiche une version.

- [ ] **Step 2: Générer le projet**

Générer dans un dossier temporaire puis déplacer à la racine (le dépôt contient déjà `docs/`) : `pnpm create tauri-app@4 tablemax --template react-ts --manager pnpm --identifier dev.tablemax.app -y`. Mettre `productName: "TableMax"`, fenêtre 1400×900, `app.security.csp` = `"default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ipc: http://ipc.localhost"`. Ajouter Tailwind 4 (`@tailwindcss/vite`), Zustand, Vitest, `@testing-library/react`, `jsdom`.

- [ ] **Step 3: Base de tests de bout en bout**

`docker-compose.test.yml` : services `pg16` (`postgres:16-alpine`, port hôte 54321), `mysql8` (`mysql:8.4`, 33061), `mariadb11` (`mariadb:11.4`, 33062), mot de passe `tablemax`, base `tablemax_test`, healthchecks. `scripts/test-dbs.sh up|down|env` (`up` attend les healthchecks).

- [ ] **Step 4: Vérifier que tout compile et que les tests vides passent**

Run: `pnpm test && cargo test --manifest-path src-tauri/Cargo.toml && pnpm tauri build --debug --no-bundle`
Expected: vitest « no test files » toléré (`passWithNoTests: true`), cargo OK, binaire produit.

Run: `scripts/test-dbs.sh up && scripts/test-dbs.sh env`
Expected: trois conteneurs healthy, deux lignes `export`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "🔥 chore(app): scaffold Tauri 2 + React + test databases"
```

---

### Task 2: Modèle cœur (erreurs, valeurs, trait Session, quoting, requête de page)

**Files:**
- Create: `src-tauri/src/error.rs`, `src-tauri/src/value.rs`, `src-tauri/src/driver/mod.rs`, `src-tauri/src/driver/sql.rs`
- Modify: `src-tauri/src/lib.rs` (déclarer les modules)
- Test: tests unitaires `#[cfg(test)]` dans `value.rs` et `driver/sql.rs`

**Interfaces:**
- Produces (`error.rs`) :
  - `#[derive(Debug, Clone, Copy, Serialize, PartialEq)] #[serde(rename_all = "camelCase")] pub enum ErrorKind { Connection, Auth, Query, Cancelled, ConnectionLost, NotFound, Secret, Io, Invalid }`
  - `#[derive(Debug, thiserror::Error, Serialize)] #[error("{message}")] pub struct AppError { pub kind: ErrorKind, pub message: String }` + `AppError::new(kind, impl Into<String>)` ; `pub type AppResult<T> = Result<T, AppError>`.
- Produces (`value.rs`) :
  - `#[derive(Debug, Clone, Serialize, PartialEq)] #[serde(tag = "t", content = "v", rename_all = "camelCase")] pub enum CellValue { Null, Bool(bool), Int(i64), BigInt(String), Float(f64), Decimal(String), Text(String), LongText { preview: String, len: u64 }, Bytes { len: u64, hex_preview: String }, Json(String), Temporal(String) }`
  - `pub fn text_value(s: String) -> CellValue` (→ `LongText` si > `TEXT_PREVIEW_CHARS` caractères, `len` en caractères) ; `pub fn bytes_value(b: &[u8]) -> CellValue` (aperçu hex des `BYTES_PREVIEW` premiers octets) ; `pub fn float_value(f: f64) -> CellValue` (non fini → `Text("NaN" | "Infinity" | "-Infinity")`) ; constantes `TEXT_PREVIEW_CHARS`, `BYTES_PREVIEW`, `DEFAULT_PAGE_SIZE`, `EXACT_COUNT_THRESHOLD`.
- Produces (`driver/mod.rs`) :
  - `pub enum DriverKind { Postgres, MySql, MariaDb, Sqlite }` (serde camelCase) ; `pub enum Dialect { Postgres, MySql, Sqlite }` ; `impl DriverKind { pub fn dialect(self) -> Dialect }`
  - `pub struct ConnectParams { pub kind: DriverKind, pub host: String, pub port: u16, pub user: String, pub password: Option<String>, pub database: Option<String>, pub sqlite_path: Option<PathBuf> }`
  - `pub struct ObjectRef { pub schema: Option<String>, pub name: String }` ; `pub enum ObjectKind { Table, View }` ; `pub struct DbObject { pub schema: Option<String>, pub name: String, pub kind: ObjectKind }`
  - `pub struct ColumnMeta { pub name: String, pub type_name: String }` ; `pub struct ResultSet { pub columns: Vec<ColumnMeta>, pub rows: Vec<Vec<CellValue>> }`
  - `pub struct StatementOutcome { pub result: Option<ResultSet>, pub rows_affected: Option<u64>, pub elapsed_ms: u64 }`
  - `pub enum SortDir { Asc, Desc }` ; `pub struct PageRequest { pub object: ObjectRef, pub limit: u32, pub offset: u64, pub sort: Option<(String, SortDir)> }` ; `#[serde(tag = "t", content = "v")] pub enum RowCount { Exact(u64), Estimate(u64) }`
  - tous ces types : `Serialize + Deserialize`, `rename_all = "camelCase"`.
  - `#[async_trait] pub trait Canceller: Send + Sync { async fn cancel(&self) -> AppResult<()>; }`
  - `#[async_trait] pub trait Session: Send + Sync { fn dialect(&self) -> Dialect; fn server_version(&self) -> String; async fn list_schemas(&self) -> AppResult<Vec<String>>; async fn list_objects(&self, schema: Option<&str>) -> AppResult<Vec<DbObject>>; async fn fetch_page(&self, req: &PageRequest) -> AppResult<ResultSet>; async fn count_rows(&self, obj: &ObjectRef, exact_threshold: u64) -> AppResult<RowCount>; async fn execute(&self, sql: &str) -> AppResult<StatementOutcome>; fn canceller(&self) -> Arc<dyn Canceller>; async fn close(&self) -> AppResult<()>; }` — `&self` partout : chaque driver protège sa connexion par un mutex interne pour que `canceller()` reste utilisable pendant un `execute`. Une requête annulée renvoie `ErrorKind::Cancelled`.
  - `pub async fn connect(params: &ConnectParams) -> AppResult<Arc<dyn Session>>` (dispatch vers les drivers des Tasks 3–5 ; jusque-là `unimplemented` par driver absent → `AppError::new(Invalid, "driver not available")`).
- Produces (`driver/sql.rs`) : `pub fn quote_ident(d: Dialect, ident: &str) -> String` ; `pub fn qualified(d: Dialect, obj: &ObjectRef) -> String` ; `pub fn build_page_query(d: Dialect, req: &PageRequest) -> String`.

- [ ] **Step 1: Écrire les tests qui échouent**

```rust
#[test] fn quote_ident_escapes_per_dialect() {
    assert_eq!(quote_ident(Dialect::Postgres, r#"My "Table""#), r#""My ""Table""""#);
    assert_eq!(quote_ident(Dialect::Sqlite, "order"), r#""order""#);
    assert_eq!(quote_ident(Dialect::MySql, "we`ird"), "`we``ird`");
}
#[test] fn page_query_with_sort_and_schema() {
    let req = PageRequest { object: ObjectRef { schema: Some("public".into()), name: "orders".into() },
        limit: 300, offset: 600, sort: Some(("total".into(), SortDir::Desc)) };
    assert_eq!(build_page_query(Dialect::Postgres, &req),
        r#"SELECT * FROM "public"."orders" ORDER BY "total" DESC LIMIT 300 OFFSET 600"#);
}
#[test] fn page_query_without_sort_mysql() {
    let req = PageRequest { object: ObjectRef { schema: Some("shop".into()), name: "order".into() }, limit: 10, offset: 0, sort: None };
    assert_eq!(build_page_query(Dialect::MySql, &req), "SELECT * FROM `shop`.`order` LIMIT 10 OFFSET 0");
}
#[test] fn long_text_is_truncated() {
    let v = text_value("é".repeat(TEXT_PREVIEW_CHARS + 5));
    assert!(matches!(v, CellValue::LongText { ref preview, len } if preview.chars().count() == TEXT_PREVIEW_CHARS && len == (TEXT_PREVIEW_CHARS + 5) as u64));
}
#[test] fn bytes_preview_and_non_finite_floats() {
    assert_eq!(bytes_value(&[0xde, 0xad, 0x00]), CellValue::Bytes { len: 3, hex_preview: "dead00".into() });
    assert_eq!(float_value(f64::NAN), CellValue::Text("NaN".into()));
}
#[test] fn cell_value_serializes_tagged() {
    assert_eq!(serde_json::to_string(&CellValue::BigInt("18446744073709551615".into())).unwrap(), r#"{"t":"bigInt","v":"18446744073709551615"}"#);
    assert_eq!(serde_json::to_string(&CellValue::Null).unwrap(), r#"{"t":"null"}"#);
}
```

- [ ] **Step 2: Lancer et constater l'échec**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: FAIL (symboles introuvables).

- [ ] **Step 3: Implémenter `error.rs`, `value.rs`, `driver/mod.rs`, `driver/sql.rs`** selon les Interfaces.

- [ ] **Step 4: Relancer**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: PASS.

- [ ] **Step 5: Commit** — `✨ feat(core): add value model, session trait and SQL quoting`

---

### Task 3: Driver SQLite

**Files:**
- Create: `src-tauri/src/driver/sqlite.rs`
- Modify: `src-tauri/src/driver/mod.rs` (dispatch `Sqlite`)
- Test: `src-tauri/tests/sqlite_driver.rs`

**Interfaces:**
- Consumes: Task 2 (`Session`, `Canceller`, `ConnectParams`, `CellValue` helpers, `build_page_query`).
- Produces: `pub async fn connect_sqlite(path: &Path) -> AppResult<Arc<dyn Session>>`. `list_schemas` → `["main"]` (+ bases attachées). `list_objects` lit `sqlite_schema` (exclut `sqlite_%`). `count_rows` est toujours `Exact`. Mapping : INTEGER→`Int`, REAL→`float_value`, TEXT→`text_value`, BLOB→`bytes_value`, NULL→`Null`. `type_name` = type déclaré de la colonne (`decl_type`) ou `""`. Implémentation : `rusqlite::Connection` dans `Arc<std::sync::Mutex<_>>`, chaque appel dans `tokio::task::spawn_blocking` ; `Canceller` = `InterruptHandle` (une requête interrompue → `ErrorKind::Cancelled`). Fichier inexistant → `ErrorKind::NotFound` (ouvrir avec `SQLITE_OPEN_READ_WRITE` sans `CREATE`).

- [ ] **Step 1: Écrire les tests qui échouent** (base temporaire créée par le test avec `tempfile`)

```rust
#[tokio::test] async fn lists_tables_and_views() { /* create table customers, view big; assert list_objects(None) == [customers(Table), big(View)] trié par nom */ }
#[tokio::test] async fn fetch_page_sorts_and_paginates() { /* 25 lignes id 1..25; page limit 10 offset 10 sort id desc → ids 15..6 */ }
#[tokio::test] async fn weird_identifier_table_opens() { /* create table "My ""Table""" (x); fetch_page sur ObjectRef{name: r#"My "Table""#} → 1 ligne */ }
#[tokio::test] async fn maps_types_and_null_vs_empty() { /* select NULL, '', 42, 1.5, x'00ff' → Null, Text(""), Int(42), Float(1.5), Bytes{len:2,hex_preview:"00ff"} */ }
#[tokio::test] async fn long_text_cell_is_truncated() { /* insert 3 MB text; fetch_page → LongText{len: 3_000_000} */ }
#[tokio::test] async fn execute_ddl_returns_rows_affected_without_result() { /* insert 3 rows → result None, rows_affected Some(3) */ }
#[tokio::test] async fn cancel_interrupts_long_query() { /* spawn execute(recursive CTE infinie); sleep 200ms; canceller().cancel(); assert kind == Cancelled en < 2 s */ }
#[tokio::test] async fn missing_file_is_not_found() { /* connect_sqlite("/nonexistent/x.db") → NotFound */ }
```

- [ ] **Step 2: Lancer et constater l'échec** — `cargo test --manifest-path src-tauri/Cargo.toml --test sqlite_driver` → FAIL.
- [ ] **Step 3: Implémenter `driver/sqlite.rs`** selon les Interfaces.
- [ ] **Step 4: Relancer** → PASS.
- [ ] **Step 5: Commit** — `✨ feat(driver): add SQLite session`

---

### Task 4: Driver PostgreSQL

**Files:**
- Create: `src-tauri/src/driver/postgres.rs`, `src-tauri/tests/common/mod.rs`
- Modify: `src-tauri/src/driver/mod.rs` (dispatch `Postgres`)
- Test: `src-tauri/tests/postgres_driver.rs`

**Interfaces:**
- Consumes: Task 2.
- Produces: `pub async fn connect_postgres(p: &ConnectParams) -> AppResult<Arc<dyn Session>>` (TLS non configuré en Plan 1 → `NoTls` ; le Plan 2 ajoute rustls). `tests/common/mod.rs` : `pub fn pg_urls() -> Vec<String>` et `pub fn mysql_urls() -> Vec<String>` qui lisent `TABLEMAX_TEST_PG_URLS` / `TABLEMAX_TEST_MYSQL_URLS` et **paniquent** avec « run `pnpm test:rust` (scripts/test-dbs.sh up) » si absentes ; `pub fn params_from_url(url: &str, kind: DriverKind) -> ConnectParams`. Chaque test boucle sur toutes les URLs (matrice de versions) et travaille dans un schéma unique `t_<uuid>` supprimé à la fin.
- Mapping : `bool`→`Bool` ; `int2/int4/int8`→`Int` ; `float4/float8`→`float_value` ; `numeric`→`Decimal` (texte exact) ; `text/varchar/bpchar/name`→`text_value` ; `uuid`, `inet`, types inconnus, enums, tableaux → représentation texte PG (`Text`) ; `json/jsonb`→`Json` ; `bytea`→`bytes_value` ; `date/time/timestamp/timestamptz/interval`→`Temporal` (format texte PG). Implémentation conseillée : `simple_query` pour `execute` (renvoie tout en texte → re-typage via OID des colonnes obtenu par `prepare` quand l'instruction est unique) — au choix du constructeur tant que les tests passent.
- `list_schemas` exclut `pg_catalog`, `information_schema`, `pg_toast%`. `count_rows` : estimation `reltuples` si > seuil, sinon `count(*)`. Canceller : `client.cancel_token().cancel_query(NoTls)`. Erreur d'auth (SQLSTATE `28P01`) → `Auth` ; connexion fermée → `ConnectionLost` ; SQLSTATE `57014` → `Cancelled`.

- [ ] **Step 1: Écrire les tests qui échouent**

```rust
#[tokio::test] async fn pg_maps_types_exactly() { /* select 1::int8, 9223372036854775807::int8, 12345678901234567890.1234567890::numeric(38,10), 'NaN'::float8, true, '{"a":1}'::jsonb, '\x00ff'::bytea, ''::text, null::text, '2026-10-16 12:00:00+00'::timestamptz
   → Int(1), Int(i64::MAX), Decimal("12345678901234567890.1234567890"), Text("NaN"), Bool(true), Json(r#"{"a": 1}"#), Bytes{len:2,hex_preview:"00ff"}, Text(""), Null, Temporal(_) */ }
#[tokio::test] async fn pg_lists_schemas_and_objects() { /* schéma de test contient table t et vue v ; list_schemas contient le schéma de test et pas pg_catalog */ }
#[tokio::test] async fn pg_fetch_page_sort_desc() { /* 25 lignes, limit 5 offset 0 sort id desc → 25..21 */ }
#[tokio::test] async fn pg_wrong_password_is_auth_error() { /* kind == Auth */ }
#[tokio::test] async fn pg_cancel_long_query() { /* execute("select pg_sleep(30)"); cancel après 300 ms → Cancelled en < 3 s */ }
#[tokio::test] async fn pg_terminated_backend_reports_connection_lost() { /* depuis une 2e session: pg_terminate_backend(pid de la 1re); 1re execute("select 1") → ConnectionLost, pas de blocage (timeout test 5 s) */ }
```

- [ ] **Step 2: Lancer et constater l'échec** — `pnpm test:rust -- --test postgres_driver` → FAIL.
- [ ] **Step 3: Implémenter `driver/postgres.rs` et `tests/common/mod.rs`.**
- [ ] **Step 4: Relancer** → PASS.
- [ ] **Step 5: Commit** — `✨ feat(driver): add PostgreSQL session`

---

### Task 5: Driver MySQL / MariaDB

**Files:**
- Create: `src-tauri/src/driver/mysql.rs`
- Modify: `src-tauri/src/driver/mod.rs` (dispatch `MySql` et `MariaDb`)
- Test: `src-tauri/tests/mysql_driver.rs` (boucle sur MySQL 8 **et** MariaDB 11 via `mysql_urls()`)

**Interfaces:**
- Consumes: Task 2, `tests/common` (Task 4).
- Produces: `pub async fn connect_mysql(p: &ConnectParams) -> AppResult<Arc<dyn Session>>`. `server_version()` = `SELECT VERSION()` (contient « MariaDB » pour MariaDB). `list_schemas` = bases hors `mysql`, `information_schema`, `performance_schema`, `sys`. `list_objects(Some(db))` via `information_schema.TABLES` (`BASE TABLE`→Table, `VIEW`→View). `count_rows` : `TABLE_ROWS` comme estimation si > seuil, sinon `COUNT(*)`. Canceller : nouvelle connexion avec les mêmes paramètres qui exécute `KILL QUERY <connection_id>` (id lu à la connexion) ; erreur 1317 → `Cancelled`. Erreur 1045 → `Auth`. Requêtes en protocole texte pour `execute` (multi-types fiables), re-typage par `column_type` : entiers signés→`Int`, `BIGINT UNSIGNED` > `i64::MAX`→`BigInt`, `DECIMAL`→`Decimal`, `FLOAT/DOUBLE`→`float_value`, `JSON`→`Json`, `BLOB/BINARY/VARBINARY/BIT`→`bytes_value`, `DATE/TIME/DATETIME/TIMESTAMP/YEAR`→`Temporal`, texte→`text_value`, `NULL`→`Null`. Les valeurs de chaînes non UTF-8 → `bytes_value`.

- [ ] **Step 1: Écrire les tests qui échouent**

```rust
#[tokio::test] async fn mysql_maps_types_exactly() { /* table avec bigint unsigned = 18446744073709551615, decimal(38,10)=12345678901234567890.1234567890, json '{"a":1}', blob 0x00FF, varchar '' et NULL, datetime '2026-10-16 12:00:00'
   → BigInt("18446744073709551615"), Decimal("12345678901234567890.1234567890"), Json(_), Bytes{len:2,hex_preview:"00ff"}, Text(""), Null, Temporal("2026-10-16 12:00:00") — sur chaque URL */ }
#[tokio::test] async fn mysql_lists_databases_and_objects() { /* base de test contient table + vue */ }
#[tokio::test] async fn mysql_reserved_word_table() { /* table `order`; fetch_page sort id desc OK */ }
#[tokio::test] async fn mysql_cancel_long_query() { /* execute("select sleep(30)") ; cancel après 300 ms → Cancelled en < 3 s */ }
#[tokio::test] async fn mysql_wrong_password_is_auth_error() { /* kind == Auth */ }
```

- [ ] **Step 2: Lancer et constater l'échec** — `pnpm test:rust -- --test mysql_driver` → FAIL.
- [ ] **Step 3: Implémenter `driver/mysql.rs`.**
- [ ] **Step 4: Relancer** → PASS sur MySQL 8 et MariaDB 11.
- [ ] **Step 5: Commit** — `✨ feat(driver): add MySQL/MariaDB session`

---

### Task 6: Secrets et stockage des connexions

**Files:**
- Create: `src-tauri/src/secrets.rs`, `src-tauri/src/store.rs`
- Test: tests unitaires dans `store.rs` et `secrets.rs`

**Interfaces:**
- Produces (`secrets.rs`) :
  - `pub enum SecretKind { DbPassword, SshPassword, SshPassphrase }` ; `pub struct SecretKey { pub connection_id: String, pub kind: SecretKind }` → service `"dev.tablemax.app"`, username `"{connection_id}:{kind}"` (`db_password`, `ssh_password`, `ssh_passphrase`).
  - `pub trait SecretStore: Send + Sync { fn available(&self) -> bool; fn set(&self, key: &SecretKey, value: &str) -> AppResult<()>; fn get(&self, key: &SecretKey) -> AppResult<Option<String>>; fn delete(&self, key: &SecretKey) -> AppResult<()>; }` (`get` d'une entrée absente → `Ok(None)` ; `delete` d'une entrée absente → `Ok(())` ; échec du trousseau → `ErrorKind::Secret`).
  - `pub struct KeyringSecretStore;` (crate `keyring` 4.2, `keyring::Entry::new(service, username)`, `available()` = `keyring::Entry::store_status().is_ok()`) ; `pub struct MemorySecretStore` (tests).
- Produces (`store.rs`) :
  - `pub enum EnvTag { Local, Dev, Staging, Prod }` ; `pub enum PasswordMode { Keyring, Ask, None }`
  - `pub struct ConnectionConfig { pub id: String, pub name: String, pub color: String, pub env_tag: EnvTag, pub kind: DriverKind, pub host: String, pub port: u16, pub user: String, pub database: Option<String>, pub sqlite_path: Option<String>, pub password_mode: PasswordMode, pub group: Option<String> }` (serde camelCase ; **aucun champ secret**).
  - `pub struct ConnectionStore` : `open(path: &Path) -> AppResult<Self>` (crée `app.db`, migration `PRAGMA user_version`), `list() -> AppResult<Vec<ConnectionConfig>>` (tri par nom insensible à la casse), `get(id) -> AppResult<ConnectionConfig>` (absent → `NotFound`), `upsert(&ConnectionConfig) -> AppResult<()>`, `delete(id) -> AppResult<()>`. Colonnes stockées : un JSON du `ConnectionConfig` + `id`, `name`.
  - `pub fn save_connection(store: &ConnectionStore, secrets: &dyn SecretStore, cfg: ConnectionConfig, password: Option<String>) -> AppResult<ConnectionConfig>` : génère un `id` UUID v4 si vide ; si `password_mode == Keyring` et `password` fourni → `secrets.set` ; si mode ≠ `Keyring` → supprime le secret existant.
  - `pub fn delete_connection(store, secrets, id) -> AppResult<()>` : supprime la ligne **et** tous les `SecretKind` de la connexion.

- [ ] **Step 1: Écrire les tests qui échouent**

```rust
#[test] fn save_roundtrip_and_sorted_list() { /* 2 connexions "b", "A" → list() == ["A","b"] ; get(id) == cfg */ }
#[test] fn password_goes_to_secret_store_not_disk() { /* save_connection(..., Some("s3cr3t-PW")) ; MemorySecretStore contient la valeur ; std::fs::read(app.db) ne contient pas les octets "s3cr3t-PW" */ }
#[test] fn switching_to_ask_mode_deletes_secret() { /* save Keyring+pw puis save Ask sans pw → get(DbPassword) == None */ }
#[test] fn delete_connection_removes_all_secrets() { /* 3 SecretKind présents → tous None après delete */ }
#[test] fn get_missing_is_not_found() { /* kind == NotFound */ }
```

- [ ] **Step 2: Lancer et constater l'échec** — `cargo test --manifest-path src-tauri/Cargo.toml --lib store` → FAIL.
- [ ] **Step 3: Implémenter `secrets.rs` et `store.rs`.**
- [ ] **Step 4: Relancer** → PASS.
- [ ] **Step 5: Commit** — `✨ feat(store): persist connections with secrets in OS keyring`

---

### Task 7: SessionManager et commandes Tauri

**Files:**
- Create: `src-tauri/src/manager.rs`, `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (état géré, `generate_handler!`), `src-tauri/capabilities/default.json`
- Test: tests dans `manager.rs` (SQLite + `MemorySecretStore`, sans runtime Tauri)

**Interfaces:**
- Consumes: Tasks 2–6.
- Produces (`manager.rs`) :
  - `pub struct SessionManager` : `new(store: Arc<ConnectionStore>, secrets: Arc<dyn SecretStore>) -> Self`.
  - `pub async fn test_connection(&self, cfg: &ConnectionConfig, password: Option<String>) -> AppResult<String>` (version serveur ; ferme la connexion).
  - `pub async fn open_workspace(&self, connection_id: &str, password: Option<String>) -> AppResult<WorkspaceInfo>` : mot de passe = argument, sinon trousseau si `Keyring` ; mode `Ask` sans argument → `AppError::new(Auth, "password required")`. `pub struct WorkspaceInfo { pub workspace_id: String, pub connection_id: String, pub dialect: Dialect, pub server_version: String }`.
  - `pub async fn close_workspace(&self, workspace_id: &str) -> AppResult<()>` (ferme aussi ses sessions SQL).
  - `pub fn browse(&self, workspace_id: &str) -> AppResult<Arc<dyn Session>>` (connexion de navigation).
  - `pub async fn open_sql_session(&self, workspace_id: &str) -> AppResult<String>` (nouvelle connexion dédiée, mêmes paramètres) ; `close_sql_session(session_id)`.
  - `pub async fn execute_batch(&self, session_id: &str, statements: Vec<String>, sink: impl Fn(ExecEvent) + Send + Sync) -> AppResult<()>` : exécute dans l'ordre ; à la première erreur émet `StatementFailed` et s'arrête ; termine toujours par `BatchFinished { cancelled }`. Un seul lot à la fois par session (sinon `Invalid`, « a query is already running »).
  - `pub async fn cancel(&self, session_id: &str) -> AppResult<()>`.
  - `#[serde(tag = "event", content = "data", rename_all = "camelCase", rename_all_fields = "camelCase")] pub enum ExecEvent { StatementStarted { index: usize }, StatementFinished { index: usize, outcome: StatementOutcome }, StatementFailed { index: usize, error: AppError }, BatchFinished { cancelled: bool } }`
  - Verrous : ne jamais tenir le verrou de la table des sessions pendant un `execute` (stocker `Arc<dyn Session>` + `Arc<dyn Canceller>`).
- Produces (`commands.rs`, noms exacts exposés au frontend) : `connections_list`, `connection_save(config, password)`, `connection_delete(id)`, `connection_test(config, password)`, `workspace_open(connectionId, password)`, `workspace_close(workspaceId)`, `schemas_list(workspaceId)`, `objects_list(workspaceId, schema)`, `table_page(workspaceId, request)`, `table_count(workspaceId, object)`, `sql_session_open(workspaceId)`, `sql_session_close(sessionId)`, `sql_execute(sessionId, statements, onEvent: Channel<ExecEvent>)`, `sql_cancel(sessionId)`. Toutes `async`, renvoient `Result<_, AppError>`. Le `ConnectionStore` vit dans `app.path().app_data_dir()/app.db`.

- [ ] **Step 1: Écrire les tests qui échouent**

```rust
#[tokio::test] async fn open_workspace_and_browse_sqlite() { /* config SQLite → open_workspace → browse().list_objects(None) non vide */ }
#[tokio::test] async fn ask_mode_without_password_is_auth_error() { /* PasswordMode::Ask, kind Postgres, password None → kind == Auth, aucun appel réseau */ }
#[tokio::test] async fn execute_batch_stops_at_error() { /* ["select 1","select * from nope","select 2"] → events: Started0, Finished0, Started1, Failed1, BatchFinished{cancelled:false} ; pas d'index 2 */ }
#[tokio::test] async fn sql_sessions_are_isolated() { /* session A: "create temp table t(x)"; session B: "select * from t" → Failed (temp table invisible) */ }
#[tokio::test] async fn cancel_marks_batch_cancelled() { /* recursive CTE infinie ; cancel ; dernier event BatchFinished{cancelled:true} */ }
#[tokio::test] async fn concurrent_batch_on_same_session_is_rejected() { /* 2e execute_batch pendant le 1er → Invalid */ }
#[tokio::test] async fn close_workspace_closes_its_sql_sessions() { /* après close, execute_batch(session) → NotFound */ }
```

- [ ] **Step 2: Lancer et constater l'échec** — `cargo test --manifest-path src-tauri/Cargo.toml --lib manager` → FAIL.
- [ ] **Step 3: Implémenter `manager.rs`, `commands.rs`, enregistrement dans `lib.rs`.** Capabilities : uniquement `core:default` (pas de fs/shell/http).
- [ ] **Step 4: Relancer + compiler l'app** — tests PASS ; `pnpm tauri build --debug --no-bundle` OK.
- [ ] **Step 5: Commit** — `✨ feat(ipc): add session manager and Tauri commands`

---

### Task 8: Frontend — couche IPC et gestion des connexions

**Files:**
- Create: `src/lib/types.ts`, `src/lib/ipc.ts`, `src/stores/connections.ts`, `src/features/connections/ConnectionList.tsx`, `src/features/connections/ConnectionForm.tsx`, `src/features/connections/PasswordPrompt.tsx`, `src/App.tsx` (layout : liste à gauche, contenu à droite)
- Test: `src/features/connections/ConnectionForm.test.tsx`, `src/stores/connections.test.ts`

**Interfaces:**
- Consumes: commandes de la Task 7.
- Produces :
  - `types.ts` : miroirs TS exacts des types Rust sérialisés (`CellValue`, `ConnectionConfig`, `DriverKind`, `EnvTag`, `PasswordMode`, `DbObject`, `ObjectRef`, `ResultSet`, `StatementOutcome`, `PageRequest` (avec `sort: [string, "asc" | "desc"] | null`), `RowCount`, `ExecEvent`, `AppError`, `WorkspaceInfo`, `Dialect`).
  - `ipc.ts` : une fonction par commande, mêmes noms en camelCase (`connectionsList()`, `connectionSave(config, password)`, …, `sqlExecute(sessionId, statements, onEvent: (e: ExecEvent) => void)` via `new Channel<ExecEvent>()`). Les erreurs rejetées sont des `AppError`.
  - `useConnections` (Zustand) : `items`, `load()`, `save(cfg, password)`, `remove(id)`.
  - Formulaire : nom, 6 couleurs, tag d'env (local/dev/staging/prod), driver ; champs host/port/user/password/database (port par défaut 5432 PG, 3306 MySQL/MariaDB) ou chemin de fichier pour SQLite ; mode mot de passe (Keyring / Ask) ; boutons **Test**, **Save**, **Connect**. En édition d'une connexion existante, le champ mot de passe est vide avec placeholder « Stored in keyring » et n'écrase le secret que s'il est rempli.
  - `PasswordPrompt` : demandé à la connexion si `Ask`, ou si le backend renvoie `Auth` « password required ».

- [ ] **Step 1: Écrire les tests qui échouent** (ipc mocké avec `vi.mock("../../lib/ipc")`)

```tsx
test("switching driver to MySQL sets default port 3306", ...)          // select driver → port input value "3306"
test("sqlite hides host fields and shows file path", ...)
test("Save sends password only when typed", ...)                       // édition: password vide → connectionSave(cfg, null)
test("Test shows server version on success and error message on Auth", ...)
test("store load sorts by name and remove drops item", ...)
```

- [ ] **Step 2: Lancer et constater l'échec** — `pnpm test` → FAIL.
- [ ] **Step 3: Implémenter** les fichiers listés.
- [ ] **Step 4: Relancer** → PASS ; `pnpm lint` OK.
- [ ] **Step 5: Commit** — `✨ feat(ui): connection list and form`

---

### Task 9: Frontend — workspaces, sidebar d'objets et onglets illimités

**Files:**
- Create: `src/stores/workspaces.ts`, `src/features/workspace/WorkspaceView.tsx`, `src/features/workspace/ObjectSidebar.tsx`, `src/features/workspace/TabBar.tsx`, `src/features/workspace/WorkspaceSwitcher.tsx`
- Test: `src/stores/workspaces.test.ts`, `src/features/workspace/ObjectSidebar.test.tsx`

**Interfaces:**
- Consumes: `ipc.ts` (Task 8).
- Produces (`useWorkspaces`) :
  - `type Tab = { id: string; kind: "table"; object: ObjectRef; title: string } | { id: string; kind: "query"; title: string; sql: string; sqlSessionId: string | null }`
  - `type Workspace = { id: string; connectionId: string; name: string; color: string; envTag: EnvTag; dialect: Dialect; schemas: string[]; currentSchema: string | null; tabs: Tab[]; activeTabId: string | null }`
  - actions : `openWorkspace(connectionId, password?)`, `closeWorkspace(id)`, `setActiveWorkspace(id)`, `setSchema(wsId, schema)`, `openTableTab(wsId, object)` (si un onglet table pour le même objet existe déjà → l'active au lieu d'en créer un), `openQueryTab(wsId)` (titre `Query 1`, `Query 2`…), `closeTab(wsId, tabId)` (onglet query : appelle `sqlSessionClose` si `sqlSessionId`), `activateTab(wsId, tabId)`. Aucune limite de nombre d'onglets.
  - `TabBar` : défilement horizontal quand les onglets débordent, bouton « + » (nouvel onglet query), fermeture au clic milieu. Raccourcis : `Ctrl+T` nouvel onglet query, `Ctrl+W` ferme l'onglet actif.
  - `ObjectSidebar` : sélecteur de schéma/base, liste tables puis vues (icônes distinctes), champ filtre (sous-chaîne insensible à la casse), clic → `openTableTab`.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test("opening the same table twice activates the existing tab", ...)
test("can open 200 tabs without limit", ...)                       // tabs.length === 200
test("closing a query tab closes its SQL session", ...)            // sqlSessionClose appelé avec l'id
test("closing active tab activates its right neighbour, else left", ...)
test("sidebar filter is case-insensitive and keeps tables before views", ...)
```

- [ ] **Step 2: Lancer et constater l'échec** — `pnpm test` → FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Relancer** → PASS.
- [ ] **Step 5: Commit** — `✨ feat(ui): workspaces, object sidebar and unlimited tabs`

---

### Task 10: Frontend — onglet Table (grille paginée, tri, comptage)

**Files:**
- Create: `src/features/grid/cellContent.ts`, `src/features/grid/DataGrid.tsx`, `src/features/grid/TableDataTab.tsx`, `src/features/grid/usePagedTable.ts`
- Test: `src/features/grid/cellContent.test.ts`, `src/features/grid/usePagedTable.test.ts`

**Interfaces:**
- Consumes: `tablePage`, `tableCount` (Task 8), `Tab` (Task 9).
- Produces :
  - `cellContent(v: CellValue): { kind: "text" | "number" | "boolean" | "null"; display: string; copyText: string }` — `Null` → display `NULL` (style atténué), `Text("")` → display `""` (chaîne vide visible, distincte de NULL), `LongText` → `preview + "…"` et `copyText = preview`, `Bytes` → `<binary 2 B> 00ff`, `BigInt`/`Decimal` affichés tels quels (aucune conversion en `number`), `Json` compact sur une ligne.
  - `usePagedTable(workspaceId, object, pageSize = 300)` → `{ result, page, pageCount, rowCount, sort, setSort(col), nextPage(), prevPage(), reload(), loading, error }`. `setSort` cycle asc → desc → aucun et revient à la page 0. `rowCount` affiché `≈ N` si `Estimate`.
  - `DataGrid` (Glide Data Grid, lecture seule) : en-têtes cliquables pour le tri avec indicateur, colonnes redimensionnables, sélection de cellules, `Ctrl+C` copie `copyText` en TSV.
  - Barre de pied : `Rows 301–600 of ≈ 1 234 567`, boutons page précédente/suivante, bouton Reload, temps de chargement.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test("NULL and empty string are displayed differently", ...)
test("bigInt and decimal keep exact digits", ...)          // "18446744073709551615" inchangé
test("long text shows ellipsis", ...)
test("sort cycles asc, desc, none and resets page", ...)
test("estimate count renders with ≈", ...)
```

- [ ] **Step 2: Lancer et constater l'échec** — `pnpm test` → FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Relancer** → PASS.
- [ ] **Step 5: Commit** — `✨ feat(ui): paginated, sortable table data grid`

---

### Task 11: Frontend — onglet SQL (éditeur, exécution, résultats, annulation)

**Files:**
- Create: `src/features/editor/splitStatements.ts`, `src/features/editor/SqlEditor.tsx`, `src/features/editor/QueryTab.tsx`, `src/features/editor/ResultsPanel.tsx`
- Test: `src/features/editor/splitStatements.test.ts`, `src/features/editor/QueryTab.test.tsx`

**Interfaces:**
- Consumes: `sqlSessionOpen`, `sqlExecute`, `sqlCancel` (Task 8), `DataGrid` + `cellContent` (Task 10), `Tab` query (Task 9).
- Produces :
  - `type Statement = { text: string; from: number; to: number }` ; `splitStatements(sql: string, dialect: Dialect): Statement[]` — sépare sur `;` hors chaînes `'…'` (avec `''` et `\'` pour MySQL), identifiants `"…"`/`` `…` ``, commentaires `--`, `#` (MySQL), `/* */`, et dollar-quoting PG (`$$…$$`, `$tag$…$tag$`) ; ignore les instructions vides ; `text` sans le `;` final, trimé. `statementAt(stmts: Statement[], cursor: number): Statement | null` (l'instruction qui contient le curseur, sinon la précédente la plus proche).
  - `QueryTab` : ouvre sa session SQL dédiée au premier run (`sqlSessionOpen`, id stocké dans le `Tab`). `Ctrl+Enter` : sélection si non vide, sinon instruction sous le curseur ; `Ctrl+Shift+Enter` : tout l'éditeur. Bouton **Cancel** visible pendant l'exécution (`sqlCancel`). Un sous-onglet de résultat par instruction qui renvoie un `ResultSet` ; pour les autres : message `N rows affected`. En-tête de chaque résultat : temps (`elapsedMs`) et nombre de lignes. Une erreur affiche son message et l'index de l'instruction (`Statement 2: …`) sous les résultats déjà reçus.
  - `SqlEditor` : CodeMirror 6 + `@codemirror/lang-sql` avec dialecte (`PostgreSQL`, `MySQL`, `SQLite`), numéros de ligne, thème suivant le système.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
test("splits on semicolons outside strings and comments", ...)   // "select ';'; -- a;b\nselect 2" → 2 statements
test("handles PG dollar quoting", ...)                            // "create function f() returns int as $$ select 1; $$ language sql; select 2" → 2
test("handles MySQL backticks, # comments and backslash escapes", ...)
test("statementAt picks statement under cursor", ...)
test("run shows one result tab per result set and error with index", ...) // sqlExecute mocké qui émet Started0/Finished0/Started1/Failed1/BatchFinished
test("cancel button calls sqlCancel while running", ...)
```

- [ ] **Step 2: Lancer et constater l'échec** — `pnpm test` → FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Relancer** → PASS ; `pnpm lint` OK.
- [ ] **Step 5: Vérification manuelle dans l'app réelle**

Run: `scripts/test-dbs.sh up && pnpm tauri dev`
Vérifier, sur PG 16, MySQL 8 et SQLite (`/tmp/.../demo.sqlite` ou une base créée pour l'occasion) : créer et enregistrer la connexion (mot de passe visible dans Seahorse/« Mots de passe et clés » sous `dev.tablemax.app`, et **absent** de `app.db`), ouvrir le workspace, ouvrir 3 tables + 2 onglets SQL, trier, paginer, lancer `select pg_sleep(10)` / `select sleep(10)` puis Cancel.
Expected: tout fonctionne sans gel de l'UI ; noter tout écart dans le message de commit ou un fichier `docs/notes/plan-01-manual-check.md`.

- [ ] **Step 6: Commit** — `✨ feat(ui): SQL editor tab with batch execution and cancel`

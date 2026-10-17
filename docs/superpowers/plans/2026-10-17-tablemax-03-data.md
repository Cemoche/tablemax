# TableMax — Plan 3 : Données (édition, filtres, clés étrangères, structure) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dans un onglet de table, l'utilisateur filtre (constructeur ou barre rapide), modifie, insère, duplique et supprime des lignes, voit et annule chaque modification en attente avec son SQL, valide tout en une transaction (Ctrl+S) ou abandonne, suit les clés étrangères avec un fil d'Ariane, consulte le détail d'une ligne, copie une sélection en TSV/CSV/JSON/INSERT, et lit la structure de la table (colonnes, index, clés étrangères, DDL).

**Architecture:** Le backend gagne un modèle de métadonnées (`TableInfo`) fourni par chaque driver, et un module `driver/query.rs` **commun** qui construit des requêtes **paramétrées** (`Statement { sql, params }`) : pages filtrées et triées, comptes filtrés plafonnés, et DML (UPDATE/INSERT/DELETE ciblés par clé). Les drivers n'exécutent que des `Statement` (`query`, `apply` en transaction). Le `SessionManager` met `TableInfo` en cache par workspace. Le frontend garde, par onglet, la vue (page, tri, filtres, fil d'Ariane) et les modifications en attente dans des stores Zustand, édite dans Glide Data Grid, et demande au backend l'aperçu SQL et l'application des modifications.

**Tech Stack:** existant (Tauri 2.12, Rust 1.96 edition 2024, tokio-postgres 0.7, mysql_async 0.37, rusqlite 0.40, React 19, Zustand 5, Tailwind 4, `@glideapps/glide-data-grid` 6, Vitest). Aucune nouvelle dépendance requise.

**Spec:** `docs/superpowers/specs/2026-10-16-tablemax-design.md` (§2 « Données (grille) » et « Structure », §4, §6 bis « Résultats de l'éditeur SQL en lecture seule ») · suivis : `docs/notes/plan-01-followups.md`, `docs/notes/plan-02-followups.md`.

## Global Constraints

- Tout ce qui précède reste valable : chaînes visibles dans `src/lib/strings.ts`, couleurs par tokens (`src/styles/tokens.css`) uniquement, I/O asynchrone et annulable, secrets jamais exposés, commits `<emoji> <type>(<scope>): <description>` + trailer, aucune dépendance native nouvelle (`cargo tree -i aws-lc-sys` vide).
- **Toute valeur saisie par l'utilisateur part en paramètre lié**, jamais concaténée dans le SQL — sauf l'opérateur explicite « Raw SQL » du filtre (texte de l'utilisateur inséré tel quel entre parenthèses, c'est sa base) et l'aperçu SQL affiché (rendu avec littéraux échappés, **jamais exécuté**).
- Identifiants (tables, colonnes, schémas) toujours via `quote_ident`/`qualified`.
- Typage des paramètres : PostgreSQL lie chaque valeur texte comme `CAST($n::text AS <type>)` où `<type>` est `format_type(atttypid, atttypmod)` lu dans le catalogue ; MySQL et SQLite lient le texte tel quel (`?`). Les octets sont liés nativement (`$n`/`?`).
- Pages : `DEFAULT_PAGE_SIZE = 300`. Sans tri explicite, l'ordre est stabilisé par la clé primaire (ou `rowid` pour une table SQLite qui en a un), sinon aucun ORDER BY.
- Comptes : sans filtre, comportement actuel (`EXACT_COUNT_THRESHOLD = 500_000`, estimation au-delà). Avec filtres : `SELECT COUNT(*) FROM (SELECT 1 FROM t WHERE … LIMIT 500001)` → `Exact(n)` si n ≤ 500 000, sinon `Estimate(500000)` affiché « 500,000+ ».
- Édition autorisée seulement pour une **table** ayant une clé primaire, ou à défaut un index unique dont toutes les colonnes sont `NOT NULL` (la « clé de ligne ») ; vues et tables sans clé : lecture seule avec explication (`strings.grid.readOnlyNoKey` / `readOnlyView`).
- Une modification UPDATE/DELETE doit toucher **exactement une ligne**, sinon toute la transaction est annulée (« the row changed or was deleted since it was loaded »). MySQL se connecte avec `CLIENT_FOUND_ROWS` pour que « lignes touchées » compte les lignes trouvées (même sémantique que PG/SQLite).
- Valeurs tronquées (`LongText`, `Json` coupé, `Bytes` > 64 octets) : l'éditeur charge la valeur complète avant d'éditer (`cell_value`) ; les octets ne s'éditent pas en v1 (lecture seule, explication) ; une colonne d'octets dont l'aperçu est tronqué ne peut pas servir de clé de ligne.
- Résultats de l'éditeur SQL : toujours en lecture seule (spec §6 bis).
- Le safe mode (plan 5) s'insérera avant l'application : `changes_apply` reste l'unique point d'entrée des écritures depuis la grille.

## Review Focus

1. **Identifiants piégeux et types variés à l'édition** (table `order`, colonne `My "Col"`, `` we`ird ``, majuscules ; `numeric(12,2)`, `bigint` > 2^53, `boolean`, `json/jsonb`, `date`/`timestamptz`, `uuid`, enum MySQL) : l'UPDATE produit exactement la valeur saisie, relue identique → tests `edits_round_trip_types` par moteur (Task 3).
2. **Modification concurrente** (la ligne a changé ou disparu entre chargement et commit) : rien n'est écrit, erreur claire sur la modification fautive, les autres modifications restent en attente → test `stale_row_rolls_back_everything` (Task 3) + test UI (Task 5).
3. **NULL vs chaîne vide vs DEFAULT** à l'édition et à l'insertion : le choix est explicite dans l'éditeur (raccourcis « Set NULL », « Set DEFAULT » pour l'insertion), l'aperçu SQL le montre, la base le reçoit tel quel → tests (Tasks 3, 4).
4. **Valeur tronquée éditée** (TEXT de 50 000 caractères, JSON imbriqué) : l'éditeur charge la valeur complète, et l'enregistrer ne tronque jamais la donnée → test `editing_long_text_keeps_full_value` (Task 3 backend + Task 4 UI).
5. **Filtre avec valeur hostile ou mal typée** (`'; drop table x; --`, `abc` sur une colonne entière, `%`/`_` dans « contains ») : la valeur est liée, l'erreur de type est claire et la table intacte ; `%`/`_` sont échappés pour contains/not contains → tests `filters_bind_values` (Task 2).

---

### Task 1: Métadonnées de table et DDL (backend)

**Files:**
- Create: `src-tauri/src/driver/meta.rs` (types), `src-tauri/tests/table_info.rs`
- Modify: `src-tauri/src/driver/mod.rs` (trait `Session`), `postgres.rs`, `mysql.rs`, `sqlite.rs`, `src-tauri/src/manager.rs` (cache + accès), `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`; déplacer la résolution de cible SSH (`resolve_ssh_target`, `home_dir`, `non_empty`) de `manager.rs` vers `src-tauri/src/ssh/target.rs` sans changement de comportement (le manager dépasse 2000 lignes).

**Interfaces:**
- Produces (`meta.rs`, serde camelCase, `Serialize + Deserialize + Clone + PartialEq + Debug`) :
  - `pub struct ColumnInfo { pub name: String, pub type_name: String /* PG: format_type ; MySQL: COLUMN_TYPE ; SQLite: type déclaré */, pub nullable: bool, pub default: Option<String>, pub auto_increment: bool /* serial/identity/AUTO_INCREMENT/INTEGER PRIMARY KEY */, pub generated: bool /* colonne générée : jamais éditable */, pub comment: Option<String> }`
  - `pub struct IndexInfo { pub name: String, pub columns: Vec<String>, pub unique: bool, pub primary: bool, pub definition: Option<String> }`
  - `pub struct ForeignKeyInfo { pub name: String, pub columns: Vec<String>, pub ref_schema: Option<String>, pub ref_table: String, pub ref_columns: Vec<String>, pub on_update: String, pub on_delete: String }`
  - `pub struct TableInfo { pub object: ObjectRef, pub kind: ObjectKind, pub columns: Vec<ColumnInfo>, pub primary_key: Vec<String>, pub indexes: Vec<IndexInfo>, pub foreign_keys: Vec<ForeignKeyInfo>, pub row_key: Option<Vec<String>> /* PK, sinon premier index unique entièrement NOT NULL (ordre: nom), sinon None */, pub has_rowid: bool /* SQLite : table avec rowid */ }`
  - `impl TableInfo { pub fn editable(&self) -> bool /* kind Table && row_key.is_some() */; pub fn column(&self, name: &str) -> Option<&ColumnInfo> }`
- Produces (trait `Session`) : `async fn table_info(&self, obj: &ObjectRef) -> AppResult<TableInfo>` ; `async fn table_ddl(&self, obj: &ObjectRef) -> AppResult<String>`. Objet absent → `ErrorKind::NotFound`.
  - PG : `pg_attribute`/`pg_class`/`pg_index`/`pg_constraint` (+ `format_type`, `pg_get_expr` pour les défauts, `attidentity`, `attgenerated`, `col_description`) ; DDL d'une vue = `CREATE VIEW … AS ` + `pg_get_viewdef` ; DDL d'une table reconstruit : `CREATE TABLE` avec colonnes (type, `NOT NULL`, `DEFAULT`, identity/generated), puis contraintes (`pg_get_constraintdef`), puis `CREATE INDEX` des index non liés à une contrainte (`pg_get_indexdef`), puis `COMMENT ON`.
  - MySQL/MariaDB : `information_schema.COLUMNS` (`COLUMN_TYPE`, `EXTRA` pour auto_increment et `GENERATED`), `STATISTICS`, `KEY_COLUMN_USAGE` + `REFERENTIAL_CONSTRAINTS` ; DDL = `SHOW CREATE TABLE` / `SHOW CREATE VIEW`.
  - SQLite : `pragma_table_xinfo` (colonnes cachées/générées), `pragma_index_list` + `pragma_index_info`, `pragma_foreign_key_list` ; `has_rowid` = pas `WITHOUT ROWID` et pas une vue ; DDL = `sql` de `sqlite_schema` pour la table/vue puis ses index et triggers.
- Produces (manager/commands) : `SessionManager::table_info(ws, obj) -> AppResult<Arc<TableInfo>>` avec cache par `(workspace, object)`, `invalidate_table_info(ws, obj)` ; commandes `table_info(workspaceId, object, refresh: bool)` et `table_ddl(workspaceId, object)`.

- [ ] **Step 1: Tests d'intégration qui échouent** (`tests/table_info.rs`, une fonction par moteur pour chaque cas, sur un schéma créé par le test avec : `parent(id serial/AUTO_INCREMENT PK, code text unique not null)`, `"order"(id, parent_id FK → parent(id) ON DELETE CASCADE, "My ""Col""" text, amount numeric(12,2) default 0, note text, total generated/virtual)`, une table `nokey(a int, b text)`, une table `uniq(a int not null, b int, unique(a))`, une vue `v_order`) :
  - `columns_types_and_flags` : types (`numeric(12,2)` / `decimal(12,2)` / `NUMERIC(12,2)`), `nullable`, défaut `0`, `auto_increment` sur l'id, `generated` sur la colonne générée, commentaire (PG/MySQL).
  - `primary_and_row_key` : `"order"` → `primary_key == ["id"]`, `row_key == Some(["id"])` ; `uniq` → `row_key == Some(["a"])` ; `nokey` → `None` et `editable() == false` ; la vue → `kind == View`, non éditable.
  - `foreign_keys` : nom, colonnes, table référencée, `on_delete == "CASCADE"`.
  - `indexes` : l'index unique sur `parent.code` est `unique`, la PK est `primary`.
  - `ddl_mentions_columns_and_constraints` : le DDL de `"order"` contient le nom de colonne échappé, `REFERENCES`, et pour PG le `CREATE INDEX` d'un index secondaire ; celui de la vue commence par `CREATE` et contient `VIEW`.
  - `missing_table_is_not_found`.
  - Cache : test unitaire du manager avec une session factice comptant les appels (`table_info` deux fois → un appel driver ; `refresh: true` → un appel de plus).
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test:rust` → Expected: échec de compilation.
- [ ] **Step 3: Implémenter** (dont le déplacement de la résolution SSH, couvert par ses tests existants déplacés).
- [ ] **Step 4: Vérifier** — Run: `pnpm test:rust && pnpm lint` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(driver): table metadata and DDL for PostgreSQL, MySQL and SQLite`

---

### Task 2: Requêtes paramétrées, filtres et comptes filtrés (backend)

**Files:**
- Create: `src-tauri/src/driver/query.rs`, `src-tauri/tests/filters.rs`
- Modify: `src-tauri/src/driver/mod.rs` (`PageRequest`, trait), `sql.rs` (garde `quote_ident`/`qualified` ; `build_page_query` disparaît au profit de `query.rs`), `postgres.rs`, `mysql.rs`, `sqlite.rs`, `src-tauri/src/manager.rs`, `src-tauri/src/commands.rs`

**Interfaces:**
- Produces (`query.rs`) :
  - `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)] #[serde(tag = "t", content = "v", rename_all = "camelCase")] pub enum SqlParam { Text(String), Bytes(Vec<u8>) }` ; `pub struct Statement { pub sql: String, pub params: Vec<SqlParam> }` (Debug sans les valeurs : `params: <n>`).
  - `#[serde(rename_all = "camelCase")] pub enum FilterOp { Eq, Neq, Lt, Gt, Lte, Gte, In, NotIn, Between, NotBetween, Like, NotLike, Ilike, Contains, NotContains, IsNull, IsNotNull, Raw }` ; `pub struct Filter { pub column: Option<String> /* None = toutes colonnes */, pub op: FilterOp, pub values: Vec<String> }`.
  - `PageRequest` gagne `#[serde(default)] pub filters: Vec<Filter>`.
  - `pub fn build_page(d: Dialect, info: &TableInfo, req: &PageRequest) -> AppResult<Statement>` ; `pub fn build_filtered_count(d: Dialect, info: &TableInfo, filters: &[Filter], cap: u64) -> AppResult<Statement>`.
  - Règles : conditions jointes par `AND` ; `values` attendus : 0 pour `IsNull`/`IsNotNull`, 2 pour `Between`/`NotBetween`, ≥ 1 pour `In`/`NotIn`, 1 pour les autres (sinon `Invalid "filter on <col>: expected <n> value(s)"`) ; colonne inconnue → `Invalid "unknown column <col>"` ; `Ilike` hors PG → `LIKE` (MySQL : insensible à la casse par collation ; SQLite : `LIKE` déjà insensible ASCII) ; `Contains`/`NotContains` → `LIKE '%' || v || '%' ESCAPE '\'` avec `%`, `_`, `\` de la valeur échappés (MySQL : `CONCAT('%', ?, '%')`) ; `Like`/`NotLike` : motif tel quel ; colonne `None` (toutes colonnes) : seulement `Eq`, `Contains`, `NotContains`, `Like` → `(CAST(c1 AS text) <op> … OR …)` sur toutes les colonnes non binaires (MySQL `CAST(c AS CHAR)`, SQLite `CAST(c AS TEXT)`), avec `NotContains` combiné par `AND` ; `Raw` : `(<values[0]>)` tel quel, colonne ignorée ; valeur de comparaison typée selon les Global Constraints (PG `CAST($n::text AS <type>)`).
  - Ordre : tri explicite, sinon `row_key`/PK, sinon `rowid` (SQLite `has_rowid`), sinon aucun.
- Produces (trait `Session`) : `async fn query(&self, stmt: &Statement) -> AppResult<ResultSet>` (même conversion de valeurs et plafond que `fetch_page`) ; `fetch_page` et `count_rows` du trait deviennent : `fetch_page` supprimé (le manager appelle `build_page` + `query`), `count_rows` conservé pour le cas **sans filtre**.
- Produces (manager/commands) : `table_page(workspaceId, request)` (filtres inclus) ; `table_count(workspaceId, object, filters)` → sans filtre : `count_rows` ; avec : `build_filtered_count(…, 500_001)` → `Exact(n)` ou `Estimate(500000)`.

- [ ] **Step 1: Tests unitaires qui échouent** (`query.rs`, chaînes SQL exactes par dialecte) :
```rust
#[test] fn eq_filter_casts_on_postgres() {
    // info: colonne "amount" type "numeric(12,2)"
    let s = build_page(Dialect::Postgres, &info, &req_with(vec![f("amount", FilterOp::Eq, &["10.5"])])).unwrap();
    assert_eq!(s.sql, r#"SELECT * FROM "public"."order" WHERE "amount" = CAST($1::text AS numeric(12,2)) ORDER BY "id" LIMIT 300 OFFSET 0"#);
    assert_eq!(s.params, vec![SqlParam::Text("10.5".into())]);
}
#[test] fn contains_escapes_wildcards() { /* MySQL: "`note` LIKE CONCAT('%', ?, '%') ESCAPE '\\\\'" et param "50\\%" pour "50%" */ }
#[test] fn in_between_null_and_raw() { /* IN avec 3 params ; BETWEEN 2 ; IS NULL sans param ; Raw entre parenthèses */ }
#[test] fn any_column_contains_skips_binary_columns() {}
#[test] fn wrong_value_count_is_invalid() {}
#[test] fn unknown_column_is_invalid() {}
#[test] fn default_order_uses_row_key_then_rowid() {}
#[test] fn filtered_count_is_capped() { /* "SELECT COUNT(*) FROM (SELECT 1 FROM … WHERE … LIMIT 500001) AS t" */ }
#[test] fn statement_debug_hides_params() {}
```
- [ ] **Step 2: Tests d'intégration qui échouent** (`tests/filters.rs`, par moteur, sur la base de démo construite par le test) : `filters_bind_values` (`'; drop table x; --` en `Eq` → 0 ligne, table intacte ; `abc` sur une colonne entière → `ErrorKind::Query` côté PG, 0 ligne ou erreur claire côté MySQL/SQLite — documenter le comportement observé dans le test) ; `contains_matches_literal_percent` ; `in_and_between` ; `any_column_contains` ; `filtered_count_exact_and_capped` (avec un cap de test réduit) ; `pagination_is_stable_without_sort`.
- [ ] **Step 3: Vérifier l'échec** — Run: `pnpm test:rust` → Expected: FAIL.
- [ ] **Step 4: Implémenter.**
- [ ] **Step 5: Vérifier** — Run: `pnpm test:rust && pnpm lint && pnpm test` → Expected: PASS (le frontend envoie encore des pages sans filtres : `filters` a `serde(default)`).
- [ ] **Step 6: Commit** — `✨ feat(driver): parameterized pages with filters and capped filtered counts`

---

### Task 3: Modifications : aperçu, application en transaction, valeur complète (backend)

**Files:**
- Create: `src-tauri/src/driver/dml.rs`, `src-tauri/tests/edits.rs`
- Modify: `src-tauri/src/value.rs` (`CellValue: Deserialize`), `src-tauri/src/driver/mod.rs` (trait), `postgres.rs`, `mysql.rs` (`client_found_rows(true)`), `sqlite.rs`, `src-tauri/src/manager.rs`, `src-tauri/src/commands.rs`

**Interfaces:**
- Produces (`dml.rs`, serde camelCase) :
  - `#[serde(tag = "t", content = "v", rename_all = "camelCase")] pub enum EditValue { Null, Default, Text(String) }` (`Default` seulement pour une insertion).
  - `pub struct RowKey(pub Vec<(String, CellValue)>)` (sérialisé en tableau de paires) — valeurs d'origine des colonnes de `row_key`.
  - `#[serde(tag = "kind", rename_all = "camelCase")] pub enum RowChange { Update { key: RowKey, set: Vec<(String, EditValue)> }, Insert { values: Vec<(String, EditValue)> }, Delete { key: RowKey } }`.
  - `pub fn build_change(d: Dialect, info: &TableInfo, c: &RowChange) -> AppResult<Statement>` : refuse si `!info.editable()` (`Invalid "table is read-only: <raison>"`), colonne inconnue ou générée, `Default` hors insertion, clé incomplète ou dont une valeur est `Null`/`LongText`/`Bytes` tronqué (`len > 64`) ; clé `Bytes` complète → `SqlParam::Bytes` (hex décodé) ; autres valeurs de clé converties en texte (`Int`, `BigInt`, `Decimal`, `Float` en représentation aller-retour, `Bool` → `true`/`false` PG, `1`/`0` MySQL/SQLite, `Text`, `Temporal`, `Json`) ; colonnes `Insert` avec `Default` omises (si toutes omises : `INSERT … DEFAULT VALUES`, MySQL `INSERT … () VALUES ()`).
  - `pub fn render_preview(d: Dialect, stmt: &Statement) -> String` : remplace les paramètres par des littéraux échappés (`'…'` avec `'` doublés ; octets en `'\x…'`/`X'…'`), pour affichage uniquement.
  - `#[serde(rename_all = "camelCase")] pub struct ApplyOutcome { pub applied: bool, pub affected: Vec<u64>, pub failed_index: Option<usize>, pub error: Option<AppError> }`.
- Produces (trait `Session`) : `async fn apply(&self, stmts: &[Statement], expect_one: &[bool]) -> AppResult<ApplyOutcome>` — `BEGIN`, chaque instruction, contrôle « exactement une ligne » quand `expect_one[i]` (UPDATE/DELETE), `COMMIT` ; à la première erreur ou ligne ≠ 1 : `ROLLBACK`, `applied: false`, `failed_index`, `error` (l'erreur de la base, ou, si le nombre de lignes touchées ≠ 1, `ErrorKind::Query` avec le message exact `the row changed or was deleted since it was loaded`) ; erreur de connexion → `Err`. Annulable comme `execute`.
- Produces (manager/commands) :
  - `changes_preview(workspaceId, object, changes: Vec<RowChange>) -> Vec<String>` (un SQL par changement, ou une erreur `Invalid` qui nomme l'index).
  - `changes_apply(workspaceId, object, changes) -> ApplyOutcome` (sur la connexion de navigation ; invalide le cache `TableInfo` si une erreur indique que la table a changé — sinon conservé).
  - `cell_value(workspaceId, object, key: RowKey, column) -> CellValue` : la valeur complète (sans troncature `TEXT_PREVIEW_CHARS`/JSON ; octets toujours en aperçu) ; ligne absente → `NotFound`.

- [ ] **Step 1: Tests unitaires qui échouent** (`dml.rs`) : SQL exact par dialecte pour Update/Insert/Delete (clé composite, identifiants piégeux), `Insert` tout `Default`, refus des cas listés, `render_preview` échappe `'` et n'est jamais égal au SQL paramétré.
- [ ] **Step 2: Tests d'intégration qui échouent** (`tests/edits.rs`, par moteur) :
  - `edits_round_trip_types` : UPDATE de `numeric(12,2)` (`"12.30"`), bigint `9007199254740993`, bool, json `{"a":[1,2]}`, date/timestamp, uuid (PG), enum (MySQL), texte avec `'` et unicode → relu identique via `table_page`.
  - `null_empty_and_default` : `Null` → NULL, `Text("")` → `''`, insertion avec `Default` → valeur par défaut de la base.
  - `insert_delete_duplicate` : insertion (id auto), suppression, « duplication » = insertion des valeurs d'une ligne sans les colonnes auto-incrémentées/générées.
  - `stale_row_rolls_back_everything` : deux changements, le second vise une ligne supprimée entre-temps → `applied == false`, `failed_index == Some(1)`, message exact, le premier changement n'est pas écrit.
  - `read_only_tables_refuse_changes` : vue et table sans clé → `Invalid`.
  - `editing_long_text_keeps_full_value` : `cell_value` d'un texte de 50 000 caractères renvoie tout ; un UPDATE d'une autre colonne de la même ligne laisse le texte intact.
  - `mysql_found_rows` : UPDATE qui écrit la même valeur → compte 1 (pas 0).
- [ ] **Step 3: Vérifier l'échec** — Run: `pnpm test:rust` → Expected: FAIL.
- [ ] **Step 4: Implémenter.**
- [ ] **Step 5: Vérifier** — Run: `pnpm test:rust && pnpm lint` → Expected: PASS.
- [ ] **Step 6: Commit** — `✨ feat(driver): preview and apply row changes in one transaction`

---

### Task 4: Édition dans la grille et modifications en attente (frontend)

**Files:**
- Create: `src/stores/pendingChanges.ts` (+ test), `src/features/grid/editing.ts` (+ test), `src/features/grid/CellEditorOverlay.tsx` si l'éditeur intégré de Glide ne suffit pas pour NULL/DEFAULT
- Modify: `src/lib/types.ts`, `src/lib/ipc.ts`, `src/lib/types.shape.test.ts`, `src/lib/strings.ts`, `src/features/grid/DataGrid.tsx`, `src/features/grid/TableDataTab.tsx`, `src/features/grid/usePagedTable.ts`, `src/styles/tokens.css` (tokens `--pending-edit`, `--pending-insert`, `--pending-delete`), `src/features/workspace/WorkspaceView.tsx` (raccourcis), `src/stores/workspaces.ts` (fermeture d'onglet avec modifications en attente)

**Interfaces:**
- Produces (`types.ts`/`ipc.ts`, miroir exact des Tasks 1–3) : `TableInfo`, `ColumnInfo`, `IndexInfo`, `ForeignKeyInfo`, `Filter`, `FilterOp`, `EditValue`, `RowKey` (`[string, CellValue][]`), `RowChange`, `ApplyOutcome` ; `tableInfo(ws, object, refresh)`, `tableDdl(ws, object)`, `tablePage(ws, request)` (avec `filters`), `tableCount(ws, object, filters)`, `changesPreview(ws, object, changes)`, `changesApply(ws, object, changes)`, `cellValue(ws, object, key, column)`.
- Produces (`pendingChanges.ts`) : store par onglet `{ [tabId]: PendingTab }` avec `PendingTab = { edits: Record<rowKeyId, { key: RowKey; set: Record<column, EditValue>; original: CellValue[] }>, inserts: Array<{ tempId: string; values: Record<column, EditValue> }>, deletes: Record<rowKeyId, RowKey> }` et actions `setCell(tabId, rowKey, column, value, originalRow)`, `revertCell`, `addInsert(tabId, values?)` (duplication = valeurs d'une ligne sans colonnes auto/générées), `setInsertCell`, `removeInsert`, `toggleDelete(tabId, rowKey)`, `revertChange(tabId, changeId)`, `discard(tabId)`, `toChanges(tabId): RowChange[]` (ordre : updates, inserts, deletes), `count(tabId)`. `rowKeyId = JSON.stringify(key)`. Remettre une cellule à sa valeur d'origine retire l'edit.
- `editing.ts` : `rowKeyOf(info, columns, row): RowKey | null`, `cellEditability(info, column, value): { editable: boolean; reason?: string }` (générée, octets, table non éditable), `parseEditorInput(text, { setNull, setDefault })`.
- UI :
  - Cellules éditables (`allowOverlay: true`, `readonly: false`) seulement si `info.editable()` ; double-clic/Entrée ouvre l'éditeur ; pour `LongText`/`Json` tronqué, l'éditeur attend `cellValue` (indicateur « loading… ») ; menu contextuel de cellule : « Set NULL », « Set empty string », « Set DEFAULT » (insertion seulement), « Revert cell » ; menu de ligne : « Duplicate row », « Delete row » / « Restore row ».
  - Lignes insérées affichées en tête de grille (fond `--pending-insert`), cellules modifiées `--pending-edit`, lignes supprimées `--pending-delete` + texte barré.
  - Barre d'outils de l'onglet : `+ Row`, `Commit (Ctrl+S)` et `Discard` actifs s'il y a des modifications, compteur « N pending changes » ; bannière lecture seule avec la raison si non éditable.
  - `Ctrl+S` (et `Cmd+S` sur macOS) dans un onglet de table = commit ; succès → `discard` + rechargement de la page et du compte ; échec → le changement fautif (via `failedIndex`) est marqué en erreur avec le message, rien n'est retiré.
  - Changer de page/tri/filtre avec des modifications en attente : bloqué avec un message (`strings.grid.commitOrDiscardFirst`) ; fermer l'onglet : confirmation « Discard N pending changes? ».

- [ ] **Step 1: Tests qui échouent** : `pendingChanges.test.ts` (setCell puis retour à l'original retire l'edit ; duplication sans colonnes auto/générées ; `toChanges` ordre et contenu ; toggleDelete d'une ligne modifiée garde la suppression seule) ; `editing.test.ts` (`rowKeyOf` avec PK composite, `null` si une valeur de clé est tronquée ; `cellEditability` pour générée/octets/vue) ; `TableDataTab.test.tsx` (ipc mocké : table non éditable → bannière et pas de bouton `+ Row` ; commit appelle `changesApply` avec `toChanges` puis recharge ; échec `failedIndex` → message affiché et changements conservés ; changement de page bloqué tant qu'il y a des modifications) ; `types.shape.test.ts` (formes JSON exactes des nouveaux types).
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(grid): inline editing with pending changes, commit and discard`

---

### Task 5: Panneau des modifications et détail de ligne (frontend)

**Files:**
- Create: `src/features/grid/PendingChangesPanel.tsx` (+ test), `src/features/grid/RowDetailPanel.tsx` (+ test)
- Modify: `src/features/grid/TableDataTab.tsx`, `src/lib/strings.ts`

**Interfaces:**
- `PendingChangesPanel` (panneau bas repliable, ouvert automatiquement à la première modification) : une ligne par changement (`UPDATE`/`INSERT`/`DELETE`, clé lisible `id = 42`, colonnes touchées), le SQL de `changesPreview` (rechargé avec un délai de 200 ms après chaque modification ; erreur `Invalid` affichée sur la ligne concernée), un bouton « Undo » par changement (`revertChange`), et l'erreur d'application sur le changement fautif.
- `RowDetailPanel` (panneau droit, `Ctrl+I` ou bouton « Row details ») : la ligne sélectionnée en formulaire vertical (nom de colonne, type, valeur) ; JSON mis en forme (indenté, via `cellValue` si tronqué) ; texte long complet (via `cellValue`) ; champs éditables si la table l'est (même store, mêmes règles que la grille) ; lien vers la ligne référencée pour les colonnes de clé étrangère (utilise l'action de la Task 7 si présente, sinon caché).

- [ ] **Step 1: Tests qui échouent** : le panneau liste 3 changements de types différents avec leur SQL (ipc mocké) ; « Undo » retire un changement et relance l'aperçu ; une erreur `failedIndex` s'affiche sur la bonne ligne ; le détail affiche un JSON indenté et charge la valeur complète d'un `longText` ; modifier un champ crée un edit dans le store.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(grid): pending changes panel with SQL preview and row details`

---

### Task 6: Filtres : constructeur et barre rapide (frontend)

**Files:**
- Create: `src/lib/quickFilter.ts` (+ test), `src/features/grid/FilterBar.tsx` (+ test)
- Modify: `src/stores/gridViews.ts` (`filters: Filter[]` dans la vue, remise à la page 0 quand ils changent), `src/features/grid/usePagedTable.ts` (filtres envoyés à `tablePage` et `tableCount`), `src/features/grid/TableDataTab.tsx`, `src/lib/strings.ts`

**Interfaces:**
- `parseQuickFilter(input: string, columns: string[]): { filters: Filter[]; error: string | null }` — grammaire : `cond (AND cond)*` (mot-clé `and` insensible à la casse) ; `cond := col op value | col IS [NOT] NULL | col [NOT] IN (v, v, …) | col [NOT] BETWEEN v AND v | col [NOT] LIKE v | col ILIKE v | col [NOT] CONTAINS v | any CONTAINS v` ; `op ∈ = != <> < > <= >=` ; `col` : identifiant nu, ou entre `"…"`/`` `…` `` ; `value` : nombre, mot nu, ou `'…'`/`"…"` avec doublement pour échapper ; mots-clés insensibles à la casse ; colonne inconnue → erreur `unknown column "<x>"` (correspondance insensible à la casse acceptée si unique). `formatQuickFilter(filters): string` (inverse, pour afficher la barre depuis le constructeur ; `Raw` → `(sql)` non réanalysable, la barre affiche alors un badge « advanced »).
- `FilterBar` : champ de saisie rapide (Entrée applique, Échap annule, erreur sous le champ) + bouton « Filters (N) » ouvrant le constructeur : lignes `[colonne | Any column] [opérateur] [valeur(s)]` avec + / – ; opérateurs disponibles selon le dialecte (`ILIKE` PG seulement) et la colonne (« Any column » limité à `=`, contains, not contains, LIKE) ; nombre de champs valeur selon l'opérateur (0, 1, 2, ou liste séparée par des virgules pour IN) ; « Apply » / « Clear » ; le constructeur et la barre restent synchronisés.

- [ ] **Step 1: Tests qui échouent** :
```ts
test("parses a compound quick filter", () => {
  expect(parseQuickFilter("status = paid and total > 100", cols).filters).toEqual([
    { column: "status", op: "eq", values: ["paid"] }, { column: "total", op: "gt", values: ["100"] }]);
});
test("quoted values, IN, BETWEEN, IS NOT NULL", () => { /* name = 'O''Brien' ; id in (1, 2, 3) ; created_at between '2025-01-01' and '2025-02-01' ; notes is not null */ });
test("unknown column and syntax errors", () => { /* "nope = 1" → unknown column "nope" ; "total >" → erreur, filters [] */ });
test("round-trips through formatQuickFilter", () => {});
```
  `FilterBar.test.tsx` : saisie + Entrée appelle `onApply` avec les filtres ; le constructeur n'offre pas ILIKE pour MySQL ; « Any column » limite les opérateurs ; « Clear » vide les filtres. `usePagedTable.test.ts` : des filtres changés repartent page 0 et sont passés à `tablePage` et `tableCount`.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(grid): filter builder and quick filter bar`

---

### Task 7: Navigation par clé étrangère et copie de sélection (frontend)

**Files:**
- Create: `src/features/grid/Breadcrumb.tsx` (+ test), `src/lib/copyFormats.ts` (+ test)
- Modify: `src/stores/gridViews.ts` (pile `trail`), `src/stores/workspaces.ts` (l'onglet de table peut changer d'objet), `src/features/grid/DataGrid.tsx` (indicateur de lien sur les colonnes FK, menu de copie), `src/features/grid/TableDataTab.tsx`, `src/lib/strings.ts`

**Interfaces:**
- Navigation : une cellule d'une colonne de clé étrangère affiche un indicateur ; Ctrl+clic (ou menu « Open referenced row ») ouvre dans **le même onglet** la table référencée filtrée par `ref_columns[i] = valeur[i]` (FK composite : toutes les colonnes ; valeur NULL : pas de lien) ; l'état courant (objet, filtres, tri, page) est empilé dans `trail` ; `Breadcrumb` affiche la pile (`orders › customers (id = 42)`) et revenir à un élément restaure exactement cet état ; `Alt+←` revient d'un cran. Naviguer avec des modifications en attente est bloqué comme un changement de page. Le titre de l'onglet suit l'objet courant.
- `copyFormats.ts` : `toTsv(columns, rows)`, `toCsv(columns, rows)` (RFC 4180 : guillemets doublés, champs avec `,`/`"`/saut de ligne entre guillemets, NULL → champ vide), `toJson(columns, rows)` (tableau d'objets ; `bigInt`/`decimal` en chaîne, `json` parsé, NULL → `null`), `toInsert(dialect, object, columns, rows)` (une instruction `INSERT INTO <qualified> (<cols>) VALUES (…);` par ligne, identifiants via les règles de `quote_ident`, chaînes échappées, NULL → `NULL`, octets → littéral hex du dialecte, valeurs tronquées signalées par un commentaire `-- truncated value` et laissées de côté). Menu contextuel de la grille : « Copy as TSV / CSV / JSON / SQL INSERT » sur la sélection (cellules ou lignes) ; `Ctrl+C` garde le TSV de Glide.

- [ ] **Step 1: Tests qui échouent** : `copyFormats.test.ts` (CSV avec virgule, guillemet, saut de ligne, NULL ; JSON avec bigInt et json imbriqué ; INSERT MySQL/PG/SQLite avec identifiant piégeux et `'`) ; `Breadcrumb.test.tsx` (pile de 3, clic sur le premier restaure son état) ; `TableDataTab.test.tsx` (ouverture d'une ligne référencée appelle `tablePage` sur la table cible avec le filtre `eq` ; FK composite → deux filtres ; bloqué si modifications en attente).
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(grid): foreign key navigation with breadcrumb and copy formats`

---

### Task 8: Vue Structure et vérification finale

**Files:**
- Create: `src/features/structure/StructureTab.tsx` (+ test)
- Modify: `src/features/grid/TableDataTab.tsx` (bascule « Data | Structure » en haut de l'onglet ; raccourcis `Alt+1` Data, `Alt+2` Structure), `src/lib/strings.ts`, `README.md` (édition, filtres, FK, structure, raccourcis), `docs/notes/plan-03-manual-check.md`

**Interfaces:**
- `StructureTab` : sous-onglets Columns (nom, type, nullable, défaut, auto-incrément/générée, commentaire ; PK et FK marquées), Indexes (nom, colonnes, unique/primary, définition), Foreign keys (colonnes → table(colonnes), ON UPDATE/DELETE ; lien qui ouvre la table référencée dans un nouvel onglet), DDL (CodeMirror en lecture seule avec coloration SQL du dialecte, bouton « Copy »). Bouton « Refresh » (`tableInfo(…, refresh = true)`). Lecture seule (spec : édition de structure hors v1).

- [ ] **Step 1: Tests qui échouent** : `StructureTab.test.tsx` (ipc mocké : colonnes avec PK marquée ; index unique ; FK avec ON DELETE CASCADE ; DDL affiché ; Refresh appelle `tableInfo(…, true)`).
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérification complète** — Run: `pnpm test && pnpm lint && pnpm test:rust` → Expected: tout passe.
- [ ] **Step 5: Vérification manuelle** (app réelle, session isolée comme au plan 2 ; base de démo `tablemax_demo` sur PG, MySQL, MariaDB et SQLite) et notes dans `docs/notes/plan-03-manual-check.md` : filtrer `orders` par la barre rapide (`status = delivered and total > 100`) puis par le constructeur ; modifier un montant, insérer et supprimer une ligne, voir le SQL, annuler un changement, Commit (Ctrl+S) puis vérifier en SQL ; provoquer un conflit (modifier la même ligne depuis un onglet SQL avant le commit) → message et rien d'écrit ; ouvrir `order_items` → clic sur `order_id` → commande filtrée → fil d'Ariane retour ; détail d'une ligne de `edge_cases` (JSON indenté, texte long complet) ; copier 3 lignes en CSV/JSON/INSERT ; Structure de `orders` (colonnes, index, FK, DDL) ; table sans clé / vue → lecture seule expliquée.
- [ ] **Step 6: Commit** — `✨ feat(structure): read-only structure view`

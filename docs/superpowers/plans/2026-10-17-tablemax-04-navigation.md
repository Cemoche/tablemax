# TableMax — Plan 4 : Onglets, navigation et éditeur — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Naviguer vite et ne rien perdre : onglet aperçu, Ctrl+Tab dans l'ordre d'usage, recherche d'onglets, restauration de session au redémarrage, sidebar avec routines et changement de base, palette de commandes Ctrl+K / Ctrl+P, et un éditeur SQL avec complétion sur le schéma, formatage, commentaire, LIMIT automatique optionnel, historique et requêtes sauvegardées.

**Architecture:** Backend : `app.db` passe en version 2 (tables `query_history` et `session_state`), les requêtes sauvegardées sont des fichiers `.sql` sous `<app_data_dir>/queries/<connection_id>/`, et le `SessionManager` gagne un catalogue de complétion (tables + colonnes d'un schéma en une requête par moteur), la liste des routines et le changement de base PostgreSQL. Frontend : le store `workspaces` gagne l'onglet aperçu, l'ordre MRU et la sérialisation de session ; une palette `cmdk` unique agrège objets, connexions, onglets et actions ; l'éditeur CodeMirror reçoit une source de complétion construite depuis le catalogue (avec alias), `sql-formatter` pour le formatage et `toggleComment`.

**Tech Stack:** existant + `cmdk` 1 (palette, spec §6) et `sql-formatter` 15 (formatage par dialecte), tous deux en JavaScript pur.

**Spec:** `docs/superpowers/specs/2026-10-16-tablemax-design.md` (§2 « Navigation » et « Éditeur SQL ») · suivis : `docs/notes/plan-01-followups.md` (Task 5/9/11 : DELIMITER, raccourcis `e.key`, popup de mots-clés lang-sql).

## Global Constraints

- Tout ce qui précède reste valable (chaînes dans `strings.ts`, tokens CSS, I/O asynchrone, secrets jamais exposés, commits au format du projet, aucune dépendance native).
- **Ce plan s'exécute en parallèle du plan 3** dans son propre worktree (branche `feat/plan-04-navigation` partie de `b9b03a9`) puis sera rebasé sur la fin du plan 3. Pour limiter les conflits : ne pas modifier `src/features/grid/**`, `src-tauri/src/driver/{query,dml,meta}.rs`, ni les signatures existantes des commandes `table_*` ; les ajouts dans les fichiers partagés (`strings.ts`, `types.ts`, `ipc.ts`, `commands.rs`, `lib.rs`, `manager.rs`) se font en **blocs nouveaux** en fin de section, pas en réécrivant l'existant.
- Bases de test : ce worktree utilise sa propre pile Docker (`TABLEMAX_TEST_PROJECT=tablemax-test-p4`, `TABLEMAX_TEST_PG_PORT=55321`, `TABLEMAX_TEST_MYSQL_PORT=34061`, `TABLEMAX_TEST_MARIADB_PORT=34062`, `TABLEMAX_TEST_SSH_PORT=3222`) — à exporter avant `pnpm test:rust`.
- La restauration de session **ne stocke aucun secret** et ne restaure ni les transactions ni les connexions : un workspace restauré est « déconnecté » et se reconnecte à l'activation d'un de ses onglets (mêmes invites que l'ouverture).
- Historique : 1 000 entrées max par connexion (les plus anciennes supprimées), texte SQL tel qu'exécuté ; il peut contenir des valeurs sensibles tapées par l'utilisateur → un bouton « Clear history » par connexion, et l'historique d'une connexion est supprimé avec elle.
- Raccourcis : utiliser `e.code`/`mod` (Ctrl sur Linux/Windows, Cmd sur macOS), ignorer `e.repeat`, ne pas se déclencher quand un dialogue modal est ouvert. Défauts : `Mod+K` palette, `Mod+P` palette (objets), `Ctrl+Tab` / `Ctrl+Shift+Tab` MRU, `Mod+T` nouvel onglet SQL, `Mod+W` fermer, `Mod+Shift+F` formater, `Mod+/` commenter, `Mod+Enter` / `Mod+Shift+Enter` exécuter, `Mod+S` enregistrer la requête (onglet SQL) — dans un onglet de table, `Mod+S` reste le commit du plan 3.

## Review Focus

1. **Redémarrage avec des connexions à mot de passe demandé (`Ask`) ou SSH** : les onglets reviennent, rien ne se connecte avant activation, l'activation déclenche les invites habituelles, annuler laisse l'onglet en place avec un bouton « Reconnect » → tests `restored_workspace_connects_on_activation` (Task 4).
2. **Fichier de session corrompu ou d'une version future** : l'app démarre à vide sans planter et sans écraser le fichier tant que l'utilisateur n'a rien fait → test `corrupt_session_is_ignored` (Tasks 1 et 4).
3. **Complétion avec alias et identifiants quotés** (`select o.| from "order" o`, `` `my table` t ``) : colonnes de la bonne table proposées, insérées avec le bon quoting → tests `completion_resolves_aliases` (Task 7).
4. **Palette sur une base de 5 000 tables** : saisie fluide (liste virtualisée/limitée à 200 résultats, catalogue chargé une fois par schéma) → test `palette_caps_results` (Task 6).
5. **Nom de requête sauvegardée hostile** (`../../etc/passwd`, `con`, `a/b`, 300 caractères) : refusé ou assaini, jamais d'écriture hors du dossier de la connexion → test `saved_query_names_are_confined` (Task 1).

---

### Task 1: Historique, session et requêtes sauvegardées (backend)

**Files:**
- Create: `src-tauri/src/history.rs`, `src-tauri/src/saved_queries.rs`, `src-tauri/tests/persistence.rs`
- Modify: `src-tauri/src/store.rs` (migration v2), `src-tauri/src/manager.rs` (enregistrement de l'historique dans `execute_batch`), `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Migration `PRAGMA user_version = 2` : `CREATE TABLE query_history(id INTEGER PRIMARY KEY, connection_id TEXT NOT NULL, sql TEXT NOT NULL, executed_at INTEGER NOT NULL /* ms epoch */, elapsed_ms INTEGER, rows INTEGER, error TEXT)` + index `(connection_id, executed_at DESC)` ; `CREATE TABLE session_state(id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, json TEXT NOT NULL, saved_at INTEGER NOT NULL)`. Supprimer une connexion supprime son historique et son dossier de requêtes.
- `history.rs` : `#[serde(rename_all = "camelCase")] pub struct HistoryEntry { pub id: i64, pub connection_id: String, pub sql: String, pub executed_at: i64, pub elapsed_ms: Option<u64>, pub rows: Option<u64>, pub error: Option<String> }` ; `pub fn record(store: &ConnectionStore, e: NewHistoryEntry) -> AppResult<()>` (élague au-delà de `HISTORY_CAP = 1000` par connexion) ; `pub fn list(store, connection_id, search: Option<&str>, limit: u32) -> AppResult<Vec<HistoryEntry>>` (plus récent d'abord, `search` = sous-chaîne insensible à la casse) ; `pub fn clear(store, connection_id)`.
- `execute_batch` enregistre une entrée par instruction terminée (succès : `elapsed_ms`, `rows` = lignes renvoyées ou touchées ; échec : `error` = message) via `spawn_blocking`, sans jamais faire échouer le lot si l'écriture d'historique échoue.
- Session : `pub fn save_session(store, json: &str) -> AppResult<()>` (refuse > 5 Mo : `Invalid "session too large"`) ; `pub fn load_session(store) -> AppResult<Option<String>>` (le frontend valide le JSON et sa version).
- `saved_queries.rs` : dossier `<app_data_dir>/queries/<connection_id>/` ; `pub fn list(dir, connection_id) -> AppResult<Vec<SavedQuery>>` (`SavedQuery { name, modified_at, size }`, triés par nom) ; `read(dir, connection_id, name) -> String` ; `write(dir, connection_id, name, sql)` (écriture atomique : fichier temporaire + rename) ; `rename(…, from, to)` ; `delete`. Noms : 1–120 caractères, sans `/`, `\`, NUL, sans `..`, pas de nom réservé Windows (`con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`, insensible à la casse), pas d'espace ni de point final ; extension `.sql` ajoutée par le backend ; sinon `Invalid "invalid query name"`. `connection_id` est validé comme un id existant.
- Commandes : `history_list(connectionId, search, limit)`, `history_clear(connectionId)`, `session_save(json)`, `session_load()`, `saved_queries_list(connectionId)`, `saved_query_read(connectionId, name)`, `saved_query_write(connectionId, name, sql)`, `saved_query_rename(connectionId, from, to)`, `saved_query_delete(connectionId, name)`.

- [ ] **Step 1: Tests qui échouent** : migration v1 → v2 sur une base du plan 1 (les connexions restent) ; `history_cap_prunes_oldest` (1 005 entrées → 1 000, les 5 plus anciennes parties) ; `history_search_and_order` ; `execute_batch_records_history` (succès + échec, test d'intégration SQLite via le manager) ; `deleting_connection_removes_history_and_queries` ; `corrupt_session_is_ignored` côté backend (`load_session` renvoie la chaîne telle quelle ; une table absente → `None`) ; `session_too_large` ; `saved_query_names_are_confined` (chaque nom hostile refusé ; aucun fichier hors du dossier) ; `saved_query_write_is_atomic_and_round_trips` (unicode, CRLF conservé).
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test:rust` (avec les variables de pile du Global Constraints) → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test:rust && pnpm lint` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(store): query history, saved queries and session state`

---

### Task 2: Catalogue de complétion, routines et changement de base (backend)

**Files:**
- Create: `src-tauri/src/driver/catalog.rs`, `src-tauri/tests/catalog.rs`
- Modify: `src-tauri/src/driver/mod.rs` (trait), `postgres.rs`, `mysql.rs`, `sqlite.rs`, `src-tauri/src/manager.rs`, `src-tauri/src/commands.rs`

**Interfaces:**
- `catalog.rs` (serde camelCase) : `pub struct CatalogColumn { pub name: String, pub type_name: String }` ; `pub struct CatalogTable { pub name: String, pub kind: ObjectKind, pub columns: Vec<CatalogColumn> }` ; `pub struct Catalog { pub schema: Option<String>, pub tables: Vec<CatalogTable> }` ; `#[serde(rename_all = "camelCase")] pub enum RoutineKind { Function, Procedure }` ; `pub struct DbRoutine { pub schema: Option<String>, pub name: String, pub kind: RoutineKind }`.
- Trait `Session` : `async fn catalog(&self, schema: Option<&str>) -> AppResult<Catalog>` (une requête par moteur : PG `pg_attribute` ⨝ `pg_class` (tables, vues, vues matérialisées) ; MySQL `information_schema.COLUMNS` ; SQLite `sqlite_schema` + `pragma_table_info` par table, dans un seul appel bloquant) ; `async fn list_routines(&self, schema: Option<&str>) -> AppResult<Vec<DbRoutine>>` (PG `pg_proc` hors schémas système ; MySQL `information_schema.ROUTINES` ; SQLite : vide) ; `async fn list_databases(&self) -> AppResult<Vec<String>>` (PG `pg_database` non modèles et `datallowconn` ; MySQL = schémas ; SQLite = schémas attachés).
- Manager : `catalog(ws, schema)` avec cache par `(workspace, schema)` (TTL 5 min, `refresh` force) ; `switch_database(ws, database)` : PostgreSQL seulement (MySQL/SQLite changent de schéma comme aujourd'hui) — reconnecte la session de navigation sur `database` (même config, mêmes secrets tenus, même tunnel), les **nouveaux** onglets SQL l'utilisent, les onglets SQL ouverts gardent leur connexion ; le `WorkspaceInfo` renvoyé porte la base courante. Base inexistante → `NotFound`.
- Commandes : `catalog_get(workspaceId, schema, refresh)`, `routines_list(workspaceId, schema)`, `databases_list(workspaceId)`, `workspace_switch_database(workspaceId, database) -> WorkspaceInfo`.

- [ ] **Step 1: Tests d'intégration qui échouent** (par moteur, schéma créé par le test) : `catalog_lists_tables_views_and_columns` (ordre des colonnes = ordre de définition, types) ; `catalog_handles_tricky_names` ; `routines_listed` (une fonction et une procédure PG/MySQL ; SQLite vide) ; `databases_listed` ; `pg_switch_database` (créer `tablemax_p4_other`, basculer, `list_schemas` vient de la nouvelle base, une session SQL ouverte avant garde l'ancienne base) ; cache : test unitaire avec session factice.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test:rust` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test:rust && pnpm lint` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(driver): completion catalog, routines and PostgreSQL database switching`

---

### Task 3: Onglet aperçu, ordre MRU et recherche d'onglets (frontend)

**Files:**
- Create: `src/features/workspace/TabSwitcher.tsx` (+ test), `src/features/workspace/TabList.tsx` (+ test), `src/lib/shortcuts.ts` (+ test)
- Modify: `src/stores/workspaces.ts` (+ test), `src/features/workspace/TabBar.tsx`, `src/features/workspace/WorkspaceView.tsx`, `src/features/workspace/ObjectSidebar.tsx`, `src/lib/strings.ts`

**Interfaces:**
- `Tab` gagne `preview: boolean` (table seulement) ; `Workspace` gagne `mru: string[]` (ids d'onglets, le plus récent d'abord).
- Store : `openTableTab(wsId, object, { preview })` — simple clic dans la sidebar = `preview: true` : remplace l'onglet aperçu existant du workspace (un seul à la fois) au lieu d'en ajouter un ; double-clic = onglet épinglé (si un aperçu montre déjà cet objet, il est épinglé) ; `pinTab(wsId, tabId)` (appelé aussi à la première modification ou au premier tri/filtre/page dans l'onglet) ; `activateTab` met à jour `mru` ; fermer un onglet active le précédent dans `mru`.
- `shortcuts.ts` : `matchShortcut(e: KeyboardEvent, spec: string): boolean` (spec `"Mod+K"`, `"Ctrl+Tab"`, `"Mod+Shift+F"` ; `Mod` = Meta sur macOS sinon Ctrl ; comparaison sur `e.code` ; `e.repeat` ignoré) ; `isModalOpen(): boolean` (présence d'un élément `[aria-modal="true"]`) ; `useShortcut(spec, handler, opts?)`.
- `TabSwitcher` : `Ctrl+Tab` maintenu ouvre une liste des onglets dans l'ordre `mru` ; chaque `Tab` supplémentaire avance, `Shift` recule ; relâcher `Ctrl` active la sélection ; `Échap` annule.
- `TabList` : bouton « ▾ » au bout de la barre d'onglets, ouvre une liste filtrable de tous les onglets (titre, type, schéma) ; Entrée active.
- Le titre d'un onglet aperçu est en italique (`font-style` via classe utilitaire, pas de couleur codée en dur).

- [ ] **Step 1: Tests qui échouent** : store (deux simples clics → un seul onglet aperçu avec le second objet ; double-clic épingle ; épinglage à la première modification ; `mru` après activations ; fermeture → onglet précédent du `mru`) ; `shortcuts.test.ts` (Mod selon la plateforme simulée, `e.code`, `repeat`, modal) ; `TabSwitcher.test.tsx` (Ctrl+Tab ×2 puis relâche → active le 2ᵉ du `mru`) ; `TabList.test.tsx` (filtre + Entrée).
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(tabs): preview tabs, MRU switching and tab search`

---

### Task 4: Restauration de session (frontend)

**Files:**
- Create: `src/stores/session.ts` (+ test)
- Modify: `src/stores/workspaces.ts`, `src/App.tsx`, `src/features/workspace/WorkspaceView.tsx` (état « déconnecté »), `src/lib/types.ts`, `src/lib/ipc.ts`, `src/lib/strings.ts`

**Interfaces:**
- `SessionSnapshot = { version: 1; activeWorkspaceIndex: number | null; workspaces: Array<{ connectionId: string; currentSchema: string | null; database: string | null; activeTabIndex: number | null; tabs: Array<{ kind: "table"; object: ObjectRef; preview: boolean } | { kind: "query"; title: string; sql: string }> }> }`.
- `session.ts` : `snapshot(state): SessionSnapshot` ; `parseSnapshot(json: string): SessionSnapshot | null` (version inconnue, JSON invalide, forme invalide → `null`) ; `startSessionAutosave()` : s'abonne au store `workspaces`, sauvegarde (`session_save`) 1 s après le dernier changement et à la fermeture de la fenêtre (`beforeunload`), jamais avant que la restauration initiale soit terminée ; `restoreSession()` : au démarrage, `session_load` → `parseSnapshot` → recrée les workspaces en état `status: "disconnected"` (connexions supprimées depuis : ignorées) avec leurs onglets.
- `Workspace` gagne `status: "connected" | "disconnected" | "connecting"`. Activer un onglet d'un workspace déconnecté lance l'ouverture (même flux d'invites que `App.tsx`) puis rattache les onglets (les onglets SQL ouvrent leur session au premier Run, comme aujourd'hui) ; en cas d'annulation ou d'erreur, l'onglet affiche « Disconnected » + bouton « Reconnect ».

- [ ] **Step 1: Tests qui échouent** : `session.test.ts` (aller-retour `snapshot`/`parseSnapshot` ; `parseSnapshot` sur JSON invalide, version 2, champs manquants → `null` ; le snapshot ne contient aucun champ nommé `password`/`secret`) ; `restored_workspace_connects_on_activation` (ipc mocké : au démarrage aucun `workspaceOpen` ; activer l'onglet → `workspaceOpen` ; une erreur `password required` affiche l'invite ; annuler → bouton « Reconnect ») ; `corrupt_session_is_ignored` (session invalide → démarrage vide, `session_save` pas appelé tant que rien ne change) ; autosave (changement → un seul `session_save` après 1 s, timers simulés).
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(session): restore workspaces and tabs on restart`

---

### Task 5: Sidebar : routines, bases et menu d'objet (frontend)

**Files:**
- Modify: `src/features/workspace/ObjectSidebar.tsx` (+ test), `src/stores/workspaces.ts`, `src/lib/types.ts`, `src/lib/ipc.ts`, `src/lib/strings.ts`

**Interfaces:**
- Sidebar : sélecteur de base (PostgreSQL seulement : `databases_list`, change via `workspace_switch_database`, met à jour les schémas) au-dessus du sélecteur de schéma ; sections repliables « Tables », « Views », « Routines » (routines listées, double-clic ouvre un onglet SQL contenant le DDL de la routine si le backend le permet — sinon seulement le nom à copier : v1 = nom à copier) ; le filtre texte s'applique aux trois sections ; menu contextuel d'objet : « Open » (aperçu), « Open in new tab » (épinglé), « New query » (onglet SQL pré-rempli `SELECT * FROM <qualified> LIMIT 100;` avec le quoting du dialecte), « Copy name » ; « Refresh » recharge objets, routines et catalogue.

- [ ] **Step 1: Tests qui échouent** : sélecteur de base visible en PG seulement et appelle `workspaceSwitchDatabase` ; sections et filtre ; « New query » produit le SQL attendu pour PG/MySQL/SQLite avec un nom piégeux.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(sidebar): routines, database switcher and object menu`

---

### Task 6: Palette de commandes (frontend)

**Files:**
- Create: `src/features/palette/CommandPalette.tsx` (+ test), `src/features/palette/actions.ts` (+ test), `src/stores/catalog.ts` (+ test)
- Modify: `package.json` (`cmdk`), `src/App.tsx`, `src/lib/types.ts`, `src/lib/ipc.ts`, `src/lib/strings.ts`

**Interfaces:**
- `catalog.ts` : store `{ [workspaceId]: { [schema]: { catalog: Catalog; loadedAt: number } } }` + `ensureCatalog(wsId, schema)` (un seul appel en vol par clé) + `refreshCatalog`.
- `actions.ts` : registre `Action { id: string; title: string; shortcut?: string; when?: (ctx) => boolean; run: (ctx) => void }` : nouvel onglet SQL, fermer l'onglet, onglet suivant/précédent, nouvelle connexion, changer de schéma, changer de base (PG), formater la requête, commenter, basculer la sidebar, ouvrir l'historique, recharger le catalogue ; `ctx` = workspace et onglet actifs.
- `CommandPalette` (`cmdk`, dialogue `aria-modal`) : `Mod+K` = tout (groupes Objects / Tabs / Connections / Actions), `Mod+P` = Objects seulement ; recherche floue (score `cmdk`) ; au plus 200 résultats affichés par groupe ; Entrée : objet → onglet aperçu, onglet → activation, connexion → ouverture du workspace, action → `run` ; affiche le raccourci des actions.

- [ ] **Step 1: Tests qui échouent** : `palette_caps_results` (catalogue mocké de 5 000 tables → ≤ 200 éléments rendus, le premier correspond à la saisie) ; `Mod+P` n'affiche que les objets ; sélection d'un objet ouvre un onglet aperçu ; une action `when` fausse est masquée ; `ensureCatalog` déduplique les appels.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(palette): command palette for objects, tabs, connections and actions`

---

### Task 7: Éditeur SQL : complétion, formatage, commentaire, LIMIT automatique

**Files:**
- Create: `src/features/editor/completion.ts` (+ test), `src/features/editor/autoLimit.ts` (+ test)
- Modify: `package.json` (`sql-formatter`), `src/features/editor/SqlEditor.tsx`, `src/features/editor/QueryTab.tsx` (+ test), `src/lib/strings.ts`

**Interfaces:**
- `completion.ts` : `buildCompletionSource(catalog: Catalog | null, dialect: Dialect): CompletionSource` — propose mots-clés du dialecte, tables (avec schéma si différent du courant), colonnes après `table.` ou `alias.` ; résout les alias déclarés dans l'instruction courante (`FROM t a`, `FROM t AS a`, `JOIN t a`, identifiants quotés `"…"`/`` `…` ``) ; insère les identifiants avec le quoting du dialecte quand nécessaire (majuscules en PG, caractères spéciaux, mots réservés) ; remplace la popup de mots-clés par défaut de `lang-sql` (suivi plan 1, Task 11).
- Formatage : `Mod+Shift+F` formate la sélection ou tout l'éditeur via `sql-formatter` (`language`: `postgresql`/`mysql`/`sqlite`, `keywordCase: "upper"`), en une seule transaction CodeMirror (annulable par Ctrl+Z).
- Commentaire : `Mod+/` = `toggleComment` (`--`).
- `autoLimit.ts` : `applyAutoLimit(sql, dialect, limit): string` — ajoute ` LIMIT <limit>` à une instruction `SELECT`/`WITH … SELECT` de premier niveau sans `LIMIT`/`FETCH`/`TOP` final (ignore commentaires et `;` final ; ne touche pas `SELECT … INTO`, `FOR UPDATE` → avant celui-ci) ; case « Auto LIMIT 1000 » dans la barre de l'éditeur, désactivée par défaut, mémorisée par onglet (le plan 5 en fera un réglage).

- [ ] **Step 1: Tests qui échouent** : `completion_resolves_aliases` (`select o.| from "order" o` → colonnes de `order` ; `` select t.| from `my table` t `` en MySQL ; `JOIN … AS c`) ; quoting à l'insertion (`MyCol` en PG → `"MyCol"`) ; tables d'un autre schéma préfixées ; `autoLimit.test.ts` (SELECT simple, avec `;`, avec commentaire final, CTE, déjà `LIMIT`, `FETCH FIRST`, `FOR UPDATE`, non-SELECT inchangé, sous-requête avec LIMIT mais pas la requête externe) ; `QueryTab.test.tsx` (case Auto LIMIT → `sqlExecute` reçoit l'instruction modifiée ; formatage d'une sélection).
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(editor): schema completion, formatting, comments and auto LIMIT`

---

### Task 8: Historique, requêtes sauvegardées, DELIMITER et vérification finale

**Files:**
- Create: `src/features/editor/HistoryPanel.tsx` (+ test), `src/features/editor/SavedQueries.tsx` (+ test)
- Modify: `src/features/editor/QueryTab.tsx`, `src/features/editor/splitStatements.ts` (+ test), `src-tauri/src/driver/mysql.rs` (lexer : `DELIMITER` et corps composés), `src/lib/types.ts`, `src/lib/ipc.ts`, `src/lib/strings.ts`, `README.md`, `docs/notes/plan-04-manual-check.md`

**Interfaces:**
- `HistoryPanel` (panneau droit de l'onglet SQL, `Mod+Shift+H`) : historique de la connexion (recherche, date relative, durée, lignes, erreur en rouge via token) ; clic = insère le SQL dans l'éditeur, double-clic = remplace ; « Clear history » avec confirmation.
- `SavedQueries` : liste par connexion dans la sidebar de l'onglet SQL ; `Mod+S` dans un onglet SQL enregistre (demande un nom la première fois, le titre de l'onglet devient ce nom) ; ouvrir, renommer, supprimer (confirmation) ; un onglet lié à une requête sauvegardée montre un point « modifié » tant qu'il n'est pas réenregistré.
- `DELIMITER` (MySQL/MariaDB, suivi plan 1 Task 5) : `splitStatements` reconnaît `DELIMITER <x>` en début de ligne, découpe sur le délimiteur courant, n'envoie pas les lignes `DELIMITER` ; les blocs `BEGIN … END` d'un `CREATE PROCEDURE/FUNCTION/TRIGGER` sont envoyés entiers ; le lexer multi-instructions du driver MySQL accepte un corps composé envoyé comme une seule instruction.

- [ ] **Step 1: Tests qui échouent** : `HistoryPanel.test.tsx`, `SavedQueries.test.tsx` (ipc mocké : Mod+S demande un nom puis appelle `savedQueryWrite` ; renommer ; le point « modifié ») ; `splitStatements.test.ts` (procédure avec `DELIMITER //` → 2 instructions attendues, sans les lignes DELIMITER) ; test d'intégration MySQL et MariaDB : créer une procédure avec un corps `BEGIN … END` via `execute_batch`.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test && pnpm test:rust` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérification complète** — Run: `pnpm test && pnpm lint && pnpm test:rust` → Expected: tout passe.
- [ ] **Step 5: Vérification manuelle** (app réelle, session isolée) et `docs/notes/plan-04-manual-check.md` : simple clic sur 3 tables → un seul onglet aperçu ; double-clic épingle ; Ctrl+Tab MRU ; recherche d'onglet ; fermer puis relancer l'app → workspaces et onglets restaurés, reconnexion à l'activation (dont une connexion `Ask`) ; palette Ctrl+K / Ctrl+P ; complétion avec alias sur `tablemax_demo` ; formatage ; Auto LIMIT ; historique ; requête sauvegardée puis rouverte après redémarrage ; changement de base PG ; procédure MySQL avec `DELIMITER`.
- [ ] **Step 6: Commit** — `✨ feat(editor): query history, saved queries and DELIMITER support`

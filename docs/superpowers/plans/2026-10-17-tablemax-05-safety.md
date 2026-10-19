# TableMax — Plan 5 : Sécurité, réglages et livraison — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ne jamais écrire sur une base « prod » sans confirmation (safe mode), voir d'un coup d'œil l'environnement (teinte et titre), régler l'app (thème, polices, taille de page, seuil de comptage, LIMIT auto, raccourcis), et installer TableMax depuis un `.deb` ou une AppImage vérifiés en build release.

**Architecture:** Backend : un module `safety.rs` classe chaque instruction (lecture / écriture) et `sql_execute` refuse une instruction qui demande confirmation tant que la requête n'est pas marquée `confirmed` ; les réglages vivent dans `<app_data_dir>/settings.json` (pas dans `app.db`, pour ne pas croiser les migrations du plan 4) ; une commande pose le titre de la fenêtre côté Rust (aucune permission JS). Frontend : store de réglages appliqué au thème (`data-theme`), à l'éditeur et à la grille ; dialogue de confirmation du safe mode ; bandeau d'environnement. Packaging : icône originale, cibles `deb` + `appimage`, vérification du binaire release. Les branchements qui dépendent des plans 3 et 4 (commit de la grille, raccourcis personnalisables, taille de page et seuil de comptage côté grille) sont regroupés dans la **Task 6, exécutée après l'intégration** des branches.

**Tech Stack:** existant ; aucune nouvelle dépendance npm ou cargo hors besoin justifié ; outils système déjà présents pour l'icône (`rsvg-convert` ou ImageMagick `convert`).

**Spec:** `docs/superpowers/specs/2026-10-16-tablemax-design.md` (§2 « Sécurité par environnement / Safe mode » et « Réglages », §4, §6 bis « Packaging Linux v1 ») · suivis : `docs/notes/plan-01-followups.md` (release non vérifiée, thème `data-theme`, icônes de modèle).

## Global Constraints

- Tout ce qui précède reste valable (chaînes, tokens, I/O asynchrone, secrets, commits, aucune dépendance native, capabilities `core:default` uniquement).
- **Exécution parallèle** : les Tasks 1 à 5 s'exécutent dans le worktree `.worktrees/plan-05` (branche `feat/plan-05-safety` partie de `b9b03a9`) en parallèle des plans 3 et 4. Ne pas toucher `src/features/grid/**`, `src-tauri/src/driver/{query,dml,meta,catalog}.rs`, `src/features/palette/**`, `src/lib/shortcuts.ts`, ni les migrations de `app.db`. Ajouts en blocs nouveaux dans les fichiers partagés. La Task 6 se fait **après** le rebase sur les plans 3 et 4.
- Bases de test de ce worktree : `TABLEMAX_TEST_PROJECT=tablemax-test-p5`, `TABLEMAX_TEST_PG_PORT=56321`, `TABLEMAX_TEST_MYSQL_PORT=35061`, `TABLEMAX_TEST_MARIADB_PORT=35062`, `TABLEMAX_TEST_SSH_PORT=4222`.
- Safe mode (spec) : niveaux `off`, `confirmAll` (toute requête), `confirmWrites` (tout sauf `SELECT`/`EXPLAIN`/`SHOW`). Défaut selon le tag : **prod = `confirmWrites`**, sinon `off`. Réglable par connexion (« Default (by environment) » = `None`). S'applique à l'éditeur SQL et au Commit de la grille, en montrant le SQL qui va partir.
- Classement « lecture » **strict et prudent** : seules sont des lectures les instructions dont le premier mot significatif (après commentaires et parenthèses ouvrantes) est `SELECT` (sans `INTO` de premier niveau ni `FOR UPDATE`/`FOR SHARE`… → écriture/verrou), `SHOW`, `DESCRIBE`/`DESC`, `EXPLAIN` **sans** `ANALYZE` (PG exécute `EXPLAIN ANALYZE`), `WITH` dont aucune sous-instruction n'est `INSERT`/`UPDATE`/`DELETE`/`MERGE`, `VALUES`, `TABLE` (PG). Tout le reste, et tout ce qui ne s'analyse pas, est une **écriture**.
- La confirmation est demandée **avant** l'envoi de la première instruction du lot : rien ne part tant que l'utilisateur n'a pas confirmé l'ensemble.
- Réglages : fichier `settings.json` versionné (`version: 1`), écrit atomiquement ; valeurs hors bornes ramenées aux bornes ; fichier invalide → défauts sans écraser le fichier tant que l'utilisateur ne modifie rien.
- Icône : originale (dessinée pour TableMax : par exemple une grille stylisée), jamais dérivée de TablePlus.

## Review Focus

1. **Instruction d'écriture déguisée** (`WITH d AS (DELETE … RETURNING *) SELECT …`, `EXPLAIN ANALYZE DELETE …`, `SELECT … INTO new_table`, `SELECT … FOR UPDATE`, commentaire `/* select */ delete …`, `-- select` puis `update` sur la ligne suivante, MySQL `/*!50000 DELETE */`) en mode `confirmWrites` : classée écriture → confirmation demandée → tests `disguised_writes_need_confirmation` (Task 2).
2. **Lot mixte** (`select 1; update …; select 2`) : la confirmation couvre le lot avant tout envoi ; annuler n'exécute même pas le premier `select` → test `mixed_batch_confirms_before_anything_runs` (Tasks 2 et 3).
3. **Connexion prod sans réglage explicite** (anciennes configs, imports TablePlus/URL) : le défaut `confirmWrites` s'applique bien → test `legacy_prod_connection_defaults_to_confirm_writes` (Task 2).
4. **Thème changé pendant que la grille et l'éditeur sont ouverts** : les deux suivent sans recharger → tests (Task 1) + vérification manuelle (Task 5).
5. **Build release** (CSP stricte, chemins d'assets, CodeMirror et Glide dans le binaire optimisé) : l'app release se lance, ouvre une base, affiche une table et exécute une requête → vérification `release_smoke` (Task 5).

---

### Task 1: Réglages (backend + store + thème)

**Files:**
- Create: `src-tauri/src/settings.rs`, `src/stores/settings.ts` (+ test), `src/lib/theme.ts` (+ test)
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/styles/tokens.css` (`:root[data-theme="light"]`, `:root[data-theme="dark"]` en plus de `prefers-color-scheme`), `src/features/grid/gridTheme.ts` **seulement** pour observer `data-theme` (seul fichier de `grid/` autorisé, changement minimal), `src/features/editor/SqlEditor.tsx` (police, taille, thème), `src/main.tsx` ou `src/App.tsx` (chargement initial), `src/lib/types.ts`, `src/lib/ipc.ts`

**Interfaces:**
- `settings.rs` (serde camelCase, `Default`) : `pub struct Settings { pub version: u32 /* 1 */, pub theme: Theme /* System | Light | Dark */, pub editor_font_family: String /* "" = token --font-mono */, pub editor_font_size: u32 /* 10..=24, défaut 13 */, pub page_size: u32 /* 50..=5000, défaut 300 */, pub exact_count_threshold: u64 /* 10_000..=100_000_000, défaut 500_000 */, pub auto_limit_default: bool /* défaut false */, pub auto_limit_value: u32 /* 1..=1_000_000, défaut 1000 */, pub keymap: BTreeMap<String, String> /* actionId → raccourci ; vide = défauts */ }` ; `pub fn load(path) -> Settings` (absent/invalide → défauts) ; `pub fn save(path, &Settings) -> AppResult<()>` (bornes appliquées, écriture atomique) ; commandes `settings_get()`, `settings_set(settings) -> Settings` (renvoie la valeur bornée).
- `settings.ts` : store `{ settings, loaded, load(), update(patch) }` (optimiste, puis valeur bornée du backend).
- `theme.ts` : `applyTheme(theme)` pose `document.documentElement.dataset.theme` (`light`/`dark`) ou le retire (`system`) ; `useResolvedDark()` (suit `data-theme` et `prefers-color-scheme`, via `MutationObserver` + `matchMedia`).

- [ ] **Step 1: Tests qui échouent** : Rust (`settings_defaults_and_round_trip`, `out_of_range_values_are_clamped`, `invalid_file_gives_defaults_and_is_not_overwritten_on_load`, `atomic_write`) ; TS (`applyTheme` pose/retire l'attribut ; `useResolvedDark` réagit à un changement d'attribut ; le store applique la valeur bornée renvoyée ; la grille et l'éditeur reçoivent un thème sombre quand `data-theme="dark"` alors que l'OS est clair).
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test && pnpm test:rust` (variables de pile du Global Constraints) → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint && pnpm test:rust` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(settings): persisted settings with light, dark and system themes`

---

### Task 2: Safe mode (backend)

**Files:**
- Create: `src-tauri/src/safety.rs`, `src-tauri/tests/safety.rs`
- Modify: `src-tauri/src/store.rs` (`safe_mode`), `src-tauri/src/error.rs` (`ConfirmationRequired`), `src-tauri/src/manager.rs` (garde dans `execute_batch`), `src-tauri/src/commands.rs` (`sql_execute(…, confirmed)`)

**Interfaces:**
- `#[serde(rename_all = "camelCase")] pub enum SafeMode { Off, ConfirmAll, ConfirmWrites }` ; `ConnectionConfig` gagne `#[serde(default)] pub safe_mode: Option<SafeMode>` ; `pub fn effective_safe_mode(cfg) -> SafeMode` (`None` → `ConfirmWrites` si `env_tag == Prod`, sinon `Off`).
- `#[serde(rename_all = "camelCase")] pub enum StatementClass { Read, Write }` ; `pub fn classify(dialect: Dialect, sql: &str) -> StatementClass` selon les Global Constraints (lexer qui ignore chaînes, identifiants quotés, commentaires `--`/`#`(MySQL)/`/* */`, et traite le contenu des commentaires exécutables MySQL `/*! … */` comme du code).
- `pub fn needs_confirmation(mode: SafeMode, classes: &[StatementClass]) -> Vec<usize>` (indices à confirmer ; `ConfirmAll` → tous).
- `ErrorKind::ConfirmationRequired` (camelCase `"confirmationRequired"`), message = indices séparés par des virgules ; `execute_batch(session_id, statements, confirmed: bool, sink)` : si `!confirmed` et `needs_confirmation` non vide → `Err(ConfirmationRequired)` **sans rien exécuter** ni émettre d'événement ; le safe mode effectif vient de la config stockée du workspace (jamais du frontend).
- La Task 6 appliquera la même garde à `changes_apply` (plan 3).

- [ ] **Step 1: Tests qui échouent** : `classify` table de cas (lectures : `select`, `  (select …)`, `show tables`, `describe t`, `explain select`, `with a as (select 1) select * from a`, `values (1)`, `table t` PG ; écritures : `insert/update/delete/merge/create/drop/alter/truncate/grant/set/use/call/do/copy/vacuum/begin`, `disguised_writes_need_confirmation` (les 7 cas de la Review Focus), instruction vide/incompréhensible → Write) ; `needs_confirmation` par mode ; `legacy_prod_connection_defaults_to_confirm_writes` (config JSON sans `safeMode`, tag prod) ; intégration SQLite via le manager : `mixed_batch_confirms_before_anything_runs` (aucun événement, table inchangée) puis réussite avec `confirmed: true` ; une connexion `Off` exécute sans confirmation.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test:rust` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test:rust && pnpm lint` → Expected: PASS (le frontend passe `confirmed: false` par défaut : adapter `ipc.sqlExecute` avec un paramètre optionnel pour garder les tests verts).
- [ ] **Step 5: Commit** — `🔒 security(safety): confirm writes on protected connections before anything runs`

---

### Task 3: Safe mode et environnement (frontend)

**Files:**
- Create: `src/features/safety/ConfirmRunDialog.tsx` (+ test), `src/features/workspace/EnvBanner.tsx` (+ test)
- Modify: `src/features/editor/QueryTab.tsx` (+ test), `src/features/connections/ConnectionForm.tsx` (+ test) ou une section dédiée `SafetySection.tsx`, `src/features/workspace/WorkspaceView.tsx`, `src/features/workspace/WorkspaceSwitcher.tsx`, `src-tauri/src/commands.rs` (`window_set_title`), `src/lib/types.ts`, `src/lib/ipc.ts`, `src/lib/errors.ts`, `src/lib/strings.ts`

**Interfaces:**
- Formulaire : sélecteur « Safe mode » (Default (by environment) / Off / Confirm writes / Confirm all queries), le libellé de « Default » indique le mode effectif selon le tag choisi.
- `QueryTab` : sur `confirmationRequired`, ouvre `ConfirmRunDialog` listant **toutes** les instructions du lot, celles à confirmer mises en évidence (token `--warning`), nom de la connexion et tag ; « Run » relance avec `confirmed: true`, « Cancel » (focus par défaut, Échap) n'exécute rien.
- `EnvBanner` : bandeau fin en haut du workspace, couleur du tag (`--env-*`), texte `<connexion> · <TAG>` ; pour `prod`, mention « Safe mode: confirm writes » (ou le mode effectif) ; l'onglet de workspace dans `WorkspaceSwitcher` porte la même pastille.
- `window_set_title(title)` (Rust, `WebviewWindow::set_title`, aucune permission JS) : `TableMax — <connexion> [PROD]` (tag en majuscules pour prod/staging), `TableMax` sur l'écran des connexions.

- [ ] **Step 1: Tests qui échouent** : `ConfirmRunDialog` (instructions affichées, Cancel par défaut, Échap) ; `QueryTab` (ipc mocké : `confirmationRequired` → dialogue ; Run → second appel avec `confirmed: true` ; Cancel → aucun second appel) ; formulaire (libellé du défaut selon le tag ; la valeur est enregistrée) ; `EnvBanner` (couleur par tag via classe de token, texte prod) ; titre de fenêtre appelé à l'activation d'un workspace.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint && pnpm test:rust` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(safety): confirmation dialog, safe mode setting and environment banner`

---

### Task 4: Écran Réglages

**Files:**
- Create: `src/features/settings/SettingsDialog.tsx` (+ test)
- Modify: `src/App.tsx` (bouton engrenage dans la barre du haut / écran des connexions, raccourci `Mod+,` via un écouteur local simple), `src/lib/strings.ts`

**Interfaces:**
- Dialogue modal (`aria-modal`) avec sections : **Appearance** (thème System/Light/Dark, appliqué immédiatement), **Editor** (police — vide = police mono par défaut —, taille), **Data** (taille de page, seuil de comptage estimé : affichés, enregistrés ; leur effet sur la grille est branché par la Task 6), **Queries** (Auto LIMIT par défaut + valeur), **Keyboard** (liste en lecture seule des raccourcis par défaut ; l'édition arrive avec la Task 6), **About** (version de l'app via `app.getVersion` côté Rust — commande `app_version()` —, licence, lien vers le dépôt affiché en texte). Champs numériques bornés comme le backend ; erreurs inline.

- [ ] **Step 1: Tests qui échouent** : changer le thème appelle `settings_set` et pose `data-theme` ; une taille hors bornes affiche une erreur et n'envoie rien ; About affiche la version renvoyée ; Échap ferme.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(settings): settings dialog`

---

### Task 5: Packaging Linux et vérification du build release

**Files:**
- Create: `assets/icon/tablemax.svg` (icône originale), `scripts/gen-icons.sh`, `docs/notes/plan-05-release-check.md`
- Modify: `src-tauri/icons/*` (régénérées), `src-tauri/tauri.conf.json` (`bundle.targets: ["deb", "appimage"]`, `shortDescription`, `longDescription`, `category: "DeveloperTool"`, `publisher`, `copyright`, `linux.deb.depends` si nécessaire), `src-tauri/Cargo.toml` (nettoyage des commentaires du modèle — suivi plan 1), `package.json` (scripts `build:app` = `tauri build`, `icons`), `README.md` (installation `.deb`/AppImage, dépendances d'exécution)

**Interfaces:**
- `gen-icons.sh` : à partir du SVG, produit les PNG/ICNS/ICO attendus via `pnpm tauri icon assets/icon/tablemax.svg` (outil Tauri) ; idempotent.
- Build : `pnpm tauri build` → `src-tauri/target/release/bundle/deb/*.deb` et `…/appimage/*.AppImage`.
- `release_smoke` (manuel, consigné dans `plan-05-release-check.md`) : lancer l'AppImage (ou le binaire release) dans une session isolée (HOME/XDG temporaires, Xvfb, `GDK_BACKEND=x11`), créer une connexion SQLite vers la base de démo (`pnpm demo:db` dans le HOME temporaire, ou un fichier SQLite de test), ouvrir une table (grille rendue), exécuter une requête dans l'éditeur (coloration et résultat), ouvrir les réglages et changer de thème ; vérifier l'absence d'erreur CSP dans la console (lancer avec `WEBKIT_DISABLE_COMPOSITING_MODE=1` si besoin) ; installer le `.deb` dans un conteneur `ubuntu:24.04` (`docker run --rm -v …:/pkg ubuntu:24.04 bash -c "apt-get update && apt-get install -y /pkg/*.deb && tablemax --version || true"`) pour vérifier que les dépendances déclarées se résolvent.

- [ ] **Step 1: Icône et configuration** ; Run: `bash scripts/gen-icons.sh && git status --short src-tauri/icons` → Expected: icônes régénérées.
- [ ] **Step 2: Build** — Run: `pnpm tauri build` → Expected: un `.deb` et une `.AppImage` produits (noter tailles et chemins).
- [ ] **Step 3: Vérification release** (procédure ci-dessus) et notes ; corriger tout problème trouvé (CSP, assets) avec un test quand c'est testable.
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint && pnpm test:rust` → Expected: PASS.
- [ ] **Step 5: Commit** — `🔥 chore(release): original icon, deb and AppImage bundles, release check`

---

### Task 6: Intégration avec les plans 3 et 4 (après rebase)

**Files:**
- Modify: `src-tauri/src/manager.rs`/`commands.rs` (`changes_apply(…, confirmed)`), `src/features/grid/TableDataTab.tsx` et le panneau des modifications (dialogue de confirmation au Commit), `src/lib/shortcuts.ts` (plan 4 : lire les raccourcis effectifs depuis `settings.keymap`), `src/features/settings/SettingsDialog.tsx` (section Keyboard éditable : enregistrer une combinaison, détection de conflits, « Reset »), `src/features/grid/usePagedTable.ts` (taille de page des réglages), `src-tauri/src/commands.rs` (`table_count` utilise `exact_count_threshold` des réglages), `src/features/editor/QueryTab.tsx` (Auto LIMIT par défaut et valeur depuis les réglages), `docs/notes/plan-05-manual-check.md`

**Interfaces:**
- `changes_apply(workspaceId, object, changes, confirmed)` : un commit de grille est toujours une écriture → si le safe mode effectif n'est pas `Off` et `!confirmed` → `ConfirmationRequired` sans rien appliquer ; le frontend affiche `ConfirmRunDialog` avec le SQL de `changes_preview`.
- Keymap : `effectiveShortcut(actionId)` = `settings.keymap[actionId] ?? DEFAULT_KEYMAP[actionId]` ; l'éditeur de raccourcis refuse une combinaison déjà prise (affiche l'action en conflit) et propose « Reset to default ».

- [ ] **Step 1: Tests qui échouent** : commit de grille sur connexion prod → dialogue puis `changesApply(…, true)` ; Cancel → rien ; raccourci personnalisé pris en compte par la palette et Ctrl+T ; conflit refusé ; taille de page 50 → `tablePage` avec `limit: 50` ; Auto LIMIT par défaut activé depuis les réglages ; Rust : `changes_apply` sans confirmation sur prod → `ConfirmationRequired` et table inchangée.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test && pnpm test:rust` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérification complète** — Run: `pnpm test && pnpm lint && pnpm test:rust` → Expected: tout passe.
- [ ] **Step 5: Vérification manuelle** de bout en bout (session isolée) dans `docs/notes/plan-05-manual-check.md` : connexion prod → bandeau et titre ; `update` dans l'éditeur → confirmation, Cancel puis Run ; commit de grille sur prod → confirmation avec le SQL ; thème clair/sombre/système à chaud ; raccourci personnalisé ; taille de page 50.
- [ ] **Step 6: Commit** — `✨ feat(safety): safe mode on grid commits and customizable shortcuts`

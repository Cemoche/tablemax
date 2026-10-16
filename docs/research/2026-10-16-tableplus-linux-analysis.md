# TablePlus Linux — analyse REA / statique (2026-10-16)

Cible : `/opt/tableplus/tableplus`, paquet apt `tableplus 0.1.316` (affiché « TablePlus 1.8.4 (316) »),
SHA-256 `85ab3adbb0e2f8e37e806fca0904bda5948c06b78136ad6b384f9a748cdff979`.

Ce document sert de **référence de compréhension** pour TableMax. Aucun code, icône ou asset de
TablePlus n'est repris : TableMax est écrit de zéro.

## Méthode

- `nm` / `strings` / `objdump -d` sur le binaire (non strippé, `with debug_info`, ~145 000 symboles).
- REA (`open_binary`, provider Hopper). Hopper dépassait le délai de démarrage de 120 s sur ce
  binaire de 140 Mo → `REA_HOPPER_STARTUP_TIMEOUT_MS=900000` ajouté à la config MCP.
- Lancement de l'app (XWayland, `GDK_BACKEND=x11`) et capture de l'écran « New Connection ».
  Les popups GTK ne sont pas capturables sous Wayland ; l'observation UI de REA est macOS-only.

## Observations

### Technologie
- Vala → C, GTK 3, libgee, GtkSourceView 3, json-glib, libsecret, Granite (SourceList).
- Drivers et libs embarqués en statique : libssh2, SQLite, DuckDB, mongoc, curl, Sentry/crashpad.
- Fichiers utilisateur dans `~/.tableplus/` : `connections.json`, `settings.json`, `keymap.json`,
  `session.json`, `config.json`, `history/`, `queries/`, `aichat/`, licence dans `.tblicensenix`.

### Architecture (namespaces `table_plus_*`)
| Namespace | Rôle |
|---|---|
| `drivers` | 17 drivers : MySQL, MariaDB, PostgreSQL, SQLite, SQL Server, Redis (+Sentinel), MongoDB, ClickHouse, Cassandra, CockroachDB, Redshift, Greenplum, DuckDB, LibSQL, Cloudflare D1, Elasticsearch |
| `services` | ConnectionService (open/test/commit/discard/reload/shutdown, import/export URL), PasswordService (libsecret, async), SshService (tunnel, port forwarding, multi-channel), SafeModeService, QueryService, KeymapService, ThemeService, LicenseService, UpdateService, LLM (OpenAI/Anthropic/Copilot/Codex CLI), RNCryptor v3 (export chiffré des connexions) |
| `layouts` | Workspace → MainTabView (notebook, split) → TableView/TableDataView/TableStructureView/QueryView/ResultTabView ; dialogs : connexion, import CSV/JSON, export, backup/restore, process list, user management MySQL/PG, Open Anything, safe-mode confirm, preview SQL, settings |
| `partials` | DataView (grille), AdvancedFilter, CellClipboard (formats), RowDetailView, ForeignKeyPopover, ChartView, OpenAnythingItem |
| `diagram`, `metrics` | Diagrammes ER ; Metrics Boards (canvas, chart/scoreboard/table/input items) |

### Actions (≈40, keymap personnalisable)
backup, beautify/uglify query, cancel_all_queries, close_tab, commit, discard, new_connection,
new_tab, new_window, new_workspace, next/previous tab & workspace, open_anything, open_database,
open_diagram, open_metrics_board, open_process_list, open_settings, open_user_management,
preview_sql, reload, restore, run_query, show_table_data, show_table_structure,
toggle_(block_)comments, toggle_left/right_sidebar, zoom in/out/default, quit.

### Formulaire de connexion (capture)
Nom ; couleur (6 pastilles) ; tag (local/…) ; driver ; host/socket + port ; user ; password +
« Store in keyring » ; database ; « Other options » ; SSL mode (PREFERRED…) + Key/Cert/CA Cert ;
toggle SSH Tunnel ; boutons Save / Test / Connect.

### Safe mode
- « Alert Mode 1 - Warn before sending queries to the server »
- « Alert Mode 2 - Warn before sending queries to the server except SELECT/EXPLAIN/SHOW queries »

### Filtres
Opérateurs observés : `=`… `LIKE`, `ILIKE`, `BETWEEN`, `NOT BETWEEN`, `NOT IN`, `Contains`,
`Not contains`, `Raw SQL`, cible « Any column ».

### Licence (Linux)
- Seul appel de garde-fou « free » trouvé : `advanced_filter_check_and_show_free_warning`, appelé
  depuis `advanced_filter_clone_filter`. Logique (asm) : `license.deviceID == ""` → ouvre
  `LicenseDialog`.
- `get_license` est aussi lu par `window_build_ui`, `window_update_title` (« (Trial) »),
  `header_right_box_update_layout`.
- **Aucune limite d'onglets** trouvée dans la build Linux (les appels `gtk_notebook_get_n_pages`
  servent à la navigation/split/nettoyage).

## Inconnues
- Pseudo-code Hopper des fonctions clés : en attente (analyse Hopper longue).
- Parcours UI au-delà de l'écran de connexion non capturé (limite Wayland).

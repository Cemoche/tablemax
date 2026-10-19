# TableMax — Refonte UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Donner à TableMax l'apparence et le comportement de TablePlus macOS sur Linux : thèmes sombre et clair calqués, interface plus grande, barre du haut unifiée avec pastille de statut, colonne des connexions, barre latérale Items / Queries / History, onglets en capsules, grille et barre du bas comme TablePlus, filtres, panneau de détail, écran et formulaire de connexion, éditeur SQL, raccourcis et interactions identiques.

**Architecture:** Tout reste dans le frontend React existant (Tailwind 4 + tokens CSS, Zustand, Glide Data Grid, CodeMirror 6). Les couleurs et tailles passent par `src/styles/tokens.css` ; la taille de l'interface par le zoom natif de la webview (commande Rust) ; la fenêtre devient sans décorations avec des commandes Rust pour la barre de titre ; les raccourcis passent par le registre existant (`keymap-actions.json`, `keymapRegistry.ts`) avec des portées. Une seule modification backend de fond : le combinateur AND / OR des filtres.

**Tech Stack:** existant ; nouveaux paquets npm `@fontsource/jetbrains-mono` (OFL) et un jeu d'icônes libre en traits fins (`lucide-react`, ISC).

**Spec:** `docs/superpowers/specs/2026-10-19-tablemax-ui-redesign-design.md` (§2 objectifs, §3 non- et anti-objectifs, §5.1 tokens, §5.2 dimensions, §5.3 raccourcis, §5.4 interactions, §5.5 précisions) · epic #77 · bugs #78, #79.

## Global Constraints

- Règles du dépôt : `CLAUDE.md`, `src/CLAUDE.md`, `src-tauri/CLAUDE.md` (chaînes dans `src/lib/strings.ts`, couleurs seulement par tokens, IPC par `src/lib/ipc.ts`, capabilities `core:default`, une commande = `commands.rs` + `lib.rs` + `ipc.ts` + `types.ts` + `types.shape.test.ts`).
- **Rien de TablePlus** dans le dépôt ou le bundle : ni fichier, ni icône, ni image, ni texte, ni logo. Icônes : `lucide-react` et nos propres SVG (icônes d'objets, monogrammes des moteurs).
- **Aucune ressource réseau** : polices et icônes livrées dans le bundle.
- Valeurs : celles des §5.1 (tokens sombre / clair) et §5.2 (dimensions à 100 %) de la spec, à reprendre telles quelles ; maquettes : artifact « TableMax — refonte style TablePlus ».
- Base de texte de l'interface 13 px ; données en JetBrains Mono 13 px (`dataFontSize`) ; `system-ui` pour l'interface.
- Raccourcis : le tableau du §5.3 fait foi (contextes, alternatives Ctrl+PageUp / PageDown) ; tous réassignables ; un raccourci ne doit jamais voler une frappe dans un champ texte ou l'éditeur quand ce n'est pas son contexte.
- Environnement : une connexion `production` reste évidente (pastille, badge `PROD` jamais tronqué, `[PROD]` dans le titre) ; safe mode inchangé.
- Livraison : une issue, une branche, une PR par tâche vers `main`, l'app reste utilisable à chaque PR ; captures avant / après (sombre et clair, bureau GNOME Wayland) et notes de vérification manuelle dans chaque PR qui change l'écran.
- RAM limitée sur la machine de dev : une seule commande lourde à la fois (build Rust, vitest complet), `CARGO_BUILD_JOBS=4`, vérifier `free -m` (≥ 2500 Mo disponibles) avant un build ; UI tests chargés : `pnpm test --testTimeout=30000` en local si besoin (#58).

## Review Focus

1. **Fenêtre étroite (960 px) et noms longs** : la pastille tronque son texte mais garde le badge `PROD`, les onglets et l'arbre tronquent avec une ellipse, rien ne passe sur deux lignes → tests `status_pill_keeps_prod_badge_when_truncated` (Task 2), `long_names_truncate` (Tasks 3, 4).
2. **Clavier seul** : chaque contrôle nouveau (pilules, segmentés, onglets capsules, barre de filtres, barre du bas) est atteignable au Tab, avec un focus visible, et a un `aria-label` quand il n'a pas de texte → tests `toolbar_is_keyboard_reachable` (Task 2), `filter_bar_keyboard_flow` (Task 6).
3. **Raccourcis dans un champ texte** : Ctrl+←/→, Ctrl+I, Ctrl+F, Ctrl+Enter, Space dans un input, la recherche ou l'éditeur gardent leur comportement texte quand ce n'est pas leur contexte → test `context_shortcuts_do_not_steal_text_input` (Task 10).
4. **Zoom 130 % et 90 %** : la grille (canvas) reste nette et cliquable au bon endroit, les popovers restent dans la fenêtre → vérification manuelle obligatoire (Task 1) + test `interface_scale_applied_on_load_and_change` (Task 1).
5. **Thème clair** : contraste suffisant des placeholders `NULL` sur les lignes alternées et des textes secondaires (≥ 4,5:1 pour le texte, ≥ 3:1 pour les placeholders) → test `light_theme_contrast` (Task 1).

---

### Task 1: Tokens, thèmes, polices et taille de l'interface

**Files:**
- Modify: `src/styles/tokens.css`, `src/styles/tokens.test.ts`, `src/index.css`, `src/main.tsx`, `src/lib/theme.ts` (+ test), `src/features/grid/gridTheme.ts` (lit les nouveaux tokens), `src/stores/settings.ts` (+ test), `src-tauri/src/settings.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/lib/types.ts`, `src/lib/types.shape.test.ts`, `src/lib/ipc.ts`, `src/lib/keymap-actions.json`, `src/lib/strings.ts`, `package.json`, `pnpm-lock.yaml`
- Create: `src/lib/contrast.ts` (+ test)

**Interfaces:**
- Produces : tous les tokens du §5.1 (noms CSS `--win`, `--side`, `--content`, `--sep`, `--pill`, `--pill-border`, `--icon`, `--icon-dim`, `--text`, `--text-2`, `--seg-sel`, `--search`, `--sel`, `--tab`, `--tab-sel`, `--grid-head`, `--head-text`, `--row-a`, `--row-b`, `--grid-sep`, `--cell-text`, `--placeholder`, `--rownum`, `--bottom`, `--btn`, `--accent`, `--cell-focus`, `--inserted`, `--modified`, `--deleted`, `--tag-<tag>-bg` / `--tag-<tag>-text`, `--swatch-1..6`), en sombre et en clair, exposés à Tailwind dans `src/index.css` (`bg-win`, `text-text-2`…). Les anciens noms utilisés par les composants restent comme alias jusqu'à leur remplacement dans les tâches suivantes.
- `Settings` gagne `interface_scale: f32` (0.9–1.3, défaut 1.0) et `data_font_size: u32` (10–24, défaut 13), bornés par `clamped()` ; ancienne config → défauts.
- Commande `window_set_zoom(scale: f64)` (zoom natif de la webview) appelée au chargement des réglages et à chaque changement.
- Actions `font.increase` (Ctrl+=) et `font.decrease` (Ctrl+-) : ±1 sur `dataFontSize` et `editorFontSize`, dans leurs bornes.
- `contrast.ts` : `contrastRatio(fg: string, bg: string): number`.
- Police : `@fontsource/jetbrains-mono` 400 / 500 (latin, latin-ext) importée dans `main.tsx` ; `--font-mono: "JetBrains Mono", ui-monospace, monospace` ; `--font-ui: system-ui, sans-serif` ; base 13 px.

- [ ] **Step 1: Tests qui échouent** : `every_token_defined_in_both_themes` (liste du §5.1), `light_theme_contrast` (`--text`/`--content` ≥ 4.5, `--text-2`/`--side` ≥ 4.5, `--placeholder` sur `--row-a` et `--row-b` ≥ 3, idem en sombre), Rust `interface_scale_and_data_font_size_clamped`, `old_settings_get_new_defaults`, TS `interface_scale_applied_on_load_and_change` (appelle `ipc.windowSetZoom`), `font_shortcuts_change_both_sizes_within_bounds`.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib settings` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint && cargo test --manifest-path src-tauri/Cargo.toml --lib` → Expected: PASS ; manuel : `pnpm dev`, thèmes clair / sombre / système, zoom 90 % / 100 % / 130 % (grille nette, clics justes), captures avant / après.
- [ ] **Step 5: Commit** — `🎨 style(theme): TablePlus-like dark and light tokens, JetBrains Mono, interface size`

---

### Task 2: Barre du haut unifiée, fenêtre sans décorations, pastille de statut

**Files:**
- Create: `src/features/chrome/AppToolbar.tsx`, `src/features/chrome/StatusPill.tsx`, `src/features/chrome/ConnectionPopover.tsx`, `src/features/chrome/WindowControls.tsx`, `src/features/chrome/ResizeHandles.tsx` (+ tests)
- Modify: `src/App.tsx`, `src/features/workspace/WorkspaceView.tsx`, `src-tauri/tauri.conf.json` (`decorations: false`, `minWidth: 960`, `minHeight: 600`), `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/settings.rs` (`use_system_title_bar: bool`, défaut false), `src/lib/ipc.ts`, `src/lib/types.ts`, `src/lib/types.shape.test.ts`, `src/lib/strings.ts`, `src/lib/keymap-actions.json`
- Delete: `src/features/workspace/EnvBanner.tsx` (+ test)

**Interfaces:**
- Commandes : `window_minimize()`, `window_toggle_maximize()`, `window_start_drag()`, `window_start_resize(direction: ResizeDirection)` (`North`, `South`, `East`, `West`, `NorthEast`, `NorthWest`, `SouthEast`, `SouthWest`) ; fermer passe par le chemin existant (`close_gate`). Avec `use_system_title_bar` vrai, la fenêtre garde ses décorations natives (appliqué au démarrage) et `WindowControls` / `ResizeHandles` ne sont pas rendus.
- `AppToolbar` : groupes et ordre du §2.3 de la spec ; double-clic sur une zone vide = agrandir / restaurer ; Discard / Preview / Commit actifs selon le store des modifications en attente ; Safe mode = menu des niveaux de la connexion ; base = nouvelle action `database.open` (Ctrl+K) ; SQL = `query.new` / nouvelle action `editor.open` (Ctrl+E) ; reload `workspace.reload` (Ctrl+R) ; Open Anything ; panneau de détail (`grid.rowDetails`, Space).
- `StatusPill({ workspace })` : texte `"<Engine> <version> : <database> : <schema>.<object>"` (monospace), fond = couleur de la connexion, états `connecting` / `reconnecting` / `error` (tokens d'état), badge `PROD` si tag `production`, jamais tronqué ; clic = `ConnectionPopover` (moteur, serveur, hôte, utilisateur, base, TLS ; Edit, Reconnect, Disconnect).

- [ ] **Step 1: Tests qui échouent** : `toolbar_groups_in_spec_order`, `commit_group_follows_pending_changes`, `status_pill_text_and_color`, `status_pill_keeps_prod_badge_when_truncated`, `prod_title_kept`, `toolbar_is_keyboard_reachable`, `double_click_toolbar_toggles_maximize`, `system_title_bar_setting_hides_window_controls`, Rust `resize_direction_serde`.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.** Vérifier sur GNOME Wayland : déplacer, agrandir, ancrer aux bords, redimensionner par les 8 poignées. Si le redimensionnement ou l'ancrage n'est pas fiable, `use_system_title_bar` passe à vrai par défaut et la PR le dit (spec §5.5).
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint && cargo test --manifest-path src-tauri/Cargo.toml --lib` → Expected: PASS ; manuel et captures.
- [ ] **Step 5: Commit** — `✨ feat(chrome): unified toolbar, frameless window and connection status pill`

---

### Task 3: Colonne des connexions ouvertes et barre latérale Items / Queries / History

**Files:**
- Create: `src/features/chrome/OpenConnectionsColumn.tsx`, `src/features/sidebar/Sidebar.tsx`, `src/features/sidebar/SidebarSearch.tsx`, `src/features/sidebar/ObjectIcon.tsx`, `src/features/sidebar/SidebarFooter.tsx` (+ tests)
- Modify: `src/App.tsx`, `src/features/workspace/ObjectSidebar.tsx` (devient l'onglet Items), `src/features/editor/HistoryPanel.tsx` et `src/features/editor/SavedQueries.tsx` (onglets History et Queries de la barre latérale), `src/features/editor/QueryTab.tsx` (retire leurs panneaux), `src/features/workspace/WorkspaceSwitcher.tsx` (remplacé), `src/lib/strings.ts`, `src/lib/keymap-actions.json`, `package.json` (`lucide-react`)

**Interfaces:**
- `OpenConnectionsColumn` : une tuile 80 px par workspace du store (icône de base dans la couleur de la connexion, nom sur 2 lignes), tuile active surlignée ; clic = activer ; Ctrl+Shift+[ / ] et Ctrl+Shift+PageUp / PageDown = workspace précédent / suivant (nouvelles actions `workspace.previous` / `workspace.next`).
- `Sidebar` : segmenté Items / Queries / History (état mémorisé par workspace) ; recherche (`sidebar.search`, Ctrl+Shift+F) avec menu d'options : contient / commence par / finit par, tables, vues ; arbre monospace `dataFontSize`, lignes 24, chevrons, `ObjectIcon kind` (`table`, `view`, `materializedView`, `function`, `procedure`) ; pied : réglages, [+ | ⌄] (nouvel onglet SQL, rafraîchir), sélecteur de schéma. Ctrl+0 (`sidebar.toggle`) masque / montre la barre ; largeur redimensionnable, min 240, mémorisée.
- Queries / History : clic = onglet SQL avec ce texte (ou active l'onglet de la requête sauvegardée déjà ouverte) ; menu contextuel Run, Copy, Insert into SQL editor, Delete ; `history.toggle` (Ctrl+Shift+H) ouvre l'onglet History.
- Menu d'un objet : Open in new tab, Open structure, Copy name, Copy script as (CREATE, SELECT top 100), Refresh.

- [ ] **Step 1: Tests qui échouent** : `column_lists_open_workspaces_and_switches`, `workspace_shortcuts_cycle`, `segmented_tabs_switch_and_persist`, `search_options_filter_tree`, `tree_icons_by_kind`, `long_names_truncate`, `query_click_opens_sql_tab`, `history_shortcut_opens_history_tab`, `object_context_menu_actions`, `sidebar_toggle_and_resize`.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS ; manuel et captures.
- [ ] **Step 5: Commit** — `✨ feat(sidebar): open connections column and Items / Queries / History sidebar`

---

### Task 4: Barre d'onglets en capsules

**Files:**
- Modify: `src/features/workspace/TabBar.tsx` (+ test), `src/features/workspace/TabList.tsx`, `src/stores/workspaces.ts` (+ test), `src/lib/keymap-actions.json`, `src/lib/strings.ts`

**Interfaces:**
- Onglets en capsules qui se partagent la largeur (min 120 px, puis défilement horizontal), onglet d'aperçu en italique, onglet actif `--tab-sel` ; flèches précédent / suivant de l'historique de navigation (`nav.back` / `nav.forward`, Alt+← / Alt+→) ; bouton de séparation (désactivé tant que le split n'existe pas, epic #17) ; menu New tab / Close / Close others / Rename (renommage en place).
- Actions : `tab.previous` / `tab.next` gagnent Ctrl+[ / Ctrl+] et Ctrl+PageUp / Ctrl+PageDown (Ctrl+Tab garde l'ordre récent) ; nouvelles `tab.goto1` … `tab.goto9` (Ctrl+1…9) ; `tab.close` Ctrl+W.

- [ ] **Step 1: Tests qui échouent** : `capsules_share_width_and_scroll`, `preview_tab_italic`, `rename_in_place`, `close_others`, `ctrl_brackets_and_pageup_cycle_tabs`, `ctrl_number_goes_to_tab`, `back_forward_navigation`, `long_names_truncate`.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS ; manuel et captures.
- [ ] **Step 5: Commit** — `✨ feat(tabs): capsule tab bar with TablePlus navigation shortcuts`

---

### Task 5: Grille — apparence, sélection de lignes, colonnes

**Files:**
- Modify: `src/features/grid/DataGrid.tsx` (+ test), `src/features/grid/gridTheme.ts` (+ test), `src/features/grid/cellContent.ts` (+ test), `src/features/grid/GridContextMenu.tsx` (+ test), `src/features/grid/TableDataTab.tsx`, `src/stores/gridViews.ts` (+ test), `src/lib/strings.ts`, `src/lib/keymap-actions.json`

**Interfaces:**
- Thème de grille : données `--font-mono` à `dataFontSize`, en-têtes `--font-ui` medium, lignes 26, en-tête 30, numéros 46, lignes alternées `--row-a` / `--row-b`, séparateurs `--grid-sep`, placeholders `NULL` / `EMPTY` / `DEFAULT` en majuscules `--placeholder` 11,5 px, lignes sélectionnées `--accent` texte blanc, cellule active bordée `--cell-focus`.
- Sélection (#78) : clic sur un numéro = ligne ; Shift+clic = plage ; Ctrl+clic = ajoute / retire ; clic sur un en-tête = tri asc → desc → aucun, **sans** sélectionner la colonne.
- Colonnes : largeur initiale = contenu de la page (bornes 60–400) ; double-clic sur la bordure d'un en-tête = ajuster ; glisser = réordonner ; largeurs et ordre mémorisés par table (`gridViews`).
- Menus : en-tête et cellule selon le §5.4 de la spec (Copy rows as : TSV, CSV, CSV + header, JSON, Markdown, INSERT ; Set value NULL / EMPTY / DEFAULT ; Quick filter IS NULL / = valeur) ; Enter = Quick Look, Alt+Enter = Set value, Space = panneau de détail, Ctrl+Shift+C = copier les cellules, Ctrl+D = dupliquer, Ctrl+Backspace / Delete = supprimer les lignes.

- [ ] **Step 1: Tests qui échouent** : `row_number_click_selects_row` (+ Shift, Ctrl), `header_click_sorts_without_selecting_column`, `placeholders_uppercase_dim`, `zebra_rows`, `columns_autosize_within_bounds`, `double_click_border_fits`, `drag_reorders_and_persists`, `header_menu_items`, `cell_menu_items`, `enter_quick_look_alt_enter_set_value`, `space_toggles_row_detail`.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test src/features/grid` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS ; manuel et captures.
- [ ] **Step 5: Commit** — `✨ feat(grid): TablePlus grid look, row selection by row number, auto-sized columns`

---

### Task 6: Barre du bas et barre de filtres (AND / OR)

**Files:**
- Create: `src/features/grid/TableBottomBar.tsx`, `src/features/grid/ColumnsPopover.tsx`, `src/features/grid/PagePopover.tsx` (+ tests)
- Modify: `src/features/grid/FilterBar.tsx` (+ test), `src/features/grid/TableDataTab.tsx`, `src/features/grid/FilterBuilder.tsx` et `src/features/grid/ViewToggle.tsx` (fondus dans les nouveaux composants, puis supprimés), `src/lib/quickFilter.ts` (mode « Raw SQL »), `src-tauri/src/driver/mod.rs` (`PageRequest.combine`), `src-tauri/src/driver/query.rs` (+ tests), `src/lib/types.ts`, `src/lib/types.shape.test.ts`, `src/lib/strings.ts`, `src/lib/keymap-actions.json`, `src-tauri/tests/*_driver.rs` (un cas OR par moteur)

**Interfaces:**
- `PageRequest` gagne `#[serde(default)] combine: FilterCombine` (`And` défaut | `Or`), utilisé par `build_page` et `build_filtered_count`.
- `TableBottomBar` : [Data | Structure] (Ctrl+Alt+[ / ], Alt+1 / Alt+2 gardés) · `+ Row` (Ctrl+I) · compteur centré · Filters (Ctrl+F, ouvre / ferme la barre et place le focus) · Columns (Ctrl+Alt+F, popover : cocher / décocher les colonnes visibles, Show all) · pagination [‹ | réglages | ›] (Ctrl+← / Ctrl+→ avec la grille active ; popover offset / limit / Go).
- `FilterBar` : une ligne par filtre : case (Ctrl+B), colonne (Any column, Raw SQL, colonnes), opérateur (ceux du type, existants), valeur, Apply (Enter : ce filtre seul), + (Ctrl+I dans la barre), − (Ctrl+Shift+I) ; Apply All [AND | OR] (Ctrl+Enter / Ctrl+Shift+Enter) ; Échap ferme une barre vide ; teinte « appliqué » sur les lignes actives.

- [ ] **Step 1: Tests qui échouent** : Rust `filters_combined_with_or` (query.rs + un test d'intégration par moteur), TS `bottom_bar_layout`, `columns_popover_hides_columns`, `page_popover_offset_limit`, `apply_row_applies_only_that_filter`, `apply_all_and_or`, `ctrl_b_toggles_filter`, `raw_sql_mode_uses_quick_syntax`, `filter_bar_keyboard_flow`, `escape_closes_empty_bar`.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test src/features/grid && cargo test --manifest-path src-tauri/Cargo.toml --lib query` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint && pnpm test:rust` → Expected: PASS ; manuel et captures.
- [ ] **Step 5: Commit** — `✨ feat(grid): bottom bar and TablePlus filter bar with AND / OR`

---

### Task 7: Panneau de détail à droite

**Files:**
- Modify: `src/features/grid/RowDetailPanel.tsx` (+ test), `src/features/workspace/WorkspaceView.tsx`, `src/lib/strings.ts`

**Interfaces:**
- Panneau à droite de la zone de contenu, 280 px (min 240, redimensionnable, largeur mémorisée), ouvert / fermé par Space et le bouton de la barre du haut ; recherche « Search for field… » ; un champ par colonne : nom, type, valeur éditable sur place (mêmes éditeurs et modifications en attente qu'aujourd'hui), JSON indenté ; « No row selected » quand rien n'est sélectionné.

- [ ] **Step 1: Tests qui échouent** : `space_and_button_toggle_panel`, `field_search_filters_fields`, `edit_in_panel_creates_pending_change`, `no_row_selected_state`, `panel_width_persists`.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test src/features/grid` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS ; manuel et captures.
- [ ] **Step 5: Commit** — `✨ feat(grid): right-side row detail panel`

---

### Task 8: Écran des connexions et formulaire

**Files:**
- Modify: `src/features/connections/ConnectionList.tsx` (+ test), `src/features/connections/ConnectionForm.tsx` (+ test), `src/features/connections/SslSection.tsx`, `src/features/connections/SshSection.tsx`, `src/features/connections/SafetySection.tsx`, `src/features/connections/connectionDraft.ts` (+ test), `src/lib/strings.ts`, `src/lib/keymap-actions.json`
- Create: `src/features/connections/DriverTile.tsx` (+ test)

**Interfaces:**
- Liste : volet gauche (logo TableMax, nom, version, Create connection…, Import connections…, Open SQLite file…) ; volet droit : `+` (Ctrl+N), recherche (Ctrl+F), groupes dépliables (état mémorisé), lignes 52 : `DriverTile driver` (monogramme `Pg`, `My`, `Ma`, `SL` sur fond propre au moteur), point de couleur, nom, badge du tag, sous-titre `tag : hôte:port : base` (SQLite : chemin) en monospace ; Entrée = connecter, menu contextuel existant ; `connection.open` (Ctrl+Shift+K) affiche la liste depuis un workspace.
- Formulaire : disposition de la maquette (colonne de libellés 104 px alignés à droite, champs 28 px, encadré « Over SSH »), couleur parmi 6 pastilles (`--swatch-1..6`) au lieu du sélecteur actuel, tag, safe mode ; boutons Import from URL… / Test / Save / Connect ; tient sans défilement pour PostgreSQL et MySQL sans SSH à 100 % dans une fenêtre de 900 px de haut.

- [ ] **Step 1: Tests qui échouent** : `welcome_pane_actions`, `groups_collapse_and_persist`, `row_shows_tile_tag_and_subtitle`, `search_filters_connections`, `enter_connects`, `form_fields_in_mockup_order`, `color_swatches_select`, `ssh_box_toggles`, `form_fits_without_scroll` (hauteur rendue ≤ 900 px à 100 %).
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test src/features/connections` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS ; manuel et captures.
- [ ] **Step 5: Commit** — `✨ feat(connections): TablePlus-like connection list and compact form`

---

### Task 9: Éditeur SQL — barre, résultats, complétion (#79)

**Files:**
- Modify: `src/features/editor/QueryTab.tsx` (+ test), `src/features/editor/SqlEditor.tsx` (+ test), `src/features/editor/ResultsPanel.tsx` (+ test), `src/features/editor/completion.ts`, `src/lib/keymap-actions.json`, `src/lib/strings.ts`

**Interfaces:**
- Barre de 36 px sous l'onglet : « No limit ⌄ » (LIMIT automatique existant), « Beautify » (Ctrl+I et Ctrl+Shift+F), « Run Current ⌄ » (Ctrl+Enter ; menu Run All Ctrl+Shift+Enter) ; résultats avec onglets Data / Message, grille de la Task 5.
- Coloration du §5.1 (sombre / clair) ; police `--font-mono` à `editorFontSize`.
- Complétion : Ctrl+Space ouvre la liste à chaque fois, y compris après un changement d'onglet ou de workspace (#79 : écrire d'abord le test qui reproduit la perte).

- [ ] **Step 1: Tests qui échouent** : `ctrl_space_opens_completion`, `ctrl_space_after_tab_switch` (#79), `toolbar_actions_and_shortcuts`, `results_tabs_data_message`, `editor_colors_follow_theme`.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test src/features/editor` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint` → Expected: PASS ; manuel et captures.
- [ ] **Step 5: Commit** — `✨ feat(editor): TablePlus editor toolbar, result tabs and reliable completion`

---

### Task 10: Open Anything et parité des raccourcis

**Files:**
- Modify: `src/features/palette/CommandPalette.tsx` (+ test), `src/features/palette/actions.ts` (+ test), `src/lib/keymap-actions.json`, `src/lib/keymapRegistry.ts`, `src/lib/keymap.ts` (+ test), `src/lib/shortcuts.ts` (+ test), `src-tauri/src/settings.rs` (ids connus), `src/features/settings/SettingsDialog.tsx`, `src/lib/strings.ts`
- Create: `src/lib/shortcutParity.test.ts`

**Interfaces:**
- `palette.all` = Open Anything, défaut **Ctrl+P** : objets par défaut, actions quand la saisie commence par `>` ; lignes 40 px ; `palette.objects` supprimé. `database.open` (Ctrl+K) : choisir base / schéma ; `connection.open` (Ctrl+Shift+K).
- Chaque ligne du §5.3 a une action avec son défaut et sa portée (`global`, `grid`, `editor`, `filterBar`, `connectionList`) ; les portées décident qui reçoit la frappe ; une frappe dans un champ texte n'est jamais prise par une action d'une autre portée.
- `shortcutParity.test.ts` : la table du §5.3, recopiée en données de test, est comparée au registre.

- [ ] **Step 1: Tests qui échouent** : `every_spec_shortcut_registered_with_default` (shortcutParity), `ctrl_p_opens_open_anything_objects`, `gt_prefix_lists_actions`, `ctrl_k_opens_database_picker`, `context_shortcuts_do_not_steal_text_input`, `old_palette_objects_remap_ignored`.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test src/lib src/features/palette` → Expected: FAIL.
- [ ] **Step 3: Implémenter.**
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint && cargo test --manifest-path src-tauri/Cargo.toml --lib settings` → Expected: PASS.
- [ ] **Step 5: Commit** — `✨ feat(keymap): Open Anything and TablePlus shortcut parity`

---

### Task 11: Réglages, documentation et vérification finale

**Files:**
- Modify: `src/features/settings/SettingsDialog.tsx` (+ test), `src/lib/strings.ts`, `README.md`, `docs/DEMO.md`, `CLAUDE.md`, `src/CLAUDE.md`
- Create: `docs/notes/ui-redesign-manual-check.md`, `docs/notes/ui-redesign-followups.md`

**Interfaces:**
- Réglages en sections General, Table, Editor, **Fonts & Themes** (thème System / Light / Dark, Interface size, tailles de police données / éditeur, police de l'éditeur), Keymap (liste du §5.3 par portée, réassignation existante), dans le nouveau style.
- `docs/notes/ui-redesign-manual-check.md` : parcours complet sur GNOME Wayland en sombre et en clair, à 100 % et 130 % : connexions, formulaire, fenêtre principale, barre latérale, onglets, grille (sélection, colonnes, menus), filtres AND / OR, panneau de détail, éditeur et complétion, Open Anything, raccourcis du §5.3, fenêtre à 960 px ; captures.

- [ ] **Step 1: Tests qui échouent** : `settings_sections_and_fields`, `interface_size_control_updates_zoom`.
- [ ] **Step 2: Vérifier l'échec** — Run: `pnpm test src/features/settings` → Expected: FAIL.
- [ ] **Step 3: Implémenter**, puis le parcours manuel complet.
- [ ] **Step 4: Vérifier** — Run: `pnpm test && pnpm lint && pnpm test:rust` → Expected: PASS ; parcours manuel consigné avec captures.
- [ ] **Step 5: Commit** — `✨ feat(settings): Fonts & Themes settings, docs and manual check of the redesign`

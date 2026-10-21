# UI redesign — manual check

**This is a checklist to run, not a record of a run.** Nothing below has been checked yet
on a real desktop: the implementers could only run unit tests (and, for Tasks 1–4, an
Xvfb session without a compositor). Tick the boxes as you go, write what you saw on the
"Result / notes" line of each area, and attach the screenshots listed.

Built from the manual test lists of the redesign's tasks (plan
`docs/superpowers/plans/2026-10-19-tablemax-ui-redesign.md`, Tasks 1–11, and issues #102,
#103, #104, #109), deduplicated and ordered by area. The expected behaviour is the spec
`docs/superpowers/specs/2026-10-19-tablemax-ui-redesign-design.md` with its dated
amendments. The layout follows TablePlus as a reference only: nothing of it is in the app.

## Setup

- [ ] GNOME on Wayland (Ubuntu 24.04 or newer), `main` up to date, `pnpm install`, then
      `pnpm dev`.
- [ ] Data: `pnpm demo:db` (the **Demo** group). **Demo · SQLite** needs no Docker; items
      marked **(PG)** or **(MySQL)** need `bash scripts/test-dbs.sh up` and the matching
      demo connection.
- [ ] One connection tagged `production` (e.g. **Demo · MariaDB 11**, or retag the SQLite
      one), and one with a long name (40+ characters).
- [ ] A table with JSON, NULL, empty strings, long text and a foreign key (the demo
      `orders`, `customers`, `edge_cases`).

Run every area in the four passes below (Settings → Fonts & Themes changes both at once).
Areas marked **(one pass)** need only the first pass.

| Pass | Theme | Interface size | Done |
|---|---|---|---|
| 1 | Dark | 100 % | [ ] |
| 2 | Light | 100 % | [ ] |
| 3 | Dark | 130 % | [ ] |
| 4 | Light | 130 % | [ ] |

Screenshots: put them in the PR or the issue that closes this check, named
`<pass>-<area>.png` (for example `2-grid.png`).

## 1. Themes, sizes and fonts

- [ ] Dark: window #1A1A1A-ish grey toolbar, content #1E1E1E, rows alternate; light:
      #ECECEC toolbar, white content. Nothing takes the colours of the GTK theme.
- [ ] **System** follows the desktop: switch GNOME between light and dark style; the app
      follows without a restart.
- [ ] Interface size 90 %, 100 %, 130 %: the whole window (grid included) scales at once;
      grid text stays sharp; clicks land on the right cell, row number and header;
      popovers and menus stay inside the window.
- [ ] Restart at 130 %: the window opens at 130 % (note any visible jump at startup).
- [ ] Data in JetBrains Mono (grid, sidebar tree, editor, status pill), interface in the
      system font, 13 px base.
- [ ] `Ctrl+=`, `Ctrl+-`, `Ctrl+Shift+=`, `Ctrl+Num +` / `Ctrl+Num −` change the grid and
      editor font sizes together; Settings shows the new values.
- [ ] Light theme readability: NULL / EMPTY / DEFAULT placeholders on both row colours,
      secondary texts, the row numbers.
- [ ] GNOME "Reduce animation" on (`gsettings set org.gnome.desktop.interface
      enable-animations false`): tooltips appear without motion. **(one pass)**

Result / notes:

Screenshots: `<pass>-themes.png`

## 2. Window and toolbar

- [ ] The toolbar is the title bar: drag it to move the window; double-click empty space
      maximizes and restores; the maximize button switches to Restore and back, also after
      a maximize done by GNOME (super+↑, drag to the top).
- [ ] Edge snapping (drag to the top, to a side) and resizing from every edge and corner.
- [ ] Minimize works; the window has a shadow and rounded corners under mutter.
- [ ] Minimum size 960 × 600.
- [ ] Window buttons (Linux): three 24 px round buttons (–, □, ×); hover darkens; close
      never turns red; close with pending changes asks first.
- [ ] Settings → General → **Use the system title bar**, restart: the GNOME header bar is
      above the toolbar and our window buttons are gone. Turn it off again. **(one pass)**
- [ ] Groups, left to right: [sidebar · connection] [Discard · Preview · Commit] [safe mode
      · database · SQL] status pill [reload · Open anything] [row details].
- [ ] Discard / Preview / Commit are active only with pending changes; Commit shows a count
      badge; while committing Discard becomes **Cancel** and works.
- [ ] Safe mode menu: levels, "Default (by environment)" checked; the icon is a closed lock
      for a production connection.
- [ ] Database button (`Ctrl+K`) lists databases / schemas.
- [ ] Tab through the toolbar: every button reachable, visible focus ring; off buttons
      (aria-disabled, #110) are reached too and show their tooltip; tooltips show on focus too.
- [ ] With the discard dialog open, press and double-click on the dimmed overlay: the window
      neither moves nor maximizes.
- [ ] (Windows build, if any) flat 46 px caption buttons over the toolbar's height; close
      red with a white × on hover. **(optional)**

Result / notes:

Screenshots: `<pass>-toolbar.png`, `<pass>-maximized.png`

## 3. Status pill

- [ ] Local connection: grey `LOCAL` badge, then `PostgreSQL 16.x : <connection> : <db> :
      public.<table>` in monospace; the name appears once when it equals the database.
- [ ] Light: a pale tint of the connection colour, dark text; dark: a dark tint, light text.
      Readable with each of the 6 colours (change the colour while connected: the pill
      follows).
- [ ] Retag dev / staging / prod: `DEV` blue, `STAGING` amber, `PROD` red, live.
- [ ] Through an SSH tunnel: `: SSH :` after the version. **(PG)**
- [ ] The pill takes the free width; a strip on each side still drags the window.
- [ ] Narrow the window: the text gets an ellipsis, the `PROD` badge is never cut, nothing
      wraps.
- [ ] Production connection: `[PROD]` at the end of the window title.
- [ ] Click the pill (or Enter on it): engine, server, host, user, database, TLS; Edit,
      Reconnect (disabled while connected), Disconnect.
- [ ] Connecting / reconnecting / error states show in the pill; a long error wraps in its
      tooltip.

Result / notes:

Screenshots: `<pass>-pill.png`, `<pass>-pill-prod-960.png`

## 4. Connections screen and form

- [ ] Start with no session: welcome pane on the left (our icon, "TableMax", version,
      **Create connection…**, **Import connections…**), the list on the right. Light: grey
      pane, white list; dark: both dark, told apart by the separator.
- [ ] Rows about 52 px: driver tile `Pg` / `My` / `Ma` / `SL` with white letters, colour dot
      (visible for all six colours, the pale ones in light too), name, tag badge, monospace
      subtitle `local : localhost:5432 : db` (a SQLite row shows its path).
- [ ] Groups fold and the chevron turns; a folded group stays folded after a restart; a
      search match opens a folded group.
- [ ] Keyboard: `Ctrl+F` focuses the search, ↓ goes to the first row, ↑ / ↓ / Home / End
      across groups with a visible ring, Enter connects, `Shift+F10` opens Connect /
      Edit…, Tab leaves the list in one step.
- [ ] Mouse: a click selects (grey), a double-click connects, a right-click opens the menu.
- [ ] Form (PostgreSQL, then MySQL), 100 %, 900 px high window: nothing scrolls, centred,
      620 px wide, labels right-aligned in one column; order: Driver; Name + Group;
      Color + Tag; Safe mode; Host + Port; User; Password + storage; Database; SSL mode +
      CA… / Cert… / Key…; Over SSH; Import from URL… … Test / Save / Connect.
- [ ] Colour: six round swatches visible in both themes, ring on the chosen one, arrow keys
      move; after Save the list dot and the pill tint follow.
- [ ] SSL files: CA… opens the native picker; a chosen file adds its line with path and
      Clear. A remote host with Prefer shows the warning under the SSL line.
- [ ] Over SSH: ticking opens the tunnel lines inside the box, labels aligned with the
      form's label column; Key auth adds Key file + Browse…; Agent hides the password.
- [ ] Import from URL…: `mysql://root:pw@127.0.0.1:3306/shop` fills a new form (name `shop`,
      password pre-typed); on a saved connection name, colour and tag stay.
- [ ] Test / Save / Connect as before: host key prompt, passphrase prompt, "Re-enter the
      password" after an identity change. **(PG)**
- [ ] Unsaved edits: edit a name, then try ←, `Ctrl+Shift+K`, `Ctrl+N`, `Ctrl+P` → New
      connection, the pill's Edit: each asks "Discard changes to this connection?"; Cancel
      keeps, Discard drops; with no edits nothing asks. Switching to a workspace and back
      keeps the edited form.
- [ ] Delete (header icon) asks "Delete <name>?"; Cancel keeps; Delete removes and returns
      to the list.
- [ ] Focus: a saved connection opens on Name, a new one on Driver; ← returns the focus to
      the selected row.
- [ ] Escape (#118): on a clean form, from Name, a select, a checkbox or after a click on
      the page, the list comes back at once, focus on the selected row (else the search). On
      an edited form it asks "Discard changes to this connection?"; Escape there keeps the
      form and its edits. Escape with Import from URL…, Delete's question, a Test prompt, an
      open select popup or a shown tooltip closes only that. In Group (with suggestions):
      type a letter, the first Escape closes the suggestions, the second asks "Discard
      changes to this connection?" (the form is now edited).
- [ ] Escape with the focus in the toolbar or the open connections column: the form stays.
- [ ] Group: if the first Escape already closes the suggestion list and a second one is
      still swallowed (nothing happens), report it.
- [ ] From a workspace: `Ctrl+Shift+K` shows the list with its search focused (also from the
      SQL editor, where the line is not deleted); `Ctrl+N` opens a blank form.
- [ ] Toolbar safe mode changed while that connection's form has edits: back on the form,
      the safe mode line shows the new level and the edits are still there.
- [ ] A Test prompt arriving while a workspace is shown: no invisible dialog (`Ctrl+Shift+K`,
      `Ctrl+P`, Escape work); back on the connections screen the prompt is shown. **(PG)**
- [ ] Import connections… opens the import dialog. **(one pass)**

Result / notes:

Screenshots: `<pass>-connections.png`, `<pass>-form.png`

## 5. Open connections column

- [ ] One neutral rounded tile per open connection, outlined database icon in its colour,
      the name in small text below (long names cut); the active one has a panel behind it;
      the others highlight on hover; × on hover closes.
- [ ] `Ctrl+Shift+]` / `Ctrl+Shift+[` and `Ctrl+Shift+PageDown` / `PageUp` cycle.
- [ ] The settings button (sliders) at the bottom opens Settings and stays there with many
      connections (the tiles scroll).
- [ ] On the connections screen with no workspace, the toolbar gear opens Settings; with a
      workspace open the toolbar has no gear.
- [ ] During a commit the tile's × gives its reason (tooltip) and does nothing.

Result / notes:

Screenshots: `<pass>-column.png`

## 6. Sidebar

- [ ] Items / Queries / History segmented control: click, and from the keyboard (Tab to it,
      ← / → / Home / End move and show); remembered per workspace.
- [ ] Items: "Tables", "Views", "Functions" as plain headers with a chevron, no counts;
      SQLite and a schema without functions: no Functions header.
- [ ] Table icon a blue grid, view icon a purple framed eye, readable on hover and on the
      selected row; tree in monospace, 24 px rows.
- [ ] A table's chevron: "Loading columns…" flashes, then the columns (dimmed types); no tab
      opens; collapse / expand again is instant. Same for a view.
- [ ] Keyboard on a table row: → opens, → again enters the columns; ← back, ← closes, ← to
      the section; Enter opens the tab.
- [ ] `Ctrl+R` (or ⌄ → Refresh) with a table's columns open and focused: the columns stay
      visible, the focus stays; a column added meanwhile in another client appears; a
      table dropped elsewhere disappears with no error row. **(PG)**
- [ ] Search (`Ctrl+Shift+F`) with its options menu (Contains / Starts with / Ends with,
      Tables, Views): keyboard ↑ / ↓ / Home / End, Escape gives the focus back.
- [ ] Object menu (right-click or `Shift+F10`): Open in new tab, Open structure, Copy name,
      Copy script as (CREATE, SELECT top 100), Refresh.
- [ ] Queries: a click opens the query in a linked tab (or activates it); menu Run, Copy,
      Insert into SQL editor, Rename…, Delete (asks).
- [ ] History: a click opens a new SQL tab with the text; menu Run, Copy, Insert into SQL
      editor, Delete; the list refreshes after each run; Clear history.
- [ ] Footer: `[+ | ⌄]` and the schema picker only; ⌄ opens New SQL query / Refresh, and a
      second click on ⌄ closes the menu.
- [ ] `Ctrl+0` hides and shows the sidebar; `Ctrl+Shift+H` shows it on History; drag the
      edge (min 240) or use ← / → on it; the width is kept after a restart.
- [ ] Long table names are cut with an ellipsis and get a tooltip only when cut.

Result / notes:

Screenshots: `<pass>-sidebar-items.png`, `<pass>-sidebar-history.png`

## 7. Tabs

- [ ] Capsules share the bar; with many tabs the bar scrolls and the active one scrolls
      into view; the preview tab is italic.
- [ ] One tab: it spans the bar, label centred, its × only on hover or keyboard focus (a
      mouse click does not leave it visible); with two tabs the active × always shows.
- [ ] Right end: split button and ⌄ (tab list), no `+`; `Ctrl+T`, the toolbar's SQL and the
      sidebar's + open a SQL tab.
- [ ] Tab menu (right-click, `Shift+F10`): New tab / Close / Close others / Rename… (`F2`);
      rename in place, Enter / Escape; a long name is cut with a tooltip.
- [ ] Keyboard: one Tab stop on the active tab, ← / → / Home / End, Enter or Space
      activates, Delete closes.
- [ ] A table tab on Structure (or Index) comes back on Structure after a workspace switch.
- [ ] Back / forward arrows and `Alt+←` / `Alt+→`; disabled at the ends, with their tooltip.
- [ ] `Ctrl+W` on a tab with pending changes asks "Discard N pending changes?": Cancel
      gives the focus back to where it was; Discard closes it and the tab now shown has the
      focus (not lost).
- [ ] During a commit a tab's × gives its reason and does nothing.

Result / notes:

Screenshots: `<pass>-tabs.png`

## 8. Grid

- [ ] Data in monospace, headers in the interface font (medium, centred; a long name in a
      narrow column stays left-aligned and cut), 26 px rows, 30 px header, alternate rows.
- [ ] `NULL`, `EMPTY`, `DEFAULT` as pale upper-case placeholders.
- [ ] Row numbers: the header's background and text on every row (no zebra), a faint line
      before the first column; the same on inserted, deleted and failed rows (never struck
      through).
- [ ] A click on a row number selects the row (number white on deep blue, the row deep
      blue with readable white text); Shift+click extends; Ctrl+click adds / removes; the
      corner selects or clears all (checkbox on hover).
- [ ] A click in a cell: red border on the active cell. Edited cells on a selected row keep
      their yellow.
- [ ] Header click sorts asc → desc → none and never selects the column.
- [ ] Columns are sized on their content (60–400 px); drag a header to reorder; double-click
      a border to fit; a single press on a border does not shrink the column.
- [ ] Header menu: Filter with column, Hide column, Fit to content, Reset positions, Show
      all, Sort asc / desc / remove, Copy column name.
- [ ] Cell menu (right-click, `Shift+F10`): Quick Look, Open referenced row (FK), Set value
      NULL / EMPTY / DEFAULT, Revert cell, Copy rows, Copy rows as TSV / CSV / CSV + header
      / JSON / Markdown / INSERT, Copy selected cells, Quick filter IS NULL / = value, Add
      row, Duplicate, Delete / Restore.
- [ ] Enter: Quick Look (whole value, JSON indented, long text loaded); Escape returns the
      focus. Alt+Enter or a double-click edits; typing starts an edit.
- [ ] `Ctrl+Shift+C`, `Ctrl+D`, `Ctrl+Backspace` / Delete act on the selection; paste the
      copies in a text editor and check the formats.
- [ ] A read-only cell (generated column) double-clicked: the reason shows above the grid.
      No Commit / Discard strip above the grid.
- [ ] `Ctrl+click` a foreign key: the referenced table filtered in the same tab, breadcrumb
      above the grid; `Alt+←` goes back.
- [ ] JetBrains Mono loads and the grid redraws once with it (no fallback font left).

Result / notes:

Screenshots: `<pass>-grid.png`, `<pass>-grid-selection.png`, `<pass>-grid-menus.png`

## 9. Bottom bar, columns and pages

- [ ] 42 px; [Data | Structure | Index] · `+ Row` · count in the middle · Filters ·
      Columns · [‹ | ⚙ | ›]; the active segment is deep blue with white text.
- [ ] Count: "1 of N rows selected" with a selection; "N rows" for a table on one page; the
      range ("301–600 of 1,250 rows") otherwise; "Committing…" during a commit.
- [ ] Index view (`Alt+3`): name, PRIMARY badge, columns, Yes / No, type (`btree`…),
      condition of a partial index; Structure has no Indexes section. MySQL: type and
      condition empty. **(PG)**
- [ ] Columns (`Alt+F`): one checkbox per column, Space hides / shows at once, the last
      column cannot be hidden, Show all, Escape returns to Columns.
- [ ] ⚙: offset 250, limit 100, Go → rows 251–350; a bad number says why next to the field.
- [ ] `Ctrl+→` / `Ctrl+←` page with the grid focused; in a filter field they still jump words.
- [ ] Tab through the bar: each control shows its tooltip with its key; tooltips flip above
      the bar and stay inside the window.

Result / notes:

Screenshots: `<pass>-bottom-bar.png`, `<pass>-index.png`

## 10. Filters (AND / OR)

- [ ] `Ctrl+F` in the grid opens the bar with the focus on row 1's column; `Ctrl+F` in the
      bar closes it and the grid has the focus; Filters (filled deep blue while open)
      toggles it.
- [ ] Row: `[✓] [column] [operator] [value…] [Apply] [−] [+]`; footer `[⚙] [Export]
      [SQL]`, the hint line (cut with an ellipsis at 960 px), `[Clear] [Apply All] [AND ⌄]`.
- [ ] Type a value, Enter: that row alone applies, tinted (visible but subtle in both
      themes).
- [ ] Two rows, Apply All: AND; ⌄ → OR applies at once and the ⌄ reads OR;
      `Ctrl+Enter` / `Ctrl+Shift+Enter` apply with AND / OR. Check the rows and the count.
- [ ] Keys in the bar: `Ctrl+I` adds a row, `Ctrl+Shift+I` removes (in `pnpm dev` note
      whether it opens the WebKit inspector instead), `Ctrl+B` turns a row on / off (also
      from the value field), `Ctrl+↑` / `Ctrl+↓` move between rows, `Alt+C` / `Alt+O` jump to
      the column / operator.
- [ ] `Esc` hides the bar with text typed; `Ctrl+F` reopens it with the text still there.
      With a tooltip shown, the first Escape closes only the tooltip.
- [ ] Raw SQL: `notes contains 'x'` (read as a filter), `total > 2 * quantity` (SQL),
      `a = 1 AND b = 2` under OR (SQL); the label next to the row says how it is read.
- [ ] SQL button: the `WHERE …` with the real values (`WHERE "notes" LIKE '%e%'`), Copy,
      paste in a SQL tab → same rows; a row with an error says "Fix the conditions marked
      in red first."; Escape returns to SQL and the bar stays open. **(PG)**: `id = 42`
      shows `"id" = 42`, a date `'2024-01-31'::date`. **(MySQL)**: `it's \x` shows
      `'it''s \\x'`.
- [ ] ⚙ menu: add / remove / on-off act on the row last focused; Clear all; Hide. Export is
      dim with "not available" as tooltip.
- [ ] Cell menu → Quick filter opens the bar with the new row tinted; under OR with two
      filters it replaces them. Header "Filter with column" opens the bar on that column
      with the value focused.
- [ ] FK jump: the breadcrumb and the bar show the FK filter; an OR view's crumb reads
      "… OR …".

Result / notes:

Screenshots: `<pass>-filters.png`, `<pass>-filters-sql.png`

## 11. Row details panel

- [ ] `Ctrl+Space` opens the panel on the right (about 280 px): "Search for field…" with a
      round ×, fields in column order (name bold, type dimmed, value in a monospace box);
      the grid keeps the focus and the panel follows the arrow keys.
- [ ] `Space` in the grid toggles it; the toolbar's button too (looks pressed while open).
- [ ] Switch to another table tab and another workspace and back: the panel stays open and
      shows that tab's row (or "No row selected"); `Ctrl+Space` toggles every time.
- [ ] A SQL tab: no panel, the toolbar button is greyed, `Ctrl+Space` opens the completion.
- [ ] Field search: "id" filters; "zzz" shows "No field matches".
- [ ] Edit a value: pending colour, the grid cell shows as edited, Commit counts 1, Preview
      shows the UPDATE, Undo / Discard revert, Commit writes.
- [ ] JSON indented; typing then erasing back to the original reverts; NULL shows an empty
      box with the placeholder.
- [ ] A view or a table without a key: read-only fields, no Set NULL buttons.
- [ ] Resize: drag the left edge (min 240, never more than 60 % of the content area) or
      ← / → on it; the width is kept after a restart.
- [ ] Escape in a field, or `Ctrl+Space` there, gives the focus back to the grid.
- [ ] Switching to a slow table: the panel stays, "No row selected", until the rows arrive.

Result / notes:

Screenshots: `<pass>-row-details.png`

## 12. SQL editor and completion

- [ ] Bar under the tab (36 px): "No limit ⌄ · Beautify … Save · Run Current ⌄"; tooltips
      show `Ctrl+I` and `Ctrl+Enter`; Tab into it, ← / → between buttons, Enter opens the
      menus, ↑ / ↓ inside, Escape back to the button.
- [ ] Colours: keywords blue, numbers violet, strings red-pink, comments green, built-in
      functions green; readable on and off the current-statement band in both themes; no
      bold or italic.
- [ ] The current statement's background follows the cursor (not on a comment after the
      previous `;`); a selection hides the band and uses the selection colour.
- [ ] No limit ⌄ → Limit 1000: the button reads "Limit 1000" and a SELECT gets LIMIT 1000.
- [ ] Beautify / `Ctrl+I` / `Ctrl+Shift+F` format the selection or all; `Ctrl+Z` restores.
- [ ] Run Current runs the statement under the cursor; ⌄ → Run All (`Ctrl+Shift+Enter`).
      During `select pg_sleep(5)` Run is greyed and Cancel shows; Cancel → Message says
      Cancelled. **(PG)**
- [ ] Results: a SELECT shows Data with "N rows · ms"; an UPDATE alone shows Message;
      two SELECTs show Result 1 / Result 2; an error shows in Message; ← / → between Data
      and Message.
- [ ] Completion: `Ctrl+Space` opens it; after switching tabs (click, `Ctrl+1…9`,
      `Ctrl+Tab`) or workspaces and back, it still opens, without clicking in the editor
      after a keyboard switch.
- [ ] `Ctrl+T` from the editor or the grid lands in the new editor, ready to type.
- [ ] `Ctrl+S` saves the query (named the first time); the tab shows a dot while modified.

Result / notes:

Screenshots: `<pass>-editor.png`, `<pass>-editor-results.png`

## 13. Open anything

- [ ] `Ctrl+P`: tables, tabs and connections, no actions; 40 px rows.
- [ ] `>`: only actions, each with its shortcut; `> close` narrows; "Change schema…" then
      Escape returns to the actions list.
- [ ] `> show conn`: "Show connections" shows `Ctrl+Shift+K`; picking it shows the list
      with its search focused.
- [ ] The toolbar's ⌘ button opens it, tooltip "Open anything" with `Ctrl+P`.

Result / notes:

Screenshots: `<pass>-open-anything.png`

## 14. Shortcuts (spec §5.3) — (one pass, both themes not needed)

Each default once, in its context. In a text field, the editor or a filter value, the
context keys (`Ctrl+←/→`, `Ctrl+I`, `Ctrl+F`, `Ctrl+Enter`, `Space`) keep their text
meaning.

- [ ] `Ctrl+,` settings · `Ctrl+T` / `Ctrl+E` new SQL tab · `Ctrl+W` close tab
- [ ] `Ctrl+Tab` (recent order) · `Ctrl+]` / `Ctrl+[` · `Ctrl+PageDown` / `Ctrl+PageUp`
- [ ] `Ctrl+1` … `Ctrl+9` (`Ctrl+9` = ninth tab)
- [ ] `Ctrl+Shift+]` / `Ctrl+Shift+[` · `Ctrl+Shift+PageDown` / `PageUp` (connections)
- [ ] `Ctrl+P` Open anything · `Ctrl+K` database / schema · `Ctrl+Shift+K` connection list
      · `Ctrl+N` new connection
- [ ] `Ctrl+0` sidebar · `Ctrl+Shift+F` sidebar search (formats in the editor instead) ·
      `Ctrl+Shift+H` history
- [ ] `Ctrl+Space` / `Space` row details · `Alt+1` / `Alt+2` / `Alt+3` views (GNOME takes
      none of them; `Ctrl+Alt+…` types nothing in the grid)
- [ ] `Alt+←` / `Alt+→` back / forward (FK trail first)
- [ ] `Ctrl+F` filters · `Alt+F` columns · `Ctrl+B`, `Ctrl+I`, `Ctrl+Shift+I`,
      `Ctrl+Enter`, `Ctrl+Shift+Enter` in the filter bar
- [ ] `Ctrl+←` / `Ctrl+→` pages (grid focused)
- [ ] `Ctrl+S` commit · `Ctrl+Shift+Backspace` discard (asks: Enter discards, Escape keeps;
      not while typing in a filter field) · `Ctrl+Shift+P` preview
- [ ] `Ctrl+I` add row · `Ctrl+D` duplicate · `Ctrl+Backspace` / Delete · `Ctrl+Shift+C`
      copy · Enter Quick Look · `Alt+Enter` edit
- [ ] `Ctrl+Enter` / `Ctrl+Shift+Enter` run · `Ctrl+/` comment · `Ctrl+I` beautify ·
      `Ctrl+Space` completion
- [ ] `Ctrl+=` / `Ctrl+-` font size
- [ ] `Ctrl+R` reload all · `Alt+R` reload this table only (the sidebar does not flash) ·
      `Ctrl+Shift+R` connects a restored, disconnected workspace (prompts included)
- [ ] Rebind one action in Settings → Keymap and use it; reset it. A custom Data view key
      set to `Ctrl+B`: with the focus in the filter bar, `Ctrl+B` still toggles the filter.
- [ ] Collision flag: put `"grid.copyCells": "Mod+Shift+P"` in `settings.json`, restart: the
      Copy row says "Also used by Preview the SQL of pending changes…", and the file is
      unchanged.
- [ ] AZERTY layout: `Ctrl+W` (key labelled W) closes, `Ctrl+Z` does not; `Ctrl+&`,
      `Ctrl+é`… go to tabs; `Ctrl+Shift+=` ("+") enlarges; Ctrl + the "-" key (6) goes to
      tab 6 (by design, #105: `Ctrl+)` and the keypad's − shrink); `Ctrl+,` (the key labelled
      ",") opens Settings, `Ctrl+;` no longer does; `Ctrl+!` and `Ctrl+Shift+:` comment in the
      editor. AltGr+E in the grid types nothing and starts no edit; in an edited cell
      AltGr+E types €.
- [ ] A non-Latin layout (Russian or Greek): `Ctrl` + the key at QWERTY's W closes the tab.
- [ ] Russian (#131): type a Russian letter, then `Ctrl` + the "/" keycap comments in the
      editor and `Ctrl` + the "[" / "]" keycaps go to the previous / next tab. Hebrew: same,
      after a Hebrew letter (`Ctrl` + the Q keycap does not comment). Switch back to AZERTY,
      type a letter: `Ctrl+,` (the "," key) opens Settings again, `Ctrl+!` comments.
- [ ] Hebrew: `Ctrl+W` closes the tab right after switching layout, before typing.

Result / notes:

## 15. Tooltips and pointer — (one pass)

- [ ] Hover a toolbar icon: tooltip after about 0.3 s with a fade; moving to the neighbour
      shows at once; the key drawn as a key.
- [ ] Leaving the control hides it at once; a click hides it until the pointer leaves.
- [ ] Hover a disabled control with a reason (Commit while another tab commits): tooltip
      and screen reader text give the reason; Enter, Space and a click do nothing.
- [ ] Off buttons (#110: Back at the start, Prev on page 1, Discard / Preview / Commit with
      nothing pending, Reload while disconnected): dimmed, arrow cursor, tooltip on hover and
      on Tab focus; a click, Enter and Space do nothing.
- [ ] Hand cursor on buttons, tabs, menu items, sidebar rows, selects and checkboxes; arrow
      on disabled ones and on Export; the grid keeps its own cursors.

Result / notes:

## 16. Settings

- [ ] `Ctrl+,` and the column's sliders button open it; sections on the left: General,
      Table, Editor, Fonts & Themes, Keymap; Tab reaches the list once, ↑ / ↓ / Home / End
      move and show; Escape closes and the focus returns to the opener.
- [ ] General: system title bar (with its "next start" note), version, license, repository.
- [ ] Table: page size and count threshold; a bad number shows the range and saves nothing;
      Enter or leaving the field saves.
- [ ] Editor: Auto LIMIT and its default value; a new SQL tab uses them.
- [ ] Fonts & Themes: theme System / Light / Dark applies at once; Interface size 90–130 %
      zooms the window at once and is kept after a restart; data and editor font sizes;
      the editor font (`JetBrains Mono, monospace`; an invalid name shows an error).
- [ ] Keymap: groups Everywhere, Table tabs, Filter bar, SQL tabs, SQL editor, Connection
      list; each row shows all its keys (Next tab: "Ctrl+Tab, Ctrl+], Ctrl+PageDown");
      Change → press a combination; one in use is refused with its owner; Reset.
- [ ] The dialog fits at 130 % in a 960 × 600 window (the section scrolls, not the window).

Result / notes:

Screenshots: `<pass>-settings-fonts.png`, `<pass>-settings-keymap.png`

## 17. Narrow window (960 px) — (dark and light at 100 %, then 130 %)

- [ ] Toolbar: every group on one line, the pill cut before its badge.
- [ ] Tabs and the sidebar tree truncate with an ellipsis; nothing wraps onto two lines.
- [ ] Bottom bar: nothing wraps (the right group is the widest); the count stays centred;
      popovers stay inside the window above their buttons.
- [ ] Filter bar: the hint line cut with an ellipsis; rows on one line.
- [ ] Editor bar: no wrap; the linked query name truncates.
- [ ] Row details at 60 % cap: the grid keeps at least 40 %; widening brings the saved
      width back.
- [ ] Connection form and Settings dialog usable without horizontal scrolling.

Result / notes:

Screenshots: `<pass>-960.png`

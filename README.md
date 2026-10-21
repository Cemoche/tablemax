# TableMax

A free, fast desktop database client. Tauri 2 + React + TypeScript + Rust.

**New here? Take the 10-minute tour: [docs/DEMO.md](docs/DEMO.md).**

## Download (Linux)

Ready-made packages are on the **[Releases page](https://github.com/Cemoche/tablemax/releases)**
(Linux x86_64 only for now; Windows and macOS are planned: [#21](https://github.com/Cemoche/tablemax/issues/21), [#20](https://github.com/Cemoche/tablemax/issues/20)). They are built on
Ubuntu 22.04 by `.github/workflows/release.yml`, so they run on **Ubuntu 22.04, Debian 12
and newer** (glibc 2.35), and each release is smoke-tested on Ubuntu 24.04.

- **Ubuntu / Debian — `.deb`** (`TableMax_<version>_amd64.deb`, Debian package name
  `table-max`): `sudo apt install ./TableMax_<version>_amd64.deb`. apt pulls in WebKitGTK
  4.1 and GTK 3 from the distribution. Run `tablemax` or use the "TableMax" desktop entry
  (category Development). Remove with `sudo apt remove table-max`.
- **Other distributions — AppImage** (`TableMax_<version>_amd64.AppImage`), bundles
  WebKitGTK, GTK and their libraries (X11/Wayland, fonts and Mesa EGL/GL come from the
  system, as for any AppImage): `chmod +x TableMax_*.AppImage && ./TableMax_*.AppImage`.
  It needs FUSE 2 (`libfuse2t64` on Ubuntu 24.04, `libfuse2` on 22.04, `fuse-libs` on
  Fedora); without it, run it with `APPIMAGE_EXTRACT_AND_RUN=1`. Its GTK hook picks a light
  or dark Adwaita theme from the desktop's `color-scheme` setting, and the app's "System"
  theme follows that; `APPIMAGE_GTK_THEME=Adwaita:dark` forces dark.
- Check a download: `sha256sum -c SHA256SUMS --ignore-missing`.

### Build the packages yourself

`pnpm build:app` (`tauri build`) writes `src-tauri/target/release/bundle/deb/*.deb` and
`bundle/appimage/*.AppImage`. Neither bundles its own libc: they need a glibc at least as
new as the build machine's (an AppImage built on Ubuntu 26.04 needs glibc 2.43 and fails on
24.04 with ``version `GLIBC_2.43' not found``). Build on the oldest distribution you want to
support. Check a build with `bash scripts/release-smoke.sh glibc 2.35 <package>…`,
`… deb <file.deb>` (clean `ubuntu:24.04` container) and `… appimage <file.AppImage>` (Xvfb).

### Cutting a release (maintainers)

With Claude Code: **`/release [version]`** (or "make a release") runs the steps below, proposes
the version from the commits since the last tag, and asks before pushing the tag. By hand:

1. `bash scripts/release-bump.sh <version>` sets the version in `package.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`; commit it
   through a normal issue and PR (that PR also runs the Release build and smoke tests).
2. Once it is merged: `git tag -a v<version> origin/main -m "TableMax <version>" && git push origin v<version>`
   (`v<version>-beta.1` and the like make a prerelease).
3. The Release workflow checks that the tag matches the three versions, builds, smoke-tests
   and publishes the GitHub Release with both packages, `SHA256SUMS` and generated notes.
   A failed run publishes nothing: fix, delete the tag, tag again. Then check the published
   files: `gh release download v<version>` and `sha256sum -c SHA256SUMS`.

Runtime notes: saving passwords in the keyring needs a Secret Service provider
(GNOME Keyring or KWallet, present on standard desktops); without one, choose "Ask each
time" for passwords. App data (connections, `settings.json`, the app's `known_hosts`, saved
queries) lives in `~/.local/share/io.github.cemoche.tablemax/` (the app identifier). Builds
made before the identifier changed (#49, before the first release) used
`~/.local/share/dev.tablemax.app/`: its content is moved at the first start of a newer build,
and SQLite connections to files inside it follow. Saved passwords stay
under the keyring service `dev.tablemax.app`.

The app icon is drawn for TableMax (`assets/icon/tablemax.svg`); `pnpm icons` regenerates
`src-tauri/icons/` from it.

## Development

Prerequisites (Ubuntu): `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`, Node 22, pnpm, Rust, Docker.

```bash
pnpm install
pnpm dev          # tauri dev
pnpm test         # frontend tests (vitest)
pnpm test:rust    # starts test databases, runs cargo tests
pnpm lint         # tsc + clippy
```

## Contributing

Pick an issue with no assignee, assign yourself, work on a branch `issue-<n>-<slug>` and
open a pull request to `main` with `Closes #<n>`; the owner merges. Setup, workflow and
rules (for people and their Claude Code agents) are in [CONTRIBUTING.md](CONTRIBUTING.md);
agent rules in [CLAUDE.md](CLAUDE.md).

## License

TableMax is free software: you can redistribute it and modify it under the terms of the GNU
General Public License, version 3 or (at your option) any later version. It is distributed
without any warranty. See [LICENSE](LICENSE) for the full text.

## Connections

The connections screen shows a welcome pane (**Create connection…**, **Import
connections…**) and the list of saved connections, filed in groups that fold. `Ctrl+F`
searches the list (name, group, host, database, path); the arrow keys move through the
rows, `Enter` or a double-click connects, right-click or `Shift+F10` opens **Connect** /
**Edit…**. The form opens in place of the list (`+`, `Ctrl+N`, **Create connection…**,
**Edit…**; **←** goes back, and unsaved edits are never dropped without asking). From an
open connection, `Ctrl+Shift+K` shows the list again.

- **SSL / TLS**: modes `disable`, `prefer`, `require` (encrypted, certificate not checked),
  `verify-ca` (chain checked, not the name; PostgreSQL only for now) and `verify-full`
  (chain and host name). Optional CA, client certificate and key files. New connections
  default to `verify-full` for remote hosts and `prefer` for local hosts or SSH tunnels.
- **SSH tunnels**: password, private key (passphrase asked when the key is encrypted) or
  SSH agent. `~/.ssh/config` aliases are resolved (`HostName`, `User`, `Port`,
  `IdentityFile`). An unknown host key is shown as a `SHA256:…` fingerprint to confirm,
  then saved in the app's `known_hosts`; a changed key blocks the connection.
- **MongoDB** (experimental, shown only with `TABLEMAX_EXPERIMENTAL=mongodb`): MongoDB
  4.4 or newer (older servers are refused with an explanation). TLS modes `disable`,
  `require` and `verify-full`, checked against the bundled Mozilla roots or the CA file
  (not the system store: a server signed by a company CA needs its CA file). Through an
  SSH tunnel only one host, without `mongodb+srv://`, `replicaSet` or `verify-full`.
- **Groups**: connections can be filed under a group; groups fold in the connection list.
- **URLs**: "Copy URL" in the form (never includes the password) and "Import from URL…" in the form
  (`postgresql://`, `mysql://`, `mariadb://`, `sqlite://`; `sslmode`, `ssh`, `ssh-auth`
  parameters).
- **Import connections…** (on the connections screen): reads a `.tableplusconnection` file
  with its export password, lists its connections (duplicates of existing ones are
  unchecked) and imports the chosen ones. Exports do not carry SSH key paths, SSL
  settings or colors: set them afterwards in the connection form.

Passwords, SSH passwords and key passphrases live only in the system keyring (or are
asked at each connect), never in `app.db`.

## The main window

- **Toolbar** (it is also the title bar; a setting brings back the system one): sidebar and
  connection buttons; **Discard · Preview · Commit** for the pending changes of a table
  tab; safe mode, database (`Ctrl+K`) and **SQL** (new SQL tab); in the middle the status
  pill (tag badge such as `PROD`, engine and version, `SSH` through a tunnel, connection,
  database, `schema.object`; click it for the connection details, **Edit**, **Reconnect**,
  **Disconnect**); reload (`Ctrl+R`), **Open anything** (`Ctrl+P`) and the row details
  panel. A `production` connection also shows `[PROD]` in the window title.
- **Open connections**, the narrow column on the left: one tile per open connection, in
  its colour (`Ctrl+Shift+[` / `Ctrl+Shift+]` switch); the settings button sits at its
  bottom.
- **Sidebar** (`Ctrl+0` shows or hides it; drag its edge to resize): **Items** (tables,
  views and functions of the schema; a table or view's chevron lists its columns),
  **Queries** (saved queries) and **History**, each with its search (`Ctrl+Shift+F`).
  Single-click a table for a preview tab (*italic*, reused), double-click to keep it. At the
  bottom: **+** (new SQL tab), **⌄** (New SQL query, Refresh) and the schema picker.
- **Tabs**: capsules sharing the bar, back / forward arrows (`Alt+←` / `Alt+→`), the list of
  all tabs (**⌄**). Right-click a tab for New tab / Close / Close others / Rename… (`F2`).
- **Open anything** (`Ctrl+P`): tables, views, tabs and connections; type `>` first for
  the actions (each with its shortcut).

## Table tabs

Opening a table shows its rows in a grid (300 rows a page). The bar under the grid holds
**Data | Structure | Index** (`Alt+1` / `Alt+2` / `Alt+3`), **+ Row**, the count in the
middle (`1–300 of 1,250 rows`, `415 rows`, or `1 of 415 rows selected`), **Filters**,
**Columns** and the pager **‹ ⚙ ›** (⚙ sets the offset and the page size).

- **Grid**: click a row number to select the row, `Shift`+click to extend, `Ctrl`+click to
  add or remove a row; click a header to sort (ascending, descending, none), drag it to move
  the column, double-click its right edge to fit the width. Right-click a header for Filter
  with column, Hide column, Fit to content, Reset positions, Show all, Sort and Copy column
  name. `Enter` shows the whole value of a cell (Quick Look, JSON indented).
- **Editing**: double-click a cell, press `Alt+Enter` or start typing. Right-click a cell for
  **Set value** (NULL, EMPTY, DEFAULT for new rows), **Revert cell**, copies, **Quick
  filter**, **Add row**, **Duplicate**, **Delete** / **Restore**. Edits are not written right
  away: changed cells, new rows and rows to delete are highlighted as **pending changes**.
  Only tables with a primary key (or a unique index on `NOT NULL` columns) can be edited;
  views, tables without such a key, generated and binary columns are read-only, with the
  reason shown above the grid. SQL results are always read-only.
- **Pending changes** panel (below the grid): one line per change with its SQL (`UPDATE` /
  `INSERT` / `DELETE`, values shown as literals) and an **Undo** button. **Preview**
  (`Ctrl+Shift+P`) opens it.
- **Commit** (`Ctrl+S`) writes all pending changes in one transaction, values sent as bound
  parameters; the toolbar's Commit shows how many are pending. Each `UPDATE` / `DELETE` must
  touch exactly one row: if the row was deleted or its key changed since it was loaded,
  everything is rolled back, nothing is written and the changes stay pending. Concurrent
  edits of other columns are not detected: the last write wins (like other desktop
  clients). A commit waiting for a row locked elsewhere gives up after 30 s (a normal
  failure, nothing written) and can be cancelled meanwhile (**Cancel**, everything rolled
  back). If the connection drops during a commit, the outcome is unknown: reload and check
  before committing again. **Discard** drops them (`Ctrl+Shift+Backspace` asks first);
  closing a tab or workspace that has some asks first. Paging, sorting, filtering,
  reloading and following a foreign key wait until the pending changes are committed or
  discarded.
- **Row details** (`Ctrl+Space`, or `Space` in the grid): a panel on the right with the
  selected row's fields, a field search, indented JSON and long text loaded in full; edits
  there are pending changes too. It stays open across tabs; drag its edge to resize.
- **Filters** (`Ctrl+F` or **Filters**): a bar above the grid, one line per condition: a
  checkbox, the column (or **Any column**, or **Raw SQL**), the operator, the value,
  **Apply** (this condition alone), **−** and **+**. **Apply All** applies every ticked
  condition, joined by AND, or by OR from its **⌄** menu (`Ctrl+Enter` /
  `Ctrl+Shift+Enter`). The bar's footer has **SQL**, which shows the `WHERE` clause with
  the values written in (display only: the page always sends them as parameters; **Copy**
  copies it), **Clear** and the bar's shortcuts. `Esc` hides the bar and keeps what is
  typed. A **Raw SQL** condition reads the quick syntax first, for example
  `status = delivered and total > 100`:
  - `col = value` (also `!=`, `<>`, `<`, `>`, `<=`, `>=`), `col is null`, `col is not null`;
  - `col in (a, b, c)`, `col not in (…)`, `col between 1 and 10`, `col not between …`;
  - `col like 'A%'`, `col not like …`, `col ilike …`, `col contains text`,
    `col not contains …`;
  - `any contains text` (also `any = …`, `any not contains …`, `any like …`) searches
    every column;
  - quote values with `'…'` or `"…"` (the quote doubled escapes it: `'O''Brien'`), and
    columns with `"…"` or `` `…` ``; a keyword used as a value must be quoted (`'and'`).

  Anything else is sent as SQL as typed (only there is your text inserted in the query);
  the line says how it was read. With filters, the count is exact up to 500,000 rows, then
  shown as `500,000+`.
- **Columns** (`Alt+F`): tick the columns to show; widths, order and hidden columns are
  kept per table for the session.
- **Foreign keys**: a cell that references a row has a `↗` marker. `Ctrl+click` it, or
  right-click → **Open referenced row** (or the `→ table` button in the row details), to
  show the referenced table filtered on that row in the same tab. The trail above the grid
  (`orders › customers (id = 42)`) goes back to any earlier table exactly as it was
  (filters, sort, page); `Alt+←` goes back one step.
- **Copy**: `Ctrl+C` or `Ctrl+Shift+C` copies the selected cells as TSV; right-click →
  **Copy rows** / **Copy rows as** TSV, CSV, CSV with a header, JSON, Markdown or SQL
  `INSERT`, or **Copy selected cells** (shown values, pending edits included).
- **Structure** (read-only): **Columns** (type, nullable, default, auto-increment or
  generated, comment; primary and foreign key columns marked), **Foreign keys** (columns →
  referenced table and columns, `ON UPDATE` / `ON DELETE`; the table name opens it in a new
  tab) and **DDL** (highlighted, **Copy** button). **Index** lists the indexes (columns,
  unique, type and condition of a partial index; MySQL gives no type or condition).
  **Refresh** reloads them from the database.

## SQL editor

- **Toolbar** above the editor: **No limit ⌄** (add a `LIMIT` to `SELECT` queries, the
  value comes from the settings), **Beautify** (`Ctrl+I`, also `Ctrl+Shift+F`: the
  selection or all of it), **Save**, and **Run Current** (`Ctrl+Enter`: the statement under
  the cursor, or the selection) with its **⌄** for **Run All** (`Ctrl+Shift+Enter`). The
  statement Run Current would run has a tinted background.
- **Results**: **Data** (the rows, one **Result N** tab per result set when there are
  several, with the row count and the time) and **Message** (one line per statement: rows
  returned or changed, errors, cancel). An error or a cancel shows Message.
- **Completion**: table and column names as you type; `Ctrl+Space` asks for it.
- **History** (sidebar, **History**): every statement run on a connection, newest first (the
  last 1,000 are kept), with a search box. A click opens it in a new SQL tab; right-click for
  Run, Copy, Insert into SQL editor and Delete. Statements containing the word
  `IDENTIFIED` or `PASSWORD` (`CREATE/ALTER USER … IDENTIFIED BY`, `SET PASSWORD`,
  PostgreSQL `… PASSWORD '…'`) are never recorded. It may still hold other values you
  typed: "Clear history" erases it for the connection (deleted rows are overwritten in
  `app.db`), and it is deleted with the connection.
- **Session restore**: open workspaces and tabs come back after a restart, disconnected
  until you activate them (`Ctrl+Shift+R` connects the one shown). The text of each SQL tab
  is kept as typed, like an unsaved document, so whatever you typed there (a password
  included) is stored in `app.db`. On Linux and macOS `app.db` and the saved queries are
  readable by your user only.
- **Saved queries** (sidebar, **Queries**, per connection): `Ctrl+S` asks for a name the
  first time, then overwrites; the tab takes the name and shows a dot while it differs from
  the saved file. A click opens it (or its open tab); right-click for Run, Copy, Insert into
  SQL editor, Rename… and Delete.
- **MySQL / MariaDB `DELIMITER`**: a `DELIMITER //` line changes the statement delimiter
  like in the mysql client and is not sent to the server. Without it, the `BEGIN … END`
  body of `CREATE PROCEDURE/FUNCTION/TRIGGER/EVENT` is still sent as one statement.
  Formatting is not available for a script with `DELIMITER` lines.
- **MySQL / MariaDB single-statement guard**: each statement is checked before it is sent,
  and anything the check cannot read with certainty is refused rather than sent. So some
  valid scripts do not run as is: compound statements inside executable comments (the
  `/*!50003 CREATE TRIGGER … BEGIN … END */` blocks of `mysqldump` output), dollar-quoted
  bodies (`AS $$ … $$`, MySQL 9 JavaScript routines), and anything at all while the
  session's client character set is `big5`, `cp932`, `gb18030`, `gbk` or `sjis` (run
  `SET NAMES utf8mb4` to go back).

## Settings and keyboard shortcuts

**Settings** (`Ctrl+,`, or the button at the bottom of the open connections column) has
five sections: **General** (system title bar, version), **Table** (page size, exact count
threshold), **Editor** (Auto LIMIT), **Fonts & Themes** (System / Light / Dark, **Interface
size** 90 % to 130 %, data and editor font sizes, editor font) and **Keymap**, where the
shortcuts below can be changed (**Change**, then press the new combination; one already in
use is refused) or reset. The grid's plain keys are fixed: `Enter` (Quick Look), `Space`
(row details), `Delete` (delete rows), `Esc` and `Ctrl+click`.

The defaults, on Linux and Windows. On macOS `Ctrl` is `⌘` and `Alt` is `⌥`, except
`Ctrl+Tab`, `Ctrl+Shift+Tab` and `Ctrl+Space`, which stay `Ctrl`; the other macOS
differences are in the last column.

| Where | Shortcut | Action | macOS |
|---|---|---|---|
| Everywhere | `Ctrl+P` | Open anything (`>` for actions) | |
| | `Ctrl+K` | Open a database or schema | |
| | `Ctrl+Shift+K` | Show the connection list | |
| | `Ctrl+N` | New connection | |
| | `Ctrl+,` | Settings | |
| | `Ctrl+T` / `Ctrl+E` | New SQL tab / open the SQL editor (new SQL tab) | |
| | `Ctrl+W` | Close the tab | |
| | `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab, most recent first | |
| | `Ctrl+]` / `Ctrl+[`, `Ctrl+PageDown` / `Ctrl+PageUp` | Next / previous tab in bar order | |
| | `Ctrl+1`, `Ctrl+2`, `Ctrl+3`, `Ctrl+4`, `Ctrl+5`, `Ctrl+6`, `Ctrl+7`, `Ctrl+8`, `Ctrl+9` | Go to tab 1 … 9 | |
| | `Ctrl+Shift+]` / `Ctrl+Shift+[`, `Ctrl+Shift+PageDown` / `Ctrl+Shift+PageUp` | Next / previous open connection | |
| | `Alt+←` / `Alt+→` | Back (the foreign key trail first) / forward | |
| | `Ctrl+0` | Show or hide the sidebar | |
| | `Ctrl+Shift+F` | Search the sidebar (in the editor: format) | |
| | `Ctrl+Shift+H` | Show the query history | |
| | `Ctrl+R` | Reload the sidebar and the table data | |
| | `Ctrl+Shift+R` | Connect the disconnected connection shown | |
| | `Ctrl+=` (`Ctrl+Shift+=`, `Ctrl+Num +`) / `Ctrl+-` (`Ctrl+Num −`) | Larger / smaller data and editor fonts | |
| Table tabs | `Ctrl+S` | Commit the pending changes | |
| | `Ctrl+Shift+Backspace` | Discard the pending changes (asks first) | |
| | `Ctrl+Shift+P` | Preview the SQL of the pending changes | |
| | `Ctrl+Space`, `Space` in the grid | Show or hide the row details | |
| | `Alt+1` / `Alt+2` / `Alt+3` | Data / Structure / Index | also `⌘+⌥+[` / `⌘+⌥+]` |
| | `Alt+R` | Reload this table's data | `⌘+⌥+R` |
| | `Ctrl+F` | Show or hide the filter bar | |
| | `Alt+F` | Columns | `⌘+⌥+F` |
| | `Ctrl+I` | Add a row | |
| Table grid | `Enter` / `Alt+Enter` | Quick Look / edit the cell | |
| | `Ctrl+Shift+C` | Copy the selected cells | |
| | `Ctrl+D` | Duplicate the selected rows | |
| | `Ctrl+Backspace`, `Delete` | Delete the selected rows | |
| | `Ctrl+←` / `Ctrl+→` | Previous / next page | |
| | `Ctrl+click` | Follow a foreign key | |
| Filter bar | `Ctrl+B` | Turn the condition on or off | |
| | `Ctrl+I` / `Ctrl+Shift+I` | Add a condition after this one / remove it | |
| | `Ctrl+Enter` / `Ctrl+Shift+Enter` | Apply all, joined by AND / by OR | |
| | `Ctrl+↑` / `Ctrl+↓` | Previous / next condition | |
| | `Alt+C` / `Alt+O` | Jump to the column / the operator | `⌘+←` / `⌘+→` |
| | `Esc` | Hide the bar | |
| SQL tabs | `Ctrl+S` | Save the query | |
| SQL editor | `Ctrl+Enter` / `Ctrl+Shift+Enter` | Run the current statement (or the selection) / all | |
| | `Ctrl+I`, `Ctrl+Shift+F` | Format (Beautify) | |
| | `Ctrl+/` | Comment or uncomment the lines | |
| | `Ctrl+Space` | Show completions | |
| Connection list | `Ctrl+F` | Search the list | |

A shortcut acts only where it belongs: in a text field or the editor, keys such as
`Ctrl+←`, `Ctrl+I` or `Space` keep their usual text meaning.

## Test databases

Host tools needed by `pnpm test:rust`: `docker compose` (v2), `openssl` and `ssh-keygen`
(test certificates and keys), `ssh-agent` and `ssh-add` (agent authentication test);
`pnpm demo:db` also needs `sqlite3`. Bind mounts carry the SELinux `z` option, so
Fedora/RHEL hosts work as is.

`scripts/test-dbs.sh up|down|env` manages PostgreSQL 16 (port 54321), MySQL 8.4 (33061),
MariaDB 11.4 (33062), MongoDB 7.0 (27117; users `root` and `reader`, read only on
`tablemax_test`) and a test sshd (2222, user `tunnel`) via `docker-compose.test.yml`
(project `tablemax-test`). `up` first runs `scripts/test-secrets.sh`, which generates the
throwaway TLS certificates and SSH keys into `.test-secrets/` (gitignored; existing keys
are kept, missing ones are added). `scripts/test-dbs.sh env` prints the `TABLEMAX_TEST_*`
exports, and `scripts/test-dbs.sh down` stops the containers and deletes their volumes.
The test sshd host keys (Ed25519 and ECDSA) are generated once in `.test-secrets/ssh/host/`,
so their fingerprints survive image rebuilds. `pnpm demo:db` seeds a demo database and
registers demo connections.

### Two worktrees side by side

Each checkout has its own `.test-secrets/`. To run the tests of two worktrees at the same
time, give the second one its own compose project and host ports (the defaults are
`tablemax-test`, 54321, 33061, 33062, 2222 and 27117), and keep them set for every
command:

```bash
export TABLEMAX_TEST_PROJECT=tablemax-test-b TABLEMAX_TEST_PG_PORT=55321 \
  TABLEMAX_TEST_MYSQL_PORT=34061 TABLEMAX_TEST_MARIADB_PORT=34062 TABLEMAX_TEST_SSH_PORT=3222 \
  TABLEMAX_TEST_MONGO_PORT=27217
pnpm test:rust               # `env` then exports URLs with these ports
scripts/test-dbs.sh down     # stops this project only
```

`pnpm demo:db` follows the same variables.

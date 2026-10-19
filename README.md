# TableMax

A free, fast desktop database client. Tauri 2 + React + TypeScript + Rust.

**New here? Take the 10-minute tour: [docs/DEMO.md](docs/DEMO.md).**

## Installation (Linux)

`pnpm build:app` (`tauri build`) produces two packages under
`src-tauri/target/release/bundle/`:

- **`.deb`** (`deb/TableMax_<version>_amd64.deb`, Debian package name `table-max`):
  `sudo apt install ./TableMax_<version>_amd64.deb`. It declares
  `libwebkit2gtk-4.1-0` and `libgtk-3-0` (satisfied by `libgtk-3-0t64` on Ubuntu 24.04),
  which apt pulls in. Run `tablemax` or use the "TableMax" desktop entry (category
  Development). Remove with `sudo apt remove table-max`.
- **AppImage** (`appimage/TableMax_<version>_amd64.AppImage`), bundles WebKitGTK, GTK
  and their libraries from the build machine:
  `chmod +x TableMax_*.AppImage && ./TableMax_*.AppImage`. It needs FUSE 2
  (`libfuse2t64` on Ubuntu); without it, run it with `APPIMAGE_EXTRACT_AND_RUN=1`. Its
  GTK hook picks a light or dark Adwaita theme from the desktop's `color-scheme`
  setting, and the app's "System" theme follows that. This was only simulated, not
  checked on a real dark desktop; `APPIMAGE_GTK_THEME=Adwaita:dark` forces dark.

Both packages depend on the build machine's glibc (none bundles its own libc). For a
build made on Ubuntu 26.04 (checked in a clean `ubuntu:24.04` container):

- the `.deb` needs glibc 2.39 or newer: it installs and every library resolves on
  Ubuntu 24.04 (its WebKitGTK/GTK come from the distribution);
- the AppImage needs glibc 2.43 or newer, because its bundled WebKitGTK, GLib, GnuTLS…
  were built on 26.04: on Ubuntu 24.04 (glibc 2.39) it fails with
  ``version `GLIBC_2.43' not found``. It only runs on distributions as new as the build
  host.

Build on the oldest distribution you want to support.

Runtime notes: saving passwords in the keyring needs a Secret Service provider
(GNOME Keyring or KWallet, present on standard desktops); without one, choose "Ask each
time" for passwords. App data (connections, `settings.json`, the app's `known_hosts`) lives
in `~/.local/share/dev.tablemax.app/`.

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

- **SSL / TLS**: modes `disable`, `prefer`, `require` (encrypted, certificate not checked),
  `verify-ca` (chain checked, not the name; PostgreSQL only for now) and `verify-full`
  (chain and host name). Optional CA, client certificate and key files. New connections
  default to `verify-full` for remote hosts and `prefer` for local hosts or SSH tunnels.
- **SSH tunnels**: password, private key (passphrase asked when the key is encrypted) or
  SSH agent. `~/.ssh/config` aliases are resolved (`HostName`, `User`, `Port`,
  `IdentityFile`). An unknown host key is shown as a `SHA256:…` fingerprint to confirm,
  then saved in the app's `known_hosts`; a changed key blocks the connection.
- **Groups**: connections can be filed under a group; groups fold in the sidebar.
- **URLs**: "Copy URL" in the form (never includes the password) and "+ → New from URL…"
  (`postgresql://`, `mysql://`, `mariadb://`, `sqlite://`; `sslmode`, `ssh`, `ssh-auth`
  parameters).
- **Import TablePlus export…** (in the "+" menu): reads a `.tableplusconnection` file
  with its export password, lists its connections (duplicates of existing ones are
  unchecked) and imports the chosen ones. Exports do not carry SSH key paths, SSL
  settings or colors: set them afterwards in the connection form.

Passwords, SSH passwords and key passphrases live only in the system keyring (or are
asked at each connect), never in `app.db`.

## Table tabs

Opening a table shows its rows in a grid (300 rows a page, row count in the footer).
**Data | Structure** at the top of the tab switches between the rows and the table's
structure (`Alt+1` / `Alt+2`, `⌥1` / `⌥2` on macOS).

- **Editing**: double-click a cell, press Enter or start typing. Right-click a cell or row
  for **Set NULL**, **Set empty string** (text columns), **Set DEFAULT**, **Revert cell**,
  **Duplicate row**, **Delete row** / **Restore row**; **+ Row** adds a row. Edits are not written
  right away: changed cells, new rows and rows to delete are highlighted as **pending
  changes**. Only tables with a primary key (or a unique index on `NOT NULL` columns) can
  be edited; views, tables without such a key, generated and binary columns are read-only,
  with the reason shown above the grid. SQL results are always read-only.
- **Pending changes** panel (below the grid): one line per change with its SQL (`UPDATE` /
  `INSERT` / `DELETE`, values shown as literals) and an **Undo** button.
- **Commit** (`Ctrl+S`, `⌘S` on macOS) writes all pending changes in one transaction,
  values sent as bound parameters. Each `UPDATE` / `DELETE` must touch exactly one row:
  if the row was deleted or its key changed since it was loaded, everything is rolled
  back, nothing is written and the changes stay pending. Concurrent edits of other
  columns are not detected: the last write wins (like other desktop clients). A commit
  waiting for a row locked elsewhere gives up after 30 s (a normal failure, nothing
  written) and can be cancelled meanwhile (**Cancel**, everything rolled back). If the
  connection drops during a commit, the outcome is unknown: reload and check before
  committing again. **Discard** drops them; closing a tab
  or workspace that has some asks first. Paging, sorting, filtering, reloading and
  following a foreign key wait until the pending changes are committed or discarded.
- **Row details** (`Ctrl+I`, `⌘I`): the selected row as a form, with indented JSON and
  long text loaded in full; edits there are pending changes too.
- **Filters**: the quick bar above the grid takes conditions joined by `and`
  (no `or`), for example `status = delivered and total > 100`:
  - `col = value` (also `!=`, `<>`, `<`, `>`, `<=`, `>=`), `col is null`, `col is not null`;
  - `col in (a, b, c)`, `col not in (…)`, `col between 1 and 10`, `col not between …`;
  - `col like 'A%'`, `col not like …`, `col ilike …`, `col contains text`,
    `col not contains …`;
  - `any contains text` (also `any = …`, `any not contains …`, `any like …`) searches
    every column;
  - quote values with `'…'` or `"…"` (the quote doubled escapes it: `'O''Brien'`), and
    columns with `"…"` or `` `…` ``; a keyword used as a value must be quoted (`'and'`).

  **Filters** opens the builder: one row per condition (column or **Any column**,
  operator, value), the same operators plus **Raw SQL**, a condition typed as is (only
  there is your text inserted in the query). The quick bar and the builder show the same
  filters; conditions the bar cannot write are marked **advanced**. With filters, the
  count is exact up to 500,000 rows, then shown as `500,000+`.
- **Foreign keys**: a cell that references a row has a `↗` marker. `Ctrl+click`
  (`⌘+click`) it, or right-click → **Open referenced row** (or the `→ table` button in
  the row details), to show the referenced table filtered on that row in the same tab. The
  trail above the grid (`orders › customers (id = 42)`) goes back to any earlier table
  exactly as it was (filters, sort, page); `Alt+←` goes back one step.
- **Copy**: `Ctrl+C` copies the selected cells as TSV; right-click → **Copy as TSV /
  CSV / JSON / SQL INSERT** copies the selection with its column names (shown values,
  pending edits included; new rows not committed yet are left out).
- **Structure** (read-only): **Columns** (type, nullable, default, auto-increment or
  generated, comment; primary and foreign key columns marked), **Indexes** (columns,
  unique / primary, definition), **Foreign keys** (columns → referenced table and columns,
  `ON UPDATE` / `ON DELETE`; the table name opens it in a new tab) and **DDL** (highlighted,
  **Copy** button). **Refresh** reloads it from the database.

| Shortcut | Action |
|---|---|
| `Alt+1` / `Alt+2` | Data / Structure |
| `Ctrl+S` | Commit the pending changes |
| `Ctrl+I` | Show or hide the row details |
| `Ctrl+click` | Follow a foreign key |
| `Alt+←` | Back along the foreign key trail |
| `Ctrl+C` | Copy the selected cells (TSV) |
| `Ctrl+T` / `Ctrl+W` | New query tab / close the tab |

On macOS, `Ctrl` is `⌘` and `Alt` is `⌥` (`Ctrl+T` / `Ctrl+W` stay `Ctrl`).

## SQL editor

- **Shortcuts** (`Ctrl` is `Cmd` on macOS): `Ctrl+Enter` run the statement under the
  cursor (or the selection), `Ctrl+Shift+Enter` run all, `Ctrl+Shift+F` format,
  `Ctrl+/` comment, `Ctrl+S` save the query, `Ctrl+Shift+H` history, `Ctrl+K` / `Ctrl+P`
  command palette, `Ctrl+T` new SQL tab, `Ctrl+W` close tab, `Ctrl+Tab` recent tabs.
- **History** (right panel): every statement run on a connection, newest first (the last
  1,000 are kept), with a search box. Click inserts the SQL at the cursor, double-click
  replaces the editor content. Statements containing the word `IDENTIFIED` or `PASSWORD`
  (`CREATE/ALTER USER … IDENTIFIED BY`, `SET PASSWORD`, PostgreSQL `… PASSWORD '…'`) are
  never recorded. It may still hold other values you typed: "Clear history" erases it
  for the connection (deleted rows are overwritten in `app.db`), and it is deleted with
  the connection.
- **Session restore**: open workspaces and tabs come back after a restart, disconnected
  until you activate them. The text of each SQL tab is kept as typed, like an unsaved
  document, so whatever you typed there (a password included) is stored in `app.db`.
  On Linux and macOS `app.db` and the saved queries are readable by your user only.
- **Saved queries** (left panel, per connection): `Ctrl+S` asks for a name the first time,
  then overwrites; the tab takes the name and shows a dot while it differs from the saved
  file. Open, rename and delete from the panel.
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

## Test databases

Host tools needed by `pnpm test:rust`: `docker compose` (v2), `openssl` and `ssh-keygen`
(test certificates and keys), `ssh-agent` and `ssh-add` (agent authentication test);
`pnpm demo:db` also needs `sqlite3`. Bind mounts carry the SELinux `z` option, so
Fedora/RHEL hosts work as is.

`scripts/test-dbs.sh up|down|env` manages PostgreSQL 16 (port 54321), MySQL 8.4 (33061),
MariaDB 11.4 (33062) and a test sshd (2222, user `tunnel`) via `docker-compose.test.yml`
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
`tablemax-test`, 54321, 33061, 33062 and 2222), and keep them set for every command:

```bash
export TABLEMAX_TEST_PROJECT=tablemax-test-b TABLEMAX_TEST_PG_PORT=55321 \
  TABLEMAX_TEST_MYSQL_PORT=34061 TABLEMAX_TEST_MARIADB_PORT=34062 TABLEMAX_TEST_SSH_PORT=3222
pnpm test:rust               # `env` then exports URLs with these ports
scripts/test-dbs.sh down     # stops this project only
```

`pnpm demo:db` follows the same variables.

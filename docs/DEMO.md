# TableMax — 10-minute demo

TableMax is a free, fast desktop client for PostgreSQL, MySQL, MariaDB and SQLite. This
guide gets you a demo setup and walks through the best of v1. Shortcuts are written for
Linux and Windows; on macOS, `Ctrl` is `⌘` and `Alt` is `⌥` (`Ctrl+Tab` stays `Ctrl`).

## Setup (5 minutes)

You need Linux (Ubuntu 24.04 or newer is tested), Docker with `docker compose`, `sqlite3`,
`openssl` and `ssh-keygen`. To build from source you also need Node.js with pnpm, Rust, and
the Tauri system packages (WebKitGTK 4.1).

```bash
pnpm install
bash scripts/test-dbs.sh up   # PostgreSQL, MySQL, MariaDB + an SSH server, in Docker
pnpm tauri dev                # first start creates the app database; close the window
pnpm demo:db                  # seeds a "shop" database and adds 4 demo connections
pnpm tauri dev
```

Instead of `pnpm tauri dev` you can install the `.deb` (`sudo apt install ./TableMax_*.deb`)
and start `tablemax`. `pnpm demo:db` only adds the connections when TableMax has been started
once and is closed. The demo connections are in the **Demo** group: **Demo · SQLite** (no
password), and Postgres 16, MySQL 8 and MariaDB 11 (password `tablemax`, asked at each
connect). **Demo · MariaDB 11** is tagged `prod`.

## The tour

1. **SSH tunnel + verified TLS, with a host key prompt.** Click **+** (New connection, `Ctrl+N`).
   Name `Postgres via SSH`, driver PostgreSQL, Host `pg16`, Port `5432`, User `postgres`,
   Database `tablemax_demo`, Password storage **Ask each time**. As **SSL mode**, pick
   **Verify CA and host name** and set the CA certificate to `.test-secrets/tls/ca.pem` with
   **CA…** (the folder is in the repository). Tick **Over SSH**: SSH host `127.0.0.1`,
   SSH port `2222`, SSH user `tunnel`, authentication **Password**, password `tunnel-pass`.
   Click **Connect**. The **Unknown SSH host** dialog shows the server's fingerprint: click
   **Trust and connect**, then type the database password `tablemax`. TableMax saves the key in
   its own `known_hosts` and never writes to `~/.ssh/known_hosts`. The certificate is checked
   against `pg16` through the tunnel. Passwords stay in the system keyring or are asked for;
   they are never written to disk.
2. **Command palette.** Press `Ctrl+K` and type `ord` to jump to the `orders` table. You can
   also run actions from there, e.g. "New SQL tab" or "Format query". `Ctrl+P` searches objects
   only.
3. **Preview tabs.** Single-click tables in the sidebar: one *italic* preview tab is reused.
   Double-click a table (or the tab) to keep it open. `Ctrl+Tab` switches between recent tabs.
4. **Quick filter.** In `orders`, type `status = paid and customer_id < 50` in the filter bar
   and press Enter. **Filters** opens the filter builder. The row count stays fast on large
   tables (estimated above a threshold you can change in Settings).
5. **Inline edit, pending changes, commit.** Double-click a cell, change it, press Enter. The
   cell turns yellow and the **Pending changes** panel at the bottom shows the exact SQL that
   will run. **+ Row** adds a row; **Undo** reverts one change. `Ctrl+S` (or **Commit**) applies
   everything in one transaction, all or nothing.
6. **Safe mode on production.** Connect **Demo · MariaDB 11**: a red **PROD** banner, a red
   border and `[PROD]` in the window title. Open a query tab (`Ctrl+T`) and run
   `select * from customers; update customers set notes = 'demo' where id = 1;` with
   `Ctrl+Shift+Enter`. **Confirm before running** lists every statement exactly as it will be
   sent (with the `LIMIT` that **Auto LIMIT** adds, when ticked) and marks the UPDATE: **Cancel** runs nothing, **Run** runs
   them. Grid commits on this connection ask too, showing their SQL.
7. **Foreign keys and the breadcrumb.** In `orders`, `Ctrl+click` a `customer_id` cell to
   open the customer it points to. The breadcrumb above the grid shows the path; `Alt+←` goes
   back.
8. **Structure view.** `Alt+2` (or **Structure**) shows Columns, Indexes, Foreign keys and the
   DDL; `Alt+1` goes back to the data.
9. **SQL editor.** In a query tab, start typing `select * from cu`: table and column names are
   suggested (`Ctrl+Space` to ask). `Ctrl+Shift+F` formats, `Ctrl+/` comments, `Ctrl+Enter`
   runs the statement under the cursor, `Ctrl+S` saves the query by name, and `Ctrl+Shift+H`
   opens the history (click to insert, double-click to replace).
10. **Session restore.** Close TableMax and start it again: workspaces and tabs come back,
    disconnected until you click **Reconnect** or select a tab.
11. **Import from TablePlus.** On the connections screen, click **Import connections…** on the
    left, choose `src-tauri/tests/fixtures/tableplus/all-with-passwords.tableplusconnection`,
    enter the export password `fixture-pass`, review the list (duplicates and SSH hosts are
    flagged) and click **Import *N* connections**.

## Make it yours

The ⚙ button (or `Ctrl+,`) opens **Settings**: theme (System / Light / Dark), editor font,
page size, the count threshold, Auto LIMIT, and **Keyboard**, where any shortcut can be
changed (**Change**, then press the new combination; a combination already in use is
refused) or reset.

When you are done: `bash scripts/test-dbs.sh down` stops the containers and deletes their
data.

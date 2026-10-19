# Integration v1 — end-to-end smoke run

One pass across plans 2–5 in the real app on `integration/v1`, 2026-10-18.

## Setup

- Release binary from `pnpm tauri build` (first run: 77eb46d; after the fix below: b16f359,
  `--no-bundle`), copied to a scratch directory and run from there.
- Isolated session: `env -i`, scratch `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`,
  `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR` (700), `TMPDIR`; private Xvfb `:61` (1600×1000, no
  window manager), `GDK_BACKEND=x11`, `WEBKIT_DISABLE_COMPOSITING_MODE=1`,
  `dbus-run-session` (no keyring daemon: every secret "Ask each time"). Driven with xdotool,
  checked on `import` screenshots, `psql` / `mysql` in the containers and `sqlite3` on
  `app.db`. Window closed with a WM_DELETE_WINDOW client message (what the X button sends).
- Test stack `tablemax-test-int` (pg16 57321, mysql8 36061, mariadb11 36062, sshd 5222);
  demo data from `scripts/demo-db.sh --no-register`.
- The real `~/.local/share/dev.tablemax.app` and `~/.ssh/known_hosts` were not touched
  (mtimes before and after: 2026-10-17 12:56:25 and 2026-10-15 14:53:34).

## Verified

1. **PostgreSQL through the test sshd, prod-tagged.** New connection form: environment
   `prod` switches safe mode to "Default (by environment): Confirm writes" and the SSL mode
   to "Verify CA and host name" (set to "Require (no verification)" for the test server,
   with its warning shown); host `pg16:5432` behind SSH `tunnel@127.0.0.1:5222`, both
   secrets "Ask each time". Connect: database password prompt, SSH password prompt, then
   **Unknown SSH host** with fingerprint `SHA256:MhPOK8yK…SdTnwc`, identical to
   `ssh-keygen -lf` of the test sshd's ed25519 host key. "Trust and connect" writes it to
   the app's own `known_hosts` only. Workspace opens with the red PROD banner "Safe mode:
   confirm writes".
2. **Table, quick filter.** `orders` (12,000 rows, `customer_id` with ↗ markers). Quick bar
   `status = paid and total > 2500` → normalized to `AND`, "Filters (2)", 470 rows.
3. **Edit + Ctrl+S under safe mode.** Status of order 15 → `shipped`: highlighted cell,
   "1 pending change", panel with the `UPDATE … WHERE "id" = …` preview. Ctrl+S opens
   **Confirm before running** ("Smoke PG via SSH · PROD … nothing has run yet", the UPDATE
   flagged "Needs confirmation"). `psql` before Run: `paid`; after Run: `shipped`; the grid
   reloads (469 rows).
4. **Foreign key jump and back.** Ctrl+click on `customer_id` 1719: same tab shows
   `customers` filtered on `id = 1719`, trail `orders (status = paid AND total > 2500) ›
   customers (id = 1719)`. Clicking `orders` in the trail restores the table with its two
   filters.
5. **Structure.** Alt+2: Columns (PK / FK marks, `nextval` default, auto-increment), DDL tab
   highlighted with constraints and the index. Alt+1 back to the data.
6. **Palette and Ctrl+Tab.** Ctrl+Tab goes to the most recently used tab; Ctrl+K `ord` lists
   Objects `orders`, `order_items` and Tabs `orders`; Enter on the tab entry activates it
   (filters kept).
7. **Restart → session restored, reconnect on activation.** Closed with WM_DELETE_WINDOW;
   `session_state` holds the workspace, database, schema and three tabs, no secret.
   Relaunch: the workspace and its tabs are back, "Disconnected", nothing connects at
   startup. Activating a tab asks for both passwords (no host key prompt: known), then
   loads it.
8. **Preview tabs (after the fix below).** Single click `edge_cases`: italic preview tab;
   single click `order_items`: replaces it. An edit in the preview tab pins it (upright
   title).
9. **MySQL `DELIMITER`.** New SQL tab on MySQL 8: `DELIMITER //` / `CREATE PROCEDURE
   smoke_p() BEGIN SELECT 1 AS a; SELECT 2 AS b; END //` / `DELIMITER ;` / `CALL smoke_p();`
   → Run all: the procedure exists on the server (`SHOW CREATE PROCEDURE`), the CALL shows a
   result. History holds the two statements without the DELIMITER lines.
10. **Theme.** Ctrl+, opens Settings (theme, editor font, page size, count threshold, auto
    LIMIT, keymap). Dark: the whole UI and the canvas grid turn dark on a light OS;
    `settings.json` has `"theme": "dark"`. A pending edit there uses the dark
    `--pending-edit` colour (fix 4 of the integration).
11. **Database switch refused with pending changes.** With that edit pending, choosing
    `postgres` in the database select shows "Could not switch database: Commit or discard
    the 1 pending change first: switching the database closes the table tabs"; the select
    stays on `tablemax_demo`, the edit stays. Discard: `psql` shows the value unchanged.
12. No password in `app.db` (0600), `settings.json` or `known_hosts`.

## Found and fixed

- **Every sidebar single click opened a pinned tab** (first binary). Plan 5 Task 6 latches
  the page size into the tab's grid view when the grid mounts; plan 4's subscription
  pinned a preview tab on any view change. Fixed in b16f359 (pins on page, sort, filters
  or trail changes only), with a store test; re-checked in the rebuilt binary (item 8).

## Seen, not fixed (follow-ups)

- `CALL` of a procedure returning two result sets shows only the first (`a = 1`).
- The sidebar's Routines count stays 0 after creating a procedure until Refresh.
- A restored table tab comes back without its filters (the session snapshot keeps tabs,
  not grid views).
- A pending numeric value is drawn left-aligned (as text) until committed.
- `settings.json` and the app's `known_hosts` are written 0664, and an app data directory
  created before the first launch (here by `demo-db.sh`) stays 0775; `app.db` is 0600.
  Neither file holds a secret.
- A new SQL tab opened with Ctrl+T right after the password prompt closed did not focus
  its editor (typing went nowhere until a click); not re-checked in isolation.
- Tooltips render as black boxes on Xvfb without a compositor (seen in earlier checks too).

Screenshots stay in the session scratchpad (`smoke/shots/`, not committed).

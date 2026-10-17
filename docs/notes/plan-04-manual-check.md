# Plan 04 manual check

Real app (debug build from `pnpm tauri build --debug --no-bundle`, frontend embedded, no dev
server) on a private Xvfb display (:97, 1600x1000, no window manager), driven with xdotool and
checked on screenshots. Fully isolated session: scratch root
`/tmp/claude-1000/-home-cyildirim-dev-tablemax/8c84c1b2-5d25-4b02-bd64-2793870fd9e9/scratchpad/manual-p4`
with its own HOME / XDG_* dirs, a private D-Bus session (no keyring daemon, so every server
connection uses the "Ask each time" password mode), and the p4 Docker stack only
(`tablemax-test-p4`: pg16 55321, mysql8 34061, mariadb11 34062). `pnpm demo:db` wrote
`app.db` and the demo SQLite under the scratch `XDG_DATA_HOME`. Connections used:
Demo · Postgres 16, Demo · MariaDB 11, Demo · MySQL 8 (all Ask, password `tablemax`).
Screenshots stay in `/tmp/claude-1000/-home-cyildirim-dev-tablemax/8c84c1b2-5d25-4b02-bd64-2793870fd9e9/scratchpad/manual-p4/shots/` (not committed); numbers below are the file prefixes.
The window was closed with a WM_DELETE_WINDOW client message (what the X button sends).

## Verified

### Preview / pinned tabs (04, 05, 06, 07)
- Single click on `customers`, `order_items`, `orders` in turn: one tab only, titled
  `orders` in italics (each click replaces the previous preview).
- Double-click `orders`: the title turns upright (pinned). A later single click on
  `customers` opens a new italic preview next to it; double-click pins it. Same for
  `products`; Ctrl+T adds `Query 1`.

### Ctrl+Tab MRU (08, 09, 10)
- From `Query 1` active, Ctrl+Tab goes to the previously used tab (`products`).
- Holding Ctrl and pressing Tab twice shows a list ordered by recency (products, Query 1,
  customers, orders) with the third entry highlighted; releasing Ctrl activates
  `customers`.

### Tab search (11, 12)
- The ▾ button opens a search field; typing `ord` lists `orders` (Table · public);
  Enter activates it.

### Palette (13 to 19)
- Ctrl+K: groups Objects, Tabs, Connections, Actions (New SQL tab, Close tab, Next/Previous
  tab, New connection, Change schema/database, Toggle sidebar, Reload catalog) with their
  shortcuts. Typing `prod` leaves `products` under Objects and under Tabs; Enter on the
  Tabs entry activates that tab. "New SQL tab" from the palette opens `Query 2`.
- Ctrl+P: objects only (customers, vip_customers for `cust`), no tabs/connections/actions,
  as the code intends (mode "objects").

### Completion, formatting, Auto LIMIT, history (20 to 26)
- `select o. from orders o` with the cursor after `o.`: the popup lists the six columns of
  `orders` with their types (customer_id bigint, id bigint, placed_at timestamptz, ...).
- Ctrl+Shift+F on a one-line join/group-by query: upper-cased keywords, one clause per line,
  indented. One Ctrl+Z restores the original single-line text exactly.
- Auto LIMIT 1000 checked, `select * from orders` + Ctrl+Enter: "1,000 rows"; history
  records `select * from orders LIMIT 1000`.
- Ctrl+Shift+H: panel on the right with the two executed statements, time, duration, rows,
  and a search field and "Clear history". Tooltip: click inserts at the cursor,
  double-click replaces the editor content (single click inserted at the cursor as stated).
- After a restart the history panel still shows both entries.

### Saved query (27, 28, 47b)
- Ctrl+S on a new query opens "Save query"; naming it `VIP customers` renames the tab and
  lists it in the left "Saved queries" panel.
- After closing and relaunching, the tab `VIP customers` keeps its SQL and the saved
  query is still in the panel.

### PostgreSQL database switch (29, 30, 33)
- Sidebar dropdown lists postgres / tablemax_demo / tablemax_test. Choosing
  `tablemax_test` closes the table tabs of the old database (orders, customers, products
  gone) and keeps the SQL tabs (Query 1, VIP customers); the sidebar shows an empty
  catalog. Switching back to `tablemax_demo` and reopening tables works.

### MySQL procedure with DELIMITER (36 to 39, 54, 55)
- `DELIMITER //`, `CREATE PROCEDURE p4_demo() BEGIN SELECT 1 AS one; SELECT COUNT(*) AS n
  FROM orders; END //`, `DELIMITER ;`, `CALL p4_demo();` with Run all: the procedure is
  created ("Statement 1: 0 rows affected") and the CALL result `one = 1` is shown. After
  Refresh the sidebar lists `p4_demo` under Routines (confirmed with the mysql CLI). The
  statement under the cursor (the CALL line) also runs on Ctrl+Enter.

### Session restore (43 to 47, 49 to 54)
- Three workspaces (PG with 5 tabs including a preview and a saved query, MariaDB with 2 table
  tabs, MySQL with the procedure script) are back after a relaunch, with their tab order,
  italic preview, active tab and active workspace, and the SQL text of query tabs.
- Nothing is connected at launch: pg_stat_activity and the MySQL/MariaDB process lists show
  0 client connections from the app until a workspace is activated; after activating
  MySQL, PG still has 0.
- Activating a restored workspace by clicking its tab shows "Password required" for the Ask
  connection (Postgres and MySQL both checked). Cancel: the workspace stays "Disconnected —
  Select a tab or reconnect to load its data" with a Reconnect button and its tabs. Reconnect
  asks again; with the password the catalog, the active table tab and the saved query load.

### Session save on close (R16)
- Change followed by a 1.6 to 1.8 s wait, then close: persisted. The `session_state` row
  holds a new tab with its text (`select 'slow'`).
- See Problems #1 for changes made less than about 1 s before closing.

## Problems found

1. **Last change before closing is lost (R16), blocks the "survives closing the window" goal for fast closes.**
   Repro A: PG workspace open and idle for several seconds, Ctrl+T (new SQL tab), then
   type `select 777` and close the window about 0.1 to 0.5 s later: after relaunch the new
   tab does not exist (shots 42, 43; `session_state` contains only the previous tabs).
   Repro B: click into an existing empty query tab, type `select 'quick'`, close right
   after the last key (~0.1 s): after relaunch the tab is empty. With a 1.6 s wait before
   closing the same edit is saved (`select 'slow'`). So `beforeunload` does not persist the
   pending change in the real webview: either the event does not fire on window close or
   the fire-and-forget `session_save` IPC is dropped when the process exits (no Rust close
   hook exists: no CloseRequested / on_window_event in src-tauri). Editor text has an extra
   300 ms debounce before it even reaches the store, so the unsaved window is about 1.3 s
   for typing. Not distinguishable from outside which of the two causes applies.
2. **Restored active workspace does not reconnect or prompt at launch (minor / design).**
   After a relaunch the active workspace shows "Disconnected / Reconnect" and no
   password prompt (shot 43, 50). The prompt only appears after clicking its own tab again
   (shot 51) or Reconnect. Other workspaces prompt when their tab is clicked. If the intent
   is "reconnect on activation" this one is activated by default but is not.
3. **Stale completion popup stays on screen when a modal opens (cosmetic).** In a query tab
   with the completion popup open (typed `... order by id`), Ctrl+S opens the "Save query"
   dialog but the popup remains visible and stays after saving (shots 27, 28, 29, 30); it
   only goes away after clicking in the editor (shot 31).
4. **Ctrl+T does not focus the new editor (minor).** After Ctrl+T (and the palette
   "New SQL tab", shot 19) keystrokes typed immediately go nowhere; the editor must be
   clicked first.
5. **Sidebar selection not synced with the active tab (cosmetic).** After switching tabs
   with Ctrl+Tab the sidebar keeps highlighting the last clicked table (`products` while
   `customers` is active, shot 10).
6. **CALL returning several result sets shows only the first (outside Plan 4 scope, low).**
   `CALL p4_demo();` runs two SELECTs; the app shows only "Result 1" (`one`), the
   `n = 12000` set is dropped (shots 38, 55; mysql CLI shows both).
7. **Auto LIMIT is not remembered across a restart (observation).** The checkbox was on
   when the app was closed and is off after relaunch (shots 24, 47b). Say if it should
   persist.

## Not manually verified
- Windows/macOS behaviours (Cmd shortcuts), SQLite workspace restore, SSH-tunnel
  connections (ssh test container not used), keyring-stored passwords (private D-Bus has no
  keyring on purpose), the destination of the Ctrl+Tab popup on a real window manager
  (no WM on the private display; focus handled by X without one).
- Formatting for MySQL/SQLite dialects and Auto LIMIT on MySQL: only PostgreSQL checked.
- Whether `beforeunload` fires at all on window close (see Problem 1): would need
  instrumentation of the app.

## Re-check after 59b7002 (session flush on window close)

Rebuilt with `pnpm tauri build --debug --no-bundle` (run with the normal environment: with
HOME overridden rustup cannot find its toolchain), same isolated session as above
(scratch HOME/XDG, Xvfb :97, private D-Bus, p4 stack). Window closed with a WM_DELETE_WINDOW
message; the close delay is the time until the app process exits.
- (a) Ctrl+T, close 0.1 s later: process exited after 0.14 s; `session_state` already held the
  new `Query 3` tab. Problem 1 repro A is fixed.
- (b) click in `Query 3`, type `select 'quick2'`, close 0.1 s after the last key: exited
  after 0.11 s; after relaunch the tab is back with `select 'quick2'` in the editor
  (screenshot `/tmp/claude-1000/-home-cyildirim-dev-tablemax/8c84c1b2-5d25-4b02-bd64-2793870fd9e9/scratchpad/manual-p4/shots/61-recheck-restored.png`). Problem 1 repro B is fixed.
- (c) The window closes promptly (about 0.1 s in both cases, no visible 2 s fallback wait).
- (d) Corrupt session row: not tested (out of scope).
Problem 1 is resolved; problems 2 to 7 were not re-checked.

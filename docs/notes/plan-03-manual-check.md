# Plan 03 manual check

Real app, debug build with the frontend embedded (`pnpm tauri build --debug --no-bundle`,
then `src-tauri/target/debug/tablemax` under `dbus-run-session`), on a private Xvfb
display (`:97`, `GDK_BACKEND=x11`), driven with xdotool and checked on screenshots
(`import -window`). Isolated session: `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`,
`XDG_CACHE_HOME` and `XDG_RUNTIME_DIR` in a scratch directory, no `SSH_AUTH_SOCK`; nothing
written to the real `~/.local/share/dev.tablemax.app`, `~/.ssh` or keyring. Databases:
the default test stack (`scripts/test-dbs.sh up`) and `scripts/demo-db.sh` run with the
scratch `HOME`, which re-seeded `tablemax_demo` on pg16 / mysql8 / mariadb11, created the
SQLite demo in the scratch data dir and registered the four "Demo ·" connections there
(password asked: `tablemax`). For the keyless case a table `audit_log (at, message)` was
added to the scratch SQLite file. Values changed during the check were put back afterwards
(`orders` 31 / 3 totals, rows inserted then deleted, PG `orders_id_seq`).

## PostgreSQL 16 (`Demo · Postgres 16`)

### Filters
- `orders`, quick bar `status = delivered and total > 100` + Enter: the bar shows
  `status = delivered AND total > 100`, the button `Filters (2)`, footer
  "Rows 1–300 of 5,039" — `psql` gives 5039 for the same condition.
- **Filters** opens the builder with the same two rows (`status = delivered`,
  `total > 100`). Value 100 → 4000, **Apply**: the bar follows
  (`… AND total > 4000`), "Rows 1–116 of 116" (`psql`: 116).

### Editing, pending changes, commit
- Double-click `total` of order 31, type `4999.99`, Enter: the cell turns yellow,
  "1 pending change", the **Pending changes** panel shows
  `UPDATE "public"."orders" SET "total" = CAST('4999.99'::text AS numeric) WHERE "id" = CAST('31'::text AS bigint)`.
- **+ Row**: a green row of `DEFAULT`s at the top, `INSERT … DEFAULT VALUES`; filling
  `customer_id`, `status`, `placed_at` updates the INSERT line with those three columns.
- Right-click order 66 → **Delete row**: the row is struck through in red, `DELETE … WHERE "id" = …`.
- Edit order 115 to `1.00`, then **Undo** on its line: the cell is back to 5045.52 and the
  line is gone (cancel one change).
- **Ctrl+S** with UPDATE 31 + INSERT + DELETE 66: refused by PostgreSQL (order 66 has
  `order_items`, FK `NO ACTION`): "Change 3 failed: update or delete on table "orders"
  violates foreign key constraint … — Nothing was written; the changes are still pending",
  the error repeated under the DELETE line. `psql`: order 31 unchanged, no new order.
- **Undo** on the DELETE, **Ctrl+S**: the toolbar empties, the grid reloads. `psql`:
  order 31 = 4999.99, new order 12002 (`customer_id 1`, `delivered`, total `0.00` from the
  default, `placed_at 2026-10-17 12:00:00+00`).
- Quick bar `id = 12002`, right-click → **Delete row**, **Ctrl+S**: "No rows"; `psql`: gone.

### Conflict (row deleted since it was loaded)
The exactly-one-row guard catches a row deleted (or whose key changed) after it was
loaded, as below. A concurrent edit of *other* columns of a still-present row is not a
conflict: the commit overwrites it (last write wins, see `plan-03-followups.md`, Rulings).
The messages quoted below were captured before the wording changed to "the row was deleted
or its key changed since it was loaded".
- SQL tab (Ctrl+T): `INSERT INTO orders … RETURNING id` → 12003.
- Back to `orders`, bar `id in (31, 12003)`, both totals → `1.11` (2 pending changes).
- SQL tab: `DELETE FROM orders WHERE id = 12003` → "1 row affected".
- `orders`, **Ctrl+S**: "Change 2 failed: the row changed or was deleted since it was
  loaded — Nothing was written; the changes are still pending". `psql`: order 31 still
  4999.99 (the first UPDATE was rolled back with the transaction). **Discard** empties the
  list. (The pending changes survived switching to the SQL tab and back.)

### Foreign keys and trail
- `order_items`: FK cells carry the `↗` marker. **Ctrl+click** on `order_id` 2 (row 3):
  same tab, now `orders` filtered `id = 2`, trail `order_items › orders (id = 2)`.
- **Alt+←**: back to `order_items`, page and grid as before.
- Ctrl+click `product_id` 41: `products (id = 41)`; clicking the `order_items` crumb goes back.

### Row details (`edge_cases`)
- Row "nested json", **Ctrl+I**: the panel shows `payload` indented over several lines
  (`{ "a": { "b": [ 1, 2, { "c": null } …`).
- Row "long text (50k chars)": selecting the whole `long_text` field and copying it gives
  51,300 characters, the full value (`length(long_text)` = 51300). `raw` (bytea) says
  "Binary values cannot be edited yet."

### Copy
- `order_items`, cells (1, order_id) to (3, unit_price) selected (click, Shift+click),
  right-click inside → **Copy as CSV**:
  `order_id,product_id,quantity,unit_price` + 3 lines; **Copy as JSON**: an array of 3
  objects (`"unit_price": "196.73"` kept as a string, integers as numbers);
  **Copy as SQL INSERT**: 3 × `INSERT INTO "public"."order_items" (…) VALUES (1, 21, 3, '196.73');`.
  Read back with `xclip` on the private display.
- Ctrl+C with the grid focused: TSV without header (`1\t21\t3\t196.73`, CRLF lines).

### Structure (the toggle of this task)
- Every table tab shows **Data | Structure** under the tab bar; Data is selected, the grid
  fills the height as before.
- With a pending edit and the grid focused, **Alt+2**: Structure of `orders` — Columns
  (`id` PK `bigint` default `nextval(…)` auto-increment, `customer_id` FK, `total`
  `numeric(12,2)` default 0, `shipped_at` nullable), Indexes (`orders_pkey` primary +
  unique with its definition, `orders_customer_idx`), Foreign keys
  (`orders_customer_id_fkey`: `customer_id` → `public.customers (id)`, NO ACTION /
  NO ACTION), DDL (highlighted `CREATE TABLE public.orders (…)` + `CREATE INDEX …`).
  The digit was not taken by the grid as the start of an edit.
- DDL **Copy** → the clipboard holds the DDL (`CREATE TABLE public.orders (` …).
- **Alt+1** (focus on the Copy button): back to the grid, the pending change and its panel
  still there, the grid drawn correctly after being hidden.
- After a foreign key jump (`order_items` → `orders (id = 2)`), Alt+2 shows the structure
  of `orders`, the table now displayed.
- Foreign keys → click `public.customers`: `customers` opens in a new tab.
- Indexes → **Refresh**: same content after the reload.
- View `vip_customers`: "Read-only: this is a view.", no + Row / Commit; Structure lists its
  5 columns, no keys; DDL shows `CREATE VIEW public.vip_customers AS SELECT …`.

## MariaDB 11 (`Demo · MariaDB 11`)
- `orders`, same quick filter: "Rows 1–300 of 5,039" (CLI: 5039).
- Total of order 3 → 2756.72: preview `` UPDATE `tablemax_demo`.`orders` SET `total` = '2756.72' WHERE `id` = '3' ``;
  Ctrl+S → CLI reads 2756.72 (put back to 2756.71 afterwards).
- Alt+2: Columns (`bigint(20)`, `enum('pending',…)`, `decimal(12,2)` default `0.00`,
  `datetime`), Indexes (`PRIMARY` primary + unique, `orders_customer_idx`; no definition
  column text, as noted in Task 1), Foreign keys (`orders_customer_fk` →
  `tablemax_demo.customers (id)`, RESTRICT / RESTRICT), DDL (`CREATE TABLE `orders` … ENGINE=InnoDB …`).
- `order_items` → Ctrl+click `order_id` 2 → `orders (id = 2)` with the trail.

## MySQL 8 (`Demo · MySQL 8`)
- Same filter → 5,039 (CLI: 5039); edit order 3 → 2756.72, Ctrl+S → CLI 2756.72 (put back).
- Structure: Foreign keys NO ACTION / NO ACTION; DDL `bigint` (no display width),
  `DEFAULT '0.00'`, `COLLATE=utf8mb4_0900_ai_ci`.
- Conflict: row 20001 inserted from the `mysql` CLI, loaded (`id = 20001`), total → 11,
  row deleted from the CLI, Ctrl+S → "Change 1 failed: the row changed or was deleted
  since it was loaded", nothing written (the row shown in red). Discard.

## SQLite (`Demo · SQLite`)
- `audit_log` (no key): "Read-only: this table has no primary key and no unique index on
  NOT NULL columns, so a row cannot be identified.", no + Row / Commit.
- `orders`: same filter → 5,039 (`sqlite3`: 5039); edit order 3 → 2756.72, preview
  `UPDATE "main"."orders" SET "total" = '2756.72' WHERE "id" = '3'`, Ctrl+S → `sqlite3`
  reads 2756.72.
- Structure: Foreign keys `orders_customer_id_fkey` → `main.customers (id)`, NO ACTION;
  DDL is the stored `CREATE TABLE orders (…)` + `CREATE INDEX orders_customer_idx …`.

## Not verified manually / observations
- Not driven: the Alt shortcuts while typing in a field or with a modal open (Vitest
  covers both); macOS labels (`⌥1`, `⌘S`).
- The Data / Structure choice is per mounted tab: switching to another tab and back shows
  Data again (only the active tab is mounted, like the row details panel).
- The grid menu offers **Set empty string** on non-text columns (`bigint` id, `integer`
  quantity); committing it would fail on the cast and roll back. Pre-existing (Task 4/5),
  noted in plan-03-followups.md.
- The `title` tooltip of the trail renders as a black box on Xvfb (no compositor), an
  environment artefact.

# Plan 3 — rulings and deferred follow-ups

Started during Plan 3 (branch feat/plan-03-data); completed from the SDD ledger at the end
of the plan, after the final fix wave. Deferred minors that the fix wave resolved are left
out; lines it resolved in part keep only what is still open.

## Rulings

### Pre-flight
- Ruling: T5 renders no FK link in RowDetailPanel; T7 adds it there along with the grid link — cost: none.
- Ruling: T6 reuses T4's "commit or discard first" guard for filter changes — cost: none.
- Ruling: MySQL sessions all use CLIENT_FOUND_ROWS (SQL-tab UPDATE now reports matched rows, like PG/SQLite) — cost: a user comparing with the mysql CLI may see a different "rows affected" for no-op updates.
- Ruling: plan 3 written/executed without user review — user goal: autonomy — cost: rework if scope disagrees.

### Task 2 — parameterized pages and filters
- Ruling: plan's MySQL `ESCAPE '\'` was wrong under NO_BACKSLASH_ESCAPES — correctness wins: use an escape character that is mode-independent (e.g. `ESCAPE '!'` escaping `!`, `%`, `_` in all dialects, or MySQL `ESCAPE CHAR(92)`) — cost: unit-test strings change.
- Ruling: PG casts use the base type without typmod (new ColumnInfo.base_type = format_type(atttypid, NULL)), in filters and in Task 3 DML so the DB enforces typmod on assignment — overrides plan constraint text — cost: TableInfo gains a field (TS mirror in T4).
  - Superseded in Task 3 by `format_type(atttypid, -1)` (below), and by the final fix wave for domains (resolved recursively to their base type, also with `-1`).
- Ruling: explicit sort gets a row_key/rowid ASC tiebreaker for stable OFFSET paging — cost: none.

### Task 3 — row changes
- Ruling: DML casts use base_type (DB enforces typmod, errors instead of silent truncation); apply holds the driver lock for the whole tx; per-workspace generation counter for the TableInfo cache; NULL key values refused ("row has a NULL key"); cell_value capped at 16 MiB — cost: SQLite rows with NULL PK not editable in v1.
- Ruling: base_type = format_type(atttypid, -1) (bpchar, "bit") — cost: none.

### Task 4 — inline editing
- Ruling: binary-ness comes from the backend (ColumnInfo.binary) and build_change rejects text for binary columns — single source of truth — cost: TableInfo gains a field.

### Task 7 — foreign keys and copy
- Ruling: copy exports what is DISPLAYED (pending edits applied) in all formats — cost: copying before commit yields uncommitted values.
- Ruling: defense in depth — PendingTab records its object; commit/addInsert/setCell refuse on object mismatch; duplicate bails after awaits if object changed — cost: none.

### Final review
- Ruling: concurrent edits of other columns are last-write-wins (TablePlus-class behavior); STALE_ROW reworded to "the row was deleted or its key changed since it was loaded" — cost: silent overwrite of a colleague's concurrent edit to other columns (documented).
- Ruling: apply bounds lock waits (PG lock_timeout 30s, MySQL innodb_lock_wait_timeout 30) + changes_cancel command — cost: very slow legit commits on contended rows fail after 30s.
- Ruling: MySQL TIMESTAMP DST fall-back key ambiguity deferred (documented) — cost: rare wrong-row on that hour (exactly-one guard can't see it).

## Behaviour changes worth knowing

- MySQL / MariaDB sessions connect with `CLIENT_FOUND_ROWS` (all of them: browse and SQL
  tabs). An `UPDATE` reports the rows it **matched**, including rows that already held the
  new value — the same meaning as PostgreSQL and SQLite, which the grid's
  exactly-one-row check relies on. Visible effect: in a SQL tab, a no-op `UPDATE` reports
  1 row affected where the `mysql` CLI would report 0.
- PostgreSQL values are cast to the column's type without its modifier,
  `format_type(atttypid, -1)` (`bpchar`, `"bit"`, `numeric`, `character varying`); a
  domain is cast to its underlying base type (recursively, domain over domain), so a cast
  never applies the domain's own modifier. (`format_type(atttypid, NULL)` prints
  `character` / `bit`, which parse back as `char(1)` / `bit(1)`.) The modifier is then
  applied by the database on assignment, with its own rules:
  - text that does not fit `char(n)` / `varchar(n)` / `bit(n)` (or a domain over them) is
    an error, never a cut;
  - a number with more decimals than the column's scale (`numeric(12,2)` ← `1.005`) and a
    time with more fractional digits than its precision (`timestamp(0)` ← `…:05.6`) are
    **rounded**, by PostgreSQL and by MySQL / MariaDB alike (MySQL keeps it a note even in
    strict mode). A value too large for the precision is an error.
- **Concurrent edits are last-write-wins.** The exactly-one-row guard catches a row that
  was deleted, or whose key changed, since it was loaded ("the row was deleted or its key
  changed since it was loaded"; everything rolled back). A change made meanwhile by someone
  else to *other* columns of a row that is still there is not detected: the commit writes
  its values over it, like other desktop clients.
- A commit waits at most 30 s for a row locked by another session (PostgreSQL
  `SET LOCAL lock_timeout`, MySQL / MariaDB `innodb_lock_wait_timeout` for the transaction,
  the session's value restored after): then the change fails like any database error and
  nothing is written. **Cancel** (shown while committing; `changes_cancel`) interrupts it
  and rolls everything back.
- A commit whose connection drops (`ConnectionLost` / `Connection`) has an **unknown
  outcome** (the COMMIT may have reached the server): the grid says so, keeps the pending
  changes and refuses another commit until the page has been reloaded (Reload stays
  allowed in that state).
- A cancel that lands on the COMMIT itself (MySQL `KILL QUERY` → error 1317; the same
  mapping applies to every engine) is reported as `Connection` "the commit was
  interrupted: whether it was written is unknown" — an unknown outcome too, never
  "cancelled, nothing written".
- **Known behaviour:** a commit cancel re-sends the browse connection's canceller
  (PostgreSQL cancel token / MySQL `KILL QUERY` on the browse connection), so it can also
  interrupt a page or count running at the same time on that connection — on MySQL as
  well as PostgreSQL. That page or count shows Cancelled; a reload fixes it.
- One commit per workspace at a time: a second `changes_apply` while one runs is refused
  (`Invalid` "a commit is already running in this workspace") and leaves the running one
  and its cancel alone.
- A lost browse connection (server restart, killed backend, dropped after a failed
  ROLLBACK, dead SSH tunnel) is rebuilt by the next call, once per loss; reads (pages,
  counts, metadata, cell values, schema and object lists, DDL) retry once on the new
  connection. Writes never retry.
- MySQL `TIMESTAMP` keys in the hour repeated when daylight saving time ends: the session
  shows two instants as the same local time, so the key the grid loaded can match the other
  row of that hour (the exactly-one-row guard sees one row either way) or none. Use a
  `DATETIME` key, or a session time zone without DST (`UTC`), if this matters.

## Deferred (Task 1)

- Tests missing for PostgreSQL partial / expression unique indexes, PG `type_name` of
  arrays / enums / `varchar` / `timestamptz`, MySQL `STORED` generated columns.
- PG `relation()` defaults to `public` instead of `current_schema()`; PG index sort
  duplicated; PostgreSQL 18 virtual generated columns; materialized view DDL omits its
  indexes; MariaDB `SEQUENCE` classed as a table.
- MySQL `IndexInfo.definition` is `None`; MySQL and MariaDB report foreign key actions and
  integer types differently (`NO ACTION` / `RESTRICT`, `int` / `int(11)`).
- `manager.rs` (~2,700 lines) and `mysql.rs` are large: split tests and `*_meta`
  submodules out.

## Deferred (Task 2)

- MySQL filtered path takes ~5 round trips (merge `DEALLOCATE` and the variable clear);
  a `KILL` in the middle of the cleanup may leave session variables set.
- `ILIKE` on MySQL `_bin` collations is case-sensitive.
- The any-column filter does not see PG `bytea[]` as binary.
- PG simple-query path maps errors with `map_err`, not `map_live_err` (lost-connection
  classification).

## Deferred (Task 3)

- SQLite rows whose primary key (not `INTEGER PRIMARY KEY`) is NULL cannot be edited
  ("row has a NULL key"); a rowid fallback needs `rowid` in `RowKey`.
- MySQL `FLOAT` (single precision) key columns: the loaded value never compares equal, so
  edits by such a key end as "the row was deleted or its key changed since it was loaded"
  (nothing written). `DOUBLE` is fine.
- SQLite column without type affinity holding an integer key: compared with bound text,
  it reports a false stale row. A PG `BEFORE` trigger returning NULL is reported as a stale
  row too.
- A cancel that lands during the COMMIT window, and PostgreSQL's asynchronous cancel in
  general, may hit the next statement on the same connection; the failed-ROLLBACK paths are
  untested (the reconnect after them is).
- `suggests_schema_change` matches English error messages: a localized PostgreSQL server
  does not invalidate the cached metadata after a schema change (the user can refresh).
- The 16 MiB cap of `cell_value` is not tested on MySQL / MariaDB (inserting 17 MiB
  depends on `max_allowed_packet`).
- The MySQL SQL preview always doubles backslashes (right under the default sql_mode;
  shows them doubled under `NO_BACKSLASH_ESCAPES`). The PostgreSQL preview should emit
  `E'…'` for backslashes and bytes, like the frontend copy, whatever
  `standard_conforming_strings` says.
- `dml.rs` mixes statement building and apply bookkeeping.
- PG arrays of a domain with a modifier (`d5[]` over `varchar(5)`) are still cast to the
  domain's array type (the element modifier applies on the cast).
- The first commit after a MySQL server killed an idle browse connection fails with
  `ConnectionLost` (the client only learns it then) and is shown as an unknown outcome,
  though nothing was sent; the reload rebuilds the connection.
- `changes_cancel` re-sends the cancel until the commit returns: on PostgreSQL it can
  cancel a page fetch issued meanwhile on the same browse connection.

## Deferred (Task 4)

- The context menu is not clamped to the viewport and has no arrow-key navigation.
- Row markers count inserted rows.
- Glide's overlay drops edits on synthetic instant typing (upstream).
- A stale `editorOpen` flag stays after closing a tab with its editor open.
- Retry after a load error is refused while changes are pending (Reload is allowed only
  after a commit with an unknown outcome).
- A duplicate still loading when a commit starts is dropped silently.

## Deferred (Task 5)

- A keystroke in the window where a commit starts shows text that is not pending.
- In the row details, typing back to the loaded value after a blur leaves an UPDATE for
  JSON / long text (revert when the text equals the loaded shown text); erasing a new
  row's field returns it to DEFAULT (untested).

## Deferred (Task 6)

- Apply is not disabled while changes are pending (it refuses with the message instead).
- No test for a filter surviving a tab switch.
- `ILIKE` typed in the quick bar is accepted on MySQL / SQLite: hint `LIKE` instead.

## Deferred (Task 7)

- Foreign key jumps filter the referenced table with `ref_column = '<value>'`. A value is
  bound as text: PostgreSQL casts it to the column's type, MySQL and SQLite compare it as
  is. So a jump can show 0 rows when:
  - the referenced SQLite column has no type affinity (declared without a type, or with a
    type that gives it none): an integer stored there never equals the bound text `'42'`;
  - the referenced MySQL column is `FLOAT` (single precision): the value loaded as a
    double never compares equal (same cause as the `FLOAT` key editing limit above).
    `DOUBLE` is fine.
- No link for binary key values (filters bind text) or when the referenced column is a
  PostgreSQL `json` column (no `=` operator; the load error shows, the breadcrumb goes back).
- After a jump no row is selected: an open row details panel waits for a click on the
  (usually single) referenced row.
- `linkAt` is recomputed per draw (memoize); the tab title has no filter hint.
- Integration with Plan 4: `openTableTab` dedupes on the navigated object; FK navigation
  and edits should pin a preview tab; dedupe `src/lib/sqlQuote.ts` with `sqlIdent.ts`.

## Deferred (Task 8)

- The Data / Structure choice of a table tab is not kept when switching tabs (only the
  active tab is mounted; same as the row details panel). Keep it per tab in a store if
  users miss it.
- Focus is not restored to the grid after Alt+1; the `contentEditable` guard of the
  shortcuts is untested in jsdom; `altShortcut` duplicates `modShortcut` (dedupe at
  integration).
- Known behaviour: a high `exact_count_threshold` setting makes filtered counts scan up to
  that many rows; they hold the browse connection until done and have no user-facing cancel.

# Plan 3 — rulings and deferred follow-ups

Started during Plan 3 (branch feat/plan-03-data); completed from the SDD ledger at the end
of the plan.

## Behaviour changes worth knowing

- MySQL / MariaDB sessions connect with `CLIENT_FOUND_ROWS` (all of them: browse and SQL
  tabs). An `UPDATE` reports the rows it **matched**, including rows that already held the
  new value — the same meaning as PostgreSQL and SQLite, which the grid's
  exactly-one-row check relies on. Visible effect: in a SQL tab, a no-op `UPDATE` reports
  1 row affected where the `mysql` CLI would report 0.
- PostgreSQL values are cast to the column's type without its modifier,
  `format_type(atttypid, -1)` (`bpchar`, `"bit"`, `numeric`, `character varying`): the
  column enforces `char(n)` / `varchar(n)` / `numeric(p,s)` / `bit(n)` on write, so a value
  that does not fit is an error, never a silent cut. (`format_type(atttypid, NULL)` prints
  `character` / `bit`, which parse back as `char(1)` / `bit(1)`.)

## Deferred (Task 3)

- A browse connection that is lost without SSH (including after `apply` dropped it because
  a ROLLBACK failed twice) is not rebuilt: calls report `ConnectionLost` until the
  workspace is reopened. The manager only rebuilds browse connections whose SSH tunnel died.
- SQLite rows whose primary key (not `INTEGER PRIMARY KEY`) is NULL cannot be edited
  ("row has a NULL key"); a rowid fallback needs `rowid` in `RowKey`.
- MySQL `FLOAT` (single precision) key columns: the loaded value never compares equal, so
  edits by such a key end as "the row changed or was deleted since it was loaded" (nothing
  written). `DOUBLE` is fine.
- `suggests_schema_change` matches English error messages: a localized PostgreSQL server
  does not invalidate the cached metadata after a schema change (the user can refresh).
- The 16 MiB cap of `cell_value` is not tested on MySQL / MariaDB (inserting 17 MiB
  depends on `max_allowed_packet`).
- The MySQL SQL preview always doubles backslashes (right under the default sql_mode;
  shows them doubled under `NO_BACKSLASH_ESCAPES`).

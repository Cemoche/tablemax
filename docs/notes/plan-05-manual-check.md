# Plan 05 manual check — Task 6 (integration)

End-to-end check of Plan 5 Task 6 (safe mode on grid commits, settings consumed,
customizable shortcuts) on branch `feat/plan-05-task6` after Phase A, Phase B and the merge of
`integration/v1` @ 9bd1441 (Plans 3 + 4 + 5, Plan 4 review fixes). 2026-10-18.

## Setup

- Release binary: `pnpm tauri build --no-bundle` (4 min 35 s), run from a scratch copy.
- Isolated session, as in `plan-05-release-check.md`: scratch `HOME`, `XDG_DATA_HOME`,
  `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR` (mode 700) and `TMPDIR`, `env -i`,
  private Xvfb display `:58` (1600×1000), `GDK_BACKEND=x11`,
  `WEBKIT_DISABLE_COMPOSITING_MODE=1`, private `dbus-run-session`. Driven with xdotool,
  checked on `import` screenshots and with `sqlite3` on the database file.
- Data: `scripts/demo/sqlite.sql` loaded into a scratch `prod.sqlite` (2,500 customers).
- The real `~/.local/share/dev.tablemax.app` and `~/.ssh/known_hosts` were not touched
  (mtimes before and after: 2026-10-17 12:56:25 and 2026-10-15 14:53:34).

## Verified

- **Prod connection, banner and title.** New connection "Prod SQLite", environment `prod`
  (the safe mode select switches to "Default (by environment): Confirm writes"), driver
  SQLite, file `prod.sqlite` → Save → Connect. Red banner "Prod SQLite · PROD — Safe mode:
  confirm writes", red workspace border and switcher dot, window title
  `TableMax — Prod SQLite [PROD]`.
- **Settings shortcut and modal-aware shortcuts.** Ctrl+, opens Settings. With Settings
  open, Ctrl+T opens no tab and Ctrl+W closes no tab.
- **Settings consumed.** Page size 300 → 50 (Enter), "Add a LIMIT to SELECT queries by
  default" on, Default LIMIT 1000 → 50 (Enter). `settings.json` holds `"pageSize": 50`,
  `"autoLimitDefault": true`, `"autoLimitValue": 50`.
- **Custom shortcut.** Keyboard → New query tab → Change → "Press a combination…" →
  Ctrl+Shift+N: saved as `"keymap": {"query.new": "Mod+Shift+N"}`, label "Ctrl+Shift+N",
  Reset button shown. Open the command palette → Change → Ctrl+W: refused, "Already used by
  Close tab", nothing saved. Escape while recording: recording cancelled, Settings stays
  open. After Close: Ctrl+T does nothing, the empty-workspace hint reads "press Ctrl+Shift+N
  for a new query", Ctrl+Shift+N opens "Query 1" with "Auto LIMIT 50" checked by default.
- **Editor confirmation shows the SQL that runs.** Run all on
  `select id, full_name from customers order by id; update customers set notes = 'manual-check' where id = 1;`
  → "Confirm before running": statement 1 shown as
  `select id, full_name from customers order by id LIMIT 50` (Auto LIMIT appended),
  statement 2 marked "Needs confirmation". A click on the dialog text (focus leaves the
  buttons) then Escape → cancelled, no result, `notes` of id 1 still NULL. Run all again →
  Run → "Result 1 · 50 rows", "Statement 2: 1 row affected", `notes` = `manual-check`.
  (A first attempt with a wrong column name stopped at statement 1 with the error quoting
  the SQL as sent, `… LIMIT 50`; the update did not run.)
- **Grid commit on prod.** `customers` → "Rows 1–50 of 2,500" (page size 50), Commit label
  "Commit (Ctrl+S)". Edit `notes` of id 2 → "grid-check", Ctrl+S → "Confirm before running"
  with `UPDATE "main"."customers" SET "notes" = 'grid-check' WHERE "id" = '2'` marked "Needs
  confirmation". Cancel → still "1 pending change", database unchanged (NULL). Ctrl+S → Run
  → pending list cleared, database `grid-check`.
- **Alt+2** switches the table tab to Structure (columns listed).
- **Theme live.** Settings → Dark with the table tab open: the whole window turns dark at
  once (sidebar, tabs, structure view); `settings.json` holds `"theme": "dark"`.

## Observations (not regressions of Task 6)

- The grid commit preview prints every value as a text literal (`WHERE "id" = '2'` for an
  integer key): `dml::render_preview` renders parameters as text, as in Plan 3; display only
  (the commit binds typed parameters).
- Typing into fields with xdotool `--window` loses keystrokes under Xvfb (the first name
  typed into the connection form did not arrive); typing without `--window` works. A test
  harness detail, not an app issue.

## Not covered here

- PostgreSQL / MySQL connections (the safe mode and commit guard are backend-generic and
  covered by the integration tests on the test stack).
- macOS shortcut labels (⌘) — unit-tested only.

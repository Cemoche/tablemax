# Plan 4 — rulings and deferred follow-ups

Extracted from the SDD ledger of Plan 4 (branch feat/plan-04-navigation, head d3aa06a),
its final whole-branch review and the review fix wave (branch fix/plan-04-review).
Deferred minors that the fix wave resolved are left out; lines it resolved in part keep
only what is still open. Item 5 of the last review (pin a preview tab on its first grid
edit, and refuse/confirm a database switch while grid edits are pending) is handled in
the integration branch (integration/v1), not here.

## Rulings

### Plan 4 tasks (ledger)

- Ruling R1: T3 pins a preview tab on first sort/page by subscribing to the useGridViews store (src/stores/gridViews.ts, outside the grid folder) from the workspaces store; "first modification/filter" are Plan 3 features — T3 exposes pinTab and the orchestrator/Plan-3 rebase wires edits/filters to it — why: honours the no-touch rule on src/features/grid/** — cost if wrong: after rebase, editing a preview tab does not pin it until one line is added in Plan 3's edit path.
- Ruling R2: session_save/load live in a new src-tauri/src/session_state.rs (not history.rs) — why: one responsibility per file — cost: none.
- Ruling R3: T1 adds the ipc.ts/types.ts wrappers + shape tests for all its commands (history, session, saved queries) so later frontend tasks consume a pinned contract — why: CLAUDE.md "a new command = … + ipc + types" — cost: none.
- Ruling R4: T2 adds `database: string | null` to WorkspaceInfo (Rust + types.ts + shape test), filled at open from the config and updated by switch_database — why: plan says the returned WorkspaceInfo carries the current db — cost: none.
- Ruling R5: a restored workspace gets a frontend placeholder id; on successful connect the store swaps it for the backend workspace id (workspaces[].id and activeWorkspaceId), keeping tabs (tab ids unchanged); openWorkspace on a connection whose workspace is disconnected connects it instead of only activating — why: every ipc call (incl. grid code we can't touch) uses workspace.id as the backend id — cost: WorkspaceView remounts once on reconnect.
- Ruling R6: T6 creates a small editor-command bridge (src/features/editor/editorCommands.ts: per-tab registration of commands by the mounted SqlEditor); T6 wires "comment" (toggleComment) through it; T7 registers "format"; the palette "Format query" action uses `when` = a format command is registered for the active tab, so no dead action exists between T6 and T7 — cost: one tiny module.
- Ruling R7: the "Open history" palette action is added by T8 (with HistoryPanel), not T6 — cost: none.
- Ruling R8: palette "Change schema…" / "Change database…" (PG only) switch the palette to a sub-list of schemas / databases (databases_list) — cost: none.
- Ruling R9: Auto LIMIT checkbox state is per tab in memory, not in the session snapshot (Plan 5 turns it into a setting) — cost: resets to off after restart.
- Ruling R10: T8 adds an optional `savedName: string | null` to snapshot query tabs (still version 1; parseSnapshot accepts it absent) so a restored tab stays linked to its saved query — cost: none.
- Ruling R11: palette Objects = tables/views of the active workspace's current schema from the catalog store (loaded once per schema) — cost: objects of other schemas need a schema switch first.
- Ruling R12: fix that test to build the known_hosts host from the configured SSH port (test-only commit, folded into the Task 2 dispatch) — why: full `pnpm test:rust` must be green on the alternate stack the README documents — cost: tiny conflict risk if Plan 3 touches the same test (unlikely).
- Ruling R13 (T4): on restart the previously active workspace is restored as active but disconnected (Reconnect button); connect starts only on a user action (tab activation, workspace selection, Reconnect) — why: plan "rien ne se connecte avant activation" — cost: one extra click after restart for the last workspace.
- Ruling R14 (T4): parseSnapshot rejects missing/invalid required fields but ignores unknown extra fields within version 1 — why: lets T8 add optional savedName without a version bump — cost: a malformed extra field is silently dropped.
- Ruling R15 (T4): restored PG database differing from the default is re-applied via workspaceSwitchDatabase after connect; failure keeps the default db — cost: user lands on the default db if the saved one vanished.
  - Amended by the fix wave: on that fallback the restored table tabs are closed and a notice is shown (see below).
- Ruling R16 (T4 ⚠️): keep the plan-mandated beforeunload save; whether it fires/completes on a Tauri/WebKitGTK window close is checked in the Task 8 manual check; no onCloseRequested hook (would need core:window:allow-destroy beyond core:default) — cost if wrong: changes in the last <1 s before quitting are lost (the 1 s debounce saves everything else).
- Ruling R17 (T5): T5 creates src/lib/sqlIdent.ts (quoteIdent / qualifiedName per dialect, quoting only when needed is T7's concern — T5 always quotes for "New query") reused by T7 completion — why: no frontend quoting helper exists — cost: none.
- Ruling R18 (T5): sidebar Refresh also forces the backend catalog cache (ipc.catalogGet(ws, schema, true), errors ignored) until T6's catalog store exists; T6 rewires it to refreshCatalog — cost: one extra query per refresh.
- Ruling R19 (T5, supersedes the "leave old table tabs" part of the T5 dispatch): on a PG database switch, close the workspace's table tabs (they'd silently query the new db under the old title — with Plan 3 editing that's a write to the wrong db); query tabs keep their own SQL sessions on the old db (backend behaviour) — cost: user reopens tables after a switch.
- Ruling R20 (T5 review minor D): show the switch error as the generic text + toAppError(e).message (src/CLAUDE.md rule; backend messages never carry secrets per src-tauri rules) — folded into the T5 fix round as a one-liner — cost: none.
- Ruling R21 (T6): palette Tabs group = tabs of the active workspace only, activated through activateTab (so disconnected workspaces connect per T4) — cost: tabs of other workspaces need a workspace switch first.
- Ruling R22 (T6): Objects group filtered/scored by us (cmdk scorer) before rendering, top 200 — cmdk's internal filter only sees rendered items — cost: none.
- Ruling R23 (T6 minor 4 → carried into T7): stale in-flight catalog load can repopulate the store after dropWorkspace on a db switch → T7 adds a per-key generation guard in src/stores/catalog.ts since completion depends on it — cost: none.
- Ruling R24 (T7): completion offers other-schema tables only for schemas already in the catalog store (no fetch of every schema); typing `schema.` loads that schema's catalog if it's in workspace.schemas — cost: other-schema tables appear only after that schema was loaded once.
- Ruling R25 (T7): fold review minor 2 (`for update offset 5` → invalid) into the fix round — same "never produce invalid SQL; worst case unchanged" guarantee — cost: none.
- Ruling R26 (T8): Steps 1–4 (+ code commit) by the implementer; Step 5 manual check by a separate dispatch in an isolated Xvfb session, committed as docs/notes/plan-04-manual-check.md; fixes it finds go through a review like any fix — cost: none.
- Ruling R27 (T8, user decision): the security re-review's own probe pass was blocked by a safety check; per Cem, coverage done as in-repo regression tests (26 candidates × trailing DROP refused, bare accepted, 3 integration cases) instead of an external probe — cost if wrong: a bypass outside the tested shapes stays undetected (final review asked to look again).
- Ruling R28 (supersedes R16): manual check proved beforeunload does NOT persist in the real webview — a change <~1.3 s before close is lost. Fix now (not deferred): Rust on_window_event CloseRequested → prevent_close + emit "session-flush-requested"; frontend flushes sessionSave then invokes a new `window_close_confirmed` command; Rust fallback closes anyway after ~2 s; no new capability (event listen is in core:default) — cost: one new command + close path.
- Ruling R29 (manual #2): keep R13 — restored active workspace shows Disconnected + Reconnect, prompt only on a user action (plan: "rien ne se connecte avant activation") — cost: one click after restart.
- Ruling R30: other quit paths (OS logout, SIGTERM, app.exit, macOS Cmd+Q without per-window CloseRequested) skip the flush and fall back to the 1 s debounce — out of R28's scope; noted as known limit in followups — cost: changes <1 s before such a quit are lost.

### Final review fix wave (fix/plan-04-review)
- Ruling: history skips SQL matching `\bIDENTIFIED\b|\bPASSWORD\b` (case-insensitive) and app.db runs with `PRAGMA secure_delete = ON`; the session snapshot keeps the editor text of SQL tabs (the user's own unsaved document, like a file), documented in the README — cost: unsaved tab text holding a password still lands in app.db (owner-only on Unix).
- Ruling: MySQL/MariaDB client character sets whose multi-byte characters can end with an ASCII byte (big5, cp932, gb18030, gbk, sjis) are refused: the client charset is read at connect and re-read with sql_mode (after statements mentioning `sql_mode`, `names`, `character` or `charset`, or starting with SET/EXECUTE/CALL/BEGIN, whether they succeed or fail); while it is unsafe, every statement is refused except an ASCII-only `SET …` (tokenized identically in those charsets), so the user can follow the message and run `SET NAMES utf8mb4` — cost: those charsets are unusable in TableMax.
- Ruling: dollar-quoted bodies (a word token starting with `$` and holding a second `$`: `$$`, `$tag$…`, MySQL 9 JavaScript routines) are refused (fail closed) — cost: JavaScript routines cannot be created from TableMax.
- Ruling: formatting is refused for MySQL text holding a `DELIMITER` line, and for a selection that starts inside a `DELIMITER` region (`delimiterAt`) — cost: no formatting for such scripts.
- Ruling: a PostgreSQL query tab records the database its first SQL session was opened on (`Tab.database`, also in the session snapshot as an optional field, still version 1); a lost session reopens there through `sql_session_open(workspaceId, database)`; the tab bar shows a small database badge when it differs from the workspace's database. A tab that never ran takes the workspace's current database at its first Run — cost: none.
- Ruling: when a restored workspace cannot re-select its saved database (R15 fallback), its table tabs are closed (same hazard as R19) and a dismissable workspace notice names the database it connected to; query tabs stay — cost: the user reopens those tables.
- Ruling: saving onto a case variant of an existing saved query asks to replace it under the existing spelling and writes that spelling (one file on every file system) — cost: the typed spelling is not kept.
- Ruling: parseSnapshot skips tabs whose `kind` is a string it does not know (remapping the active index; an unknown active tab gives no active tab); a tab without a kind, a known kind with a bad shape or an out-of-range index still invalidates the session — cost: none.
- Ruling: the MySQL "modes changed by a failing statement" case is real only for a MariaDB anonymous block (`BEGIN NOT ATOMIC SET NAMES gbk; SIGNAL …; END` keeps the charset); stored routines, and anonymous blocks for sql_mode, restore the caller's values, so the integration test covers the MariaDB charset case only — cost: none.
- Ruling: on Unix app.db is forced to 0600 at every open (also an older 0644 file); a missing app folder, the queries folder and each connection's queries folder are created 0700; saved query files are written 0600. An existing app folder keeps its mode — cost: an app folder created by an older build stays 0755 (its files are private).

## Deferred minors (to triage in Plan 5 or later)

### Still open from the final review (fix-wave scope excluded them)
- M1: completion detail shows the raw kind enum (`table`/`view`) instead of a `strings.ts` label (completion.ts) — marked FIX-BEFORE-MERGE by the review; not in this wave's findings.
- Manual #4: Ctrl+T / palette "New SQL tab" do not focus the new editor — marked FIX-BEFORE-MERGE by the review; not in this wave's findings.
- M3: `session_state` keeps a deleted connection's tab text until the next session save (delete_connection purges history and saved queries only).
- M5: driver/mysql.rs (~2 100 lines, ~900 of lexer + Compound tracker) and manager.rs (~2 600 lines) should be split; extract the lexer into `driver/mysql_lexer.rs`.
- M6: `window_close_confirmed` while the close gate is Idle flips it to Allowed for good (guard: confirm only from Pending); the Rust window handler is untested (the manual re-check covers it).
- The MySQL single-statement guard still deserves an adversarial pass (differential fuzzing of `has_multiple_statements` against the real server parser), owned by Cem (R27).
- macOS Cmd+Q and the other quit paths of R30: Plan 5 packaging prerequisite (`RunEvent::ExitRequested` → same flush).

### From the task ledger

- Task 1: minor (deferred): history::list limit=0 with search returns 1 entry (history.rs)
- Task 1: minor (deferred): name cap is 120 chars not bytes — 120 CJK/emoji chars exceed ext4 NAME_MAX → Io error instead of Invalid
- Task 1: minor (deferred): history rows can be orphaned if a connection is deleted mid-batch (pending write lands after purge)
- Task 1: minor (deferred): load_session detects missing table by matching "no such table" string
- Task 1: minor (deferred): types.shape.test.ts import order nit (SavedQuery)
- Task 1: minor (deferred): no test for record_many only_existing=true skipping a deleted connection
- Task 1: minor (deferred): folder-first delete: if the row delete fails after the folder is gone, queries are lost but connection stays (retry works)
- Task 1: minor (deferred): buffered history lost if the execute_batch future is dropped mid-batch; history appears only at batch end
- Task 1: minor (deferred): is_same_file macOS/Windows paths untested
- Task 2: minor (deferred): no single-flight on backend catalog cache miss (frontend ensureCatalog dedup in T6 covers the app path)
- Task 2: minor (deferred): Catalog deep-cloned on every cache hit (Arc would avoid it at 5 000 tables)
- Task 2: minor (deferred): no test of browse reconnect after a switch / no SSH test of switch_database
- Task 2: minor (deferred): opened_database current_database() fallback untested, swallows errors
- Task 2: minor (deferred): TTL cache test uses real sleeps (use start_paused + advance)
- Task 2: minor (deferred): test name mysql_and_sqlite_do_not_switch_database covers MySQL/MariaDB only; garbled comment tests/catalog.rs ~L1712
- Task 2: minor (deferred): whitespace-only db name → NotFound instead of Invalid; PG routines include extension-owned functions; per-driver tests had no RED run
- Task 2: minor (deferred): SQLite per-object column read swallows any error (a broken table also shows no columns)
- Task 3: minor (deferred): auto-repeat Ctrl+Tab while switcher open falls through without preventDefault (focus may move)
- Task 3: minor (deferred): shortcuts.ts silently ignores unknown modifier names (typo "Cmd+K" → K)
- Task 3: minor (deferred): TabList outside-click duplicates close(); focus not returned to ▾; aria-controls id absent when empty; activedescendant on search input
- Task 3: minor (deferred): no tests for switcher blur-cancel, empty-mru positional close fallback, modal opening mid-hold
- Task 3: minor (deferred): pin subscription scans all views×workspaces×tabs per gridViews change
- Task 3: minor (deferred): Mod+T/Mod+W tests check counts only (not kind/active, not which tab closed); useShortcut assigns ref during render; macOS now Cmd+T/W instead of Ctrl (per Mod rule — note in PR)
- Task 4: minor (deferred → T6 pointer): Mod+T / new tab on a disconnected workspace adds a tab but doesn't requestConnect; palette (T6) must go through activateTab/setActiveWorkspace/requestConnect
- Task 4: minor (deferred): close-while-connecting then immediate reopen joins the stale in-flight promise (needs 2nd click)
- Task 4: minor (deferred): a change during initial restore becomes baseline, saved only on a later change
- Task 4: minor (deferred): failed sessionSave retried only on next change, not on beforeunload
- Task 4: minor (deferred): restored workspace whose connection was deleted while open → Reconnect is a dead button, no message
- Task 4: minor (deferred): stray eslint-disable comment in App.tsx (project runs no eslint)
- Task 4: minor (deferred): App.tsx writes a ref during render (pure-render lint would flag)
- Task 5: minor (deferred): db select value has no option when database null/not listed (inject current db)
- Task 5: minor (deferred): routine click opens the context menu; menu has no viewport clamping / focus restore, stays open across refresh/switch
- Task 5: minor (deferred): "views section" test only checks headers exist
- Task 5: minor (deferred): after a switch, database changes before currentSchema → one wasted/possibly erroring objectsList with the old schema name (stale flag discards it; brief error flash possible)
- Task 5: minor (deferred): schemas-failure-after-successful-switch message still reads "switch failed"; concurrent switchDatabase returns silently
- Task 6: minor (deferred): scorer lacks word-boundary bonus / space↔_ normalization ("user acc" ≠ user_account)
- Task 6: minor (deferred): fuzzy.ts has no direct unit test; actions filtered but not ranked
- Task 6: minor (deferred): CommandPalette re-renders on every workspaces change while closed (split PaletteBody)
- Task 6: minor (deferred): unused strings.palette.loadSubFailed; databases-list error shown raw
- Task 6: minor (deferred): Enter-key selection untested; sub-list slow-first-call overwrite untested
- Task 6: minor (deferred): CommandPalette ~340 lines; cmdk pulls unused @radix-ui/react-dialog (bundle weight)
- Task 6: minor (deferred): no-op returnFocus reassign; hardcoded "schema.change"/"database.change" ids for stay; uncleared setTimeout; db-switch path still uses old close(); tests use real 10ms sleeps
- Task 6: minor (deferred): editor "focus" command returns true even if viewRef null (fallback skipped); outline-none on tab content region
- Task 7: minor (deferred): aliases inside a FROM/JOIN derived table not resolved (`from (select o.| from orders o) sub`)
- Task 7: minor (deferred): loadFormatter() rejection unhandled and cached for the session (SqlEditor.tsx)
- Task 7: minor (deferred): keyword list relies on lang-sql calling builder eagerly; two scanners (sqlLexer vs splitStatements) — follow-up: splitStatements on the lexer
- Task 7: minor (deferred): LANG/DIALECTS maps duplicated (completion.ts, SqlEditor.tsx); PG case folding approximate (bare O vs "o")
- Task 7: minor (deferred): role=status notice mounted with content (live region); weak "not in snapshot" assertion (Object.keys(tab))
- Task 7: minor (deferred): OFFSET followed by `(`/number in expression position still treated as clause (`select offset(1) from t` MySQL function named offset); `offset -1` leaves statement unchanged
- Task 8: minor (deferred, pre-existing): flaky mysql_driver cancel tests (mysql_dial_targets_…, mysql_cancel_over_tls) ~1/5–10 full-file runs, reproduced at 1df23c2 (a real driver race, fixed on integration/v1 in 91b2bfc; seen once more in this fix wave); palette_caps_results hit 5 s timeout once under load avg ~27
- Task 8: minor (deferred): Dialogs.tsx focus never restored (opener captured after autoFocus) — report claimed otherwise
- Task 8: minor (deferred): MariaDB FOR…DO…END FOR loops refused by driver / mis-split by frontend (safe, functional gap)
- Task 8: minor (deferred): Clear history disabled when filtered list empty; NameDialog never receives busy (double submit); other tabs linked to same saved name keep stale savedSql
- Task 8: minor (deferred): history refresh relies on fixed 500 ms delay; Run on a `DELIMITER ;` line runs previous stmt; (MySQL 9 JS routines are now refused, see the fix-wave rulings)
- Task 8: minor (deferred, fail-closed limits): unquoted `end` in IF/WHILE condition refused; `(SELECT …)` statement in a body refused; label named `begin` refused
- Task 8: minor (deferred): separator-less second CREATE tested only in Rust, not in the splitter; integration refusals assert error kind only (guard_x survival covers harm)
- Task 8: minor (deferred, manual #3): completion popup stays visible over the Save-query modal until editor click
- Task 8: minor (deferred, manual #5): sidebar highlight not synced with active tab after Ctrl+Tab
- Fix R28: minor (deferred): window_close_confirmed called while gate Idle flips it to Allowed for good (guard: confirm only from Pending); Rust window handler untested (manual re-check covers)

Partly resolved: "history rows can be orphaned if a connection is deleted mid-batch" —
`record_many(…, only_existing = true)` already checks the connection inside its
transaction; only the test is missing (next ledger line). "parseSnapshot drops whole
session for one unknown tab kind / out-of-range index": unknown kinds are now skipped; an
out-of-range index still invalidates the session.

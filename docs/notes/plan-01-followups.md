# Plan 1 — rulings and deferred follow-ups

Extracted from the SDD ledger at the end of Plan 1 (branch feat/plan-01-foundations).

## Rulings
- Ruling: Rust edition — use 2024 if the scaffold compiles with it, else keep template edition and note it — low cost if wrong (one-line change).
- Ruling: No TLS crates in Plan 1 (tokio-postgres NoTls, mysql_async default features w/o TLS) — Plan 2 adds SSL; YAGNI — cost: Plan 2 adds deps.
- Ruling: pg16 healthcheck without -h (reviewer Minor) elevated into fix round 1 — Task 4 integration tests depend on --wait returning only when TCP is up; flaky cold starts otherwise — cost if wrong: one extra line
- Ruling: CellValue::Bytes serializes fields as {len, hexPreview} (camelCase like all types) — Task 8 types.ts must mirror — cost: TS mismatch caught by tests
- Ruling: RowCount serializes {"t":"exact"|"estimate","v":n} (camelCase per global rule) — Task 8/10 TS mirror — cost: trivial
- Ruling: security hook flagged NoTls in postgres.rs — acknowledged, intentional for Plan 1 (spec SSL is Plan 2: sslmode with verify by default for non-loopback); Plan 1 build must not be used against remote/prod DBs; warn user at sneak peek — cost if wrong: plaintext traffic in dev preview only
- Ruling: (update) mitigate until Plan 2 — PG and MySQL drivers refuse non-loopback hosts (localhost/127.0.0.0/8/::1/unix socket) with ErrorKind::Connection 'TLS not supported yet: only local connections are allowed in this build' — added to Task 4 fix round and Task 5 brief context; Plan 2 removes the guard when sslmode lands — cost: remote DBs unusable in preview (intended)
- Ruling: no art direction now (user: keep 'sobre, dense, proche des outils du domaine'; design system later). Task 8 creates src/styles/tokens.css (CSS variables: bg/surface/text/muted/border/accent/danger + env colors local/dev/staging/prod, font sizes, spacing, radius; light+dark via prefers-color-scheme) and Tailwind theme maps to them; Tasks 9-11 must use tokens only, no hardcoded colors — cost: small refactor if a design system changes structure
- Ruling: Important 2 (lost cancel) handled in Task 7: SessionManager::cancel re-sends Canceller::cancel every 100 ms until the running statement returns (bounded 5 s) — applies to all drivers — cost: extra cancel requests (harmless)
- Ruling: security hook (confused deputy) accepted — keyring password is only reused when (kind, host, port, user, database, sqlite_path) match the STORED config for cfg.id; otherwise test_connection/save_connection require an explicit password (Auth 'password required'); added to Task 7 fix round (save_connection lives in store.rs, Task 6 code — fix applied there by Task 7 implementer) — cost: user retypes password after editing host/user
- Ruling: tokens follow system color scheme (light default, dark via prefers-color-scheme) instead of dark-first — spec Réglages says theme clair/sombre/système (Plan 5), system-follow is the closest default — cost: none
- Ruling: Task 10 keeps per-tab grid view state (page, sort) outside the component (store keyed by tab id) so switching tabs doesn't reset it — TabContent remounts on key={active.id} — cost: small store
- Ruling: Task 11 adds `updateTab(wsId, tabId, patch)` store action (sql text, sqlSessionId) — brief's action list lacks it; without it closeTab can't close SQL sessions — cost: none
- Ruling: grid row height 34px contradicts spec "dense" → set rowHeight 24 / headerHeight 28 in the same fix round (controller finding from manual check) — cost: trivial
- Ruling: re-reviewer's "manual-check notes must contain deviations only" rejected — plan Step 5 and the user's done-criteria ask for the manual verification recorded in docs/notes/plan-01-manual-check.md with deviations; the "Verified" section is controller-run evidence, which is the point of the file — cost if wrong: an extra section in a notes file
- Ruling: ONE final fix wave covers #1, #2, #3 (+4031), #4 (cap 10,000 rows per result set + truncated flag shown), Json cap, and cheap minors 5, 6, 7, 9; minor 8 deferred (fails safe) — cost: one larger fix wave
- Ruling: SQL result cap = 10,000 rows per result set (spec silent; Plan 4 adds auto-LIMIT) — cost: users must add LIMIT/pagination for bigger exports until Plan 4 export features

## Deferred minors (to triage in Plans 2–5)
- Task 1: minor (deferred): lint does not type-check vite.config.ts/vitest.config.ts (tsc without -b)
- Task 1: minor (deferred): template comment noise in src-tauri/Cargo.toml; placeholder Tauri icons; README lacks `down`
- Task 2: minor (deferred): build_page_query with sort None has no ORDER BY → unstable pagination; consider PK/rowid fallback in Plan 3 grid work
- Task 2: minor (deferred): tests missing for schema None, empty ident, Asc, exactly-10000-char boundary, RowCount serde; NUL in identifiers not rejected
- Task 3: minor (deferred): sqlite execute reports stale changes() for DDL after DML (use total_changes delta / readonly)
- Task 3: minor (deferred): cancel test uses fixed 200ms sleep — retry cancel in loop to avoid rare hang; same pattern for Task 7 tests
- Task 3: minor (deferred): SQLITE_OPEN_URI interprets user paths starting with "file:" as URI
- Task 4: minor (deferred): fallback path drops rows when prepare reports 0 cols; empty SELECT in fallback → result None
- Task 4: minor (deferred): Json/Decimal/Temporal not size-capped
- Task 4: minor (deferred): bytea_output session state can be changed by user (RESET ALL/DISCARD ALL) → bytes decode wrong; re-assert or detect `\x` prefix
- Task 4: minor (deferred): close() aborts task (no graceful Terminate); map_err over-broad; 42P01 in count_rows → Query; percent_decode panics on non-ASCII; admin session not closed in test
- Task 4: minor (deferred): with localized PG server, multi-statement error kind is Query instead of Invalid (frontend splitter prevents this path anyway)
- Task 5: minor (deferred): compound bodies (CREATE PROCEDURE … BEGIN…END) rejected by lexer — Plan 4 must update lexer + frontend splitStatements together (DELIMITER support)
- Task 5: minor (deferred): JSON cache invalidation approximate (leading comments, other connections)
- Task 5: minor (deferred): canceller connects with db_name (fails if DB dropped) → use no db
- Task 5: minor (deferred): inherent KILL QUERY race; MariaDB KILL QUERY ID; error 4031 → ConnectionLost; non-UTF-8 text test doesn't exercise path; CALL with side effects can be reported Cancelled; cancel test asserts <4s not <3s
- Task 5: minor (deferred): idle-cancel path untested; sql_mode refresh misses comment-prefixed EXECUTE/CALL; refresh ConnectionLost discards applied DML result; temp-user test cleanup not panic-safe, grants ALL ON *.*
- Task 6: minor (deferred): save_connection on upsert failure leaves new secret orphaned / overwritten (plan-mandated order); password ignored silently in Ask/None modes
- Task 7: minor (deferred, pre-existing): clippy --all-targets fails on tests/mysql_driver.rs:448 useless_format (pnpm lint doesn't use --all-targets)
- Task 7: minor (deferred): close can hang on MySQL until statement ends (close waits inner lock); close_workspace shuts sessions sequentially (N×5s); cancel returns Ok on 5s timeout; stray cancel after pre-statement stop; no tests for close-during-batch; connection_delete leaves open workspaces running; 10ms polling; held password not zeroized
- Task 7: minor (deferred): cancel during wait for old loop honoured late (add cancel_requested check to wait); identity-change + new password set before upsert; TOCTOU identity checks; Ask→Keyring + identity change w/o password fails closed
- Task 8: minor (deferred): shape test fixtures via JSON.parse pin nothing at type level; "re-enter password" msg misleading for Test in Ask mode; wrong password on prompted retry closes prompt; delete without confirmation; PasswordPrompt no Escape/focus trap; notice role=status for errors; unused strings; self-referential @theme vars + "dark-first" comment; workspaceClose rejection ignored; driver switch overwrites custom port; native GTK select styling heavy
- Task 9: minor (deferred): shortcuts use e.key (non-Latin/CapsLock) not e.code, no e.repeat guard, no modal guard, macOS Cmd excluded (Plan 5 keymap); closeWorkspace rejection unhandled; tablist a11y (tabpanel/aria-controls/roving); active tab not scrolled into view; glyphs × + not in strings; sidebar filter resets on remount; extra tests (concurrent open, schemasList reject, Ctrl+T/W, middle-click)
- Task 10: minor (deferred): floats shown with full round-trip digits (15.299999999999999) — consider 15 significant digits like sqlite CLI; page not clamped after rows deleted; TSV multi-cell escaping relies on Glide; test gaps (closeWorkspace drops views, NaN path, buildGridTheme fallback); bundle > 500 kB; Glide peer dep React ≤18
- Task 10: minor (deferred): unmount-invalidation test is vacuous (passes without fix); useGridTheme deps omit readVar; data-theme attribute switching not observed (Plan 5 theme setting)
- Task 11: minor (deferred): PG E-strings (E'a\';b') and SQLite [bracket;ident] not handled by splitter; Cancel no-op while session opening; Run with no statement gives no feedback; Mod-Enter = Cmd on macOS; redundant defaultKeymap; selected result tab resets on remount; lang-sql keyword autocomplete popup appears (Plan 4 completion)

## Out-of-scope notes from the final review
- PG/MySQL result cap bounds memory, not time (server keeps sending rows past 10,000; Cancel stops it) — server-side cursors later
- No PG/MySQL test cancels during the post-cap drain
- Result header repeats the number when exactly at cap ("10,000 rows (truncated to first 10,000)")
- clippy --all-targets: useless_format in tests/mysql_driver.rs (pnpm lint doesn't lint tests)
- Release build (pnpm tauri build) not yet smoke-checked for CSP/editor/grid
- Host forms: MySQL unix socket path and [::1] pass the local guard but fail to connect (fail safe)

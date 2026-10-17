# Plan 5 — rulings and deferred follow-ups

Extracted from the SDD ledger at the end of Plan 5 Tasks 1–5 (branch feat/plan-05-safety),
after the final fix wave. Deferred minors that a fix round or the final fix wave resolved
are left out; lines resolved in part keep only what is still open. Task 6 (integration
after the rebase on Plans 3 and 4) is done (Phase A, then Phase B): its checklist and
rulings are below.

## Rulings

### Pre-flight
- Ruling R1: Task 6 is not executed in this session; the handoff gives it to the orchestrator, after the rebase on Plans 3 and 4 — cost if wrong: none (explicit instruction).
- Ruling R2: Task 2 also mirrors its wire changes in `src/lib/types.ts` (`SafeMode`, `ConnectionConfig.safeMode?`, `ErrorKind "confirmationRequired"`), `src/lib/ipc.ts` (`sqlExecute` optional `confirmed = false`) and `types.shape.test.ts`: CLAUDE.md requires both sides to change together, and the plan step already hinted at ipc — cost if wrong: Task 3 redoes the same small edits.
- Ruling R3: Task 4 may touch `commands.rs`, `lib.rs`, `ipc.ts` (+ types) to add `app_version()`, which the plan's About section needs — cost if wrong: trivial.
- Ruling R4: Task 4's Keyboard section is a read-only list, local to `src/features/settings/`, of the shortcuts that exist on this branch (labels in strings.ts); `src/lib/shortcuts.ts` is Plan 4's and off-limits here. Task 6 swaps it for Plan 4's `DEFAULT_KEYMAP` — cost if wrong: a small list to replace at integration.
- Ruling R5: Task 1's "grid and editor go dark when data-theme=dark while the OS is light" is tested at hook level (useGridTheme rebuilds on a `data-theme` mutation; SqlEditor picks its dark base theme from useResolvedDark), because jsdom does not apply tokens.css; the CSS cascade is checked visually in the Task 5 release smoke — cost if wrong: a cascade bug caught only manually.
- Ruling R6: `execute_batch` resolves the safe mode from the stored config of the session's workspace, re-read at each batch (a stricter setting saved while open applies at once), falling back to the config captured at open when the connection is gone; the frontend never supplies the mode — cost if wrong: one extra blocking store read per batch. Refined by R16.

### Task 1 — settings and themes
- Ruling R7: `src-tauri/tests/ssh_tunnel.rs:276` hard-coded `[127.0.0.1]:2222` in a known_hosts fixture, so `unverifiable_known_hosts_blocks_without_trusting` failed on any non-default `TABLEMAX_TEST_SSH_PORT` (pre-existing). Fixed as a separate test-only commit (4fe2de2), host:port taken from `TABLEMAX_TEST_SSH`: the full gate needs it and the README promises side-by-side stacks — cost if wrong: a trivial rebase conflict if another branch fixes it too.

### Task 2 — safe mode backend
- Ruling R8: classifier details beyond the plan: EXPLAIN is a read only without any ANALYZE/ANALYSE token; a WITH holding any INSERT/UPDATE/DELETE/MERGE keyword is a write; `LOCK IN SHARE MODE` is a write; a string with several statements is a write; a store read failure at execute fails closed (`ConfirmAll`). The plan asks for "strict et prudent"; a false positive only costs a confirm click — cost if wrong: some harmless reads ask for confirmation on prod.
- Ruling R9: a SELECT calling side-effecting functions (`nextval`, `pg_terminate_backend`, user functions) stays a read: the spec defines reads syntactically (first keyword) and a function deny-list would be incomplete and give false confidence — cost if wrong: such a SELECT runs on prod without confirmation in confirmWrites mode (confirmAll still covers it).
- Ruling R10: `confirmed` is a plain per-call flag, not bound to a hash of the statements shown; the frontend must resend exactly the statements it displayed (QueryTab does, and a test pins it) — cost if wrong: a frontend bug could confirm a different batch than shown.
- Ruling R11: accepted the implementer's extension: unversioned `/*! … */` is also lexed both ways (a statement made only of an executable comment is a write), with new false positives (PG `explain (format 'json')`, MySQL `EXPLAIN FOR CONNECTION`, tables named like keywords), all fail-safe — cost if wrong: extra confirmation clicks on prod.

### Task 4 — settings dialog
- Ruling R12: no license is declared in the repo; choosing one is the owner's decision, so About shows one strings.ts entry "License: not chosen yet", no LICENSE file is added, and the repository is plain text `github.com/Cemoche/tablemax` — cost if wrong: one string to change once Cem picks a license. SUPERSEDED: Cem chose GPL-3.0-or-later; LICENSE added, package.json / Cargo.toml / tauri.conf.json carry it, About reads "License: GPL-3.0-or-later".
- Ruling R13 (= R3/R4 applied): Task 4 adds Rust `app_version()` and a read-only shortcut list with the shortcuts on this branch: Mod+Enter, Mod+Shift+Enter (SqlEditor), Ctrl+T / Ctrl+W (WorkspaceView), plus the new Mod+, (settings) — cost if wrong: list swapped for `DEFAULT_KEYMAP` in Task 6.

### Final fix wave
- Ruling R14 (orchestrator, binding): the editor font family → CSS injection is MUST-FIX: one safe grammar on both sides (comma-separated names of ASCII letters, digits, spaces, `-`, `_`, optionally quoted; 200 chars max; `; { } ( ) : / \ < >` and stray quotes rejected), applied through a CSS custom property instead of built CSS. Showing "Mod" as Ctrl/⌘ per platform is MUST-FIX too. License stays "not chosen yet" — cost if wrong: none (orchestrator decision). Done in this wave: `Settings::clamped` resets only the font field to "" (on load and on `settings_set`, which returns the clamped value rather than an error), the dialog edits it as a draft saved on Enter/blur, the editor reads `--editor-font-family` / `--editor-font-size` set through the CSSOM.

### Task 5 — packaging
- Ruling R15: the AppImage built on this Ubuntu 26.04 host needs glibc 2.43 (bundled WebKitGTK, GLib, GnuTLS…) and does not run on Ubuntu 24.04; the .deb (glibc 2.39) does. Accepted for Plan 5 with both floors in the README and the release check; a portable AppImage needs an older build host or container (CI), out of Task 5's scope — cost if wrong: the v1 AppImage is unusable on 24.04 LTS until such a build exists.

### Final review
- Ruling R16: for an open workspace the backend applies `stricter(effective(saved), effective(opened))`: tightening applies at once, loosening (a looser mode, or a retag away from prod) only at the next workspace open, fail-safe and in line with R6. The banner, the window title and ConfirmRunDialog read the live saved connection (tag + safe mode, falling back to the opened config) and show the same stricter-of mode (`enforcedSafeMode` in `src/lib/safeMode.ts`) — cost if wrong: a user who relaxes a prod connection must reopen its workspace for it to apply.

### Task 6 — Phase B
- Ruling B-R1 (controller): the `editor` shortcut scope lives inside a query tab (the CodeMirror keymap fires first, then the window listener sees the same keydown), so `editor` conflicts with `queryTab` as well as with itself and `global`; `queryTab` and `tableTab` never conflict with each other — cost if wrong: one combination refused that the orchestrator's literal rule would allow.
- Ruling B-R2: the backend `render_preview` (`dml.rs`) writes PostgreSQL literals as `E'…'` / `E'\\x…'`, like the frontend's `quoteString` / `bytesLiteral`, so the confirmation preview reads the same under any `standard_conforming_strings` (cec5bc3) — cost if wrong: none (display only).
- Open: `conflictFor` ignores CodeMirror's built-in keys (Mod+F, Mod+Z, Mod+D…) and Glide's own keys (Ctrl+C / Ctrl+A); a custom binding wins (Prec.highest / capture), so nothing breaks silently, but the built-in stops working.
- Open: Auto LIMIT per-tab overrides are kept in memory only, not in Plan 4's session snapshot (documented choice).
- Open: filtered counts at a high `exact_count_threshold` hold the browse connection without a user-facing cancel (already in `plan-03-followups.md`, "Deferred (Task 8)").

## Deferred minors

### Settings (Task 1, Task 4)
- Task 1: parent directory not fsynced after the atomic rename of settings.json.
- Task 1: a numeric overflow or negative value in settings.json resets ALL fields to the defaults instead of clamping that field (serde fails on the whole struct).
- Task 1: the theme is applied after an async IPC, so one frame of the system theme shows at startup; `main.tsx`'s `load()` is untested.
- Task 1: the settings store's `load()` is not sequenced against an in-flight `update()`; a failed stale update's error is dropped silently.
- Task 4: NumberField saves every intermediate valid value while typing: done in Task 6 (Phase A) (saves on Enter or blur).
- Task 4: ⚙ glyph hard-coded in App.tsx (not in strings.ts).
- Task 4: Mod+, (App.tsx) accepted metaKey on every platform: done in Task 6 (Phase B) (023dc67: `useAction("settings.open")`, Mod = Cmd on macOS and Ctrl elsewhere, not both).
- Task 4: no tests for the dialog reverting after a failed `settings_set`, nor for Mod+, while ConfirmRunDialog is open.
- Final fix wave: the font grammar is ASCII only, so a font whose name has non-ASCII letters (CJK font names…) cannot be set; widen to Unicode letters on both sides if users ask.

### Safe mode (Task 2, Task 3)
- Task 2: MySQL lexers (safety.rs, mysql.rs `has_multiple_statements`) read every digit after `/*!` as the version, where MySQL reads 5–6; fail-safe.
- Task 3: cancelling ConfirmRunDialog dropped the tab's previous results: done in Task 6 (Phase A) (snapshot restored on refusal).
- Task 3: ConfirmRunDialog: window-level Ctrl+T / Ctrl+W fired while it was open, and focus was not restored to the editor: done in Task 6 (Phase B) (023dc67 modal-aware shortcuts; 396553f, ea98060 `useRestoreFocus`). Escape worked only while focus was inside the overlay: done in Task 6 (Phase B) (41abddf: Escape on a `document` listener while mounted).
- Task 3: ConfirmRunDialog's Tab trap still works only while focus is inside the overlay: after a click on a non-focusable area (focus on `<body>`), Tab moves to the first focusable element of the page, possibly behind the dialog. SettingsDialog has the same gap. Global shortcuts stay inert (the dialog is `aria-modal`), so nothing unsafe follows.
- Task 3: ConfirmRunDialog duplicated `ENV_BG`: done in Task 6 (Phase A) (shared `src/features/workspace/envClasses.ts`).
- Task 3: `useWindowTitle` swallows `windowSetTitle` errors silently.
- Final review (nit): `classify` is skipped when the mode is Off or ConfirmAll (fine today; matters only if classification gets other uses).
- Final fix wave: the 2px workspace border under the banner (WorkspaceView `ENV_BORDER`) used the tag the workspace was opened with while the banner shows the live tag: done in Task 6 (Phase A) (border and switcher dot use `useLiveEnv`).

### UI shell
- Final review: double `border-b` between the App.tsx top bar and WorkspaceSwitcher.
- Task 4: window-level Ctrl+T / Ctrl+W and Mod+, fired while a modal (Settings, ConfirmRunDialog) was open; focus was not restored on close: done in Task 6 (Phase B) (023dc67, 857a2e8; 396553f, ea98060).

### Packaging (Task 5)
- Task 5: the .deb package is named `table-max` while the command is `tablemax` (documented in the README).
- Task 5: the .deb copyright line names an individual (Cem Yildirim); owner to confirm.
- Task 5: identifier `dev.tablemax.app` ends in `.app` (Tauri warning); changing it moves the data directory, so it needs a migration plan.
- Task 5: the AppImage build downloads linuxdeploy unpinned from GitHub; the `gen-icons.sh` header does not mention the pnpm / dev dependencies it needs.
- Final review: tauri bundle targets are Linux-only; the macOS / Windows port needs its own targets.

## Task 6 checklist (after the rebase on Plans 3 and 4)
- Done in Task 6 (Phase A): grid Commit (`changes_apply`) goes through the same `confirmed` guard as `execute_batch`: `safety::{effective_safe_mode, needs_confirmation}` with the R16 stricter-of-saved-and-opened resolution (`workspace_safe_mode`), refusing with `ConfirmationRequired` before any statement runs, and the dialog shows the SQL that will run.
- Done in Task 6 (Phase B): modal-aware global shortcuts with focus restore: Ctrl+W pressed under Settings no longer closes the query tab behind it; Ctrl+T / Ctrl+W / Mod+, are ignored while a modal is open, and focus returns to where it was on close (023dc67, 857a2e8, 396553f, ea98060).
- Done in Task 6 (Phase A): NumberField saves on blur/Enter; page size and exact count threshold wired to the grid.
- Done in Task 6 (Phase A): the tab's query results are restored when the confirmation dialog is cancelled.
- Done in Task 6 (Phase B): the local shortcut list (`src/features/settings/shortcuts.ts`) is replaced by Plan 4's `DEFAULT_KEYMAP`, with one `formatShortcut` and its platform modifier names (a5f56d9, 06c4db2); the Keyboard section edits it (e1198b2, 748e82b; final review fixes 8b08976: Reset refuses a conflicting default, conflicts checked on both platforms, Shift alone is not a modifier, Meta reads Super outside macOS).

## Open questions for Cem
- AppImage glibc 2.43 floor: it does not run on Ubuntu 24.04 LTS; a portable build needs an older build host or a CI container. Worth setting up before v1?
- Identifier `dev.tablemax.app` ends in `.app` (Tauri warns): change it now (moves the data directory) or keep it?
- Package name `table-max` (deb) vs command `tablemax`: align them?

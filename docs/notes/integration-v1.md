# Integration v1 — plans 3, 4, 5 and the team workflow

Branch `integration/v1` (worktree `.worktrees/integration`), 2026-10-17. Rehearsed first on
`wip/integration-dryrun` (its `docs/notes/integration-dryrun.md` holds the conflict tables
and the integration rules; this note records what differed and what was fixed).

| Step | Merged | Head | Conflicts |
|---|---|---|---|
| base | `feat/plan-03-data` | 923dfc2 | — |
| 1 | `feat/team-workflow` | 711d7a5 | none |
| 2 | `feat/plan-05-safety` | 0d1ff9c | 6 files |
| 3 | `feat/plan-03-data` (fix wave) | 76082b3 | none |
| 4 | `feat/plan-04-navigation` | d3aa06a | 23 files |
| 5 | `fix/plan-04-review` | 922f9ee | 4 files |

## New since the rehearsal

- Plan 3's structure view imported `usePrefersDark` from `SqlEditor`, which plan 5 removes:
  the DDL editor uses `useResolvedDark` (follows `data-theme`, not only the OS).
- `mysql.rs`: plan 4 rewrote the multi-statement lexer (tokens, compound bodies), plan 5
  reads executable comments both ways. Kept both: `lex(.., exec_as_comment)`, and
  `has_multiple_statements` ORs the two readings through plan 4's statement model; an
  executable comment disables the compound tracker in both readings. Both unit suites and
  `tests/mysql_compound.rs` are kept.
- `stores/workspaces.ts`: plan 3 gained `isCommitting`, `navigateTableTab` and a
  whole-workspace close confirmation; plan 4 gained connect-in-place for restored
  workspaces. `doCloseWorkspace` carries plan 4's placeholder / `connectRequest` handling.
- `SqlEditor.test.ts` was renamed `.tsx` by plan 5; plan 4's undo test moved into it.
- Plan 4's `tests/mysql_compound.rs` also needed `safe_mode` and `confirmed`.

## Semantic fixes (each with tests)

1. **Database switch × table metadata** (`manager.rs`): `switch_database` clears
   `table_info`, bumps `table_info_gen` and resets `browse_lost`. The browse rebuild (plan 3
   fix wave: any lost connection) reads the switched database under the slot lock, and a
   rebuild that would change it clears the metadata. PG integration test
   `pg_switch_database_refreshes_table_info_and_rebuilds_on_the_new_database`
   (`tests/catalog.rs`): same `schema.users` with other columns and key in two databases;
   switch, kill the browse backend, rebuild, switch back.
2. **Database switch × pending changes** (`workspaces.ts`): `switchDatabase` rejects
   (`invalid`, `strings.workspace.switchDatabasePending`) before calling the backend.
3. **Preview tab × edits** (`workspaces.ts`): a pending change pins a preview tab; filters
   and foreign key navigation already pin it through the grid view (tests for all three).
4. **`data-theme="dark"` × pending colours** (`tokens.css`): the three `--pending-*` tokens;
   `src/styles/tokens.test.ts` checks both dark blocks override the same tokens.
5. Mod+S commit rewritten with `useShortcut`, gated on `connected` and the cell editor.
6. **MySQL cancel race** (`mysql.rs`, product bug behind the flaky cancel tests): an
   interrupted `SLEEP()` row could reach the session before the canceller recorded the
   delivered KILL, so Cancel showed a result. The canceller settles each attempt before
   disconnecting; a statement that returns while a cancel was requested awaits it
   (bounded). Stress test `mysql_cancel_reported_even_when_the_result_beats_the_kill_reply`.
7. **Review wave × earlier plans** (`mysql.rs`): the session re-read after every statement
   runs after the cancel outcome is settled; the dollar-quote refusal checks both readings
   of executable comments (plan 5); grid commits (`apply`, plan 3) go through the same
   session guard (unknown state, unsafe client charset).

## Left for plan 5 Task 6

- Grid commits (`changes_apply`, from the grid, row details and pending panel) bypass safe
  mode (`src-tauri/CLAUDE.md` asks every write path to go through the guard).
- Settings not consumed yet: `pageSize`, `exactCountThreshold`, `autoLimitDefault` /
  `autoLimitValue` (plan 4 `AUTO_LIMIT_ROWS`), `keymap`; the structure view's DDL editor
  ignores the editor font settings (`editorFontStyle`).
- `ConfirmRunDialog` lists the statements as typed; with Auto LIMIT on, the confirmed run
  sends them with `LIMIT` appended.
- Raw `keydown` listeners on `e.key` (plan 5 Mod+,; plan 3 Alt+1/2, Alt+←, Ctrl+I) next to
  plan 4's `useShortcut` (`e.code`); two platform helpers (`lib/platform.ts`,
  `lib/shortcuts.ts`). All check the same `aria-modal` marker.

Follow-ups: pending changes are not in plan 4's session snapshot and nothing asks before
quitting with some; a SQL session opened while a switch runs may land on the old database
(`open_sql_session` reads it without the slot lock).

Final polish: CI should run `cargo clippy --all-targets -- -D warnings` (the review wave
made it pass; `pnpm lint` and CI still run clippy without `--all-targets`).

## Results (head after the fixes)

`pnpm install --frozen-lockfile`, `pnpm test` (76 files, 740 tests), `pnpm lint`,
`cargo clippy --all-targets -- -D warnings`, `pnpm test:rust` on project
`tablemax-test-int` (417 passed, 2 ignored; `mysql_driver` 10 consecutive runs green),
hook / bootstrap / secret checks: all green.

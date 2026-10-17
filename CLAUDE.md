# TableMax — rules for Claude agents

TableMax is a free, fast desktop database client (PostgreSQL, MySQL, MariaDB, SQLite) built
with Tauri 2, React 19 + TypeScript and Rust. Linux first (Ubuntu, Wayland), code kept
portable to macOS and Windows. Three developers work on it, each with Claude Code agents:
the work lives in GitHub issues, one issue per branch, worktree and pull request.

**This project does not use Azure DevOps or Ticky.** Tickets are GitHub issues in
`Cemoche/tablemax`, handled with `gh`. The integration branch is `main` (not `develop`).
Any global rule about Azure DevOps, Ticky, `develop` or Husky hooks does not apply here.

## Repository map

- `src/` — React frontend (rules: `src/CLAUDE.md`).
- `src-tauri/` — Rust backend and Tauri app (rules: `src-tauri/CLAUDE.md`).
- `docs/superpowers/specs/` — design spec: `2026-10-16-tablemax-design.md` (goals, non-goals, anti-goals).
- `docs/superpowers/plans/` — implementation plans, one per milestone (`### Task N` sections).
- `docs/research/` — background research (TablePlus behaviour, `.tableplusconnection` format).
- `docs/notes/` — plan follow-ups (`plan-NN-followups.md`) and manual checks (`plan-NN-manual-check.md`).
- `scripts/` — `test-dbs.sh`, `test-secrets.sh`, `demo-db.sh`.
- `tests/docker/` — test container files (PostgreSQL TLS entrypoint, test sshd).
- `docker-compose.test.yml` — test databases and sshd.

## Commands

```bash
pnpm install                   # dependencies
pnpm dev                       # run the app (tauri dev)
pnpm test                      # frontend tests (vitest)
pnpm lint                      # tsc --noEmit + cargo clippy -D warnings
pnpm test:rust                 # starts the test databases, then cargo test
pnpm demo:db                   # seeds a demo database and registers demo connections
scripts/test-dbs.sh up|down|env  # test containers; `env` prints the TABLEMAX_TEST_* exports
```

Two checkouts running `pnpm test:rust` at the same time need their own compose project
and ports: see README.md, "Two worktrees side by side".

## Definition of done

- `pnpm test && pnpm lint` green.
- `pnpm test:rust` green when `src-tauri/`, `docker-compose.test.yml`, `tests/docker/` or
  the test scripts changed.
- New behaviour has tests (TDD for bugs: a failing test first).
- UI changes: manual verification notes (what you clicked, what you saw) in the PR, and
  screenshots when the change is visible.
- No user-visible string outside `src/lib/strings.ts`; no secret in any committed file.

## Workflow (issue → branch → worktree → PR)

1. **Take an issue** with `/pick-issue [filter]`: it lists open `status:ready` issues with
   no assignee, assigns you, swaps `status:ready` for `status:in-progress` and re-reads the
   issue to back off if someone else got it first. By hand:
   `gh issue edit <n> --add-assignee @me --add-label status:in-progress --remove-label status:ready`.
   Do this **before** writing any code. **Never take an issue that already has an assignee.**
2. **Work in a worktree**, never in the main checkout: `claude --worktree issue-<n>` (creates
   `.claude/worktrees/issue-<n>/` on branch `worktree-issue-<n>`, from a fresh `origin/main`).
3. **`/work-issue <n>`**: renames or creates the branch `issue-<n>-<slug>`, checks the assignment,
   reads the issue and its linked plan/spec, then does the work (see Superpowers below).
4. **`/ship`**: re-runs the checks, pushes the branch, opens or updates the PR to `main`
   with `Closes #<n>`, sets `status:review`. It never merges.
5. A teammate reviews; **the owner merges**. Agents never merge.

- `/plan-to-issues <plan-file> [--dry-run] [--assign-me]` turns a plan's `### Task N`
  sections into issues (one per task, no duplicates).
- One issue = one branch `issue-<n>-<slug>` = one worktree = one PR containing `Closes #<n>`.
- **Only the assignee pushes to an issue branch.** Never push to `main`, never
  `--force` someone else's branch, never commit on `main`.
- The repo is private on a free plan: GitHub has no branch protection here. These rules
  are enforced by convention, by `.claude/settings.json` (permissions, hooks:
  `block-main-edits.sh` refuses edits on `main`/`master`, `session-context.sh` prints the
  branch and its issue) and by an informative CI (`.github/workflows/ci.yml`).
- Labels: `type:task|bug|epic|chore`, `status:triage|ready|in-progress|review|blocked`,
  `area:frontend|backend|infra|docs|security`, `size:S|M|L`, `plan:3|4|5`, `post-v1`,
  `good first issue`. Keep `status:*` current (one at a time); `status:blocked` + a comment
  saying on what.
- Scope creep: out-of-issue findings become a new issue (issue form or `gh issue create`),
  not extra commits.

## Commits

Format `<emoji> <type>(<scope>): <description>`, e.g. `🐛 fix(ssh): re-ask a rejected passphrase`.

| ✨ feat | 🐛 fix | 🏗️ refactor | 🔥 chore | 📝 docs | ✅ test | 🎨 style | ⚡ perf | ⏪ revert | 🔒 security |
|---|---|---|---|---|---|---|---|---|---|

Small commits, local until `/ship`. Stage files by name (no `git add -A` of unrelated files).

## Security and copy rules (spec §4)

- Secrets (DB passwords, SSH passwords, key passphrases) live **only** in the OS keyring
  (or are asked at each connect). Never on disk, in logs, in error messages or sent back
  to the frontend after saving.
- Nothing from TablePlus: no code, name, icon or asset. Reading its export format for
  import is interoperability (see `docs/research/`), not copying.
- No remote content in the app; Tauri capabilities (`src-tauri/capabilities/`) stay minimal
  — add a permission only when a feature needs it, and say why in the PR.
- The UI never freezes: database I/O is async and cancellable, grids are virtualized.
- No write to a `prod`-tagged database without confirmation when safe mode is on.
- Committed files hold no real token or password. The test passwords `tablemax`,
  `tunnel-pass` and `fixture-pass` are fake and documented; generated keys and certs go to
  `.test-secrets/` (gitignored).

## Superpowers plugin (recommended)

Enabled at project scope in `.claude/settings.json`; install it once per machine:
`claude plugin install superpowers@claude-plugins-official --scope project`.
For non-trivial work: `superpowers:brainstorming` → `superpowers:writing-plans` (plan in
`docs/superpowers/plans/`) → `superpowers:subagent-driven-development`. Small issues: TDD
directly (`superpowers:test-driven-development`).

## Where to look

- What to build and why: the spec, then the plan linked from the issue (or its epic).
- Plans done: `2026-10-16-tablemax-01-foundations.md`, `2026-10-17-tablemax-02-connections.md`,
  `2026-10-17-tablemax-team-setup.md`. Next: Plan 3 (Data), 4 (Tabs & editor),
  5 (Safety & packaging) — one milestone and epic issue each.
- Deferred work: `docs/notes/plan-0*-followups.md` (also filed as issues).
- Human onboarding and setup: `CONTRIBUTING.md`.
- Personal, untracked overrides: `CLAUDE.local.md`, `.claude/settings.local.json`.

## Language

UI text, code, comments, commit messages and these rules: English. Plans and notes may be
in French.

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

## Workflow (issue → branch → PR), manual for now

1. **Claim an issue** by assigning yourself, **before** writing any code:
   `gh issue edit <n> --add-assignee @me`. The assignment is the only claim (no status
   labels yet). **Never take an issue that already has an assignee**; re-read it after
   assigning (`gh issue view <n>`) and back off if someone else is on it too.
2. **One branch per issue**, `issue-<n>-<slug>`, from an up-to-date `origin/main`. A
   worktree is recommended so parallel work never shares a checkout:
   `git fetch origin && git worktree add -b issue-<n>-<slug> .worktrees/issue-<n> origin/main`
   (`.worktrees/` is gitignored), or `claude --worktree issue-<n>` (creates
   `.claude/worktrees/issue-<n>/` on branch `worktree-issue-<n>`: rename it with
   `git branch -m issue-<n>-<slug>`).
3. Read the issue and its linked plan/spec, do the work (see Superpowers below), meet the
   Definition of done.
4. **Push your branch and open a PR to `main`**: `git push -u origin issue-<n>-<slug>`, then
   `gh pr create --base main` with the body of `.github/pull_request_template.md`
   (`Closes #<n>`, test commands and output).
5. A teammate reviews; **the owner merges**. Agents never merge.

- One issue = one branch = one PR containing `Closes #<n>`.
- **Only the assignee pushes to an issue branch.** Never push to `main`, never
  `--force` someone else's branch, never commit on `main`.
- The repo is private on a free plan: GitHub has no branch protection here, and no hook or
  CI checks these rules yet. They hold **by convention only**.
- Scope creep: out-of-issue findings become a new issue (issue form or `gh issue create`),
  not extra commits.

## Commits

Format `<emoji> <type>(<scope>): <description>`, e.g. `🐛 fix(ssh): re-ask a rejected passphrase`.

| ✨ feat | 🐛 fix | 🏗️ refactor | 🔥 chore | 📝 docs | ✅ test | 🎨 style | ⚡ perf | ⏪ revert | 🔒 security |
|---|---|---|---|---|---|---|---|---|---|

Small commits, local until you push the branch. Stage files by name (no `git add -A` of unrelated files).

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

Each developer installs it once: `claude plugin install superpowers@claude-plugins-official`
(user scope by default). Do not use `--scope project`: it writes the tracked
`.claude/settings.json`, which does not exist yet (see Planned team workflow).
For non-trivial work: `superpowers:brainstorming` → `superpowers:writing-plans` (plan in
`docs/superpowers/plans/`) → `superpowers:subagent-driven-development`. Small issues: TDD
directly (`superpowers:test-driven-development`).

## Where to look

- What to build and why: the spec, then the plan linked from the issue.
- Plans done: `2026-10-16-tablemax-01-foundations.md`, `2026-10-17-tablemax-02-connections.md`.
  Partly done, rest postponed: `2026-10-17-tablemax-team-setup.md` (only its Task 1, these
  rules, is in place). Next: Plan 3 (Data), 4 (Tabs & editor), 5 (Safety & packaging).
- Deferred work: `docs/notes/plan-0*-followups.md`.
- Human onboarding and setup: `CONTRIBUTING.md`.
- Personal, untracked overrides: `CLAUDE.local.md`, `.claude/settings.local.json`.

## Planned team workflow (not set up yet)

Postponed with the rest of the team-setup plan. **None of this exists yet: do not call
these skills, rely on these hooks or labels, or wait for this CI.**

- Shared `.claude/settings.json`: permissions, hooks (`block-main-edits.sh` refusing edits
  on `main`/`master`, `session-context.sh` printing the branch and its issue), superpowers
  enabled at project scope, `worktree.baseRef: "fresh"`.
- Skills: `/pick-issue [filter]` (claim a ready issue, race-safe), `/work-issue <n>`,
  `/ship` (checks, push, PR, `status:review`), `/plan-to-issues <plan-file> [--dry-run]
  [--assign-me]` (one issue per `### Task N`).
- Labels `type:*`, `status:*`, `area:*`, `size:*`, `plan:*`, `post-v1`, `good first issue`,
  milestones, epics and a board; the issue forms get default labels once these exist.
- CI `.github/workflows/ci.yml` (frontend, backend with test databases, hygiene).

## Language

UI text, code, comments, commit messages and these rules: English. Plans and notes may be
in French.

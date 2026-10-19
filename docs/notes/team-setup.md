# Team setup — what is in the repo, what GitHub still needs

Plan: `docs/superpowers/plans/2026-10-17-tablemax-team-setup.md`. Branch `feat/team-workflow`.

## In the repository (live once this branch is merged)

| Piece | Where | Checked by |
|---|---|---|
| Shared Claude Code settings: permissions, hooks, superpowers enabled, `worktree.baseRef: fresh` | `.claude/settings.json` | `jq`, review |
| Hook refusing file edits and `git commit`/`cherry-pick`/`revert`/`am` on a `main`/`master` checkout of this repo (gitignored files and other repos allowed) | `.claude/hooks/block-main-edits.sh` | `bash scripts/test-claude-hooks.sh` |
| Hook giving each session its branch and issue (issue title marked as untrusted data) | `.claude/hooks/session-context.sh` | same |
| Skills `/pick-issue`, `/work-issue`, `/ship`, `/issue-comment`, `/plan-to-issues`, `/new-issue` (free-text description → issue in the form's sections, on the board) | `.claude/skills/*/SKILL.md` | `gh` flags checked against `gh <cmd> --help` (gh 2.94) |
| Plan → issues script | `scripts/plan-to-issues.mjs` | `scripts/plan-to-issues.test.mjs` (in `pnpm test`) |
| CI: frontend, backend (clippy `--all-targets` + cargo test on the test databases), hygiene | `.github/workflows/ci.yml` | actionlint 1.7.7, YAML parse; **not run on GitHub yet** |
| Secret scan of tracked files | `scripts/check-no-secrets.sh` (+ `.allow`) | run on the repo and on a throwaway repo with planted tokens |
| GitHub bootstrap | `scripts/github-bootstrap.sh` | `bash scripts/test-github-bootstrap.sh` (fake `gh`), `--dry-run` against the real repo |
| Default labels in the issue forms (`type:task` + `status:ready`, `type:bug` + `status:triage`) | `.github/ISSUE_TEMPLATE/*.yml` | YAML parse |

Permissions: the allow list holds only exact or read-only command forms (plus
`gh issue comment` / `gh pr comment`); `git push`, `gh issue create|edit|close`,
`gh pr create|edit|merge|close` and `git worktree remove` ask first; force
pushes, pushes to `main`, `gh pr merge --admin`, issue deletion/transfer, `gh auth token`,
git transport/output options and reading `.env` are denied.

## On GitHub — nothing created yet

`bash scripts/github-bootstrap.sh --dry-run` (2026-10-17, repo `Cemoche/tablemax`, which had
no issue and no custom label) lists **59 items**; only `good first issue` already exists:

- **21 labels**: `type:{task,bug,epic,chore}`, `status:{triage,ready,in-progress,review,blocked}`,
  `area:{frontend,backend,infra,docs,security}`, `size:{S,M,L}`, `plan:{3,4,5}`, `post-v1`.
- **4 milestones**: `Plan 3 — Data`, `Plan 4 — Tabs & editor`, `Plan 5 — Safety & packaging`, `Post-v1`.
- **3 plan epics, created then closed as completed** (`type:epic`, `plan:N`, assigned to
  `Cemoche`, in their milestone): the bootstrap runs once Plans 3, 4 and 5 are implemented and
  pushed. Decision: keep them (closed) rather than skip them — they cost nothing on the open
  board and record, per milestone, the plan file, the branch and how to find its PR.
- **17 post-v1 epics** (`type:epic`, `post-v1`, `status:triage`, milestone `Post-v1`): SQL
  Server, Redis, MongoDB, ClickHouse drivers; ER diagrams; metrics boards; AI chat; file
  import/export; backup/restore; users and privileges; process list; structure editing; split
  view; multiple windows; automatic updates; macOS and Windows packaging — each with context
  and dependencies (e.g. Redis/MongoDB need a "capabilities" layer on the `Session` trait).
- **14 follow-up tasks** from `docs/notes/plan-0*-followups.md` (no milestone, all
  `status:ready`, each with its file pointers):
  - on files Plans 3–5 did not touch: SSH config parsing edge cases; known_hosts multi-file
    false alarm; SSH tunnel robustness; TLS error path and blocking reads; portable integration
    tests; URL import/export edge cases; URL dialog shows the password; TablePlus import dialog
    race and parsing. Five carry `good first issue`.
  - on files Plans 3–5 rewrote (the body says to re-check each item against the merged code
    first): lint of the Vite/Vitest configs and Rust tests; PostgreSQL, MySQL/MariaDB and
    SQLite driver edge cases; SessionManager close/cancel/keyring; grid display minors.
  - Not filed: Plan 1 Task 9/11 minors (shortcuts, tab a11y, splitter) were in Plan 4's scope;
    Cargo.toml comments, icons and the release check in Plan 5's. Check those plans' own
    follow-up notes.

Board: the token has no `project` scope, so `--project` only prints how to get it. With the
scope (`gh auth refresh -s project`), `bash scripts/github-bootstrap.sh --project` creates the
user project "TableMax", adds a single-select field **Stage** (Triage, Ready, In progress,
Review, Done), links it to the repo and adds every open issue. The `status:*` labels stay the
source of truth (the skills set them); the Stage field is not synced automatically.

## Order of operations (owner / orchestrator)

1. Plans 3–5 implemented and pushed, PRs open (no merge by agents); this branch sits on
   `feat/team-setup`.
2. `bash scripts/github-bootstrap.sh --dry-run`, then `bash scripts/github-bootstrap.sh`
   (re-running it creates nothing new). Until it runs, the skills skip their `status:*` label
   steps and `/pick-issue` lists every unassigned open issue.
3. Optional board: `gh auth refresh -s project`, then `bash scripts/github-bootstrap.sh --project`.
4. Watch the first CI run on the pushed branch (`gh run watch`) and fix what a fresh runner
   reveals (system packages, Docker build of the test sshd, Rust 1.96 toolchain).
5. Each teammate once: `gh auth login`, `claude plugin install superpowers@claude-plugins-official --scope project`
   (the project enables it but does not download it), then trust the folder in Claude Code.

## Known limits and open points

- Private repo on a free plan: no branch protection, no required checks. The hooks, the
  permission rules and the skills carry the discipline; CI is informative.
- **Known cost, kept on purpose:** CI runs on every push to a non-`main` branch **and** on
  pull requests to `main`, so a push to a branch with an open PR runs the workflow twice (once
  per event: the branch alone, then the merge result). The backend job (Tauri system packages,
  Rust build, four containers) is the expensive one on the private repo's Actions minutes; if
  minutes run short, drop one trigger or run the backend job on `pull_request` only.
- Collaborators: `jerembdn` is invited; the second teammate's GitHub login is not known yet.
- `/pick-issue` settles a simultaneous claim by the current assignees' latest `assigned`
  events (earliest wins; the jq rule was tested on sample events, the GitHub path was reviewed,
  not exercised: no writes allowed while setting up). The loser has not labelled or commented
  yet, so backing off is a single unassign.

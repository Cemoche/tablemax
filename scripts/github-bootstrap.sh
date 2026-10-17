#!/usr/bin/env bash
# Set up the TableMax GitHub repository for team work: labels, milestones, epics (plans 3–5
# and post-v1 features), follow-up issues from docs/notes/plan-0*-followups.md, and
# optionally a Projects board. Idempotent: what already exists (same label name, milestone
# title or issue title, open or closed) is left as is, so it can be re-run safely.
#
# Usage: bash scripts/github-bootstrap.sh [--dry-run] [--project]
#   --dry-run   read GitHub only and print what would be created (no write at all)
#   --project   also create/fill the "TableMax" board (needs: gh auth refresh -s project)
#
# Run from the repository (gh uses the current repo). Only the repository owner runs it.
set -euo pipefail

DRY_RUN=0
WITH_PROJECT=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --project) WITH_PROJECT=1 ;;
    -h | --help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
command -v gh >/dev/null || { echo "gh is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

OWNER="Cemoche"            # repository owner: epics of the plans their agents run
PROJECT_TITLE="TableMax"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
created=0
existing=0

# ------------------------------------------------------------------ current state (read only)

READ_OK=1
if ! gh label list --limit 500 --json name --jq '.[].name' >"$TMP/labels" 2>"$TMP/err" ||
  ! gh api --paginate 'repos/{owner}/{repo}/milestones?state=all&per_page=100' --jq '.[].title' >"$TMP/milestones" 2>>"$TMP/err" ||
  ! gh issue list --state all --limit 1000 --json title --jq '.[].title' >"$TMP/issues" 2>>"$TMP/err"; then
  if [[ $DRY_RUN -eq 0 ]]; then
    echo "cannot read the repository with gh (gh auth login?):" >&2
    cat "$TMP/err" >&2
    exit 1
  fi
  READ_OK=0
  : >"$TMP/labels"; : >"$TMP/milestones"; : >"$TMP/issues"
fi

if [[ $DRY_RUN -eq 1 ]]; then
  echo "DRY RUN — nothing is written to GitHub."
  [[ $READ_OK -eq 1 ]] || echo "(GitHub not readable: everything is shown as missing; $(head -1 "$TMP/err"))"
fi

has() { grep -Fxq -- "$2" "$TMP/$1"; } # has <labels|milestones|issues> <exact text>

# ------------------------------------------------------------------ ensure_* helpers

ensure_label() { # name color description
  if has labels "$1"; then
    existing=$((existing + 1))
    return
  fi
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "would create label      $1"
  else
    gh label create "$1" --color "$2" --description "$3" >/dev/null
    echo "created label           $1"
  fi
  echo "$1" >>"$TMP/labels"
  created=$((created + 1))
}

ensure_milestone() { # title description
  if has milestones "$1"; then
    existing=$((existing + 1))
    return
  fi
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "would create milestone  $1"
  else
    gh api -X POST 'repos/{owner}/{repo}/milestones' -f title="$1" -f description="$2" --silent
    echo "created milestone       $1"
  fi
  echo "$1" >>"$TMP/milestones"
  created=$((created + 1))
}

ensure_issue() { # title labels milestone(or "") assignee(or "") [closed] ; body on stdin
  # With "closed", a newly created issue is closed at once as completed (finished plans).
  local title="$1" labels="$2" milestone="$3" assignee="$4" state="${5:-open}" body
  body="$(cat)"
  if has issues "$title"; then
    existing=$((existing + 1))
    return
  fi
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "would create issue      $title"
    echo "                        labels: $labels${milestone:+ · milestone: $milestone}${assignee:+ · assignee: $assignee}${5:+ · then closed as completed}"
  else
    local args=(issue create --title "$title" --body-file -)
    [[ -z $milestone ]] || args+=(--milestone "$milestone")
    local l
    IFS=',' read -ra _labels <<<"$labels"
    for l in "${_labels[@]}"; do args+=(--label "$l"); done
    [[ -z $assignee ]] || args+=(--assignee "$assignee")
    local url # on its own line: a failing gh inside echo "$(…)" would not stop set -e
    url="$(printf '%s' "$body" | gh "${args[@]}")"
    echo "created issue           $url  $title"
    if [[ $state == closed ]]; then
      gh issue close "$url" --reason completed >/dev/null
      echo "closed as completed     $url"
    fi
  fi
  echo "$title" >>"$TMP/issues"
  created=$((created + 1))
}

# ------------------------------------------------------------------ labels

echo "== Labels"
ensure_label "type:task" "1d76db" "A unit of work: one branch, one PR"
ensure_label "type:bug" "d73a4a" "Something does not work as it should"
ensure_label "type:epic" "5319e7" "A group of issues: a plan or a post-v1 feature"
ensure_label "type:chore" "cfd3d7" "Tooling, CI, docs housekeeping"
ensure_label "status:triage" "fbca04" "To be discussed and sized before anyone takes it"
ensure_label "status:ready" "0e8a16" "Ready to take: assign yourself with /pick-issue"
ensure_label "status:in-progress" "0052cc" "Someone is on it (see the assignee)"
ensure_label "status:review" "c5def5" "A pull request waits for review"
ensure_label "status:blocked" "b60205" "Waiting on another issue, plan or decision"
ensure_label "area:frontend" "bfdadc" "React UI (src/)"
ensure_label "area:backend" "d4c5f9" "Rust backend (src-tauri/)"
ensure_label "area:infra" "c2e0c6" "CI, scripts, test containers, Claude Code config"
ensure_label "area:docs" "e6e6e6" "Docs, plans, notes"
ensure_label "area:security" "ee0701" "Secrets, TLS, SSH, permissions"
ensure_label "size:S" "ededed" "Under half a day"
ensure_label "size:M" "d9d9d9" "About a day"
ensure_label "size:L" "bdbdbd" "Several days: consider splitting"
ensure_label "plan:3" "5319e7" "Plan 3 — Data"
ensure_label "plan:4" "5319e7" "Plan 4 — Tabs & editor"
ensure_label "plan:5" "5319e7" "Plan 5 — Safety & packaging"
ensure_label "post-v1" "f9d0c4" "Planned after v1 (spec §3)"
ensure_label "good first issue" "7057ff" "Small, well-bounded: a good way into the code"

# ------------------------------------------------------------------ milestones

echo "== Milestones"
M3="Plan 3 — Data"
M4="Plan 4 — Tabs & editor"
M5="Plan 5 — Safety & packaging"
MP="Post-v1"
ensure_milestone "$M3" "Inline editing, pending changes, filters, FK navigation, row detail, copy, structure view"
ensure_milestone "$M4" "Preview tab, MRU, tab search, session restore, command palette, SQL completion, history"
ensure_milestone "$M5" "Safe mode, environment tint, settings, keymap, theme, Linux packaging"
ensure_milestone "$MP" "Spec §3: planned after v1"

# ------------------------------------------------------------------ plan epics
# Plans 3–5 are implemented on their branches before this script runs: their epics are
# created closed (completed), as a record linking each milestone to its plan and PR.

echo "== Plan epics (created closed: the plans are implemented)"
PLANS_URL="docs/superpowers/plans"
plan_epic() { # number title plan-file branch labels ; scope on stdin
  local scope
  scope="$(cat)"
  ensure_issue "[Epic] Plan $1 — $2" "type:epic,plan:$1,$5" "Plan $1 — $2" "$OWNER" closed <<EOF
Plan: \`$PLANS_URL/$3\`.
Implemented in branch \`$4\`, see its PR (\`gh pr list --head $4 --state all\`).

$scope
EOF
}

plan_epic 3 "Data" "2026-10-17-tablemax-03-data.md" "feat/plan-03-data" "area:frontend,area:backend" <<'EOF'
Scope (spec §2 "Données (grille)" and "Structure"): inline editing (cell, insert, delete,
duplicate) with a pending-changes panel and its SQL, commit in one transaction (Ctrl+S) or
discard; read-only tables without a primary key or unique index; foreign-key navigation with a
breadcrumb; filter builder and quick filter bar; row detail panel; copy as TSV/CSV/JSON/INSERT;
read-only Structure view (columns, indexes, foreign keys, DDL).
EOF

plan_epic 4 "Tabs & editor" "2026-10-17-tablemax-04-navigation.md" "feat/plan-04-navigation" "area:frontend,area:backend" <<'EOF'
Scope (spec §2 "Navigation" and "Éditeur SQL"): preview tab, Ctrl+Tab in MRU order, search
among open tabs, session restore, object sidebar with routines and database switch, command
palette (Ctrl+K / Ctrl+P), SQL completion, formatting, comment toggle, auto LIMIT, history,
saved queries, `DELIMITER` and compound bodies for MySQL.
Plan 1 minors it was to cover (`docs/notes/plan-01-followups.md`, Tasks 9 and 11): shortcuts
on `e.key`, tablist a11y, splitter edge cases — check the plan's own follow-up notes for what
is left.
EOF

plan_epic 5 "Safety & packaging" "2026-10-17-tablemax-05-safety.md" "feat/plan-05-safety" "area:frontend,area:backend,area:security" <<'EOF'
Scope (spec §2 "Sécurité par environnement / Safe mode" and "Réglages"): safe mode levels per
connection (prod defaults to confirming writes), also on grid Commit with the SQL shown;
environment colour on the workspace border and title bar; settings (theme, editor font, page
size, estimated-count threshold, auto LIMIT, keymap); Linux packaging (.deb, AppImage) with an
original icon and a release-build check.
EOF

# ------------------------------------------------------------------ post-v1 epics (spec §3)

echo "== Post-v1 epics"
post_v1() { # title area ; body on stdin
  ensure_issue "[Post-v1] $1" "type:epic,post-v1,status:triage,$2" "$MP" ""
}

post_v1 "SQL Server driver" "area:backend" <<'EOF'
Add Microsoft SQL Server as a driver (spec §3). Likely crate: `tiberius` (pure Rust); TLS must
stay on rustls with the `ring` provider (never `aws-lc`, see `src-tauri/CLAUDE.md`).
Needs: schemas, pagination with `OFFSET … FETCH`, cancellation (attention packet), a test
container in `docker-compose.test.yml` + a URL in `scripts/test-dbs.sh`.
Depends on: the `Session` trait as it stands after Plan 3 (metadata, parameterized queries).
EOF

post_v1 "Redis driver" "area:backend,area:frontend" <<'EOF'
Browse and edit Redis keys (spec §3). Redis is not relational: no schemas, tables or SQL.
Depends on: a "capabilities" layer on the `Session` trait so the UI can show a key browser
instead of the table grid and SQL editor (the first non-relational driver designs it; MongoDB
reuses it).
EOF

post_v1 "MongoDB driver" "area:backend,area:frontend" <<'EOF'
Browse collections and documents (spec §3). Documents are JSON-like, not rows: the grid needs a
document view, filters are queries, not SQL.
Depends on: the "capabilities" layer on the `Session` trait (see the Redis epic) and the row
detail / JSON view from Plan 3.
EOF

post_v1 "ClickHouse driver" "area:backend" <<'EOF'
Add ClickHouse (spec §3), likely over its HTTP interface. Mostly read-only analytics: no
transactions and limited UPDATE/DELETE, so grid editing must be disabled or adapted (the
capabilities layer from the Redis epic helps). Needs a test container.
EOF

post_v1 "ER diagrams" "area:frontend" <<'EOF'
Show tables and their foreign keys as an entity-relationship diagram (spec §3).
Depends on: table metadata and foreign keys from Plan 3 (`TableInfo`). Rendering must stay
local (no remote content, spec §4).
EOF

post_v1 "Metrics boards" "area:frontend,area:backend" <<'EOF'
Dashboards of charts fed by saved queries, refreshed on demand (spec §3).
Depends on: saved queries (Plan 4). Needs a chart library chosen with bundle size in mind.
EOF

post_v1 "AI chat" "area:frontend,area:backend,area:security" <<'EOF'
Ask questions about the schema or generate SQL with an AI model (spec §3).
Constraints (spec §4): no remote content by default — opt-in per connection, the API key in the
OS keyring, a clear view of what is sent (schema only vs data), never sent for `prod`-tagged
connections without confirmation.
EOF

post_v1 "Import and export files (CSV, JSON, SQL, Excel)" "area:frontend,area:backend" <<'EOF'
Export a table or a result to CSV/JSON/SQL/Excel and import CSV/JSON into a table (spec §3).
Depends on: copy formats from Plan 3 (`src/lib/copyFormats.ts`) for export; file pickers are
opened from Rust (`commands::file_pick`), the webview gets no dialog permission. Large files
must stream (no full load in memory) and stay cancellable.
EOF

post_v1 "Backup and restore" "area:backend,area:frontend" <<'EOF'
Dump and restore a database (spec §3): decide between calling `pg_dump`/`mysqldump`
(external binaries to locate and version-match) and a native dump. Restore is a write:
safe mode (Plan 5) applies.
EOF

post_v1 "User and privilege management" "area:frontend,area:backend" <<'EOF'
List and edit database users, roles and grants per engine (spec §3). Every change is a write
on the server: safe mode (Plan 5) applies; show the generated SQL like the pending-changes
panel (Plan 3).
EOF

post_v1 "Process list" "area:frontend,area:backend" <<'EOF'
Show running sessions/queries (`pg_stat_activity`, `SHOW PROCESSLIST`) with a kill action
(spec §3). Kill is a write: confirmation and safe mode (Plan 5).
EOF

post_v1 "Structure editing (ALTER via UI)" "area:frontend,area:backend" <<'EOF'
Edit columns, indexes and foreign keys from the Structure view (spec §3).
Depends on: the read-only Structure view (Plan 3) and the pending-changes pattern (generated SQL
shown before commit); safe mode (Plan 5).
EOF

post_v1 "Split view" "area:frontend" <<'EOF'
Show two tabs side by side in one workspace (spec §3).
Depends on: the tab model of Plan 4 (preview tab, MRU, session restore).
EOF

post_v1 "Multiple windows" "area:frontend,area:backend" <<'EOF'
Open workspaces in separate windows (spec §3): Tauri multi-window, capabilities per window kept
minimal, session restore (Plan 4) per window.
EOF

post_v1 "Automatic updates" "area:backend,area:infra,area:security" <<'EOF'
Update the app in place (spec §3): `tauri-plugin-updater`, signed updates (signing key kept out
of the repo), a release feed. Only update checks may reach the network (spec §4: no remote
content); opt-out in settings.
EOF

post_v1 "macOS packaging" "area:infra" <<'EOF'
Build, sign and notarize a macOS app (spec §3). The code is kept portable (no Linux-only API
outside abstractions); the keyring becomes the Keychain. Needs an Apple developer account and a
macOS runner (costly on a private repo).
EOF

post_v1 "Windows packaging" "area:infra" <<'EOF'
Build an MSI/NSIS installer (spec §3): WebView2, the keyring becomes the Credential Manager,
paths and SSH agent (Pageant / OpenSSH agent) differ.
EOF

# ------------------------------------------------------------------ follow-ups (plans 1–2)

echo "== Follow-ups from docs/notes/plan-0*-followups.md"
followup() { # title labels ; body on stdin (v1 tech debt: no milestone)
  ensure_issue "$1" "type:task,$2" "" ""
}

# Ready: files Plans 3–5 did not touch.
followup "SSH config parsing edge cases" "status:ready,good first issue,size:S,area:backend" <<'EOF'
From `docs/notes/plan-02-followups.md` (Task 2):
- an invalid `Port` value lets a later `Host` block win instead of being reported;
- `glob_match` backtracks exponentially on patterns with many `*`;
- `Include`: the `seen` set is not seeded with the root file (one duplicate parse) and is
  shared across chains (a diamond is expanded once).

Files: `src-tauri/src/ssh/config.rs` (unit tests next to the code).
Acceptance: a unit test per case; `cargo test --manifest-path src-tauri/Cargo.toml --lib ssh::`,
`pnpm lint` green.
EOF

followup "known_hosts: no false 'host key changed' across files" "status:ready,size:M,area:backend,area:security" <<'EOF'
From `docs/notes/plan-02-followups.md` (residuals and Task 2): when `~/.ssh/known_hosts` and
the app's file record different algorithms for the same host, the per-file evaluation reports
Changed (fails closed, but a false alarm). Rule to adopt: Known if some file records the
presented key and no file records a same-algorithm different key. Also add a comment that
`@revoked` / `@cert-authority` lines are ignored (a revoked key reads as Unknown).

Files: `src-tauri/src/ssh/known_hosts.rs`.
Acceptance: unit tests for the multi-file cases; existing `ssh::` tests and `pnpm lint` green.
EOF

followup "SSH tunnel robustness" "status:ready,size:M,area:backend" <<'EOF'
From `docs/notes/plan-02-followups.md` (Task 3):
- agent auth: a signing error on one identity aborts the loop with Connection instead of trying
  the next identity (tunnel.rs, around the agent loop);
- no timeout on the SSH auth phase (a silent server gives ~90 s then a misleading "auth failed");
- the accept-error loop retries forever silently; forward failures are dropped without a log;
- blocking `std::fs` reads (key, known_hosts) inside the async connect;
- `KnownHosts` rebuilt field by field (derive `Clone`).

Files: `src-tauri/src/ssh/tunnel.rs`, `src-tauri/tests/ssh_tunnel.rs`.
Acceptance: tests for the auth timeout and the next-identity fallback; `pnpm test:rust`, `pnpm lint` green.
EOF

followup "TLS: name the file in CA errors, no blocking reads in connect" "status:ready,good first issue,size:S,area:backend" <<'EOF'
From `docs/notes/plan-02-followups.md` (Task 1):
- "CA file holds an unusable certificate" does not say which file (`tls.rs` ~152 and ~293);
- certificate/key files and the OS root store are read with blocking calls on every connect
  (move to `spawn_blocking` or cache the root store).

Files: `src-tauri/src/driver/tls.rs` only (Plans 3–5 do not touch it).
Acceptance: a unit test on the error message; `pnpm test:rust`, `pnpm lint` green.
EOF

followup "Integration tests: portable ports and fewer timing assumptions" "status:ready,good first issue,size:S,area:backend,area:infra" <<'EOF'
From `docs/notes/plan-01-followups.md` and `plan-02-followups.md`:
- `src-tauri/tests/ssh_tunnel.rs` (`unverifiable_known_hosts_blocks_without_trusting`)
  hard-codes `[127.0.0.1]:2222`: use `ssh_addr()` so side-by-side stacks
  (`TABLEMAX_TEST_SSH_PORT`) pass;
- the SQLite cancel test waits a fixed 200 ms: retry the cancel in a loop instead;
- `mysql_client_cert_is_presented` leaks a root session; a unit test installs the crypto
  provider for nothing.

Files: `src-tauri/tests/ssh_tunnel.rs`, `src-tauri/tests/sqlite_driver.rs`, `src-tauri/tests/mysql_driver.rs`.
Acceptance: `pnpm test:rust` green with the default ports and with the "Two worktrees side by
side" ports from the README.
EOF

followup "URL import/export edge cases" "status:ready,good first issue,size:S,area:frontend" <<'EOF'
From `docs/notes/plan-02-followups.md` (Task 6):
- invalid `sslmode` warning also shown for libpq's `allow`;
- `ssh-auth` without `ssh` is silently ignored (warn);
- an SSH user name containing `:` does not round-trip;
- legacy MySQL `verifyCa` connections export `verify-ca` (not offered for MySQL in v1).

Files: `src/lib/connectionUrl.ts` (+ `connectionUrl.test.ts`).
Acceptance: a test per case; `pnpm test && pnpm lint` green.
EOF

followup "URL import dialog shows the password in clear" "status:ready,good first issue,size:S,area:frontend,area:security" <<'EOF'
From `docs/notes/plan-02-followups.md` (Task 6): the "New from URL…" field shows a pasted
`user:password@` in clear. Mask the password part (or the whole field with a show toggle), and
restore the clipboard mock in `UrlImportDialog.test.tsx`.

Files: `src/features/connections/UrlImportDialog.tsx` (+ test), `src/lib/strings.ts` if a
label is needed (Plans 3–5 also add strings there: keep the change small).
Acceptance: a test that the password is not rendered; `pnpm test && pnpm lint` green.
EOF

followup "TablePlus import: dialog close during commit, stricter parsing" "status:ready,size:S,area:frontend,area:backend" <<'EOF'
From `docs/notes/plan-02-followups.md` (Tasks 7–8):
- close/Escape stays live during commit, so the discard can race the commit (disable while busy);
- the options byte check accepts any value with bit 0 set (use `== 1`);
- the `secret()` helper is used for `DatabaseName`.
Also (in `manager.rs`, see the SessionManager follow-up): clear the remembered last pick on discard/commit.

Files: `src/features/connections/ImportDialog.tsx` (+ test), `src-tauri/src/import/tableplus.rs`.
Acceptance: tests for the busy state and the options check; `pnpm test && pnpm lint`,
`pnpm test:rust` green.
EOF

# Ready too, but on files Plans 3–5 rewrote: re-check each item against the merged code first.
followup "Lint the Vite/Vitest configs and the Rust tests" "status:ready,size:S,area:infra" <<'EOF'
From `docs/notes/plan-01-followups.md`: `pnpm lint` does not type-check `vite.config.ts` /
`vitest.config.ts` (tsc without `-b`), and `cargo clippy --all-targets` fails on
`src-tauri/tests/mysql_driver.rs` (`useless_format`) because lint skips tests.

Plans 4 and 5 changed `package.json`: check the current lint script first.
Files: `package.json`, `tsconfig.node.json`, `src-tauri/tests/mysql_driver.rs`.
EOF

followup "PostgreSQL driver edge cases" "status:ready,size:M,area:backend" <<'EOF'
From `docs/notes/plan-01-followups.md` (Task 4): fallback path drops rows when prepare reports
0 columns; `bytea_output` can be changed by the user (`RESET ALL`) so bytes decode wrong;
`close()` aborts the task (no graceful Terminate); `percent_decode` panics on non-ASCII;
`42P01` in `count_rows` maps to Query; Json/Decimal/Temporal values are not size-capped.

Plan 3 rewrote much of `driver/postgres.rs`: re-check each item first and drop what it fixed.
EOF

followup "MySQL/MariaDB driver edge cases" "status:ready,size:M,area:backend" <<'EOF'
From `docs/notes/plan-01-followups.md` (Task 5): canceller connects with the database name
(fails if it was dropped); `KILL QUERY` quirks (MariaDB `KILL QUERY ID`, error 4031 →
ConnectionLost); `sql_mode` refresh misses comment-prefixed `EXECUTE`/`CALL`; refresh
ConnectionLost discards an applied DML result; JSON cache invalidation is approximate.

Plans 3 and 4 changed `driver/mysql.rs`: re-check each item first and drop what they fixed.
EOF

followup "SQLite driver edge cases" "status:ready,size:S,area:backend" <<'EOF'
From `docs/notes/plan-01-followups.md` (Task 3): `execute` reports stale `changes()` for DDL
after DML (use a `total_changes` delta); `SQLITE_OPEN_URI` treats user paths starting with
`file:` as URIs.

Plan 3 changed `driver/sqlite.rs`: re-check each item first.
EOF

followup "SessionManager: close, cancel and keyring edge cases" "status:ready,size:M,area:backend" <<'EOF'
From `docs/notes/plan-01-followups.md` (Task 7) and `plan-02-followups.md` (Task 4, residuals):
close can hang on MySQL until the statement ends; `close_workspace` shuts sessions one by one
(N × 5 s); cancel returns Ok on its 5 s timeout; `unbind_stale_keyring` checks identity before
the tunnel lock and the reopen (re-check right before each keyring read); the remembered
TablePlus pick is never cleared; `fresh.close()` unbounded in the closed-during-reconnect branch.

Plans 3, 4 and 5 all changed `manager.rs`: re-check each item first and drop what they fixed.
EOF

followup "Grid display minors" "status:ready,size:S,area:frontend" <<'EOF'
From `docs/notes/plan-01-followups.md` (Task 10): floats shown with full round-trip digits
(15.299999999999999); page not clamped after rows are deleted; a vacuous unmount test.

Plan 3 rewrote the grid: re-check each item first.
EOF

# ------------------------------------------------------------------ project board

echo "== Project board"
if [[ $WITH_PROJECT -eq 0 ]]; then
  echo "skipped (run with --project; needs the 'project' token scope: gh auth refresh -s project)"
else
  scopes="$(gh auth status --active --json hosts --jq '.hosts[][] | select(.active) | .scopes' 2>/dev/null || true)"
  if ! [[ ",$scopes," =~ ,[[:space:]]*project[[:space:]]*, ]]; then # not read:project
    echo "the gh token lacks the 'project' scope: run  gh auth refresh -s project  then re-run with --project"
  else
    number="$(gh project list --owner "$OWNER" --format json --jq ".projects[] | select(.title == \"$PROJECT_TITLE\") | .number" | head -1)"
    if [[ -z $number && $DRY_RUN -eq 1 ]]; then
      echo "would create project    $PROJECT_TITLE (field Stage: Triage, Ready, In progress, Review, Done), link it to the repo and add every open issue"
    else
      if [[ -z $number ]]; then
        [[ $DRY_RUN -eq 1 ]] || number="$(gh project create --owner "$OWNER" --title "$PROJECT_TITLE" --format json --jq .number)"
        echo "created project         $PROJECT_TITLE (#$number)"
      fi
      if [[ $DRY_RUN -eq 1 ]]; then
        echo "project $PROJECT_TITLE exists (#$number): would add the open issues not on it yet"
      else
        if ! gh project field-list "$number" --owner "$OWNER" --format json --jq '.fields[].name' | grep -Fxq Stage; then
          gh project field-create "$number" --owner "$OWNER" --name Stage --data-type SINGLE_SELECT \
            --single-select-options "Triage,Ready,In progress,Review,Done" >/dev/null
          echo "created field           Stage"
        fi
        gh project link "$number" --owner "$OWNER" --repo "$(gh repo view --json nameWithOwner --jq .nameWithOwner)" >/dev/null 2>&1 || true
        gh issue list --state open --limit 1000 --json url --jq '.[].url' | while read -r url; do
          gh project item-add "$number" --owner "$OWNER" --url "$url" >/dev/null
        done
        echo "added open issues to    $PROJECT_TITLE (#$number)"
      fi
    fi
  fi
fi

echo
if [[ $DRY_RUN -eq 1 ]]; then
  echo "Dry run: $created item(s) would be created, $existing already exist."
else
  echo "Done: $created item(s) created, $existing already existed."
fi

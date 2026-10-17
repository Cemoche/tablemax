---
name: ship
description: Ship the current TableMax issue branch — re-run the checks, push the branch, open or update the pull request to main with "Closes #<n>", set status:review and link the PR on the issue. Never merges. Use when the user says ship, open the PR, or send for review.
argument-hint: "[--draft]"
disable-model-invocation: true
---

# Ship the current issue branch

Argument: `$ARGUMENTS` (`--draft` opens a draft PR). **Never merge, never force-push, never
push `main`.** A teammate reviews; the repository owner merges.

## 1. Preconditions — stop at the first failure and say why

```bash
git branch --show-current
git status --porcelain
gh auth status --active --json hosts --jq '.hosts[][] | select(.active) | .login'   # ME
```

- Branch `main`/`master` → refuse. Branch not `issue-<n>-<slug>` → stop (`worktree-issue-<n>`:
  run `/work-issue <n>` first, it renames the branch). Take `<n>` from the branch name.
- Uncommitted or untracked files → list them and stop (the user commits or discards them).
- `gh issue view <n> --json state,assignees,title,url`: closed, or `ME` not among the
  assignees → stop.
- `git fetch origin main`; `git rev-list --count HEAD..origin/main` > 0 → tell the user the
  branch is behind `main` and ask whether to merge/rebase first.

## 2. Checks (all must pass; on failure stop, report, do not push)

```bash
pnpm test && pnpm lint
git diff --name-only origin/main...HEAD
```

Also run, when the diff touches them:

- `src-tauri/`, `docker-compose.test.yml`, `tests/docker/` or `scripts/test-*` → `pnpm test:rust`
- `.claude/hooks/` or `scripts/test-claude-hooks.sh` → `bash scripts/test-claude-hooks.sh`
- always, when the script exists → `bash scripts/check-no-secrets.sh`

Keep the last lines of each command's output for the PR body.

## 3. Push

```bash
git push -u origin issue-<n>-<slug>
```

(The project settings ask before every push.) Rejected as non-fast-forward → stop and explain;
never `--force`.

## 4. Open or update the PR

`gh pr list --head issue-<n>-<slug> --state open --json number,url`

Body: follow `.github/pull_request_template.md` — first line `Closes #<n>`, Summary, How it was
tested (the commands and the end of their output), Screenshots/manual checks for UI changes
(delete the section otherwise), the checklist with only true items ticked.
Title: `<emoji> <type>(<scope>): <description>` (it becomes the squash commit).

- No open PR → create it (add `--draft` if asked):
  ```bash
  gh pr create --base main --head issue-<n>-<slug> --title "<title>" --body-file - <<'EOF'
  Closes #<n>
  ...
  EOF
  ```
- Open PR → update the body only if it changed (`gh pr edit <pr> --body-file -`), and say what
  was pushed.

## 5. Update the issue

```bash
gh issue edit <n> --add-label status:review --remove-label status:in-progress
gh issue comment <n> --body-file - <<'EOF'
PR ready for review: <PR URL>
Checks: pnpm test ✓ · pnpm lint ✓ · pnpm test:rust <✓ | not needed>
EOF
```

(On a PR update, comment only if there is something new for the reviewer.)

## 6. Report

Give the PR URL, the checks that ran, and remind: a teammate reviews, the owner merges.
After the merge: `git worktree remove .worktrees/issue-<n>` (or leave the `claude --worktree`
session and let it clean up).

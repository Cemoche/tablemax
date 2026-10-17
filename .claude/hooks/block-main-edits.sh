#!/usr/bin/env bash
# PreToolUse hook (Edit|Write|NotebookEdit): refuse edits to files on a `main` or `master`
# checkout, so work always happens on an issue branch. Exit 2 blocks the tool call and
# shows stderr to Claude. Anything this hook cannot check (no jq, not a git repo, detached
# HEAD, gitignored file, bad input) is allowed. It never writes anything.
set -u

input="$(cat)" # always drain stdin, so Claude Code never gets a broken pipe
if ! command -v jq >/dev/null 2>&1; then
  echo "TableMax hook: jq is not installed, so edits on main are not checked (sudo apt install jq)." >&2
  exit 0
fi

target="$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // .cwd // empty' 2>/dev/null)" || exit 0
cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)" || cwd=""
[[ -n $target ]] || exit 0
[[ $target == /* || -z $cwd ]] || target="$cwd/$target"

# The file may not exist yet (Write): use the nearest existing directory.
dir="$target"
[[ -d $dir ]] || dir="$(dirname "$dir")"
while [[ ! -d $dir && $dir != / ]]; do dir="$(dirname "$dir")"; done

branch="$(git -C "$dir" branch --show-current 2>/dev/null)" || exit 0
case "$branch" in
  main | master) ;;
  *) exit 0 ;;
esac

# Gitignored files (CLAUDE.local.md, .claude/settings.local.json…) are never committed.
if git -C "$dir" check-ignore -q --no-index -- "$target" 2>/dev/null; then
  exit 0
fi

cat >&2 <<EOF
TableMax: edits on '$branch' are blocked. Work on an issue branch in its own worktree:
  git fetch origin && git worktree add -b issue-<n>-<slug> .worktrees/issue-<n> origin/main
or start Claude with: claude --worktree issue-<n>   (then /work-issue <n>; see CONTRIBUTING.md)
EOF
exit 2

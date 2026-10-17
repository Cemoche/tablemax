#!/usr/bin/env bash
# PreToolUse hook (Edit|Write|NotebookEdit|Bash): on a `main` or `master` checkout of this
# repository, refuse file edits and commit-making git commands (commit, cherry-pick, revert,
# am), so work always happens on an issue branch. Exit 2 blocks the tool call and shows
# stderr to Claude. Anything it cannot check (no jq, not a git repo, detached HEAD, another
# repository, gitignored file, bad input) is allowed. It never writes anything.
set -u

input="$(cat)" # always drain stdin, so Claude Code never gets a broken pipe
if ! command -v jq >/dev/null 2>&1; then
  echo "TableMax hook: jq is not installed, so edits on main are not checked (sudo apt install jq)." >&2
  exit 0
fi

field() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }
tool="$(field .tool_name)"
cwd="$(field .cwd)"
[[ -n $cwd ]] || cwd="${CLAUDE_PROJECT_DIR:-}"

common_dir() { git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null; }

refuse() { # $1 = branch, $2 = what was refused
  cat >&2 <<EOF
TableMax: $2 on '$1' is blocked. Work on an issue branch in its own worktree:
  git fetch origin && git worktree add -b issue-<n>-<slug> .worktrees/issue-<n> origin/main
or start Claude with: claude --worktree issue-<n>   (then /work-issue <n>; see CONTRIBUTING.md)
EOF
  exit 2
}

on_main() { # $1 = directory → prints the branch and succeeds when it is main/master
  local b
  b="$(git -C "$1" branch --show-current 2>/dev/null)" || return 1
  [[ $b == main || $b == master ]] || return 1
  printf '%s' "$b"
}

if [[ $tool == Bash ]]; then
  cmd="$(field .tool_input.command)"
  # git [-C <dir>] commit|cherry-pick|revert|am, anywhere in the command line.
  re='(^|[;&|(`[:space:]])git([[:space:]]+-C[[:space:]]+("[^"]*"|'"'"'[^'"'"']*'"'"'|[^[:space:]]+))?[[:space:]]+(commit|cherry-pick|revert|am)([[:space:]]|$)'
  [[ $cmd =~ $re ]] || exit 0
  dir="${BASH_REMATCH[3]:-}"
  dir="${dir#[\"\']}"; dir="${dir%[\"\']}"
  [[ -n $dir ]] || dir="$cwd"
  [[ -z $dir || $dir == /* || -z $cwd ]] || dir="$cwd/$dir"
  [[ -n $dir && -d $dir ]] || exit 0
  branch="$(on_main "$dir")" || exit 0
  refuse "$branch" "committing"
fi

target="$(field '.tool_input.file_path // .tool_input.notebook_path')"
[[ -n $target ]] || exit 0
[[ $target == /* || -z $cwd ]] || target="$cwd/$target"

# The file may not exist yet (Write): use the nearest existing directory.
dir="$target"
[[ -d $dir ]] || dir="$(dirname "$dir")"
while [[ ! -d $dir && $dir != / ]]; do dir="$(dirname "$dir")"; done

branch="$(on_main "$dir")" || exit 0

# Only this session's repository (any of its worktrees): another repo on main is not ours.
if [[ -n $cwd ]] && session_repo="$(common_dir "$cwd")"; then
  [[ "$(common_dir "$dir")" == "$session_repo" ]] || exit 0
fi

# Gitignored files (CLAUDE.local.md, .claude/settings.local.json…) are never committed.
if git -C "$dir" check-ignore -q --no-index -- "$target" 2>/dev/null; then
  exit 0
fi

refuse "$branch" "editing files"

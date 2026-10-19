#!/usr/bin/env bash
# Fail if a file tracked by git contains something that looks like a real secret: GitHub
# tokens, Anthropic API keys, AWS access key ids, private keys. Prints file:line only, never
# the value. Lock files, TablePlus fixtures and research notes are skipped; known fake
# values are listed in scripts/check-no-secrets.allow (path<TAB>exact text on the line).
# Usage: bash scripts/check-no-secrets.sh   (run from anywhere inside the repository)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

patterns=(
  'gh[pousr]_[A-Za-z0-9]{36}'           # GitHub tokens (classic, OAuth, user, server, refresh)
  'github_pat_[A-Za-z0-9_]{22,}'        # GitHub fine-grained tokens
  'sk-ant-[A-Za-z0-9_-]{20,}'           # Anthropic API keys
  'AKIA[0-9A-Z]{16}'                    # AWS access key ids
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'  # PEM / OpenSSH private keys
)
args=()
for p in "${patterns[@]}"; do args+=(-e "$p"); done

# git grep: tracked files only, -I skips binaries. Exit 0 = match, 1 = none, more = error.
status=0
matches="$(git grep -n -I -E "${args[@]}" -- . \
  ':(exclude)pnpm-lock.yaml' ':(exclude)src-tauri/Cargo.lock' \
  ':(exclude)src-tauri/tests/fixtures/**' ':(exclude)docs/research/**' \
  ':(exclude)scripts/check-no-secrets.allow')" || status=$?

if [[ $status -gt 1 ]]; then
  echo "check-no-secrets: git grep failed (exit $status)" >&2
  exit 2
fi
# Drop the matches listed in the allowlist.
allow_file="scripts/check-no-secrets.allow"
found=()
if [[ $status -eq 0 ]]; then
  while IFS= read -r match; do
    file="${match%%:*}"
    rest="${match#*:}"
    line="${rest%%:*}"
    content="${rest#*:}"
    allowed=0
    if [[ -f $allow_file ]]; then
      while IFS=$'\t' read -r apath atext; do
        [[ -z $apath || $apath == \#* || -z ${atext:-} ]] && continue
        if [[ $file == "$apath" && $content == *"$atext"* ]]; then allowed=1; break; fi
      done <"$allow_file"
    fi
    [[ $allowed -eq 1 ]] || found+=("$file:$line")
  done <<<"$matches"
fi

if [[ ${#found[@]} -gt 0 ]]; then
  echo "Possible secrets in tracked files (values not shown):" >&2
  printf '  %s\n' "${found[@]}" >&2
  echo "Remove them (and rotate any real secret), or move test material to .test-secrets/." >&2
  exit 1
fi
echo "No secrets found in tracked files."

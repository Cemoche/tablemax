#!/usr/bin/env bash
# Checks that a release tag matches the app version everywhere it is written.
# Usage: bash scripts/release-check-version.sh <tag>   (e.g. v0.1.0 or v0.1.0-beta.1)
# Prints the version on success; exits 1 with the mismatches otherwise. Needs jq.
set -euo pipefail

ROOT="${RELEASE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
tag="${1:-}"

if [[ ! "$tag" =~ ^v([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$ ]]; then
  echo "error: tag '$tag' is not v<major>.<minor>.<patch>[-<suffix>]" >&2
  exit 1
fi
want="${BASH_REMATCH[1]}"

pkg="$(jq -r .version "$ROOT/package.json")"
conf="$(jq -r .version "$ROOT/src-tauri/tauri.conf.json")"
# The [package] table's version: the first `version = "…"` line before any other table.
cargo="$(awk '/^\[/ { in_pkg = ($0 == "[package]") } in_pkg && /^version *=/ { gsub(/.*= *"|".*/, ""); print; exit }' \
  "$ROOT/src-tauri/Cargo.toml")"

status=0
for pair in "package.json:$pkg" "src-tauri/tauri.conf.json:$conf" "src-tauri/Cargo.toml:$cargo"; do
  file="${pair%%:*}" have="${pair#*:}"
  if [[ "$have" != "$want" ]]; then
    echo "error: $file has version '$have', tag $tag wants '$want'" >&2
    status=1
  fi
done
[[ $status -eq 0 ]] && echo "$want"
exit "$status"

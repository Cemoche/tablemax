#!/usr/bin/env bash
# Sets the app version for a release: package.json, src-tauri/tauri.conf.json,
# src-tauri/Cargo.toml ([package]) and the tablemax entry of src-tauri/Cargo.lock.
# Only those four lines change. Refuses a version that is not <major>.<minor>.<patch>[-suffix]
# (no leading v: the tag adds it) and files that already disagree with each other.
# Usage: bash scripts/release-bump.sh <version>     Needs jq.
set -euo pipefail

ROOT="${RELEASE_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
new="${1:-}"
if [[ ! "$new" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "error: '$new' is not a version (expected <major>.<minor>.<patch>[-suffix], without v)" >&2
  exit 1
fi

pkg="$ROOT/package.json" conf="$ROOT/src-tauri/tauri.conf.json"
toml="$ROOT/src-tauri/Cargo.toml" lock="$ROOT/src-tauri/Cargo.lock"

# The [package] version of Cargo.toml / the tablemax entry of Cargo.lock.
toml_version() {
  awk '/^\[/ { in_pkg = ($0 == "[package]") } in_pkg && /^version *=/ { gsub(/.*= *"|".*/, ""); print; exit }' "$toml"
}
lock_version() {
  awk '/^\[\[package\]\]/ { want = 0 } /^name = "tablemax"$/ { want = 1; next }
       want && /^version = / { gsub(/.*= *"|".*/, ""); print; exit }' "$lock"
}

old="$(jq -r .version "$pkg")"
for pair in "src-tauri/tauri.conf.json:$(jq -r .version "$conf")" "src-tauri/Cargo.toml:$(toml_version)" \
            "src-tauri/Cargo.lock:$(lock_version)"; do
  if [[ "${pair#*:}" != "$old" ]]; then
    echo "error: versions disagree: package.json has '$old', ${pair%%:*} has '${pair#*:}'" >&2
    exit 1
  fi
done

if [[ "$old" == "$new" ]]; then
  echo "already at $new: nothing to change"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
esc_old="${old//./\\.}"
# Top-level "version" of the two JSON files: the only line indented by exactly two spaces.
for f in "$pkg" "$conf"; do
  sed "s/^  \"version\": \"$esc_old\",\$/  \"version\": \"$new\",/" "$f" >"$tmp/out"
  [[ "$(jq -r .version "$tmp/out")" == "$new" ]] || { echo "error: could not update $f" >&2; exit 1; }
  cat "$tmp/out" >"$f"
done
awk -v new="$new" '/^\[/ { in_pkg = ($0 == "[package]") }
  in_pkg && !done && /^version *=/ { sub(/".*"/, "\"" new "\""); done = 1 } { print }' "$toml" >"$tmp/out"
cat "$tmp/out" >"$toml"
awk -v new="$new" '/^\[\[package\]\]/ { want = 0 } /^name = "tablemax"$/ { want = 1 }
  want && /^version = / { sub(/".*"/, "\"" new "\""); want = 0 } { print }' "$lock" >"$tmp/out"
cat "$tmp/out" >"$lock"

[[ "$(toml_version)" == "$new" && "$(lock_version)" == "$new" ]] \
  || { echo "error: Cargo.toml or Cargo.lock not updated" >&2; exit 1; }
echo "$old -> $new"

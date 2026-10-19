#!/usr/bin/env bash
# Tests for scripts/release-check-version.sh, the glibc check of scripts/release-smoke.sh
# and scripts/release-files.sh.
# Usage: bash scripts/test-release-scripts.sh   (needs jq, dpkg-deb, objdump; no network)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$ROOT/scripts/release-check-version.sh"
SMOKE="$ROOT/scripts/release-smoke.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
failures=0

ok() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; failures=$((failures + 1)); }

# expect <description> <expected exit code> <expected output substring> <command...>
expect() {
  local desc="$1" code="$2" needle="$3"; shift 3
  local out rc=0
  out="$("$@" 2>&1)" || rc=$?
  if [[ $rc -eq $code && "$out" == *"$needle"* ]]; then ok "$desc"; else
    fail "$desc (exit $rc, output: $out)"
  fi
}

# --- version check -------------------------------------------------------------------

fixture() { # $1 = dir, $2 = package.json version, $3 = tauri.conf.json version, $4 = Cargo version
  mkdir -p "$1/src-tauri"
  printf '{"name":"x","version":"%s"}\n' "$2" >"$1/package.json"
  printf '{"productName":"X","version":"%s"}\n' "$3" >"$1/src-tauri/tauri.conf.json"
  cat >"$1/src-tauri/Cargo.toml" <<EOF
[package]
name = "x"
version = "$4"
edition = "2021"

[dependencies]
serde = { version = "1.0.0" }

[workspace.package]
version = "9.9.9"
EOF
}

fixture "$TMP/same" 0.2.0 0.2.0 0.2.0
expect "matching tag passes and prints the version" 0 "0.2.0" \
  env RELEASE_ROOT="$TMP/same" bash "$CHECK" v0.2.0
expect "tag without v is refused" 1 "is not v<major>" \
  env RELEASE_ROOT="$TMP/same" bash "$CHECK" 0.2.0
expect "missing tag is refused" 1 "is not v<major>" \
  env RELEASE_ROOT="$TMP/same" bash "$CHECK"
expect "other version is refused" 1 "package.json has version '0.2.0', tag v0.3.0 wants '0.3.0'" \
  env RELEASE_ROOT="$TMP/same" bash "$CHECK" v0.3.0

fixture "$TMP/pre" 0.2.0-beta.1 0.2.0-beta.1 0.2.0-beta.1
expect "prerelease tag matches a prerelease version" 0 "0.2.0-beta.1" \
  env RELEASE_ROOT="$TMP/pre" bash "$CHECK" v0.2.0-beta.1

fixture "$TMP/cargo" 0.2.0 0.2.0 0.1.0
expect "Cargo.toml [package] version is checked (not a dependency or another table)" 1 \
  "src-tauri/Cargo.toml has version '0.1.0'" env RELEASE_ROOT="$TMP/cargo" bash "$CHECK" v0.2.0

fixture "$TMP/conf" 0.2.0 0.1.9 0.2.0
expect "tauri.conf.json version is checked" 1 "src-tauri/tauri.conf.json has version '0.1.9'" \
  env RELEASE_ROOT="$TMP/conf" bash "$CHECK" v0.2.0

expect "the repository itself has one version everywhere" 0 "" \
  bash "$CHECK" "v$(jq -r .version "$ROOT/package.json")"

# --- glibc floor ---------------------------------------------------------------------

# A tiny .deb holding a copy of this machine's `true`: its newest glibc symbol is the host's.
mkdir -p "$TMP/deb/DEBIAN" "$TMP/deb/usr/bin"
cp "$(type -P true)" "$TMP/deb/usr/bin/fake"
printf 'Package: fake\nVersion: 1\nArchitecture: amd64\nMaintainer: t <t@example.com>\nDescription: t\n' \
  >"$TMP/deb/DEBIAN/control"
# An ELF file without any glibc symbol (only the magic, so objdump finds nothing) must not
# stop the scan.
printf '\177ELF\002\001\001' >"$TMP/deb/usr/bin/no-glibc"
dpkg-deb -b --root-owner-group "$TMP/deb" "$TMP/fake.deb" >/dev/null
host="$(objdump -T "$(type -P true)" | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -1)"

expect "glibc floor above the binary's needs passes (an ELF file without glibc symbols is fine)" 0 \
  "2 ELF files, newest glibc symbol $host" \
  bash "$SMOKE" glibc 99.0 "$TMP/fake.deb"
expect "glibc floor below the binary's needs fails and names the file" 1 \
  "usr/bin/fake needs GLIBC_$host (max 2.0)" bash "$SMOKE" glibc 2.0 "$TMP/fake.deb"

mkdir -p "$TMP/empty/DEBIAN"
cp "$TMP/deb/DEBIAN/control" "$TMP/empty/DEBIAN/control"
dpkg-deb -b --root-owner-group "$TMP/empty" "$TMP/empty.deb" >/dev/null
expect "a package with no ELF file is an error" 1 "no ELF file found" \
  bash "$SMOKE" glibc 99.0 "$TMP/empty.deb"
expect "unknown subcommand prints usage" 2 "Usage:" bash "$SMOKE" nope

# --- release file list ---------------------------------------------------------------

FILES="$ROOT/scripts/release-files.sh"
mk() { mkdir -p "$1"; shift; local f; for f in "$@"; do : >"$f"; done; }

mk "$TMP/rel-ok" "$TMP/rel-ok/T_1_amd64.deb" "$TMP/rel-ok/T_1_amd64.AppImage"
expect "one .deb and one AppImage are listed" 0 "T_1_amd64.AppImage" bash "$FILES" "$TMP/rel-ok"
: >"$TMP/rel-ok/SHA256SUMS"
expect "SHA256SUMS is listed when present" 0 "SHA256SUMS" bash "$FILES" "$TMP/rel-ok"

mk "$TMP/rel-vite" "$TMP/rel-vite/T.deb" "$TMP/rel-vite/T.AppImage" "$TMP/rel-vite/index.html"
mkdir -p "$TMP/rel-vite/assets"
expect "a frontend build next to the packages is refused (#60)" 1 "unexpected entries" \
  bash "$FILES" "$TMP/rel-vite"
mk "$TMP/rel-two" "$TMP/rel-two/a.deb" "$TMP/rel-two/b.deb" "$TMP/rel-two/T.AppImage"
expect "two .deb files are refused" 1 "expected 1 .deb" bash "$FILES" "$TMP/rel-two"
mk "$TMP/rel-none"
expect "an empty directory is refused" 1 "expected 1 .AppImage" bash "$FILES" "$TMP/rel-none"
mk "$TMP/rel-hidden" "$TMP/rel-hidden/T.deb" "$TMP/rel-hidden/T.AppImage" "$TMP/rel-hidden/.env"
expect "a hidden file is refused" 1 ".env" bash "$FILES" "$TMP/rel-hidden"
expect "a missing directory is refused" 1 "no such directory" bash "$FILES" "$TMP/nope"

echo
if [[ $failures -eq 0 ]]; then echo "all release script tests passed"; else
  echo "$failures release script test(s) failed"; exit 1
fi

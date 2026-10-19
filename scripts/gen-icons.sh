#!/usr/bin/env bash
# Regenerate the app icons (src-tauri/icons/*) from the original SVG source
# assets/icon/tablemax.svg with the Tauri CLI. Idempotent; runs from any directory.
# Usage: scripts/gen-icons.sh
set -euo pipefail

cd "$(dirname "$0")/.."
# The CLI logs every file it writes on stderr: only show that log when it fails.
if ! log=$(pnpm tauri icon assets/icon/tablemax.svg --output src-tauri/icons 2>&1); then
  echo "$log" >&2
  exit 1
fi
# Desktop app only: drop the mobile icon sets the CLI also writes.
rm -rf src-tauri/icons/android src-tauri/icons/ios
echo "icons written to src-tauri/icons/"

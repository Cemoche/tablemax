#!/usr/bin/env bash
# Prints the files a release publishes from <dir>, one per line: exactly one .deb, one
# .AppImage and, when present, SHA256SUMS. Exits 1 (with the reason) when <dir> holds
# anything else, so a stray file or directory can never be uploaded by accident.
# Usage: bash scripts/release-files.sh <dir>
set -euo pipefail

dir="${1:-}"
[[ -d "$dir" ]] || { echo "error: no such directory: '$dir'" >&2; exit 1; }

debs=() appimages=() sums=() others=()
for path in "$dir"/* "$dir"/.[!.]*; do
  [[ -e "$path" || -L "$path" ]] || continue
  name="$(basename "$path")"
  if [[ -f "$path" && ! -L "$path" && "$name" == *.deb ]]; then debs+=("$path")
  elif [[ -f "$path" && ! -L "$path" && "$name" == *.AppImage ]]; then appimages+=("$path")
  elif [[ -f "$path" && ! -L "$path" && "$name" == SHA256SUMS ]]; then sums+=("$path")
  else others+=("$name")
  fi
done

status=0
[[ ${#debs[@]} -eq 1 ]] || { echo "error: expected 1 .deb in $dir, found ${#debs[@]}" >&2; status=1; }
[[ ${#appimages[@]} -eq 1 ]] || { echo "error: expected 1 .AppImage in $dir, found ${#appimages[@]}" >&2; status=1; }
[[ ${#others[@]} -eq 0 ]] || { echo "error: unexpected entries in $dir: ${others[*]}" >&2; status=1; }
[[ $status -eq 0 ]] || exit 1

printf '%s\n' "${debs[0]}" "${appimages[0]}"
[[ ${#sums[@]} -eq 0 ]] || printf '%s\n' "${sums[0]}"

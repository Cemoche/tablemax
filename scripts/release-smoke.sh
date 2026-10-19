#!/usr/bin/env bash
# Smoke tests for the Linux release packages (used by .github/workflows/release.yml).
# Usage:
#   bash scripts/release-smoke.sh glibc <max> <file.deb|file.AppImage>...
#       no ELF file inside needs a glibc symbol newer than <max> (e.g. 2.35)
#   bash scripts/release-smoke.sh deb <file.deb> [image]
#       installs it with apt in a clean container (default ubuntu:24.04) and checks that
#       every library of /usr/bin/tablemax resolves (needs docker)
#   bash scripts/release-smoke.sh appimage <file.AppImage> [seconds]
#       starts it under Xvfb (extract-and-run, no FUSE needed) with an empty HOME and checks
#       it is still running after <seconds> (default 15) (needs xvfb-run)
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

# Extracts a package into $2: the .deb's data, or the AppImage's squashfs.
extract() {
  local file="$1" dest="$2"
  mkdir -p "$dest"
  case "$file" in
    *.deb) dpkg-deb -x "$file" "$dest" ;;
    *.AppImage)
      local abs; abs="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
      chmod +x "$abs"
      (cd "$dest" && "$abs" --appimage-extract >/dev/null)
      ;;
    *) die "unknown package type: $file" ;;
  esac
}

# Highest GLIBC_x.y[.z] version referenced by an ELF file's dynamic symbols ("" if none).
max_glibc() {
  { objdump -T "$1" 2>/dev/null || true; } | { grep -o 'GLIBC_[0-9][0-9.]*' || true; } \
    | sed 's/GLIBC_//' | sort -uV | tail -1
}

cmd_glibc() {
  local max="$1"; shift
  [[ $# -gt 0 ]] || die "glibc: no package given"
  local tmp status=0 file f v
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' RETURN
  for file in "$@"; do
    local dest; dest="$tmp/$(basename "$file")"
    extract "$file" "$dest"
    local count=0 report="$tmp/report" worst worst_file
    : >"$report"
    while IFS= read -r -d '' f; do
      [[ "$(head -c 4 "$f" | od -An -tx1 | tr -d ' ')" == 7f454c46 ]] || continue
      count=$((count + 1))
      v="$(max_glibc "$f")"
      [[ -z "$v" ]] || printf '%s\t%s\n' "$v" "${f#"$dest"/}" >>"$report"
    done < <(find "$dest" -type f -print0)
    IFS=$'\t' read -r worst worst_file < <(sort -t $'\t' -k1,1V "$report" | tail -1) || true
    [[ $count -gt 0 ]] || die "$(basename "$file"): no ELF file found"
    if [[ "$(printf '%s\n%s\n' "$max" "${worst:-0}" | sort -V | tail -1)" != "$max" ]]; then
      echo "FAIL $(basename "$file"): $worst_file needs GLIBC_$worst (max $max)"
      status=1
    else
      echo "ok   $(basename "$file"): $count ELF files, newest glibc symbol ${worst:-none} (max $max)"
    fi
  done
  return "$status"
}

cmd_deb() {
  local file="$1" image="${2:-ubuntu:24.04}"
  [[ -f "$file" ]] || die "no such file: $file"
  local dir name
  dir="$(cd "$(dirname "$file")" && pwd)"; name="$(basename "$file")"
  docker run --rm -v "$dir:/pkg:ro" "$image" bash -euo pipefail -c "
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends '/pkg/$name' >/dev/null
    test -x /usr/bin/tablemax
    missing=\$(ldd /usr/bin/tablemax | grep 'not found' || true)
    if [ -n \"\$missing\" ]; then echo \"\$missing\"; exit 1; fi
    test -f /usr/share/applications/TableMax.desktop
    echo 'ok   $name installs on $image, every library resolves'
  "
}

cmd_appimage() {
  local file="$1" seconds="${2:-15}"
  [[ -f "$file" ]] || die "no such file: $file"
  chmod +x "$file"
  local abs home log rc=0
  abs="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
  home="$(mktemp -d)"; log="$home/app.log"
  # timeout exits 124 when it had to stop the app: the app was still running, which is the pass.
  HOME="$home" XDG_DATA_HOME="$home/.local/share" XDG_CONFIG_HOME="$home/.config" \
    APPIMAGE_EXTRACT_AND_RUN=1 GDK_BACKEND=x11 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
    xvfb-run -a timeout "$seconds" "$abs" >"$log" 2>&1 || rc=$?
  if [[ $rc -eq 124 ]]; then
    echo "ok   $(basename "$file") still running after ${seconds}s under Xvfb"
    rm -rf "$home"
  else
    echo "FAIL $(basename "$file") exited with $rc before ${seconds}s; its output:"
    tail -50 "$log"
    rm -rf "$home"
    return 1
  fi
}

case "${1:-}" in
  glibc) shift; [[ $# -ge 2 ]] || die "usage: glibc <max> <package>..."; cmd_glibc "$@" ;;
  deb) shift; [[ $# -ge 1 ]] || die "usage: deb <file.deb> [image]"; cmd_deb "$@" ;;
  appimage) shift; [[ $# -ge 1 ]] || die "usage: appimage <file.AppImage> [seconds]"; cmd_appimage "$@" ;;
  *) sed -n '2,12p' "$0" >&2; exit 2 ;;
esac

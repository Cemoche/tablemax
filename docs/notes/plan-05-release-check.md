# Plan 05 release check

Task 5 of Plan 5: Linux packaging (original icon, `.deb` + AppImage) and a manual smoke
test of the **release** build (Review Focus 4 and 5). Branch `feat/plan-05-safety`, on top
of Tasks 1–4 (settings and themes, safe mode, settings dialog). Build host: Ubuntu 26.04,
Rust release profile (LTO, `codegen-units = 1`, `strip`), tauri-cli 2.12.3.

## Icon

`assets/icon/tablemax.svg` is an original drawing made for TableMax: a blue rounded
square holding a light data grid (dark header row, 3×3 cells, one amber "selected" cell).
`scripts/gen-icons.sh` (`pnpm icons`) runs `pnpm tauri icon` on it from the repo root
(works from any directory), keeps the desktop sets only (the CLI's `android/` and `ios/`
outputs are removed) and prints the CLI log only on failure. Running it twice gives
byte-identical PNG/ICO files; `icon.icns` differs byte-wise between runs (CLI encoding),
not visually. Checked by eye at 512 px and 32 px.

## Build

`pnpm tauri build` (same as `pnpm build:app`): 6 min 36 s wall time (cold release build).

| Output | Path (under `src-tauri/target/release/`) | Size |
|---|---|---|
| Binary | `tablemax` | 18.5 MB (18,537,296 B) |
| Debian package | `bundle/deb/TableMax_0.1.0_amd64.deb` | 7.93 MiB (8,316,546 B) |
| AppImage | `bundle/appimage/TableMax_0.1.0_amd64.AppImage` | 88.96 MiB (93,284,856 B) |

- The AppImage step downloads linuxdeploy, its AppImage plugin and AppRun from GitHub on
  first use (cached afterwards); the build needs network access once.
- Frontend bundle: one JS chunk of 1,034.76 kB (Vite's > 500 kB warning, already noted
  in Plan 1) plus two small editor-overlay chunks and one CSS file.
- Tauri warns that the identifier `dev.tablemax.app` ends with `.app` (a macOS bundle
  extension clash). Harmless on Linux; changing it would move the app data directory,
  so it is left for the macOS work.
- `.deb` control: package `table-max` (kebab-case of the product name; the binary is
  `tablemax`), `Depends: libwebkit2gtk-4.1-0, libgtk-3-0`, `Maintainer: TableMax
  contributors` (from `Cargo.toml` authors), description from `shortDescription` /
  `longDescription`. Contents: `/usr/bin/tablemax`, `TableMax.desktop`
  (`Categories=Development;`, `Icon=tablemax`), hicolor icons 32, 128 and `256x256@2`
  (Tauri's name for the 128@2x icon). No `linux.deb.depends` override was needed.
- glibc floor (no package bundles libc): the binary requires glibc 2.39 (`objdump -T`),
  so the `.deb` runs on Ubuntu 24.04 (verified below). The AppImage bundles the build
  host's WebKitGTK, GLib… which require glibc 2.43, so it only runs on distributions as
  new as Ubuntu 26.04 (verified below; recorded in the README).

### `.deb` in a clean Ubuntu 24.04

```bash
docker run --rm -v "$PWD/src-tauri/target/release/bundle/deb":/pkg:ro ubuntu:24.04 bash -c \
  'apt-get update && apt-get install -y /pkg/*.deb; ldd /usr/bin/tablemax | grep "not found"; tablemax --version || true'
```

- apt resolved the declared dependencies: 277 packages newly installed
  (`libwebkit2gtk-4.1-0 2.52.6-0ubuntu0.24.04.1`; `libgtk-3-0` is satisfied by
  `libgtk-3-0t64`, which provides it). `dpkg -s table-max` → `install ok installed`.
- `ldd /usr/bin/tablemax | grep "not found"` → nothing: every shared library resolves.
- `tablemax --version`: the app has no CLI mode; with no display it panics with
  "Failed to initialize GTK" (expected, hence `|| true`).
- The desktop file and the three icons are installed under `/usr/share`.

### AppImage glibc floor (fix round 1)

The existing AppImage, mounted read-only into a clean `ubuntu:24.04` container
(glibc 2.39-0ubuntu8.9), copied and extracted there with `--appimage-extract`, then
`objdump -T` on each of its 178 ELF files (binary, 176 bundled `.so`, AppRun) and `ldd`
with `LD_LIBRARY_PATH=squashfs-root/usr/lib`:

- No `libc.so` / `ld-linux` is bundled: the AppImage uses the host glibc.
- Highest version needed: `GLIBC_2.43`, by `libwebkit2gtk-4.1.so.0`,
  `libjavascriptcoregtk-4.1.so.0`, `libglib-2.0.so.0`, `libgnutls.so.30`,
  `liblcms2.so.2` and `libjxl.so.0.11` (all from the 26.04 build host).
- `ldd usr/bin/tablemax` in the container: ``libc.so.6: version `GLIBC_2.43' not found
  (required by …/libglib-2.0.so.0)``, ``version `GLIBC_2.42' not found (required by
  …/libwebkit2gtk-4.1.so.0)``, plus ``libm.so.6: version `GLIBC_2.43' not found`` for
  four libraries. The AppImage does **not** run on Ubuntu 24.04.
- The other "not found" lines (`libX11`, `libGL`, `libEGL`, `libfontconfig`,
  `libwayland-client`…) are desktop libraries that linuxdeploy leaves out on purpose:
  they are absent from the minimal container, present on any desktop.

Verified floors for a 26.04 build: `.deb` glibc ≥ 2.39 (Ubuntu 24.04 checked); AppImage
glibc ≥ 2.43 (works on the 26.04 build host, fails on 24.04).

## Release smoke test (AppImage)

The AppImage (copied to the scratch directory) ran through FUSE (no
`APPIMAGE_EXTRACT_AND_RUN` needed) in a fully isolated session: `HOME`, `XDG_DATA_HOME`,
`XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR` (mode 700) and `TMPDIR` in a
scratch directory, `env -i` with only those plus `PATH`, a private Xvfb display `:57`
(1600×1000), `GDK_BACKEND=x11`, `WEBKIT_DISABLE_COMPOSITING_MODE=1`, a private
`dbus-run-session`. Driven with xdotool, checked on `import` screenshots. The real
`~/.local/share/dev.tablemax.app` and `~/.ssh/known_hosts` were not touched (mtimes
before and after: 12:56:16 and 2026-10-15 14:53:34). The demo SQLite database was
created with `sqlite3 <scratch>/home/demo/shop.sqlite < scripts/demo/sqlite.sql`
(`pnpm demo:db` would also seed the server containers).

### Verified
- **Launch**: the window "TableMax" (1400×900) shows the connection form with its
  styles (Tailwind CSS, tokens) applied.
- **SQLite connection**: New connection "Demo SQLite", driver SQLite (native GTK select
  popup), database file = the demo file → Test: "Connected — server 3.53.2" → Connect:
  workspace opens with the green banner "Demo SQLite · LOCAL", schema `main`, 5 tables
  and the view `vip_customers`.
- **Grid (Glide, canvas)**: `customers` → rows 1–300 of 2,500 rendered, NULLs greyed,
  numbers right-aligned, 54 ms.
- **Editor (CodeMirror)**: "+" → "Query 1"; a `select country, count(*) … group by
  country order by n desc; -- per country` is highlighted (keywords blue, numbers and
  `null` amber, comment grey italic); Ctrl+Enter → result grid "10 rows · 0 ms" (IT 236,
  FR 236, …). A first attempt, mangled by xdotool (the typed newline was lost, so the
  comment swallowed the rest), showed the SQLite error "no such column: country…" in the
  status line: the error path works too.
- **Theme switch with grid and editor open (Review Focus 4)**: Settings (⚙) shows
  System / Light / Dark, the other sections and "Version: 0.1.0" (IPC). With the query
  tab (editor + result grid) open, Dark → the dialog, editor, result grid, sidebar and
  tab bar turn dark at once; after Close, the editor text and the result are still there
  (no reload). `settings.json` in the scratch data dir holds `"theme": "dark"`. The
  `customers` tab in dark: the grid is dark. Light with the dialog open over the
  `customers` grid → the grid behind the dialog repaints light while mounted. System →
  light (the Xvfb session has no dark preference).
- **System follows the OS**: after a restart with the desktop reporting dark (see the
  AppImage note below), "System" renders the connection list, form and `customers` grid
  dark. Connections and the `system` setting survived the restarts.
- **Prod connection and safe mode**: second connection "Prod SQLite", environment
  `prod`, same file. The form's safe mode reads "Default (by environment): Confirm
  writes". Connect → red banner "Prod SQLite · PROD" with "Safe mode: confirm writes", window
  title `TableMax — Prod SQLite [PROD]`. Run all on
  `select 1; update customers set notes = 'smoke' where id = 1; select 2;` → "Confirm
  before running" listing the three statements, only statement 2 marked "Needs
  confirmation", "nothing has run yet". Cancel → no result, `notes` of id 1 still NULL
  (`sqlite3`). Run all again → Run → Result 1 / Result 2 tabs and "Statement 2: 1 row
  affected"; `notes` = `smoke` (also visible in the grid after the restart).

### CSP
The CSP is unchanged and nothing was loosened:
`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src
ipc: http://ipc.localhost`. `'unsafe-inline'` for styles was already there (CodeMirror
and Glide inject `<style>` elements and inline styles); scripts stay `'self'` only.

The WebKit console is not observable in a release build (no devtools; WebKitGTK does not
print console messages to stderr): stderr held only `libEGL` DRI3 warnings (Xvfb),
"GStreamer element appsink not found" (the AppImage leaves out the media framework,
`bundleMediaFramework: false`; the app plays no media) and the private D-Bus/portal logs —
no "Content Security Policy" / "Refused" line. The evidence is functional: the stylesheet
applied, the module script ran (React UI), IPC calls answered (Test, open, queries,
settings, version), CodeMirror highlighted and both Glide grids painted. A scan of `dist/`
finds no worker, `blob:`, `eval`, `new Function`, `@font-face` or remote URL; `index.html`
loads one module script and one stylesheet from `'self'`.

### AppImage and the GTK theme
The AppImage's GTK hook (`apprun-hooks/linuxdeploy-plugin-gtk.sh`) sets
`GTK_THEME=Adwaita:<variant>` from the portal setting `org.freedesktop.appearance
color-scheme` (or `gsettings … color-scheme`), defaulting to light. It therefore overrides
`GTK_THEME` and `~/.config/gtk-3.0/settings.ini` (both tried: still light), and WebKit's
`prefers-color-scheme` follows that theme. On a desktop set to dark it picks `:dark`; in
the headless check the dark desktop was simulated with
`APPIMAGE_GTK_THEME=Adwaita:dark` (the hook's override), which made "System" dark.

### Screenshots (not committed; session scratch directory `smoke/shots/`)
`01-launch`, `02-test-connection`, `03-grid-customers`, `04-query-light`,
`05-settings-light`, `06-settings-dark`, `07-query-dark`, `08-grid-dark`,
`09-grid-light-dialog-open`, `10-grid-light`, `11-query-system`, `12-prod-form`,
`13-prod-confirm`, `14-prod-cancelled`, `15-prod-confirmed`, `16-restart-system-dark`
(settings.ini attempt, still light), `17-system-gtk-dark` (`GTK_THEME` attempt, still
light), `18-system-adwaita-dark` (theme-name attempt, still light),
`19-system-follows-os-dark`, `20-system-dark-grid` (`.png`).

### Not manually verified
- The `.deb` app running on a desktop (installed and dependency-checked in the
  container, launched only as the AppImage here; same binary).
- Wayland (the check forces X11), server engines through the UI (Plan 2 checks; same
  code), keyring storage (SQLite needs no password).

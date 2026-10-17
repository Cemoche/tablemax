# Plan 02 manual check

Real app (debug build, `pnpm web` + `src-tauri/target/debug/tablemax`) on a private
Xvfb display, driven with xdotool and checked on screenshots. Test containers from
`scripts/test-dbs.sh up` (pg16 + sshd on 127.0.0.1:2222); the demo database
`tablemax_demo` already existed.

## Task 5 — SSL / SSH form, host key confirmation

Connection "Demo · PG via SSH": PostgreSQL, host `pg16:5432`, user `postgres`, database
`tablemax_demo`, DB password in the keyring; SSH tunnel `127.0.0.1:2222`, user `tunnel`,
password auth (`tunnel-pass`, keyring).

### Verified
- New connection: SSL mode starts at Prefer for `localhost`, switches to "Verify CA and
  host name" when the host becomes `pg16`, and back to Prefer when "SSH tunnel" is checked.
- SSH section: host / port / user / authentication / secret storage / SSH password fields.
- Connect: the connection is saved, then the "Unknown SSH host" dialog shows
  `127.0.0.1:2222` and `SHA256:qHEM/1Tujxa3G6eCWtVcUqHldv1/DupisKzW7d+MoyY`, the same
  fingerprint as `ssh-keyscan -p 2222 127.0.0.1 | ssh-keygen -lf -`.
- "Trust and connect": the workspace opens through the tunnel (schema `public`, 5 tables
  + 1 view; `customers` shows rows 1–300 of 2,500). The app's `known_hosts` now has the
  `[127.0.0.1]:2222 ssh-ed25519 …` line.
- Close the workspace, double-click the connection again: it opens with no prompt.
- `app.db` holds the SSL/SSH settings and neither password (`tunnel-pass`, `tablemax`).
- Ask-mode "Demo · Postgres 16": the "Password required" dialog (new SecretPrompt) opens;
  a wrong password shows `password authentication failed for user "postgres"`.

### Changed host key (Review Focus #2), seen by accident
The first run used the real `~/.ssh/known_hosts`, which holds hashed entries for
`[127.0.0.1]:2222` (lines 33–34) with an older key of the test sshd. Test was blocked with
"The SSH host key has changed: the server sent SHA256:qHEM/…, which differs from the key in
known_hosts…", and no prompt was offered. `~/.ssh/known_hosts` was left untouched; the
check above ran with `HOME` pointing at an empty scratch home (so `~/.ssh` was empty) and
`XDG_DATA_HOME=~/.local/share` (the real app data dir).

### Not manually verified
- Key and agent authentication, passphrase prompt, SSL file pickers (native dialog) and
  MySQL/MariaDB through the UI — covered by Vitest component tests and backend tests.

## Task 8 — final check (TLS, SSH, groups, URL, TablePlus import)

Debug build (`cargo build`, `pnpm web` + `src-tauri/target/debug/tablemax`) on a private
Xvfb display (`GDK_BACKEND=x11`), driven with xdotool, checked on screenshots. Fully
isolated session: `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and
`XDG_RUNTIME_DIR` in a scratch directory, a private D-Bus (`dbus-run-session`) with its
own unlocked `gnome-keyring-daemon`, no `SSH_AUTH_SOCK`. Nothing was written to the real
`~/.local/share/dev.tablemax.app`, `~/.ssh/known_hosts` or the user's keyring. Test
containers from `scripts/test-dbs.sh up`, with the sshd host key now generated once by
`scripts/test-secrets.sh` (`SHA256:hUMmwhvJd6o+rIX9A9IzS/ufX9vxzq/kXT0eCIHmtUA`; the same
fingerprint before and after `docker compose build --no-cache sshd` + recreate).
`pnpm demo:db` was not run (the check uses `tablemax_test`).

### Verified
- **TLS verify-full**: "Check · PG TLS" = PostgreSQL `localhost:54321`, mode "Verify CA and
  host name", CA picked through the native GTK picker (`.test-secrets/tls/ca.pem`).
  Test → "Connected — server 16.13"; Connect opens the workspace. Same settings with host
  `127.0.0.1` → "certificate not valid for name "127.0.0.1"; certificate is only valid
  for DnsName("localhost"), …" (the test cert has no IP SAN), as expected.
- **SSH, password auth**: "Check · PG via SSH" = PostgreSQL `pg16:5432` through
  `tunnel@127.0.0.1:2222`, SSH password in the keyring. Connect → "Unknown SSH host"
  `127.0.0.1:2222` with the fingerprint above → "Trust and connect" opens the workspace;
  the app's `known_hosts` holds the `[127.0.0.1]:2222 ssh-ed25519 …` line. Close +
  double-click → opens with no prompt (known key).
- **SSH, encrypted key**: same connection switched to "Private key", key file
  `.test-secrets/ssh/id_ed25519_enc` picked through the native picker, storage "Ask each
  time". Connect first asked to re-enter the DB password (identity changed, Plan-1
  inline message); then the "Key passphrase required" dialog; a wrong passphrase →
  "Wrong passphrase — try again"; `key-pass` → workspace opens.
- **Groups**: group "Checks" → sidebar sections CHECKS / UNGROUPED with counts; clicking
  the header folds it (▸, rows hidden) and unfolds it (▾).
- **Copy URL → New from URL…**: "URL copied (without the password)"; the clipboard held
  `postgresql://postgres@pg16:5432/tablemax_test?ssh=tunnel%40127.0.0.1%3A2222&ssh-auth=key`.
  Pasted into "New from URL…" → "Open form" prefilled PostgreSQL `pg16:5432`, user,
  database, SSL Prefer and the SSH tunnel `127.0.0.1:2222` (draft not saved).
- **Import TablePlus export…** ("+" menu, third item; fixtures in
  `src-tauri/tests/fixtures/tableplus/`, password `fixture-pass`):
  - `single-grouped`, password `wrong-password` → native picker (filter "TablePlus
    export") → "wrong password or corrupted file" on the first step with "Choose another
    file…" and "Try again". Retyped `fixture-pass` + "Try again" → no picker, preview of
    `fixture-grouped-mysql` (MySQL `127.0.0.1:3306`, "password" pill) → "Import 1
    connection" → "Imported 1 connection", the list reloaded.
  - `all-with-passwords` → 9 rows: `fixture-grouped-mysql` flagged "duplicate of
    fixture-grouped-mysql" (same name + identity) and `fixture-mysql` flagged "duplicate
    of fixture-grouped-mysql" (same identity: MySQL demo@127.0.0.1:3306), both unchecked;
    "password" / "SSH" pills, "via bastion.example.test", group "Fixture Group / Nested
    Group"; warning "fixture-ssh-key: SSH key file not included in the export: choose it
    in the connection settings". "Import 7 connections" → "Imported 7 connections"; the
    sidebar shows the new group "Fixture Group / Nested Group".
  - `all-without-passwords` → every row flagged as a duplicate and unchecked, "Import 0
    connections" disabled, two SSH key warnings; Cancel closes the dialog (the pending
    import is discarded; covered by Vitest and `discard_drops_the_pending_import`).
- **No secret in `app.db`**: `sqlite3 <scratch>/dev.tablemax.app/app.db .dump` (10
  connections) → `grep -c` = 0 for `tunnel-pass`, `key-pass`, `wrong-pass`,
  `fixture-pass`, `demo-pass`, `ssh-demo-pass`, `key-demo-pass` and for the quoted DB
  password `"tablemax"` / `'tablemax'` (the bare word also occurs in paths and database
  names). No file of the app data dir contains any of these secrets.

### Not manually verified
- MySQL/MariaDB through the UI, client certificates, agent auth: covered by backend tests.
- Keyring-unavailable import fallback (Ask mode + warning): covered by
  `unavailable_keyring_saves_in_ask_mode_with_warning` and the dialog test.

### Note for the real app data dir
The real `~/.local/share/dev.tablemax.app/known_hosts` (written during the Task 5 check)
still trusts the previous sshd key (`SHA256:qHEM/…`). With the new stable host key, the
demo SSH connection reports "The SSH host key has changed" once: remove the
`[127.0.0.1]:2222` line of that file (and the stale `~/.ssh/known_hosts` entries:
`ssh-keygen -R "[127.0.0.1]:2222"`), then trust the new key. From now on the key survives
image rebuilds.

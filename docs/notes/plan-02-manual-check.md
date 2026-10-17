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

## Final fix wave — MySQL 8 and MariaDB 11 in the real app

Debug build of the fix-wave branch (`cargo build`, `pnpm web` +
`src-tauri/target/debug/tablemax`) on a private Xvfb display (`GDK_BACKEND=x11`), driven
with xdotool and checked on screenshots. Isolated session: `HOME`, `XDG_DATA_HOME`,
`XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_RUNTIME_DIR` in a scratch directory, a
private `dbus-run-session` with its own unlocked `gnome-keyring-daemon`; every secret in
"Ask each time" mode, so the keyring held nothing. The real
`~/.local/share/dev.tablemax.app` and `~/.ssh/known_hosts` were not touched (their mtimes
predate the session). Test containers from `scripts/test-dbs.sh up`. A throwaway database
`tablemax_manual` (table `checks`, 3 rows) was created on both servers for the check and
dropped afterwards. The four connections were created in the form (not seeded).

### Verified
- **MySQL 8, direct, verify-full**: MySQL `localhost:33061`, user `root`, database
  `tablemax_manual`, password "Ask each time", SSL "Verify CA and host name" (the MySQL
  list has no "Verify CA", as intended), CA picked through the native GTK picker (a copy
  of `.test-secrets/tls/ca.pem` in the scratch home: typing the worktree path in the
  picker's location bar was mangled by GTK's autocompletion). Connect → "Password
  required" → `tablemax` → workspace opens; `checks` shows rows 1–3 of 3; a SQL tab
  running `select variable_value as tls, @@version … from
  performance_schema.session_status where variable_name = 'Ssl_version'` returns
  `TLSv1.3`, `8.4.11`.
- **MariaDB 11, direct, verify-full**: same on `localhost:33062` → table rows 1–3 of 3;
  the query (on `information_schema.session_status`) returns `TLSv1.3`,
  `11.4.12-MariaDB-ubu2404`.
- **MySQL 8 through the SSH tunnel**: host `mysql8:3306`, `root` / `tablemax` (Ask), SSH
  `127.0.0.1:2222`, user `tunnel`, password auth, "Ask each time". Enabling the tunnel
  switched the SSL mode from verify-full to Prefer (default for a tunnel); verify-full and
  the CA were then picked explicitly. Connect → "Password required" → "SSH password
  required": a wrong SSH password was given on purpose → "Unknown SSH host" dialog naming
  `127.0.0.1:2222`, with the new text "TableMax has no record of this server's key…" and
  `SHA256:hUMmwhvJd6o+rIX9A9IzS/ufX9vxzq/kXT0eCIHmtUA` (the stable test host key) →
  "Trust and connect" → the SSH password prompt came back with "The SSH password was not
  accepted" (final fix wave item 6; the flow used to end there) → `tunnel-pass` →
  workspace opens; `checks` rows 1–3 of 3. The query returns `TLSv1.3`,
  `root@172.28.0.3` (the sshd container's address: the connection went through the
  tunnel) and the mysql8 container's host name, so verify-full checked the certificate
  against `mysql8` while TCP went to the tunnel's local end. The app's `known_hosts` now
  holds `[127.0.0.1]:2222 ssh-ed25519 …`.
- **MariaDB 11 through the SSH tunnel**: host `mariadb11:3306`, same SSH settings, SSL
  left at the tunnel default (Prefer). No host-key prompt this time (key known). Table
  rows 1–3 of 3; the query returns `TLSv1.3` (Prefer negotiated TLS), `root@172.28.0.3`,
  `11.4.12-MariaDB-ubu2404`, `3`.
- **Require warning** (item 7): new PostgreSQL connection, host `db.example.com` (the
  mode became "Verify CA and host name" by itself), mode "Require (no verification)" →
  "The certificate of this host is not verified: traffic is encrypted, but anyone on the
  network path could pose as the server. Use a verify mode or an SSH tunnel."
- `app.db` (4 connections) and every file of the scratch app data dir: no `tunnel-pass`,
  `not-the-password`, `"tablemax"` nor `'tablemax'`.

### Observed, not changed
- Ctrl+T right after clicking a table in the sidebar created "Query 1" but left the
  table tab active (the "+" button of the tab bar opens and activates it). Plan 1
  behaviour, outside this wave.

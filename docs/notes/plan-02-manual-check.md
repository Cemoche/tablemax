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

# TableMax

A free, fast desktop database client. Tauri 2 + React + TypeScript + Rust.

## Development

Prerequisites (Ubuntu): `libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`, Node 22, pnpm, Rust, Docker.

```bash
pnpm install
pnpm dev          # tauri dev
pnpm test         # frontend tests (vitest)
pnpm test:rust    # starts test databases, runs cargo tests
pnpm lint         # tsc + clippy
```

## Connections

- **SSL / TLS**: modes `disable`, `prefer`, `require` (encrypted, certificate not checked),
  `verify-ca` (chain checked, not the name; PostgreSQL only for now) and `verify-full`
  (chain and host name). Optional CA, client certificate and key files. New connections
  default to `verify-full` for remote hosts and `prefer` for local hosts or SSH tunnels.
- **SSH tunnels**: password, private key (passphrase asked when the key is encrypted) or
  SSH agent. `~/.ssh/config` aliases are resolved (`HostName`, `User`, `Port`,
  `IdentityFile`). An unknown host key is shown as a `SHA256:…` fingerprint to confirm,
  then saved in the app's `known_hosts`; a changed key blocks the connection.
- **Groups**: connections can be filed under a group; groups fold in the sidebar.
- **URLs**: "Copy URL" in the form (never includes the password) and "+ → New from URL…"
  (`postgresql://`, `mysql://`, `mariadb://`, `sqlite://`; `sslmode`, `ssh`, `ssh-auth`
  parameters).
- **Import TablePlus export…** (in the "+" menu): reads a `.tableplusconnection` file
  with its export password, lists its connections (duplicates of existing ones are
  unchecked) and imports the chosen ones. Exports do not carry SSH key paths, SSL
  settings or colors: set them afterwards in the connection form.

Passwords, SSH passwords and key passphrases live only in the system keyring (or are
asked at each connect), never in `app.db`.

## Test databases

Host tools needed by `pnpm test:rust`: `docker compose` (v2), `openssl` and `ssh-keygen`
(test certificates and keys), `ssh-agent` and `ssh-add` (agent authentication test);
`pnpm demo:db` also needs `sqlite3`. Bind mounts carry the SELinux `z` option, so
Fedora/RHEL hosts work as is.

`scripts/test-dbs.sh up|down|env` manages PostgreSQL 16 (port 54321), MySQL 8.4 (33061),
MariaDB 11.4 (33062) and a test sshd (2222, user `tunnel`) via `docker-compose.test.yml`
(project `tablemax-test`). `up` first runs `scripts/test-secrets.sh`, which generates the
throwaway TLS certificates and SSH keys into `.test-secrets/` (gitignored; existing keys
are kept, missing ones are added). `scripts/test-dbs.sh env` prints the `TABLEMAX_TEST_*`
exports, and `scripts/test-dbs.sh down` stops the containers and deletes their volumes.
The test sshd host keys (Ed25519 and ECDSA) are generated once in `.test-secrets/ssh/host/`,
so their fingerprints survive image rebuilds. `pnpm demo:db` seeds a demo database and
registers demo connections.

### Two worktrees side by side

Each checkout has its own `.test-secrets/`. To run the tests of two worktrees at the same
time, give the second one its own compose project and host ports (the defaults are
`tablemax-test`, 54321, 33061, 33062 and 2222), and keep them set for every command:

```bash
export TABLEMAX_TEST_PROJECT=tablemax-test-b TABLEMAX_TEST_PG_PORT=55321 \
  TABLEMAX_TEST_MYSQL_PORT=34061 TABLEMAX_TEST_MARIADB_PORT=34062 TABLEMAX_TEST_SSH_PORT=3222
pnpm test:rust               # `env` then exports URLs with these ports
scripts/test-dbs.sh down     # stops this project only
```

`pnpm demo:db` follows the same variables.

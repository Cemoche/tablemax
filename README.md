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

## Test databases

`scripts/test-dbs.sh up|down|env` manages PostgreSQL 16 (port 54321), MySQL 8.4 (33061),
MariaDB 11.4 (33062) and a test sshd (2222, user `tunnel`) via `docker-compose.test.yml`
(project `tablemax-test`). `up` first runs `scripts/test-secrets.sh`, which generates the
throwaway TLS certificates and SSH keys into `.test-secrets/` (gitignored).
`scripts/test-dbs.sh env` prints the `TABLEMAX_TEST_*` exports.

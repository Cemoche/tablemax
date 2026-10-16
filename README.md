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

`scripts/test-dbs.sh up|down|env` manages PostgreSQL 16 (port 54321), MySQL 8.4 (33061)
and MariaDB 11.4 (33062) via `docker-compose.test.yml` (project `tablemax-test`).
`scripts/test-dbs.sh env` prints the `TABLEMAX_TEST_PG_URLS` / `TABLEMAX_TEST_MYSQL_URLS` exports.

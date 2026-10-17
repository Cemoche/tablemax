# Backend rules (`src-tauri/`)

Rust 1.96, edition 2024, Tauri 2, tokio. Library crate `tablemax_lib` (`src/lib.rs`).

## Modules (`src/`)

- `driver/` — `Session` / `Canceller` traits and one driver per engine: `postgres.rs`
  (tokio-postgres), `mysql.rs` (mysql_async, MySQL + MariaDB), `sqlite.rs` (rusqlite),
  shared SQL helpers `sql.rs`, TLS settings `tls.rs`. `meta.rs`: table metadata
  (`TableInfo`: columns, keys, indexes, foreign keys, row key). `query.rs`: parameterized
  grid statements (`Statement`/`SqlParam`, filters, page and capped filtered count).
  `dml.rs`: row changes from the grid (`RowChange` → UPDATE/INSERT/DELETE, display-only
  preview, full cell value statements); `Session::apply` runs them in one transaction.
- `ssh/` — tunnels with russh (`tunnel.rs`), `~/.ssh/config` aliases (`config.rs`),
  host key checks (`known_hosts.rs`).
- `import/` — connection import from other tools' exports (`tableplus.rs`, `rncryptor.rs`);
  parsed secrets stay in memory in the backend only.
- `manager.rs` — `SessionManager`: open workspaces, dedicated SQL sessions, batches,
  cancellation, secret resolution.
- `store.rs` — `ConnectionStore`: local SQLite `app.db` (connections without secrets).
- `safety.rs` — safe mode: statement classification (read / write, strict and fail-safe),
  effective mode per connection (prod defaults to confirm writes), which statements of a
  batch need a confirmation.
- `settings.rs` — user settings in `<app_data_dir>/settings.json` (versioned, written
  atomically, values clamped, unsafe editor font family reset to "").
- `secrets.rs` — `SecretStore` trait, `KeyringSecretStore` (OS keyring),
  `MemorySecretStore` (tests).
- `commands.rs` — Tauri commands, thin async wrappers over `SessionManager`. Their names
  and parameters are the frontend contract.
- `error.rs` — `AppError`; `value.rs` — typed cell values.

A new command = function in `commands.rs` + entry in `tauri::generate_handler!` in
`lib.rs` + wrapper in `src/lib/ipc.ts` + types in `src/lib/types.ts` (and
`src/lib/types.shape.test.ts`). Serde types use `#[serde(rename_all = "camelCase")]`.

## Errors

- Every fallible path returns `AppResult<T>` = `Result<T, AppError>`.
- `AppError { kind, message }` (plus optional `host` for host key errors), serialized as
  `{"kind": "...", "message": "..."}`. Kinds (`ErrorKind`): `Connection`, `Auth`, `Query`,
  `Cancelled`, `ConnectionLost`, `NotFound`, `Secret`, `Io`, `Invalid`, `HostKeyUnknown`,
  `HostKeyChanged`, `ConfirmationRequired`. Pick the kind the frontend should branch on; a
  new kind also goes into `ErrorKind` in `src/lib/types.ts`.
- `ConfirmationRequired`: `execute_batch` refuses an unconfirmed batch on a protected
  connection before anything of it runs (message: the indices to confirm). Grid commits
  (`changes_apply`) go through the same guard, every change counting as a write, before
  anything is built or the commit slot is taken. Any future write path must too
  (`safety::needs_confirmation` with the stricter-of-saved-and-opened mode of
  `workspace_safe_mode`, which fails closed to `ConfirmAll`).

## Async and I/O

- No blocking I/O on the async runtime: blocking work (rusqlite, keyring, file dialogs,
  file parsing) goes through `tokio::task::spawn_blocking` (in `manager.rs`: the
  `blocking()` helper).
- Never hold a `std::sync::Mutex` guard across an `.await` (see the locking note at the
  top of `manager.rs`).
- Every database operation stays cancellable (PG cancel token, MySQL `KILL QUERY`,
  SQLite interrupt).

## Secrets

- No secret in `Debug` output, error messages, logs or anything returned to the frontend.
  Types holding secrets get a hand-written `Debug` that prints `<redacted>` (examples:
  `HeldSecret` in `manager.rs`, `SshAuthMaterial` in `ssh/tunnel.rs`) and a test proving it.
- Secrets are read from the keyring right before connecting; they are never written to
  `app.db` or any file.

## TLS

- rustls with the `ring` provider only (`install_crypto_provider` in `driver/tls.rs`),
  never `aws-lc`: new TLS-related crates use `default-features = false` + their `ring`
  feature. Check with `grep -c aws-lc src-tauri/Cargo.lock` (must print 0).

## Tests

- Unit tests in `#[cfg(test)] mod tests` next to the code; integration tests in `tests/`
  (helpers in `tests/common/mod.rs`, TablePlus fixtures in `tests/fixtures/`).
- Integration tests run against real servers and read `TABLEMAX_TEST_*`
  (`TABLEMAX_TEST_PG_URLS`, `TABLEMAX_TEST_MYSQL_URLS`, `TABLEMAX_TEST_TLS_DIR`,
  `TABLEMAX_TEST_SSH`, `TABLEMAX_TEST_SSH_DIR`), printed by `scripts/test-dbs.sh env`.
  They panic with a hint when the variables are missing. Each test loops over every URL
  (the version matrix).
- Run everything: `pnpm test:rust`. One file, containers already up:
  `eval "$(scripts/test-dbs.sh env)" && cargo test --manifest-path src-tauri/Cargo.toml --test postgres_driver`.
  Unit tests only (no Docker): `cargo test --manifest-path src-tauri/Cargo.toml --lib`.
- Adding a server version = one service in `docker-compose.test.yml` + one URL in the
  `PG_URLS` / `MYSQL_URLS` list of `scripts/test-dbs.sh`.
- `pnpm lint` runs clippy with `-D warnings`: fix warnings instead of silencing them.
- Tauri permissions (`capabilities/default.json`) stay at `core:default`: file pickers are
  opened from Rust (`commands::file_pick`), so the webview gets no dialog permission.

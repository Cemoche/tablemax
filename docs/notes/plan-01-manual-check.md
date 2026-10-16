# Plan 01 manual check

Checked in the real app (Tauri dev build) by the controller.

## Verified
- SQLite batch "Run all": Result 1 grid, "Statement 2: 3 rows affected", "Statement 3: no such table: nope".
- PostgreSQL 16: the Ask-mode password prompt works.
- `select pg_sleep(30)` then Cancel: "Cancelled" and "Statement 1: canceling statement due to user request" in about 1 s.
- The password is absent from `app.db` (stored in the OS keyring only).
- Table grid (earlier sessions): paging, NULL vs `""`, binary preview, sort header, environment border.

## Deviations found
- Editor rendered with a light theme under the dark color scheme (fixed: theme="none" plus token-based theme).
- Floats are shown with full round-trip digits.
- The lang-sql keyword autocomplete popup appears; completion is planned for Plan 4.

## Not manually re-verified
- MySQL/MariaDB in the UI (covered by driver integration tests).

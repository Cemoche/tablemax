# Plan 2 — rulings and deferred follow-ups

Extracted from the SDD ledger at the end of Plan 2 (branch feat/plan-02-connections),
after the final fix wave. Deferred minors that the fix wave resolved are left out; lines
it resolved in part keep only what is still open.

## Rulings

### Pre-flight
- Ruling: T1 passes `SslConfig::default()` (Prefer) from connect_params until T4 adds ConnectionConfig.ssl — keeps T1 self-contained; Prefer on loopback is harmless — cost: none (T4 replaces it).
- Ruling: T6 builds the "+" menu with New connection / New from URL… only; T8 adds the "Import TablePlus export…" entry — avoids a dead menu item between tasks — cost: none.
- Ruling: MySQL Prefer plaintext fallback has no live test (all test servers run TLS); covered by code review only — cost: a fallback bug would surface only against TLS-less MySQL servers.
- Ruling: MySQL/MariaDB verify-ca not offered in v1 (mysql_async 0.37.1 bug, upstream PR #408 unreleased) — cost: users with CA-signed certs lacking the right name must use require until upstream releases.
- Ruling: plan 2 written and executed without waiting for user plan review — user goal: "Je te laisse gérer tout ça en autonomie" — cost: rework if the user disagrees with scope.

### Task 1 — TLS
- Ruling: security review (MEDIUM, unverified TLS once guard removed) accepted — T1 keeps ensure_local_host for dial None + Disable/Prefer/Require (message "unverified TLS is only allowed for local hosts…"; sent to T1 implementer mid-task); T4 removes the guard once modes are explicit; default mode = VerifyFull for remote non-SSH hosts (form, URL import, TablePlus import), Prefer otherwise — honours the Plan 1 ruling "verify by default for non-loopback" — cost: remote self-signed servers need the user to pick require/verify-ca explicitly.

### Task 2 — ~/.ssh/config and known_hosts
- Ruling: add HostKeyVerdict::Unverifiable{reason}; per file NotFound→nothing, Ok(true)→Known, Ok(false)→Unknown, KeyChanged→Changed, other Err→Unverifiable; reduce Changed>Unverifiable>Known>Unknown; T3 maps Unverifiable → Connection "cannot verify the SSH host key: <reason>" (no TOFU) — cost: a host-matching line with an unsupported key type in ~/.ssh/known_hosts blocks that host until the user fixes the line.
  - Updated by the final fix wave: per file, recorded keys for the host and none equal to the presented one → Changed (whatever the algorithm; russh's Ok(false) case), a file that exists but cannot be opened → Unverifiable; the client asks first for the algorithms known_hosts records (OpenSSH behaviour). A recorded algorithm russh cannot negotiate (DSA, `sk-*`) therefore reads as Changed.

### Task 3 — SSH tunnel
- Ruling: security review (MEDIUM, local forward listener on 127.0.0.1 accepts any local process) accepted as known limitation — same model as ssh -L / TablePlus; DB credentials still required; in-process streams possible for PG (connect_raw) but not mysql_async — cost if wrong: on a shared multi-user machine another local user can reach the DB port during a session. Follow-up: PG via connect_raw over ChannelStream later.

### Task 4 — manager
- Ruling: T4 key resolution falls back to ~/.ssh/id_ed25519, id_ecdsa, id_rsa like OpenSSH — needed because TablePlus exports omit the key path — cost: none.
- Ruling: security review (HIGH, ensure_local_host removed) — removal per plan stands; added fix: stored configs without `ssl` key get default_ssl_mode(host, ssh) (legacy remote → VerifyFull) — sent to T4 implementer, landed c2733bb — cost: a legacy remote config with self-signed cert must be switched to require explicitly.
- Ruling: plan Review Focus #1 ("ou recharger") wins over the brief's narrower test — browse lookup becomes async and reconnects through a reopened tunnel for SSH workspaces — cost: one more async path in the manager.
- Ruling: same_identity also compares ssl (mode + files) — closes TLS-downgrade reuse of keyring password via a frontend-supplied config — cost: user retypes password after editing SSL settings.
- Ruling: whole open_tunnel bounded by 30 s ("ssh connection timed out"); legacy ssl fixup skipped for SQLite — cost: none.

### Task 5 — form
- Ruling: SSH password auth offers Keyring/Ask only (None ≡ Ask) — brief listed None too — cost: none.
- Ruling: Save with an identity edit keeps Plan-1 inline "Re-enter…" message (prompts only in Test/Connect flows) — cost: one extra step on save.

### Task 6 — groups and URLs
- Ruling: URL gains `ssh-auth=key|agent` param (password default omitted); keyFile/secretMode not exported — cost: imported SSH key connections must re-pick the key file.
- Ruling: `user:pw` in the ssh URL param → password part dropped with a warning — cost: none.

### Task 7 — TablePlus import (backend)
- Ruling: TablePlus import mapping pinned in plan T7 from the research (nested groups flattened "A / B"; key-auth SSH imported with key_file None + warning; env from Tag/Enviroment; color/SSL defaults) — cost: imported connections may need manual touch-up (key file, color).
- Ruling: import_tableplus_commit returns ImportResult { saved, warnings } (not bare Vec) so keyring-unavailable fallbacks reach the UI — cost: T8 consumes the richer type.

### Task 8 — TablePlus import (UI)
- Ruling: T8 adds backend support to retry a preview without re-picking: the backend remembers the last picked export path (server-side, never from the webview) and `import_tableplus_preview(password, reusePick: bool)`; plus an `import_tableplus_discard(importId)` command called when the dialog closes (drops pending secrets eagerly) — cost: two small backend additions in T8.
- Ruling: stable sshd test host key generated by test-secrets.sh (fixes "host key changed" after image rebuilds) folded into T8 — cost: none.

## Deferred minors (to triage in Plans 3–5)
- Task 1: minor (deferred): tls.rs:152/293 "CA file holds an unusable certificate" lacks path
- Task 1: minor (deferred): blocking std::fs reads + OS root store loaded per connect inside async connect (spawn_blocking or cache)
- Task 1: minor (deferred): foreign-CA / no-client-cert tests assert only kind/is_err, not UnknownIssuer reason
- Task 1: minor (deferred): pg_cancel_long_query bound loosened 3s→4s via shared helper
- Task 1: minor (deferred): no test for MySQL Prefer cleartext retry nor VerifyFull-without-CA (OS roots) — unit test of ssl_opts per mode would pin options
- Task 1: minor (deferred): mysql_client_cert_is_presented leaks root session; needless install_crypto_provider in a unit test
- Task 2: minor (deferred): no comment that @revoked/@cert-authority are ignored (revoked key → Unknown); invalid Port value lets later block win; glob_match exponential backtracking
- Task 2: minor (deferred): Include `seen` not seeded with root file (one duplicate parse) and shared across chains (diamond expanded once)
- Task 3: minor (deferred): agent per-identity signing error aborts loop with Connection instead of trying next / auth failed (tunnel.rs:237-240)
- Task 3: minor (deferred): no timeout on SSH auth phase (silent server → ~90s then misleading "auth failed")
- Task 3: minor (deferred): blocking std::fs in async connect (key, known_hosts) — same as T1 deferral
- Task 3: minor (deferred): close() stopping listener not asserted; server-side dead session is_alive untested
- Task 3: minor (deferred): accept-error loop retries forever silently; forward failures dropped without log
- Task 3: minor (deferred): KnownHosts rebuilt field-by-field (derive Clone); test-secrets.sh `complete` fn name (sshd authorized_keys and the ssh-agent/ssh-add requirement: fixed/documented in the final fix wave)
- Task 4: minor (deferred): home dir resolved two ways (manager HOME vs tauri home_dir); manager.rs 1825 lines — move resolve_ssh_target to ssh module; save not atomic across secrets (pre-existing pattern); workspace_tunnel doc(hidden) pub (test-hooks feature?); only graceful tunnel close tested (keepalive detection untested); ssh_hosts_list returns AppResult (harmless)
- Task 4: minor (deferred): fresh.close() unbounded in closed-during-reconnect branch (the PG connect itself is now bounded by the final fix wave)
- Task 4: minor (deferred): intermittent manager_ssh failure once in 5 runs, not reproduced in 245 (possible sshd throttling)
- Task 5: minor (deferred): superseded open's side effect (workspace opened) still completes without view switch
- Task 6: minor (deferred): header toggle no-op during search; UrlImportDialog URL field shows password in clear; clipboard mock not restored; legacy MySQL verifyCa exports verify-ca
- Task 6: minor (deferred): invalid sslmode warning also for libpq `allow`; ssh-auth without ssh silently ignored; ssh username with ':' doesn't round-trip
- Task 7: minor (deferred): pending import expiry is lazy (secrets in memory until next access) — drop on dialog close in T8 or timer
- Task 7: minor (deferred): best-effort cleanup may orphan a keyring secret under an unsaved UUID; options byte check accepts any bit0-set value (use == 1); `secret()` helper used for DatabaseName; secrets not zeroized
- Task 7: minor (plan-mandated, noted): password-less export maps SSH-password connections to Key auth + key-file warning (export can't tell them apart)
- Task 8: minor (deferred): close/Escape live during commit → discard can race the commit (disable while busy); LastPick never cleared (clear on discard/commit); untested !mounted discard branch; discard .catch comment; agent auth not UI-checked (MySQL/MariaDB: see plan-02-manual-check.md, final fix wave)

## Notes from the final fix wave
- The connection form's Test flow treats an SSH secret as stored whenever the edited
  connection is saved with keyring mode; after an identity edit the backend does not read
  it, so a "passphrase required" there shows the "Wrong passphrase" text although no
  stored passphrase was tried.
- The host-key prompt now shows the resolved `host:port` the backend checked (the alias
  is no longer shown when `~/.ssh/config` maps it).

## Residuals from the final fix-wave re-review
- known_hosts: per-file evaluation reports Changed when `~/.ssh/known_hosts` and the app file record different algorithms for the same host (fails closed; false alarm). Rule to adopt: Known if some file records the presented key and no file records a same-algorithm different key.
- `src-tauri/tests/ssh_tunnel.rs:276` (`unverifiable_known_hosts_blocks_without_trusting`) hard-codes `[127.0.0.1]:2222`; use `ssh_addr()` so side-by-side stacks pass.
- `manager.rs` `unbind_stale_keyring`: the identity check runs before the tunnel slot lock and the (≤30 s) reopen; re-check right before each keyring read.

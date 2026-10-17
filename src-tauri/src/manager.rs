//! Session manager: owns the open workspaces (one browse connection each) and the
//! dedicated SQL sessions, runs statement batches and cancels them.
//!
//! Locking: the state map sits behind a std mutex that is only held for map
//! lookups/updates, never across an `.await` on database I/O. Each SQL session keeps
//! its `Arc<dyn Session>` and `Arc<dyn Canceller>` so a batch and a cancel can run
//! concurrently without touching the map.
//!
//! Secrets (DB password, SSH password or key passphrase): resolved (argument, else OS
//! keyring) right before connecting; nothing is cached for keyring-only workspaces —
//! opening a SQL session re-reads the keyring. A secret typed by the user when the
//! workspace was opened (`Ask` mode, or an explicit override) cannot be re-read from
//! anywhere, so it is kept in memory in the workspace entry as a [`HeldSecret`]
//! (no `Debug` output, not serializable) until the workspace is closed.
//!
//! SSH: a workspace whose connection has `ssh` settings opens one tunnel; the browse
//! connection, every SQL session and every cancel request dial its local end
//! (`ConnectParams.dial`) while `host` stays the DB host as seen from the SSH server
//! (also the TLS name). A SQL session opened after the tunnel died reopens it.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use tokio::time::Instant;

use crate::driver::dml::{
    ApplyOutcome, RowChange, RowKey, STALE_ROW, build_cell_size, build_cell_value, build_change,
    render_preview, suggests_schema_change,
};
use crate::driver::meta::TableInfo;
use crate::driver::query::{Filter, Statement, build_filtered_count, build_page, read_count};
use crate::driver::{
    self, Canceller, ConnectParams, Dialect, DriverKind, ObjectRef, PageRequest, ResultSet,
    RowCount, Session, StatementOutcome,
};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::import::{self, IMPORT_TTL, ImportPreview, ImportResult, LastPick, PendingImports};
use crate::secrets::{SecretKey, SecretKind, SecretStore};
use crate::ssh::config::{SshConfigFile, user_config};
use crate::ssh::known_hosts::KnownHosts;
use crate::ssh::target::{home_dir, resolve_ssh_target};
use crate::ssh::tunnel::{self, HostKeyPolicy, SshTunnel};
use crate::store::{
    self, ConnectionConfig, ConnectionStore, PasswordMode, SshSettings, same_identity,
};
use crate::value::{CellValue, EXACT_COUNT_THRESHOLD, FILTERED_COUNT_CAP, MAX_EDIT_BYTES};

/// How often a pending cancel is re-sent while the statement is still running.
pub const CANCEL_RESEND_INTERVAL: Duration = Duration::from_millis(100);
/// Upper bound on how long `cancel` keeps re-sending.
pub const CANCEL_TIMEOUT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(10);
/// Upper bound on opening an SSH tunnel (config, connect, key exchange, auth), so a
/// stalled server cannot hold a workspace (and its close) forever.
pub const SSH_OPEN_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub workspace_id: String,
    pub connection_id: String,
    pub dialect: Dialect,
    pub server_version: String,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "event",
    content = "data",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ExecEvent {
    StatementStarted {
        index: usize,
    },
    StatementFinished {
        index: usize,
        outcome: StatementOutcome,
    },
    StatementFailed {
        index: usize,
        error: AppError,
    },
    BatchFinished {
        cancelled: bool,
    },
}

/// A secret typed by the user, kept only for the lifetime of its workspace.
/// Deliberately not `Serialize`, and its `Debug` output never shows the value.
struct HeldSecret(String);

impl std::fmt::Debug for HeldSecret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HeldSecret(<redacted>)")
    }
}

/// The workspace's SSH tunnel: `Some` from opening to closing for an SSH connection,
/// `None` without SSH or once closed. Async lock, held while a dead tunnel is
/// reopened (and while the browse connection is rebuilt on it), so concurrent
/// callers open a single new one.
type TunnelSlot = Arc<tokio::sync::Mutex<Option<Arc<SshTunnel>>>>;

struct Workspace {
    config: ConnectionConfig,
    held_password: Option<HeldSecret>,
    held_ssh_secret: Option<HeldSecret>,
    tunnel: TunnelSlot,
    browse: Arc<dyn Session>,
    /// The tunnel `browse` was connected through; once it is dead, `browse` is rebuilt.
    browse_tunnel: Option<Arc<SshTunnel>>,
    sql_sessions: Vec<String>,
    /// Table metadata read through `browse`, by (schema, name); dropped with the workspace.
    table_info: HashMap<(Option<String>, String), Arc<TableInfo>>,
    /// Bumped by every invalidation: a read that started before one is not cached.
    table_info_gen: u64,
}

/// A workspace's reconnect parameters (held secrets are copies, dropped after use).
struct Reconnect {
    config: ConnectionConfig,
    password: Option<String>,
    ssh_secret: Option<String>,
    slot: TunnelSlot,
}

/// Control flags of one batch. A fresh one is installed for every batch, so no flag
/// can carry over from a previous batch.
#[derive(Default)]
struct BatchCtl {
    /// Cancel was requested: run no further statements.
    cancel_requested: AtomicBool,
    /// A statement is in flight (or about to start) on the driver.
    in_statement: AtomicBool,
    /// A cancel loop is re-sending cancels for this batch (dedupes the loop only).
    cancelling: AtomicBool,
}

struct SqlSession {
    workspace_id: String,
    session: Arc<dyn Session>,
    canceller: Arc<dyn Canceller>,
    /// The running batch, if any. Short lock, never held across `.await`.
    current: Mutex<Option<Arc<BatchCtl>>>,
    /// Cancel loops still alive on this session (they may outlive their batch while a
    /// re-sent cancel is in flight); a new batch waits for them before its first statement.
    resend_loops: AtomicUsize,
}

impl SqlSession {
    fn new(workspace_id: &str, session: Arc<dyn Session>) -> Self {
        Self {
            workspace_id: workspace_id.to_string(),
            canceller: session.canceller(),
            session,
            current: Mutex::new(None),
            resend_loops: AtomicUsize::new(0),
        }
    }

    fn current(&self) -> MutexGuard<'_, Option<Arc<BatchCtl>>> {
        self.current.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Uninstalls the batch's ctl when the batch ends (also on panic or drop).
struct EndBatch<'a>(&'a SqlSession, Arc<BatchCtl>);

impl Drop for EndBatch<'_> {
    fn drop(&mut self) {
        self.1.in_statement.store(false, SeqCst);
        let mut cur = self.0.current();
        if cur.as_ref().is_some_and(|c| Arc::ptr_eq(c, &self.1)) {
            *cur = None;
        }
    }
}

/// Decrements the session's live cancel-loop count and frees the batch's loop slot.
struct EndResendLoop<'a>(&'a SqlSession, &'a BatchCtl);

impl Drop for EndResendLoop<'_> {
    fn drop(&mut self) {
        self.1.cancelling.store(false, SeqCst);
        self.0.resend_loops.fetch_sub(1, SeqCst);
    }
}

#[derive(Default)]
struct State {
    workspaces: HashMap<String, Workspace>,
    sessions: HashMap<String, Arc<SqlSession>>,
}

pub struct SessionManager {
    store: Arc<ConnectionStore>,
    secrets: Arc<dyn SecretStore>,
    known_hosts: KnownHosts,
    /// Replaces `~/.ssh/config` (tests); otherwise it is re-read at each connect.
    ssh_config: Option<Arc<SshConfigFile>>,
    /// Previewed imports (with their secrets) waiting for a commit.
    imports: PendingImports,
    /// The export file last picked for an import, re-read by a retry.
    import_pick: LastPick,
    state: Mutex<State>,
}

fn workspace_not_found(id: &str) -> AppError {
    AppError::new(ErrorKind::NotFound, format!("workspace {id} not found"))
}

fn session_not_found(id: &str) -> AppError {
    AppError::new(ErrorKind::NotFound, format!("SQL session {id} not found"))
}

/// Runs blocking work (SQLite store, OS keyring) off the async runtime threads.
async fn blocking<T, F>(f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?
}

/// Connects with `cfg`, dialing `tunnel`'s local end when there is one (`host` stays
/// the DB host as seen from the SSH server, which is also the TLS name).
async fn connect(
    cfg: &ConnectionConfig,
    password: Option<String>,
    tunnel: Option<&SshTunnel>,
) -> AppResult<Arc<dyn Session>> {
    driver::connect(&ConnectParams {
        kind: cfg.kind,
        host: cfg.host.clone(),
        port: cfg.port,
        user: cfg.user.clone(),
        password,
        database: cfg.database.clone(),
        sqlite_path: cfg.sqlite_path.as_ref().map(Into::into),
        ssl: cfg.ssl.clone(),
        dial: tunnel.map(SshTunnel::local_addr),
    })
    .await
}

/// Bounds `fut` by [`SSH_OPEN_TIMEOUT`] (Connection "ssh connection timed out").
async fn with_ssh_timeout<T>(fut: impl Future<Output = AppResult<T>>) -> AppResult<T> {
    tokio::time::timeout(SSH_OPEN_TIMEOUT, fut)
        .await
        .unwrap_or_else(|_| {
            Err(AppError::new(
                ErrorKind::Connection,
                "ssh connection timed out",
            ))
        })
}

/// The SSH settings that apply to `cfg` (SQLite never uses a tunnel).
fn ssh_of(cfg: &ConnectionConfig) -> Option<&SshSettings> {
    cfg.ssh.as_ref().filter(|_| cfg.kind != DriverKind::Sqlite)
}

/// Requests cancellation of the batch running on `entry` (no-op when idle).
/// Records `cancel_requested` on the batch first (so no further statement starts,
/// even if another cancel loop is already active), then sends the driver cancel and
/// re-sends it every [`CANCEL_RESEND_INTERVAL`] until the in-flight statement
/// returns, for at most [`CANCEL_TIMEOUT`]. Only the re-send loop is deduplicated.
/// On timeout the request stays recorded (the batch stops after the statement); the
/// last canceller error, if any, is returned.
async fn request_cancel(entry: &SqlSession) -> AppResult<()> {
    let Some(ctl) = entry.current().clone() else {
        return Ok(());
    };
    ctl.cancel_requested.store(true, SeqCst);
    if ctl.cancelling.swap(true, SeqCst) {
        // Another loop is already re-sending for this batch.
        return Ok(());
    }
    // Count the loop before reading `in_statement`: a batch starting after this point
    // waits for the loop, so a late re-send cannot hit its first statement.
    entry.resend_loops.fetch_add(1, SeqCst);
    let _end = EndResendLoop(entry, &ctl);
    let deadline = Instant::now() + CANCEL_TIMEOUT;
    let mut last_err = None;
    while ctl.in_statement.load(SeqCst) {
        let now = Instant::now();
        if now >= deadline {
            return last_err.map_or(Ok(()), Err);
        }
        last_err = match tokio::time::timeout(deadline - now, entry.canceller.cancel()).await {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(e),
            Err(_) => Some(AppError::new(
                ErrorKind::Connection,
                "cancel request timed out",
            )),
        };
        let next = (now + CANCEL_RESEND_INTERVAL).min(deadline);
        while ctl.in_statement.load(SeqCst) && Instant::now() < next {
            tokio::time::sleep(POLL).await;
        }
    }
    Ok(())
}

/// Stops whatever runs on the session, then closes its connection.
async fn shutdown_sql(entry: &SqlSession) -> AppResult<()> {
    let _ = request_cancel(entry).await;
    entry.session.close().await
}

impl SessionManager {
    /// `known_hosts`: the system file (read only) and the app file (written when the
    /// user trusts a host key).
    pub fn new(
        store: Arc<ConnectionStore>,
        secrets: Arc<dyn SecretStore>,
        known_hosts: KnownHosts,
    ) -> Self {
        Self {
            store,
            secrets,
            known_hosts,
            ssh_config: None,
            imports: PendingImports::new(IMPORT_TTL),
            import_pick: LastPick::default(),
            state: Mutex::new(State::default()),
        }
    }

    /// Keeps previewed imports committable for `ttl` instead of [`IMPORT_TTL`].
    pub fn with_import_ttl(mut self, ttl: Duration) -> Self {
        self.imports = PendingImports::new(ttl);
        self
    }

    /// Resolves SSH aliases with `config` instead of `~/.ssh/config`.
    pub fn with_ssh_config(mut self, config: SshConfigFile) -> Self {
        self.ssh_config = Some(Arc::new(config));
        self
    }

    fn state(&self) -> MutexGuard<'_, State> {
        // Map updates never panic half-way, so a poisoned lock still holds consistent data.
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn sql_entry(&self, session_id: &str) -> AppResult<Arc<SqlSession>> {
        self.state()
            .sessions
            .get(session_id)
            .cloned()
            .ok_or_else(|| session_not_found(session_id))
    }

    pub async fn list_connections(&self) -> AppResult<Vec<ConnectionConfig>> {
        let store = self.store.clone();
        blocking(move || store.list()).await
    }

    pub async fn save_connection(
        &self,
        cfg: ConnectionConfig,
        password: Option<String>,
        ssh_secret: Option<String>,
    ) -> AppResult<ConnectionConfig> {
        let (st, sec) = (self.store.clone(), self.secrets.clone());
        blocking(move || store::save_connection(&st, sec.as_ref(), cfg, password, ssh_secret)).await
    }

    /// Reads the TablePlus export at `path` (decrypted with `password`) and keeps its
    /// entries, secrets included, as a pending import; the preview carries no secret.
    pub async fn import_tableplus_preview(
        &self,
        path: PathBuf,
        password: String,
    ) -> AppResult<ImportPreview> {
        let store = self.store.clone();
        let (entries, warnings, existing) = blocking(move || {
            let data = import::read_export(&path)?;
            let plain = import::rncryptor::decrypt(&data, &password)?;
            let (entries, warnings) = import::tableplus::parse_export(&plain)?;
            Ok((entries, warnings, store.list()?))
        })
        .await?;
        let items = import::preview_items(&entries, &existing);
        let import_id = self.imports.insert(entries);
        Ok(ImportPreview {
            import_id,
            items,
            warnings,
        })
    }

    /// [`Self::import_tableplus_preview`] of the file [`LastPick::resolve`] gives: the
    /// last picked one when `reuse_pick` (a retry with another password), else the one
    /// `pick` returns. `None` when the picker is cancelled.
    pub async fn import_tableplus_preview_picked<F, Fut>(
        &self,
        password: String,
        reuse_pick: bool,
        pick: F,
    ) -> AppResult<Option<ImportPreview>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = AppResult<Option<PathBuf>>>,
    {
        let Some(path) = self.import_pick.resolve(reuse_pick, pick).await? else {
            return Ok(None);
        };
        self.import_tableplus_preview(path, password)
            .await
            .map(Some)
    }

    /// Drops a pending import and its secrets (unknown or expired id: nothing to do).
    pub fn import_tableplus_discard(&self, import_id: &str) {
        self.imports.discard(import_id);
    }

    /// Saves the entries of a pending import at `indexes` and drops the import (NotFound
    /// "import expired" when unknown or older than its TTL).
    pub async fn import_tableplus_commit(
        &self,
        import_id: &str,
        indexes: &[usize],
    ) -> AppResult<ImportResult> {
        let entries = self.imports.take(import_id, indexes)?;
        let (st, sec) = (self.store.clone(), self.secrets.clone());
        blocking(move || Ok(import::commit_entries(&st, sec.as_ref(), entries))).await
    }

    /// Concrete host aliases of `~/.ssh/config`.
    pub async fn ssh_hosts(&self) -> AppResult<Vec<String>> {
        let config = self.ssh_config.clone();
        blocking(move || Ok(config.unwrap_or_else(|| Arc::new(user_config())).aliases())).await
    }

    pub async fn delete_connection(&self, id: &str) -> AppResult<()> {
        let (st, sec, id) = (self.store.clone(), self.secrets.clone(), id.to_string());
        blocking(move || store::delete_connection(&st, sec.as_ref(), &id)).await
    }

    /// Password for connecting with `cfg`: SQLite → always none (the keyring is never
    /// touched); `None` mode → none; `Ask` → the argument or an Auth error (before any
    /// network I/O); `Keyring` → the argument if given, else the stored secret (only for
    /// saved configs, i.e. non-empty id).
    ///
    /// `cfg` must be the stored config for `cfg.id` (or have an empty id): callers
    /// holding a frontend-supplied config check `same_identity` first.
    async fn resolve_password(
        &self,
        cfg: &ConnectionConfig,
        password: Option<String>,
    ) -> AppResult<Option<String>> {
        if cfg.kind == DriverKind::Sqlite {
            return Ok(None);
        }
        match cfg.password_mode {
            PasswordMode::None => Ok(None),
            PasswordMode::Ask => password
                .map(Some)
                .ok_or_else(|| AppError::new(ErrorKind::Auth, "password required")),
            PasswordMode::Keyring => {
                if password.is_some() || cfg.id.is_empty() {
                    return Ok(password);
                }
                let secrets = self.secrets.clone();
                let key = SecretKey::new(cfg.id.clone(), SecretKind::DbPassword);
                blocking(move || secrets.get(&key)).await
            }
        }
    }

    /// SSH secret for `ssh` (password or passphrase; none for the agent): the argument
    /// if given (whatever the mode), else the stored secret in `Keyring` mode for saved
    /// configs (non-empty id), else none.
    ///
    /// Same contract as [`Self::resolve_password`] for `cfg`.
    async fn resolve_ssh_secret(
        &self,
        cfg: &ConnectionConfig,
        ssh: &SshSettings,
        secret: Option<String>,
    ) -> AppResult<Option<String>> {
        let Some(kind) = ssh.secret_kind() else {
            return Ok(None);
        };
        if secret.is_some() || ssh.secret_mode != PasswordMode::Keyring || cfg.id.is_empty() {
            return Ok(secret);
        }
        let secrets = self.secrets.clone();
        let key = SecretKey::new(cfg.id.clone(), kind);
        blocking(move || secrets.get(&key)).await
    }

    /// Opens the SSH tunnel of `cfg` to its DB `host:port`, or `None` without SSH.
    /// Bounded by [`SSH_OPEN_TIMEOUT`].
    async fn open_tunnel(
        &self,
        cfg: &ConnectionConfig,
        ssh_secret: Option<String>,
        accept_fingerprint: Option<String>,
    ) -> AppResult<Option<Arc<SshTunnel>>> {
        let Some(ssh) = ssh_of(cfg) else {
            return Ok(None);
        };
        with_ssh_timeout(async {
            let secret = self.resolve_ssh_secret(cfg, ssh, ssh_secret).await?;
            let (config, ssh) = (self.ssh_config.clone(), ssh.clone());
            let target = blocking(move || {
                let config = config.unwrap_or_else(|| Arc::new(user_config()));
                resolve_ssh_target(&ssh, &config, home_dir().as_deref(), secret)
            })
            .await?;
            let policy = HostKeyPolicy {
                known_hosts: KnownHosts {
                    system: self.known_hosts.system.clone(),
                    app: self.known_hosts.app.clone(),
                },
                accept_fingerprint,
            };
            tunnel::open_tunnel(&target, &cfg.host, cfg.port, &policy).await
        })
        .await
        .map(Some)
    }

    /// The workspace's live tunnel (`None` without SSH), reopened with `held_secret` or
    /// the keyring when it died. A closed workspace is NotFound.
    async fn live_tunnel(
        &self,
        workspace_id: &str,
        config: &ConnectionConfig,
        slot: &TunnelSlot,
        held_secret: Option<String>,
    ) -> AppResult<Option<Arc<SshTunnel>>> {
        if ssh_of(config).is_none() {
            return Ok(None);
        }
        let mut current = slot.lock().await;
        self.revive_tunnel(workspace_id, config, &mut current, held_secret)
            .await
            .map(Some)
    }

    /// `current` (the locked slot of an SSH workspace) if alive, else a new tunnel
    /// stored in its place (the dead one is closed). `None` = workspace closed.
    async fn revive_tunnel(
        &self,
        workspace_id: &str,
        config: &ConnectionConfig,
        current: &mut Option<Arc<SshTunnel>>,
        held_secret: Option<String>,
    ) -> AppResult<Arc<SshTunnel>> {
        match current.as_ref() {
            None => return Err(workspace_not_found(workspace_id)),
            Some(t) if t.is_alive() => return Ok(t.clone()),
            Some(_) => {}
        }
        // The host key was confirmed when the workspace was opened: no new trust here.
        let fresh = self
            .open_tunnel(config, held_secret, None)
            .await?
            .ok_or_else(|| AppError::new(ErrorKind::Invalid, "no SSH settings"))?;
        if let Some(dead) = current.replace(fresh.clone()) {
            dead.close().await;
        }
        Ok(fresh)
    }

    /// Connects with `cfg` (saved or not), returns the server version, disconnects
    /// (and closes the tunnel when `cfg` goes through SSH).
    ///
    /// `cfg` comes from the frontend and may differ from what is stored under
    /// `cfg.id`: keyring secrets (DB password, SSH secret) are only reused when the
    /// connection identity (`same_identity`: server, account and SSH target) matches
    /// the stored config, so an edited config can never send a stored secret
    /// elsewhere. Otherwise the DB password must be given (Auth "password required",
    /// before any I/O) and the SSH secret is treated as not stored.
    pub async fn test_connection(
        &self,
        cfg: &ConnectionConfig,
        password: Option<String>,
        ssh_secret: Option<String>,
        accept_fingerprint: Option<String>,
    ) -> AppResult<String> {
        let mut cfg = cfg.clone();
        if cfg.kind == DriverKind::Sqlite {
            // No password, no keyring, no tunnel, no stored identity to check.
            let session = connect(&cfg, None, None).await?;
            let version = session.server_version();
            let _ = session.close().await;
            return Ok(version);
        }
        let db_from_keyring = cfg.password_mode == PasswordMode::Keyring && password.is_none();
        let ssh_from_keyring = ssh_secret.is_none()
            && cfg.ssh.as_ref().is_some_and(|s| {
                s.secret_kind().is_some() && s.secret_mode == PasswordMode::Keyring
            });
        if (db_from_keyring || ssh_from_keyring) && !cfg.id.is_empty() {
            let store = self.store.clone();
            let id = cfg.id.clone();
            match blocking(move || store.get(&id)).await {
                Ok(stored) if same_identity(&stored, &cfg) => {}
                Ok(_) if db_from_keyring => {
                    return Err(AppError::new(ErrorKind::Auth, "password required"));
                }
                // Another target: no stored secret may be read for it.
                Ok(_) => cfg.id.clear(),
                // Not saved: there is no stored identity to bind a secret to.
                Err(e) if e.kind == ErrorKind::NotFound => cfg.id.clear(),
                Err(e) => return Err(e),
            }
        }
        let cfg = &cfg;
        let password = self.resolve_password(cfg, password).await?;
        let tunnel = self
            .open_tunnel(cfg, ssh_secret, accept_fingerprint)
            .await?;
        let result = match connect(cfg, password, tunnel.as_deref()).await {
            Ok(session) => {
                let version = session.server_version();
                let _ = session.close().await;
                Ok(version)
            }
            Err(e) => Err(e),
        };
        if let Some(t) = tunnel {
            t.close().await;
        }
        result
    }

    /// Opens a workspace on the saved connection: SSH tunnel first when configured
    /// (`accept_fingerprint` trusts an unknown host key the user confirmed), then the
    /// browse connection through it.
    pub async fn open_workspace(
        &self,
        connection_id: &str,
        password: Option<String>,
        ssh_secret: Option<String>,
        accept_fingerprint: Option<String>,
    ) -> AppResult<WorkspaceInfo> {
        let store = self.store.clone();
        let id = connection_id.to_string();
        let config = blocking(move || store.get(&id)).await?;
        let held_password = match config.password_mode {
            PasswordMode::None => None,
            _ if config.kind == DriverKind::Sqlite => None,
            _ => password.clone().map(HeldSecret),
        };
        let held_ssh_secret = ssh_of(&config)
            .and_then(SshSettings::secret_kind)
            .and(ssh_secret.clone())
            .map(HeldSecret);
        let resolved = self.resolve_password(&config, password).await?;
        let tunnel = self
            .open_tunnel(&config, ssh_secret, accept_fingerprint)
            .await?;
        let browse = match connect(&config, resolved, tunnel.as_deref()).await {
            Ok(browse) => browse,
            Err(e) => {
                if let Some(t) = tunnel {
                    t.close().await;
                }
                return Err(e);
            }
        };
        let info = WorkspaceInfo {
            workspace_id: uuid::Uuid::new_v4().to_string(),
            connection_id: config.id.clone(),
            dialect: browse.dialect(),
            server_version: browse.server_version(),
        };
        self.state().workspaces.insert(
            info.workspace_id.clone(),
            Workspace {
                config,
                held_password,
                held_ssh_secret,
                browse_tunnel: tunnel.clone(),
                tunnel: Arc::new(tokio::sync::Mutex::new(tunnel)),
                browse,
                sql_sessions: Vec::new(),
                table_info: HashMap::new(),
                table_info_gen: 0,
            },
        );
        Ok(info)
    }

    /// Closes the workspace, its SQL sessions (cancelling running batches), its
    /// browse connection, then its SSH tunnel. Every close is attempted; the first
    /// error is returned.
    pub async fn close_workspace(&self, workspace_id: &str) -> AppResult<()> {
        let (ws, sessions) = {
            let mut st = self.state();
            let ws = st
                .workspaces
                .remove(workspace_id)
                .ok_or_else(|| workspace_not_found(workspace_id))?;
            let sessions: Vec<_> = ws
                .sql_sessions
                .iter()
                .filter_map(|id| st.sessions.remove(id))
                .collect();
            (ws, sessions)
        };
        let mut first_err = None;
        for s in sessions {
            if let Err(e) = shutdown_sql(&s).await {
                first_err.get_or_insert(e);
            }
        }
        // A hung browse query (page, count) would otherwise block the close (MySQL's close
        // waits for the connection lock). Best-effort and bounded.
        let _ = tokio::time::timeout(CANCEL_TIMEOUT, ws.browse.canceller().cancel()).await;
        if let Err(e) = ws.browse.close().await {
            first_err.get_or_insert(e);
        }
        if let Some(t) = ws.tunnel.lock().await.take() {
            t.close().await;
        }
        first_err.map_or(Ok(()), Err)
    }

    /// The workspace's current SSH tunnel (tests: simulate a dropped SSH connection).
    #[doc(hidden)]
    pub async fn workspace_tunnel(&self, workspace_id: &str) -> Option<Arc<SshTunnel>> {
        let slot = self.state().workspaces.get(workspace_id)?.tunnel.clone();
        slot.lock().await.clone()
    }

    /// What reconnecting a workspace needs, copied out of the state lock.
    fn reconnect_material(&self, workspace_id: &str) -> AppResult<Reconnect> {
        let st = self.state();
        let ws = st
            .workspaces
            .get(workspace_id)
            .ok_or_else(|| workspace_not_found(workspace_id))?;
        Ok(Reconnect {
            config: ws.config.clone(),
            password: ws.held_password.as_ref().map(|p| p.0.clone()),
            ssh_secret: ws.held_ssh_secret.as_ref().map(|p| p.0.clone()),
            slot: ws.tunnel.clone(),
        })
    }

    /// Guards the keyring on reconnect paths. A workspace keeps the config it was
    /// opened with, but the keyring follows the saved connection: once that was edited
    /// to another identity (`same_identity`) or deleted, the stored secrets belong to
    /// another target and must never be read for this one. Then only the secrets held
    /// by the workspace are used: no DB password held in Keyring mode is Auth "password
    /// required", and the SSH secret is treated as not stored (Auth "ssh password
    /// required" / "ssh passphrase required" when the tunnel needs it).
    async fn unbind_stale_keyring(&self, r: &mut Reconnect) -> AppResult<()> {
        let cfg = &r.config;
        if cfg.kind == DriverKind::Sqlite || cfg.id.is_empty() {
            return Ok(());
        }
        let db_from_keyring = cfg.password_mode == PasswordMode::Keyring && r.password.is_none();
        let ssh_from_keyring = r.ssh_secret.is_none()
            && ssh_of(cfg).is_some_and(|s| {
                s.secret_kind().is_some() && s.secret_mode == PasswordMode::Keyring
            });
        if !db_from_keyring && !ssh_from_keyring {
            return Ok(());
        }
        let store = self.store.clone();
        let id = cfg.id.clone();
        match blocking(move || store.get(&id)).await {
            Ok(stored) if same_identity(&stored, cfg) => return Ok(()),
            Ok(_) => {}
            Err(e) if e.kind == ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        if db_from_keyring {
            return Err(AppError::new(ErrorKind::Auth, "password required"));
        }
        // No id: resolve_password / resolve_ssh_secret never read the keyring.
        r.config.id.clear();
        Ok(())
    }

    /// The browse connection, unless the tunnel it went through has died.
    fn usable_browse(&self, workspace_id: &str) -> AppResult<Option<Arc<dyn Session>>> {
        let st = self.state();
        let ws = st
            .workspaces
            .get(workspace_id)
            .ok_or_else(|| workspace_not_found(workspace_id))?;
        let usable = ws.browse_tunnel.as_ref().is_none_or(|t| t.is_alive());
        Ok(usable.then(|| ws.browse.clone()))
    }

    /// The workspace's shared browse connection (schemas, objects, pages, counts).
    ///
    /// With SSH, once the tunnel it went through has died, the browse connection is
    /// rebuilt (tunnel reopened if no SQL session did it yet, held secrets or keyring)
    /// and swapped into the workspace, so browsing recovers without reopening the
    /// workspace. Concurrent callers share one reopen (tunnel slot lock). Keyring
    /// secrets are only read while the saved connection still has the workspace's
    /// identity ([`Self::unbind_stale_keyring`]).
    pub async fn browse(&self, workspace_id: &str) -> AppResult<Arc<dyn Session>> {
        if let Some(browse) = self.usable_browse(workspace_id)? {
            return Ok(browse);
        }
        let mut r = self.reconnect_material(workspace_id)?;
        self.unbind_stale_keyring(&mut r).await?;
        let mut current = r.slot.lock().await;
        // Another caller may have rebuilt it while we waited for the lock.
        if let Some(browse) = self.usable_browse(workspace_id)? {
            return Ok(browse);
        }
        let tunnel = self
            .revive_tunnel(workspace_id, &r.config, &mut current, r.ssh_secret)
            .await?;
        let password = self.resolve_password(&r.config, r.password).await?;
        let fresh = connect(&r.config, password, Some(&tunnel)).await?;
        let old = {
            let mut st = self.state();
            st.workspaces.get_mut(workspace_id).map(|ws| {
                ws.browse_tunnel = Some(tunnel);
                std::mem::replace(&mut ws.browse, fresh.clone())
            })
        };
        drop(current);
        match old {
            Some(old) => {
                // Its connection is already gone; bounded in case the driver waits.
                let _ = tokio::time::timeout(CANCEL_TIMEOUT, old.close()).await;
                Ok(fresh)
            }
            None => {
                // The workspace was closed while we were reconnecting.
                let _ = fresh.close().await;
                Err(workspace_not_found(workspace_id))
            }
        }
    }

    /// The metadata of a table or view, read once through the browse connection and
    /// cached until [`Self::invalidate_table_info`] or the workspace closes. A read that
    /// was in flight when an invalidation happened is returned but not cached (it may
    /// predate the change that caused the invalidation).
    pub async fn table_info(
        &self,
        workspace_id: &str,
        obj: &ObjectRef,
    ) -> AppResult<Arc<TableInfo>> {
        let key = (obj.schema.clone(), obj.name.clone());
        let generation = {
            let st = self.state();
            let ws = st
                .workspaces
                .get(workspace_id)
                .ok_or_else(|| workspace_not_found(workspace_id))?;
            if let Some(hit) = ws.table_info.get(&key) {
                return Ok(hit.clone());
            }
            ws.table_info_gen
        };
        let info = Arc::new(self.browse(workspace_id).await?.table_info(obj).await?);
        if let Some(ws) = self.state().workspaces.get_mut(workspace_id)
            && ws.table_info_gen == generation
        {
            ws.table_info.insert(key, info.clone());
        }
        Ok(info)
    }

    /// Forgets the cached metadata of `obj` (no-op when absent or the workspace is closed).
    pub fn invalidate_table_info(&self, workspace_id: &str, obj: &ObjectRef) {
        if let Some(ws) = self.state().workspaces.get_mut(workspace_id) {
            ws.table_info_gen += 1;
            ws.table_info
                .remove(&(obj.schema.clone(), obj.name.clone()));
        }
    }

    /// The statements of `changes`, built from the cached metadata, with the browse
    /// connection. `Invalid` "change <index>: …" (0-based) for the first one refused.
    async fn build_changes(
        &self,
        workspace_id: &str,
        obj: &ObjectRef,
        changes: &[RowChange],
    ) -> AppResult<(Arc<dyn Session>, Vec<Statement>)> {
        let info = self.table_info(workspace_id, obj).await?;
        let browse = self.browse(workspace_id).await?;
        let d = browse.dialect();
        let stmts = changes
            .iter()
            .enumerate()
            .map(|(i, c)| {
                build_change(d, &info, c)
                    .map_err(|e| AppError::new(e.kind, format!("change {i}: {}", e.message)))
            })
            .collect::<AppResult<Vec<_>>>()?;
        Ok((browse, stmts))
    }

    /// The SQL of each change with its values as literals, for display only.
    pub async fn changes_preview(
        &self,
        workspace_id: &str,
        obj: &ObjectRef,
        changes: &[RowChange],
    ) -> AppResult<Vec<String>> {
        let (browse, stmts) = self.build_changes(workspace_id, obj, changes).await?;
        let d = browse.dialect();
        Ok(stmts.iter().map(|s| render_preview(d, s)).collect())
    }

    /// Applies `changes` in one transaction on the browse connection (the only write path
    /// of the grid): all or nothing, each UPDATE / DELETE touching exactly one row. A
    /// failure that hints at a schema change drops the table's cached metadata.
    pub async fn changes_apply(
        &self,
        workspace_id: &str,
        obj: &ObjectRef,
        changes: &[RowChange],
    ) -> AppResult<ApplyOutcome> {
        let (browse, stmts) = self.build_changes(workspace_id, obj, changes).await?;
        let expect_one: Vec<bool> = changes.iter().map(RowChange::expects_one_row).collect();
        let outcome = browse.apply(&stmts, &expect_one).await?;
        if outcome.error.as_ref().is_some_and(suggests_schema_change) {
            self.invalidate_table_info(workspace_id, obj);
        }
        Ok(outcome)
    }

    /// The whole value of one cell (text and JSON never cut; bytes stay a preview), found
    /// by its row key. `NotFound` when the row is gone, `Invalid` above `MAX_EDIT_BYTES`.
    pub async fn cell_value(
        &self,
        workspace_id: &str,
        obj: &ObjectRef,
        key: &RowKey,
        column: &str,
    ) -> AppResult<CellValue> {
        let info = self.table_info(workspace_id, obj).await?;
        let browse = self.browse(workspace_id).await?;
        let d = browse.dialect();
        let gone = || AppError::new(ErrorKind::NotFound, STALE_ROW);
        // Binary columns: no size check (always a preview).
        let bytes = match build_cell_size(d, &info, key, column)? {
            None => 0,
            Some(stmt) => match browse
                .query(&stmt)
                .await?
                .rows
                .first()
                .and_then(|r| r.first())
            {
                None => return Err(gone()),
                Some(CellValue::Int(n)) => (*n).max(0) as u64,
                Some(CellValue::BigInt(s) | CellValue::Decimal(s)) => s.parse().unwrap_or(u64::MAX),
                // NULL: nothing to load.
                Some(_) => 0,
            },
        };
        if bytes > MAX_EDIT_BYTES {
            return Err(AppError::new(
                ErrorKind::Invalid,
                format!("value too large to edit ({} MB)", bytes.div_ceil(1 << 20)),
            ));
        }
        let rs = browse
            .query_full(&build_cell_value(d, &info, key, column)?)
            .await?;
        rs.rows
            .into_iter()
            .next()
            .and_then(|r| r.into_iter().next())
            .ok_or_else(gone)
    }

    /// One page of a table or view (filters, order, limit) through the browse connection,
    /// built from the cached metadata.
    pub async fn table_page(&self, workspace_id: &str, req: &PageRequest) -> AppResult<ResultSet> {
        let info = self.table_info(workspace_id, &req.object).await?;
        let browse = self.browse(workspace_id).await?;
        let stmt = build_page(browse.dialect(), &info, req)?;
        browse.query(&stmt).await
    }

    /// Rows of a table or view. Without filters: the driver's count (estimated above
    /// `EXACT_COUNT_THRESHOLD`). With filters: counted up to `FILTERED_COUNT_CAP`, then
    /// `Estimate(EXACT_COUNT_THRESHOLD)` ("at least").
    pub async fn table_count(
        &self,
        workspace_id: &str,
        obj: &ObjectRef,
        filters: &[Filter],
    ) -> AppResult<RowCount> {
        if filters.is_empty() {
            return self
                .browse(workspace_id)
                .await?
                .count_rows(obj, EXACT_COUNT_THRESHOLD)
                .await;
        }
        let info = self.table_info(workspace_id, obj).await?;
        let browse = self.browse(workspace_id).await?;
        let stmt = build_filtered_count(browse.dialect(), &info, filters, FILTERED_COUNT_CAP)?;
        read_count(&browse.query(&stmt).await?, FILTERED_COUNT_CAP)
    }

    /// Opens a dedicated connection with the workspace's parameters, through its
    /// tunnel (reopened first if it died). Same keyring rule as [`Self::browse`].
    pub async fn open_sql_session(&self, workspace_id: &str) -> AppResult<String> {
        let mut r = self.reconnect_material(workspace_id)?;
        self.unbind_stale_keyring(&mut r).await?;
        let password = self.resolve_password(&r.config, r.password).await?;
        let tunnel = self
            .live_tunnel(workspace_id, &r.config, &r.slot, r.ssh_secret)
            .await?;
        let session = connect(&r.config, password, tunnel.as_deref()).await?;
        self.register_sql_session(workspace_id, session).await
    }

    async fn register_sql_session(
        &self,
        workspace_id: &str,
        session: Arc<dyn Session>,
    ) -> AppResult<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let registered = {
            let mut guard = self.state();
            let st = &mut *guard;
            match st.workspaces.get_mut(workspace_id) {
                Some(ws) => {
                    ws.sql_sessions.push(id.clone());
                    let entry = Arc::new(SqlSession::new(workspace_id, session.clone()));
                    st.sessions.insert(id.clone(), entry);
                    true
                }
                None => false,
            }
        };
        if registered {
            Ok(id)
        } else {
            // The workspace was closed while we were connecting.
            let _ = session.close().await;
            Err(workspace_not_found(workspace_id))
        }
    }

    pub async fn close_sql_session(&self, session_id: &str) -> AppResult<()> {
        let entry = {
            let mut st = self.state();
            let entry = st
                .sessions
                .remove(session_id)
                .ok_or_else(|| session_not_found(session_id))?;
            if let Some(ws) = st.workspaces.get_mut(&entry.workspace_id) {
                ws.sql_sessions.retain(|s| s != session_id);
            }
            entry
        };
        shutdown_sql(&entry).await
    }

    /// Runs `statements` in order, one driver call each. Stops at the first error
    /// (`StatementFailed`) or when cancel is requested; always ends with
    /// `BatchFinished`. Only one batch may run per session at a time.
    pub async fn execute_batch(
        &self,
        session_id: &str,
        statements: Vec<String>,
        sink: impl Fn(ExecEvent) + Send + Sync,
    ) -> AppResult<()> {
        let entry = self.sql_entry(session_id)?;
        let ctl = Arc::new(BatchCtl::default());
        {
            let mut cur = entry.current();
            if cur.is_some() {
                return Err(AppError::new(
                    ErrorKind::Invalid,
                    "a query is already running",
                ));
            }
            *cur = Some(ctl.clone());
        }
        let _end = EndBatch(&entry, ctl.clone());
        // A cancel loop left over from a previous batch may still have a re-sent cancel
        // in flight; let it land before our first statement. A cancel requested for
        // this batch meanwhile is recorded on `ctl` and honoured below.
        let deadline = Instant::now() + CANCEL_TIMEOUT;
        while entry.resend_loops.load(SeqCst) > 0 && Instant::now() < deadline {
            tokio::time::sleep(POLL).await;
        }

        let mut cancelled = false;
        for (index, sql) in statements.iter().enumerate() {
            // Mark the statement in flight before checking the flag: `request_cancel`
            // sets the flag before reading `in_statement`, so one side always sees the other.
            ctl.in_statement.store(true, SeqCst);
            if ctl.cancel_requested.load(SeqCst) {
                ctl.in_statement.store(false, SeqCst);
                cancelled = true;
                break;
            }
            sink(ExecEvent::StatementStarted { index });
            let result = entry.session.execute(sql).await;
            ctl.in_statement.store(false, SeqCst);
            match result {
                Ok(outcome) => {
                    sink(ExecEvent::StatementFinished { index, outcome });
                    if ctl.cancel_requested.load(SeqCst) {
                        cancelled = true;
                        break;
                    }
                }
                Err(error) => {
                    cancelled =
                        error.kind == ErrorKind::Cancelled || ctl.cancel_requested.load(SeqCst);
                    sink(ExecEvent::StatementFailed { index, error });
                    break;
                }
            }
        }
        sink(ExecEvent::BatchFinished { cancelled });
        Ok(())
    }

    /// Cancels the batch running on the session; `Ok(())` when idle.
    pub async fn cancel(&self, session_id: &str) -> AppResult<()> {
        let entry = self.sql_entry(session_id)?;
        request_cancel(&entry).await
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use async_trait::async_trait;
    use tokio::sync::mpsc;

    use super::*;
    use crate::driver::query::{FilterOp, Statement};
    use crate::driver::tls::SslConfig;
    use crate::driver::{Canceller, DbObject, ObjectKind, ObjectRef, SortDir};
    use crate::secrets::{MemorySecretStore, SecretKey, SecretKind};
    use crate::store::{EnvTag, PasswordMode, SshAuth, SshSettings};
    use crate::value::CellValue;

    const WAIT: Duration = Duration::from_secs(10);
    const INFINITE_CTE: &str = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) \
                                SELECT count(*) FROM c";

    struct Fx {
        _dir: tempfile::TempDir,
        db_path: PathBuf,
        secrets: Arc<MemorySecretStore>,
        mgr: Arc<SessionManager>,
    }

    /// A manager with an empty `~/.ssh/config` and a tempdir app `known_hosts`.
    fn manager(dir: &tempfile::TempDir, secrets: Arc<dyn SecretStore>) -> SessionManager {
        let store = ConnectionStore::open(&dir.path().join("app.db")).unwrap();
        let known_hosts = KnownHosts {
            system: None,
            app: dir.path().join("known_hosts"),
        };
        SessionManager::new(Arc::new(store), secrets, known_hosts)
            .with_ssh_config(SshConfigFile::default())
    }

    fn fixture() -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("data.db");
        let c = rusqlite::Connection::open(&db_path).unwrap();
        c.execute_batch(
            "CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO items(name) VALUES ('a'), ('b');",
        )
        .unwrap();
        drop(c);
        let secrets = Arc::new(MemorySecretStore::new());
        let mgr = Arc::new(manager(&dir, secrets.clone()));
        Fx {
            _dir: dir,
            db_path,
            secrets,
            mgr,
        }
    }

    fn cfg(kind: DriverKind, mode: PasswordMode) -> ConnectionConfig {
        ConnectionConfig {
            id: String::new(),
            name: "test".into(),
            color: "#888".into(),
            env_tag: EnvTag::Local,
            kind,
            host: "localhost".into(),
            port: 5432,
            user: "u".into(),
            database: None,
            sqlite_path: None,
            password_mode: mode,
            group: None,
            ssl: SslConfig::default(),
            ssh: None,
        }
    }

    fn sqlite_cfg(fx: &Fx) -> ConnectionConfig {
        let mut c = cfg(DriverKind::Sqlite, PasswordMode::None);
        c.sqlite_path = Some(fx.db_path.to_string_lossy().into_owned());
        c
    }

    async fn sqlite_ws(fx: &Fx) -> WorkspaceInfo {
        let saved = fx
            .mgr
            .save_connection(sqlite_cfg(fx), None, None)
            .await
            .unwrap();
        fx.mgr
            .open_workspace(&saved.id, None, None, None)
            .await
            .unwrap()
    }

    /// Collects events; `rx` yields a copy of each summary as it is emitted.
    struct Collector {
        events: Arc<Mutex<Vec<String>>>,
        rx: mpsc::UnboundedReceiver<String>,
        tx: mpsc::UnboundedSender<String>,
    }

    fn summary(e: &ExecEvent) -> String {
        match e {
            ExecEvent::StatementStarted { index } => format!("started{index}"),
            ExecEvent::StatementFinished { index, .. } => format!("finished{index}"),
            ExecEvent::StatementFailed { index, error } => {
                format!("failed{index}:{:?}", error.kind)
            }
            ExecEvent::BatchFinished { cancelled } => format!("batch:{cancelled}"),
        }
    }

    impl Collector {
        fn new() -> Self {
            let (tx, rx) = mpsc::unbounded_channel();
            Self {
                events: Arc::new(Mutex::new(vec![])),
                rx,
                tx,
            }
        }
        fn sink(&self) -> impl Fn(ExecEvent) + Send + Sync + 'static {
            let events = self.events.clone();
            let tx = self.tx.clone();
            move |e| {
                let s = summary(&e);
                events.lock().unwrap().push(s.clone());
                let _ = tx.send(s);
            }
        }
        async fn wait_for(&mut self, want: &str) {
            tokio::time::timeout(WAIT, async {
                while let Some(s) = self.rx.recv().await {
                    if s == want {
                        return;
                    }
                }
                panic!("event stream ended before {want}");
            })
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {want}"));
        }
        fn all(&self) -> Vec<String> {
            self.events.lock().unwrap().clone()
        }
    }

    fn sql(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[tokio::test]
    async fn open_workspace_and_browse_sqlite() {
        let fx = fixture();
        let ws = sqlite_ws(&fx).await;
        assert_eq!(ws.dialect, Dialect::Sqlite);
        assert!(!ws.server_version.is_empty());
        let objs = fx
            .mgr
            .browse(&ws.workspace_id)
            .await
            .unwrap()
            .list_objects(None)
            .await
            .unwrap();
        assert!(objs.iter().any(|o| o.name == "items"), "{objs:?}");
    }

    #[tokio::test]
    async fn ask_mode_without_password_is_auth_error() {
        let fx = fixture();
        // A non-local host: reaching the driver would yield a Connection error instead.
        let mut c = cfg(DriverKind::Postgres, PasswordMode::Ask);
        c.host = "203.0.113.7".into();
        let saved = fx.mgr.save_connection(c.clone(), None, None).await.unwrap();
        let err = fx
            .mgr
            .open_workspace(&saved.id, None, None, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Auth);
        assert_eq!(err.message, "password required");
        let err = fx
            .mgr
            .test_connection(&c, None, None, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Auth);
    }

    #[tokio::test]
    async fn execute_batch_stops_at_error() {
        let fx = fixture();
        let ws = sqlite_ws(&fx).await;
        let sid = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
        let c = Collector::new();
        fx.mgr
            .execute_batch(
                &sid,
                sql(&["select 1", "select * from nope", "select 2"]),
                c.sink(),
            )
            .await
            .unwrap();
        assert_eq!(
            c.all(),
            [
                "started0",
                "finished0",
                "started1",
                "failed1:Query",
                "batch:false"
            ]
        );
    }

    #[tokio::test]
    async fn sql_sessions_are_isolated() {
        let fx = fixture();
        let ws = sqlite_ws(&fx).await;
        let a = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
        let b = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
        assert_ne!(a, b);
        let ca = Collector::new();
        fx.mgr
            .execute_batch(&a, sql(&["create temp table t(x)"]), ca.sink())
            .await
            .unwrap();
        assert_eq!(ca.all(), ["started0", "finished0", "batch:false"]);
        let cb = Collector::new();
        fx.mgr
            .execute_batch(&b, sql(&["select * from t"]), cb.sink())
            .await
            .unwrap();
        assert_eq!(cb.all(), ["started0", "failed0:Query", "batch:false"]);
    }

    #[tokio::test]
    async fn cancel_marks_batch_cancelled() {
        let fx = fixture();
        let ws = sqlite_ws(&fx).await;
        let sid = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
        let mut c = Collector::new();
        let sink = c.sink();
        let (mgr, s) = (fx.mgr.clone(), sid.clone());
        let batch = tokio::spawn(async move {
            mgr.execute_batch(&s, sql(&[INFINITE_CTE, "select 2"]), sink)
                .await
        });
        c.wait_for("started0").await;
        tokio::time::timeout(WAIT, fx.mgr.cancel(&sid))
            .await
            .expect("cancel timed out")
            .unwrap();
        tokio::time::timeout(WAIT, batch)
            .await
            .expect("batch did not stop")
            .unwrap()
            .unwrap();
        assert_eq!(c.all(), ["started0", "failed0:Cancelled", "batch:true"]);
        // The session stays usable after a cancel.
        let c2 = Collector::new();
        fx.mgr
            .execute_batch(&sid, sql(&["select 1"]), c2.sink())
            .await
            .unwrap();
        assert_eq!(c2.all(), ["started0", "finished0", "batch:false"]);
    }

    #[tokio::test]
    async fn concurrent_batch_on_same_session_is_rejected() {
        let fx = fixture();
        let ws = sqlite_ws(&fx).await;
        let sid = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
        let mut c = Collector::new();
        let sink = c.sink();
        let (mgr, s) = (fx.mgr.clone(), sid.clone());
        let batch =
            tokio::spawn(async move { mgr.execute_batch(&s, sql(&[INFINITE_CTE]), sink).await });
        c.wait_for("started0").await;
        let err = fx
            .mgr
            .execute_batch(&sid, sql(&["select 1"]), |_| {})
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert_eq!(err.message, "a query is already running");
        tokio::time::timeout(WAIT, fx.mgr.cancel(&sid))
            .await
            .expect("cancel timed out")
            .unwrap();
        tokio::time::timeout(WAIT, batch)
            .await
            .expect("batch did not stop")
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn close_workspace_closes_its_sql_sessions() {
        let fx = fixture();
        let ws = sqlite_ws(&fx).await;
        let sid = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
        fx.mgr.close_workspace(&ws.workspace_id).await.unwrap();
        let err = fx
            .mgr
            .execute_batch(&sid, sql(&["select 1"]), |_| {})
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound);
        assert_eq!(
            fx.mgr.browse(&ws.workspace_id).await.err().unwrap().kind,
            ErrorKind::NotFound
        );
        assert_eq!(
            fx.mgr
                .open_sql_session(&ws.workspace_id)
                .await
                .unwrap_err()
                .kind,
            ErrorKind::NotFound
        );
    }

    #[tokio::test]
    async fn close_sql_session_removes_only_that_session() {
        let fx = fixture();
        let ws = sqlite_ws(&fx).await;
        let a = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
        let b = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
        fx.mgr.close_sql_session(&a).await.unwrap();
        assert_eq!(
            fx.mgr
                .execute_batch(&a, sql(&["select 1"]), |_| {})
                .await
                .unwrap_err()
                .kind,
            ErrorKind::NotFound
        );
        fx.mgr
            .execute_batch(&b, sql(&["select 1"]), |_| {})
            .await
            .unwrap();
        assert_eq!(
            fx.mgr.close_sql_session(&a).await.unwrap_err().kind,
            ErrorKind::NotFound
        );
        fx.mgr.close_workspace(&ws.workspace_id).await.unwrap();
    }

    #[tokio::test]
    async fn cancel_on_idle_session_is_ok() {
        let fx = fixture();
        let ws = sqlite_ws(&fx).await;
        let sid = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
        fx.mgr.cancel(&sid).await.unwrap();
        // An idle cancel must not leak into the next batch.
        let c = Collector::new();
        fx.mgr
            .execute_batch(&sid, sql(&["select 1"]), c.sink())
            .await
            .unwrap();
        assert_eq!(c.all(), ["started0", "finished0", "batch:false"]);
        assert_eq!(
            fx.mgr.cancel("nope").await.unwrap_err().kind,
            ErrorKind::NotFound
        );
    }

    #[tokio::test]
    async fn test_connection_works_for_unsaved_config() {
        let fx = fixture();
        let c = sqlite_cfg(&fx);
        assert!(c.id.is_empty());
        let v = fx.mgr.test_connection(&c, None, None, None).await.unwrap();
        assert!(!v.is_empty());
    }

    #[tokio::test]
    async fn unknown_ids_are_not_found() {
        let fx = fixture();
        assert_eq!(
            fx.mgr
                .open_workspace("nope", None, None, None)
                .await
                .unwrap_err()
                .kind,
            ErrorKind::NotFound
        );
        assert_eq!(
            fx.mgr.close_workspace("nope").await.unwrap_err().kind,
            ErrorKind::NotFound
        );
        assert_eq!(
            fx.mgr.browse("nope").await.err().unwrap().kind,
            ErrorKind::NotFound
        );
    }

    #[tokio::test]
    async fn password_resolution_rules() {
        let fx = fixture();
        let mut k = cfg(DriverKind::Postgres, PasswordMode::Keyring);
        k.id = "c1".into();
        fx.secrets
            .set(
                &SecretKey::new("c1", SecretKind::DbPassword),
                "from-keyring",
            )
            .unwrap();
        let r = |c: ConnectionConfig, p: Option<&str>| {
            let mgr = fx.mgr.clone();
            let p = p.map(String::from);
            async move { mgr.resolve_password(&c, p).await }
        };
        assert_eq!(
            r(k.clone(), None).await.unwrap().as_deref(),
            Some("from-keyring")
        );
        assert_eq!(
            r(k.clone(), Some("arg")).await.unwrap().as_deref(),
            Some("arg")
        );
        let mut unsaved = k.clone();
        unsaved.id = String::new();
        assert_eq!(r(unsaved, None).await.unwrap(), None);
        let none = cfg(DriverKind::Postgres, PasswordMode::None);
        assert_eq!(r(none, Some("arg")).await.unwrap(), None);
        let ask = cfg(DriverKind::Postgres, PasswordMode::Ask);
        assert_eq!(
            r(ask.clone(), Some("typed")).await.unwrap().as_deref(),
            Some("typed")
        );
        assert_eq!(r(ask, None).await.unwrap_err().kind, ErrorKind::Auth);
    }

    #[test]
    fn exec_event_serde_shape() {
        let j = |e: ExecEvent| serde_json::to_value(e).unwrap();
        assert_eq!(
            j(ExecEvent::StatementStarted { index: 2 }),
            serde_json::json!({"event": "statementStarted", "data": {"index": 2}})
        );
        assert_eq!(
            j(ExecEvent::BatchFinished { cancelled: true }),
            serde_json::json!({"event": "batchFinished", "data": {"cancelled": true}})
        );
        let failed = j(ExecEvent::StatementFailed {
            index: 0,
            error: AppError::new(ErrorKind::Cancelled, "query cancelled"),
        });
        assert_eq!(failed["event"], "statementFailed");
        assert_eq!(failed["data"]["error"]["kind"], "cancelled");
        let fin = j(ExecEvent::StatementFinished {
            index: 1,
            outcome: StatementOutcome {
                result: None,
                rows_affected: Some(3),
                elapsed_ms: 4,
            },
        });
        assert_eq!(fin["data"]["outcome"]["rowsAffected"], 3);
        let info = serde_json::to_value(WorkspaceInfo {
            workspace_id: "w".into(),
            connection_id: "c".into(),
            dialect: Dialect::Sqlite,
            server_version: "3".into(),
        })
        .unwrap();
        assert_eq!(
            info,
            serde_json::json!({"workspaceId": "w", "connectionId": "c", "dialect": "sqlite", "serverVersion": "3"})
        );
    }

    /// A session whose statements ignore cancellation and take `delay` to complete.
    struct StubbornSession {
        delay: Duration,
        cancel_delay: Duration,
        cancels: Arc<AtomicUsize>,
    }

    /// Counts cancels; each takes `.1` to complete (a slow KILL over a new connection).
    struct CountingCanceller(Arc<AtomicUsize>, Duration);

    #[async_trait]
    impl Canceller for CountingCanceller {
        async fn cancel(&self) -> AppResult<()> {
            self.0.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(self.1).await;
            Ok(())
        }
    }

    #[async_trait]
    impl Session for StubbornSession {
        fn dialect(&self) -> Dialect {
            Dialect::Sqlite
        }
        fn server_version(&self) -> String {
            "stub".into()
        }
        async fn list_schemas(&self) -> AppResult<Vec<String>> {
            Ok(vec![])
        }
        async fn list_objects(&self, _: Option<&str>) -> AppResult<Vec<DbObject>> {
            Ok(vec![])
        }
        async fn query(&self, _: &Statement) -> AppResult<ResultSet> {
            Err(AppError::new(ErrorKind::Invalid, "stub"))
        }
        async fn query_full(&self, _: &Statement) -> AppResult<ResultSet> {
            Err(AppError::new(ErrorKind::Invalid, "stub"))
        }
        async fn apply(&self, _: &[Statement], _: &[bool]) -> AppResult<ApplyOutcome> {
            Err(AppError::new(ErrorKind::Invalid, "stub"))
        }
        async fn count_rows(&self, _: &ObjectRef, _: u64) -> AppResult<RowCount> {
            Ok(RowCount::Exact(0))
        }
        async fn table_info(&self, _: &ObjectRef) -> AppResult<TableInfo> {
            Err(AppError::new(ErrorKind::Invalid, "stub"))
        }
        async fn table_ddl(&self, _: &ObjectRef) -> AppResult<String> {
            Err(AppError::new(ErrorKind::Invalid, "stub"))
        }
        async fn execute(&self, _: &str) -> AppResult<StatementOutcome> {
            tokio::time::sleep(self.delay).await;
            Ok(StatementOutcome {
                result: None,
                rows_affected: Some(0),
                elapsed_ms: 0,
            })
        }
        fn canceller(&self) -> Arc<dyn Canceller> {
            Arc::new(CountingCanceller(self.cancels.clone(), self.cancel_delay))
        }
        async fn close(&self) -> AppResult<()> {
            Ok(())
        }
    }

    async fn stubborn_session(fx: &Fx, delay: Duration) -> (String, Arc<AtomicUsize>) {
        stubborn_session_with(fx, delay, Duration::ZERO).await
    }

    async fn stubborn_session_with(
        fx: &Fx,
        delay: Duration,
        cancel_delay: Duration,
    ) -> (String, Arc<AtomicUsize>) {
        let ws = sqlite_ws(fx).await;
        let cancels = Arc::new(AtomicUsize::new(0));
        let session: Arc<dyn Session> = Arc::new(StubbornSession {
            delay,
            cancel_delay,
            cancels: cancels.clone(),
        });
        let sid = fx
            .mgr
            .register_sql_session(&ws.workspace_id, session)
            .await
            .unwrap();
        (sid, cancels)
    }

    #[tokio::test]
    async fn close_workspace_cancels_the_browse_query_first() {
        let fx = fixture();
        let cancels = Arc::new(AtomicUsize::new(0));
        let browse: Arc<dyn Session> = Arc::new(StubbornSession {
            delay: Duration::ZERO,
            cancel_delay: Duration::ZERO,
            cancels: cancels.clone(),
        });
        fx.mgr.state().workspaces.insert(
            "w-stub".into(),
            Workspace {
                config: cfg(DriverKind::Postgres, PasswordMode::None),
                held_password: None,
                held_ssh_secret: None,
                tunnel: Default::default(),
                browse,
                browse_tunnel: None,
                sql_sessions: Vec::new(),
                table_info: HashMap::new(),
                table_info_gen: 0,
            },
        );
        fx.mgr.close_workspace("w-stub").await.unwrap();
        assert_eq!(cancels.load(Ordering::SeqCst), 1);
    }

    /// Serves a one-column table and counts `table_info` calls; `missing` is NotFound.
    /// Each `table_info` call waits for `.1` (tests hold it to keep a read in flight).
    struct MetaSession(Arc<AtomicUsize>, Arc<tokio::sync::Mutex<()>>);

    #[async_trait]
    impl Session for MetaSession {
        fn dialect(&self) -> Dialect {
            Dialect::Postgres
        }
        fn server_version(&self) -> String {
            "meta".into()
        }
        async fn list_schemas(&self) -> AppResult<Vec<String>> {
            Ok(vec![])
        }
        async fn list_objects(&self, _: Option<&str>) -> AppResult<Vec<DbObject>> {
            Ok(vec![])
        }
        async fn query(&self, _: &Statement) -> AppResult<ResultSet> {
            Err(AppError::new(ErrorKind::Invalid, "meta"))
        }
        async fn query_full(&self, _: &Statement) -> AppResult<ResultSet> {
            Err(AppError::new(ErrorKind::Invalid, "meta"))
        }
        async fn apply(&self, _: &[Statement], _: &[bool]) -> AppResult<ApplyOutcome> {
            Err(AppError::new(ErrorKind::Invalid, "meta"))
        }
        async fn count_rows(&self, _: &ObjectRef, _: u64) -> AppResult<RowCount> {
            Ok(RowCount::Exact(0))
        }
        async fn table_info(&self, obj: &ObjectRef) -> AppResult<TableInfo> {
            self.0.fetch_add(1, Ordering::SeqCst);
            let _hold = self.1.lock().await;
            if obj.name == "missing" {
                return Err(AppError::new(ErrorKind::NotFound, "missing"));
            }
            Ok(TableInfo {
                object: obj.clone(),
                kind: ObjectKind::Table,
                columns: vec![],
                primary_key: vec![],
                indexes: vec![],
                foreign_keys: vec![],
                row_key: None,
                has_rowid: false,
            })
        }
        async fn table_ddl(&self, _: &ObjectRef) -> AppResult<String> {
            Ok(String::new())
        }
        async fn execute(&self, _: &str) -> AppResult<StatementOutcome> {
            Err(AppError::new(ErrorKind::Invalid, "meta"))
        }
        fn canceller(&self) -> Arc<dyn Canceller> {
            Arc::new(CountingCanceller(Arc::default(), Duration::ZERO))
        }
        async fn close(&self) -> AppResult<()> {
            Ok(())
        }
    }

    /// A workspace whose browse connection is a [`MetaSession`]; returns its call count.
    fn meta_workspace(fx: &Fx, id: &str) -> Arc<AtomicUsize> {
        meta_workspace_held(fx, id, Arc::default())
    }

    fn meta_workspace_held(
        fx: &Fx,
        id: &str,
        hold: Arc<tokio::sync::Mutex<()>>,
    ) -> Arc<AtomicUsize> {
        let calls = Arc::new(AtomicUsize::new(0));
        fx.mgr.state().workspaces.insert(
            id.into(),
            Workspace {
                config: cfg(DriverKind::Postgres, PasswordMode::None),
                held_password: None,
                held_ssh_secret: None,
                tunnel: Default::default(),
                browse: Arc::new(MetaSession(calls.clone(), hold)),
                browse_tunnel: None,
                sql_sessions: Vec::new(),
                table_info: HashMap::new(),
                table_info_gen: 0,
            },
        );
        calls
    }

    fn obj(schema: Option<&str>, name: &str) -> ObjectRef {
        ObjectRef {
            schema: schema.map(Into::into),
            name: name.into(),
        }
    }

    fn page(object: ObjectRef, filters: Vec<Filter>) -> PageRequest {
        PageRequest {
            object,
            limit: 300,
            offset: 0,
            sort: None,
            filters,
        }
    }

    fn filter(col: Option<&str>, op: FilterOp, values: &[&str]) -> Filter {
        Filter {
            column: col.map(Into::into),
            op,
            values: values.iter().map(|v| v.to_string()).collect(),
        }
    }

    #[tokio::test]
    async fn table_page_and_count_apply_filters() {
        let fx = fixture();
        let ws = sqlite_ws(&fx).await.workspace_id;
        let items = obj(Some("main"), "items");
        let all = fx
            .mgr
            .table_page(&ws, &page(items.clone(), vec![]))
            .await
            .unwrap();
        assert_eq!(all.rows.len(), 2);
        let mut sorted = page(items.clone(), vec![]);
        sorted.sort = Some(("name".into(), SortDir::Desc));
        let rows = fx.mgr.table_page(&ws, &sorted).await.unwrap().rows;
        assert_eq!(rows[0][1], CellValue::Text("b".into()));

        let only_b = vec![filter(Some("name"), FilterOp::Eq, &["b"])];
        let rs = fx
            .mgr
            .table_page(&ws, &page(items.clone(), only_b.clone()))
            .await
            .unwrap();
        assert_eq!(
            rs.rows,
            vec![vec![CellValue::Int(2), CellValue::Text("b".into())]]
        );

        assert_eq!(
            fx.mgr.table_count(&ws, &items, &[]).await.unwrap(),
            RowCount::Exact(2)
        );
        assert_eq!(
            fx.mgr.table_count(&ws, &items, &only_b).await.unwrap(),
            RowCount::Exact(1)
        );
        let none = vec![filter(None, FilterOp::Contains, &["zz"])];
        assert_eq!(
            fx.mgr.table_count(&ws, &items, &none).await.unwrap(),
            RowCount::Exact(0)
        );

        let bad = vec![filter(Some("nope"), FilterOp::Eq, &["1"])];
        let e = fx
            .mgr
            .table_page(&ws, &page(items.clone(), bad.clone()))
            .await;
        assert_eq!(e.unwrap_err().kind, ErrorKind::Invalid);
        let e = fx.mgr.table_count(&ws, &items, &bad).await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Invalid);
        let e = fx
            .mgr
            .table_page(&ws, &page(obj(Some("main"), "missing"), vec![]))
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::NotFound);
    }

    #[tokio::test]
    async fn table_info_is_cached_per_workspace_and_object() {
        let fx = fixture();
        let calls = meta_workspace(&fx, "w1");
        let a = obj(Some("public"), "a");
        let first = fx.mgr.table_info("w1", &a).await.unwrap();
        let again = fx.mgr.table_info("w1", &a).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(Arc::ptr_eq(&first, &again));
        assert_eq!(first.object, a);

        // Another object (or the same name in another schema) is another entry.
        fx.mgr.table_info("w1", &obj(None, "a")).await.unwrap();
        fx.mgr
            .table_info("w1", &obj(Some("other"), "a"))
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 3);

        // Refresh = invalidate, then one more driver call.
        fx.mgr.invalidate_table_info("w1", &a);
        let fresh = fx.mgr.table_info("w1", &a).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        assert!(!Arc::ptr_eq(&first, &fresh));
        fx.mgr.table_info("w1", &a).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 4);

        // Errors are not cached.
        let missing = obj(None, "missing");
        for n in 5..=6 {
            let e = fx.mgr.table_info("w1", &missing).await.unwrap_err();
            assert_eq!(e.kind, ErrorKind::NotFound);
            assert_eq!(calls.load(Ordering::SeqCst), n);
        }

        // Workspaces never share entries.
        let other = meta_workspace(&fx, "w2");
        fx.mgr.table_info("w2", &a).await.unwrap();
        assert_eq!(other.load(Ordering::SeqCst), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 6);
    }

    #[tokio::test]
    async fn invalidation_wins_over_an_in_flight_read() {
        let fx = fixture();
        let hold = Arc::new(tokio::sync::Mutex::new(()));
        let calls = meta_workspace_held(&fx, "w1", hold.clone());
        let a = obj(None, "a");
        let held = hold.lock().await;
        let (m, o) = (fx.mgr.clone(), a.clone());
        let read = tokio::spawn(async move { m.table_info("w1", &o).await });
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        // The read started before the invalidation: its (possibly stale) result is
        // returned but must not be cached.
        fx.mgr.invalidate_table_info("w1", &a);
        drop(held);
        read.await.unwrap().unwrap();
        fx.mgr.table_info("w1", &a).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        // That one was cached.
        fx.mgr.table_info("w1", &a).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn changes_apply_preview_and_cell_value_on_sqlite() {
        use crate::driver::dml::{EditValue, RowChange, RowKey};
        let fx = fixture();
        let ws = sqlite_ws(&fx).await.workspace_id;
        let items = obj(Some("main"), "items");
        let key = |id| RowKey(vec![("id".into(), CellValue::Int(id))]);
        let changes = vec![
            RowChange::Update {
                key: key(1),
                set: vec![("name".into(), EditValue::Text("o'k".into()))],
            },
            RowChange::Insert {
                values: vec![("name".into(), EditValue::Text("c".into()))],
            },
            RowChange::Delete { key: key(2) },
        ];
        assert_eq!(
            fx.mgr.changes_preview(&ws, &items, &changes).await.unwrap(),
            vec![
                r#"UPDATE "main"."items" SET "name" = 'o''k' WHERE "id" = '1'"#,
                r#"INSERT INTO "main"."items" ("name") VALUES ('c')"#,
                r#"DELETE FROM "main"."items" WHERE "id" = '2'"#,
            ]
        );
        let o = fx.mgr.changes_apply(&ws, &items, &changes).await.unwrap();
        assert!(o.applied, "{o:?}");
        assert_eq!(o.affected, vec![1, 1, 1]);
        let rows = fx
            .mgr
            .table_page(&ws, &page(items.clone(), vec![]))
            .await
            .unwrap()
            .rows;
        assert_eq!(
            rows,
            vec![
                vec![CellValue::Int(1), CellValue::Text("o'k".into())],
                vec![CellValue::Int(3), CellValue::Text("c".into())],
            ]
        );
        assert_eq!(
            fx.mgr
                .cell_value(&ws, &items, &key(3), "name")
                .await
                .unwrap(),
            CellValue::Text("c".into())
        );
        let e = fx
            .mgr
            .cell_value(&ws, &items, &key(2), "name")
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::NotFound);

        // Row 2 is gone: the whole batch rolls back, the cache stays.
        let before = fx.mgr.table_info(&ws, &items).await.unwrap();
        let o = fx
            .mgr
            .changes_apply(
                &ws,
                &items,
                &[
                    RowChange::Delete { key: key(1) },
                    RowChange::Delete { key: key(2) },
                ],
            )
            .await
            .unwrap();
        assert_eq!((o.applied, o.failed_index), (false, Some(1)));
        assert_eq!(o.error.unwrap().message, STALE_ROW);
        assert!(Arc::ptr_eq(
            &before,
            &fx.mgr.table_info(&ws, &items).await.unwrap()
        ));
        assert_eq!(
            fx.mgr.table_count(&ws, &items, &[]).await.unwrap(),
            RowCount::Exact(2)
        );
    }

    #[tokio::test]
    async fn closing_a_workspace_drops_its_table_info() {
        let fx = fixture();
        let calls = meta_workspace(&fx, "w1");
        let a = obj(None, "a");
        fx.mgr.table_info("w1", &a).await.unwrap();
        fx.mgr.close_workspace("w1").await.unwrap();
        let e = fx.mgr.table_info("w1", &a).await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::NotFound);
        // Same id reopened: a fresh cache.
        let again = meta_workspace(&fx, "w1");
        fx.mgr.table_info("w1", &a).await.unwrap();
        assert_eq!(again.load(Ordering::SeqCst), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // Invalidating on an unknown workspace is a no-op.
        fx.mgr.invalidate_table_info("nope", &a);
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_resends_and_stops_after_ok_statement() {
        let fx = fixture();
        let (sid, cancels) = stubborn_session(&fx, Duration::from_millis(500)).await;
        let mut c = Collector::new();
        let sink = c.sink();
        let (mgr, s) = (fx.mgr.clone(), sid.clone());
        let batch =
            tokio::spawn(async move { mgr.execute_batch(&s, sql(&["a", "b"]), sink).await });
        c.wait_for("started0").await;
        fx.mgr.cancel(&sid).await.unwrap();
        batch.await.unwrap().unwrap();
        assert_eq!(c.all(), ["started0", "finished0", "batch:true"]);
        let n = cancels.load(Ordering::SeqCst);
        assert!(
            n >= 2,
            "cancel must be re-sent until the statement returns, got {n}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn cancel_is_bounded_when_statement_ignores_it() {
        let fx = fixture();
        let (sid, cancels) = stubborn_session(&fx, Duration::from_secs(60)).await;
        let mut c = Collector::new();
        let sink = c.sink();
        let (mgr, s) = (fx.mgr.clone(), sid.clone());
        let batch = tokio::spawn(async move { mgr.execute_batch(&s, sql(&["a"]), sink).await });
        c.wait_for("started0").await;
        let start = tokio::time::Instant::now();
        fx.mgr.cancel(&sid).await.unwrap();
        let took = start.elapsed();
        assert!(
            took >= Duration::from_secs(5) && took < Duration::from_secs(6),
            "{took:?}"
        );
        let n = cancels.load(Ordering::SeqCst);
        assert!(
            (40..=60).contains(&n),
            "~one cancel per 100 ms for 5 s, got {n}"
        );
        batch.await.unwrap().unwrap();
        assert_eq!(c.all(), ["started0", "finished0", "batch:true"]);
    }

    /// A cancel loop from batch 1 outlives it (its re-sent cancel is slow). A cancel
    /// issued while batch 2 waits for that loop must still stop batch 2 before its
    /// first statement.
    #[tokio::test(start_paused = true)]
    async fn cancel_during_wait_for_previous_cancel_loop_is_not_lost() {
        let fx = fixture();
        let (sid, _cancels) =
            stubborn_session_with(&fx, Duration::from_millis(200), Duration::from_secs(1)).await;
        let mut c1 = Collector::new();
        let sink = c1.sink();
        let (mgr, s) = (fx.mgr.clone(), sid.clone());
        let batch1 = tokio::spawn(async move { mgr.execute_batch(&s, sql(&["a"]), sink).await });
        c1.wait_for("started0").await;
        let (mgr, s) = (fx.mgr.clone(), sid.clone());
        let cancel1 = tokio::spawn(async move { mgr.cancel(&s).await });
        c1.wait_for("batch:true").await;
        batch1.await.unwrap().unwrap();
        assert!(
            !cancel1.is_finished(),
            "the first cancel loop must outlive batch 1"
        );

        let c2 = Collector::new();
        let sink = c2.sink();
        let (mgr, s) = (fx.mgr.clone(), sid.clone());
        let batch2 = tokio::spawn(async move { mgr.execute_batch(&s, sql(&["b"]), sink).await });
        // Virtual time: batch 2 is now waiting for the in-flight cancel (1 s) to land.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!cancel1.is_finished() && c2.all().is_empty());
        fx.mgr.cancel(&sid).await.unwrap();
        batch2.await.unwrap().unwrap();
        cancel1.await.unwrap().unwrap();
        assert_eq!(c2.all(), ["batch:true"]);
        // Nothing carries over: the next batch runs normally.
        let c3 = Collector::new();
        fx.mgr
            .execute_batch(&sid, sql(&["c"]), c3.sink())
            .await
            .unwrap();
        assert_eq!(c3.all(), ["started0", "finished0", "batch:false"]);
    }

    #[tokio::test]
    async fn test_connection_with_changed_host_requires_password() {
        let fx = fixture();
        let mut c = cfg(DriverKind::Postgres, PasswordMode::Keyring);
        c.host = "127.0.0.1".into();
        c.port = 1;
        let saved = fx
            .mgr
            .save_connection(c, Some("stored-pw".into()), None)
            .await
            .unwrap();
        let mut changed = saved.clone();
        changed.host = "127.0.0.2".into();
        // Reaching the driver would give a Connection error (nothing listens on port 1).
        let err = fx
            .mgr
            .test_connection(&changed, None, None, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Auth);
        assert_eq!(err.message, "password required");
    }

    /// Secret store that counts reads.
    struct CountingSecrets {
        inner: MemorySecretStore,
        gets: AtomicUsize,
    }

    impl SecretStore for CountingSecrets {
        fn available(&self) -> bool {
            true
        }
        fn set(&self, k: &SecretKey, v: &str) -> AppResult<()> {
            self.inner.set(k, v)
        }
        fn get(&self, k: &SecretKey) -> AppResult<Option<String>> {
            self.gets.fetch_add(1, Ordering::SeqCst);
            self.inner.get(k)
        }
        fn delete(&self, k: &SecretKey) -> AppResult<()> {
            self.inner.delete(k)
        }
    }

    #[tokio::test]
    async fn test_connection_uses_keyring_only_for_unchanged_identity() {
        let secrets = Arc::new(CountingSecrets {
            inner: MemorySecretStore::new(),
            gets: AtomicUsize::new(0),
        });
        let dir = tempfile::tempdir().unwrap();
        let mgr = manager(&dir, secrets.clone());
        // Nothing listens on port 1: reaching the driver yields a Connection error, which
        // is enough to observe whether the keyring was read first.
        let mut c = cfg(DriverKind::Postgres, PasswordMode::Keyring);
        c.host = "127.0.0.1".into();
        c.port = 1;
        let saved = mgr
            .save_connection(c, Some("pw".into()), None)
            .await
            .unwrap();

        // Unchanged identity (only cosmetic fields differ): the keyring is read.
        let mut renamed = saved.clone();
        renamed.name = "renamed".into();
        renamed.color = "#000".into();
        let err = mgr
            .test_connection(&renamed, None, None, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Connection);
        assert_eq!(secrets.gets.load(Ordering::SeqCst), 1);

        // Changed identity: Auth error, keyring untouched.
        let mut moved = saved.clone();
        moved.port = 2;
        let err = mgr
            .test_connection(&moved, None, None, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Auth);
        assert_eq!(secrets.gets.load(Ordering::SeqCst), 1);

        // An explicit password is always accepted (and the keyring is not read).
        let err = mgr
            .test_connection(&saved, Some("typed".into()), None, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Connection);
        assert_eq!(secrets.gets.load(Ordering::SeqCst), 1);
    }

    /// A keyring that is unavailable: every call fails.
    struct BrokenSecrets;

    impl SecretStore for BrokenSecrets {
        fn available(&self) -> bool {
            false
        }
        fn set(&self, _: &SecretKey, _: &str) -> AppResult<()> {
            Err(AppError::new(ErrorKind::Secret, "no keyring"))
        }
        fn get(&self, _: &SecretKey) -> AppResult<Option<String>> {
            Err(AppError::new(ErrorKind::Secret, "no keyring"))
        }
        fn delete(&self, _: &SecretKey) -> AppResult<()> {
            Err(AppError::new(ErrorKind::Secret, "no keyring"))
        }
    }

    #[tokio::test]
    async fn sqlite_works_without_a_keyring() {
        let fx = fixture();
        let dir = tempfile::tempdir().unwrap();
        let mgr = manager(&dir, Arc::new(BrokenSecrets));
        // Keyring mode (the form's old default) must not reach the keyring for SQLite.
        let mut c = sqlite_cfg(&fx);
        c.password_mode = PasswordMode::Keyring;
        assert!(
            !mgr.test_connection(&c, None, None, None)
                .await
                .unwrap()
                .is_empty()
        );
        let saved = mgr.save_connection(c, None, None).await.unwrap();
        assert!(
            !mgr.test_connection(&saved, None, None, None)
                .await
                .unwrap()
                .is_empty()
        );
        let ws = mgr
            .open_workspace(&saved.id, None, None, None)
            .await
            .unwrap();
        let sid = mgr.open_sql_session(&ws.workspace_id).await.unwrap();
        let c = Collector::new();
        mgr.execute_batch(&sid, sql(&["select count(*) from items"]), c.sink())
            .await
            .unwrap();
        assert_eq!(c.all(), ["started0", "finished0", "batch:false"]);
        mgr.close_workspace(&ws.workspace_id).await.unwrap();
        mgr.delete_connection(&saved.id).await.unwrap();
        assert!(mgr.list_connections().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn sqlite_password_resolution_never_touches_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = manager(&dir, Arc::new(BrokenSecrets));
        for mode in [PasswordMode::Keyring, PasswordMode::Ask, PasswordMode::None] {
            let mut c = cfg(DriverKind::Sqlite, mode);
            c.id = "saved".into();
            assert_eq!(mgr.resolve_password(&c, None).await.unwrap(), None);
            assert_eq!(
                mgr.resolve_password(&c, Some("x".into())).await.unwrap(),
                None
            );
        }
    }

    fn ssh(auth: SshAuth) -> SshSettings {
        SshSettings {
            host: "bastion".into(),
            port: None,
            user: None,
            auth,
            key_file: None,
            secret_mode: PasswordMode::Keyring,
        }
    }

    #[tokio::test]
    async fn sqlite_ignores_ssh_settings() {
        let fx = fixture();
        let mut c = sqlite_cfg(&fx);
        c.ssh = Some(ssh(SshAuth::Password));
        assert!(
            !fx.mgr
                .test_connection(&c, None, None, None)
                .await
                .unwrap()
                .is_empty()
        );
        let saved = fx.mgr.save_connection(c, None, None).await.unwrap();
        assert_eq!(saved.ssh, None);
    }

    #[tokio::test]
    async fn test_connection_reuses_ssh_secret_only_for_unchanged_identity() {
        let secrets = Arc::new(CountingSecrets {
            inner: MemorySecretStore::new(),
            gets: AtomicUsize::new(0),
        });
        let dir = tempfile::tempdir().unwrap();
        let mgr = manager(&dir, secrets.clone());
        // Nothing listens on 127.0.0.1:1: reaching the network yields a Connection error.
        let mut c = cfg(DriverKind::Postgres, PasswordMode::Ask);
        c.host = "db.internal".into();
        let mut s = ssh(SshAuth::Password);
        s.host = "127.0.0.1".into();
        s.port = Some(1);
        s.user = Some("u".into());
        c.ssh = Some(s);
        let saved = mgr
            .save_connection(c, None, Some("ssh-pw".into()))
            .await
            .unwrap();

        // Unchanged identity: the stored SSH password is read, then the network is reached.
        let err = mgr
            .test_connection(&saved, Some("db".into()), None, None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Connection, "{}", err.message);
        assert_eq!(secrets.gets.load(Ordering::SeqCst), 1);

        // Another SSH server: the stored SSH password is never read nor sent.
        let mut moved = saved.clone();
        moved.ssh.as_mut().unwrap().host = "127.0.0.2".into();
        let err = mgr
            .test_connection(&moved, Some("db".into()), None, None)
            .await
            .unwrap_err();
        assert_eq!(
            (err.kind, err.message.as_str()),
            (ErrorKind::Auth, "ssh password required")
        );
        assert_eq!(secrets.gets.load(Ordering::SeqCst), 1);

        // A typed SSH password is always accepted.
        let err = mgr
            .test_connection(&moved, Some("db".into()), Some("typed".into()), None)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Connection, "{}", err.message);
        assert_eq!(secrets.gets.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn test_connection_with_downgraded_tls_requires_password() {
        let secrets = Arc::new(CountingSecrets {
            inner: MemorySecretStore::new(),
            gets: AtomicUsize::new(0),
        });
        let dir = tempfile::tempdir().unwrap();
        let mgr = manager(&dir, secrets.clone());
        let mut c = cfg(DriverKind::Postgres, PasswordMode::Keyring);
        c.host = "db.example.com".into();
        c.ssl.mode = crate::driver::tls::SslMode::VerifyFull;
        let saved = mgr
            .save_connection(c, Some("pw".into()), None)
            .await
            .unwrap();
        let mut weaker = saved.clone();
        weaker.ssl.mode = crate::driver::tls::SslMode::Prefer;
        let err = mgr
            .test_connection(&weaker, None, None, None)
            .await
            .unwrap_err();
        assert_eq!(
            (err.kind, err.message.as_str()),
            (ErrorKind::Auth, "password required")
        );
        assert_eq!(secrets.gets.load(Ordering::SeqCst), 0, "keyring never read");
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_ssh_open_times_out() {
        let start = Instant::now();
        let err = with_ssh_timeout(std::future::pending::<AppResult<()>>())
            .await
            .unwrap_err();
        assert_eq!(
            (err.kind, err.message.as_str()),
            (ErrorKind::Connection, "ssh connection timed out")
        );
        assert_eq!(start.elapsed(), SSH_OPEN_TIMEOUT);
        assert_eq!(SSH_OPEN_TIMEOUT, Duration::from_secs(30));
        // A result within the bound passes through untouched.
        let ok = with_ssh_timeout(async { Ok::<_, AppError>(7) }).await;
        assert_eq!(ok.unwrap(), 7);
    }
}

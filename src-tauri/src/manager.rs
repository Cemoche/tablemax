//! Session manager: owns the open workspaces (one browse connection each) and the
//! dedicated SQL sessions, runs statement batches and cancels them.
//!
//! Locking: the state map sits behind a std mutex that is only held for map
//! lookups/updates, never across an `.await` on database I/O. Each SQL session keeps
//! its `Arc<dyn Session>` and `Arc<dyn Canceller>` so a batch and a cancel can run
//! concurrently without touching the map.
//!
//! Passwords: resolved (argument, else OS keyring) right before connecting and passed
//! to the driver in `ConnectParams`; nothing is cached for keyring-only workspaces —
//! opening a SQL session re-reads the keyring. A password typed by the user when the
//! workspace was opened (`Ask` mode, or an explicit override) cannot be re-read from
//! anywhere, so it is kept in memory in the workspace entry as a [`HeldPassword`]
//! (no `Debug` output, not serializable) until the workspace is closed.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use tokio::time::Instant;

use crate::driver::{self, Canceller, ConnectParams, Dialect, Session, StatementOutcome};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::secrets::{SecretKey, SecretKind, SecretStore};
use crate::store::{self, ConnectionConfig, ConnectionStore, PasswordMode, same_identity};

/// How often a pending cancel is re-sent while the statement is still running.
pub const CANCEL_RESEND_INTERVAL: Duration = Duration::from_millis(100);
/// Upper bound on how long `cancel` keeps re-sending.
pub const CANCEL_TIMEOUT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(10);

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

/// A password typed by the user, kept only for the lifetime of its workspace.
/// Deliberately not `Serialize`, and its `Debug` output never shows the value.
struct HeldPassword(String);

impl std::fmt::Debug for HeldPassword {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("HeldPassword(<redacted>)")
    }
}

struct Workspace {
    config: ConnectionConfig,
    held_password: Option<HeldPassword>,
    browse: Arc<dyn Session>,
    sql_sessions: Vec<String>,
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

fn connect_params(cfg: &ConnectionConfig, password: Option<String>) -> ConnectParams {
    ConnectParams {
        kind: cfg.kind,
        host: cfg.host.clone(),
        port: cfg.port,
        user: cfg.user.clone(),
        password,
        database: cfg.database.clone(),
        sqlite_path: cfg.sqlite_path.as_ref().map(Into::into),
    }
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
    pub fn new(store: Arc<ConnectionStore>, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            store,
            secrets,
            state: Mutex::new(State::default()),
        }
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
    ) -> AppResult<ConnectionConfig> {
        let (st, sec) = (self.store.clone(), self.secrets.clone());
        blocking(move || store::save_connection(&st, sec.as_ref(), cfg, password)).await
    }

    pub async fn delete_connection(&self, id: &str) -> AppResult<()> {
        let (st, sec, id) = (self.store.clone(), self.secrets.clone(), id.to_string());
        blocking(move || store::delete_connection(&st, sec.as_ref(), &id)).await
    }

    /// Password for connecting with `cfg`: `None` mode → none; `Ask` → the argument or
    /// an Auth error (before any network I/O); `Keyring` → the argument if given, else
    /// the stored secret (only for saved configs, i.e. non-empty id).
    ///
    /// `cfg` must be the stored config for `cfg.id` (or have an empty id): callers
    /// holding a frontend-supplied config check `same_identity` first.
    async fn resolve_password(
        &self,
        cfg: &ConnectionConfig,
        password: Option<String>,
    ) -> AppResult<Option<String>> {
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

    /// Connects with `cfg` (saved or not), returns the server version, disconnects.
    ///
    /// `cfg` comes from the frontend and may differ from what is stored under
    /// `cfg.id`: the keyring secret is only reused when the connection identity
    /// (kind, host, port, user, database, sqlite_path) matches the stored config, so
    /// an edited config can never send the stored password elsewhere. Otherwise an
    /// explicit password is required (Auth "password required", before any I/O).
    pub async fn test_connection(
        &self,
        cfg: &ConnectionConfig,
        password: Option<String>,
    ) -> AppResult<String> {
        let mut cfg = cfg.clone();
        if cfg.password_mode == PasswordMode::Keyring && password.is_none() && !cfg.id.is_empty() {
            let store = self.store.clone();
            let id = cfg.id.clone();
            match blocking(move || store.get(&id)).await {
                Ok(stored) if same_identity(&stored, &cfg) => {}
                Ok(_) => return Err(AppError::new(ErrorKind::Auth, "password required")),
                // Not saved: there is no stored identity to bind a secret to.
                Err(e) if e.kind == ErrorKind::NotFound => cfg.id.clear(),
                Err(e) => return Err(e),
            }
        }
        let cfg = &cfg;
        let password = self.resolve_password(cfg, password).await?;
        let session = driver::connect(&connect_params(cfg, password)).await?;
        let version = session.server_version();
        let _ = session.close().await;
        Ok(version)
    }

    pub async fn open_workspace(
        &self,
        connection_id: &str,
        password: Option<String>,
    ) -> AppResult<WorkspaceInfo> {
        let store = self.store.clone();
        let id = connection_id.to_string();
        let config = blocking(move || store.get(&id)).await?;
        let held_password = match config.password_mode {
            PasswordMode::None => None,
            _ => password.clone().map(HeldPassword),
        };
        let resolved = self.resolve_password(&config, password).await?;
        let browse = driver::connect(&connect_params(&config, resolved)).await?;
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
                browse,
                sql_sessions: Vec::new(),
            },
        );
        Ok(info)
    }

    /// Closes the workspace, its SQL sessions (cancelling running batches) and its
    /// browse connection. Every close is attempted; the first error is returned.
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
        if let Err(e) = ws.browse.close().await {
            first_err.get_or_insert(e);
        }
        first_err.map_or(Ok(()), Err)
    }

    /// The workspace's shared browse connection (schemas, objects, pages, counts).
    pub fn browse(&self, workspace_id: &str) -> AppResult<Arc<dyn Session>> {
        self.state()
            .workspaces
            .get(workspace_id)
            .map(|ws| ws.browse.clone())
            .ok_or_else(|| workspace_not_found(workspace_id))
    }

    /// Opens a dedicated connection with the workspace's parameters.
    pub async fn open_sql_session(&self, workspace_id: &str) -> AppResult<String> {
        let (config, held) = {
            let st = self.state();
            let ws = st
                .workspaces
                .get(workspace_id)
                .ok_or_else(|| workspace_not_found(workspace_id))?;
            (
                ws.config.clone(),
                ws.held_password.as_ref().map(|p| p.0.clone()),
            )
        };
        let password = self.resolve_password(&config, held).await?;
        let session = driver::connect(&connect_params(&config, password)).await?;
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
    use crate::driver::{
        Canceller, DbObject, DriverKind, ObjectRef, PageRequest, ResultSet, RowCount,
    };
    use crate::secrets::{MemorySecretStore, SecretKey, SecretKind};
    use crate::store::{EnvTag, PasswordMode};

    const WAIT: Duration = Duration::from_secs(10);
    const INFINITE_CTE: &str = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) \
                                SELECT count(*) FROM c";

    struct Fx {
        _dir: tempfile::TempDir,
        db_path: PathBuf,
        secrets: Arc<MemorySecretStore>,
        mgr: Arc<SessionManager>,
    }

    fn fixture() -> Fx {
        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionStore::open(&dir.path().join("app.db")).unwrap();
        let db_path = dir.path().join("data.db");
        let c = rusqlite::Connection::open(&db_path).unwrap();
        c.execute_batch(
            "CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO items(name) VALUES ('a'), ('b');",
        )
        .unwrap();
        drop(c);
        let secrets = Arc::new(MemorySecretStore::new());
        let mgr = Arc::new(SessionManager::new(Arc::new(store), secrets.clone()));
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
        }
    }

    fn sqlite_cfg(fx: &Fx) -> ConnectionConfig {
        let mut c = cfg(DriverKind::Sqlite, PasswordMode::None);
        c.sqlite_path = Some(fx.db_path.to_string_lossy().into_owned());
        c
    }

    async fn sqlite_ws(fx: &Fx) -> WorkspaceInfo {
        let saved = fx.mgr.save_connection(sqlite_cfg(fx), None).await.unwrap();
        fx.mgr.open_workspace(&saved.id, None).await.unwrap()
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
        let saved = fx.mgr.save_connection(c.clone(), None).await.unwrap();
        let err = fx.mgr.open_workspace(&saved.id, None).await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Auth);
        assert_eq!(err.message, "password required");
        let err = fx.mgr.test_connection(&c, None).await.unwrap_err();
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
            fx.mgr.browse(&ws.workspace_id).err().unwrap().kind,
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
        let v = fx.mgr.test_connection(&c, None).await.unwrap();
        assert!(!v.is_empty());
    }

    #[tokio::test]
    async fn unknown_ids_are_not_found() {
        let fx = fixture();
        assert_eq!(
            fx.mgr.open_workspace("nope", None).await.unwrap_err().kind,
            ErrorKind::NotFound
        );
        assert_eq!(
            fx.mgr.close_workspace("nope").await.unwrap_err().kind,
            ErrorKind::NotFound
        );
        assert_eq!(
            fx.mgr.browse("nope").err().unwrap().kind,
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
        async fn fetch_page(&self, _: &PageRequest) -> AppResult<ResultSet> {
            Err(AppError::new(ErrorKind::Invalid, "stub"))
        }
        async fn count_rows(&self, _: &ObjectRef, _: u64) -> AppResult<RowCount> {
            Ok(RowCount::Exact(0))
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
            .save_connection(c, Some("stored-pw".into()))
            .await
            .unwrap();
        let mut changed = saved.clone();
        changed.host = "127.0.0.2".into();
        // Reaching the driver would give a Connection error (nothing listens on port 1).
        let err = fx.mgr.test_connection(&changed, None).await.unwrap_err();
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
        let fx = fixture();
        let secrets = Arc::new(CountingSecrets {
            inner: MemorySecretStore::new(),
            gets: AtomicUsize::new(0),
        });
        let dir = tempfile::tempdir().unwrap();
        let store = ConnectionStore::open(&dir.path().join("app.db")).unwrap();
        let mgr = SessionManager::new(Arc::new(store), secrets.clone());
        let mut c = sqlite_cfg(&fx);
        c.password_mode = PasswordMode::Keyring;
        let saved = mgr.save_connection(c, Some("pw".into())).await.unwrap();

        // Unchanged identity (only cosmetic fields differ): the keyring is read.
        let mut renamed = saved.clone();
        renamed.name = "renamed".into();
        renamed.color = "#000".into();
        mgr.test_connection(&renamed, None).await.unwrap();
        assert_eq!(secrets.gets.load(Ordering::SeqCst), 1);

        // Changed identity: Auth error, keyring untouched.
        let mut moved = saved.clone();
        moved.sqlite_path = Some(dir.path().join("other.db").to_string_lossy().into());
        let err = mgr.test_connection(&moved, None).await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Auth);
        assert_eq!(secrets.gets.load(Ordering::SeqCst), 1);

        // An explicit password is always accepted (and the keyring is not read).
        mgr.test_connection(&saved, Some("typed".into()))
            .await
            .unwrap();
        assert_eq!(secrets.gets.load(Ordering::SeqCst), 1);
    }
}

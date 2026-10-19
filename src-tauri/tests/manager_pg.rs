//! SessionManager against PostgreSQL: proves cancel works across drivers.
//! Requires the test databases: `eval "$(bash scripts/test-dbs.sh env)"`.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::CountingSecrets;
use tablemax_lib::driver::DriverKind;
use tablemax_lib::driver::tls::SslConfig;
use tablemax_lib::error::ErrorKind;
use tablemax_lib::manager::{ExecEvent, SessionManager};
use tablemax_lib::secrets::MemorySecretStore;
use tablemax_lib::ssh::known_hosts::KnownHosts;
use tablemax_lib::store::{ConnectionConfig, ConnectionStore, EnvTag, PasswordMode};
use tokio::sync::mpsc;

const WAIT: Duration = Duration::from_secs(15);

fn known_hosts(dir: &tempfile::TempDir) -> KnownHosts {
    KnownHosts {
        system: None,
        app: dir.path().join("known_hosts"),
    }
}

#[tokio::test]
async fn cancel_marks_batch_cancelled_pg() {
    let url = &common::pg_urls()[0];
    let p = common::params_from_url(url, DriverKind::Postgres);
    let dir = tempfile::tempdir().unwrap();
    let store = ConnectionStore::open(&dir.path().join("app.db")).unwrap();
    let mgr = Arc::new(SessionManager::new(
        Arc::new(store),
        Arc::new(MemorySecretStore::new()),
        known_hosts(&dir),
    ));
    let cfg = ConnectionConfig {
        id: String::new(),
        name: "pg".into(),
        color: "#888".into(),
        env_tag: EnvTag::Local,
        kind: DriverKind::Postgres,
        host: p.host.clone(),
        port: p.port,
        user: p.user.clone(),
        database: p.database.clone(),
        sqlite_path: None,
        password_mode: PasswordMode::Keyring,
        group: None,
        ssl: SslConfig::default(),
        ssh: None,
        safe_mode: None,
    };
    let saved = mgr
        .save_connection(cfg, p.password.clone(), None)
        .await
        .unwrap();
    // Password comes from the (memory) keyring for both the browse and the SQL session.
    let ws = mgr
        .open_workspace(&saved.id, None, None, None)
        .await
        .unwrap();
    let sid = mgr.open_sql_session(&ws.workspace_id).await.unwrap();

    let events: Arc<Mutex<Vec<String>>> = Arc::default();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let sink = {
        let events = events.clone();
        move |e: ExecEvent| {
            let s = match &e {
                ExecEvent::StatementStarted { index } => format!("started{index}"),
                ExecEvent::StatementFinished { index, .. } => format!("finished{index}"),
                ExecEvent::StatementFailed { index, error } => {
                    format!("failed{index}:{:?}", error.kind)
                }
                ExecEvent::BatchFinished { cancelled } => format!("batch:{cancelled}"),
            };
            events.lock().unwrap().push(s.clone());
            let _ = tx.send(s);
        }
    };
    let (m, s) = (mgr.clone(), sid.clone());
    let batch = tokio::spawn(async move {
        m.execute_batch(
            &s,
            vec!["select pg_sleep(30)".into(), "select 2".into()],
            false,
            sink,
        )
        .await
    });
    tokio::time::timeout(WAIT, async {
        while let Some(s) = rx.recv().await {
            if s == "started0" {
                return;
            }
        }
    })
    .await
    .expect("statement never started");

    tokio::time::timeout(WAIT, mgr.cancel(&sid))
        .await
        .expect("cancel timed out")
        .unwrap();
    tokio::time::timeout(WAIT, batch)
        .await
        .expect("batch did not stop")
        .unwrap()
        .unwrap();
    assert_eq!(
        *events.lock().unwrap(),
        ["started0", "failed0:Cancelled", "batch:true"]
    );

    mgr.close_workspace(&ws.workspace_id).await.unwrap();
}

#[tokio::test]
async fn test_connection_reuses_keyring_only_for_unchanged_identity_pg() {
    let url = &common::pg_urls()[0];
    let p = common::params_from_url(url, DriverKind::Postgres);
    let dir = tempfile::tempdir().unwrap();
    let store = ConnectionStore::open(&dir.path().join("app.db")).unwrap();
    let mgr = SessionManager::new(
        Arc::new(store),
        Arc::new(MemorySecretStore::new()),
        known_hosts(&dir),
    );
    let cfg = ConnectionConfig {
        id: String::new(),
        name: "pg".into(),
        color: "#888".into(),
        env_tag: EnvTag::Local,
        kind: DriverKind::Postgres,
        host: p.host.clone(),
        port: p.port,
        user: p.user.clone(),
        database: p.database.clone(),
        sqlite_path: None,
        password_mode: PasswordMode::Keyring,
        group: None,
        ssl: SslConfig::default(),
        ssh: None,
        safe_mode: None,
    };
    let saved = mgr
        .save_connection(cfg, p.password.clone(), None)
        .await
        .unwrap();
    // Same identity: the stored password authenticates against the real server.
    let version = mgr.test_connection(&saved, None, None, None).await.unwrap();
    assert!(!version.is_empty());
    // Another user on the same server: the stored password must not be sent.
    let mut other = saved.clone();
    other.user = "someone_else".into();
    let err = mgr
        .test_connection(&other, None, None, None)
        .await
        .unwrap_err();
    assert_eq!(err.kind, tablemax_lib::error::ErrorKind::Auth);
    assert_eq!(err.message, "password required");
}

/// PostgreSQL 16 on `host` (`127.0.0.1` or `localhost`: the same server, two identities).
fn pg_cfg(host: &str, mode: PasswordMode) -> (ConnectionConfig, Option<String>) {
    let p = common::params_from_url(&common::pg_urls()[0], DriverKind::Postgres);
    let cfg = ConnectionConfig {
        id: String::new(),
        name: "pg".into(),
        color: "#888".into(),
        env_tag: EnvTag::Local,
        kind: DriverKind::Postgres,
        host: host.into(),
        port: p.port,
        user: p.user.clone(),
        database: p.database.clone(),
        sqlite_path: None,
        password_mode: mode,
        group: None,
        ssl: SslConfig::default(),
        ssh: None,
        safe_mode: None,
    };
    (cfg, p.password)
}

fn counting_manager(dir: &tempfile::TempDir) -> (Arc<CountingSecrets>, SessionManager) {
    let store = ConnectionStore::open(&dir.path().join("app.db")).unwrap();
    let secrets = Arc::new(CountingSecrets::default());
    let mgr = SessionManager::new(Arc::new(store), secrets.clone(), known_hosts(dir));
    (secrets, mgr)
}

/// An open workspace keeps the config it was opened with. Once the saved connection
/// points elsewhere, the keyring holds the new target's secret: reconnecting the old
/// workspace must never read it (it would be sent to the old server).
#[tokio::test]
async fn reconnect_never_reads_the_keyring_after_the_connection_was_retargeted() {
    let dir = tempfile::tempdir().unwrap();
    let (secrets, mgr) = counting_manager(&dir);
    let (cfg, pw) = pg_cfg("127.0.0.1", PasswordMode::Keyring);
    let saved = mgr.save_connection(cfg, pw.clone(), None).await.unwrap();
    let ws = mgr
        .open_workspace(&saved.id, None, None, None)
        .await
        .unwrap();

    // Unchanged identity (a rename): the stored password is still the workspace's.
    let renamed = ConnectionConfig {
        name: "pg renamed".into(),
        ..saved.clone()
    };
    let renamed = mgr.save_connection(renamed, None, None).await.unwrap();
    let sid = mgr.open_sql_session(&ws.workspace_id).await.unwrap();
    mgr.close_sql_session(&sid).await.unwrap();

    // Another host with a new password.
    let moved = ConnectionConfig {
        host: "localhost".into(),
        ..renamed
    };
    mgr.save_connection(moved, Some("new-target-secret".into()), None)
        .await
        .unwrap();
    secrets.reset();
    let e = mgr.open_sql_session(&ws.workspace_id).await.unwrap_err();
    assert_eq!(
        (e.kind, e.message.as_str()),
        (ErrorKind::Auth, "password required")
    );
    assert_eq!(
        secrets.gets(),
        0,
        "the keyring must not be read for the old target"
    );

    // Deleted: same.
    mgr.delete_connection(&saved.id).await.unwrap();
    let e = mgr.open_sql_session(&ws.workspace_id).await.unwrap_err();
    assert_eq!(
        (e.kind, e.message.as_str()),
        (ErrorKind::Auth, "password required")
    );
    assert_eq!(secrets.gets(), 0);
    mgr.close_workspace(&ws.workspace_id).await.unwrap();
}

#[tokio::test]
async fn reconnect_after_retarget_uses_the_held_password() {
    let dir = tempfile::tempdir().unwrap();
    let (secrets, mgr) = counting_manager(&dir);
    let (cfg, pw) = pg_cfg("127.0.0.1", PasswordMode::Ask);
    let saved = mgr.save_connection(cfg, None, None).await.unwrap();
    let ws = mgr.open_workspace(&saved.id, pw, None, None).await.unwrap();
    let moved = ConnectionConfig {
        host: "localhost".into(),
        ..saved
    };
    mgr.save_connection(moved, None, None).await.unwrap();
    secrets.reset();
    let sid = mgr.open_sql_session(&ws.workspace_id).await.unwrap();
    assert_eq!(secrets.gets(), 0);
    mgr.close_sql_session(&sid).await.unwrap();
    mgr.close_workspace(&ws.workspace_id).await.unwrap();
}

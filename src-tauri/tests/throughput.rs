//! Workspace throughput (#112) against the test databases, direct connections: the
//! browse connection and the SQL sessions go through the workspace's loopback relay,
//! whose bytes make the rate. Over SSH: `manager_ssh.rs`.
//! Requires the test databases: `eval "$(bash scripts/test-dbs.sh env)"`.
mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{mysql_urls, params_from_url, pg_urls};
use tablemax_lib::driver::DriverKind;
use tablemax_lib::driver::tls::SslConfig;
use tablemax_lib::manager::{ExecEvent, SessionManager};
use tablemax_lib::secrets::MemorySecretStore;
use tablemax_lib::ssh::known_hosts::KnownHosts;
use tablemax_lib::store::{ConnectionConfig, ConnectionStore, EnvTag, PasswordMode};
use tablemax_lib::traffic::{MIN_SPAN, RATE_WINDOW};

/// Size of the value each query brings back.
const BIG: u64 = 300_000;

fn manager(dir: &tempfile::TempDir) -> SessionManager {
    let store = ConnectionStore::open(&dir.path().join("app.db")).unwrap();
    let known_hosts = KnownHosts {
        system: None,
        app: dir.path().join("known_hosts"),
    };
    SessionManager::new(
        Arc::new(store),
        Arc::new(MemorySecretStore::new()),
        known_hosts,
    )
}

fn config(url: &str, kind: DriverKind) -> (ConnectionConfig, Option<String>) {
    let p = params_from_url(url, kind);
    let cfg = ConnectionConfig {
        id: String::new(),
        name: format!("{kind:?}"),
        color: "#888".into(),
        env_tag: EnvTag::Local,
        kind,
        host: p.host,
        port: p.port,
        user: p.user,
        database: p.database,
        sqlite_path: None,
        password_mode: PasswordMode::Keyring,
        group: None,
        ssl: SslConfig::default(),
        ssh: None,
        safe_mode: None,
        mongo: None,
    };
    (cfg, p.password)
}

/// Runs `sql` on the SQL session `sid`; panics on a failed statement.
async fn run(mgr: &SessionManager, sid: &str, sql: &str) {
    let failed: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = {
        let failed = failed.clone();
        move |e: ExecEvent| {
            if let ExecEvent::StatementFailed { error, .. } = &e {
                failed.lock().unwrap().push(error.message.clone());
            }
        }
    };
    mgr.execute_batch(sid, vec![sql.into()], false, sink)
        .await
        .unwrap();
    assert!(failed.lock().unwrap().is_empty(), "{:?}", failed.lock().unwrap());
}

/// The rate after a query moved `BIG` bytes on the browse connection, then on a SQL
/// session; then idle, back to exactly 0.
async fn assert_counted(url: &str, kind: DriverKind, big_value_sql: &str) {
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(&dir);
    let (cfg, pw) = config(url, kind);
    let saved = mgr.save_connection(cfg, pw, None).await.unwrap();
    let ws = mgr.open_workspace(&saved.id, None, None, None).await.unwrap();
    assert!(ws.capabilities.throughput, "{kind:?}");
    let id = ws.workspace_id.as_str();
    assert_eq!(
        mgr.workspace_throughput(id).unwrap(),
        None,
        "{kind:?}: the first call only takes a reference"
    );

    // Browse connection.
    let out = mgr.browse(id).await.unwrap().execute(big_value_sql).await;
    out.unwrap();
    tokio::time::sleep(MIN_SPAN + Duration::from_millis(100)).await;
    let rate = mgr.workspace_throughput(id).unwrap().expect("a rate");
    // BIG bytes over a span of at most a few seconds.
    assert!(rate.read_per_sec >= BIG / 4, "{kind:?}: {rate:?}");
    assert!(rate.written_per_sec > 0, "{kind:?}: {rate:?}");

    // A SQL session dials the same relay: its bytes count too.
    let sid = mgr.open_sql_session(id).await.unwrap();
    tokio::time::sleep(RATE_WINDOW + Duration::from_millis(200)).await;
    mgr.workspace_throughput(id).unwrap();
    run(&mgr, &sid, big_value_sql).await;
    tokio::time::sleep(MIN_SPAN + Duration::from_millis(100)).await;
    let rate = mgr.workspace_throughput(id).unwrap().expect("a rate");
    assert!(rate.read_per_sec >= BIG / 4, "{kind:?} SQL session: {rate:?}");

    // Idle: no traffic at all within the window.
    for _ in 0..3 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        mgr.workspace_throughput(id).unwrap();
    }
    let idle = mgr.workspace_throughput(id).unwrap().expect("a rate");
    assert_eq!((idle.read_per_sec, idle.written_per_sec), (0, 0), "{kind:?}");
    mgr.close_workspace(id).await.unwrap();
}

#[tokio::test]
async fn postgres_direct_throughput() {
    for url in pg_urls() {
        assert_counted(&url, DriverKind::Postgres, &format!("SELECT repeat('x', {BIG})")).await;
    }
}

#[tokio::test]
async fn mysql_and_mariadb_direct_throughput() {
    // URL order from `scripts/test-dbs.sh env`: MySQL 8 first, MariaDB 11 second.
    for (i, url) in mysql_urls().into_iter().enumerate() {
        let kind = if i == 0 {
            DriverKind::MySql
        } else {
            DriverKind::MariaDb
        };
        assert_counted(&url, kind, &format!("SELECT REPEAT('x', {BIG})")).await;
    }
}

/// TLS stays end to end through the relay: the certificate is checked against the
/// connection's host, and a TLS failure keeps its own message (the relay reached the
/// server, so it has no failure of its own to report).
#[tokio::test]
async fn postgres_verify_full_through_the_relay() {
    use tablemax_lib::driver::tls::SslMode;
    use tablemax_lib::error::ErrorKind;
    for url in pg_urls() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = manager(&dir);
        let (mut cfg, pw) = config(&url, DriverKind::Postgres);
        cfg.host = "localhost".into();
        cfg.ssl = common::ssl(SslMode::VerifyFull, Some("ca.pem"));
        let saved = mgr.save_connection(cfg.clone(), pw.clone(), None).await.unwrap();
        let ws = mgr.open_workspace(&saved.id, None, None, None).await.unwrap();
        let sid = mgr.open_sql_session(&ws.workspace_id).await.unwrap();
        run(&mgr, &sid, "SELECT 1").await;
        mgr.close_workspace(&ws.workspace_id).await.unwrap();

        // The test certificate has no IP:127.0.0.1 SAN.
        cfg.id.clear();
        cfg.host = "127.0.0.1".into();
        let saved = mgr.save_connection(cfg, pw, None).await.unwrap();
        let e = mgr
            .open_workspace(&saved.id, None, None, None)
            .await
            .expect_err("wrong name");
        assert_eq!(e.kind, ErrorKind::Connection, "{}", e.message);
        assert!(e.message.contains("not valid for name"), "{}", e.message);
    }
}

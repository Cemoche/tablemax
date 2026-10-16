//! SessionManager against PostgreSQL: proves cancel works across drivers.
//! Requires the test databases: `eval "$(bash scripts/test-dbs.sh env)"`.

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tablemax_lib::driver::DriverKind;
use tablemax_lib::manager::{ExecEvent, SessionManager};
use tablemax_lib::secrets::MemorySecretStore;
use tablemax_lib::store::{ConnectionConfig, ConnectionStore, EnvTag, PasswordMode};
use tokio::sync::mpsc;

const WAIT: Duration = Duration::from_secs(15);

#[tokio::test]
async fn cancel_marks_batch_cancelled_pg() {
    let url = &common::pg_urls()[0];
    let p = common::params_from_url(url, DriverKind::Postgres);
    let dir = tempfile::tempdir().unwrap();
    let store = ConnectionStore::open(&dir.path().join("app.db")).unwrap();
    let mgr = Arc::new(SessionManager::new(
        Arc::new(store),
        Arc::new(MemorySecretStore::new()),
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
    };
    let saved = mgr.save_connection(cfg, p.password.clone()).await.unwrap();
    // Password comes from the (memory) keyring for both the browse and the SQL session.
    let ws = mgr.open_workspace(&saved.id, None).await.unwrap();
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

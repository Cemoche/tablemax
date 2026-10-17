//! Compound statements (CREATE PROCEDURE … BEGIN … END with inner `;`) through the path
//! the app uses: `SessionManager::execute_batch` on a dedicated SQL session, on MySQL and
//! MariaDB. Requires the test databases: `eval "$(bash scripts/test-dbs.sh env)"`.

mod common;

use std::sync::{Arc, Mutex};

use common::{mysql_urls, params_from_url, unique_schema};
use tablemax_lib::driver::mysql::connect_mysql;
use tablemax_lib::driver::tls::SslConfig;
use tablemax_lib::driver::{ConnectParams, DriverKind, Session};
use tablemax_lib::error::ErrorKind;
use tablemax_lib::manager::{ExecEvent, SessionManager};
use tablemax_lib::secrets::MemorySecretStore;
use tablemax_lib::ssh::known_hosts::KnownHosts;
use tablemax_lib::store::{ConnectionConfig, ConnectionStore, EnvTag, PasswordMode};
use tablemax_lib::value::CellValue;

/// Drops the test database on drop, even when an assertion fails.
struct DropDb {
    params: ConnectParams,
    name: String,
}

impl Drop for DropDb {
    fn drop(&mut self) {
        let params = self.params.clone();
        let sql = format!("DROP DATABASE IF EXISTS `{}`", self.name);
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                if let Ok(s) = connect_mysql(&params).await {
                    let _ = s.execute(&sql).await;
                    let _ = s.close().await;
                }
            });
        })
        .join();
    }
}

fn kind_for(index: usize) -> DriverKind {
    if index == 0 {
        DriverKind::MySql
    } else {
        DriverKind::MariaDb
    }
}

struct Mgr {
    _dir: tempfile::TempDir,
    mgr: SessionManager,
}

fn manager() -> Mgr {
    let dir = tempfile::tempdir().unwrap();
    let store = ConnectionStore::open(&dir.path().join("app.db")).unwrap();
    let known = KnownHosts {
        system: None,
        app: dir.path().join("known_hosts"),
    };
    let mgr = SessionManager::new(Arc::new(store), Arc::new(MemorySecretStore::new()), known);
    Mgr { _dir: dir, mgr }
}

/// Saves a connection to `database` and returns its id.
async fn save(m: &Mgr, url: &str, kind: DriverKind, database: &str) -> String {
    let p = params_from_url(url, kind);
    let cfg = ConnectionConfig {
        id: String::new(),
        name: "compound".into(),
        color: "#888".into(),
        env_tag: EnvTag::Local,
        kind,
        host: p.host.clone(),
        port: p.port,
        user: p.user.clone(),
        database: Some(database.to_string()),
        sqlite_path: None,
        password_mode: PasswordMode::Keyring,
        group: None,
        ssl: SslConfig::default(),
        ssh: None,
    };
    m.mgr
        .save_connection(cfg, p.password.clone(), None)
        .await
        .unwrap()
        .id
}

#[derive(Debug)]
enum Got {
    Finished(Option<Vec<Vec<CellValue>>>),
    Failed(ErrorKind, String),
}

async fn batch(mgr: &SessionManager, sid: &str, statements: &[&str]) -> Vec<Got> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = {
        let events = events.clone();
        move |e: ExecEvent| match e {
            ExecEvent::StatementFinished { outcome, .. } => events
                .lock()
                .unwrap()
                .push(Got::Finished(outcome.result.map(|r| r.rows))),
            ExecEvent::StatementFailed { error, .. } => events
                .lock()
                .unwrap()
                .push(Got::Failed(error.kind, error.message)),
            _ => {}
        }
    };
    let owned: Vec<String> = statements.iter().map(|s| s.to_string()).collect();
    mgr.execute_batch(sid, owned, sink).await.unwrap();
    let out = std::mem::take(&mut *events.lock().unwrap());
    out
}

#[tokio::test]
async fn mysql_compound_procedure_runs_through_execute_batch() {
    let m = manager();
    for (i, url) in mysql_urls().into_iter().enumerate() {
        let kind = kind_for(i);
        let params = params_from_url(&url, kind);
        let db = unique_schema();
        let admin = connect_mysql(&params).await.unwrap();
        admin
            .execute(&format!("CREATE DATABASE `{db}`"))
            .await
            .unwrap();
        admin.close().await.unwrap();
        let _guard = DropDb {
            params,
            name: db.clone(),
        };

        let id = save(&m, &url, kind, &db).await;
        let ws = m.mgr.open_workspace(&id, None, None, None).await.unwrap();
        let sid = m.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
        let proc_name = format!("p4_compound_{}", db.replace('-', "_"));
        // The body as `splitStatements` sends it: one statement, inner `;` included.
        let create = format!(
            "CREATE PROCEDURE `{proc_name}`(IN n INT)\n\
             BEGIN\n\
             \x20 DECLARE i INT DEFAULT 0;\n\
             \x20 DECLARE total INT DEFAULT 0;\n\
             \x20 WHILE i < n DO\n\
             \x20   SET i = i + 1;\n\
             \x20   IF i % 2 = 0 THEN SET total = total + i; END IF;\n\
             \x20 END WHILE;\n\
             \x20 SELECT CASE WHEN total > 0 THEN total ELSE -1 END AS total;\n\
             END"
        );
        let call = format!("CALL `{proc_name}`(4)");
        let drop = format!("DROP PROCEDURE `{proc_name}`");
        let got = batch(&m.mgr, &sid, &[&create, &call, &drop]).await;
        assert_eq!(got.len(), 3, "{url}: {got:?}");
        assert!(
            matches!(&got[0], Got::Finished(_)),
            "{url} create: {:?}",
            got[0]
        );
        match &got[1] {
            Got::Finished(Some(rows)) => {
                assert_eq!(rows.len(), 1, "{url}: {rows:?}");
                // 2 + 4
                let v = &rows[0][0];
                let six = match v {
                    CellValue::Int(n) => *n == 6,
                    CellValue::Text(s) => s == "6",
                    other => panic!("{url}: unexpected {other:?}"),
                };
                assert!(six, "{url}: {v:?}");
            }
            other => panic!("{url} call: {other:?}"),
        }
        assert!(
            matches!(&got[2], Got::Finished(_)),
            "{url} drop: {:?}",
            got[2]
        );

        // A genuine second statement after the body is still refused before execution.
        let sneaky = format!("CREATE PROCEDURE `{proc_name}_x`() BEGIN SELECT 1; END; SELECT 2");
        let got = batch(&m.mgr, &sid, &[&sneaky]).await;
        match &got[..] {
            [Got::Failed(ErrorKind::Invalid, msg)] => {
                assert!(msg.contains("exactly one statement"), "{url}: {msg}")
            }
            other => panic!("{url} sneaky: {other:?}"),
        }
        // Review round 1: these ran `DROP TABLE` on both servers when the lexer took a
        // BEGIN / CASE outside a statement start for a block. Each must be refused and the
        // table must survive.
        let got = batch(&m.mgr, &sid, &["CREATE TABLE guard_x (a INT)"]).await;
        assert!(matches!(&got[..], [Got::Finished(_)]), "{url}: {got:?}");
        for sneaky in [
            "create procedure p4_case() begin set @case = 1; end; drop table guard_x; end",
            "create procedure p4_sel() select begin from guard_x; drop table guard_x; end",
            "create procedure p4_h() begin declare continue handler for sqlexception \
             select begin from guard_x; end; drop table guard_x; end",
        ] {
            let got = batch(&m.mgr, &sid, &[sneaky]).await;
            assert!(
                matches!(&got[..], [Got::Failed(ErrorKind::Invalid, _)]),
                "{url} {sneaky}: {got:?}"
            );
            let got = batch(&m.mgr, &sid, &["SELECT COUNT(*) FROM guard_x"]).await;
            assert!(
                matches!(&got[..], [Got::Finished(Some(_))]),
                "{url}: guard_x must still exist after {sneaky}: {got:?}"
            );
        }
        m.mgr.close_sql_session(&sid).await.unwrap();
        m.mgr.close_workspace(&ws.workspace_id).await.unwrap();
    }
}

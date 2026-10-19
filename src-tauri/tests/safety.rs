//! Safe mode through the SessionManager, on SQLite (no test server needed): a batch or a
//! grid commit that needs a confirmation is refused before anything of it runs.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tablemax_lib::driver::dml::{EditValue, RowChange, RowKey};
use tablemax_lib::driver::tls::SslConfig;
use tablemax_lib::driver::{DriverKind, ObjectRef};
use tablemax_lib::error::ErrorKind;
use tablemax_lib::manager::{ExecEvent, SessionManager};
use tablemax_lib::secrets::MemorySecretStore;
use tablemax_lib::ssh::known_hosts::KnownHosts;
use tablemax_lib::store::{ConnectionConfig, ConnectionStore, EnvTag, PasswordMode, SafeMode};
use tablemax_lib::value::CellValue;

struct Fx {
    _dir: tempfile::TempDir,
    db_path: PathBuf,
    mgr: SessionManager,
}

fn fixture() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("data.db");
    rusqlite::Connection::open(&db_path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO items(name) VALUES ('a'), ('b');",
        )
        .unwrap();
    let store = ConnectionStore::open(&dir.path().join("app.db")).unwrap();
    let known_hosts = KnownHosts {
        system: None,
        app: dir.path().join("known_hosts"),
    };
    let mgr = SessionManager::new(
        Arc::new(store),
        Arc::new(MemorySecretStore::new()),
        known_hosts,
    );
    Fx {
        _dir: dir,
        db_path,
        mgr,
    }
}

fn cfg(path: &Path, env_tag: EnvTag, safe_mode: Option<SafeMode>) -> ConnectionConfig {
    ConnectionConfig {
        id: String::new(),
        name: "lite".into(),
        color: "swatch-1".into(),
        env_tag,
        kind: DriverKind::Sqlite,
        host: String::new(),
        port: 0,
        user: String::new(),
        database: None,
        sqlite_path: Some(path.to_string_lossy().into_owned()),
        password_mode: PasswordMode::None,
        group: None,
        ssl: SslConfig::default(),
        ssh: None,
        safe_mode,
        mongo: None,
    }
}

/// Saves the connection, opens a workspace and a SQL session on it.
async fn session(
    fx: &Fx,
    env_tag: EnvTag,
    safe_mode: Option<SafeMode>,
) -> (ConnectionConfig, String) {
    let saved = fx
        .mgr
        .save_connection(cfg(&fx.db_path, env_tag, safe_mode), None, None)
        .await
        .unwrap();
    let ws = fx
        .mgr
        .open_workspace(&saved.id, None, None, None)
        .await
        .unwrap();
    let sid = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
    (saved, sid)
}

#[derive(Clone, Default)]
struct Events(Arc<Mutex<Vec<String>>>);

impl Events {
    fn sink(&self) -> impl Fn(ExecEvent) + Send + Sync + 'static {
        let events = self.0.clone();
        move |e| {
            let s = match e {
                ExecEvent::StatementStarted { index } => format!("started{index}"),
                ExecEvent::StatementFinished { index, .. } => format!("finished{index}"),
                ExecEvent::StatementFailed { index, error } => {
                    format!("failed{index}:{:?}", error.kind)
                }
                ExecEvent::BatchFinished { cancelled } => format!("batch:{cancelled}"),
            };
            events.lock().unwrap().push(s);
        }
    }

    fn all(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

fn names(path: &Path) -> Vec<String> {
    let c = rusqlite::Connection::open(path).unwrap();
    let mut stmt = c.prepare("SELECT name FROM items ORDER BY id").unwrap();
    stmt.query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

fn sql(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

const MIXED: &[&str] = &["select 1", "update items set name = 'z'", "select 2"];

#[tokio::test]
async fn mixed_batch_confirms_before_anything_runs() {
    let fx = fixture();
    // A prod connection without an explicit setting: confirmWrites.
    let (_, sid) = session(&fx, EnvTag::Prod, None).await;
    let events = Events::default();
    let err = fx
        .mgr
        .execute_batch(&sid, sql(MIXED), false, events.sink())
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::ConfirmationRequired);
    assert_eq!(err.message, "1");
    assert!(events.all().is_empty(), "nothing ran: {:?}", events.all());
    assert_eq!(names(&fx.db_path), ["a", "b"], "table unchanged");

    // The refused batch left the session idle: the confirmed batch runs right away.
    let events = Events::default();
    fx.mgr
        .execute_batch(&sid, sql(MIXED), true, events.sink())
        .await
        .unwrap();
    assert_eq!(
        events.all(),
        [
            "started0",
            "finished0",
            "started1",
            "finished1",
            "started2",
            "finished2",
            "batch:false"
        ]
    );
    assert_eq!(names(&fx.db_path), ["z", "z"]);
}

#[tokio::test]
async fn reads_on_a_protected_connection_run_without_confirmation() {
    let fx = fixture();
    let (_, sid) = session(&fx, EnvTag::Prod, Some(SafeMode::ConfirmWrites)).await;
    let events = Events::default();
    fx.mgr
        .execute_batch(
            &sid,
            sql(&["select * from items", "/* c */ select 1 -- trailing"]),
            false,
            events.sink(),
        )
        .await
        .unwrap();
    assert_eq!(
        events.all(),
        [
            "started0",
            "finished0",
            "started1",
            "finished1",
            "batch:false"
        ]
    );
}

#[tokio::test]
async fn confirm_all_asks_for_every_statement() {
    let fx = fixture();
    let (_, sid) = session(&fx, EnvTag::Local, Some(SafeMode::ConfirmAll)).await;
    let events = Events::default();
    let err = fx
        .mgr
        .execute_batch(
            &sid,
            sql(&["select 1", "select 2", "delete from items"]),
            false,
            events.sink(),
        )
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::ConfirmationRequired);
    assert_eq!(err.message, "0,1,2");
    assert!(events.all().is_empty());
    assert_eq!(names(&fx.db_path), ["a", "b"]);
}

#[tokio::test]
async fn off_connection_runs_without_confirmation() {
    let fx = fixture();
    // Explicitly off, even on prod.
    let (_, sid) = session(&fx, EnvTag::Prod, Some(SafeMode::Off)).await;
    let events = Events::default();
    fx.mgr
        .execute_batch(&sid, sql(MIXED), false, events.sink())
        .await
        .unwrap();
    assert_eq!(events.all().last().map(String::as_str), Some("batch:false"));
    assert_eq!(names(&fx.db_path), ["z", "z"]);

    // Default (by environment) on a non-prod tag: off.
    let (_, sid) = session(&fx, EnvTag::Dev, None).await;
    fx.mgr
        .execute_batch(&sid, sql(&["delete from items"]), false, |_| {})
        .await
        .unwrap();
    assert!(names(&fx.db_path).is_empty());
}

/// The safe mode is re-read from the store at each batch: a stricter setting saved while
/// the workspace is open applies to its next batch.
#[tokio::test]
async fn stricter_setting_applies_to_an_open_workspace() {
    let fx = fixture();
    let (saved, sid) = session(&fx, EnvTag::Local, None).await;
    fx.mgr
        .execute_batch(&sid, sql(&["update items set name = 'x'"]), false, |_| {})
        .await
        .unwrap();
    let stricter = ConnectionConfig {
        safe_mode: Some(SafeMode::ConfirmWrites),
        mongo: None,
        ..saved
    };
    fx.mgr.save_connection(stricter, None, None).await.unwrap();
    let err = fx
        .mgr
        .execute_batch(&sid, sql(&["update items set name = 'y'"]), false, |_| {})
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::ConfirmationRequired);
    assert_eq!(names(&fx.db_path), ["x", "x"]);
}

/// Ruling R16: loosening a connection while its workspace is open (retag prod → dev, or
/// switch the mode off) only applies at the next open; until then the stricter of the
/// saved and the opened settings is enforced.
#[tokio::test]
async fn looser_setting_waits_for_the_next_open() {
    for loosened in [
        (EnvTag::Dev, None),
        (EnvTag::Dev, Some(SafeMode::Off)),
        (EnvTag::Prod, Some(SafeMode::Off)),
    ] {
        let fx = fixture();
        let (saved, sid) = session(&fx, EnvTag::Prod, None).await;
        let looser = ConnectionConfig {
            env_tag: loosened.0,
            safe_mode: loosened.1,
            mongo: None,
            ..saved.clone()
        };
        fx.mgr.save_connection(looser, None, None).await.unwrap();
        let events = Events::default();
        let err = fx
            .mgr
            .execute_batch(&sid, sql(&["delete from items"]), false, events.sink())
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::ConfirmationRequired, "{loosened:?}");
        assert!(events.all().is_empty(), "nothing ran: {:?}", events.all());
        assert_eq!(names(&fx.db_path), ["a", "b"], "{loosened:?}");

        // A workspace opened after the change uses the looser setting.
        let ws = fx
            .mgr
            .open_workspace(&saved.id, None, None, None)
            .await
            .unwrap();
        let fresh = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
        fx.mgr
            .execute_batch(&fresh, sql(&["delete from items"]), false, |_| {})
            .await
            .unwrap();
        assert!(names(&fx.db_path).is_empty(), "{loosened:?}");
    }
}

/// A deleted connection keeps the protection of the config the workspace was opened with.
#[tokio::test]
async fn deleted_connection_keeps_the_opened_config() {
    let fx = fixture();
    let (saved, sid) = session(&fx, EnvTag::Prod, None).await;
    fx.mgr.delete_connection(&saved.id).await.unwrap();
    let err = fx
        .mgr
        .execute_batch(&sid, sql(&["delete from items"]), false, |_| {})
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::ConfirmationRequired);
    assert_eq!(names(&fx.db_path), ["a", "b"]);
}

/// The open workspace still talks to the database it was opened on: once the saved
/// connection points elsewhere, it keeps the stricter of both settings.
#[tokio::test]
async fn edited_identity_keeps_the_stricter_setting() {
    let fx = fixture();
    let (saved, sid) = session(&fx, EnvTag::Prod, None).await;
    let other = fx._dir.path().join("other.db");
    let moved = ConnectionConfig {
        env_tag: EnvTag::Local,
        sqlite_path: Some(other.to_string_lossy().into_owned()),
        ..saved
    };
    fx.mgr.save_connection(moved, None, None).await.unwrap();
    let err = fx
        .mgr
        .execute_batch(&sid, sql(&["delete from items"]), false, |_| {})
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::ConfirmationRequired);
    assert_eq!(names(&fx.db_path), ["a", "b"]);
}

/// The store cannot be read: fail closed, every statement needs a confirmation.
#[tokio::test]
async fn unreadable_store_fails_closed() {
    let fx = fixture();
    let (saved, sid) = session(&fx, EnvTag::Local, Some(SafeMode::Off)).await;
    rusqlite::Connection::open(fx._dir.path().join("app.db"))
        .unwrap()
        .execute(
            "UPDATE connections SET config_json = 'not json' WHERE id = ?1",
            [&saved.id],
        )
        .unwrap();
    let events = Events::default();
    let err = fx
        .mgr
        .execute_batch(&sid, sql(&["select 1"]), false, events.sink())
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::ConfirmationRequired);
    assert_eq!(err.message, "0");
    assert!(events.all().is_empty());
}

// ---------------------------------------------------------------------------------------
// Grid commits (`changes_apply`): always writes, same guard as a batch.
// ---------------------------------------------------------------------------------------

/// Saves the connection and opens a workspace on it.
async fn workspace(
    fx: &Fx,
    env_tag: EnvTag,
    safe_mode: Option<SafeMode>,
) -> (ConnectionConfig, String) {
    let saved = fx
        .mgr
        .save_connection(cfg(&fx.db_path, env_tag, safe_mode), None, None)
        .await
        .unwrap();
    let ws = fx
        .mgr
        .open_workspace(&saved.id, None, None, None)
        .await
        .unwrap();
    (saved, ws.workspace_id)
}

fn items() -> ObjectRef {
    ObjectRef {
        schema: Some("main".into()),
        name: "items".into(),
    }
}

fn rename(id: i64, name: &str) -> RowChange {
    RowChange::Update {
        key: RowKey(vec![("id".into(), CellValue::Int(id))]),
        set: vec![("name".into(), EditValue::Text(name.into()))],
    }
}

/// Renames both rows to `name`.
fn rename_both(name: &str) -> Vec<RowChange> {
    vec![rename(1, name), rename(2, name)]
}

/// `changes_cancel` returns at once: no commit (ctl) is installed in the workspace. A
/// leftover ctl would make it wait for a commit that never ends.
async fn cancel_is_a_no_op(fx: &Fx, ws: &str) {
    let started = Instant::now();
    fx.mgr.changes_cancel(ws).await.unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "no commit left behind"
    );
}

#[tokio::test]
async fn grid_commit_on_a_protected_connection_needs_confirmation() {
    for (env_tag, safe_mode) in [
        // prod defaults to confirmWrites.
        (EnvTag::Prod, None),
        (EnvTag::Local, Some(SafeMode::ConfirmWrites)),
        (EnvTag::Local, Some(SafeMode::ConfirmAll)),
    ] {
        let fx = fixture();
        let (_, ws) = workspace(&fx, env_tag, safe_mode).await;
        let err = fx
            .mgr
            .changes_apply(&ws, &items(), &rename_both("z"), false)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::ConfirmationRequired, "{safe_mode:?}");
        assert_eq!(err.message, "0,1", "{safe_mode:?}");
        assert_eq!(names(&fx.db_path), ["a", "b"], "table unchanged");
        cancel_is_a_no_op(&fx, &ws).await;

        // Confirmed: applied.
        let o = fx
            .mgr
            .changes_apply(&ws, &items(), &rename_both("z"), true)
            .await
            .unwrap();
        assert!(o.applied, "{o:?}");
        assert_eq!(names(&fx.db_path), ["z", "z"]);
    }
}

/// The guard runs first: a change that could not even be built is still refused for
/// confirmation, so nothing of an unconfirmed commit is built or run.
#[tokio::test]
async fn unconfirmed_grid_commit_builds_nothing() {
    let fx = fixture();
    let (_, ws) = workspace(&fx, EnvTag::Prod, None).await;
    let bad = vec![RowChange::Update {
        key: RowKey(vec![("id".into(), CellValue::Int(1))]),
        set: vec![("nope".into(), EditValue::Text("x".into()))],
    }];
    let err = fx
        .mgr
        .changes_apply(&ws, &items(), &bad, false)
        .await
        .unwrap_err();
    assert_eq!(
        (err.kind, err.message.as_str()),
        (ErrorKind::ConfirmationRequired, "0")
    );
    // Confirmed, the same change is built and refused as invalid.
    let err = fx
        .mgr
        .changes_apply(&ws, &items(), &bad, true)
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Invalid);
}

#[tokio::test]
async fn grid_commit_without_safe_mode_needs_no_confirmation() {
    for (env_tag, safe_mode) in [
        // Explicitly off, even on prod.
        (EnvTag::Prod, Some(SafeMode::Off)),
        // Default (by environment) on a non-prod tag: off.
        (EnvTag::Dev, None),
    ] {
        let fx = fixture();
        let (_, ws) = workspace(&fx, env_tag, safe_mode).await;
        let o = fx
            .mgr
            .changes_apply(&ws, &items(), &rename_both("y"), false)
            .await
            .unwrap();
        assert!(o.applied, "{env_tag:?} {safe_mode:?}: {o:?}");
        assert_eq!(names(&fx.db_path), ["y", "y"]);
    }
}

/// Nothing to write: nothing to confirm.
#[tokio::test]
async fn empty_grid_commit_needs_no_confirmation() {
    let fx = fixture();
    let (_, ws) = workspace(&fx, EnvTag::Local, Some(SafeMode::ConfirmAll)).await;
    let o = fx
        .mgr
        .changes_apply(&ws, &items(), &[], false)
        .await
        .unwrap();
    assert!(o.applied, "{o:?}");
}

/// Ruling R16: a connection retagged to prod while its workspace is open protects the
/// next grid commit at once.
#[tokio::test]
async fn grid_commit_after_a_retag_to_prod_needs_confirmation() {
    let fx = fixture();
    let (saved, ws) = workspace(&fx, EnvTag::Local, None).await;
    let o = fx
        .mgr
        .changes_apply(&ws, &items(), &rename_both("x"), false)
        .await
        .unwrap();
    assert!(o.applied, "{o:?}");
    let prod = ConnectionConfig {
        env_tag: EnvTag::Prod,
        ..saved
    };
    fx.mgr.save_connection(prod, None, None).await.unwrap();
    let err = fx
        .mgr
        .changes_apply(&ws, &items(), &rename_both("w"), false)
        .await
        .unwrap_err();
    assert_eq!(
        (err.kind, err.message.as_str()),
        (ErrorKind::ConfirmationRequired, "0,1")
    );
    assert_eq!(names(&fx.db_path), ["x", "x"]);
    cancel_is_a_no_op(&fx, &ws).await;
}

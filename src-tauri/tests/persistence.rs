//! Query history, saved queries and session state (SQLite store + queries folder).
//! No database server needed: the manager tests run against a SQLite file.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tablemax_lib::driver::DriverKind;
use tablemax_lib::driver::tls::SslConfig;
use tablemax_lib::error::ErrorKind;
use tablemax_lib::history::{self, HISTORY_CAP, NewHistoryEntry};
use tablemax_lib::manager::SessionManager;
use tablemax_lib::saved_queries;
use tablemax_lib::secrets::MemorySecretStore;
use tablemax_lib::session_state;
use tablemax_lib::ssh::config::SshConfigFile;
use tablemax_lib::ssh::known_hosts::KnownHosts;
use tablemax_lib::store::{ConnectionConfig, ConnectionStore, EnvTag, PasswordMode};

fn entry(conn: &str, sql: &str, at: i64) -> NewHistoryEntry {
    NewHistoryEntry {
        connection_id: conn.into(),
        sql: sql.into(),
        executed_at: at,
        elapsed_ms: Some(3),
        rows: Some(1),
        error: None,
    }
}

fn open_store(dir: &tempfile::TempDir) -> ConnectionStore {
    ConnectionStore::open(&dir.path().join("app.db")).unwrap()
}

fn user_version(path: &Path) -> i64 {
    rusqlite::Connection::open(path)
        .unwrap()
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn migration_v1_to_v2_keeps_connections() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("app.db");
    {
        // A Plan 1/2 database: schema version 1, one saved connection.
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch(
            "CREATE TABLE connections(id TEXT PRIMARY KEY, name TEXT NOT NULL, config_json TEXT NOT NULL);
             PRAGMA user_version = 1;",
        )
        .unwrap();
        c.execute(
            "INSERT INTO connections(id, name, config_json) VALUES('c1', 'old', ?1)",
            [
                r##"{"id":"c1","name":"old","color":"#888","envTag":"dev","kind":"postgres",
              "host":"localhost","port":5432,"user":"u","database":null,"sqlitePath":null,
              "passwordMode":"keyring","group":null}"##,
            ],
        )
        .unwrap();
    }
    assert_eq!(user_version(&path), 1);
    let store = ConnectionStore::open(&path).unwrap();
    assert_eq!(user_version(&path), 2);
    assert_eq!(store.list().unwrap().len(), 1);
    assert_eq!(store.get("c1").unwrap().name, "old");
    // The new tables work, and reopening is a no-op.
    history::record(&store, entry("c1", "select 1", 1)).unwrap();
    drop(store);
    let store = ConnectionStore::open(&path).unwrap();
    assert_eq!(history::list(&store, "c1", None, 10).unwrap().len(), 1);
    assert_eq!(session_state::load_session(&store).unwrap(), None);
}

#[test]
fn history_cap_prunes_oldest() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(&dir);
    for i in 0..1005 {
        history::record(&store, entry("c1", &format!("select {i}"), i)).unwrap();
    }
    history::record(&store, entry("other", "select 'keep'", 0)).unwrap();
    let all = history::list(&store, "c1", None, 5000).unwrap();
    assert_eq!(HISTORY_CAP, 1000);
    assert_eq!(all.len(), 1000);
    assert_eq!(all.first().unwrap().sql, "select 1004");
    assert_eq!(all.last().unwrap().sql, "select 5", "the 5 oldest are gone");
    // The cap is per connection.
    assert_eq!(history::list(&store, "other", None, 10).unwrap().len(), 1);
}

#[test]
fn history_search_and_order() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(&dir);
    history::record(&store, entry("c1", "SELECT * FROM Orders", 10)).unwrap();
    history::record(&store, entry("c1", "update users set x = 1", 20)).unwrap();
    history::record(&store, entry("c1", "select * from orders where id = 1", 30)).unwrap();
    history::record(&store, entry("c2", "select * from orders", 40)).unwrap();
    let all = history::list(&store, "c1", None, 10).unwrap();
    let ats: Vec<i64> = all.iter().map(|e| e.executed_at).collect();
    assert_eq!(ats, [30, 20, 10], "most recent first");
    let found = history::list(&store, "c1", Some("ORDERS"), 10).unwrap();
    assert_eq!(found.len(), 2, "case-insensitive substring");
    assert_eq!(found[0].executed_at, 30);
    // LIKE wildcards are literal.
    assert!(
        history::list(&store, "c1", Some("%"), 10)
            .unwrap()
            .is_empty()
    );
    assert_eq!(history::list(&store, "c1", None, 2).unwrap().len(), 2);
    assert_eq!(
        history::list(&store, "c1", Some("orders"), 1)
            .unwrap()
            .len(),
        1
    );
    history::clear(&store, "c1").unwrap();
    assert!(history::list(&store, "c1", None, 10).unwrap().is_empty());
    assert_eq!(history::list(&store, "c2", None, 10).unwrap().len(), 1);
}

#[test]
fn session_too_large() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(&dir);
    let big = "x".repeat(5 * 1024 * 1024 + 1);
    let err = session_state::save_session(&store, &big).unwrap_err();
    assert_eq!(err.kind, ErrorKind::Invalid);
    assert_eq!(err.message, "session too large");
    assert_eq!(session_state::load_session(&store).unwrap(), None);
    let max = "x".repeat(5 * 1024 * 1024);
    session_state::save_session(&store, &max).unwrap();
    assert_eq!(
        session_state::load_session(&store).unwrap().unwrap().len(),
        max.len()
    );
}

#[test]
fn corrupt_session_is_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_store(&dir);
    // The backend never interprets the JSON: it returns the stored text as is.
    session_state::save_session(&store, "{not json").unwrap();
    assert_eq!(
        session_state::load_session(&store).unwrap().as_deref(),
        Some("{not json")
    );
    session_state::save_session(&store, r#"{"version":1}"#).unwrap();
    assert_eq!(
        session_state::load_session(&store).unwrap().as_deref(),
        Some(r#"{"version":1}"#)
    );
    // A missing table reads as "no session", not as an error.
    drop(store);
    let c = rusqlite::Connection::open(dir.path().join("app.db")).unwrap();
    c.execute_batch("DROP TABLE session_state").unwrap();
    drop(c);
    let store = ConnectionStore::open(&dir.path().join("app.db")).unwrap();
    assert_eq!(session_state::load_session(&store).unwrap(), None);
}

#[test]
fn saved_query_names_are_confined() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("queries");
    let long = "a".repeat(121);
    let hostile = [
        "",
        "../../etc/passwd",
        "..",
        "a..b",
        "a/b",
        "a\\b",
        "a\0b",
        "con",
        "CON",
        "Prn",
        "aux",
        "NUL",
        "com1",
        "COM9",
        "lpt1",
        "LPT9",
        "con.txt",
        "trailing ",
        "trailing.",
        "name:stream",
        "c:evil",
        "q*",
        "a\nb",
        &long,
    ];
    for name in hostile {
        let err = saved_queries::write(&base, "c1", name, "select 1")
            .expect_err(&format!("{name:?} must be refused"));
        assert_eq!(err.kind, ErrorKind::Invalid, "{name:?}");
        assert_eq!(err.message, "invalid query name", "{name:?}");
        assert!(saved_queries::read(&base, "c1", name).is_err(), "{name:?}");
        assert!(
            saved_queries::delete(&base, "c1", name).is_err(),
            "{name:?}"
        );
        assert!(saved_queries::rename(&base, "c1", name, "ok").is_err());
        assert!(saved_queries::rename(&base, "c1", "ok", name).is_err());
    }
    // Hostile connection ids are refused too.
    for id in ["", "..", "../x", "a/b", ".", "a\\b"] {
        assert!(
            saved_queries::write(&base, id, "ok", "x").is_err(),
            "{id:?}"
        );
        assert!(saved_queries::list(&base, id).is_err(), "{id:?}");
    }
    // Nothing was created anywhere under the tempdir.
    let mut created = Vec::new();
    fn walk(p: &Path, out: &mut Vec<String>) {
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                out.push(e.path().display().to_string());
                walk(&e.path(), out);
            }
        }
    }
    walk(dir.path(), &mut created);
    assert!(created.is_empty(), "stray files: {created:?}");
    // The longest legal name and an inner dot are fine, and stay in the folder.
    let max = "b".repeat(120);
    saved_queries::write(&base, "c1", &max, "select 1").unwrap();
    saved_queries::write(&base, "c1", "v1.2 report", "select 2").unwrap();
    let mut files = Vec::new();
    walk(dir.path(), &mut files);
    assert!(
        files.iter().all(|f| f.starts_with(base.to_str().unwrap())),
        "{files:?}"
    );
    assert_eq!(saved_queries::list(&base, "c1").unwrap().len(), 2);
}

#[test]
fn saved_query_write_is_atomic_and_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().join("queries");
    let sql = "-- été ✓ 日本語\r\nselect 'é';\r\nselect 2;\r\n";
    saved_queries::write(&base, "c1", "Été 日本", sql).unwrap();
    assert_eq!(saved_queries::read(&base, "c1", "Été 日本").unwrap(), sql);
    // The extension is added by the backend, the content stored byte for byte.
    let on_disk = std::fs::read(base.join("c1").join("Été 日本.sql")).unwrap();
    assert_eq!(on_disk, sql.as_bytes());
    // Overwrite replaces the content and leaves no temporary file behind.
    saved_queries::write(&base, "c1", "Été 日本", "select 3").unwrap();
    assert_eq!(
        saved_queries::read(&base, "c1", "Été 日本").unwrap(),
        "select 3"
    );
    let names: Vec<String> = std::fs::read_dir(base.join("c1"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names, ["Été 日本.sql"]);
    // List: sorted by name, with size and modification time.
    saved_queries::write(&base, "c1", "b", "12345").unwrap();
    saved_queries::write(&base, "c1", "a", "").unwrap();
    std::fs::write(base.join("c1").join("notes.txt"), "ignored").unwrap();
    let list = saved_queries::list(&base, "c1").unwrap();
    let got: Vec<&str> = list.iter().map(|q| q.name.as_str()).collect();
    assert_eq!(got, ["a", "b", "Été 日本"]);
    assert_eq!(list[1].size, 5);
    assert!(list[1].modified_at > 1_000_000_000_000);
    // Rename and delete.
    saved_queries::rename(&base, "c1", "b", "c").unwrap();
    assert_eq!(saved_queries::read(&base, "c1", "c").unwrap(), "12345");
    assert_eq!(
        saved_queries::read(&base, "c1", "b").unwrap_err().kind,
        ErrorKind::NotFound
    );
    assert_eq!(
        saved_queries::rename(&base, "c1", "a", "c")
            .unwrap_err()
            .kind,
        ErrorKind::Invalid,
        "no silent overwrite"
    );
    // Case-variants are distinct files on a case-sensitive filesystem: never clobbered.
    #[cfg(target_os = "linux")]
    {
        saved_queries::write(&base, "c1", "x", "lower").unwrap();
        saved_queries::write(&base, "c1", "X", "upper").unwrap();
        let err = saved_queries::rename(&base, "c1", "x", "X").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert_eq!(saved_queries::read(&base, "c1", "X").unwrap(), "upper");
        assert_eq!(saved_queries::read(&base, "c1", "x").unwrap(), "lower");
        // A case-only rename onto a free name still works.
        saved_queries::rename(&base, "c1", "x", "Y").unwrap();
        assert_eq!(saved_queries::read(&base, "c1", "Y").unwrap(), "lower");
    }
    saved_queries::delete(&base, "c1", "c").unwrap();
    assert_eq!(
        saved_queries::delete(&base, "c1", "c").unwrap_err().kind,
        ErrorKind::NotFound
    );
    // A connection without a folder lists nothing.
    assert!(saved_queries::list(&base, "never").unwrap().is_empty());
}

// ---- through the SessionManager ----

struct Fx {
    dir: tempfile::TempDir,
    db_path: std::path::PathBuf,
    mgr: Arc<SessionManager>,
}

fn fixture() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("data.db");
    rusqlite::Connection::open(&db_path)
        .unwrap()
        .execute_batch("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items(name) VALUES ('a'), ('b');")
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
    )
    .with_ssh_config(SshConfigFile::default())
    .with_queries_dir(dir.path().join("queries"));
    Fx {
        dir,
        db_path,
        mgr: Arc::new(mgr),
    }
}

fn sqlite_cfg(fx: &Fx) -> ConnectionConfig {
    ConnectionConfig {
        id: String::new(),
        name: "test".into(),
        color: "#888".into(),
        env_tag: EnvTag::Local,
        kind: DriverKind::Sqlite,
        host: "localhost".into(),
        port: 0,
        user: String::new(),
        database: None,
        sqlite_path: Some(fx.db_path.to_string_lossy().into_owned()),
        password_mode: PasswordMode::None,
        group: None,
        ssl: SslConfig::default(),
        ssh: None,
        safe_mode: None,
    }
}

fn sql(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// History is written off the batch's path: poll until `n` entries are there.
async fn wait_history(fx: &Fx, conn: &str, n: usize) -> Vec<history::HistoryEntry> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let list = fx.mgr.history_list(conn, None, 100).await.unwrap();
        if list.len() >= n || Instant::now() > deadline {
            return list;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn execute_batch_records_history() {
    let fx = fixture();
    let saved = fx
        .mgr
        .save_connection(sqlite_cfg(&fx), None, None)
        .await
        .unwrap();
    let ws = fx
        .mgr
        .open_workspace(&saved.id, None, None, None)
        .await
        .unwrap();
    let sid = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
    fx.mgr
        .execute_batch(
            &sid,
            sql(&[
                "select * from items",
                "insert into items(name) values ('c')",
                "select * from nope",
                "select 99",
            ]),
            true,
            |_| {},
        )
        .await
        .unwrap();
    // The failing statement stops the batch: three entries, newest first.
    let list = wait_history(&fx, &saved.id, 3).await;
    assert_eq!(list.len(), 3, "{list:?}");
    assert_eq!(list[0].sql, "select * from nope");
    assert!(list[0].error.as_deref().is_some_and(|m| !m.is_empty()));
    assert_eq!(list[0].rows, None);
    assert_eq!(list[1].sql, "insert into items(name) values ('c')");
    assert_eq!(list[1].rows, Some(1), "rows touched");
    assert_eq!(list[1].error, None);
    assert!(list[1].elapsed_ms.is_some());
    assert_eq!(list[2].sql, "select * from items");
    assert_eq!(list[2].rows, Some(2), "rows returned");
    assert!(list.iter().all(|e| e.connection_id == saved.id));
    // Search and clear go through the manager.
    let found = fx
        .mgr
        .history_list(&saved.id, Some("INSERT".into()), 10)
        .await
        .unwrap();
    assert_eq!(found.len(), 1);
    fx.mgr.history_clear(&saved.id).await.unwrap();
    assert!(
        fx.mgr
            .history_list(&saved.id, None, 10)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn deleting_connection_removes_history_and_queries() {
    let fx = fixture();
    let a = fx
        .mgr
        .save_connection(sqlite_cfg(&fx), None, None)
        .await
        .unwrap();
    let b = fx
        .mgr
        .save_connection(sqlite_cfg(&fx), None, None)
        .await
        .unwrap();
    for id in [&a.id, &b.id] {
        fx.mgr.saved_query_write(id, "q", "select 1").await.unwrap();
    }
    let ws = fx
        .mgr
        .open_workspace(&a.id, None, None, None)
        .await
        .unwrap();
    let sid = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
    fx.mgr
        .execute_batch(&sid, sql(&["select 1"]), true, |_| {})
        .await
        .unwrap();
    wait_history(&fx, &a.id, 1).await;
    fx.mgr.close_workspace(&ws.workspace_id).await.unwrap();

    fx.mgr.delete_connection(&a.id).await.unwrap();
    assert!(
        fx.mgr
            .history_list(&a.id, None, 10)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(!fx.dir.path().join("queries").join(&a.id).exists());
    // The other connection keeps its queries.
    assert!(
        fx.dir
            .path()
            .join("queries")
            .join(&b.id)
            .join("q.sql")
            .exists()
    );
    assert_eq!(fx.mgr.saved_queries_list(&b.id).await.unwrap().len(), 1);
    // Deleting a connection that has no folder is fine.
    let c = fx
        .mgr
        .save_connection(sqlite_cfg(&fx), None, None)
        .await
        .unwrap();
    fx.mgr.delete_connection(&c.id).await.unwrap();
}

#[tokio::test]
async fn saved_queries_require_an_existing_connection() {
    let fx = fixture();
    let err = fx
        .mgr
        .saved_query_write("ghost", "q", "select 1")
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::NotFound);
    assert!(!fx.dir.path().join("queries").join("ghost").exists());
    let err = fx.mgr.saved_queries_list("../x").await.unwrap_err();
    assert!(matches!(err.kind, ErrorKind::Invalid | ErrorKind::NotFound));
}

#[tokio::test]
async fn session_round_trip_through_the_manager() {
    let fx = fixture();
    assert_eq!(fx.mgr.session_load().await.unwrap(), None);
    fx.mgr
        .session_save(r#"{"version":1,"tabs":[]}"#.into())
        .await
        .unwrap();
    assert_eq!(
        fx.mgr.session_load().await.unwrap().as_deref(),
        Some(r#"{"version":1,"tabs":[]}"#)
    );
}

#[test]
fn wire_shapes_are_camel_case() {
    let h = history::HistoryEntry {
        id: 1,
        connection_id: "c".into(),
        sql: "select 1".into(),
        executed_at: 5,
        elapsed_ms: Some(3),
        rows: None,
        error: None,
    };
    assert_eq!(
        serde_json::to_string(&h).unwrap(),
        r#"{"id":1,"connectionId":"c","sql":"select 1","executedAt":5,"elapsedMs":3,"rows":null,"error":null}"#
    );
    let q = saved_queries::SavedQuery {
        name: "n".into(),
        modified_at: 7,
        size: 2,
    };
    assert_eq!(
        serde_json::to_string(&q).unwrap(),
        r#"{"name":"n","modifiedAt":7,"size":2}"#
    );
}

#[tokio::test]
async fn failed_queries_cleanup_keeps_the_connection() {
    let fx = fixture();
    let a = fx
        .mgr
        .save_connection(sqlite_cfg(&fx), None, None)
        .await
        .unwrap();
    fx.mgr
        .saved_query_write(&a.id, "q", "select 1")
        .await
        .unwrap();
    // Make the folder undeletable: a read-only parent (skipped when running as root).
    use std::os::unix::fs::PermissionsExt;
    let queries = fx.dir.path().join("queries");
    std::fs::set_permissions(&queries, std::fs::Permissions::from_mode(0o555)).unwrap();
    let denied = std::fs::create_dir(queries.join("probe")).is_err();
    let res = fx.mgr.delete_connection(&a.id).await;
    std::fs::set_permissions(&queries, std::fs::Permissions::from_mode(0o755)).unwrap();
    if denied {
        assert!(res.is_err());
        assert_eq!(
            fx.mgr
                .list_connections()
                .await
                .unwrap()
                .into_iter()
                .map(|c| c.id)
                .collect::<Vec<_>>(),
            [a.id.clone()]
        );
        fx.mgr.delete_connection(&a.id).await.unwrap();
    }
    assert!(!queries.join(&a.id).exists());
}

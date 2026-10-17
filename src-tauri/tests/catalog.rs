//! Completion catalog, routine list, database list and PostgreSQL database switching.
//! Requires the test databases: `eval "$(bash scripts/test-dbs.sh env)"`.

mod common;

use std::sync::Arc;

use common::{mysql_urls, params_from_url, pg_urls, unique_schema};
use tablemax_lib::driver::catalog::{Catalog, DbRoutine, RoutineKind};
use tablemax_lib::driver::mysql::connect_mysql;
use tablemax_lib::driver::postgres::connect_postgres;
use tablemax_lib::driver::sqlite::connect_sqlite;
use tablemax_lib::driver::tls::SslConfig;
use tablemax_lib::driver::{ConnectParams, DriverKind, ObjectKind, Session};
use tablemax_lib::error::ErrorKind;
use tablemax_lib::manager::SessionManager;
use tablemax_lib::secrets::MemorySecretStore;
use tablemax_lib::ssh::known_hosts::KnownHosts;
use tablemax_lib::store::{ConnectionConfig, ConnectionStore, EnvTag, PasswordMode};
use tablemax_lib::value::CellValue;

/// Runs `sql` on a throwaway connection when dropped (cleanup even if an assertion fails).
struct Cleanup {
    params: ConnectParams,
    sql: Vec<String>,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        let params = self.params.clone();
        let sql = self.sql.clone();
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                let s = tablemax_lib::driver::connect(&params).await;
                if let Ok(s) = s {
                    for q in &sql {
                        let _ = s.execute(q).await;
                    }
                    let _ = s.close().await;
                }
            });
        })
        .join();
    }
}

/// Engines under test: PostgreSQL (each URL), MySQL and MariaDB (each URL), each with a
/// fresh schema/database and its cleanup.
struct Target {
    label: String,
    session: Arc<dyn Session>,
    /// `None` for PostgreSQL's default-schema argument is the schema itself.
    schema: String,
    kind: DriverKind,
    _cleanup: Cleanup,
}

async fn pg_targets() -> Vec<Target> {
    let mut out = Vec::new();
    for url in pg_urls() {
        let params = params_from_url(&url, DriverKind::Postgres);
        let s = connect_postgres(&params).await.unwrap();
        let schema = unique_schema();
        s.execute(&format!("CREATE SCHEMA \"{schema}\""))
            .await
            .unwrap();
        s.execute(&format!("SET search_path TO \"{schema}\""))
            .await
            .unwrap();
        out.push(Target {
            label: format!("pg {url}"),
            session: s,
            kind: DriverKind::Postgres,
            _cleanup: Cleanup {
                params,
                sql: vec![format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE")],
            },
            schema,
        });
    }
    out
}

async fn mysql_targets() -> Vec<Target> {
    let mut out = Vec::new();
    for (i, url) in mysql_urls().into_iter().enumerate() {
        let kind = if i == 0 {
            DriverKind::MySql
        } else {
            DriverKind::MariaDb
        };
        let params = params_from_url(&url, kind);
        let s = connect_mysql(&params).await.unwrap();
        let schema = unique_schema();
        s.execute(&format!("CREATE DATABASE `{schema}`"))
            .await
            .unwrap();
        s.execute(&format!("USE `{schema}`")).await.unwrap();
        out.push(Target {
            label: format!("mysql {url}"),
            session: s,
            kind,
            _cleanup: Cleanup {
                params,
                sql: vec![format!("DROP DATABASE IF EXISTS `{schema}`")],
            },
            schema,
        });
    }
    out
}

async fn server_targets() -> Vec<Target> {
    let mut t = pg_targets().await;
    t.extend(mysql_targets().await);
    t
}

fn q(kind: DriverKind, ident: &str) -> String {
    match kind {
        DriverKind::MySql | DriverKind::MariaDb => format!("`{}`", ident.replace('`', "``")),
        _ => format!("\"{}\"", ident.replace('"', "\"\"")),
    }
}

fn table<'a>(c: &'a Catalog, name: &str) -> &'a tablemax_lib::driver::catalog::CatalogTable {
    c.tables
        .iter()
        .find(|t| t.name == name)
        .unwrap_or_else(|| panic!("table {name} missing in {:?}", c.tables))
}

fn col_names(t: &tablemax_lib::driver::catalog::CatalogTable) -> Vec<&str> {
    t.columns.iter().map(|c| c.name.as_str()).collect()
}

async fn sqlite_session() -> (tempfile::TempDir, Arc<dyn Session>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.db");
    rusqlite::Connection::open(&path).unwrap();
    let s = connect_sqlite(&path).await.unwrap();
    (dir, s)
}

#[tokio::test]
async fn catalog_lists_tables_views_and_columns() {
    for t in server_targets().await {
        let s = &t.session;
        s.execute("CREATE TABLE t (id int primary key, zeta text, alpha int)")
            .await
            .unwrap();
        s.execute("CREATE TABLE a_first (x int)").await.unwrap();
        s.execute("CREATE VIEW v AS SELECT id, zeta FROM t")
            .await
            .unwrap();
        if t.kind == DriverKind::Postgres {
            s.execute("CREATE MATERIALIZED VIEW mv AS SELECT id FROM t")
                .await
                .unwrap();
            // A dropped column must not show up, and must not shift the order.
            s.execute("ALTER TABLE t ADD COLUMN gone int")
                .await
                .unwrap();
            s.execute("ALTER TABLE t DROP COLUMN gone").await.unwrap();
            s.execute("ALTER TABLE t ADD COLUMN omega text")
                .await
                .unwrap();
        }
        let c = s.catalog(Some(&t.schema)).await.unwrap();
        assert_eq!(c.schema.as_deref(), Some(t.schema.as_str()), "{}", t.label);
        let names: Vec<&str> = c.tables.iter().map(|t| t.name.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "{}: tables sorted by name", t.label);
        let tt = table(&c, "t");
        assert_eq!(tt.kind, ObjectKind::Table, "{}", t.label);
        let mut want = vec!["id", "zeta", "alpha"];
        if t.kind == DriverKind::Postgres {
            want.push("omega");
        }
        assert_eq!(col_names(tt), want, "{}: definition order", t.label);
        assert!(
            tt.columns[0].type_name.starts_with("int"),
            "{}: {:?}",
            t.label,
            tt.columns[0]
        );
        assert_eq!(tt.columns[1].type_name, "text", "{}", t.label);
        let v = table(&c, "v");
        assert_eq!(v.kind, ObjectKind::View, "{}", t.label);
        assert_eq!(col_names(v), ["id", "zeta"], "{}", t.label);
        if t.kind == DriverKind::Postgres {
            assert_eq!(table(&c, "mv").kind, ObjectKind::View);
        }
        assert_eq!(table(&c, "a_first").kind, ObjectKind::Table);
        // The same objects list_objects reports.
        let objs = s.list_objects(Some(&t.schema)).await.unwrap();
        assert_eq!(objs.len(), c.tables.len(), "{}", t.label);
    }

    let (_d, s) = sqlite_session().await;
    s.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, zeta TEXT, alpha, beta NUMERIC)")
        .await
        .unwrap();
    s.execute("CREATE VIEW v AS SELECT id, zeta FROM t")
        .await
        .unwrap();
    let c = s.catalog(None).await.unwrap();
    assert_eq!(c.schema.as_deref(), Some("main"));
    assert_eq!(
        c.tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
        ["t", "v"]
    );
    let tt = table(&c, "t");
    assert_eq!(col_names(tt), ["id", "zeta", "alpha", "beta"]);
    assert_eq!(tt.columns[0].type_name, "INTEGER");
    assert_eq!(tt.columns[2].type_name, "", "untyped column");
    assert_eq!(table(&c, "v").kind, ObjectKind::View);
    assert_eq!(col_names(table(&c, "v")), ["id", "zeta"]);
}

#[tokio::test]
async fn catalog_handles_tricky_names() {
    let tables = [
        "order",
        "My Table",
        "we\"ird",
        "we`ird",
        "ünï çödé",
        "a.b",
        "x'y",
    ];
    let cols = [
        "select",
        "Mixed Case",
        "col\"q",
        "col`q",
        "naïve",
        "dot.col",
    ];
    for t in server_targets().await {
        for name in tables {
            // MySQL identifiers cannot contain a dot-free-trailing space issue here, but
            // quotes are fine once escaped.
            let defs: Vec<String> = cols
                .iter()
                .map(|c| format!("{} int", q(t.kind, c)))
                .collect();
            t.session
                .execute(&format!(
                    "CREATE TABLE {} ({})",
                    q(t.kind, name),
                    defs.join(", ")
                ))
                .await
                .unwrap_or_else(|e| panic!("{} {name}: {e:?}", t.label));
        }
        if t.kind == DriverKind::Postgres {
            t.session
                .execute("CREATE TABLE empty_table ()")
                .await
                .unwrap();
        }
        let c = t.session.catalog(Some(&t.schema)).await.unwrap();
        for name in tables {
            assert_eq!(col_names(table(&c, name)), cols, "{} {name}", t.label);
        }
        if t.kind == DriverKind::Postgres {
            assert!(table(&c, "empty_table").columns.is_empty());
        }
    }

    let (_d, s) = sqlite_session().await;
    for name in tables {
        let defs: Vec<String> = cols
            .iter()
            .map(|c| format!("{} int", q(DriverKind::Sqlite, c)))
            .collect();
        s.execute(&format!(
            "CREATE TABLE {} ({})",
            q(DriverKind::Sqlite, name),
            defs.join(", ")
        ))
        .await
        .unwrap();
    }
    let c = s.catalog(Some("main")).await.unwrap();
    for name in tables {
        assert_eq!(col_names(table(&c, name)), cols, "sqlite {name}");
    }
}

#[tokio::test]
async fn catalog_of_an_unknown_schema_is_empty() {
    for t in server_targets().await {
        let c = t.session.catalog(Some("no_such_schema_p4")).await.unwrap();
        assert!(c.tables.is_empty(), "{}", t.label);
    }
}

#[tokio::test]
async fn routines_listed() {
    for t in pg_targets().await {
        let s = &t.session;
        let sch = &t.schema;
        s.execute(&format!(
            "CREATE FUNCTION \"{sch}\".f_one() RETURNS int LANGUAGE sql AS $$ select 1 $$"
        ))
        .await
        .unwrap();
        s.execute(&format!(
            "CREATE PROCEDURE \"{sch}\".p_one() LANGUAGE sql AS $$ select 1 $$"
        ))
        .await
        .unwrap();
        let r = s.list_routines(Some(sch)).await.unwrap();
        let want = |name: &str, kind| DbRoutine {
            schema: Some(sch.clone()),
            name: name.into(),
            kind,
        };
        assert_eq!(
            r,
            vec![
                want("f_one", RoutineKind::Function),
                want("p_one", RoutineKind::Procedure)
            ],
            "{}",
            t.label
        );
        // Without a schema: every user schema, never the system ones.
        let all = s.list_routines(None).await.unwrap();
        assert!(all.contains(&want("f_one", RoutineKind::Function)));
        assert!(
            all.iter().all(|r| r.schema.as_deref() != Some("pg_catalog")
                && r.schema.as_deref() != Some("information_schema")),
            "{}",
            t.label
        );
    }
    for t in mysql_targets().await {
        let s = &t.session;
        s.execute("CREATE FUNCTION f_one() RETURNS INT DETERMINISTIC RETURN 1")
            .await
            .unwrap();
        s.execute("CREATE PROCEDURE p_one() SELECT 1")
            .await
            .unwrap();
        let r = s.list_routines(Some(&t.schema)).await.unwrap();
        let want = |name: &str, kind| DbRoutine {
            schema: Some(t.schema.clone()),
            name: name.into(),
            kind,
        };
        let expected = vec![
            want("f_one", RoutineKind::Function),
            want("p_one", RoutineKind::Procedure),
        ];
        assert_eq!(r, expected, "{}", t.label);
        // None = the connection's current database.
        assert_eq!(
            s.list_routines(None).await.unwrap(),
            expected,
            "{}",
            t.label
        );
    }
    let (_d, s) = sqlite_session().await;
    assert!(s.list_routines(None).await.unwrap().is_empty());
}

#[tokio::test]
async fn databases_listed() {
    for url in pg_urls() {
        let params = params_from_url(&url, DriverKind::Postgres);
        let s = connect_postgres(&params).await.unwrap();
        let dbs = s.list_databases().await.unwrap();
        assert!(dbs.contains(params.database.as_ref().unwrap()), "{dbs:?}");
        assert!(!dbs.iter().any(|d| d.starts_with("template")), "{dbs:?}");
        let mut sorted = dbs.clone();
        sorted.sort();
        assert_eq!(dbs, sorted);
    }
    for t in mysql_targets().await {
        let dbs = t.session.list_databases().await.unwrap();
        assert!(dbs.contains(&t.schema), "{} {dbs:?}", t.label);
        assert!(!dbs.contains(&"information_schema".to_string()), "{dbs:?}");
        assert_eq!(dbs, t.session.list_schemas().await.unwrap());
    }
    let (_d, s) = sqlite_session().await;
    assert_eq!(s.list_databases().await.unwrap(), ["main"]);
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

async fn save(m: &Mgr, url: &str, kind: DriverKind) -> String {
    let p = params_from_url(url, kind);
    let cfg = ConnectionConfig {
        id: String::new(),
        name: "c".into(),
        color: "#888".into(),
        env_tag: EnvTag::Local,
        kind,
        host: p.host.clone(),
        port: p.port,
        user: p.user.clone(),
        database: p.database.clone(),
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

async fn scalar(mgr: &SessionManager, sid: &str, sql: &str) -> String {
    let events = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = {
        let events = events.clone();
        move |e: tablemax_lib::manager::ExecEvent| {
            if let tablemax_lib::manager::ExecEvent::StatementFinished { outcome, .. } = e {
                events.lock().unwrap().push(outcome);
            }
        }
    };
    mgr.execute_batch(sid, vec![sql.into()], sink)
        .await
        .unwrap();
    let outcome = events.lock().unwrap().pop().expect("a result");
    match &outcome.result.unwrap().rows[0][0] {
        CellValue::Text(s) => s.clone(),
        other => panic!("not text: {other:?}"),
    }
}

#[tokio::test]
async fn pg_switch_database() {
    for url in pg_urls() {
        let params = params_from_url(&url, DriverKind::Postgres);
        let original_db = params.database.clone().unwrap();
        let admin = connect_postgres(&params).await.unwrap();
        let other = "tablemax_p4_other";
        // Left over from an interrupted run, or still held by a lingering session.
        admin
            .execute(&format!("DROP DATABASE IF EXISTS {other} WITH (FORCE)"))
            .await
            .unwrap();
        admin
            .execute(&format!("CREATE DATABASE {other}"))
            .await
            .unwrap();
        let _cleanup = Cleanup {
            params: params.clone(),
            sql: vec![format!("DROP DATABASE IF EXISTS {other} WITH (FORCE)")],
        };
        let mut other_params = params.clone();
        other_params.database = Some(other.into());
        let o = connect_postgres(&other_params).await.unwrap();
        o.execute("CREATE SCHEMA p4_marker").await.unwrap();
        o.execute("CREATE TABLE p4_marker.only_here (id int, label text)")
            .await
            .unwrap();
        o.close().await.unwrap();

        let m = manager();
        let id = save(&m, &url, DriverKind::Postgres).await;
        let ws = m.mgr.open_workspace(&id, None, None, None).await.unwrap();
        assert_eq!(ws.database.as_deref(), Some(original_db.as_str()));
        let old_sql = m.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
        assert!(
            m.mgr
                .databases_list(&ws.workspace_id)
                .await
                .unwrap()
                .contains(&other.to_string())
        );
        let before = m
            .mgr
            .catalog(&ws.workspace_id, Some("p4_marker"), false)
            .await
            .unwrap();
        assert!(
            before.tables.is_empty(),
            "marker schema is only in the other db"
        );

        // A database that does not exist: NotFound, and the workspace is untouched.
        let e = m
            .mgr
            .switch_database(&ws.workspace_id, "tablemax_p4_missing")
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::NotFound, "{}", e.message);
        let schemas = m
            .mgr
            .browse(&ws.workspace_id)
            .await
            .unwrap()
            .list_schemas()
            .await
            .unwrap();
        assert!(!schemas.contains(&"p4_marker".to_string()));

        let info = m
            .mgr
            .switch_database(&ws.workspace_id, other)
            .await
            .unwrap();
        assert_eq!(info.workspace_id, ws.workspace_id);
        assert_eq!(info.connection_id, ws.connection_id);
        assert_eq!(info.database.as_deref(), Some(other));

        // Browsing reads the new database.
        let schemas = m
            .mgr
            .browse(&ws.workspace_id)
            .await
            .unwrap()
            .list_schemas()
            .await
            .unwrap();
        assert!(schemas.contains(&"p4_marker".to_string()), "{schemas:?}");
        // The catalog cached for the old database is gone.
        let after = m
            .mgr
            .catalog(&ws.workspace_id, Some("p4_marker"), false)
            .await
            .unwrap();
        assert_eq!(after.tables.len(), 1);
        assert_eq!(after.tables[0].name, "only_here");
        // A SQL session opened before keeps its database; new ones use the new one.
        assert_eq!(
            scalar(&m.mgr, &old_sql, "select current_database()::text").await,
            original_db
        );
        let new_sql = m.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
        assert_eq!(
            scalar(&m.mgr, &new_sql, "select current_database()::text").await,
            other
        );
        m.mgr.close_workspace(&ws.workspace_id).await.unwrap();
        admin.close().await.unwrap();
    }
}

#[tokio::test]
async fn mysql_and_sqlite_do_not_switch_database() {
    let m = manager();
    for (i, url) in mysql_urls().into_iter().enumerate() {
        let kind = if i == 0 {
            DriverKind::MySql
        } else {
            DriverKind::MariaDb
        };
        let id = save(&m, &url, kind).await;
        let ws = m.mgr.open_workspace(&id, None, None, None).await.unwrap();
        let e = m
            .mgr
            .switch_database(&ws.workspace_id, "whatever")
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Invalid, "{}", e.message);
        m.mgr.close_workspace(&ws.workspace_id).await.unwrap();
    }
}

/// MariaDB's information_schema compares names case/accent-insensitively: tables that
/// differ only by case or accent must keep their own columns.
#[tokio::test]
async fn catalog_keeps_case_and_accent_variants_apart() {
    let defs: [(&str, [&str; 2]); 4] = [
        ("Tt", ["a", "b"]),
        ("tt", ["x", "y"]),
        ("cafe", ["c1", "c2"]),
        ("café", ["d1", "d2"]),
    ];
    let create = |kind: DriverKind, name: &str, cols: &[&str; 2]| {
        let c: Vec<String> = cols.iter().map(|c| format!("{} int", q(kind, c))).collect();
        format!("CREATE TABLE {} ({})", q(kind, name), c.join(", "))
    };
    for t in server_targets().await {
        for (name, cols) in &defs {
            t.session
                .execute(&create(t.kind, name, cols))
                .await
                .unwrap_or_else(|e| panic!("{} {name}: {e:?}", t.label));
        }
        let c = t.session.catalog(Some(&t.schema)).await.unwrap();
        assert_eq!(c.tables.len(), 4, "{}: {:?}", t.label, c.tables);
        for (name, cols) in &defs {
            assert_eq!(col_names(table(&c, name)), cols, "{} {name}", t.label);
        }
    }
    // SQLite table names are case-insensitive: only the accent pair can coexist.
    let (_d, s) = sqlite_session().await;
    let lite = &defs[2..];
    for (name, cols) in lite {
        s.execute(&create(DriverKind::Sqlite, name, cols))
            .await
            .unwrap();
    }
    let c = s.catalog(None).await.unwrap();
    assert_eq!(c.tables.len(), 2);
    for (name, cols) in lite {
        assert_eq!(col_names(table(&c, name)), cols, "sqlite {name}");
    }
}

#[tokio::test]
async fn sqlite_catalog_survives_a_dangling_view() {
    let (_d, s) = sqlite_session().await;
    s.execute("CREATE TABLE a (id INTEGER, v TEXT)")
        .await
        .unwrap();
    s.execute("CREATE TABLE b (k INTEGER)").await.unwrap();
    s.execute("CREATE VIEW dangling AS SELECT id FROM a")
        .await
        .unwrap();
    s.execute("DROP TABLE a").await.unwrap();
    let c = s.catalog(None).await.unwrap();
    let d = table(&c, "dangling");
    assert_eq!(d.kind, ObjectKind::View);
    assert!(d.columns.is_empty());
    assert_eq!(col_names(table(&c, "b")), ["k"]);
}

//! Row changes end to end on every engine: `SessionManager::changes_preview`,
//! `changes_apply` (one transaction on the browse connection, exactly-one-row guard),
//! `cell_value`, read back through `table_page`.
//!
//! Each test builds its own schema (PostgreSQL schema, MySQL/MariaDB database, SQLite
//! file) through a separate setup connection; schemas are dropped at the end, even when an
//! assertion fails.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{mysql_urls, params_from_url, pg_urls, unique_schema};
use tablemax_lib::driver::dml::{
    ApplyOutcome, EditValue, RowChange, RowKey, STALE_ROW, build_change,
};
use tablemax_lib::driver::mysql::connect_mysql;
use tablemax_lib::driver::postgres::connect_postgres;
use tablemax_lib::driver::query::{SqlParam, Statement};
use tablemax_lib::driver::sqlite::connect_sqlite;
use tablemax_lib::driver::tls::SslConfig;
use tablemax_lib::driver::{
    ConnectParams, Dialect, DriverKind, ObjectRef, PageRequest, ResultSet, Session,
};
use tablemax_lib::error::ErrorKind;
use tablemax_lib::manager::SessionManager;
use tablemax_lib::secrets::MemorySecretStore;
use tablemax_lib::ssh::known_hosts::KnownHosts;
use tablemax_lib::store::{ConnectionConfig, ConnectionStore, EnvTag, PasswordMode};
use tablemax_lib::value::CellValue;

const WAIT: Duration = Duration::from_secs(20);

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

/// Drops the test schema/database on drop (a fresh connection on its own runtime).
struct Cleanup {
    params: ConnectParams,
    sql: String,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        let (params, sql) = (self.params.clone(), self.sql.clone());
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                let s = match params.kind {
                    DriverKind::Postgres => connect_postgres(&params).await,
                    _ => connect_mysql(&params).await,
                };
                if let Ok(s) = s {
                    let _ = s.execute(&sql).await;
                    let _ = s.close().await;
                }
            });
        })
        .join();
    }
}

struct Fx {
    kind: DriverKind,
    mgr: Arc<SessionManager>,
    ws: String,
    /// Setup connection (DDL, seeding, concurrent writes by "someone else").
    raw: Arc<dyn Session>,
    schema: String,
    _cleanup: Option<Cleanup>,
    _dir: tempfile::TempDir,
}

fn manager(dir: &tempfile::TempDir) -> Arc<SessionManager> {
    let store = ConnectionStore::open(&dir.path().join("app.db")).unwrap();
    Arc::new(SessionManager::new(
        Arc::new(store),
        Arc::new(MemorySecretStore::new()),
        KnownHosts {
            system: None,
            app: dir.path().join("known_hosts"),
        },
    ))
}

fn config(kind: DriverKind, p: Option<&ConnectParams>, sqlite: Option<String>) -> ConnectionConfig {
    ConnectionConfig {
        id: String::new(),
        name: "edits".into(),
        color: "#888".into(),
        env_tag: EnvTag::Local,
        kind,
        host: p.map(|p| p.host.clone()).unwrap_or_default(),
        port: p.map(|p| p.port).unwrap_or(0),
        user: p.map(|p| p.user.clone()).unwrap_or_default(),
        database: p.and_then(|p| p.database.clone()),
        sqlite_path: sqlite,
        password_mode: if p.is_some() {
            PasswordMode::Keyring
        } else {
            PasswordMode::None
        },
        group: None,
        ssl: SslConfig::default(),
        ssh: None,
    }
}

async fn open(mgr: &SessionManager, cfg: ConnectionConfig, password: Option<String>) -> String {
    let saved = mgr.save_connection(cfg, password, None).await.unwrap();
    mgr.open_workspace(&saved.id, None, None, None)
        .await
        .unwrap()
        .workspace_id
}

async fn pg_fixture(url: &str) -> Fx {
    let params = params_from_url(url, DriverKind::Postgres);
    let raw = connect_postgres(&params).await.unwrap();
    let schema = unique_schema();
    raw.execute(&format!("CREATE SCHEMA \"{schema}\""))
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(&dir);
    let ws = open(
        &mgr,
        config(DriverKind::Postgres, Some(&params), None),
        params.password.clone(),
    )
    .await;
    Fx {
        kind: DriverKind::Postgres,
        mgr,
        ws,
        raw,
        _cleanup: Some(Cleanup {
            params,
            sql: format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"),
        }),
        schema,
        _dir: dir,
    }
}

async fn mysql_fixture(url: &str, kind: DriverKind) -> Fx {
    let params = params_from_url(url, kind);
    let raw = connect_mysql(&params).await.unwrap();
    let schema = unique_schema();
    raw.execute(&format!(
        "CREATE DATABASE `{schema}` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"
    ))
    .await
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mgr = manager(&dir);
    let ws = open(
        &mgr,
        config(kind, Some(&params), None),
        params.password.clone(),
    )
    .await;
    Fx {
        kind,
        mgr,
        ws,
        raw,
        _cleanup: Some(Cleanup {
            params,
            sql: format!("DROP DATABASE IF EXISTS `{schema}`"),
        }),
        schema,
        _dir: dir,
    }
}

async fn sqlite_fixture() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.db");
    rusqlite::Connection::open(&path).unwrap();
    let raw = connect_sqlite(&path).await.unwrap();
    let mgr = manager(&dir);
    let ws = open(
        &mgr,
        config(
            DriverKind::Sqlite,
            None,
            Some(path.to_string_lossy().into_owned()),
        ),
        None,
    )
    .await;
    Fx {
        kind: DriverKind::Sqlite,
        mgr,
        ws,
        raw,
        schema: "main".into(),
        _cleanup: None,
        _dir: dir,
    }
}

/// URL order from `scripts/test-dbs.sh env`: MySQL 8 first, MariaDB 11 second.
fn mysql_targets() -> Vec<(String, DriverKind)> {
    mysql_urls()
        .into_iter()
        .enumerate()
        .map(|(i, u)| {
            let kind = if i == 0 {
                DriverKind::MySql
            } else {
                DriverKind::MariaDb
            };
            (u, kind)
        })
        .collect()
}

/// Every fixture: PostgreSQL, MySQL, MariaDB, SQLite.
async fn all_fixtures() -> Vec<Fx> {
    let mut out = Vec::new();
    for url in pg_urls() {
        out.push(pg_fixture(&url).await);
    }
    for (url, kind) in mysql_targets() {
        out.push(mysql_fixture(&url, kind).await);
    }
    out.push(sqlite_fixture().await);
    out
}

impl Fx {
    fn d(&self) -> Dialect {
        self.kind.dialect()
    }

    fn obj(&self, name: &str) -> ObjectRef {
        ObjectRef {
            schema: Some(self.schema.clone()),
            name: name.into(),
        }
    }

    fn q(&self, name: &str) -> String {
        tablemax_lib::driver::sql::qualified(self.d(), &self.obj(name))
    }

    /// Picks the engine's variant: PostgreSQL, MySQL/MariaDB, SQLite.
    fn pick<'a>(&self, pg: &'a str, my: &'a str, lite: &'a str) -> &'a str {
        match self.d() {
            Dialect::Postgres => pg,
            Dialect::MySql => my,
            Dialect::Sqlite => lite,
        }
    }

    async fn run(&self, sql: &str) {
        self.raw
            .execute(sql)
            .await
            .unwrap_or_else(|e| panic!("{:?} {sql}: {e:?}", self.kind));
    }

    /// The table's first page through the manager (ordered by the row key).
    async fn page(&self, name: &str) -> ResultSet {
        self.mgr
            .table_page(
                &self.ws,
                &PageRequest {
                    object: self.obj(name),
                    limit: 300,
                    offset: 0,
                    sort: None,
                    filters: vec![],
                },
            )
            .await
            .unwrap_or_else(|e| panic!("{:?} page {name}: {e:?}", self.kind))
    }

    async fn apply(&self, name: &str, changes: Vec<RowChange>) -> ApplyOutcome {
        self.mgr
            .changes_apply(&self.ws, &self.obj(name), &changes)
            .await
            .unwrap_or_else(|e| panic!("{:?} apply {name}: {e:?}", self.kind))
    }

    /// Applies and asserts every change went through.
    async fn apply_ok(&self, name: &str, changes: Vec<RowChange>) {
        let o = self.apply(name, changes).await;
        assert!(o.applied, "{:?}: {o:?}", self.kind);
    }

    fn edit(&self, c: &CellValue) -> EditValue {
        match c {
            CellValue::Null => EditValue::Null,
            CellValue::Bool(b) => EditValue::Text(
                match (self.d(), b) {
                    (Dialect::Postgres, true) => "true",
                    (Dialect::Postgres, false) => "false",
                    (_, true) => "1",
                    (_, false) => "0",
                }
                .into(),
            ),
            CellValue::Int(i) => EditValue::Text(i.to_string()),
            CellValue::Float(f) => EditValue::Text(f.to_string()),
            CellValue::BigInt(s)
            | CellValue::Decimal(s)
            | CellValue::Text(s)
            | CellValue::Json(s)
            | CellValue::Temporal(s) => EditValue::Text(s.clone()),
            other => panic!("not editable as text: {other:?}"),
        }
    }
}

fn col(rs: &ResultSet, name: &str) -> usize {
    rs.columns
        .iter()
        .position(|c| c.name == name)
        .unwrap_or_else(|| panic!("no column {name}"))
}

fn cell(rs: &ResultSet, row: usize, name: &str) -> CellValue {
    rs.rows[row][col(rs, name)].clone()
}

/// The row key of page row `row`, from the loaded values (as the grid does).
fn key(rs: &ResultSet, row: usize, cols: &[&str]) -> RowKey {
    RowKey(
        cols.iter()
            .map(|c| (c.to_string(), cell(rs, row, c)))
            .collect(),
    )
}

fn text(s: &str) -> EditValue {
    EditValue::Text(s.into())
}

fn set(pairs: &[(&str, EditValue)]) -> Vec<(String, EditValue)> {
    pairs
        .iter()
        .map(|(c, v)| (c.to_string(), v.clone()))
        .collect()
}

fn update(key: RowKey, pairs: &[(&str, EditValue)]) -> RowChange {
    RowChange::Update {
        key,
        set: set(pairs),
    }
}

fn int_key(id: i64) -> RowKey {
    RowKey(vec![("id".into(), CellValue::Int(id))])
}

fn as_str(c: &CellValue) -> &str {
    match c {
        CellValue::Text(s)
        | CellValue::Temporal(s)
        | CellValue::Json(s)
        | CellValue::Decimal(s)
        | CellValue::BigInt(s) => s,
        other => panic!("not textual: {other:?}"),
    }
}

fn int(c: &CellValue) -> i64 {
    match c {
        CellValue::Int(n) => *n,
        other => panic!("not an int: {other:?}"),
    }
}

// ---------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn edits_round_trip_types() {
    for fx in all_fixtures().await {
        let t = fx.q("typed");
        let extra = fx.pick("u uuid", "e enum('small','large')", "x TEXT");
        let ddl = fx.pick(
            "id integer PRIMARY KEY, num numeric(12,2), big bigint, flag boolean, doc json, \
             d date, ts timestamp, note text",
            "id int PRIMARY KEY, num decimal(12,2), big bigint, flag boolean, doc json, \
             d date, ts datetime, note text",
            "id INTEGER PRIMARY KEY, num NUMERIC, big INTEGER, flag BOOLEAN, doc TEXT, \
             d DATE, ts DATETIME, note TEXT",
        );
        fx.run(&format!("CREATE TABLE {t} ({ddl}, {extra})")).await;
        fx.run(&format!("INSERT INTO {t} (id) VALUES (1)")).await;
        let note = "l'été ☕ \"q\" \\ fin";
        let flag = fx.pick("true", "1", "1");
        let (extra_col, extra_val) = match fx.d() {
            Dialect::Postgres => ("u", "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"),
            Dialect::MySql => ("e", "large"),
            Dialect::Sqlite => ("x", "plain"),
        };
        let rs = fx.page("typed").await;
        fx.apply_ok(
            "typed",
            vec![update(
                key(&rs, 0, &["id"]),
                &[
                    ("num", text("12.30")),
                    ("big", text("9007199254740993")),
                    ("flag", text(flag)),
                    ("doc", text(r#"{"a":[1,2]}"#)),
                    ("d", text("2024-02-29")),
                    ("ts", text("2024-02-29 13:45:01")),
                    (extra_col, text(extra_val)),
                    ("note", text(note)),
                ],
            )],
        )
        .await;
        let rs = fx.page("typed").await;
        let k = fx.kind;
        match fx.d() {
            // NUMERIC affinity: SQLite keeps a number, not the decimal text.
            Dialect::Sqlite => assert_eq!(cell(&rs, 0, "num"), CellValue::Float(12.3), "{k:?}"),
            _ => assert_eq!(
                cell(&rs, 0, "num"),
                CellValue::Decimal("12.30".into()),
                "{k:?}"
            ),
        }
        assert_eq!(
            cell(&rs, 0, "big"),
            CellValue::BigInt("9007199254740993".into()),
            "{k:?}"
        );
        match fx.d() {
            Dialect::Postgres => assert_eq!(cell(&rs, 0, "flag"), CellValue::Bool(true)),
            _ => assert_eq!(cell(&rs, 0, "flag"), CellValue::Int(1), "{k:?}"),
        }
        let doc: serde_json::Value = serde_json::from_str(as_str(&cell(&rs, 0, "doc"))).unwrap();
        assert_eq!(doc, serde_json::json!({"a": [1, 2]}), "{k:?}");
        assert_eq!(as_str(&cell(&rs, 0, "d")), "2024-02-29", "{k:?}");
        assert_eq!(as_str(&cell(&rs, 0, "ts")), "2024-02-29 13:45:01", "{k:?}");
        assert_eq!(
            cell(&rs, 0, extra_col),
            CellValue::Text(extra_val.into()),
            "{k:?}"
        );
        assert_eq!(cell(&rs, 0, "note"), CellValue::Text(note.into()), "{k:?}");

        // A composite key made of loaded text/uuid and date values finds its row.
        let kt = fx.q("keyed");
        let code = fx.pick("uuid", "varchar(40)", "TEXT");
        fx.run(&format!(
            "CREATE TABLE {kt} (code {code}, day date, v int, PRIMARY KEY (code, day))"
        ))
        .await;
        fx.run(&format!(
            "INSERT INTO {kt} VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '2024-01-02', 1), \
             ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '2024-01-03', 2)"
        ))
        .await;
        let rs = fx.page("keyed").await;
        fx.apply_ok(
            "keyed",
            vec![update(key(&rs, 1, &["code", "day"]), &[("v", text("20"))])],
        )
        .await;
        let rs = fx.page("keyed").await;
        assert_eq!(
            (int(&cell(&rs, 0, "v")), int(&cell(&rs, 1, "v"))),
            (1, 20),
            "{k:?}"
        );
    }
}

#[tokio::test]
async fn null_empty_and_default() {
    for fx in all_fixtures().await {
        let t = fx.q("nd");
        let ddl = fx.pick(
            "id serial PRIMARY KEY, a text, b text NOT NULL DEFAULT 'dflt', c integer DEFAULT 7",
            "id int AUTO_INCREMENT PRIMARY KEY, a text, b varchar(20) NOT NULL DEFAULT 'dflt', \
             c int DEFAULT 7",
            "id INTEGER PRIMARY KEY, a TEXT, b TEXT NOT NULL DEFAULT 'dflt', c INTEGER DEFAULT 7",
        );
        fx.run(&format!("CREATE TABLE {t} ({ddl})")).await;
        let k = fx.kind;
        fx.apply_ok(
            "nd",
            vec![
                RowChange::Insert {
                    values: set(&[
                        ("id", EditValue::Default),
                        ("a", EditValue::Null),
                        ("b", EditValue::Default),
                        ("c", EditValue::Default),
                    ]),
                },
                RowChange::Insert {
                    values: set(&[("a", text(""))]),
                },
                // Every column left to its default.
                RowChange::Insert { values: vec![] },
            ],
        )
        .await;
        let rs = fx.page("nd").await;
        assert_eq!(rs.rows.len(), 3, "{k:?}");
        for row in 0..3 {
            assert_eq!(cell(&rs, row, "b"), CellValue::Text("dflt".into()), "{k:?}");
            assert_eq!(cell(&rs, row, "c"), CellValue::Int(7), "{k:?}");
        }
        assert_eq!(cell(&rs, 0, "a"), CellValue::Null, "{k:?}");
        assert_eq!(cell(&rs, 1, "a"), CellValue::Text("".into()), "{k:?}");
        assert_eq!(cell(&rs, 2, "a"), CellValue::Null, "{k:?}");

        // Empty text stays empty text, NULL stays NULL.
        fx.apply_ok(
            "nd",
            vec![
                update(key(&rs, 0, &["id"]), &[("a", text(""))]),
                update(key(&rs, 1, &["id"]), &[("a", EditValue::Null)]),
            ],
        )
        .await;
        let rs = fx.page("nd").await;
        assert_eq!(cell(&rs, 0, "a"), CellValue::Text("".into()), "{k:?}");
        assert_eq!(cell(&rs, 1, "a"), CellValue::Null, "{k:?}");
    }
}

#[tokio::test]
async fn insert_delete_duplicate() {
    for fx in all_fixtures().await {
        let t = fx.q("dup");
        let ddl = fx.pick(
            "id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name text, \
             shout text GENERATED ALWAYS AS (upper(name)) STORED",
            "id int AUTO_INCREMENT PRIMARY KEY, name varchar(50), \
             shout varchar(50) GENERATED ALWAYS AS (upper(name)) STORED",
            "id INTEGER PRIMARY KEY, name TEXT, \
             shout TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL",
        );
        fx.run(&format!("CREATE TABLE {t} ({ddl})")).await;
        let k = fx.kind;
        fx.apply_ok(
            "dup",
            vec![RowChange::Insert {
                values: set(&[("id", EditValue::Default), ("name", text("x"))]),
            }],
        )
        .await;
        let rs = fx.page("dup").await;
        assert_eq!(rs.rows.len(), 1, "{k:?}");
        let first = int(&cell(&rs, 0, "id"));
        assert_eq!(cell(&rs, 0, "shout"), CellValue::Text("X".into()), "{k:?}");

        // Duplicate: the row's values without its auto-increment and generated columns.
        let info = fx.mgr.table_info(&fx.ws, &fx.obj("dup")).await.unwrap();
        let values: Vec<(String, EditValue)> = info
            .columns
            .iter()
            .filter(|c| !c.auto_increment && !c.generated)
            .map(|c| (c.name.clone(), fx.edit(&cell(&rs, 0, &c.name))))
            .collect();
        assert_eq!(values, set(&[("name", text("x"))]), "{k:?}");
        fx.apply_ok("dup", vec![RowChange::Insert { values }]).await;
        let rs = fx.page("dup").await;
        assert_eq!(rs.rows.len(), 2, "{k:?}");
        let second = int(&cell(&rs, 1, "id"));
        assert_ne!(first, second, "{k:?}");
        assert_eq!(cell(&rs, 1, "name"), CellValue::Text("x".into()), "{k:?}");
        assert_eq!(cell(&rs, 1, "shout"), CellValue::Text("X".into()), "{k:?}");

        let o = fx
            .apply(
                "dup",
                vec![RowChange::Delete {
                    key: key(&rs, 0, &["id"]),
                }],
            )
            .await;
        assert!(o.applied, "{k:?}: {o:?}");
        assert_eq!(o.affected, vec![1], "{k:?}");
        let rs = fx.page("dup").await;
        assert_eq!(rs.rows.len(), 1, "{k:?}");
        assert_eq!(int(&cell(&rs, 0, "id")), second, "{k:?}");
    }
}

#[tokio::test]
async fn stale_row_rolls_back_everything() {
    for fx in all_fixtures().await {
        let t = fx.q("s");
        fx.run(&format!(
            "CREATE TABLE {t} (id int PRIMARY KEY, v varchar(20))"
        ))
        .await;
        fx.run(&format!("INSERT INTO {t} VALUES (1, 'a'), (2, 'b')"))
            .await;
        let rs = fx.page("s").await;
        // Someone else deletes row 2 after the grid loaded it.
        fx.run(&format!("DELETE FROM {t} WHERE id = 2")).await;
        let o = fx
            .apply(
                "s",
                vec![
                    update(key(&rs, 0, &["id"]), &[("v", text("changed"))]),
                    update(key(&rs, 1, &["id"]), &[("v", text("x"))]),
                ],
            )
            .await;
        let k = fx.kind;
        assert!(!o.applied, "{k:?}");
        assert_eq!(o.failed_index, Some(1), "{k:?}");
        assert_eq!(o.affected, vec![1, 0], "{k:?}");
        let e = o.error.expect("error");
        assert_eq!(
            (e.kind, e.message.as_str()),
            (ErrorKind::Query, STALE_ROW),
            "{k:?}"
        );
        let rs = fx.page("s").await;
        assert_eq!(rs.rows.len(), 1, "{k:?}");
        assert_eq!(cell(&rs, 0, "v"), CellValue::Text("a".into()), "{k:?}");

        // A delete of the vanished row is stale too.
        let o = fx
            .apply("s", vec![RowChange::Delete { key: int_key(2) }])
            .await;
        assert_eq!(
            (o.applied, o.failed_index, o.error.map(|e| e.message)),
            (false, Some(0), Some(STALE_ROW.to_string())),
            "{k:?}"
        );
    }
}

#[tokio::test]
async fn read_only_tables_refuse_changes() {
    for fx in all_fixtures().await {
        let (t, v, n) = (fx.q("base"), fx.q("base_view"), fx.q("nokey"));
        fx.run(&format!("CREATE TABLE {t} (id int PRIMARY KEY, a int)"))
            .await;
        fx.run(&format!("CREATE VIEW {v} AS SELECT id, a FROM {t}"))
            .await;
        fx.run(&format!("CREATE TABLE {n} (a int, b int)")).await;
        let k = fx.kind;
        for (name, change) in [
            ("base_view", update(int_key(1), &[("a", text("2"))])),
            (
                "nokey",
                RowChange::Insert {
                    values: set(&[("a", text("1"))]),
                },
            ),
        ] {
            let obj = fx.obj(name);
            let changes = vec![change];
            let e = fx
                .mgr
                .changes_apply(&fx.ws, &obj, &changes)
                .await
                .unwrap_err();
            assert_eq!(e.kind, ErrorKind::Invalid, "{k:?} {name}");
            assert!(
                e.message.starts_with("change 0: table is read-only: "),
                "{k:?} {name}: {}",
                e.message
            );
            let e = fx
                .mgr
                .changes_preview(&fx.ws, &obj, &changes)
                .await
                .unwrap_err();
            assert_eq!(e.kind, ErrorKind::Invalid, "{k:?} {name}");
        }
    }
}

#[tokio::test]
async fn preview_renders_literals_and_names_the_bad_change() {
    for fx in all_fixtures().await {
        let t = fx.q("p");
        fx.run(&format!("CREATE TABLE {t} (id int PRIMARY KEY, v int)"))
            .await;
        let obj = fx.obj("p");
        let k = fx.kind;
        let out = fx
            .mgr
            .changes_preview(
                &fx.ws,
                &obj,
                &[
                    update(int_key(1), &[("v", text("it's"))]),
                    RowChange::Delete { key: int_key(2) },
                ],
            )
            .await
            .unwrap();
        assert_eq!(out.len(), 2, "{k:?}");
        assert!(out[0].starts_with("UPDATE "), "{k:?} {}", out[0]);
        assert!(out[0].contains("'it''s'"), "{k:?} {}", out[0]);
        assert!(out[1].starts_with("DELETE FROM "), "{k:?} {}", out[1]);
        assert!(out[1].contains("'2'"), "{k:?} {}", out[1]);

        let changes = [
            RowChange::Delete { key: int_key(1) },
            update(int_key(1), &[("nope", text("1"))]),
        ];
        for e in [
            fx.mgr
                .changes_preview(&fx.ws, &obj, &changes)
                .await
                .unwrap_err(),
            fx.mgr
                .changes_apply(&fx.ws, &obj, &changes)
                .await
                .unwrap_err(),
        ] {
            assert_eq!(
                (e.kind, e.message.as_str()),
                (ErrorKind::Invalid, "change 1: unknown column nope"),
                "{k:?}"
            );
        }
    }
}

#[tokio::test]
async fn editing_long_text_keeps_full_value() {
    for fx in all_fixtures().await {
        let t = fx.q("lt");
        let body_type = fx.pick("text", "mediumtext", "TEXT");
        fx.run(&format!(
            "CREATE TABLE {t} (id int PRIMARY KEY, body {body_type}, v int)"
        ))
        .await;
        let body = format!("é{}ü", "x".repeat(49_998));
        fx.run(&format!("INSERT INTO {t} VALUES (1, '{body}', 0)"))
            .await;
        let k = fx.kind;
        let rs = fx.page("lt").await;
        assert!(
            matches!(
                cell(&rs, 0, "body"),
                CellValue::LongText { len: 50_000, .. }
            ),
            "{k:?}"
        );
        let obj = fx.obj("lt");
        let full = fx
            .mgr
            .cell_value(&fx.ws, &obj, &key(&rs, 0, &["id"]), "body")
            .await
            .unwrap();
        assert_eq!(full, CellValue::Text(body.clone()), "{k:?}");

        fx.apply_ok(
            "lt",
            vec![update(key(&rs, 0, &["id"]), &[("v", text("1"))])],
        )
        .await;
        let again = fx
            .mgr
            .cell_value(&fx.ws, &obj, &int_key(1), "body")
            .await
            .unwrap();
        assert_eq!(again, CellValue::Text(body), "{k:?}");
        assert_eq!(
            fx.mgr
                .cell_value(&fx.ws, &obj, &int_key(1), "v")
                .await
                .unwrap(),
            CellValue::Int(1),
            "{k:?}"
        );
        let e = fx
            .mgr
            .cell_value(&fx.ws, &obj, &int_key(99), "body")
            .await
            .unwrap_err();
        assert_eq!(e.kind, ErrorKind::NotFound, "{k:?}");

        // Above 16 MiB the value is refused (MySQL/MariaDB skipped: max_allowed_packet).
        let huge = match fx.d() {
            Dialect::Postgres => "repeat('a', 17 * 1024 * 1024)",
            Dialect::Sqlite => "replace(hex(zeroblob(17 * 1024 * 1024 / 2)), '0', 'a')",
            Dialect::MySql => continue,
        };
        fx.run(&format!("INSERT INTO {t} VALUES (2, {huge}, 0)"))
            .await;
        let e = fx
            .mgr
            .cell_value(&fx.ws, &obj, &int_key(2), "body")
            .await
            .unwrap_err();
        assert_eq!(
            (e.kind, e.message.as_str()),
            (ErrorKind::Invalid, "value too large to edit (17 MB)"),
            "{k:?}"
        );
    }
}

#[tokio::test]
async fn mysql_found_rows() {
    for fx in all_fixtures().await {
        let t = fx.q("fr");
        fx.run(&format!("CREATE TABLE {t} (id int PRIMARY KEY, v int)"))
            .await;
        fx.run(&format!("INSERT INTO {t} VALUES (1, 5)")).await;
        // Writing the value the row already has still counts the row (CLIENT_FOUND_ROWS).
        let o = fx
            .apply("fr", vec![update(int_key(1), &[("v", text("5"))])])
            .await;
        assert!(o.applied, "{:?}: {o:?}", fx.kind);
        assert_eq!(o.affected, vec![1], "{:?}", fx.kind);
    }
}

#[tokio::test]
async fn too_long_value_errors_instead_of_truncating() {
    // SQLite does not enforce varchar lengths.
    for fx in all_fixtures().await {
        if fx.d() == Dialect::Sqlite {
            continue;
        }
        let t = fx.q("vc");
        fx.run(&format!(
            "CREATE TABLE {t} (id int PRIMARY KEY, s varchar(5))"
        ))
        .await;
        fx.run(&format!("INSERT INTO {t} VALUES (1, 'abc')")).await;
        let o = fx
            .apply("vc", vec![update(int_key(1), &[("s", text("abcdefgh"))])])
            .await;
        let k = fx.kind;
        assert!(!o.applied, "{k:?}");
        assert_eq!(o.failed_index, Some(0), "{k:?}");
        assert_eq!(o.error.expect("error").kind, ErrorKind::Query, "{k:?}");
        let rs = fx.page("vc").await;
        assert_eq!(cell(&rs, 0, "s"), CellValue::Text("abc".into()), "{k:?}");
    }
}

#[tokio::test]
async fn schema_change_invalidates_cached_table_info() {
    for fx in all_fixtures().await {
        let t = fx.q("sc");
        fx.run(&format!(
            "CREATE TABLE {t} (id int PRIMARY KEY, v int, w int)"
        ))
        .await;
        fx.run(&format!("INSERT INTO {t} VALUES (1, 1, 1)")).await;
        let obj = fx.obj("sc");
        let k = fx.kind;
        let before = fx.mgr.table_info(&fx.ws, &obj).await.unwrap();
        assert!(before.column("w").is_some(), "{k:?}");
        fx.run(&format!("ALTER TABLE {t} DROP COLUMN w")).await;
        // Built from the stale metadata: the database rejects the dropped column.
        let o = fx
            .apply("sc", vec![update(int_key(1), &[("w", text("2"))])])
            .await;
        assert!(!o.applied, "{k:?}");
        assert_eq!(o.error.expect("error").kind, ErrorKind::Query, "{k:?}");
        let after = fx.mgr.table_info(&fx.ws, &obj).await.unwrap();
        assert!(after.column("w").is_none(), "{k:?}: cache not invalidated");

        // Other failures keep the cache.
        let o = fx
            .apply("sc", vec![update(int_key(9), &[("v", text("2"))])])
            .await;
        assert!(!o.applied, "{k:?}");
        let kept = fx.mgr.table_info(&fx.ws, &obj).await.unwrap();
        assert!(Arc::ptr_eq(&after, &kept), "{k:?}");
    }
}

/// A statement that runs until cancelled.
fn endless(fx: &Fx, table: &str) -> Statement {
    let sql = match fx.d() {
        Dialect::Postgres => "SELECT pg_sleep(30)".to_string(),
        Dialect::MySql => "DO SLEEP(30)".to_string(),
        Dialect::Sqlite => format!(
            "UPDATE {} SET v = v WHERE id = (WITH RECURSIVE c(x) AS \
             (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c)",
            fx.q(table)
        ),
    };
    Statement {
        sql,
        params: vec![],
    }
}

#[tokio::test]
async fn apply_is_cancellable_and_rolls_back() {
    for fx in all_fixtures().await {
        let t = fx.q("cx");
        fx.run(&format!("CREATE TABLE {t} (id int PRIMARY KEY, v int)"))
            .await;
        fx.run(&format!("INSERT INTO {t} VALUES (1, 1)")).await;
        let k = fx.kind;
        let info = fx.mgr.table_info(&fx.ws, &fx.obj("cx")).await.unwrap();
        let write = build_change(fx.d(), &info, &update(int_key(1), &[("v", text("2"))])).unwrap();
        let browse = fx.mgr.browse(&fx.ws).await.unwrap();
        let canceller = browse.canceller();
        let stmts = vec![write, endless(&fx, "cx")];
        let running = tokio::spawn(async move { browse.apply(&stmts, &[true, false]).await });
        tokio::time::sleep(Duration::from_millis(400)).await;
        canceller.cancel().await.unwrap();
        let res = tokio::time::timeout(WAIT, running)
            .await
            .expect("cancelled apply must end")
            .unwrap();
        assert_eq!(res.unwrap_err().kind, ErrorKind::Cancelled, "{k:?}");
        // Rolled back, and the browse connection is still usable.
        let rs = fx.page("cx").await;
        assert_eq!(cell(&rs, 0, "v"), CellValue::Int(1), "{k:?}");
        fx.apply_ok("cx", vec![update(int_key(1), &[("v", text("3"))])])
            .await;
        assert_eq!(
            cell(&fx.page("cx").await, 0, "v"),
            CellValue::Int(3),
            "{k:?}"
        );
    }
}

#[tokio::test]
async fn page_fetch_never_runs_inside_the_transaction() {
    // SQLite runs every call under one connection mutex: nothing to interleave.
    for fx in all_fixtures().await {
        if fx.d() == Dialect::Sqlite {
            continue;
        }
        let t = fx.q("iso");
        fx.run(&format!(
            "CREATE TABLE {t} (id int PRIMARY KEY, v varchar(10))"
        ))
        .await;
        fx.run(&format!("INSERT INTO {t} VALUES (1, 'old')")).await;
        let k = fx.kind;
        let info = fx.mgr.table_info(&fx.ws, &fx.obj("iso")).await.unwrap();
        let change = |id: i64, v: &str| {
            build_change(fx.d(), &info, &update(int_key(id), &[("v", text(v))])).unwrap()
        };
        let pause = Statement {
            sql: fx.pick("SELECT pg_sleep(1)", "DO SLEEP(1)", "").into(),
            params: vec![],
        };
        // Writes row 1, pauses, then fails (row 999 does not exist): all rolled back.
        let stmts = vec![change(1, "new"), pause, change(999, "x")];
        let browse = fx.mgr.browse(&fx.ws).await.unwrap();
        let running = tokio::spawn(async move { browse.apply(&stmts, &[true, false, true]).await });
        tokio::time::sleep(Duration::from_millis(300)).await;
        // Issued while the transaction is open: must wait for it, never see "new".
        let rs = fx.page("iso").await;
        let o = running.await.unwrap().unwrap();
        assert_eq!(o.failed_index, Some(2), "{k:?}: {o:?}");
        assert_eq!(cell(&rs, 0, "v"), CellValue::Text("old".into()), "{k:?}");
    }
}

#[tokio::test]
async fn bytes_key_finds_its_row() {
    for fx in all_fixtures().await {
        let t = fx.q("bk");
        let bin = fx.pick("bytea", "varbinary(8)", "BLOB");
        fx.run(&format!("CREATE TABLE {t} (k {bin} PRIMARY KEY, v int)"))
            .await;
        let lit = fx.pick("'\\xdead00'", "x'dead00'", "x'dead00'");
        fx.run(&format!("INSERT INTO {t} VALUES ({lit}, 1)")).await;
        let rs = fx.page("bk").await;
        let k = fx.kind;
        assert!(
            matches!(cell(&rs, 0, "k"), CellValue::Bytes { len: 3, .. }),
            "{k:?}"
        );
        let info = fx.mgr.table_info(&fx.ws, &fx.obj("bk")).await.unwrap();
        let stmt = build_change(
            fx.d(),
            &info,
            &update(key(&rs, 0, &["k"]), &[("v", text("2"))]),
        )
        .unwrap();
        assert_eq!(
            stmt.params.last(),
            Some(&SqlParam::Bytes(vec![0xde, 0xad, 0x00])),
            "{k:?}"
        );
        fx.apply_ok("bk", vec![update(key(&rs, 0, &["k"]), &[("v", text("2"))])])
            .await;
        assert_eq!(
            cell(&fx.page("bk").await, 0, "v"),
            CellValue::Int(2),
            "{k:?}"
        );
    }
}

//! Table metadata (`Session::table_info`) and DDL (`Session::table_ddl`) on every engine.
//!
//! Each test builds its own schema (PostgreSQL schema, MySQL/MariaDB database, SQLite file)
//! with the same shape: `parent`, `"order"` (FK to parent, a tricky column name, a numeric
//! default, a comment, a generated column, a secondary index), `nokey`, `uniq` and the view
//! `v_order`. Schemas are dropped at the end, even when an assertion fails.

mod common;

use std::sync::Arc;

use common::{mysql_urls, params_from_url, pg_urls, unique_schema};
use tablemax_lib::driver::meta::{ColumnInfo, TableInfo};
use tablemax_lib::driver::mysql::connect_mysql;
use tablemax_lib::driver::postgres::connect_postgres;
use tablemax_lib::driver::sqlite::connect_sqlite;
use tablemax_lib::driver::{ConnectParams, DriverKind, ObjectKind, ObjectRef, Session};
use tablemax_lib::error::ErrorKind;

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

/// A session on a schema holding the fixture tables.
struct Fx {
    s: Arc<dyn Session>,
    schema: String,
    _cleanup: Option<Cleanup>,
    _dir: Option<tempfile::TempDir>,
}

impl Fx {
    fn obj(&self, name: &str) -> ObjectRef {
        ObjectRef {
            schema: Some(self.schema.clone()),
            name: name.into(),
        }
    }

    async fn info(&self, name: &str) -> TableInfo {
        self.s
            .table_info(&self.obj(name))
            .await
            .unwrap_or_else(|e| panic!("table_info({name}): {e:?}"))
    }

    async fn ddl(&self, name: &str) -> String {
        self.s
            .table_ddl(&self.obj(name))
            .await
            .unwrap_or_else(|e| panic!("table_ddl({name}): {e:?}"))
    }

    async fn run(&self, sql: &str) {
        self.s
            .execute(sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
    }
}

async fn pg_fixture(url: &str) -> Fx {
    let params = params_from_url(url, DriverKind::Postgres);
    let s = connect_postgres(&params).await.unwrap();
    let schema = unique_schema();
    let fx = Fx {
        s,
        _cleanup: Some(Cleanup {
            params,
            sql: format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"),
        }),
        _dir: None,
        schema: schema.clone(),
    };
    let q = format!("\"{schema}\"");
    for sql in [
        format!("CREATE SCHEMA {q}"),
        format!("CREATE TABLE {q}.parent (id serial PRIMARY KEY, code text UNIQUE NOT NULL)"),
        format!(
            "CREATE TABLE {q}.\"order\" (\
             id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, \
             parent_id integer, \
             \"My \"\"Col\"\"\" text, \
             amount numeric(12,2) DEFAULT 0, \
             note text, \
             total numeric GENERATED ALWAYS AS (amount * 2) STORED, \
             CONSTRAINT order_parent_fk FOREIGN KEY (parent_id) REFERENCES {q}.parent(id) \
             ON DELETE CASCADE)"
        ),
        format!("CREATE INDEX order_note_idx ON {q}.\"order\" (note)"),
        format!("COMMENT ON COLUMN {q}.\"order\".note IS 'the note'"),
        format!("CREATE TABLE {q}.nokey (a int, b text)"),
        format!("CREATE TABLE {q}.uniq (a int NOT NULL, b int, UNIQUE (a))"),
        // Sorts before uniq_a_key but its column is nullable: never a row key.
        format!("CREATE UNIQUE INDEX a_b_uniq ON {q}.uniq (b)"),
        format!("CREATE VIEW {q}.v_order AS SELECT id, amount FROM {q}.\"order\""),
    ] {
        fx.run(&sql).await;
    }
    fx
}

async fn mysql_fixture(url: &str, kind: DriverKind) -> Fx {
    let params = params_from_url(url, kind);
    let s = connect_mysql(&params).await.unwrap();
    let schema = unique_schema();
    let fx = Fx {
        s,
        _cleanup: Some(Cleanup {
            params,
            sql: format!("DROP DATABASE IF EXISTS `{schema}`"),
        }),
        _dir: None,
        schema: schema.clone(),
    };
    let q = format!("`{schema}`");
    for sql in [
        format!("CREATE DATABASE {q}"),
        format!(
            "CREATE TABLE {q}.parent (id int AUTO_INCREMENT PRIMARY KEY, \
             code varchar(50) NOT NULL UNIQUE)"
        ),
        format!(
            "CREATE TABLE {q}.`order` (\
             id int AUTO_INCREMENT PRIMARY KEY, \
             parent_id int, \
             `My \"Col\"` text, \
             amount decimal(12,2) DEFAULT 0, \
             note text COMMENT 'the note', \
             total decimal(12,2) AS (amount * 2) VIRTUAL, \
             CONSTRAINT order_parent_fk FOREIGN KEY (parent_id) REFERENCES {q}.parent(id) \
             ON DELETE CASCADE)"
        ),
        format!("CREATE INDEX order_note_idx ON {q}.`order` (note(20))"),
        format!("CREATE TABLE {q}.nokey (a int, b text)"),
        format!(
            "CREATE TABLE {q}.uniq (a int NOT NULL, b int, UNIQUE KEY uniq_a (a), \
             UNIQUE KEY a_b_uniq (b))"
        ),
        format!("CREATE VIEW {q}.v_order AS SELECT id, amount FROM {q}.`order`"),
    ] {
        fx.run(&sql).await;
    }
    fx
}

async fn sqlite_fixture() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.db");
    rusqlite::Connection::open(&path).unwrap();
    let s = connect_sqlite(&path).await.unwrap();
    let fx = Fx {
        s,
        schema: "main".into(),
        _cleanup: None,
        _dir: Some(dir),
    };
    for sql in [
        "CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL)",
        "CREATE TABLE \"order\" (id INTEGER PRIMARY KEY, \
         parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE, \
         \"My \"\"Col\"\"\" TEXT, amount NUMERIC(12,2) DEFAULT 0, note TEXT, \
         total NUMERIC GENERATED ALWAYS AS (amount * 2) VIRTUAL)",
        "CREATE INDEX order_note_idx ON \"order\" (note)",
        "CREATE TRIGGER order_touch AFTER INSERT ON \"order\" BEGIN SELECT 1; END",
        "CREATE TABLE nokey (a INT, b TEXT)",
        "CREATE TABLE uniq (a INT NOT NULL, b INT, UNIQUE (a))",
        "CREATE UNIQUE INDEX a_b_uniq ON uniq (b)",
        "CREATE TABLE wr (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID",
        "CREATE VIEW v_order AS SELECT id, amount FROM \"order\"",
    ] {
        fx.run(sql).await;
    }
    fx
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

fn col<'a>(info: &'a TableInfo, name: &str) -> &'a ColumnInfo {
    info.column(name)
        .unwrap_or_else(|| panic!("no column {name} in {:?}", info.columns))
}

fn names(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

// ---------------------------------------------------------------------------------------
// Shared assertions (engine differences passed in)
// ---------------------------------------------------------------------------------------

struct Expect {
    amount_type: &'static str,
    amount_default: &'static str,
    /// Engines that keep column comments.
    comments: bool,
    fk_name: &'static str,
}

async fn check_columns(fx: &Fx, ex: &Expect) {
    let order = fx.info("order").await;
    assert_eq!(order.kind, ObjectKind::Table);
    assert_eq!(order.object, fx.obj("order"));
    let cols: Vec<&str> = order.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(
        cols,
        ["id", "parent_id", "My \"Col\"", "amount", "note", "total"]
    );

    let id = col(&order, "id");
    assert!(id.auto_increment, "{id:?}");
    assert!(!id.nullable && !id.generated, "{id:?}");

    let amount = col(&order, "amount");
    assert_eq!(amount.type_name, ex.amount_type);
    assert!(amount.nullable);
    assert_eq!(amount.default.as_deref(), Some(ex.amount_default));
    assert!(!amount.auto_increment && !amount.generated);

    let total = col(&order, "total");
    assert!(total.generated, "{total:?}");
    assert_eq!(total.default, None);

    let tricky = col(&order, "My \"Col\"");
    assert!(tricky.nullable);
    assert_eq!(tricky.default, None);

    let note = col(&order, "note");
    let want = ex.comments.then(|| "the note".to_string());
    assert_eq!(note.comment, want);
    assert_eq!(col(&order, "parent_id").comment, None);

    let parent = fx.info("parent").await;
    assert!(col(&parent, "id").auto_increment);
    let code = col(&parent, "code");
    assert!(!code.nullable && !code.auto_increment);
}

async fn check_keys(fx: &Fx) {
    let order = fx.info("order").await;
    assert_eq!(names(&order.primary_key), ["id"]);
    assert_eq!(order.row_key, Some(vec!["id".to_string()]));
    assert!(order.editable());

    let uniq = fx.info("uniq").await;
    assert!(uniq.primary_key.is_empty());
    assert_eq!(uniq.row_key, Some(vec!["a".to_string()]));
    assert!(uniq.editable());

    let nokey = fx.info("nokey").await;
    assert!(nokey.primary_key.is_empty());
    assert_eq!(nokey.row_key, None);
    assert!(!nokey.editable());

    let view = fx.info("v_order").await;
    assert_eq!(view.kind, ObjectKind::View);
    assert!(!view.editable());
    assert!(!view.has_rowid);
    assert_eq!(view.columns.len(), 2);
}

async fn check_foreign_keys(fx: &Fx, ex: &Expect) {
    let order = fx.info("order").await;
    assert_eq!(order.foreign_keys.len(), 1, "{:?}", order.foreign_keys);
    let fk = &order.foreign_keys[0];
    assert_eq!(fk.name, ex.fk_name);
    assert_eq!(names(&fk.columns), ["parent_id"]);
    assert_eq!(fk.ref_schema.as_deref(), Some(fx.schema.as_str()));
    assert_eq!(fk.ref_table, "parent");
    assert_eq!(names(&fk.ref_columns), ["id"]);
    assert_eq!(fk.on_delete, "CASCADE");
    assert!(fx.info("parent").await.foreign_keys.is_empty());
}

async fn check_indexes(fx: &Fx) {
    let parent = fx.info("parent").await;
    let code = parent
        .indexes
        .iter()
        .find(|i| i.columns == ["code"])
        .unwrap_or_else(|| panic!("no index on code: {:?}", parent.indexes));
    assert!(code.unique && !code.primary, "{code:?}");
    let pk: Vec<_> = parent.indexes.iter().filter(|i| i.primary).collect();
    assert_eq!(pk.len(), 1, "{:?}", parent.indexes);
    assert_eq!(names(&pk[0].columns), ["id"]);
    assert!(pk[0].unique);

    let order = fx.info("order").await;
    let note = order
        .indexes
        .iter()
        .find(|i| i.name == "order_note_idx")
        .unwrap_or_else(|| panic!("no order_note_idx: {:?}", order.indexes));
    assert_eq!(names(&note.columns), ["note"]);
    assert!(!note.unique && !note.primary);
}

async fn check_missing(fx: &Fx) {
    let e = fx.s.table_info(&fx.obj("nope")).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::NotFound, "{e:?}");
    let e = fx.s.table_ddl(&fx.obj("nope")).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::NotFound, "{e:?}");
    let elsewhere = ObjectRef {
        schema: Some(unique_schema()),
        name: "order".into(),
    };
    let e = fx.s.table_info(&elsewhere).await.unwrap_err();
    assert_eq!(e.kind, ErrorKind::NotFound, "{e:?}");
}

async fn check_view_ddl(fx: &Fx) {
    let ddl = fx.ddl("v_order").await;
    assert!(ddl.starts_with("CREATE"), "{ddl}");
    assert!(ddl.contains("VIEW"), "{ddl}");
}

// ---------------------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------------------

const PG: Expect = Expect {
    amount_type: "numeric(12,2)",
    amount_default: "0",
    comments: true,
    fk_name: "order_parent_fk",
};

#[tokio::test]
async fn pg_columns_types_and_flags() {
    for url in pg_urls() {
        let fx = pg_fixture(&url).await;
        check_columns(&fx, &PG).await;
        let order = fx.info("order").await;
        assert_eq!(col(&order, "id").type_name, "integer");
        // Identity column: no stored default; serial: its nextval() default.
        assert_eq!(col(&order, "id").default, None);
        let parent = fx.info("parent").await;
        let serial = col(&parent, "id").default.clone().unwrap_or_default();
        assert!(serial.starts_with("nextval("), "{serial}");
        assert!(!order.has_rowid);
    }
}

#[tokio::test]
async fn pg_primary_and_row_key() {
    for url in pg_urls() {
        check_keys(&pg_fixture(&url).await).await;
    }
}

#[tokio::test]
async fn pg_foreign_keys() {
    for url in pg_urls() {
        let fx = pg_fixture(&url).await;
        check_foreign_keys(&fx, &PG).await;
        let fk = &fx.info("order").await.foreign_keys[0];
        assert_eq!(fk.on_update, "NO ACTION");
    }
}

#[tokio::test]
async fn pg_indexes() {
    for url in pg_urls() {
        let fx = pg_fixture(&url).await;
        check_indexes(&fx).await;
        let order = fx.info("order").await;
        let note = order
            .indexes
            .iter()
            .find(|i| i.name == "order_note_idx")
            .unwrap();
        let def = note.definition.as_deref().unwrap_or_default();
        assert!(def.starts_with("CREATE INDEX order_note_idx"), "{def}");
    }
}

#[tokio::test]
async fn pg_ddl_mentions_columns_and_constraints() {
    for url in pg_urls() {
        let fx = pg_fixture(&url).await;
        let ddl = fx.ddl("order").await;
        for want in [
            "CREATE TABLE",
            r#""My ""Col""" text"#,
            "GENERATED ALWAYS AS IDENTITY",
            "GENERATED ALWAYS AS ((amount * (2)::numeric)) STORED",
            "amount numeric(12,2) DEFAULT 0",
            "PRIMARY KEY (id)",
            "REFERENCES",
            "ON DELETE CASCADE",
            "CREATE INDEX order_note_idx",
            "COMMENT ON COLUMN",
            "'the note'",
        ] {
            assert!(ddl.contains(want), "missing {want:?} in:\n{ddl}");
        }
        // The index backing the primary key is part of its constraint, not repeated.
        assert!(!ddl.contains("CREATE UNIQUE INDEX order_pkey"), "{ddl}");
        let parent = fx.ddl("parent").await;
        assert!(parent.contains("UNIQUE (code)"), "{parent}");
        assert!(!parent.contains("CREATE UNIQUE INDEX"), "{parent}");
        check_view_ddl(&fx).await;
        assert!(fx.ddl("v_order").await.starts_with("CREATE VIEW"));
    }
}

#[tokio::test]
async fn pg_invalid_unique_index_is_never_a_row_key() {
    for url in pg_urls() {
        let fx = pg_fixture(&url).await;
        let q = format!("\"{}\"", fx.schema);
        assert_eq!(fx.info("uniq").await.row_key, Some(vec!["a".to_string()]));
        // What a failed CREATE UNIQUE INDEX CONCURRENTLY leaves behind: an index that
        // does not enforce uniqueness (the test user is a superuser).
        fx.run(&format!(
            "UPDATE pg_index SET indisvalid = false \
             WHERE indexrelid = '{q}.uniq_a_key'::regclass"
        ))
        .await;
        let uniq = fx.info("uniq").await;
        assert_eq!(uniq.row_key, None, "{:?}", uniq.indexes);
        assert!(!uniq.editable());
        // Still listed: it exists (and shows in the DDL).
        assert!(uniq.indexes.iter().any(|i| i.name == "uniq_a_key"));
    }
}

#[tokio::test]
async fn pg_missing_table_is_not_found() {
    for url in pg_urls() {
        check_missing(&pg_fixture(&url).await).await;
    }
}

// ---------------------------------------------------------------------------------------
// MySQL / MariaDB
// ---------------------------------------------------------------------------------------

const MYSQL: Expect = Expect {
    amount_type: "decimal(12,2)",
    amount_default: "0.00",
    comments: true,
    fk_name: "order_parent_fk",
};

#[tokio::test]
async fn mysql_columns_types_and_flags() {
    for (url, kind) in mysql_targets() {
        let fx = mysql_fixture(&url, kind).await;
        check_columns(&fx, &MYSQL).await;
        let order = fx.info("order").await;
        // MySQL 8 prints `int`, MariaDB `int(11)`.
        let id = &col(&order, "id").type_name;
        assert!(id.starts_with("int"), "{kind:?}: {id}");
        assert_eq!(col(&order, "id").default, None);
        assert!(!order.has_rowid);
    }
}

/// The same DDL reports the same defaults on MySQL and MariaDB: an SQL expression with
/// string literals quoted, no default (or DEFAULT NULL) as `None`.
#[tokio::test]
async fn mysql_defaults_are_normalised() {
    for (url, kind) in mysql_targets() {
        let fx = mysql_fixture(&url, kind).await;
        fx.run(&format!(
            "CREATE TABLE `{}`.defaults (\
             quote varchar(20) DEFAULT 'it''s', \
             null_text varchar(20) DEFAULT 'NULL', \
             blank varchar(20) DEFAULT '', \
             backslash varchar(20) DEFAULT 'a\\\\b', \
             plain varchar(20), \
             explicit_null varchar(20) DEFAULT NULL, \
             required varchar(20) NOT NULL, \
             day date DEFAULT '2020-01-02', \
             choice enum('x','y') DEFAULT 'y', \
             n int DEFAULT -3, \
             f double DEFAULT 1.5, \
             flags bit(3) DEFAULT b'101', \
             ts timestamp NULL DEFAULT CURRENT_TIMESTAMP, \
             ts3 datetime(3) DEFAULT CURRENT_TIMESTAMP(3), \
             uid varchar(36) DEFAULT (uuid()), \
             doc json)",
            fx.schema
        ))
        .await;
        let info = fx.info("defaults").await;
        let got: Vec<(&str, Option<&str>)> = info
            .columns
            .iter()
            .map(|c| (c.name.as_str(), c.default.as_deref()))
            .collect();
        assert_eq!(
            got,
            [
                ("quote", Some("'it''s'")),
                ("null_text", Some("'NULL'")),
                ("blank", Some("''")),
                ("backslash", Some(r"'a\\b'")),
                ("plain", None),
                ("explicit_null", None),
                ("required", None),
                ("day", Some("'2020-01-02'")),
                ("choice", Some("'y'")),
                ("n", Some("-3")),
                ("f", Some("1.5")),
                ("flags", Some("b'101'")),
                ("ts", Some("CURRENT_TIMESTAMP")),
                ("ts3", Some("CURRENT_TIMESTAMP(3)")),
                ("uid", Some("uuid()")),
                ("doc", None),
            ],
            "{kind:?}"
        );
        // MariaDB stores JSON as LONGTEXT + CHECK json_valid: still reported as json.
        assert_eq!(col(&info, "doc").type_name, "json", "{kind:?}");
        assert!(
            info.columns
                .iter()
                .all(|c| !c.generated && !c.auto_increment)
        );
    }
}

#[tokio::test]
async fn mysql_primary_and_row_key() {
    for (url, kind) in mysql_targets() {
        check_keys(&mysql_fixture(&url, kind).await).await;
    }
}

#[tokio::test]
async fn mysql_foreign_keys() {
    for (url, kind) in mysql_targets() {
        let fx = mysql_fixture(&url, kind).await;
        check_foreign_keys(&fx, &MYSQL).await;
        // Unspecified ON UPDATE: MySQL reports NO ACTION, MariaDB RESTRICT (same effect
        // in InnoDB); reported as the server says.
        let fk = &fx.info("order").await.foreign_keys[0];
        let want = if kind == DriverKind::MySql {
            "NO ACTION"
        } else {
            "RESTRICT"
        };
        assert_eq!(fk.on_update, want, "{kind:?}");
    }
}

#[tokio::test]
async fn mysql_indexes() {
    for (url, kind) in mysql_targets() {
        let fx = mysql_fixture(&url, kind).await;
        check_indexes(&fx).await;
        let parent = fx.info("parent").await;
        let pk = parent.indexes.iter().find(|i| i.primary).unwrap();
        assert_eq!(pk.name, "PRIMARY");
    }
}

#[tokio::test]
async fn mysql_ddl_mentions_columns_and_constraints() {
    for (url, kind) in mysql_targets() {
        let fx = mysql_fixture(&url, kind).await;
        let ddl = fx.ddl("order").await;
        for want in [
            "CREATE TABLE `order`",
            "`My \"Col\"` text",
            "REFERENCES `parent`",
            "ON DELETE CASCADE",
            "KEY `order_note_idx`",
            "COMMENT 'the note'",
        ] {
            assert!(ddl.contains(want), "{kind:?}: missing {want:?} in:\n{ddl}");
        }
        check_view_ddl(&fx).await;
    }
}

#[tokio::test]
async fn mysql_missing_table_is_not_found() {
    for (url, kind) in mysql_targets() {
        check_missing(&mysql_fixture(&url, kind).await).await;
    }
}

// ---------------------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------------------

const SQLITE: Expect = Expect {
    amount_type: "NUMERIC(12,2)",
    amount_default: "0",
    comments: false,
    // SQLite keeps no name for an unnamed foreign key: `<table>_<columns>_fkey`.
    fk_name: "order_parent_id_fkey",
};

#[tokio::test]
async fn sqlite_columns_types_and_flags() {
    let fx = sqlite_fixture().await;
    check_columns(&fx, &SQLITE).await;
    let order = fx.info("order").await;
    assert_eq!(col(&order, "id").type_name, "INTEGER");
    assert!(order.has_rowid);
    // A primary key that is not INTEGER is no rowid alias.
    let wr = fx.info("wr").await;
    assert!(!col(&wr, "k").auto_increment);
    assert!(!col(&wr, "k").nullable);
    assert!(!wr.has_rowid);
    // No schema given: `main`.
    let bare =
        fx.s.table_info(&ObjectRef {
            schema: None,
            name: "order".into(),
        })
        .await
        .unwrap();
    assert_eq!(bare.columns, order.columns);
}

#[tokio::test]
async fn sqlite_primary_and_row_key() {
    let fx = sqlite_fixture().await;
    check_keys(&fx).await;
    let wr = fx.info("wr").await;
    assert_eq!(wr.row_key, Some(vec!["k".to_string()]));
}

#[tokio::test]
async fn sqlite_foreign_keys() {
    let fx = sqlite_fixture().await;
    check_foreign_keys(&fx, &SQLITE).await;
    let fk = &fx.info("order").await.foreign_keys[0];
    assert_eq!(fk.on_update, "NO ACTION");
    // `REFERENCES parent` without columns targets the parent's primary key.
    fx.run("CREATE TABLE child (p INTEGER REFERENCES parent)")
        .await;
    let child = fx.info("child").await;
    assert_eq!(names(&child.foreign_keys[0].ref_columns), ["id"]);
}

#[tokio::test]
async fn sqlite_indexes() {
    let fx = sqlite_fixture().await;
    check_indexes(&fx).await;
    let order = fx.info("order").await;
    let note = order
        .indexes
        .iter()
        .find(|i| i.name == "order_note_idx")
        .unwrap();
    assert_eq!(
        note.definition.as_deref(),
        Some("CREATE INDEX order_note_idx ON \"order\" (note)")
    );
}

#[tokio::test]
async fn sqlite_ddl_mentions_columns_and_constraints() {
    let fx = sqlite_fixture().await;
    let ddl = fx.ddl("order").await;
    for want in [
        "CREATE TABLE \"order\"",
        r#""My ""Col""" TEXT"#,
        "REFERENCES parent(id) ON DELETE CASCADE",
        "CREATE INDEX order_note_idx",
        "CREATE TRIGGER order_touch",
    ] {
        assert!(ddl.contains(want), "missing {want:?} in:\n{ddl}");
    }
    check_view_ddl(&fx).await;
}

#[tokio::test]
async fn sqlite_missing_table_is_not_found() {
    check_missing(&sqlite_fixture().await).await;
}

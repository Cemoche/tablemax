pub mod catalog;
pub mod dml;
pub mod meta;
pub mod mongo;
pub mod mysql;
pub mod postgres;
pub mod query;
pub mod sql;
pub mod sqlite;
pub mod tls;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, ErrorKind};
use crate::store::MongoSettings;
use crate::value::CellValue;
use catalog::{Catalog, DbRoutine};
use dml::ApplyOutcome;
use meta::TableInfo;
use query::{Filter, Statement};
use tls::SslConfig;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DriverKind {
    Postgres,
    MySql,
    MariaDb,
    Sqlite,
    MongoDb,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Dialect {
    Postgres,
    MySql,
    Sqlite,
}

impl DriverKind {
    /// The SQL dialect of the driver; `None` for a document database.
    pub fn dialect(self) -> Option<Dialect> {
        match self {
            DriverKind::Postgres => Some(Dialect::Postgres),
            DriverKind::MySql | DriverKind::MariaDb => Some(Dialect::MySql),
            DriverKind::Sqlite => Some(Dialect::Sqlite),
            DriverKind::MongoDb => None,
        }
    }
}

/// Built by the session manager from a stored `ConnectionConfig`; never deserialized
/// from the frontend (`dial` must only ever point at a tunnel the app opened).
#[derive(Clone)]
pub struct ConnectParams {
    pub kind: DriverKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub database: Option<String>,
    pub sqlite_path: Option<PathBuf>,
    pub ssl: SslConfig,
    /// When set, the TCP connection goes to this address (e.g. an SSH tunnel's local
    /// end) while `host` stays the name used for TLS verification and display.
    pub dial: Option<SocketAddr>,
    /// MongoDB-only settings (`None` for the other drivers).
    pub mongo: Option<MongoSettings>,
}

impl std::fmt::Debug for ConnectParams {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let password = self.password.as_ref().map(|_| "<redacted>");
        f.debug_struct("ConnectParams")
            .field("kind", &self.kind)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("password", &password)
            .field("database", &self.database)
            .field("sqlite_path", &self.sqlite_path)
            .field("ssl", &self.ssl)
            .field("dial", &self.dial)
            .field("mongo", &self.mongo)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    pub schema: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ObjectKind {
    Table,
    View,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DbObject {
    pub schema: Option<String>,
    pub name: String,
    pub kind: ObjectKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    pub type_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<CellValue>>,
    /// True when the statement produced more than `MAX_RESULT_ROWS` rows and only the
    /// first `MAX_RESULT_ROWS` were kept.
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatementOutcome {
    pub result: Option<ResultSet>,
    pub rows_affected: Option<u64>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SortDir {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    pub object: ObjectRef,
    pub limit: u32,
    pub offset: u64,
    pub sort: Option<(String, SortDir)>,
    /// Joined by AND. Absent from older frontends: no filter.
    #[serde(default)]
    pub filters: Vec<Filter>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", content = "v", rename_all = "camelCase")]
pub enum RowCount {
    Exact(u64),
    Estimate(u64),
}

#[async_trait]
pub trait Canceller: Send + Sync {
    async fn cancel(&self) -> AppResult<()>;
}

/// What every live session does, whatever its data model: list, count, cancel, close.
/// All methods take `&self`: each driver guards its connection with an internal mutex
/// so `canceller()` stays usable during a running call. A cancelled call returns
/// `ErrorKind::Cancelled`.
#[async_trait]
pub trait SessionBase: Send + Sync {
    fn server_version(&self) -> String;
    async fn list_schemas(&self) -> AppResult<Vec<String>>;
    async fn list_objects(&self, schema: Option<&str>) -> AppResult<Vec<DbObject>>;
    /// Rows of a table or view without filters: an estimate above `exact_threshold`
    /// where the engine keeps one (filtered counts use `query::build_filtered_count`).
    async fn count_rows(&self, obj: &ObjectRef, exact_threshold: u64) -> AppResult<RowCount>;
    fn canceller(&self) -> Arc<dyn Canceller>;
    async fn close(&self) -> AppResult<()>;
    /// True once the session knows its connection is gone (closed, dropped after a failed
    /// ROLLBACK, or a lost link already seen): every call would fail with
    /// `ConnectionLost`. Never blocks. A link that died unnoticed still reports false.
    fn is_lost(&self) -> bool {
        false
    }
    /// Tables, views and their columns (definition order) of `schema` in one query,
    /// for completion and the palette. `None` = the default schema of the engine.
    async fn catalog(&self, schema: Option<&str>) -> AppResult<Catalog>;
    /// Databases the connection can switch to (PostgreSQL), or the schemas for
    /// MySQL / attached databases for SQLite.
    async fn list_databases(&self) -> AppResult<Vec<String>>;
}

/// A live SQL session: statements, grid pages and edits, table metadata.
#[async_trait]
pub trait Session: SessionBase {
    fn dialect(&self) -> Dialect;
    /// Runs a parameterized statement (see `query`) and returns its rows, decoded and
    /// capped (`MAX_RESULT_ROWS`) like `execute`.
    async fn query(&self, stmt: &Statement) -> AppResult<ResultSet>;
    /// `query` with text and JSON values whole (no `TEXT_PREVIEW_CHARS` cut); bytes stay
    /// a preview. For loading one cell to edit it.
    async fn query_full(&self, stmt: &Statement) -> AppResult<ResultSet>;
    /// Runs `stmts` in one transaction (see `dml`): each statement whose `expect_one` flag
    /// is set must touch exactly one row. At the first error or other row count everything
    /// is rolled back and the outcome says which statement failed and why (the database's
    /// error, or `dml::STALE_ROW`). A lost connection or a cancel (through `canceller()`)
    /// rolls back too and is returned as `Err`. Nothing else runs on the session meanwhile.
    async fn apply(&self, stmts: &[Statement], expect_one: &[bool]) -> AppResult<ApplyOutcome>;
    /// Columns, keys, indexes and foreign keys of a table or view (`NotFound` if absent).
    async fn table_info(&self, obj: &ObjectRef) -> AppResult<TableInfo>;
    /// The `CREATE` statement(s) of a table or view (`NotFound` if absent).
    async fn table_ddl(&self, obj: &ObjectRef) -> AppResult<String>;
    async fn execute(&self, sql: &str) -> AppResult<StatementOutcome>;
    /// Functions and procedures of `schema` (PostgreSQL: every non-system schema when
    /// `None`). SQLite has none.
    async fn list_routines(&self, schema: Option<&str>) -> AppResult<Vec<DbRoutine>>;
}

/// A live document session (collections of documents instead of SQL tables).
pub trait DocumentSession: SessionBase {}

/// A session of either family, as `connect` opens it.
#[derive(Clone)]
pub enum AnySession {
    Sql(Arc<dyn Session>),
    Documents(Arc<dyn DocumentSession>),
}

fn not_supported() -> AppError {
    AppError::new(ErrorKind::Invalid, "not supported by this connection")
}

impl AnySession {
    /// What every session does (list, count, cancel, close).
    pub fn base(&self) -> &dyn SessionBase {
        match self {
            AnySession::Sql(s) => s.as_ref(),
            AnySession::Documents(s) => s.as_ref(),
        }
    }

    /// The SQL session; `Invalid` for any other family.
    pub fn sql(&self) -> AppResult<&Arc<dyn Session>> {
        match self {
            AnySession::Sql(s) => Ok(s),
            AnySession::Documents(_) => Err(not_supported()),
        }
    }

    /// The document session; `Invalid` for any other family.
    pub fn documents(&self) -> AppResult<&Arc<dyn DocumentSession>> {
        match self {
            AnySession::Documents(s) => Ok(s),
            AnySession::Sql(_) => Err(not_supported()),
        }
    }
}

/// What the interface may offer on a connection, by driver kind.
#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub sql_editor: bool,
    pub grid_editing: bool,
    pub routines: bool,
    pub ddl: bool,
    pub foreign_keys: bool,
    pub documents: bool,
    /// The workspace can move its connection to another database (PostgreSQL).
    pub database_switch: bool,
}

pub fn capabilities(kind: DriverKind) -> Capabilities {
    let sql = Capabilities {
        sql_editor: true,
        grid_editing: true,
        routines: true,
        ddl: true,
        foreign_keys: true,
        documents: false,
        database_switch: false,
    };
    match kind {
        DriverKind::Postgres => Capabilities {
            database_switch: true,
            ..sql
        },
        DriverKind::MySql | DriverKind::MariaDb | DriverKind::Sqlite => sql,
        DriverKind::MongoDb => Capabilities {
            sql_editor: false,
            grid_editing: false,
            routines: false,
            ddl: false,
            foreign_keys: false,
            documents: true,
            database_switch: false,
        },
    }
}

pub async fn connect(params: &ConnectParams) -> AppResult<AnySession> {
    let session = match params.kind {
        DriverKind::MongoDb => {
            crate::flags::ensure_mongodb_enabled(crate::flags::experimental("mongodb"))?;
            return mongo::connect_mongo(params).await;
        }
        DriverKind::Sqlite => match &params.sqlite_path {
            Some(path) => sqlite::connect_sqlite(path).await,
            None => Err(AppError::new(ErrorKind::Invalid, "sqlite_path is required")),
        },
        DriverKind::Postgres => postgres::connect_postgres(params).await,
        DriverKind::MySql | DriverKind::MariaDb => mysql::connect_mysql(params).await,
    }?;
    Ok(AnySession::Sql(session))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connect_params_debug_redacts_password() {
        let params = ConnectParams {
            kind: DriverKind::Postgres,
            host: "h".into(),
            port: 5432,
            user: "u".into(),
            password: Some("s3cret-value".into()),
            database: None,
            sqlite_path: None,
            ssl: SslConfig::default(),
            dial: None,
            mongo: None,
        };
        let out = format!("{:?}", params);
        assert!(!out.contains("s3cret-value"));
        assert!(out.contains("<redacted>"));
    }

    #[test]
    fn capabilities_per_kind() {
        let sql_but_switch = Capabilities {
            sql_editor: true,
            grid_editing: true,
            routines: true,
            ddl: true,
            foreign_keys: true,
            documents: false,
            database_switch: false,
        };
        assert_eq!(
            capabilities(DriverKind::Postgres),
            Capabilities {
                database_switch: true,
                ..sql_but_switch
            }
        );
        for kind in [DriverKind::MySql, DriverKind::MariaDb, DriverKind::Sqlite] {
            assert_eq!(capabilities(kind), sql_but_switch, "{kind:?}");
        }
        let only_documents = Capabilities {
            sql_editor: false,
            grid_editing: false,
            routines: false,
            ddl: false,
            foreign_keys: false,
            documents: true,
            database_switch: false,
        };
        assert_eq!(capabilities(DriverKind::MongoDb), only_documents);
        let wire = serde_json::to_value(capabilities(DriverKind::Postgres)).unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "sqlEditor": true, "gridEditing": true, "routines": true, "ddl": true,
                "foreignKeys": true, "documents": false, "databaseSwitch": true
            })
        );
    }

    /// A document session with no data: enough to exercise `AnySession` before the
    /// first document driver exists.
    struct StubDocuments;

    struct NoCancel;

    #[async_trait]
    impl Canceller for NoCancel {
        async fn cancel(&self) -> AppResult<()> {
            Ok(())
        }
    }

    #[async_trait]
    impl SessionBase for StubDocuments {
        fn server_version(&self) -> String {
            "stub 1".into()
        }
        async fn list_schemas(&self) -> AppResult<Vec<String>> {
            Ok(vec![])
        }
        async fn list_objects(&self, _schema: Option<&str>) -> AppResult<Vec<DbObject>> {
            Ok(vec![])
        }
        async fn count_rows(&self, _obj: &ObjectRef, _exact: u64) -> AppResult<RowCount> {
            Ok(RowCount::Exact(0))
        }
        fn canceller(&self) -> Arc<dyn Canceller> {
            Arc::new(NoCancel)
        }
        async fn close(&self) -> AppResult<()> {
            Ok(())
        }
        async fn catalog(&self, _schema: Option<&str>) -> AppResult<Catalog> {
            Ok(Catalog {
                schema: None,
                tables: vec![],
            })
        }
        async fn list_databases(&self) -> AppResult<Vec<String>> {
            Ok(vec![])
        }
    }

    impl DocumentSession for StubDocuments {}

    #[tokio::test]
    async fn any_session_family_errors() {
        let docs = AnySession::Documents(Arc::new(StubDocuments));
        let err = docs.sql().err().expect("documents are not SQL");
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert!(
            err.message.contains("not supported by this connection"),
            "{}",
            err.message
        );
        assert!(docs.documents().is_ok());
        assert_eq!(docs.base().server_version(), "stub 1");
        assert!(!docs.base().is_lost());

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        std::fs::File::create(&path).unwrap();
        let sql = sqlite::connect_sqlite(&path).await.unwrap();
        let sql = AnySession::Sql(sql);
        let err = sql.documents().err().expect("SQL has no documents");
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert!(
            err.message.contains("not supported by this connection"),
            "{}",
            err.message
        );
        assert_eq!(sql.sql().unwrap().dialect(), Dialect::Sqlite);
        let schemas = sql.base().list_schemas().await.unwrap();
        assert!(schemas.contains(&"main".to_string()), "{schemas:?}");
        sql.base().close().await.unwrap();
    }
}

pub mod postgres;
pub mod sql;
pub mod sqlite;

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, ErrorKind};
use crate::value::CellValue;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum DriverKind {
    Postgres,
    MySql,
    MariaDb,
    Sqlite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    MySql,
    Sqlite,
}

impl DriverKind {
    pub fn dialect(self) -> Dialect {
        match self {
            DriverKind::Postgres => Dialect::Postgres,
            DriverKind::MySql | DriverKind::MariaDb => Dialect::MySql,
            DriverKind::Sqlite => Dialect::Sqlite,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectParams {
    pub kind: DriverKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub database: Option<String>,
    pub sqlite_path: Option<PathBuf>,
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

/// A live database session. All methods take `&self`: each driver guards its
/// connection with an internal mutex so `canceller()` stays usable during
/// `execute`. A cancelled query returns `ErrorKind::Cancelled`.
#[async_trait]
pub trait Session: Send + Sync {
    fn dialect(&self) -> Dialect;
    fn server_version(&self) -> String;
    async fn list_schemas(&self) -> AppResult<Vec<String>>;
    async fn list_objects(&self, schema: Option<&str>) -> AppResult<Vec<DbObject>>;
    async fn fetch_page(&self, req: &PageRequest) -> AppResult<ResultSet>;
    async fn count_rows(&self, obj: &ObjectRef, exact_threshold: u64) -> AppResult<RowCount>;
    async fn execute(&self, sql: &str) -> AppResult<StatementOutcome>;
    fn canceller(&self) -> Arc<dyn Canceller>;
    async fn close(&self) -> AppResult<()>;
}

pub async fn connect(params: &ConnectParams) -> AppResult<Arc<dyn Session>> {
    // Driver tasks replace these arms.
    match params.kind {
        DriverKind::Sqlite => match &params.sqlite_path {
            Some(path) => sqlite::connect_sqlite(path).await,
            None => Err(AppError::new(ErrorKind::Invalid, "sqlite_path is required")),
        },
        DriverKind::Postgres => postgres::connect_postgres(params).await,
        DriverKind::MySql | DriverKind::MariaDb => {
            Err(AppError::new(ErrorKind::Invalid, "driver not available"))
        }
    }
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
        };
        let out = format!("{:?}", params);
        assert!(!out.contains("s3cret-value"));
        assert!(out.contains("<redacted>"));
    }
}

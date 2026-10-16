//! SQLite driver. One `rusqlite::Connection` behind a std mutex; every call runs in
//! `spawn_blocking`. Cancellation goes through SQLite's `InterruptHandle`, which is
//! independent of the mutex so it works while `execute` holds the connection.
//!
//! After `close()`, every session call returns `ErrorKind::ConnectionLost`.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, InterruptHandle, OpenFlags};

use super::sql::{build_page_query, qualified};
use super::{
    Canceller, ColumnMeta, DbObject, Dialect, ObjectKind, ObjectRef, PageRequest, ResultSet,
    RowCount, Session, StatementOutcome,
};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::value::{CellValue, MAX_RESULT_ROWS, bytes_value, float_value, int_value, text_value};

struct SqliteSession {
    conn: Arc<Mutex<Option<Connection>>>,
    interrupt: Arc<InterruptHandle>,
    version: String,
}

struct SqliteCanceller(Arc<InterruptHandle>);

#[async_trait]
impl Canceller for SqliteCanceller {
    async fn cancel(&self) -> AppResult<()> {
        self.0.interrupt();
        Ok(())
    }
}

fn map_err(e: rusqlite::Error) -> AppError {
    if let rusqlite::Error::SqliteFailure(f, _) = &e
        && f.code == rusqlite::ErrorCode::OperationInterrupted
    {
        return AppError::new(ErrorKind::Cancelled, "query cancelled");
    }
    AppError::new(ErrorKind::Query, e.to_string())
}

pub async fn connect_sqlite(path: &Path) -> AppResult<Arc<dyn Session>> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_flags(&path, flags).map_err(|e| {
            let missing = matches!(
                &e,
                rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::CannotOpen
            ) && !path.exists();
            if missing {
                AppError::new(
                    ErrorKind::NotFound,
                    format!("database file not found: {}", path.display()),
                )
            } else {
                AppError::new(ErrorKind::Connection, e.to_string())
            }
        })?;
        // Opening is lazy; touch the file so a non-database file fails here.
        conn.query_row("SELECT count(*) FROM sqlite_schema", [], |_| Ok(()))
            .map_err(|e| AppError::new(ErrorKind::Connection, e.to_string()))?;
        let interrupt = Arc::new(conn.get_interrupt_handle());
        let session: Arc<dyn Session> = Arc::new(SqliteSession {
            conn: Arc::new(Mutex::new(Some(conn))),
            interrupt,
            version: rusqlite::version().to_string(),
        });
        Ok(session)
    })
    .await
    .map_err(|e| AppError::new(ErrorKind::Connection, e.to_string()))?
}

impl SqliteSession {
    async fn with_conn<T, F>(&self, f: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> AppResult<T> + Send + 'static,
    {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let guard = conn
                .lock()
                .map_err(|_| AppError::new(ErrorKind::ConnectionLost, "connection poisoned"))?;
            match guard.as_ref() {
                Some(c) => f(c),
                None => Err(AppError::new(ErrorKind::ConnectionLost, "session closed")),
            }
        })
        .await
        .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?
    }
}

fn cell(v: ValueRef<'_>) -> CellValue {
    match v {
        ValueRef::Null => CellValue::Null,
        ValueRef::Integer(i) => int_value(i),
        ValueRef::Real(f) => float_value(f),
        ValueRef::Text(t) => text_value(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => bytes_value(b),
    }
}

fn read_rows(stmt: &mut rusqlite::Statement<'_>) -> AppResult<ResultSet> {
    let columns: Vec<ColumnMeta> = stmt
        .columns()
        .iter()
        .map(|c| ColumnMeta {
            name: c.name().to_string(),
            type_name: c.decl_type().unwrap_or("").to_string(),
        })
        .collect();
    let n = columns.len();
    let mut rows = Vec::new();
    let mut truncated = false;
    let mut q = stmt.query([]).map_err(map_err)?;
    while let Some(row) = q.next().map_err(map_err)? {
        if rows.len() == MAX_RESULT_ROWS {
            // One row past the cap: stop stepping, the statement is reset on drop.
            truncated = true;
            break;
        }
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            out.push(cell(row.get_ref(i).map_err(map_err)?));
        }
        rows.push(out);
    }
    Ok(ResultSet {
        columns,
        rows,
        truncated,
    })
}

#[async_trait]
impl Session for SqliteSession {
    fn dialect(&self) -> Dialect {
        Dialect::Sqlite
    }

    fn server_version(&self) -> String {
        self.version.clone()
    }

    async fn list_schemas(&self) -> AppResult<Vec<String>> {
        self.with_conn(|c| {
            let mut stmt = c.prepare("PRAGMA database_list").map_err(map_err)?;
            let names = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .map_err(map_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(map_err)?;
            Ok(names.into_iter().filter(|n| n != "temp").collect())
        })
        .await
    }

    async fn list_objects(&self, schema: Option<&str>) -> AppResult<Vec<DbObject>> {
        let schema = schema.unwrap_or("main").to_string();
        self.with_conn(move |c| {
            let sql = format!(
                "SELECT name, type FROM {}.sqlite_schema \
                 WHERE type IN ('table','view') AND substr(name,1,7) <> 'sqlite_' \
                 ORDER BY name",
                super::sql::quote_ident(Dialect::Sqlite, &schema)
            );
            let mut stmt = c.prepare(&sql).map_err(map_err)?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(map_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(map_err)?;
            Ok(rows
                .into_iter()
                .map(|(name, ty)| DbObject {
                    schema: Some(schema.clone()),
                    name,
                    kind: if ty == "view" {
                        ObjectKind::View
                    } else {
                        ObjectKind::Table
                    },
                })
                .collect())
        })
        .await
    }

    async fn fetch_page(&self, req: &PageRequest) -> AppResult<ResultSet> {
        let sql = build_page_query(Dialect::Sqlite, req);
        self.with_conn(move |c| {
            let mut stmt = c.prepare(&sql).map_err(map_err)?;
            read_rows(&mut stmt)
        })
        .await
    }

    async fn count_rows(&self, obj: &ObjectRef, _exact_threshold: u64) -> AppResult<RowCount> {
        let sql = format!("SELECT COUNT(*) FROM {}", qualified(Dialect::Sqlite, obj));
        self.with_conn(move |c| {
            let n: i64 = c.query_row(&sql, [], |r| r.get(0)).map_err(map_err)?;
            Ok(RowCount::Exact(n.max(0) as u64))
        })
        .await
    }

    async fn execute(&self, sql: &str) -> AppResult<StatementOutcome> {
        let sql = sql.to_string();
        self.with_conn(move |c| {
            let start = Instant::now();
            let mut stmt = c.prepare(&sql).map_err(map_err)?;
            if stmt.column_count() > 0 {
                let rs = read_rows(&mut stmt)?;
                Ok(StatementOutcome {
                    result: Some(rs),
                    rows_affected: None,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                })
            } else {
                stmt.execute([]).map_err(map_err)?;
                Ok(StatementOutcome {
                    result: None,
                    rows_affected: Some(c.changes()),
                    elapsed_ms: start.elapsed().as_millis() as u64,
                })
            }
        })
        .await
    }

    fn canceller(&self) -> Arc<dyn Canceller> {
        Arc::new(SqliteCanceller(self.interrupt.clone()))
    }

    async fn close(&self) -> AppResult<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = conn
                .lock()
                .map_err(|_| AppError::new(ErrorKind::ConnectionLost, "connection poisoned"))?;
            if let Some(c) = guard.take() {
                c.close().map_err(|(_, e)| map_err(e))?;
            }
            Ok(())
        })
        .await
        .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?
    }
}

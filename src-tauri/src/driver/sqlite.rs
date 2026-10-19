//! SQLite driver. One `rusqlite::Connection` behind a std mutex; every call runs in
//! `spawn_blocking`. Cancellation goes through SQLite's `InterruptHandle`, which is
//! independent of the mutex so it works while `execute` holds the connection.
//!
//! After `close()`, every session call returns `ErrorKind::ConnectionLost`.
//!
//! `apply` runs `BEGIN IMMEDIATE` … `COMMIT` inside one `with_conn` call: the mutex keeps
//! every other call out of the transaction. An interrupt cancels the running statement
//! (SQLite may then roll the transaction back itself; the explicit ROLLBACK is best effort).
//! A transaction still open after it closes the connection: the session is then lost.

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use async_trait::async_trait;
use rusqlite::types::{ToSqlOutput, ValueRef};
use rusqlite::{Connection, InterruptHandle, OpenFlags, OptionalExtension, ToSql};

use super::catalog::{Catalog, CatalogColumn, DbRoutine, group_rows};
use super::dml::{self, ApplyOutcome};
use super::meta::{
    ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo, derive_row_key, non_null_default,
    object_not_found, sort_indexes,
};
use super::query::{SqlParam, Statement, is_binary};
use super::sql::{qualified, quote_ident};
use super::{
    Canceller, ColumnMeta, DbObject, Dialect, ObjectKind, ObjectRef, ResultSet, RowCount, Session,
    StatementOutcome,
};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::value::{CellValue, MAX_RESULT_ROWS, bytes_value, float_value, int_value, text_cell};

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
    /// `query` / `query_full`; `full` keeps text whole.
    async fn query_with(&self, stmt: &Statement, full: bool) -> AppResult<ResultSet> {
        let stmt = stmt.clone();
        self.with_conn(move |c| {
            let mut prepared = c.prepare(&stmt.sql).map_err(map_err)?;
            read_rows(
                &mut prepared,
                rusqlite::params_from_iter(stmt.params.iter()),
                full,
            )
        })
        .await
    }

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

/// `full` keeps text whole.
fn cell(v: ValueRef<'_>, full: bool) -> CellValue {
    match v {
        ValueRef::Null => CellValue::Null,
        ValueRef::Integer(i) => int_value(i),
        ValueRef::Real(f) => float_value(f),
        ValueRef::Text(t) => text_cell(String::from_utf8_lossy(t).into_owned(), full),
        ValueRef::Blob(b) => bytes_value(b),
    }
}

impl ToSql for SqlParam {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        match self {
            SqlParam::Text(s) => s.to_sql(),
            SqlParam::Bytes(b) => b.to_sql(),
        }
    }
}

fn read_rows(
    stmt: &mut rusqlite::Statement<'_>,
    params: impl rusqlite::Params,
    full: bool,
) -> AppResult<ResultSet> {
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
    let mut q = stmt.query(params).map_err(map_err)?;
    while let Some(row) = q.next().map_err(map_err)? {
        if rows.len() == MAX_RESULT_ROWS {
            // One row past the cap: stop stepping, the statement is reset on drop.
            truncated = true;
            break;
        }
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            out.push(cell(row.get_ref(i).map_err(map_err)?, full));
        }
        rows.push(out);
    }
    Ok(ResultSet {
        columns,
        rows,
        truncated,
    })
}

/// The transaction of `apply` (see the module docs).
fn apply_tx(c: &Connection, stmts: &[Statement], expect_one: &[bool]) -> AppResult<ApplyOutcome> {
    let rollback = || {
        let _ = c.execute_batch("ROLLBACK");
    };
    c.execute_batch("BEGIN IMMEDIATE").map_err(map_err)?;
    let mut affected = Vec::with_capacity(stmts.len());
    for (i, stmt) in stmts.iter().enumerate() {
        let result = c
            .prepare(&stmt.sql)
            .and_then(|mut p| p.execute(rusqlite::params_from_iter(stmt.params.iter())))
            .map(|n| n as u64)
            .map_err(map_err);
        if let Err(halt) = dml::record(i, expect_one[i], result, &mut affected) {
            rollback();
            return halt.into_result();
        }
    }
    match c.execute_batch("COMMIT") {
        Ok(()) => Ok(dml::applied(affected)),
        Err(e) => {
            rollback();
            dml::commit_failed(affected, map_err(e))
        }
    }
}

/// Kind and `CREATE` statement of a table or view; `NotFound` when the schema or the
/// object does not exist.
fn object_of(c: &Connection, schema: &str, name: &str) -> AppResult<(ObjectKind, String)> {
    let known: bool = c
        .query_row(
            "SELECT EXISTS (SELECT 1 FROM pragma_database_list WHERE name = ?1)",
            [schema],
            |r| r.get(0),
        )
        .map_err(map_err)?;
    if !known {
        return Err(object_not_found(schema, name));
    }
    let sql = format!(
        "SELECT type, sql FROM {}.sqlite_schema WHERE name = ?1 AND type IN ('table', 'view')",
        quote_ident(Dialect::Sqlite, schema)
    );
    let found = c
        .query_row(&sql, [name], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .optional()
        .map_err(map_err)?;
    let (ty, create) = found.ok_or_else(|| object_not_found(schema, name))?;
    let kind = if ty == "view" {
        ObjectKind::View
    } else {
        ObjectKind::Table
    };
    Ok((kind, create.unwrap_or_default()))
}

/// Primary key columns in key order.
fn primary_key_of(c: &Connection, schema: &str, table: &str) -> AppResult<Vec<String>> {
    let mut stmt = c
        .prepare("SELECT name FROM pragma_table_info(?1, ?2) WHERE pk > 0 ORDER BY pk")
        .map_err(map_err)?;
    stmt.query_map([table, schema], |r| r.get(0))
        .map_err(map_err)?
        .collect::<Result<_, _>>()
        .map_err(map_err)
}

fn table_info_of(c: &Connection, schema: &str, name: &str) -> AppResult<TableInfo> {
    let (kind, _) = object_of(c, schema, name)?;
    let without_rowid: bool = c
        .query_row(
            "SELECT wr FROM pragma_table_list WHERE schema = ?1 AND name = ?2",
            [schema, name],
            |r| r.get(0),
        )
        .optional()
        .map_err(map_err)?
        .unwrap_or(false);
    let has_rowid = kind == ObjectKind::Table && !without_rowid;

    // name, declared type, notnull, default, pk position, hidden (2/3 = generated).
    type XInfo = (String, String, bool, Option<String>, i64, i64);
    let mut stmt = c
        .prepare(
            "SELECT name, type, \"notnull\", dflt_value, pk, hidden \
             FROM pragma_table_xinfo(?1, ?2) WHERE hidden <> 1 ORDER BY cid",
        )
        .map_err(map_err)?;
    let raw: Vec<XInfo> = stmt
        .query_map([name, schema], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .map_err(map_err)?
        .collect::<Result<_, _>>()
        .map_err(map_err)?;
    let mut pk: Vec<(i64, String)> = raw
        .iter()
        .filter(|x| x.4 > 0)
        .map(|x| (x.4, x.0.clone()))
        .collect();
    pk.sort();
    let primary_key: Vec<String> = pk.into_iter().map(|(_, n)| n).collect();
    // `INTEGER PRIMARY KEY` on a rowid table is an alias of the rowid: never NULL,
    // assigned automatically.
    let rowid_alias = |x: &XInfo| {
        has_rowid && primary_key.len() == 1 && x.4 == 1 && x.1.eq_ignore_ascii_case("INTEGER")
    };
    let columns: Vec<ColumnInfo> = raw
        .iter()
        .map(|x| {
            let alias = rowid_alias(x);
            // WITHOUT ROWID tables enforce NOT NULL on their primary key.
            let not_null = x.2 || alias || (without_rowid && x.4 > 0);
            ColumnInfo {
                name: x.0.clone(),
                type_name: x.1.clone(),
                base_type: x.1.clone(),
                nullable: !not_null,
                default: non_null_default(x.3.clone()),
                auto_increment: alias,
                generated: x.5 == 2 || x.5 == 3,
                binary: is_binary(Dialect::Sqlite, &x.1),
                comment: None,
            }
        })
        .collect();

    let q = quote_ident(Dialect::Sqlite, schema);
    let mut stmt = c
        .prepare("SELECT name, \"unique\", origin, partial FROM pragma_index_list(?1, ?2)")
        .map_err(map_err)?;
    let listed: Vec<(String, bool, String, bool)> = stmt
        .query_map([name, schema], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(map_err)?
        .collect::<Result<_, _>>()
        .map_err(map_err)?;
    let mut indexes = Vec::new();
    let mut partial = Vec::new();
    for (idx, unique, origin, is_partial) in listed {
        let mut stmt = c
            .prepare("SELECT cid, name FROM pragma_index_info(?1, ?2) ORDER BY seqno")
            .map_err(map_err)?;
        let columns: Vec<String> = stmt
            .query_map([idx.as_str(), schema], |r| {
                let cid: i64 = r.get(0)?;
                let name: Option<String> = r.get(1)?;
                Ok(name.unwrap_or_else(|| {
                    if cid == -1 {
                        "rowid".into()
                    } else {
                        "(expression)".into()
                    }
                }))
            })
            .map_err(map_err)?
            .collect::<Result<_, _>>()
            .map_err(map_err)?;
        let definition: Option<String> = c
            .query_row(
                &format!("SELECT sql FROM {q}.sqlite_schema WHERE type = 'index' AND name = ?1"),
                [idx.as_str()],
                |r| r.get(0),
            )
            .optional()
            .map_err(map_err)?
            .flatten();
        if is_partial {
            partial.push(idx.clone());
        }
        indexes.push(IndexInfo {
            name: idx,
            columns,
            unique,
            primary: origin == "pk",
            definition,
        });
    }
    // A rowid alias primary key has no index of its own: list it like the others.
    if !primary_key.is_empty() && !indexes.iter().any(|i| i.primary) {
        indexes.push(IndexInfo {
            name: "PRIMARY".into(),
            columns: primary_key.clone(),
            unique: true,
            primary: true,
            definition: None,
        });
    }
    sort_indexes(&mut indexes);
    let row_key = derive_row_key(
        &primary_key,
        indexes.iter().filter(|i| !partial.contains(&i.name)),
        &columns,
    );

    // id, seq, table, from, to (NULL = the parent's primary key), on_update, on_delete.
    type FkRow = (i64, String, String, Option<String>, String, String);
    let mut stmt = c
        .prepare(
            "SELECT id, \"table\", \"from\", \"to\", on_update, on_delete \
             FROM pragma_foreign_key_list(?1, ?2) ORDER BY id, seq",
        )
        .map_err(map_err)?;
    let fk_rows: Vec<FkRow> = stmt
        .query_map([name, schema], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .map_err(map_err)?
        .collect::<Result<_, _>>()
        .map_err(map_err)?;
    let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
    let mut implicit: Vec<bool> = Vec::new();
    let mut last_id = None;
    for (id, table, from, to, on_update, on_delete) in fk_rows {
        if last_id != Some(id) {
            last_id = Some(id);
            implicit.push(false);
            foreign_keys.push(ForeignKeyInfo {
                name: String::new(),
                columns: Vec::new(),
                ref_schema: Some(schema.to_string()),
                ref_table: table,
                ref_columns: Vec::new(),
                on_update,
                on_delete,
            });
        }
        let (fk, imp) = (
            foreign_keys.last_mut().expect("pushed above"),
            implicit.last_mut().expect("pushed above"),
        );
        fk.columns.push(from);
        match to {
            Some(to) => fk.ref_columns.push(to),
            None => *imp = true,
        }
    }
    for (fk, imp) in foreign_keys.iter_mut().zip(implicit) {
        if imp {
            fk.ref_columns = primary_key_of(c, schema, &fk.ref_table)?;
        }
        // SQLite keeps no name for a foreign key: `<table>_<columns>_fkey`, like PostgreSQL.
        fk.name = format!("{name}_{}_fkey", fk.columns.join("_"));
    }

    Ok(TableInfo {
        object: ObjectRef {
            schema: Some(schema.to_string()),
            name: name.to_string(),
        },
        kind,
        columns,
        primary_key,
        indexes,
        foreign_keys,
        row_key,
        has_rowid,
    })
}

/// The table/view statement, then its indexes and triggers, each ending with `;`.
fn table_ddl_of(c: &Connection, schema: &str, name: &str) -> AppResult<String> {
    let (_, create) = object_of(c, schema, name)?;
    let sql = format!(
        "SELECT sql FROM {}.sqlite_schema WHERE tbl_name = ?1 \
         AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name",
        quote_ident(Dialect::Sqlite, schema)
    );
    let mut stmt = c.prepare(&sql).map_err(map_err)?;
    let extra: Vec<String> = stmt
        .query_map([name], |r| r.get(0))
        .map_err(map_err)?
        .collect::<Result<_, _>>()
        .map_err(map_err)?;
    Ok(std::iter::once(create)
        .chain(extra)
        .map(|s| format!("{};", s.trim_end().trim_end_matches(';')))
        .collect::<Vec<_>>()
        .join("\n\n"))
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
                quote_ident(Dialect::Sqlite, &schema)
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

    async fn query(&self, stmt: &Statement) -> AppResult<ResultSet> {
        self.query_with(stmt, false).await
    }

    async fn query_full(&self, stmt: &Statement) -> AppResult<ResultSet> {
        self.query_with(stmt, true).await
    }

    async fn apply(&self, stmts: &[Statement], expect_one: &[bool]) -> AppResult<ApplyOutcome> {
        dml::check_apply_args(stmts, expect_one)?;
        let (stmts, expect_one) = (stmts.to_vec(), expect_one.to_vec());
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = conn
                .lock()
                .map_err(|_| AppError::new(ErrorKind::ConnectionLost, "connection poisoned"))?;
            let Some(c) = guard.as_ref() else {
                return Err(AppError::new(ErrorKind::ConnectionLost, "session closed"));
            };
            let out = apply_tx(c, &stmts, &expect_one);
            // Still inside the transaction (the ROLLBACK failed): close the connection,
            // which rolls it back, rather than leave it open on the session.
            if !c.is_autocommit() {
                drop(guard.take());
            }
            out
        })
        .await
        .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?
    }

    async fn count_rows(&self, obj: &ObjectRef, _exact_threshold: u64) -> AppResult<RowCount> {
        let sql = format!("SELECT COUNT(*) FROM {}", qualified(Dialect::Sqlite, obj));
        self.with_conn(move |c| {
            let n: i64 = c.query_row(&sql, [], |r| r.get(0)).map_err(map_err)?;
            Ok(RowCount::Exact(n.max(0) as u64))
        })
        .await
    }

    async fn table_info(&self, obj: &ObjectRef) -> AppResult<TableInfo> {
        let schema = obj.schema.clone().unwrap_or_else(|| "main".into());
        let name = obj.name.clone();
        self.with_conn(move |c| table_info_of(c, &schema, &name))
            .await
    }

    async fn table_ddl(&self, obj: &ObjectRef) -> AppResult<String> {
        let schema = obj.schema.clone().unwrap_or_else(|| "main".into());
        let name = obj.name.clone();
        self.with_conn(move |c| table_ddl_of(c, &schema, &name))
            .await
    }

    async fn execute(&self, sql: &str) -> AppResult<StatementOutcome> {
        let sql = sql.to_string();
        self.with_conn(move |c| {
            let start = Instant::now();
            let mut stmt = c.prepare(&sql).map_err(map_err)?;
            if stmt.column_count() > 0 {
                let rs = read_rows(&mut stmt, [], false)?;
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

    fn is_lost(&self) -> bool {
        // Busy = a call is running on a connection that is still there.
        match self.conn.try_lock() {
            Ok(guard) => guard.is_none(),
            Err(std::sync::TryLockError::WouldBlock) => false,
            Err(std::sync::TryLockError::Poisoned(_)) => true,
        }
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

    async fn catalog(&self, schema: Option<&str>) -> AppResult<Catalog> {
        let schema = schema.unwrap_or("main").to_string();
        // One blocking call. Columns are read per object so that a broken view (its base
        // table dropped) is listed without columns instead of failing the whole catalog.
        self.with_conn(move |c| {
            let sql = format!(
                "SELECT name, type FROM {}.sqlite_schema \
                 WHERE type IN ('table','view') AND substr(name,1,7) <> 'sqlite_' \
                 ORDER BY name",
                super::sql::quote_ident(Dialect::Sqlite, &schema)
            );
            let mut stmt = c.prepare(&sql).map_err(map_err)?;
            let objects = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(map_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(map_err)?;
            let columns_of = |name: &str| -> rusqlite::Result<Vec<CatalogColumn>> {
                let mut st =
                    c.prepare("SELECT name, type FROM pragma_table_info(?1, ?2) ORDER BY cid")?;
                st.query_map([name, schema.as_str()], |r| {
                    Ok(CatalogColumn {
                        name: r.get(0)?,
                        type_name: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    })
                })?
                .collect()
            };
            Ok(group_rows(
                Some(schema.clone()),
                objects.into_iter().flat_map(|(name, ty)| {
                    let kind = if ty == "view" {
                        ObjectKind::View
                    } else {
                        ObjectKind::Table
                    };
                    match columns_of(&name) {
                        Ok(cols) if !cols.is_empty() => cols
                            .into_iter()
                            .map(|col| (name.clone(), kind, Some(col)))
                            .collect::<Vec<_>>(),
                        _ => vec![(name, kind, None)],
                    }
                }),
            ))
        })
        .await
    }

    async fn list_routines(&self, _schema: Option<&str>) -> AppResult<Vec<DbRoutine>> {
        Ok(Vec::new())
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        self.list_schemas().await
    }
}

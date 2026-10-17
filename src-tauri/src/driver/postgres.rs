//! PostgreSQL driver on `tokio-postgres`, TLS through `tokio-postgres-rustls`.
//!
//! TLS: `Disable` connects with `NoTls`; `Prefer` lets the server decline TLS; every other
//! mode requires it, the certificate checks living in the rustls config (see `tls`).
//! `host` is always the TLS/display name; `dial`, when set, is the TCP target
//! (`hostaddr` + `port`). The cancel token keeps both and reuses the same TLS connector.
//!
//! The `Client` is `&self`-usable, so no mutex is needed and `canceller()` works while
//! `execute` is in flight. The connection future runs on a tokio task; when it ends the
//! session is flagged lost so later calls fail fast with `ConnectionLost`.
//!
//! Result decoding: the statement is `prepare`d only to learn the column types (OIDs),
//! then run through `simple_query_raw` (text protocol, streamed so at most
//! `MAX_RESULT_ROWS` rows are kept; the rest is drained and the set marked
//! `truncated`). Every value therefore arrives in PostgreSQL's own canonical text form (exact `numeric`, jsonb with its canonical
//! spacing, uuid/inet/enum/array/interval as the server prints them) and is re-typed
//! from the column OID by `cell_from_text`. This avoids per-type binary decoders and
//! any precision loss. `simple_query` also reports the command's row count, which
//! gives `rows_affected` for statements without columns. If `prepare` fails for a
//! statement that cannot be prepared, we fall back to `simple_query` alone and all
//! values come back as Text/Null.
//!
//! Parameterized statements (`query`) need the extended protocol, whose rows tokio-postgres
//! always requests in binary. To keep the same canonical text (and the same decoder), the
//! statement is prepared to learn its columns, then wrapped so the server renders every
//! value with its type's output function: `WITH q(c1, ..) AS (<sql>) SELECT CASE WHEN
//! num_nulls(q.c1) = 0 THEN format('%s', q.c1) END, .. FROM q` (`format('%s')` calls the
//! output function; `num_nulls` keeps NULL apart from an all-NULL composite).
//! A statement without parameters takes the simple-query path above instead.
//!
//! Row changes (`apply`) run `BEGIN`, each statement through `execute_raw` (its row count),
//! then `COMMIT` (or `ROLLBACK`). The `Client` pipelines concurrent calls on one
//! connection, so a page fetch issued meanwhile would run inside the transaction: every
//! call takes `gate` shared, `apply` takes it exclusive for the whole transaction.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::StreamExt;
use tokio_postgres::config::SslMode as PgSslMode;
use tokio_postgres::error::SqlState;
use tokio_postgres::tls::MakeTlsConnect;
use tokio_postgres::types::{ToSql, Type};
use tokio_postgres::{CancelToken, Client, Config, NoTls, SimpleQueryMessage, Socket};
use tokio_postgres_rustls::MakeRustlsConnect;

use super::dml::{self, ApplyOutcome};
use super::meta::{
    ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo, derive_row_key, non_null_default,
    object_not_found,
};
use super::query::{SqlParam, Statement};
use super::sql::qualified;
use super::tls::{SslMode, rustls_client_config};
use super::{
    Canceller, ColumnMeta, ConnectParams, DbObject, Dialect, ObjectKind, ObjectRef, ResultSet,
    RowCount, Session, StatementOutcome,
};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::value::{
    CellValue, MAX_RESULT_ROWS, bytes_value, decode_hex, float_value, int_value, json_cell,
    text_cell,
};

struct PgSession {
    client: Client,
    cancel: CancelToken,
    /// The connector the session was opened with (`None` = `NoTls`), reused to cancel.
    tls: Option<MakeRustlsConnect>,
    lost: Arc<AtomicBool>,
    conn_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    version: String,
    /// Shared by every call, exclusive during `apply` (see the module docs).
    gate: tokio::sync::RwLock<()>,
}

struct PgCanceller {
    token: CancelToken,
    tls: Option<MakeRustlsConnect>,
}

#[async_trait]
impl Canceller for PgCanceller {
    async fn cancel(&self) -> AppResult<()> {
        match &self.tls {
            Some(tls) => self.token.cancel_query(tls.clone()).await,
            None => self.token.cancel_query(NoTls).await,
        }
        .map_err(|e| AppError::new(ErrorKind::Connection, with_causes(&e)))
    }
}

/// Maps a server error; `None` when the error did not come from the server.
fn map_db_error(e: &tokio_postgres::Error) -> Option<AppError> {
    let db = e.as_db_error()?;
    let code = db.code();
    let kind = if *code == SqlState::INVALID_PASSWORD
        || *code == SqlState::INVALID_AUTHORIZATION_SPECIFICATION
    {
        ErrorKind::Auth
    } else if *code == SqlState::QUERY_CANCELED {
        ErrorKind::Cancelled
    } else if *code == SqlState::INVALID_CATALOG_NAME {
        ErrorKind::NotFound
    } else if *code == SqlState::ADMIN_SHUTDOWN || *code == SqlState::CRASH_SHUTDOWN {
        ErrorKind::ConnectionLost
    } else {
        ErrorKind::Query
    };
    Some(AppError::new(kind, db.message()))
}

/// `e` followed by its sources: tokio-postgres' own message omits the cause (e.g. which
/// certificate check failed during the TLS handshake).
fn with_causes(e: &tokio_postgres::Error) -> String {
    let mut msg = e.to_string();
    let mut cause = std::error::Error::source(e);
    while let Some(c) = cause {
        msg.push_str(": ");
        msg.push_str(&c.to_string());
        cause = c.source();
    }
    msg
}

fn map_connect_err(e: tokio_postgres::Error) -> AppError {
    map_db_error(&e).unwrap_or_else(|| AppError::new(ErrorKind::Connection, with_causes(&e)))
}

/// Error during a call on a live session: a non-server error means the link is gone.
fn map_err(e: tokio_postgres::Error) -> AppError {
    map_db_error(&e).unwrap_or_else(|| AppError::new(ErrorKind::ConnectionLost, e.to_string()))
}

/// Connects and drives the connection on a task that flags `lost` when it ends.
async fn open_client<T>(
    cfg: &Config,
    tls: T,
    lost: Arc<AtomicBool>,
) -> AppResult<(Client, tokio::task::JoinHandle<()>)>
where
    T: MakeTlsConnect<Socket>,
    T::Stream: Send + 'static,
{
    let (client, connection) = cfg.connect(tls).await.map_err(map_connect_err)?;
    let handle = tokio::spawn(async move {
        let _ = connection.await;
        lost.store(true, Ordering::SeqCst);
    });
    Ok((client, handle))
}

fn pg_ssl_mode(mode: SslMode) -> PgSslMode {
    match mode {
        SslMode::Disable => PgSslMode::Disable,
        SslMode::Prefer => PgSslMode::Prefer,
        SslMode::Require | SslMode::VerifyCa | SslMode::VerifyFull => PgSslMode::Require,
    }
}

/// Bounds TCP connect, TLS, authentication and the session setup queries together: a
/// server (or tunnel) that accepts and never answers fails as Connection
/// "connection timed out" instead of hanging (tokio-postgres only bounds the TCP connect).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

struct AbortOnDrop(Option<tokio::task::JoinHandle<()>>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        if let Some(h) = self.0.take() {
            h.abort();
        }
    }
}

pub async fn connect_postgres(p: &ConnectParams) -> AppResult<Arc<dyn Session>> {
    let tls =
        rustls_client_config(&p.ssl)?.map(|c| MakeRustlsConnect::new(Arc::unwrap_or_clone(c)));
    let mut cfg = Config::new();
    cfg.host(&p.host)
        .user(&p.user)
        .ssl_mode(pg_ssl_mode(p.ssl.mode));
    match p.dial {
        Some(addr) => cfg.hostaddr(addr.ip()).port(addr.port()),
        None => cfg.port(p.port),
    };
    if let Some(pw) = &p.password {
        cfg.password(pw);
    }
    if let Some(db) = &p.database {
        cfg.dbname(db);
    }
    // TCP connect only: the whole connect + startup is bounded by CONNECT_TIMEOUT below.
    cfg.connect_timeout(CONNECT_TIMEOUT);
    let lost = Arc::new(AtomicBool::new(false));
    let opened = tokio::time::timeout(CONNECT_TIMEOUT, async {
        let (client, handle) = match &tls {
            Some(tls) => open_client(&cfg, tls.clone(), lost.clone()).await?,
            None => open_client(&cfg, NoTls, lost.clone()).await?,
        };
        // Stops the connection task if init fails or the deadline drops this future.
        let mut guard = AbortOnDrop(Some(handle));
        // The text decoders assume hex bytea output.
        client
            .batch_execute("SET bytea_output = 'hex'")
            .await
            .map_err(map_err)?;
        let row = client
            .query_one("SELECT current_setting('server_version')", &[])
            .await
            .map_err(map_err)?;
        let handle = guard.0.take().expect("connection task");
        Ok::<_, AppError>((client, handle, row.get::<_, String>(0)))
    })
    .await;
    let (client, handle, version) =
        opened.map_err(|_| AppError::new(ErrorKind::Connection, "connection timed out"))??;
    let cancel = client.cancel_token();
    Ok(Arc::new(PgSession {
        client,
        cancel,
        tls,
        lost,
        conn_task: Mutex::new(Some(handle)),
        version,
        gate: tokio::sync::RwLock::new(()),
    }))
}

impl PgSession {
    fn check(&self) -> AppResult<()> {
        if self.lost.load(Ordering::SeqCst) || self.client.is_closed() {
            return Err(AppError::new(ErrorKind::ConnectionLost, "connection lost"));
        }
        Ok(())
    }

    /// `full` keeps text and JSON values whole.
    async fn run(&self, sql: &str, full: bool) -> AppResult<(Option<ResultSet>, u64)> {
        self.check()?;
        let types: Option<Vec<(String, Type)>> = match self.client.prepare(sql).await {
            Ok(stmt) => Some(
                stmt.columns()
                    .iter()
                    .map(|c| (c.name().to_string(), c.type_().clone()))
                    .collect(),
            ),
            Err(e) => {
                if let Some(db) = e.as_db_error()
                    && *db.code() == SqlState::SYNTAX_ERROR
                {
                    // 42601 never falls back: simple_query could only succeed here for
                    // multi-command input. Keyed on SQLSTATE, so localized servers work;
                    // nothing has been executed.
                    return Err(if db.message().contains("multiple commands") {
                        AppError::new(ErrorKind::Invalid, "execute accepts exactly one statement")
                    } else {
                        map_err(e)
                    });
                }
                let err = map_err(e);
                if matches!(err.kind, ErrorKind::Cancelled | ErrorKind::ConnectionLost) {
                    return Err(err);
                }
                None // fall back to the text protocol alone
            }
        };
        // Streamed so memory stays bounded by MAX_RESULT_ROWS: rows past the cap are
        // read and discarded (the protocol must be drained to keep the session in sync);
        // a cancel still interrupts the server and surfaces as an error here.
        let stream = self.client.simple_query_raw(sql).await.map_err(map_err)?;
        let mut stream = std::pin::pin!(stream);
        let mut rows: Vec<Vec<CellValue>> = Vec::new();
        let mut names: Vec<String> = Vec::new();
        let mut affected = 0u64;
        let mut truncated = false;
        while let Some(m) = stream.next().await {
            match m.map_err(map_err)? {
                SimpleQueryMessage::Row(_) if rows.len() == MAX_RESULT_ROWS => truncated = true,
                SimpleQueryMessage::Row(r) => {
                    if names.is_empty() {
                        names = r.columns().iter().map(|c| c.name().to_string()).collect();
                    }
                    let mut out = Vec::with_capacity(r.len());
                    for i in 0..r.len() {
                        let text = r.get(i);
                        let ty = types.as_ref().and_then(|t| t.get(i)).map(|(_, t)| t);
                        out.push(match text {
                            None => CellValue::Null,
                            Some(s) => cell_from_text(ty, s, full),
                        });
                    }
                    rows.push(out);
                }
                SimpleQueryMessage::CommandComplete(n) => affected = n,
                _ => {}
            }
        }
        let has_columns = types
            .as_ref()
            .map(|t| !t.is_empty())
            .unwrap_or(!rows.is_empty());
        if !has_columns {
            return Ok((None, affected));
        }
        let columns = match &types {
            Some(t) => column_metas(t),
            None => names
                .into_iter()
                .map(|name| ColumnMeta {
                    name,
                    type_name: String::new(),
                })
                .collect(),
        };
        Ok((
            Some(ResultSet {
                columns,
                rows,
                truncated,
            }),
            affected,
        ))
    }
}

impl PgSession {
    /// A call on a live session failed: a non-server error is a lost link only when the
    /// client is closed (a parameter the server would not accept fails client-side).
    fn map_live_err(&self, e: tokio_postgres::Error) -> AppError {
        match map_db_error(&e) {
            Some(err) => err,
            None if self.client.is_closed() => {
                AppError::new(ErrorKind::ConnectionLost, e.to_string())
            }
            None => AppError::new(ErrorKind::Query, with_causes(&e)),
        }
    }

    /// Runs a parameterized statement (see the module docs for the text wrapper); `full`
    /// keeps text and JSON values whole.
    async fn query_bound(&self, stmt: &Statement, full: bool) -> AppResult<ResultSet> {
        self.check()?;
        let params = bound(stmt);
        let inner = self
            .client
            .prepare(&stmt.sql)
            .await
            .map_err(|e| self.map_live_err(e))?;
        let types: Vec<(String, Type)> = inner
            .columns()
            .iter()
            .map(|c| (c.name().to_string(), c.type_().clone()))
            .collect();
        if types.is_empty() {
            self.client
                .execute_raw(&inner, params)
                .await
                .map_err(|e| self.map_live_err(e))?;
            return Ok(ResultSet {
                columns: vec![],
                rows: vec![],
                truncated: false,
            });
        }
        let stream = self
            .client
            .query_raw(text_wrapper(&stmt.sql, types.len()).as_str(), params)
            .await
            .map_err(|e| self.map_live_err(e))?;
        let mut stream = std::pin::pin!(stream);
        let mut rows: Vec<Vec<CellValue>> = Vec::new();
        let mut truncated = false;
        while let Some(row) = stream.next().await {
            let row = row.map_err(|e| self.map_live_err(e))?;
            // Past the cap: drained so the session stays in sync (a cancel still lands).
            if rows.len() == MAX_RESULT_ROWS {
                truncated = true;
                continue;
            }
            let mut out = Vec::with_capacity(types.len());
            for (i, (_, ty)) in types.iter().enumerate() {
                let text: Option<&str> = row.try_get(i).map_err(|e| self.map_live_err(e))?;
                out.push(match text {
                    None => CellValue::Null,
                    Some(s) => cell_from_text(Some(ty), s, full),
                });
            }
            rows.push(out);
        }
        Ok(ResultSet {
            columns: column_metas(&types),
            rows,
            truncated,
        })
    }

    /// `query` / `query_full`: a statement without parameters takes the simple-query path
    /// (no text wrapper).
    async fn query_with(&self, stmt: &Statement, full: bool) -> AppResult<ResultSet> {
        let _gate = self.gate.read().await;
        if !stmt.params.is_empty() {
            return self.query_bound(stmt, full).await;
        }
        let (rs, _) = self.run(&stmt.sql, full).await?;
        Ok(rs.unwrap_or(ResultSet {
            columns: vec![],
            rows: vec![],
            truncated: false,
        }))
    }

    /// One statement of `apply`: the rows it touched.
    async fn apply_one(&self, stmt: &Statement) -> AppResult<u64> {
        self.client
            .execute_raw(stmt.sql.as_str(), bound(stmt))
            .await
            .map_err(|e| self.map_live_err(e))
    }

    /// Retried once (a late cancel may interrupt the first attempt). An open transaction
    /// must never outlive `apply`: if both attempts fail, the connection is dropped (the
    /// server aborts the transaction) and the session reports `ConnectionLost` from then on.
    async fn rollback(&self) {
        for _ in 0..2 {
            if self.client.batch_execute("ROLLBACK").await.is_ok() || self.client.is_closed() {
                return;
            }
        }
        self.drop_connection();
    }

    /// Ends the connection task (the server sees the socket close); later calls fail fast.
    fn drop_connection(&self) {
        self.lost.store(true, Ordering::SeqCst);
        if let Some(h) = self.conn_task.lock().ok().and_then(|mut g| g.take()) {
            h.abort();
        }
    }
}

fn bound(stmt: &Statement) -> Vec<&(dyn ToSql + Sync)> {
    stmt.params
        .iter()
        .map(|p| match p {
            SqlParam::Text(s) => s as &(dyn ToSql + Sync),
            SqlParam::Bytes(b) => b as &(dyn ToSql + Sync),
        })
        .collect()
}

/// `sql`'s `n` columns, each rendered as text by its type's output function.
fn text_wrapper(sql: &str, n: usize) -> String {
    let aliases: Vec<String> = (1..=n).map(|i| format!("c{i}")).collect();
    let cells: Vec<String> = aliases
        .iter()
        .map(|c| format!("CASE WHEN num_nulls(q.{c}) = 0 THEN format('%s', q.{c}) END"))
        .collect();
    // The outer query only projects: rows keep the inner ORDER BY (a plain subquery scan).
    // The SQL sits on its own lines so a trailing `--` comment cannot swallow the paren.
    format!(
        "WITH q({}) AS (\n{sql}\n) SELECT {} FROM q",
        aliases.join(", "),
        cells.join(", ")
    )
}

fn column_metas(types: &[(String, Type)]) -> Vec<ColumnMeta> {
    types
        .iter()
        .map(|(n, ty)| ColumnMeta {
            name: n.clone(),
            type_name: ty.name().to_string(),
        })
        .collect()
}

/// Re-types a PostgreSQL text-format value from its column type; `full` keeps text and
/// JSON whole.
fn cell_from_text(ty: Option<&Type>, s: &str, full: bool) -> CellValue {
    let text = || text_cell(s.to_string(), full);
    let Some(ty) = ty else {
        return text();
    };
    match *ty {
        Type::BOOL => match s {
            "t" => CellValue::Bool(true),
            "f" => CellValue::Bool(false),
            _ => text(),
        },
        Type::INT2 | Type::INT4 | Type::INT8 => {
            s.parse::<i64>().map(int_value).unwrap_or_else(|_| text())
        }
        Type::FLOAT4 | Type::FLOAT8 => s.parse::<f64>().map(float_value).unwrap_or_else(|_| text()),
        Type::NUMERIC => CellValue::Decimal(s.to_string()),
        // hex output (`bytea_output = 'hex'`): `\x` then the digits.
        Type::BYTEA => match s.strip_prefix("\\x").and_then(decode_hex) {
            Some(b) => bytes_value(&b),
            None => bytes_value(s.as_bytes()),
        },
        Type::JSON | Type::JSONB => json_cell(s.to_string(), full),
        Type::DATE
        | Type::TIME
        | Type::TIMETZ
        | Type::TIMESTAMP
        | Type::TIMESTAMPTZ
        | Type::INTERVAL => CellValue::Temporal(s.to_string()),
        _ => text(),
    }
}

/// A table or view found in the catalog.
struct PgRel {
    oid: u32,
    schema: String,
    relkind: String,
    /// `schema.name`, each part quoted only when needed (server `quote_ident`).
    qualified: String,
}

/// One column with what both `table_info` and `table_ddl` need.
struct PgColumn {
    info: ColumnInfo,
    quoted: String,
    /// `a` (ALWAYS) / `d` (BY DEFAULT) identity, else empty.
    identity: String,
    /// The generation expression of a generated column.
    generation: Option<String>,
    /// `quote_literal(comment)`.
    comment_literal: Option<String>,
}

struct PgIndex {
    info: IndexInfo,
    partial: bool,
    /// `indisvalid AND indislive`: an invalid index (e.g. left by a failed
    /// `CREATE UNIQUE INDEX CONCURRENTLY`) does not enforce uniqueness.
    valid: bool,
    /// Backs a PRIMARY KEY / UNIQUE / EXCLUDE constraint (part of the constraint's DDL).
    constraint: bool,
}

/// Keeps a constraint unless it is a per-partition copy of one declared on this same
/// table (an FK to a partitioned table has one such row per referenced partition).
const PG_OWN_CONSTRAINT: &str = "NOT EXISTS (SELECT 1 FROM pg_constraint p \
     WHERE p.oid = con.conparentid AND p.conrelid = con.conrelid)";

fn pg_action(code: &str) -> String {
    match code {
        "r" => "RESTRICT",
        "c" => "CASCADE",
        "n" => "SET NULL",
        "d" => "SET DEFAULT",
        _ => "NO ACTION",
    }
    .to_string()
}

impl PgSession {
    async fn relation(&self, obj: &ObjectRef) -> AppResult<PgRel> {
        self.check()?;
        let schema = obj.schema.clone().unwrap_or_else(|| "public".into());
        let row = self
            .client
            .query_opt(
                "SELECT c.oid, c.relkind::text, format('%I.%I', n.nspname, c.relname) \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1::text AND c.relname = $2::text \
                 AND c.relkind IN ('r', 'p', 'v', 'm')",
                &[&schema, &obj.name],
            )
            .await
            .map_err(map_err)?
            .ok_or_else(|| object_not_found(&schema, &obj.name))?;
        Ok(PgRel {
            oid: row.get(0),
            relkind: row.get(1),
            qualified: row.get(2),
            schema,
        })
    }

    async fn columns(&self, oid: u32) -> AppResult<Vec<PgColumn>> {
        let rows = self
            .client
            .query(
                "SELECT a.attname::text, quote_ident(a.attname), \
                 format_type(a.atttypid, a.atttypmod), a.attnotnull, \
                 pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, a.attgenerated::text, \
                 col_description(a.attrelid, a.attnum), \
                 quote_literal(col_description(a.attrelid, a.attnum)), \
                 format_type(a.atttypid, -1) \
                 FROM pg_attribute a \
                 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
                 WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped \
                 ORDER BY a.attnum",
                &[&oid],
            )
            .await
            .map_err(map_err)?;
        Ok(rows
            .iter()
            .map(|r| {
                let expr: Option<String> = r.get(4);
                let identity: String = r.get(5);
                let generated = !r.get::<_, String>(6).is_empty();
                let default = if generated {
                    None
                } else {
                    non_null_default(expr.clone())
                };
                let serial = default
                    .as_deref()
                    .is_some_and(|d| d.starts_with("nextval("));
                PgColumn {
                    info: ColumnInfo {
                        name: r.get(0),
                        type_name: r.get(2),
                        base_type: r.get(9),
                        nullable: !r.get::<_, bool>(3),
                        auto_increment: !identity.is_empty() || serial,
                        default,
                        generated,
                        comment: r.get(7),
                    },
                    quoted: r.get(1),
                    identity,
                    generation: if generated { expr } else { None },
                    comment_literal: r.get(8),
                }
            })
            .collect())
    }

    async fn indexes(&self, oid: u32) -> AppResult<Vec<PgIndex>> {
        let rows = self
            .client
            .query(
                "SELECT i.relname::text, ix.indisunique, ix.indisprimary, \
                 pg_get_indexdef(ix.indexrelid), ix.indpred IS NOT NULL, \
                 ARRAY(SELECT COALESCE(a.attname::text, pg_get_indexdef(ix.indexrelid, s.k, true)) \
                   FROM generate_series(1, ix.indnkeyatts::int) AS s(k) \
                   LEFT JOIN pg_attribute a ON a.attrelid = ix.indrelid \
                     AND a.attnum = ix.indkey[s.k - 1] AND a.attnum > 0 \
                   ORDER BY s.k), \
                 EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = ix.indexrelid \
                   AND con.conrelid = ix.indrelid AND con.contype IN ('p', 'u', 'x')), \
                 ix.indisvalid AND ix.indislive \
                 FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid \
                 WHERE ix.indrelid = $1",
                &[&oid],
            )
            .await
            .map_err(map_err)?;
        let mut out: Vec<PgIndex> = rows
            .iter()
            .map(|r| PgIndex {
                info: IndexInfo {
                    name: r.get(0),
                    unique: r.get(1),
                    primary: r.get(2),
                    definition: Some(r.get(3)),
                    columns: r.get(5),
                },
                partial: r.get(4),
                constraint: r.get(6),
                valid: r.get(7),
            })
            .collect();
        // Primary first, then by name (as `meta::sort_indexes`).
        out.sort_by(|a, b| {
            b.info
                .primary
                .cmp(&a.info.primary)
                .then_with(|| a.info.name.cmp(&b.info.name))
        });
        Ok(out)
    }

    async fn foreign_keys(&self, oid: u32) -> AppResult<Vec<ForeignKeyInfo>> {
        let rows = self
            .client
            .query(
                &format!(
                    "SELECT con.conname::text, \
                     ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS u(n, o) \
                       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = u.n ORDER BY u.o), \
                     rn.nspname::text, rc.relname::text, \
                     ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS u(n, o) \
                       JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = u.n ORDER BY u.o), \
                     con.confupdtype::text, con.confdeltype::text \
                     FROM pg_constraint con \
                     JOIN pg_class rc ON rc.oid = con.confrelid \
                     JOIN pg_namespace rn ON rn.oid = rc.relnamespace \
                     WHERE con.conrelid = $1 AND con.contype = 'f' AND {PG_OWN_CONSTRAINT} \
                     ORDER BY con.conname"
                ),
                &[&oid],
            )
            .await
            .map_err(map_err)?;
        Ok(rows
            .iter()
            .map(|r| ForeignKeyInfo {
                name: r.get(0),
                columns: r.get(1),
                ref_schema: Some(r.get(2)),
                ref_table: r.get(3),
                ref_columns: r.get(4),
                on_update: pg_action(r.get(5)),
                on_delete: pg_action(r.get(6)),
            })
            .collect())
    }

    async fn table_ddl_of(&self, rel: &PgRel) -> AppResult<String> {
        let oid = rel.oid;
        if rel.relkind == "v" || rel.relkind == "m" {
            let row = self
                .client
                .query_one("SELECT pg_get_viewdef($1::oid, true)", &[&oid])
                .await
                .map_err(map_err)?;
            let def: String = row.get(0);
            let what = if rel.relkind == "m" {
                "MATERIALIZED VIEW"
            } else {
                "VIEW"
            };
            return Ok(format!("CREATE {what} {} AS\n{def}", rel.qualified));
        }
        let columns = self.columns(oid).await?;
        let mut lines: Vec<String> = columns
            .iter()
            .map(|c| {
                let mut l = format!("    {} {}", c.quoted, c.info.type_name);
                if let Some(d) = &c.info.default {
                    l.push_str(&format!(" DEFAULT {d}"));
                }
                if !c.info.nullable {
                    l.push_str(" NOT NULL");
                }
                match c.identity.as_str() {
                    "a" => l.push_str(" GENERATED ALWAYS AS IDENTITY"),
                    "d" => l.push_str(" GENERATED BY DEFAULT AS IDENTITY"),
                    _ => {}
                }
                if let Some(g) = &c.generation {
                    l.push_str(&format!(" GENERATED ALWAYS AS ({g}) STORED"));
                }
                l
            })
            .collect();
        let constraints = self
            .client
            .query(
                &format!(
                    "SELECT quote_ident(con.conname), pg_get_constraintdef(con.oid, true) \
                     FROM pg_constraint con \
                     WHERE con.conrelid = $1 AND con.contype IN ('p', 'u', 'x', 'c', 'f') \
                     AND {PG_OWN_CONSTRAINT} \
                     ORDER BY CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'x' THEN 2 \
                     WHEN 'c' THEN 3 ELSE 4 END, con.conname"
                ),
                &[&oid],
            )
            .await
            .map_err(map_err)?;
        for r in &constraints {
            lines.push(format!(
                "    CONSTRAINT {} {}",
                r.get::<_, String>(0),
                r.get::<_, String>(1)
            ));
        }
        let mut ddl = format!("CREATE TABLE {} (\n{}\n)", rel.qualified, lines.join(",\n"));
        if rel.relkind == "p" {
            let row = self
                .client
                .query_one("SELECT pg_get_partkeydef($1::oid)", &[&oid])
                .await
                .map_err(map_err)?;
            if let Some(key) = row.get::<_, Option<String>>(0) {
                ddl.push_str(&format!(" PARTITION BY {key}"));
            }
        }
        ddl.push(';');
        for i in self.indexes(oid).await? {
            if let (false, Some(def)) = (i.constraint, &i.info.definition) {
                ddl.push_str(&format!("\n\n{def};"));
            }
        }
        let table_comment = self
            .client
            .query_one(
                "SELECT quote_literal(obj_description($1::oid, 'pg_class'))",
                &[&oid],
            )
            .await
            .map_err(map_err)?;
        let mut comments = Vec::new();
        if let Some(lit) = table_comment.get::<_, Option<String>>(0) {
            comments.push(format!("COMMENT ON TABLE {} IS {lit};", rel.qualified));
        }
        for c in &columns {
            if let Some(lit) = &c.comment_literal {
                comments.push(format!(
                    "COMMENT ON COLUMN {}.{} IS {lit};",
                    rel.qualified, c.quoted
                ));
            }
        }
        if !comments.is_empty() {
            ddl.push_str("\n\n");
            ddl.push_str(&comments.join("\n"));
        }
        Ok(ddl)
    }
}

#[async_trait]
impl Session for PgSession {
    fn dialect(&self) -> Dialect {
        Dialect::Postgres
    }

    fn server_version(&self) -> String {
        self.version.clone()
    }

    async fn list_schemas(&self) -> AppResult<Vec<String>> {
        let _gate = self.gate.read().await;
        self.check()?;
        let rows = self
            .client
            .query(
                "SELECT nspname::text FROM pg_namespace \
                 WHERE nspname NOT IN ('pg_catalog', 'information_schema') \
                 AND nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp\\_%' \
                 ORDER BY nspname",
                &[],
            )
            .await
            .map_err(map_err)?;
        Ok(rows.iter().map(|r| r.get::<_, String>(0)).collect())
    }

    async fn list_objects(&self, schema: Option<&str>) -> AppResult<Vec<DbObject>> {
        let _gate = self.gate.read().await;
        self.check()?;
        let schema = schema.unwrap_or("public").to_string();
        let rows = self
            .client
            .query(
                "SELECT c.relname::text, c.relkind::text FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1::text AND c.relkind IN ('r', 'p', 'v', 'm')",
                &[&schema],
            )
            .await
            .map_err(map_err)?;
        let mut out: Vec<DbObject> = rows
            .iter()
            .map(|r| {
                let kind: String = r.get(1);
                DbObject {
                    schema: Some(schema.clone()),
                    name: r.get(0),
                    kind: if kind == "v" || kind == "m" {
                        ObjectKind::View
                    } else {
                        ObjectKind::Table
                    },
                }
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    async fn query(&self, stmt: &Statement) -> AppResult<ResultSet> {
        self.query_with(stmt, false).await
    }

    async fn query_full(&self, stmt: &Statement) -> AppResult<ResultSet> {
        self.query_with(stmt, true).await
    }

    async fn apply(&self, stmts: &[Statement], expect_one: &[bool]) -> AppResult<ApplyOutcome> {
        dml::check_apply_args(stmts, expect_one)?;
        let _gate = self.gate.write().await;
        self.check()?;
        self.client
            .batch_execute("BEGIN")
            .await
            .map_err(|e| self.map_live_err(e))?;
        let mut affected = Vec::with_capacity(stmts.len());
        for (i, stmt) in stmts.iter().enumerate() {
            let result = self.apply_one(stmt).await;
            if let Err(halt) = dml::record(i, expect_one[i], result, &mut affected) {
                self.rollback().await;
                return halt.into_result();
            }
        }
        match self.client.batch_execute("COMMIT").await {
            Ok(()) => Ok(dml::applied(affected)),
            Err(e) => {
                let err = self.map_live_err(e);
                self.rollback().await;
                dml::commit_failed(affected, err)
            }
        }
    }

    async fn count_rows(&self, obj: &ObjectRef, exact_threshold: u64) -> AppResult<RowCount> {
        let _gate = self.gate.read().await;
        self.check()?;
        let q = qualified(Dialect::Postgres, obj);
        let row = self
            .client
            .query_opt(
                "SELECT c.reltuples::float8 FROM pg_class c WHERE c.oid = $1::text::regclass",
                &[&q],
            )
            .await
            .map_err(map_err)?;
        if let Some(row) = row {
            let est: f64 = row.get(0);
            // reltuples is -1 when the table was never analyzed: unknown, count exactly.
            if est > exact_threshold as f64 {
                return Ok(RowCount::Estimate(est as u64));
            }
        }
        let row = self
            .client
            .query_one(&format!("SELECT COUNT(*) FROM {q}"), &[])
            .await
            .map_err(map_err)?;
        let n: i64 = row.get(0);
        Ok(RowCount::Exact(n.max(0) as u64))
    }

    async fn table_info(&self, obj: &ObjectRef) -> AppResult<TableInfo> {
        let _gate = self.gate.read().await;
        let rel = self.relation(obj).await?;
        let columns: Vec<ColumnInfo> = self
            .columns(rel.oid)
            .await?
            .into_iter()
            .map(|c| c.info)
            .collect();
        let indexes = self.indexes(rel.oid).await?;
        let primary_key = indexes
            .iter()
            .find(|i| i.info.primary)
            .map(|i| i.info.columns.clone())
            .unwrap_or_default();
        let row_key = derive_row_key(
            &primary_key,
            indexes
                .iter()
                .filter(|i| i.valid && !i.partial)
                .map(|i| &i.info),
            &columns,
        );
        let is_view = rel.relkind == "v" || rel.relkind == "m";
        Ok(TableInfo {
            object: ObjectRef {
                schema: Some(rel.schema.clone()),
                name: obj.name.clone(),
            },
            kind: if is_view {
                ObjectKind::View
            } else {
                ObjectKind::Table
            },
            columns,
            primary_key,
            indexes: indexes.into_iter().map(|i| i.info).collect(),
            foreign_keys: self.foreign_keys(rel.oid).await?,
            row_key,
            has_rowid: false,
        })
    }

    async fn table_ddl(&self, obj: &ObjectRef) -> AppResult<String> {
        let _gate = self.gate.read().await;
        let rel = self.relation(obj).await?;
        self.table_ddl_of(&rel).await
    }

    async fn execute(&self, sql: &str) -> AppResult<StatementOutcome> {
        let _gate = self.gate.read().await;
        let start = Instant::now();
        let (result, affected) = self.run(sql, false).await?;
        Ok(StatementOutcome {
            rows_affected: if result.is_none() {
                Some(affected)
            } else {
                None
            },
            result,
            elapsed_ms: start.elapsed().as_millis() as u64,
        })
    }

    fn canceller(&self) -> Arc<dyn Canceller> {
        Arc::new(PgCanceller {
            token: self.cancel.clone(),
            tls: self.tls.clone(),
        })
    }

    async fn close(&self) -> AppResult<()> {
        self.drop_connection();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::DriverKind;
    use crate::driver::tls::SslConfig;

    #[tokio::test]
    async fn silent_server_times_out() {
        // Accepts connections and holds them open without ever answering.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let hold = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((sock, _)) = listener.accept().await {
                held.push(sock);
            }
        });
        let p = ConnectParams {
            kind: DriverKind::Postgres,
            host: "127.0.0.1".into(),
            port,
            user: "u".into(),
            password: None,
            database: None,
            sqlite_path: None,
            ssl: SslConfig {
                mode: SslMode::Disable,
                ..Default::default()
            },
            dial: None,
        };
        let start = Instant::now();
        let res = tokio::time::timeout(
            CONNECT_TIMEOUT + Duration::from_secs(5),
            connect_postgres(&p),
        )
        .await
        .expect("connect to a silent server must end on its own");
        let e = res.err().expect("a silent server must not connect");
        assert_eq!(
            (e.kind, e.message.as_str()),
            (ErrorKind::Connection, "connection timed out")
        );
        assert!(start.elapsed() >= CONNECT_TIMEOUT, "{:?}", start.elapsed());
        hold.abort();
    }

    #[test]
    fn text_wrapper_renders_every_column() {
        assert_eq!(
            text_wrapper("SELECT a, b FROM t", 2),
            "WITH q(c1, c2) AS (\nSELECT a, b FROM t\n) SELECT \
             CASE WHEN num_nulls(q.c1) = 0 THEN format('%s', q.c1) END, \
             CASE WHEN num_nulls(q.c2) = 0 THEN format('%s', q.c2) END FROM q"
        );
    }

    #[test]
    fn hex_bytea_decodes() {
        let bytea = |s| cell_from_text(Some(&Type::BYTEA), s, false);
        assert_eq!(bytea("\\x00ff"), bytes_value(&[0, 255]));
        assert_eq!(bytea("\\x"), bytes_value(&[]));
        // Not hex output: the raw text bytes.
        assert_eq!(bytea("00ff"), bytes_value(b"00ff"));
        assert_eq!(bytea("\\x0"), bytes_value(b"\\x0"));
    }

    #[test]
    fn text_is_retyped_by_column_type() {
        assert_eq!(
            cell_from_text(Some(&Type::BOOL), "f", false),
            CellValue::Bool(false)
        );
        assert_eq!(
            cell_from_text(Some(&Type::INT8), "-5", false),
            CellValue::Int(-5)
        );
        assert_eq!(
            cell_from_text(Some(&Type::INT8), "-9223372036854775808", false),
            CellValue::BigInt("-9223372036854775808".into())
        );
        assert_eq!(
            cell_from_text(Some(&Type::NUMERIC), "1.2300", false),
            CellValue::Decimal("1.2300".into())
        );
        assert_eq!(
            cell_from_text(Some(&Type::FLOAT8), "NaN", false),
            CellValue::Text("NaN".into())
        );
        assert_eq!(
            cell_from_text(Some(&Type::FLOAT8), "-Infinity", false),
            CellValue::Text("-Infinity".into())
        );
        assert_eq!(
            cell_from_text(None, "x", false),
            CellValue::Text("x".into())
        );
        assert_eq!(
            cell_from_text(Some(&Type::UUID), "u", false),
            CellValue::Text("u".into())
        );
        let long = "x".repeat(crate::value::TEXT_PREVIEW_CHARS + 1);
        assert!(matches!(
            cell_from_text(Some(&Type::TEXT), &long, false),
            CellValue::LongText { .. }
        ));
        assert_eq!(
            cell_from_text(Some(&Type::TEXT), &long, true),
            CellValue::Text(long.clone())
        );
        assert_eq!(
            cell_from_text(Some(&Type::JSONB), &long, true),
            CellValue::Json(long)
        );
    }
}

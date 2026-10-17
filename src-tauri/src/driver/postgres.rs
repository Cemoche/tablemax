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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::StreamExt;
use tokio_postgres::config::SslMode as PgSslMode;
use tokio_postgres::error::SqlState;
use tokio_postgres::tls::MakeTlsConnect;
use tokio_postgres::types::Type;
use tokio_postgres::{CancelToken, Client, Config, NoTls, SimpleQueryMessage, Socket};
use tokio_postgres_rustls::MakeRustlsConnect;

use super::sql::{build_page_query, qualified};
use super::tls::{SslMode, rustls_client_config};
use super::{
    Canceller, ColumnMeta, ConnectParams, DbObject, Dialect, ObjectKind, ObjectRef, PageRequest,
    ResultSet, RowCount, Session, StatementOutcome,
};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::value::{
    CellValue, MAX_RESULT_ROWS, bytes_value, float_value, int_value, json_value, text_value,
};

struct PgSession {
    client: Client,
    cancel: CancelToken,
    /// The connector the session was opened with (`None` = `NoTls`), reused to cancel.
    tls: Option<MakeRustlsConnect>,
    lost: Arc<AtomicBool>,
    conn_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    version: String,
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

pub async fn connect_postgres(p: &ConnectParams) -> AppResult<Arc<dyn Session>> {
    super::ensure_local_host(p)?;
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
    cfg.connect_timeout(Duration::from_secs(10));
    let lost = Arc::new(AtomicBool::new(false));
    let (client, handle) = match &tls {
        Some(tls) => open_client(&cfg, tls.clone(), lost.clone()).await?,
        None => open_client(&cfg, NoTls, lost.clone()).await?,
    };
    // The text decoders assume hex bytea output.
    let init = async {
        client
            .batch_execute("SET bytea_output = 'hex'")
            .await
            .map_err(map_err)?;
        let row = client
            .query_one("SELECT current_setting('server_version')", &[])
            .await
            .map_err(map_err)?;
        Ok::<String, AppError>(row.get(0))
    }
    .await;
    let version = match init {
        Ok(v) => v,
        Err(e) => {
            handle.abort();
            return Err(e);
        }
    };
    let cancel = client.cancel_token();
    Ok(Arc::new(PgSession {
        client,
        cancel,
        tls,
        lost,
        conn_task: Mutex::new(Some(handle)),
        version,
    }))
}

impl PgSession {
    fn check(&self) -> AppResult<()> {
        if self.lost.load(Ordering::SeqCst) || self.client.is_closed() {
            return Err(AppError::new(ErrorKind::ConnectionLost, "connection lost"));
        }
        Ok(())
    }

    async fn run(&self, sql: &str) -> AppResult<(Option<ResultSet>, u64)> {
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
                            Some(s) => cell_from_text(ty, s),
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
            Some(t) => t
                .iter()
                .map(|(n, ty)| ColumnMeta {
                    name: n.clone(),
                    type_name: ty.name().to_string(),
                })
                .collect(),
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

fn decode_hex(s: &str) -> Option<Vec<u8>> {
    let h = s.strip_prefix("\\x")?;
    if h.len() % 2 != 0 || !h.is_ascii() {
        return None;
    }
    (0..h.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&h[i..i + 2], 16).ok())
        .collect()
}

/// Re-types a PostgreSQL text-format value from its column type.
fn cell_from_text(ty: Option<&Type>, s: &str) -> CellValue {
    let Some(ty) = ty else {
        return text_value(s.to_string());
    };
    match *ty {
        Type::BOOL => match s {
            "t" => CellValue::Bool(true),
            "f" => CellValue::Bool(false),
            _ => text_value(s.to_string()),
        },
        Type::INT2 | Type::INT4 | Type::INT8 => s
            .parse::<i64>()
            .map(int_value)
            .unwrap_or_else(|_| text_value(s.to_string())),
        Type::FLOAT4 | Type::FLOAT8 => s
            .parse::<f64>()
            .map(float_value)
            .unwrap_or_else(|_| text_value(s.to_string())),
        Type::NUMERIC => CellValue::Decimal(s.to_string()),
        Type::BYTEA => match decode_hex(s) {
            Some(b) => bytes_value(&b),
            None => bytes_value(s.as_bytes()),
        },
        Type::JSON | Type::JSONB => json_value(s.to_string()),
        Type::DATE
        | Type::TIME
        | Type::TIMETZ
        | Type::TIMESTAMP
        | Type::TIMESTAMPTZ
        | Type::INTERVAL => CellValue::Temporal(s.to_string()),
        _ => text_value(s.to_string()),
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

    async fn fetch_page(&self, req: &PageRequest) -> AppResult<ResultSet> {
        let sql = build_page_query(Dialect::Postgres, req);
        let (rs, _) = self.run(&sql).await?;
        rs.ok_or_else(|| AppError::new(ErrorKind::Query, "page query returned no result set"))
    }

    async fn count_rows(&self, obj: &ObjectRef, exact_threshold: u64) -> AppResult<RowCount> {
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

    async fn execute(&self, sql: &str) -> AppResult<StatementOutcome> {
        let start = Instant::now();
        let (result, affected) = self.run(sql).await?;
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
        self.lost.store(true, Ordering::SeqCst);
        if let Some(h) = self.conn_task.lock().ok().and_then(|mut g| g.take()) {
            h.abort();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_bytea_decodes() {
        assert_eq!(decode_hex("\\x00ff"), Some(vec![0, 255]));
        assert_eq!(decode_hex("\\x"), Some(vec![]));
        assert_eq!(decode_hex("00ff"), None);
        assert_eq!(decode_hex("\\x0"), None);
    }

    #[test]
    fn text_is_retyped_by_column_type() {
        assert_eq!(
            cell_from_text(Some(&Type::BOOL), "f"),
            CellValue::Bool(false)
        );
        assert_eq!(cell_from_text(Some(&Type::INT8), "-5"), CellValue::Int(-5));
        assert_eq!(
            cell_from_text(Some(&Type::INT8), "-9223372036854775808"),
            CellValue::BigInt("-9223372036854775808".into())
        );
        assert_eq!(
            cell_from_text(Some(&Type::NUMERIC), "1.2300"),
            CellValue::Decimal("1.2300".into())
        );
        assert_eq!(
            cell_from_text(Some(&Type::FLOAT8), "NaN"),
            CellValue::Text("NaN".into())
        );
        assert_eq!(
            cell_from_text(Some(&Type::FLOAT8), "-Infinity"),
            CellValue::Text("-Infinity".into())
        );
        assert_eq!(cell_from_text(None, "x"), CellValue::Text("x".into()));
        assert_eq!(
            cell_from_text(Some(&Type::UUID), "u"),
            CellValue::Text("u".into())
        );
    }
}

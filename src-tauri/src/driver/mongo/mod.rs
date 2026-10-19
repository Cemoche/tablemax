//! MongoDB driver (official `mongodb` crate, rustls + ring): a database is a TableMax
//! schema, a collection a table, a view a view. Read only.
//!
//! Cancel: every call of a session races its session's cancel signal, so `canceller()`
//! returns at once from whatever is in flight (`Cancelled`; the abandoned operation's
//! connection is dropped by the driver). Reads that can run long carry a `maxTimeMS`, so
//! nothing abandoned keeps running on the server.

pub mod options;

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::time::Duration;

use async_trait::async_trait;
use mongodb::bson::{Document, doc};
use mongodb::results::CollectionType;
use mongodb::{Client, Database};
use tokio::sync::Notify;

use super::catalog::{Catalog, CatalogTable};
use super::{
    AnySession, Canceller, ConnectParams, DbObject, DocumentSession, ObjectKind, ObjectRef,
    RowCount, SessionBase,
};
use crate::error::{AppError, AppResult, ErrorKind};

/// Lowest wire version the driver speaks: MongoDB 4.4.
pub const MIN_WIRE_VERSION: i32 = 9;
/// Server-side bound of a count on a view (`count_documents` runs the view's pipeline).
const VIEW_COUNT_MAX_TIME: Duration = Duration::from_secs(60);
/// MongoDB error codes this driver branches on.
const UNAUTHORIZED: i32 = 13;
const AUTHENTICATION_FAILED: i32 = 18;

fn too_old(found: Option<i64>) -> AppError {
    let found = found.map_or_else(String::new, |v| format!(" (it reports wire version {v})"));
    AppError::new(
        ErrorKind::Connection,
        format!("MongoDB 4.4 or newer is required: this server is older{found}"),
    )
}

/// Refuses a server older than MongoDB 4.4 from its `hello` reply (`maxWireVersion`).
pub fn check_hello(hello: &Document) -> AppResult<()> {
    let max = match hello.get("maxWireVersion") {
        Some(mongodb::bson::Bson::Int32(v)) => Some(i64::from(*v)),
        Some(mongodb::bson::Bson::Int64(v)) => Some(*v),
        Some(mongodb::bson::Bson::Double(v)) => Some(*v as i64),
        _ => None,
    };
    match max {
        Some(v) if v >= i64::from(MIN_WIRE_VERSION) => Ok(()),
        other => Err(too_old(other)),
    }
}

/// A server selection timeout's message cut down to why the last server could not be used
/// (bad certificate, refused connection...), without the topology dump.
fn selection_message(message: &str) -> String {
    const CAUSE: &str = "Error: Kind: ";
    match message.find(CAUSE) {
        Some(i) => {
            let cause = &message[i + CAUSE.len()..];
            let cause = cause.find(", labels:").map_or(cause, |j| &cause[..j]);
            format!("cannot reach the server: {cause}")
        }
        None => message.to_string(),
    }
}

/// The message of a driver error without its debug wrapping (labels, sources).
fn describe(e: &mongodb::error::Error) -> String {
    use mongodb::error::ErrorKind as K;
    match e.kind.as_ref() {
        K::Command(c) => format!("{} ({})", c.message, c.code_name),
        K::ServerSelection { message, .. } => selection_message(message),
        kind => kind.to_string(),
    }
}

/// The driver refused the server for its version (see `compatibility_error_message` in
/// the crate).
fn is_too_old(message: &str) -> bool {
    message.contains("driver requires at least")
}

/// A driver error as an `AppError`. `connected`: the session was open, so a network
/// failure means the connection was lost (the manager then rebuilds it).
fn map_error(e: &mongodb::error::Error, connected: bool) -> AppError {
    use mongodb::error::ErrorKind as K;
    let message = describe(e);
    if is_too_old(&message) {
        return too_old(None);
    }
    let network = if connected {
        ErrorKind::ConnectionLost
    } else {
        ErrorKind::Connection
    };
    let kind = match e.kind.as_ref() {
        K::Authentication { .. } => ErrorKind::Auth,
        K::Command(c) if c.code == AUTHENTICATION_FAILED => ErrorKind::Auth,
        K::Command(_) | K::Write(_) | K::BulkWrite(_) | K::InsertMany(_) => ErrorKind::Query,
        K::InvalidArgument { .. } | K::InvalidTlsConfig { .. } => ErrorKind::Invalid,
        K::Io(_)
        | K::ServerSelection { .. }
        | K::ConnectionPoolCleared { .. }
        | K::DnsResolve { .. }
        | K::Shutdown => network,
        _ => ErrorKind::Query,
    };
    AppError::new(kind, message)
}

/// `map_error` for a connection attempt, through [`withhold_if_password`].
fn map_connect_error(e: &mongodb::error::Error, password: Option<&str>) -> AppError {
    withhold_if_password(map_error(e, false), password)
}

/// Defence in depth: the driver never puts the password in a message, so a message that
/// contains it does so by coincidence (password `admin`, "not authorized on admin").
/// Substituting it would point at the password; the whole message is replaced instead,
/// by a generic one of the same kind.
fn withhold_if_password(err: AppError, password: Option<&str>) -> AppError {
    match password {
        Some(p) if !p.is_empty() && err.message.contains(p) => {
            let message = match err.kind {
                ErrorKind::Auth => "authentication failed",
                _ => "cannot connect to the MongoDB server",
            };
            AppError::new(err.kind, message)
        }
        _ => err,
    }
}

fn cancelled() -> AppError {
    AppError::new(ErrorKind::Cancelled, "query cancelled")
}

fn closed() -> AppError {
    AppError::new(ErrorKind::ConnectionLost, "the connection is closed")
}

/// Opens a MongoDB session: client options (see `options`), then `hello` (reachability,
/// authentication, version ≥ 4.4) and `buildInfo` (version string).
pub async fn connect_mongo(p: &ConnectParams) -> AppResult<AnySession> {
    let opts = options::client_options(p).await?;
    let client = Client::with_options(opts).map_err(|e| map_connect_error(&e, None))?;
    let admin = client.database("admin");
    let password = p.password.as_deref();
    let version = async {
        let hello = admin
            .run_command(doc! { "hello": 1 })
            .await
            .map_err(|e| map_connect_error(&e, password))?;
        check_hello(&hello)?;
        let info = admin
            .run_command(doc! { "buildInfo": 1 })
            .await
            .map_err(|e| map_connect_error(&e, password))?;
        Ok::<_, AppError>(info.get_str("version").unwrap_or("unknown").to_string())
    }
    .await;
    let version = match version {
        Ok(v) => v,
        Err(e) => {
            client.shutdown().immediate(true).await;
            return Err(e);
        }
    };
    let database = p
        .database
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(String::from);
    Ok(AnySession::Documents(Arc::new(MongoSession {
        client,
        version,
        database,
        cancel: Arc::new(Notify::new()),
        closed: AtomicBool::new(false),
    })))
}

pub struct MongoSession {
    client: Client,
    version: String,
    /// The connection's database: listed when the user may not list databases, and the
    /// one `list_objects(None)` reads.
    database: Option<String>,
    /// Woken by the canceller: every call in flight returns `Cancelled`.
    cancel: Arc<Notify>,
    closed: AtomicBool,
}

struct MongoCanceller(Arc<Notify>);

#[async_trait]
impl Canceller for MongoCanceller {
    async fn cancel(&self) -> AppResult<()> {
        self.0.notify_waiters();
        Ok(())
    }
}

impl MongoSession {
    /// Runs `fut` unless the session is closed, giving up with `Cancelled` when the
    /// canceller fires meanwhile.
    async fn run<T, F>(&self, fut: F) -> AppResult<T>
    where
        F: Future<Output = AppResult<T>>,
    {
        if self.closed.load(SeqCst) {
            return Err(closed());
        }
        // Created before the call starts: `notify_waiters` reaches it from now on.
        let cancel = self.cancel.notified();
        tokio::select! {
            biased;
            _ = cancel => Err(cancelled()),
            r = fut => r,
        }
    }

    fn db(&self, schema: Option<&str>) -> Option<Database> {
        schema
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or(self.database.as_deref())
            .map(|name| self.client.database(name))
    }

    fn db_of(&self, obj: &ObjectRef) -> AppResult<Database> {
        self.db(obj.schema.as_deref())
            .ok_or_else(|| AppError::new(ErrorKind::Invalid, "no database selected"))
    }

    /// Collections and views of `db` (no `system.*`), sorted by name. A user who may not
    /// list them in full gets the names it is authorized on, as collections.
    async fn objects(&self, db: &Database) -> AppResult<Vec<(String, ObjectKind)>> {
        let full = async {
            let mut cursor = db.list_collections().await?;
            let mut out = Vec::new();
            while cursor.advance().await? {
                let spec = cursor.deserialize_current()?;
                let kind = match spec.collection_type {
                    CollectionType::View => ObjectKind::View,
                    _ => ObjectKind::Table,
                };
                out.push((spec.name, kind));
            }
            Ok::<_, mongodb::error::Error>(out)
        }
        .await;
        let mut out = match full {
            Ok(out) => out,
            Err(e) if is_unauthorized(&e) => db
                .list_collection_names()
                .authorized_collections(true)
                .await
                .map_err(|e| map_error(&e, true))?
                .into_iter()
                .map(|n| (n, ObjectKind::Table))
                .collect(),
            Err(e) => return Err(map_error(&e, true)),
        };
        out.retain(|(name, _)| !name.starts_with("system."));
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }

    /// Whether `obj` is a view (`NotFound` when it does not exist).
    async fn is_view(&self, db: &Database, obj: &ObjectRef) -> AppResult<bool> {
        let mut cursor = db
            .list_collections()
            .filter(doc! { "name": obj.name.as_str() })
            .await
            .map_err(|e| map_error(&e, true))?;
        if !cursor.advance().await.map_err(|e| map_error(&e, true))? {
            return Err(AppError::new(
                ErrorKind::NotFound,
                format!("collection {} not found", obj.name),
            ));
        }
        let spec = cursor
            .deserialize_current()
            .map_err(|e| map_error(&e, true))?;
        Ok(spec.collection_type == CollectionType::View)
    }
}

fn is_unauthorized(e: &mongodb::error::Error) -> bool {
    matches!(e.kind.as_ref(), mongodb::error::ErrorKind::Command(c) if c.code == UNAUTHORIZED)
}

#[async_trait]
impl SessionBase for MongoSession {
    fn server_version(&self) -> String {
        self.version.clone()
    }

    /// The databases the user may see (`authorizedDatabases`), plus the connection's
    /// own; only the latter when listing is refused.
    async fn list_schemas(&self) -> AppResult<Vec<String>> {
        let listed = self
            .run(async {
                self.client
                    .list_database_names()
                    .authorized_databases(true)
                    .await
                    .map_err(|e| map_error(&e, true))
            })
            .await;
        let mut names = match listed {
            Ok(names) => names,
            Err(e) if matches!(e.kind, ErrorKind::Cancelled | ErrorKind::ConnectionLost) => {
                return Err(e);
            }
            Err(_) => Vec::new(),
        };
        if let Some(db) = &self.database
            && !names.contains(db)
        {
            names.push(db.clone());
        }
        names.sort();
        Ok(names)
    }

    async fn list_objects(&self, schema: Option<&str>) -> AppResult<Vec<DbObject>> {
        let Some(db) = self.db(schema) else {
            return Ok(Vec::new());
        };
        let objects = self.run(self.objects(&db)).await?;
        let schema = Some(db.name().to_string());
        Ok(objects
            .into_iter()
            .map(|(name, kind)| DbObject {
                schema: schema.clone(),
                name,
                kind,
            })
            .collect())
    }

    /// A collection: the server's estimate (collection metadata). A view: its documents,
    /// counted up to `exact_threshold + 1`; above the threshold an estimate.
    async fn count_rows(&self, obj: &ObjectRef, exact_threshold: u64) -> AppResult<RowCount> {
        let db = self.db_of(obj)?;
        self.run(async {
            let coll = db.collection::<Document>(&obj.name);
            if !self.is_view(&db, obj).await? {
                let n = coll
                    .estimated_document_count()
                    .await
                    .map_err(|e| map_error(&e, true))?;
                return Ok(RowCount::Estimate(n));
            }
            let n = coll
                .count_documents(doc! {})
                .limit(exact_threshold.saturating_add(1))
                .max_time(VIEW_COUNT_MAX_TIME)
                .await
                .map_err(|e| map_error(&e, true))?;
            Ok(if n > exact_threshold {
                RowCount::Estimate(exact_threshold)
            } else {
                RowCount::Exact(n)
            })
        })
        .await
    }

    fn canceller(&self) -> Arc<dyn Canceller> {
        Arc::new(MongoCanceller(self.cancel.clone()))
    }

    async fn close(&self) -> AppResult<()> {
        if self.closed.swap(true, SeqCst) {
            return Ok(());
        }
        self.cancel.notify_waiters();
        self.client.clone().shutdown().immediate(true).await;
        Ok(())
    }

    fn is_lost(&self) -> bool {
        self.closed.load(SeqCst)
    }

    /// Collections and views without columns (documents have no fixed fields).
    async fn catalog(&self, schema: Option<&str>) -> AppResult<Catalog> {
        let Some(db) = self.db(schema) else {
            return Ok(Catalog {
                schema: None,
                tables: Vec::new(),
            });
        };
        let objects = self.run(self.objects(&db)).await?;
        Ok(Catalog {
            schema: Some(db.name().to_string()),
            tables: objects
                .into_iter()
                .map(|(name, kind)| CatalogTable {
                    name,
                    kind,
                    columns: Vec::new(),
                })
                .collect(),
        })
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        self.list_schemas().await
    }
}

impl DocumentSession for MongoSession {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_too_old_is_explained() {
        for hello in [
            doc! { "isWritablePrimary": true, "maxWireVersion": 8 },
            doc! { "isWritablePrimary": true, "maxWireVersion": 6_i64 },
            doc! { "isWritablePrimary": true },
        ] {
            let e = check_hello(&hello).unwrap_err();
            assert_eq!(e.kind, ErrorKind::Connection);
            assert!(e.message.contains("MongoDB 4.4 or newer"), "{}", e.message);
        }
        assert!(check_hello(&doc! { "maxWireVersion": 9 }).is_ok());
        assert!(check_hello(&doc! { "maxWireVersion": 21 }).is_ok());
    }

    #[test]
    fn driver_errors_have_short_messages() {
        let selection = "Server selection timeout: No available servers. Topology: { Type: \
                         Single, Servers: [ { Address: localhost:1, Type: Unknown, Error: \
                         Kind: I/O error: invalid peer certificate: UnknownIssuer, labels: {}, \
                         source: None } ] }";
        assert_eq!(
            selection_message(selection),
            "cannot reach the server: I/O error: invalid peer certificate: UnknownIssuer"
        );
        assert_eq!(selection_message("no servers"), "no servers");
        assert!(is_too_old(
            "Server at h:1 reports wire version 8, but this version of the MongoDB Rust \
             driver requires at least 9 (MongoDB 4.4)."
        ));
        assert!(!is_too_old("Authentication failed."));
    }

    #[test]
    fn a_message_containing_the_password_is_withheld_whole() {
        let err = AppError::new(
            ErrorKind::Query,
            "not authorized on admin to execute command { hello: 1 }",
        );
        let out = withhold_if_password(err, Some("admin"));
        assert_eq!(out.kind, ErrorKind::Query);
        assert_eq!(out.message, "cannot connect to the MongoDB server");
        assert!(!out.message.contains("<redacted>"));
        assert!(!out.message.contains("admin"));

        let auth = AppError::new(
            ErrorKind::Auth,
            "SCRAM failure for user a: Authentication failed.",
        );
        let out = withhold_if_password(auth, Some("a"));
        assert_eq!(out.kind, ErrorKind::Auth);
        assert_eq!(out.message, "authentication failed");

        // No password, an empty one, or no match: the message is kept as is.
        for pw in [None, Some(""), Some("s3cret-pw")] {
            let err = AppError::new(ErrorKind::Connection, "cannot reach the server: refused");
            let out = withhold_if_password(err, pw);
            assert_eq!(out.message, "cannot reach the server: refused", "{pw:?}");
        }
    }

    #[tokio::test]
    async fn cancel_reaches_a_call_in_flight() {
        let notify = Arc::new(Notify::new());
        let canceller = MongoCanceller(notify.clone());
        let cancel = notify.notified();
        let pending = async {
            tokio::select! {
                biased;
                _ = cancel => Err::<(), _>(cancelled()),
                _ = std::future::pending::<()>() => Ok(()),
            }
        };
        let (r, c) = tokio::join!(pending, canceller.cancel());
        c.unwrap();
        assert_eq!(r.unwrap_err().kind, ErrorKind::Cancelled);
    }
}

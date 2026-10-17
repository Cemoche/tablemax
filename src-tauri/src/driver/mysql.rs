//! MySQL / MariaDB driver on `mysql_async`, TLS through its rustls backend.
//!
//! TLS: `SslOpts` are derived from the connection's `SslConfig` (see `ssl_opts`). `Prefer`
//! retries in cleartext only when the server does not offer TLS at all; `VerifyCa` is
//! refused before any I/O (mysql_async 0.37.1 cannot skip only the name check). With
//! `dial`, TCP goes to that address and `host` becomes the TLS name. The canceller keeps
//! the options the session actually connected with (same address, same TLS).
//!
//! The `Conn` lives behind an async mutex, so `canceller()` (which never touches it) works
//! while `execute` is in flight. Cancellation opens a NEW connection with the same
//! parameters and runs `KILL QUERY <connection id>`; the password is kept in memory only,
//! inside the canceller, and never logged.
//!
//! Result decoding: statements run through `query_iter` (text protocol), so every value
//! arrives as the server's canonical text bytes (exact DECIMAL, JSON, dates...). Values are
//! re-typed from the column type, UNSIGNED flag and character set (63 = binary).
//! Non-UTF-8 text falls back to `bytes_value`; TINYINT(1) stays Int; BIT is bytes; YEAR is
//! Temporal. MariaDB has no JSON column type (LONGTEXT + CHECK json_valid) and mysql_async
//! cannot negotiate extended metadata, so JSON columns are recovered from
//! information_schema.CHECK_CONSTRAINTS (cached per table, cleared on DDL).
//!
//! Cancellation quirk: an interrupted `SELECT SLEEP()` returns a normal result, not error
//! 1317; a cancel that lands during a row-returning statement is reported as Cancelled.
//!
//! Single statement only: `mysql_async` always advertises CLIENT_MULTI_STATEMENTS and it
//! cannot be turned off, so `execute` first runs a small SQL lexer (`has_multiple_statements`)
//! that sees through string literals, quoted identifiers and comments, and rejects any
//! input with more than one statement as `Invalid` BEFORE anything reaches the server.
//! Executable comments (`/*! ... */`, `/*M! ... */`) are scanned as code since the server
//! runs their content. The lexer follows the session's `sql_mode` (NO_BACKSLASH_ESCAPES,
//! ANSI_QUOTES): it is read at connect and re-read after EVERY statement (success or
//! error), since a prepared or comment-wrapped statement can change it without any
//! visible keyword; if that re-read fails while the link is up, the session state is
//! unknown and every statement is refused until a re-read succeeds. The lexer reads the
//! text as UTF-8 (what the driver sends): when the session's client character set is one
//! whose multi-byte characters can end with an ASCII byte such as `\` (big5, cp932,
//! gb18030, gbk, sjis), the server would tokenize differently, so every statement is
//! refused until the user switches back (an ASCII-only `SET …` is still accepted for
//! that). The client charset is read and re-read with sql_mode, in the same query.
//! Dollar-quoted bodies (`AS $$ … $$`, MySQL 9 JavaScript routines) are refused too: the
//! lexer does not see through them.
//! Compound statements (`CREATE PROCEDURE/FUNCTION/TRIGGER/EVENT … BEGIN … END`, MariaDB
//! `BEGIN NOT ATOMIC … END`) are one statement: the `;` inside their body do not count.
//! The body tracker is conservative (see `Compound`): when in doubt it refuses, and an
//! executable comment disables it. The client-side `DELIMITER` command never reaches the
//! driver: the frontend splitter (`splitStatements`) handles it.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::prelude::{FromRow, Queryable};
use mysql_async::{
    ClientIdentity, Column, Conn, DriverError, Error as MyError, Opts, OptsBuilder, Row, SslOpts,
    Value,
};

use super::catalog::{Catalog, CatalogColumn, DbRoutine, RoutineKind, group_rows};
use super::sql::{build_page_query, qualified};
use super::tls::{SslConfig, SslMode, load_files, native_roots};
use super::{
    Canceller, ColumnMeta, ConnectParams, DbObject, Dialect, ObjectKind, ObjectRef, PageRequest,
    ResultSet, RowCount, Session, StatementOutcome,
};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::value::{
    CellValue, MAX_RESULT_ROWS, bytes_value, float_value, int_value, json_value, text_value,
};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const BINARY_CHARSET: u16 = 63;
const HIDDEN_SCHEMAS: [&str; 4] = ["mysql", "information_schema", "performance_schema", "sys"];

/// SQL-mode flags that change how the server tokenizes string literals.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Modes {
    /// Backslash escapes inside '...' and "..." (off under NO_BACKSLASH_ESCAPES).
    backslash_escapes: bool,
    /// "..." is an identifier (never has backslash escapes).
    ansi_quotes: bool,
}

impl Modes {
    fn from_sql_mode(mode: &str) -> Self {
        let has = |f: &str| mode.split(',').any(|m| m.trim().eq_ignore_ascii_case(f));
        Modes {
            backslash_escapes: !has("NO_BACKSLASH_ESCAPES"),
            ansi_quotes: has("ANSI_QUOTES"),
        }
    }
}

/// Client character sets in which the trailing byte of a multi-byte character can be an
/// ASCII byte (0x5C `\`, a quote…): the server would not split such text where the
/// UTF-8 lexer does.
const UNSAFE_CLIENT_CHARSETS: [&str; 5] = ["big5", "cp932", "gb18030", "gbk", "sjis"];

/// The charset's name when it is one of [`UNSAFE_CLIENT_CHARSETS`].
fn unsafe_client_charset(charset: Option<&str>) -> Option<String> {
    let cs = charset?.trim().to_ascii_lowercase();
    UNSAFE_CLIENT_CHARSETS.contains(&cs.as_str()).then_some(cs)
}

struct Inner {
    conn: Option<Conn>,
    modes: Modes,
    /// The session's client character set when it is unsafe for the lexer (see
    /// [`UNSAFE_CLIENT_CHARSETS`]); `None` when it is safe.
    unsafe_charset: Option<String>,
    /// The last re-read of the modes failed (link still up): `modes` and
    /// `unsafe_charset` may be stale, so statements are refused until a re-read works.
    modes_unknown: bool,
    /// MariaDB only: (database, table) -> columns constrained by `json_valid(...)`.
    json_cache: HashMap<(String, String), HashSet<String>>,
}

struct MySession {
    inner: tokio::sync::Mutex<Inner>,
    lost: AtomicBool,
    canceller: Arc<MyCanceller>,
    version: String,
    mariadb: bool,
}

struct MyCanceller {
    opts: Opts,
    conn_id: u32,
    /// A statement is in flight on the session.
    running: AtomicBool,
    /// Sequence number of the current/last statement (bumped by `run`).
    seq: AtomicU64,
    /// Sequence of the statement a successful `KILL QUERY` was delivered for.
    cancelled_seq: AtomicU64,
}

#[async_trait]
impl Canceller for MyCanceller {
    async fn cancel(&self) -> AppResult<()> {
        if !self.running.load(Ordering::SeqCst) {
            return Ok(());
        }
        let target = self.seq.load(Ordering::SeqCst);
        let mut conn = open_conn(&self.opts).await?;
        let res = conn
            .query_drop(format!("KILL QUERY {}", self.conn_id))
            .await
            .map_err(|e| map_err(&e, false));
        let _ = conn.disconnect().await;
        // Recorded only once the KILL was delivered, tagged with the statement it targeted.
        if res.is_ok() {
            self.cancelled_seq.store(target, Ordering::SeqCst);
        }
        res
    }
}

/// Maps an error. `live` = the error happened on an established session, so a transport
/// failure means the link is gone (ConnectionLost) rather than a failed connect attempt.
fn map_err(e: &MyError, live: bool) -> AppError {
    match e {
        MyError::Server(se) => {
            let kind = match se.code {
                1045 => ErrorKind::Auth,
                1317 => ErrorKind::Cancelled,
                1049 => ErrorKind::NotFound,
                // 1053 server shutdown, 1927 MariaDB "Connection was killed",
                // 4031 MySQL 8 "disconnected by the server because of inactivity".
                2002 | 2003 | 2013 | 2006 | 1053 | 1927 | 4031 => ErrorKind::ConnectionLost,
                _ => ErrorKind::Query,
            };
            AppError::new(kind, se.message.clone())
        }
        MyError::Io(_) | MyError::Driver(mysql_async::DriverError::ConnectionClosed) => {
            AppError::new(
                if live {
                    ErrorKind::ConnectionLost
                } else {
                    ErrorKind::Connection
                },
                e.to_string(),
            )
        }
        MyError::Driver(_) => AppError::new(
            if live {
                ErrorKind::Query
            } else {
                ErrorKind::Connection
            },
            e.to_string(),
        ),
        _ => AppError::new(ErrorKind::Connection, e.to_string()),
    }
}

/// Fallible row conversion: `mysql_async`'s typed helpers (`exec::<T>`, `query_first::<T>`,
/// `collect::<T>`) call `from_row`, which panics on an unexpected value. The message never
/// includes the row (it may carry data).
fn from_rows<T: FromRow>(rows: Vec<Row>) -> AppResult<Vec<T>> {
    rows.into_iter()
        .map(|r| {
            T::from_row_opt(r).map_err(|_| {
                AppError::new(ErrorKind::Query, "unexpected value type in a metadata row")
            })
        })
        .collect()
}

/// The session's sql_mode flags and its unsafe client character set, if any.
async fn read_session_modes(conn: &mut Conn) -> Result<(Modes, Option<String>), AppError> {
    let row: Option<Row> = conn
        .query_first::<Row, _>("SELECT @@SESSION.sql_mode, @@SESSION.character_set_client")
        .await
        .map_err(|e| map_err(&e, true))?;
    let rows: Vec<(Option<String>, Option<String>)> = from_rows(row.into_iter().collect())?;
    let (mode, charset) = rows.into_iter().next().unwrap_or_default();
    Ok((
        Modes::from_sql_mode(&mode.unwrap_or_default()),
        unsafe_client_charset(charset.as_deref()),
    ))
}

/// First column of the first row as text (`None` for no row or NULL), without panicking.
async fn query_first_string(conn: &mut Conn, sql: &str) -> Result<Option<String>, AppError> {
    let row: Option<Row> = conn
        .query_first::<Row, _>(sql)
        .await
        .map_err(|e| map_err(&e, true))?;
    let rows: Vec<(Option<String>,)> = from_rows(row.into_iter().collect())?;
    Ok(rows.into_iter().next().and_then(|r| r.0))
}

/// `SslOpts` for `ssl` (`None` = cleartext). `tls_name` overrides the name checked
/// against the certificate (the real host when TCP goes to a `dial` address).
fn ssl_opts(ssl: &SslConfig, tls_name: Option<&str>) -> AppResult<Option<SslOpts>> {
    match ssl.mode {
        SslMode::Disable => return Ok(None),
        SslMode::VerifyCa => {
            return Err(AppError::new(
                ErrorKind::Invalid,
                "verify-ca is not supported for MySQL yet; use verify-full or require",
            ));
        }
        SslMode::Prefer | SslMode::Require | SslMode::VerifyFull => {}
    }
    let files = load_files(ssl)?;
    let mut o = SslOpts::default();
    if let Some(ca) = files.ca {
        o = o
            .with_root_certs(vec![ca.into()])
            .with_disable_built_in_roots(true);
    } else if ssl.mode == SslMode::VerifyFull {
        // Same roots as PostgreSQL: the OS store, else mysql_async's bundled Mozilla roots.
        let native: Vec<_> = native_roots()
            .into_iter()
            .map(|c| c.as_ref().to_vec().into())
            .collect();
        if !native.is_empty() {
            o = o.with_root_certs(native).with_disable_built_in_roots(true);
        }
    }
    if let Some((cert, key)) = files.identity {
        o = o.with_client_identity(Some(ClientIdentity::new(cert.into(), key.into())));
    }
    if matches!(ssl.mode, SslMode::Prefer | SslMode::Require) {
        o = o.with_danger_accept_invalid_certs(true);
    }
    Ok(Some(o.with_danger_tls_hostname_override(
        tls_name.map(str::to_string),
    )))
}

fn build_opts(p: &ConnectParams) -> AppResult<Opts> {
    let (addr, port, tls_name) = match p.dial {
        Some(dial) => (dial.ip().to_string(), dial.port(), Some(p.host.as_str())),
        None => (p.host.clone(), p.port, None),
    };
    Ok(OptsBuilder::default()
        .ip_or_hostname(addr)
        .tcp_port(port)
        .user(Some(p.user.clone()))
        .pass(p.password.clone())
        .db_name(p.database.clone())
        // Never silently swap the TCP endpoint for a unix socket reported by the server.
        .prefer_socket(false)
        .ssl_opts(ssl_opts(&p.ssl, tls_name)?)
        .into())
}

/// Connects; the outer error is the timeout, the inner one the driver's.
async fn try_conn(opts: &Opts) -> AppResult<Result<Conn, MyError>> {
    tokio::time::timeout(CONNECT_TIMEOUT, Conn::new(opts.clone()))
        .await
        .map_err(|_| AppError::new(ErrorKind::Connection, "connection timed out"))
}

async fn open_conn(opts: &Opts) -> AppResult<Conn> {
    try_conn(opts).await?.map_err(|e| map_err(&e, false))
}

/// Opens the session connection and returns it with the options that worked: under
/// `Prefer`, a server without TLS support gets a second, cleartext attempt.
async fn open_session_conn(opts: Opts, mode: SslMode) -> AppResult<(Conn, Opts)> {
    match try_conn(&opts).await? {
        Ok(conn) => Ok((conn, opts)),
        Err(MyError::Driver(DriverError::NoClientSslFlagFromServer)) if mode == SslMode::Prefer => {
            let plain: Opts = OptsBuilder::from_opts(opts)
                .ssl_opts(None::<SslOpts>)
                .into();
            Ok((open_conn(&plain).await?, plain))
        }
        Err(e) => Err(map_err(&e, false)),
    }
}

pub async fn connect_mysql(p: &ConnectParams) -> AppResult<Arc<dyn Session>> {
    let (mut conn, opts) = open_session_conn(build_opts(p)?, p.ssl.mode).await?;
    let version = match query_first_string(&mut conn, "SELECT VERSION()").await {
        Ok(v) => v,
        Err(e) => {
            let _ = conn.disconnect().await;
            return Err(e);
        }
    };
    let conn_id = conn.id();
    let version = version.unwrap_or_default();
    let (modes, unsafe_charset) = match read_session_modes(&mut conn).await {
        Ok(v) => v,
        Err(e) => {
            let _ = conn.disconnect().await;
            return Err(e);
        }
    };
    // The canceller must keep working if the selected database is dropped.
    let cancel_opts: Opts = OptsBuilder::from_opts(opts).db_name(None::<String>).into();
    Ok(Arc::new(MySession {
        mariadb: version.contains("MariaDB"),
        inner: tokio::sync::Mutex::new(Inner {
            conn: Some(conn),
            json_cache: HashMap::new(),
            modes,
            unsafe_charset,
            modes_unknown: false,
        }),
        lost: AtomicBool::new(false),
        canceller: Arc::new(MyCanceller {
            opts: cancel_opts,
            conn_id,
            running: AtomicBool::new(false),
            seq: AtomicU64::new(0),
            cancelled_seq: AtomicU64::new(0),
        }),
        version,
    }))
}

/// One significant token of the multi-statement lexer: whitespace and comments are not
/// tokens; strings and quoted identifiers are `Lit`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Tok<'a> {
    Word(&'a str),
    Punct(u8),
    Lit,
}

impl Tok<'_> {
    fn is(&self, kw: &str) -> bool {
        matches!(self, Tok::Word(w) if w.eq_ignore_ascii_case(kw))
    }
    fn is_any(&self, kws: &[&str]) -> bool {
        kws.iter().any(|k| self.is(k))
    }
}

/// Splits `sql` into tokens, seeing through '...', "...", `...`, `-- `, `#` and `/* */`
/// (honouring NO_BACKSLASH_ESCAPES / ANSI_QUOTES). The content of executable comments
/// (`/*! ... */`, `/*M! ... */`) is code; the flag tells whether one was seen.
fn lex(sql: &str, modes: Modes) -> (Vec<Tok<'_>>, bool) {
    let b = sql.as_bytes();
    let n = b.len();
    let mut out = Vec::new();
    let mut i = 0;
    let mut in_exec_comment = false;
    let mut saw_exec_comment = false;
    let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80;
    while i < n {
        let c = b[i];
        if c.is_ascii_whitespace() {
            i += 1;
            continue;
        }
        if in_exec_comment && b[i..].starts_with(b"*/") {
            in_exec_comment = false;
            i += 2;
            continue;
        }
        if c == b'#'
            || (b[i..].starts_with(b"--")
                && b.get(i + 2)
                    .is_none_or(|x| x.is_ascii_whitespace() || x.is_ascii_control()))
        {
            while i < n && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b[i..].starts_with(b"/*") {
            if b[i..].starts_with(b"/*!") {
                in_exec_comment = true;
                saw_exec_comment = true;
                i += 3;
            } else if b[i..].starts_with(b"/*M!") {
                in_exec_comment = true;
                saw_exec_comment = true;
                i += 4;
            } else {
                i += 2;
                while i < n && !b[i..].starts_with(b"*/") {
                    i += 1;
                }
                i += 2;
            }
            continue;
        }
        match c {
            b'\'' | b'"' | b'`' => {
                i += 1;
                while i < n {
                    let escapes =
                        modes.backslash_escapes && c != b'`' && !(c == b'"' && modes.ansi_quotes);
                    if b[i] == b'\\' && escapes {
                        i += 2;
                    } else if b[i] == c {
                        if b.get(i + 1) == Some(&c) {
                            i += 2;
                        } else {
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
                i += 1;
                out.push(Tok::Lit);
            }
            _ if is_word(c) => {
                let start = i;
                while i < n && is_word(b[i]) {
                    i += 1;
                }
                // Word bytes are ASCII or whole UTF-8 sequences (>= 0x80), so the slice is
                // on char boundaries.
                out.push(Tok::Word(&sql[start..i]));
            }
            _ => {
                out.push(Tok::Punct(c));
                i += 1;
            }
        }
    }
    (out, saw_exec_comment)
}

/// Open compound constructs of a stored-program body.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Frame {
    Block,
    If,
    CaseStmt,
    Loop,
    While,
    Repeat,
}

/// What ends the expression being skipped.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Until {
    Then,
    Do,
    When,
    EndRepeat,
}

/// Position inside a compound body.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    /// The next token starts a statement.
    StmtStart,
    /// Right after a block's BEGIN (MariaDB may add NOT ATOMIC).
    AfterBegin,
    ExpectAtomic,
    /// A plain word at a statement start: a label if `:` follows, else a statement.
    PendingWord,
    /// After `label:`: BEGIN, LOOP, WHILE or REPEAT must follow.
    Label,
    /// Inside a non-compound statement: everything up to its `;` is ignored.
    Ordinary,
    /// Skipping a condition / operand up to THEN, DO, WHEN or END REPEAT; CASE … END
    /// expressions inside are counted.
    Expr {
        until: Until,
        case_depth: u32,
    },
    /// END at a statement start: the next token says what it closes.
    EndPending,
    /// END inside UNTIL …: must be END REPEAT.
    EndRepeatPending,
    /// After the END of a construct: an optional label, then `;` (or the end of input).
    AfterClose {
        label_allowed: bool,
    },
    DeclareStart,
    DeclareKind,
    DeclareFor,
    Cond,
    CondSqlstate {
        value_seen: bool,
    },
    CondNot,
    CondDone,
}

/// Routine header (after CREATE … PROCEDURE/FUNCTION), up to the first body token.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Hdr {
    Name,
    Params(u32),
    Chars,
    Returns,
    TypeAfterName,
    TypeParen(u32),
    TypeName,
    CharacterSet,
    ExpectLit,
    /// Keywords still expected: (first alternatives, then optionally one more keyword).
    Expect(&'static [&'static str], Option<&'static [&'static str]>),
}

/// Trigger header: `… FOR EACH ROW [{FOLLOWS|PRECEDES} name]`, then the body.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TrigHdr {
    Scan(u8),
    AfterRow,
    OrderName,
    BodyNext,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Start,
    AfterCreate,
    Routine(Hdr),
    Trigger(TrigHdr),
    /// Event header; true once DO was seen (the next token starts the body).
    Event(bool),
    BeginNot,
    BeginAtomic,
    Body,
    Plain,
}

/// Objects that never take a `BEGIN … END` body: a `CREATE` naming one is plain.
const PLAIN_CREATE: [&str; 13] = [
    "TABLE",
    "VIEW",
    "INDEX",
    "DATABASE",
    "SCHEMA",
    "USER",
    "ROLE",
    "SERVER",
    "TABLESPACE",
    "LOGFILE",
    "SEQUENCE",
    "PACKAGE",
    "RESOURCE",
];

/// Type attributes allowed after `RETURNS <type> [(…)]`.
const TYPE_MODS: [&str; 7] = [
    "UNSIGNED", "SIGNED", "ZEROFILL", "BINARY", "ASCII", "UNICODE", "BYTE",
];

/// Words that are never the first word of a plain statement in a body.
const CONTROL: [&str; 8] = [
    "END", "ELSE", "ELSEIF", "WHEN", "UNTIL", "THEN", "DO", "DECLARE",
];

/// Follows the compound statement the tokens belong to (`CREATE PROCEDURE/FUNCTION/
/// TRIGGER/EVENT` whose body is a compound statement, MariaDB `BEGIN NOT ATOMIC … END`),
/// so that the `;` inside its body are not statement ends.
///
/// The server ends the CREATE at the end of the body statement; the tracker must never
/// believe a body is still open when the server has ended it, or a following statement
/// would run unseen. So it models where a statement STARTS: the body starts at the first
/// token after the routine characteristics / `FOR EACH ROW [FOLLOWS|PRECEDES x]` / event
/// `DO`; inside, a statement starts after `;`, BEGIN, `label:`, THEN, ELSE, DO (WHILE),
/// LOOP, REPEAT and a handler's condition list. Only a BEGIN/IF/CASE/LOOP/WHILE/REPEAT in
/// that position opens a construct (BEGIN and END are not reserved words: `select begin`
/// is a column), only an END there closes one, and it must close the innermost
/// construct (END IF, END CASE…). A body that does not start with a compound statement
/// is a plain statement. Words after `.`, `@` or `@@` are identifiers. Anything else
/// unexpected sets `refuse` (fail closed).
struct Compound {
    phase: Phase,
    mode: Mode,
    stack: Vec<Frame>,
    after_ident_marker: bool,
    absorbed: bool,
    refuse: bool,
}

impl Compound {
    fn new(enabled: bool) -> Self {
        Compound {
            phase: if enabled { Phase::Start } else { Phase::Plain },
            mode: Mode::StmtStart,
            stack: Vec::new(),
            after_ident_marker: false,
            absorbed: false,
            refuse: false,
        }
    }

    /// Feeds one token other than `;`.
    fn feed(&mut self, tok: Tok<'_>) {
        // A word right after `.` or `@` is an identifier (`t.case`, `@begin`, `@@x`).
        let ident = self.after_ident_marker;
        self.after_ident_marker = matches!(tok, Tok::Punct(b'.' | b'@'));
        self.step(tok, ident);
    }

    fn step(&mut self, tok: Tok<'_>, ident: bool) {
        match self.phase {
            Phase::Start => {
                self.phase = if tok.is("CREATE") {
                    Phase::AfterCreate
                } else if tok.is("BEGIN") {
                    Phase::BeginNot
                } else {
                    Phase::Plain
                };
            }
            Phase::BeginNot => {
                self.phase = if tok.is("NOT") {
                    Phase::BeginAtomic
                } else {
                    Phase::Plain
                };
            }
            Phase::BeginAtomic => {
                if tok.is("ATOMIC") {
                    self.phase = Phase::Body;
                    self.stack.push(Frame::Block);
                    self.mode = Mode::StmtStart;
                } else {
                    self.phase = Phase::Plain;
                }
            }
            Phase::AfterCreate => {
                if tok.is_any(&["PROCEDURE", "FUNCTION"]) {
                    self.phase = Phase::Routine(Hdr::Name);
                } else if tok.is("TRIGGER") {
                    self.phase = Phase::Trigger(TrigHdr::Scan(0));
                } else if tok.is("EVENT") {
                    self.phase = Phase::Event(false);
                } else if tok.is_any(&PLAIN_CREATE) {
                    self.phase = Phase::Plain;
                }
            }
            Phase::Routine(h) => self.routine(h, tok),
            Phase::Trigger(h) => self.trigger(h, tok),
            Phase::Event(false) => {
                if tok.is("DO") {
                    self.phase = Phase::Event(true);
                }
            }
            Phase::Event(true) => self.start_body(tok),
            Phase::Body => self.body(tok, ident),
            Phase::Plain => {}
        }
    }

    fn start_body(&mut self, tok: Tok<'_>) {
        self.phase = Phase::Body;
        self.mode = Mode::StmtStart;
        self.stmt_start(tok);
    }

    fn routine(&mut self, h: Hdr, tok: Tok<'_>) {
        let set = |s: &mut Self, h: Hdr| s.phase = Phase::Routine(h);
        match h {
            Hdr::Name => {
                if tok == Tok::Punct(b'(') {
                    set(self, Hdr::Params(1));
                }
            }
            Hdr::Params(d) => match tok {
                Tok::Punct(b'(') => set(self, Hdr::Params(d + 1)),
                Tok::Punct(b')') if d == 1 => set(self, Hdr::Chars),
                Tok::Punct(b')') => set(self, Hdr::Params(d - 1)),
                _ => {}
            },
            Hdr::Returns => match tok {
                Tok::Word(_) => set(self, Hdr::TypeAfterName),
                _ => self.phase = Phase::Plain,
            },
            Hdr::TypeAfterName => {
                if tok == Tok::Punct(b'(') {
                    set(self, Hdr::TypeParen(1));
                } else if tok.is_any(&["CHARSET", "COLLATE"]) {
                    set(self, Hdr::TypeName);
                } else if tok.is("CHARACTER") {
                    set(self, Hdr::CharacterSet);
                } else if !tok.is_any(&TYPE_MODS) {
                    self.chars(tok);
                }
            }
            Hdr::TypeParen(d) => match tok {
                Tok::Punct(b'(') => set(self, Hdr::TypeParen(d + 1)),
                Tok::Punct(b')') if d == 1 => set(self, Hdr::TypeAfterName),
                Tok::Punct(b')') => set(self, Hdr::TypeParen(d - 1)),
                _ => {}
            },
            Hdr::TypeName => match tok {
                Tok::Word(_) | Tok::Lit => set(self, Hdr::TypeAfterName),
                _ => self.phase = Phase::Plain,
            },
            Hdr::CharacterSet => {
                if tok.is("SET") {
                    set(self, Hdr::TypeName);
                } else {
                    self.phase = Phase::Plain;
                }
            }
            Hdr::ExpectLit => {
                if tok == Tok::Lit {
                    set(self, Hdr::Chars);
                } else {
                    self.phase = Phase::Plain;
                }
            }
            Hdr::Expect(now, then) => {
                if !tok.is_any(now) {
                    self.phase = Phase::Plain;
                } else if let Some(next) = then {
                    set(self, Hdr::Expect(next, None));
                } else {
                    set(self, Hdr::Chars);
                }
            }
            Hdr::Chars => self.chars(tok),
        }
    }

    /// Routine characteristics; the first other token starts the body.
    fn chars(&mut self, tok: Tok<'_>) {
        let next = if tok.is("RETURNS") {
            Hdr::Returns
        } else if tok.is("COMMENT") {
            Hdr::ExpectLit
        } else if tok.is("LANGUAGE") || tok.is("CONTAINS") || tok.is("NO") {
            Hdr::Expect(&["SQL"], None)
        } else if tok.is("NOT") {
            Hdr::Expect(&["DETERMINISTIC"], None)
        } else if tok.is("DETERMINISTIC") {
            Hdr::Chars
        } else if tok.is_any(&["READS", "MODIFIES"]) {
            Hdr::Expect(&["SQL"], Some(&["DATA"]))
        } else if tok.is("SQL") {
            Hdr::Expect(&["SECURITY"], Some(&["DEFINER", "INVOKER"]))
        } else {
            return self.start_body(tok);
        };
        self.phase = Phase::Routine(next);
    }

    fn trigger(&mut self, h: TrigHdr, tok: Tok<'_>) {
        let set = |s: &mut Self, h: TrigHdr| s.phase = Phase::Trigger(h);
        match h {
            TrigHdr::Scan(seen) => {
                let want = ["FOR", "EACH", "ROW"][seen as usize];
                if tok.is(want) {
                    set(
                        self,
                        if seen == 2 {
                            TrigHdr::AfterRow
                        } else {
                            TrigHdr::Scan(seen + 1)
                        },
                    );
                } else {
                    set(self, TrigHdr::Scan(u8::from(tok.is("FOR"))));
                }
            }
            TrigHdr::AfterRow => {
                if tok.is_any(&["FOLLOWS", "PRECEDES"]) {
                    set(self, TrigHdr::OrderName);
                } else {
                    self.start_body(tok);
                }
            }
            TrigHdr::OrderName => match tok {
                Tok::Word(_) | Tok::Lit => set(self, TrigHdr::BodyNext),
                _ => self.phase = Phase::Plain,
            },
            TrigHdr::BodyNext => self.start_body(tok),
        }
    }

    fn top(&self) -> Option<Frame> {
        self.stack.last().copied()
    }

    /// A token at a statement start (the stack may be empty: the routine body itself).
    fn stmt_start(&mut self, tok: Tok<'_>) {
        let root = self.stack.is_empty();
        if !matches!(tok, Tok::Word(_)) {
            // `(select 1)` or a stray token: a plain body, or not understood inside one.
            if root {
                self.phase = Phase::Plain;
            } else {
                self.refuse = true;
            }
            return;
        }
        let top = self.top();
        let (frame, mode) = if tok.is("BEGIN") {
            (Some(Frame::Block), Mode::AfterBegin)
        } else if tok.is("IF") {
            (
                Some(Frame::If),
                Mode::Expr {
                    until: Until::Then,
                    case_depth: 0,
                },
            )
        } else if tok.is("CASE") {
            (
                Some(Frame::CaseStmt),
                Mode::Expr {
                    until: Until::When,
                    case_depth: 0,
                },
            )
        } else if tok.is("LOOP") {
            (Some(Frame::Loop), Mode::StmtStart)
        } else if tok.is("WHILE") {
            (
                Some(Frame::While),
                Mode::Expr {
                    until: Until::Do,
                    case_depth: 0,
                },
            )
        } else if tok.is("REPEAT") {
            (Some(Frame::Repeat), Mode::StmtStart)
        } else if root {
            // The body is a plain statement (or `label:` before a compound one).
            if tok.is_any(&CONTROL) {
                self.phase = Phase::Plain;
            } else {
                self.mode = Mode::PendingWord;
            }
            return;
        } else if tok.is("DECLARE") {
            (None, Mode::DeclareStart)
        } else if tok.is("END") {
            (None, Mode::EndPending)
        } else if tok.is("ELSEIF") && top == Some(Frame::If) {
            (
                None,
                Mode::Expr {
                    until: Until::Then,
                    case_depth: 0,
                },
            )
        } else if tok.is("ELSE") && matches!(top, Some(Frame::If | Frame::CaseStmt)) {
            (None, Mode::StmtStart)
        } else if tok.is("WHEN") && top == Some(Frame::CaseStmt) {
            (
                None,
                Mode::Expr {
                    until: Until::Then,
                    case_depth: 0,
                },
            )
        } else if tok.is("UNTIL") && top == Some(Frame::Repeat) {
            (
                None,
                Mode::Expr {
                    until: Until::EndRepeat,
                    case_depth: 0,
                },
            )
        } else if tok.is_any(&CONTROL) {
            self.refuse = true;
            return;
        } else {
            (None, Mode::PendingWord)
        };
        if let Some(f) = frame {
            self.stack.push(f);
        }
        self.mode = mode;
    }

    fn body(&mut self, tok: Tok<'_>, ident: bool) {
        match self.mode {
            Mode::StmtStart => self.stmt_start(tok),
            Mode::AfterBegin => {
                if tok == Tok::Punct(b':') {
                    // `begin: …`: a label named begin, not worth the ambiguity.
                    self.refuse = true;
                } else if tok.is("NOT") {
                    self.mode = Mode::ExpectAtomic;
                } else {
                    self.mode = Mode::StmtStart;
                    self.stmt_start(tok);
                }
            }
            Mode::ExpectAtomic => {
                if tok.is("ATOMIC") {
                    self.mode = Mode::StmtStart;
                } else {
                    self.refuse = true;
                }
            }
            Mode::PendingWord => {
                if tok == Tok::Punct(b':') {
                    self.mode = Mode::Label;
                } else if self.stack.is_empty() {
                    self.phase = Phase::Plain;
                } else {
                    self.mode = Mode::Ordinary;
                }
            }
            Mode::Label => {
                if tok.is_any(&["BEGIN", "LOOP", "WHILE", "REPEAT"]) {
                    self.stmt_start(tok);
                } else {
                    self.refuse = true;
                }
            }
            Mode::Ordinary => {}
            Mode::Expr { until, case_depth } => {
                if ident {
                    return;
                }
                let expr = |d| Mode::Expr {
                    until,
                    case_depth: d,
                };
                if tok.is("CASE") {
                    self.mode = expr(case_depth + 1);
                } else if tok.is("END") {
                    if case_depth > 0 {
                        self.mode = expr(case_depth - 1);
                    } else if until == Until::EndRepeat {
                        self.mode = Mode::EndRepeatPending;
                    } else {
                        self.refuse = true;
                    }
                } else if case_depth > 0 {
                    // THEN / WHEN / ELSE of a CASE expression.
                } else if tok.is("THEN") && until == Until::Then {
                    self.mode = Mode::StmtStart;
                } else if tok.is("WHEN") && until == Until::When {
                    self.mode = expr_then();
                } else if tok.is("DO") && until == Until::Do {
                    self.mode = Mode::StmtStart;
                } else if tok.is_any(&["THEN", "WHEN", "DO"]) {
                    self.refuse = true;
                }
            }
            Mode::EndRepeatPending => {
                if tok.is("REPEAT") && self.top() == Some(Frame::Repeat) {
                    self.close(true);
                } else {
                    self.refuse = true;
                }
            }
            Mode::EndPending => {
                let ok = match self.top() {
                    Some(Frame::Block) => !tok.is_any(&["IF", "CASE", "LOOP", "WHILE", "REPEAT"]),
                    Some(Frame::If) => tok.is("IF"),
                    Some(Frame::CaseStmt) => tok.is("CASE"),
                    Some(Frame::Loop) => tok.is("LOOP"),
                    Some(Frame::While) => tok.is("WHILE"),
                    Some(Frame::Repeat) | None => false,
                };
                if !ok {
                    self.refuse = true;
                    return;
                }
                if self.top() == Some(Frame::Block) {
                    // `END label`: the label is this token.
                    self.close(true);
                    self.body(tok, ident);
                } else {
                    let label = matches!(self.top(), Some(Frame::Loop | Frame::While));
                    self.close(label);
                }
            }
            Mode::AfterClose { label_allowed } => {
                if label_allowed && matches!(tok, Tok::Word(_)) {
                    self.mode = Mode::AfterClose {
                        label_allowed: false,
                    };
                } else {
                    self.refuse = true;
                }
            }
            Mode::DeclareStart => {
                self.mode = if tok.is_any(&["CONTINUE", "EXIT", "UNDO"]) {
                    Mode::DeclareKind
                } else {
                    Mode::Ordinary
                };
            }
            Mode::DeclareKind => {
                self.mode = if tok.is("HANDLER") {
                    Mode::DeclareFor
                } else {
                    Mode::Ordinary
                };
            }
            Mode::DeclareFor => {
                if tok.is("FOR") {
                    self.mode = Mode::Cond;
                } else {
                    self.refuse = true;
                }
            }
            Mode::Cond => {
                if tok.is("SQLSTATE") {
                    self.mode = Mode::CondSqlstate { value_seen: false };
                } else if tok.is("NOT") {
                    self.mode = Mode::CondNot;
                } else if matches!(tok, Tok::Word(_)) {
                    self.mode = Mode::CondDone;
                } else {
                    self.refuse = true;
                }
            }
            Mode::CondSqlstate { value_seen } => {
                if !value_seen && tok.is("VALUE") {
                    self.mode = Mode::CondSqlstate { value_seen: true };
                } else if tok == Tok::Lit {
                    self.mode = Mode::CondDone;
                } else {
                    self.refuse = true;
                }
            }
            Mode::CondNot => {
                if tok.is("FOUND") {
                    self.mode = Mode::CondDone;
                } else {
                    self.refuse = true;
                }
            }
            Mode::CondDone => {
                if tok == Tok::Punct(b',') {
                    self.mode = Mode::Cond;
                } else {
                    // The handler's statement.
                    self.mode = Mode::StmtStart;
                    self.stmt_start(tok);
                }
            }
        }
    }

    /// Pops the innermost construct; an optional label and `;` follow.
    fn close(&mut self, label_allowed: bool) {
        self.stack.pop();
        self.mode = Mode::AfterClose { label_allowed };
    }

    /// A `;`: true when it is inside the compound body (not a statement end).
    fn semi(&mut self) -> bool {
        if self.phase != Phase::Body {
            return false;
        }
        self.after_ident_marker = false;
        let inside = match self.mode {
            Mode::StmtStart | Mode::AfterBegin => !self.stack.is_empty(),
            Mode::PendingWord if self.stack.is_empty() => {
                self.phase = Phase::Plain;
                false
            }
            Mode::PendingWord | Mode::Ordinary => true,
            Mode::EndPending if self.top() == Some(Frame::Block) => {
                self.stack.pop();
                !self.stack.is_empty()
            }
            Mode::AfterClose { .. } => !self.stack.is_empty(),
            _ => {
                self.refuse = true;
                false
            }
        };
        if inside {
            self.mode = Mode::StmtStart;
            self.absorbed = true;
        } else if !self.refuse && self.phase == Phase::Body {
            self.mode = Mode::AfterClose {
                label_allowed: false,
            };
        }
        inside
    }

    /// End of input: false when the input cannot be trusted to be one statement.
    fn finish(&mut self) -> bool {
        if self.refuse {
            return false;
        }
        if self.phase == Phase::Body
            && self.mode == Mode::EndPending
            && self.top() == Some(Frame::Block)
        {
            self.stack.pop();
        }
        // A body still open after swallowing a `;`: refuse (fail closed).
        !(self.absorbed && self.phase == Phase::Body && !self.stack.is_empty())
    }
}

const fn expr_then() -> Mode {
    Mode::Expr {
        until: Until::Then,
        case_depth: 0,
    }
}

/// True when `sql` holds more than one statement (a `;` followed by anything other than
/// whitespace or comments). Sees through '...', "...", `...`, `-- `, `#` and `/* */`,
/// honouring the session's NO_BACKSLASH_ESCAPES / ANSI_QUOTES modes. The `;` inside the
/// body of a compound statement (`CREATE PROCEDURE/FUNCTION/TRIGGER/EVENT … BEGIN … END`,
/// MariaDB `BEGIN NOT ATOMIC … END`) do not count, see [`Compound`].
fn has_multiple_statements(sql: &str, modes: Modes) -> bool {
    let (toks, exec_comment) = lex(sql, modes);
    let mut compound = Compound::new(!exec_comment);
    let mut seen_semi = false;
    for tok in toks {
        // A real token: anything after a top-level ';' makes this a multi-statement input.
        if seen_semi {
            return true;
        }
        if tok == Tok::Punct(b';') {
            if !compound.semi() {
                seen_semi = true;
            }
        } else {
            compound.feed(tok);
        }
        if compound.refuse {
            return true;
        }
    }
    !compound.finish()
}

/// True when `sql` holds a dollar-quote word (`$$`, `$tag$…`): MySQL 9 reads a body
/// between such quotes (JavaScript routines) that the lexer cannot see through.
fn has_dollar_quote(sql: &str, modes: Modes) -> bool {
    lex(sql, modes).0.into_iter().any(|t| match t {
        Tok::Word(w) => w.strip_prefix('$').is_some_and(|rest| rest.contains('$')),
        _ => false,
    })
}

/// Why `sql` must not be sent, checked before anything reaches the server: an unsafe
/// client character set (only an ASCII-only `SET …` passes, to switch back), a
/// dollar-quoted body, or more than one statement.
fn refusal(
    sql: &str,
    modes: Modes,
    unsafe_charset: Option<&str>,
    modes_unknown: bool,
) -> Option<AppError> {
    if modes_unknown {
        return Some(AppError::new(
            ErrorKind::Invalid,
            "session state could not be verified: reconnect",
        ));
    }
    if let Some(cs) = unsafe_charset
        && !(sql.is_ascii() && first_word(sql) == "set")
    {
        return Some(AppError::new(
            ErrorKind::Invalid,
            format!("client character set {cs} is not supported: use SET NAMES utf8mb4"),
        ));
    }
    if has_dollar_quote(sql, modes) {
        return Some(AppError::new(
            ErrorKind::Invalid,
            "dollar-quoted bodies are not supported",
        ));
    }
    if has_multiple_statements(sql, modes) {
        return Some(AppError::new(
            ErrorKind::Invalid,
            "execute accepts exactly one statement",
        ));
    }
    None
}

fn type_name(col: &Column) -> String {
    use ColumnType::*;
    let unsigned = col.flags().contains(ColumnFlags::UNSIGNED_FLAG);
    let binary = col.character_set() == BINARY_CHARSET;
    let base = match col.column_type() {
        MYSQL_TYPE_TINY => "tinyint",
        MYSQL_TYPE_SHORT => "smallint",
        MYSQL_TYPE_INT24 => "mediumint",
        MYSQL_TYPE_LONG => "int",
        MYSQL_TYPE_LONGLONG => "bigint",
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => "decimal",
        MYSQL_TYPE_FLOAT => "float",
        MYSQL_TYPE_DOUBLE => "double",
        MYSQL_TYPE_NULL => "null",
        MYSQL_TYPE_TIMESTAMP | MYSQL_TYPE_TIMESTAMP2 => "timestamp",
        MYSQL_TYPE_DATE | MYSQL_TYPE_NEWDATE => "date",
        MYSQL_TYPE_TIME | MYSQL_TYPE_TIME2 => "time",
        MYSQL_TYPE_DATETIME | MYSQL_TYPE_DATETIME2 => "datetime",
        MYSQL_TYPE_YEAR => "year",
        MYSQL_TYPE_BIT => "bit",
        MYSQL_TYPE_JSON => "json",
        MYSQL_TYPE_ENUM => "enum",
        MYSQL_TYPE_SET => "set",
        MYSQL_TYPE_GEOMETRY => "geometry",
        MYSQL_TYPE_TINY_BLOB => {
            if binary {
                "tinyblob"
            } else {
                "tinytext"
            }
        }
        MYSQL_TYPE_MEDIUM_BLOB => {
            if binary {
                "mediumblob"
            } else {
                "mediumtext"
            }
        }
        MYSQL_TYPE_LONG_BLOB => {
            if binary {
                "longblob"
            } else {
                "longtext"
            }
        }
        MYSQL_TYPE_BLOB => {
            if binary {
                "blob"
            } else {
                "text"
            }
        }
        MYSQL_TYPE_VARCHAR | MYSQL_TYPE_VAR_STRING => {
            if binary {
                "varbinary"
            } else {
                "varchar"
            }
        }
        MYSQL_TYPE_STRING => {
            if col.flags().contains(ColumnFlags::ENUM_FLAG) {
                "enum"
            } else if col.flags().contains(ColumnFlags::SET_FLAG) {
                "set"
            } else if binary {
                "binary"
            } else {
                "char"
            }
        }
        _ => "unknown",
    };
    if unsigned && base.ends_with("int") {
        format!("{base} unsigned")
    } else {
        base.to_string()
    }
}

/// Re-types one text-protocol value from its column metadata.
fn cell_from_value(col: &Column, v: &Value, force_json: bool) -> CellValue {
    let bytes = match v {
        Value::NULL => return CellValue::Null,
        Value::Bytes(b) => b,
        // The text protocol only yields Bytes/NULL; stay total for anything else.
        Value::Int(i) => return int_value(*i),
        Value::UInt(u) => {
            return i64::try_from(*u)
                .map(int_value)
                .unwrap_or_else(|_| CellValue::BigInt(u.to_string()));
        }
        Value::Float(f) => return float_value(f64::from(*f)),
        Value::Double(f) => return float_value(*f),
        other => return CellValue::Temporal(other.as_sql(true).trim_matches('\'').to_string()),
    };
    use ColumnType::*;
    let as_str = || std::str::from_utf8(bytes).ok();
    if force_json && let Some(s) = as_str() {
        return json_value(s.to_string());
    }
    match col.column_type() {
        MYSQL_TYPE_TINY | MYSQL_TYPE_SHORT | MYSQL_TYPE_INT24 | MYSQL_TYPE_LONG
        | MYSQL_TYPE_LONGLONG => match as_str() {
            Some(s) => match s.parse::<i64>() {
                Ok(i) => int_value(i),
                // BIGINT UNSIGNED above i64::MAX: keep the exact digits.
                Err(_) if s.parse::<u64>().is_ok() => CellValue::BigInt(s.to_string()),
                Err(_) => text_value(s.to_string()),
            },
            None => bytes_value(bytes),
        },
        MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL => match as_str() {
            Some(s) => CellValue::Decimal(s.to_string()),
            None => bytes_value(bytes),
        },
        MYSQL_TYPE_FLOAT | MYSQL_TYPE_DOUBLE => match as_str() {
            Some(s) => s
                .parse::<f64>()
                .map(float_value)
                .unwrap_or_else(|_| text_value(s.to_string())),
            None => bytes_value(bytes),
        },
        MYSQL_TYPE_JSON => match as_str() {
            Some(s) => json_value(s.to_string()),
            None => bytes_value(bytes),
        },
        MYSQL_TYPE_BIT | MYSQL_TYPE_GEOMETRY => bytes_value(bytes),
        MYSQL_TYPE_DATE
        | MYSQL_TYPE_NEWDATE
        | MYSQL_TYPE_TIME
        | MYSQL_TYPE_TIME2
        | MYSQL_TYPE_DATETIME
        | MYSQL_TYPE_DATETIME2
        | MYSQL_TYPE_TIMESTAMP
        | MYSQL_TYPE_TIMESTAMP2
        | MYSQL_TYPE_YEAR => match as_str() {
            Some(s) => CellValue::Temporal(s.to_string()),
            None => bytes_value(bytes),
        },
        // Strings, enums, sets, blobs: charset 63 means binary, anything else is text.
        _ => {
            if col.character_set() == BINARY_CHARSET {
                bytes_value(bytes)
            } else {
                match as_str() {
                    Some(s) => text_value(s.to_string()),
                    None => bytes_value(bytes),
                }
            }
        }
    }
}

/// The first word of `sql`, lower-cased ("" when it starts with something else).
fn first_word(sql: &str) -> String {
    sql.trim_start()
        .split(|c: char| !c.is_ascii_alphabetic())
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

/// Applies the result of a re-read of the session modes to the session state. A failed
/// re-read leaves the state unknown (fail closed); only a lost link is returned, for the
/// caller to report.
fn absorb_reread(
    inner: &mut Inner,
    reread: Result<(Modes, Option<String>), AppError>,
) -> AppResult<()> {
    match reread {
        Ok((modes, charset)) => {
            inner.modes = modes;
            inner.unsafe_charset = charset;
            inner.modes_unknown = false;
            Ok(())
        }
        Err(e) if e.kind == ErrorKind::ConnectionLost => Err(e),
        Err(_) => {
            inner.modes_unknown = true;
            Ok(())
        }
    }
}

fn is_ddl(sql: &str) -> bool {
    matches!(
        first_word(sql).as_str(),
        "create" | "alter" | "drop" | "rename"
    )
}

/// Column names constrained by `json_valid(`col`)` in a CHECK clause.
fn json_columns_in(clause: &str, out: &mut HashSet<String>) {
    let mut rest = clause;
    while let Some(i) = rest.find("json_valid(`") {
        rest = &rest[i + "json_valid(`".len()..];
        if let Some(end) = rest.find("`)") {
            out.insert(rest[..end].replace("``", "`"));
            rest = &rest[end..];
        }
    }
}

impl MySession {
    fn gone() -> AppError {
        AppError::new(ErrorKind::ConnectionLost, "connection lost")
    }

    fn note_loss(&self, e: &AppError) {
        if e.kind == ErrorKind::ConnectionLost {
            self.lost.store(true, Ordering::SeqCst);
        }
    }

    /// Runs one statement under the connection lock. Returns (result set, rows affected).
    async fn run(&self, sql: &str) -> AppResult<(Option<ResultSet>, u64)> {
        if self.lost.load(Ordering::SeqCst) {
            return Err(Self::gone());
        }
        let mut guard = self.inner.lock().await;
        let inner = &mut *guard;
        // An earlier re-read failed: try again before deciding anything.
        if inner.modes_unknown
            && let Some(conn) = inner.conn.as_mut()
        {
            let reread = read_session_modes(conn).await;
            if let Err(e) = absorb_reread(inner, reread) {
                self.note_loss(&e);
                return Err(e);
            }
        }
        // Checked under the lock: `modes` and the charset reflect every earlier statement.
        if let Some(e) = refusal(
            sql,
            inner.modes,
            inner.unsafe_charset.as_deref(),
            inner.modes_unknown,
        ) {
            return Err(e);
        }
        let Some(conn) = inner.conn.as_mut() else {
            return Err(Self::gone());
        };
        if is_ddl(sql) {
            inner.json_cache.clear();
        }
        let my_seq = self.canceller.seq.fetch_add(1, Ordering::SeqCst) + 1;
        self.canceller.running.store(true, Ordering::SeqCst);
        let out = Self::run_on(conn, &mut inner.json_cache, self.mariadb, sql).await;
        self.canceller.running.store(false, Ordering::SeqCst);
        let was_cancelled = self.canceller.cancelled_seq.load(Ordering::SeqCst) == my_seq;
        // After EVERY statement, success or error: a prepared, comment-wrapped or
        // dynamically built statement can change sql_mode or the client charset without
        // any keyword to spot. One cheap round trip.
        let link_lost = matches!(&out, Err(e) if e.kind == ErrorKind::ConnectionLost);
        if !link_lost {
            let reread = read_session_modes(conn).await;
            if let Err(err) = absorb_reread(inner, reread) {
                self.note_loss(&err);
                return Err(err);
            }
        }
        match out {
            Err(e) => {
                self.note_loss(&e);
                Err(e)
            }
            // MySQL/MariaDB answer an interrupted `SELECT SLEEP()` (and similar) with a
            // normal result instead of error 1317. A cancel that landed while a
            // row-returning statement was running therefore reports Cancelled; DML is
            // never rewritten since its effects may have been applied.
            Ok((Some(_), _)) if was_cancelled => {
                Err(AppError::new(ErrorKind::Cancelled, "query cancelled"))
            }
            Ok(v) => Ok(v),
        }
    }

    async fn run_on(
        conn: &mut Conn,
        json_cache: &mut HashMap<(String, String), HashSet<String>>,
        mariadb: bool,
        sql: &str,
    ) -> AppResult<(Option<ResultSet>, u64)> {
        let mut qr = conn.query_iter(sql).await.map_err(|e| map_err(&e, true))?;
        let cols: Vec<Column> = qr.columns_ref().to_vec();
        if cols.is_empty() {
            let affected = qr.affected_rows();
            qr.drop_result().await.map_err(|e| map_err(&e, true))?;
            return Ok((None, affected));
        }
        // Keep at most MAX_RESULT_ROWS rows in memory; one more row marks the result as
        // truncated and the rest is read and discarded by `drop_result` (a cancel still
        // lands while it drains).
        let mut rows: Vec<Row> = Vec::new();
        let mut truncated = false;
        while let Some(row) = qr.next().await.map_err(|e| map_err(&e, true))? {
            if rows.len() == MAX_RESULT_ROWS {
                truncated = true;
                break;
            }
            rows.push(row);
        }
        // Drain the rest, plus any trailing result sets (e.g. the OK packet after CALL).
        qr.drop_result().await.map_err(|e| map_err(&e, true))?;
        // MariaDB has no JSON column type (JSON = LONGTEXT + CHECK json_valid) and
        // mysql_async does not negotiate extended metadata: recover it from the catalog.
        let mut is_json = vec![false; cols.len()];
        if mariadb {
            for (i, c) in cols.iter().enumerate() {
                if !matches!(
                    c.column_type(),
                    ColumnType::MYSQL_TYPE_BLOB
                        | ColumnType::MYSQL_TYPE_LONG_BLOB
                        | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
                        | ColumnType::MYSQL_TYPE_TINY_BLOB
                        | ColumnType::MYSQL_TYPE_VAR_STRING
                        | ColumnType::MYSQL_TYPE_VARCHAR
                ) || c.character_set() == BINARY_CHARSET
                    || c.org_table_str().is_empty()
                {
                    continue;
                }
                let key = (c.schema_str().to_string(), c.org_table_str().to_string());
                if !json_cache.contains_key(&key) {
                    // Best-effort: a failed lookup must not turn a good SELECT into an error.
                    let lookup: Result<Vec<Row>, MyError> = conn
                        .exec(
                            "SELECT CAST(CHECK_CLAUSE AS CHAR) FROM information_schema.CHECK_CONSTRAINTS \
                             WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?",
                            (key.0.clone(), key.1.clone()),
                        )
                        .await;
                    match lookup {
                        Ok(rows) => {
                            let mut set = HashSet::new();
                            // A clause that is NULL or not text simply holds no JSON column.
                            for (clause,) in
                                from_rows::<(Option<String>,)>(rows).unwrap_or_default()
                            {
                                if let Some(clause) = clause {
                                    json_columns_in(&clause, &mut set);
                                }
                            }
                            json_cache.insert(key.clone(), set);
                        }
                        Err(e) => {
                            let err = map_err(&e, true);
                            if matches!(err.kind, ErrorKind::ConnectionLost | ErrorKind::Cancelled)
                            {
                                return Err(err);
                            }
                        }
                    }
                }
                is_json[i] = json_cache
                    .get(&key)
                    .is_some_and(|set| set.contains(c.org_name_str().as_ref()));
            }
        }
        let out_rows = rows
            .iter()
            .map(|row| {
                cols.iter()
                    .enumerate()
                    .map(|(i, col)| match row.as_ref(i) {
                        Some(v) => cell_from_value(col, v, is_json[i]),
                        None => CellValue::Null,
                    })
                    .collect()
            })
            .collect();
        let columns = cols
            .iter()
            .enumerate()
            .map(|(i, c)| ColumnMeta {
                name: c.name_str().to_string(),
                type_name: if is_json[i] {
                    "json".to_string()
                } else {
                    type_name(c)
                },
            })
            .collect();
        Ok((
            Some(ResultSet {
                columns,
                rows: out_rows,
                truncated,
            }),
            0,
        ))
    }

    /// Bound-parameter metadata query under the connection lock.
    async fn exec_rows<T, P>(&self, sql: &str, params: P) -> AppResult<Vec<T>>
    where
        T: mysql_async::prelude::FromRow + Send + 'static,
        P: Into<mysql_async::Params> + Send,
    {
        if self.lost.load(Ordering::SeqCst) {
            return Err(Self::gone());
        }
        let mut guard = self.inner.lock().await;
        let Some(conn) = guard.conn.as_mut() else {
            return Err(Self::gone());
        };
        let rows = conn.exec::<Row, _, _>(sql, params).await.map_err(|e| {
            let err = map_err(&e, true);
            self.note_loss(&err);
            err
        })?;
        from_rows(rows)
    }

    /// `schema`, else the connection's current database (Invalid when none is selected).
    async fn schema_or_current(&self, schema: Option<&str>) -> AppResult<String> {
        if let Some(s) = schema {
            return Ok(s.to_string());
        }
        let cur: Vec<(Option<String>,)> = self.exec_rows("SELECT DATABASE()", ()).await?;
        cur.into_iter()
            .next()
            .and_then(|r| r.0)
            .ok_or_else(|| AppError::new(ErrorKind::Invalid, "no database selected"))
    }
}

#[async_trait]
impl Session for MySession {
    fn dialect(&self) -> Dialect {
        Dialect::MySql
    }

    fn server_version(&self) -> String {
        self.version.clone()
    }

    async fn list_schemas(&self) -> AppResult<Vec<String>> {
        let rows: Vec<(String,)> = self
            .exec_rows(
                "SELECT CAST(SCHEMA_NAME AS CHAR) FROM information_schema.SCHEMATA",
                (),
            )
            .await?;
        let mut out: Vec<String> = rows
            .into_iter()
            .map(|r| r.0)
            .filter(|s| !HIDDEN_SCHEMAS.contains(&s.to_ascii_lowercase().as_str()))
            .collect();
        out.sort();
        Ok(out)
    }

    async fn list_objects(&self, schema: Option<&str>) -> AppResult<Vec<DbObject>> {
        let db = match schema {
            Some(s) => s.to_string(),
            None => {
                let cur: Vec<(Option<String>,)> = self.exec_rows("SELECT DATABASE()", ()).await?;
                match cur.into_iter().next().and_then(|r| r.0) {
                    Some(d) => d,
                    None => {
                        return Err(AppError::new(ErrorKind::Invalid, "no database selected"));
                    }
                }
            }
        };
        let rows: Vec<(String, String)> = self
            .exec_rows(
                "SELECT CAST(TABLE_NAME AS CHAR), CAST(TABLE_TYPE AS CHAR) \
                 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
                (db.clone(),),
            )
            .await?;
        let mut out: Vec<DbObject> = rows
            .into_iter()
            .filter_map(|(name, ty)| {
                let kind = match ty.as_str() {
                    "BASE TABLE" => ObjectKind::Table,
                    "VIEW" => ObjectKind::View,
                    _ => return None,
                };
                Some(DbObject {
                    schema: Some(db.clone()),
                    name,
                    kind,
                })
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    async fn fetch_page(&self, req: &PageRequest) -> AppResult<ResultSet> {
        let sql = build_page_query(Dialect::MySql, req);
        let (rs, _) = self.run(&sql).await?;
        rs.ok_or_else(|| AppError::new(ErrorKind::Query, "page query returned no result set"))
    }

    async fn count_rows(&self, obj: &ObjectRef, exact_threshold: u64) -> AppResult<RowCount> {
        if let Some(schema) = &obj.schema {
            // TABLE_ROWS is NULL for views: fall through to the exact count.
            let rows: Vec<(Option<u64>,)> = self
                .exec_rows(
                    "SELECT TABLE_ROWS FROM information_schema.TABLES \
                     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
                    (schema.clone(), obj.name.clone()),
                )
                .await?;
            if let Some((Some(est),)) = rows.into_iter().next()
                && est > exact_threshold
            {
                return Ok(RowCount::Estimate(est));
            }
        }
        let q = qualified(Dialect::MySql, obj);
        let (rs, _) = self.run(&format!("SELECT COUNT(*) FROM {q}")).await?;
        match rs
            .and_then(|r| r.rows.into_iter().next())
            .map(|mut r| r.remove(0))
        {
            Some(CellValue::Int(n)) => Ok(RowCount::Exact(n.max(0) as u64)),
            Some(CellValue::BigInt(s)) => Ok(RowCount::Exact(s.parse().unwrap_or(u64::MAX))),
            _ => Err(AppError::new(ErrorKind::Query, "count returned no value")),
        }
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
        self.canceller.clone()
    }

    async fn close(&self) -> AppResult<()> {
        self.lost.store(true, Ordering::SeqCst);
        // Taking the lock waits for an in-flight query; cancel first if that matters.
        let conn = self.inner.lock().await.conn.take();
        if let Some(c) = conn {
            let _ = c.disconnect().await;
        }
        Ok(())
    }

    async fn catalog(&self, schema: Option<&str>) -> AppResult<Catalog> {
        let db = self.schema_or_current(schema).await?;
        // One query; LEFT JOIN keeps column-less objects.
        let rows: Vec<(String, String, Option<String>, Option<String>)> = self
            .exec_rows(
                "SELECT CAST(t.TABLE_NAME AS CHAR), CAST(t.TABLE_TYPE AS CHAR), \
                 CAST(c.COLUMN_NAME AS CHAR), CAST(c.COLUMN_TYPE AS CHAR) \
                 FROM information_schema.TABLES t \
                 LEFT JOIN information_schema.COLUMNS c \
                 ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME \
                 AND BINARY c.TABLE_NAME = BINARY t.TABLE_NAME \
                 AND BINARY c.TABLE_SCHEMA = BINARY t.TABLE_SCHEMA \
                 WHERE t.TABLE_SCHEMA = ? AND BINARY t.TABLE_SCHEMA = BINARY ? \
                 AND t.TABLE_TYPE IN ('BASE TABLE', 'VIEW') \
                 ORDER BY BINARY t.TABLE_NAME, c.ORDINAL_POSITION",
                (db.clone(), db.clone()),
            )
            .await?;
        Ok(group_rows(
            Some(db),
            rows.into_iter().map(|(table, ty, name, col_type)| {
                let kind = if ty == "VIEW" {
                    ObjectKind::View
                } else {
                    ObjectKind::Table
                };
                let col = name.map(|name| CatalogColumn {
                    name,
                    type_name: col_type.unwrap_or_default(),
                });
                (table, kind, col)
            }),
        ))
    }

    async fn list_routines(&self, schema: Option<&str>) -> AppResult<Vec<DbRoutine>> {
        let db = self.schema_or_current(schema).await?;
        let rows: Vec<(String, String)> = self
            .exec_rows(
                "SELECT CAST(ROUTINE_NAME AS CHAR), CAST(ROUTINE_TYPE AS CHAR) \
                 FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? \
                 ORDER BY ROUTINE_NAME",
                (db.clone(),),
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|(name, ty)| DbRoutine {
                schema: Some(db.clone()),
                name,
                kind: if ty.eq_ignore_ascii_case("PROCEDURE") {
                    RoutineKind::Procedure
                } else {
                    RoutineKind::Function
                },
            })
            .collect())
    }

    async fn list_databases(&self) -> AppResult<Vec<String>> {
        self.list_schemas().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEFAULT: Modes = Modes {
        backslash_escapes: true,
        ansi_quotes: false,
    };
    const NBE: Modes = Modes {
        backslash_escapes: false,
        ansi_quotes: false,
    };
    const ANSI: Modes = Modes {
        backslash_escapes: true,
        ansi_quotes: true,
    };

    #[test]
    fn lexer_honours_no_backslash_escapes() {
        // Backslash is a plain char: the quote ends the string, so `;` is real.
        assert!(has_multiple_statements(
            r"select 'a\'; delete from t; select '",
            NBE
        ));
        assert!(has_multiple_statements(r"select 'a\'; select 2", NBE));
        assert!(!has_multiple_statements(r"select 'a\'", NBE));
        assert!(!has_multiple_statements(r"select 'a\' ;", NBE));
        // Default mode: the escaped quote keeps the string open.
        assert!(!has_multiple_statements(r"select 'a\'; select 2'", DEFAULT));
        assert!(!has_multiple_statements(
            r"select 'a\'; select 2; select '",
            DEFAULT
        ));
        assert!(!has_multiple_statements(r"select 'a\'; select 2", DEFAULT));
        assert!(has_multiple_statements(
            r"select 'a\'; select 2; select '",
            NBE
        ));
    }

    #[test]
    fn lexer_honours_ansi_quotes() {
        // "..." is an identifier: no backslash escapes, closes at the next quote.
        assert!(has_multiple_statements(
            r#"select "a\"; drop table t; -- ""#,
            ANSI
        ));
        assert!(!has_multiple_statements(
            r#"select "a\"; drop table t; -- ""#,
            DEFAULT
        ));
        // Doubled quotes still escape under ANSI_QUOTES.
        assert!(!has_multiple_statements(r#"select "a"";b""#, ANSI));
        // '...' strings keep backslash escapes under ANSI_QUOTES.
        assert!(!has_multiple_statements(r"select 'a\'; b'", ANSI));
    }

    #[test]
    fn sql_mode_parsing() {
        let m = Modes::from_sql_mode("STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES,ANSI_QUOTES");
        assert_eq!(
            m,
            Modes {
                backslash_escapes: false,
                ansi_quotes: true
            }
        );
        assert_eq!(Modes::from_sql_mode(""), DEFAULT);
    }

    fn inner() -> Inner {
        Inner {
            conn: None,
            modes: DEFAULT,
            unsafe_charset: None,
            modes_unknown: false,
            json_cache: HashMap::new(),
        }
    }

    #[test]
    fn a_failed_reread_fails_closed_until_one_succeeds() {
        let mut st = inner();
        // A re-read that fails with the link up: state unknown, every statement refused.
        absorb_reread(&mut st, Err(AppError::new(ErrorKind::Query, "boom"))).unwrap();
        assert!(st.modes_unknown);
        for sql in ["select 1", "SET NAMES utf8mb4"] {
            let e = refusal(
                sql,
                st.modes,
                st.unsafe_charset.as_deref(),
                st.modes_unknown,
            )
            .expect(sql);
            assert_eq!(e.kind, ErrorKind::Invalid);
            assert_eq!(e.message, "session state could not be verified: reconnect");
        }
        // A lost link is reported, not swallowed.
        let lost = absorb_reread(&mut st, Err(AppError::new(ErrorKind::ConnectionLost, "x")));
        assert_eq!(lost.unwrap_err().kind, ErrorKind::ConnectionLost);
        // A successful re-read restores the state it read.
        absorb_reread(&mut st, Ok((NBE, Some("gbk".into())))).unwrap();
        assert!(!st.modes_unknown);
        assert_eq!(st.modes, NBE);
        assert_eq!(st.unsafe_charset.as_deref(), Some("gbk"));
        absorb_reread(&mut st, Ok((DEFAULT, None))).unwrap();
        assert!(refusal("select 1", st.modes, None, st.modes_unknown).is_none());
    }

    #[test]
    fn unsafe_client_charsets_are_recognised() {
        for cs in ["gbk", "GBK", "big5", "cp932", "gb18030", "sjis"] {
            assert!(unsafe_client_charset(Some(cs)).is_some(), "{cs}");
        }
        for cs in [
            "utf8mb4", "utf8mb3", "latin1", "ascii", "binary", "ujis", "euckr",
        ] {
            assert_eq!(unsafe_client_charset(Some(cs)), None, "{cs}");
        }
        assert_eq!(unsafe_client_charset(None), None);
    }

    #[test]
    fn unsafe_client_charset_refuses_everything_but_an_ascii_set() {
        let refused = |sql: &str| refusal(sql, DEFAULT, Some("gbk"), false);
        for sql in [
            "select '中\\'; drop table t; -- '",
            "select 1",
            "set @x = '中'",
            "/*!40101 SET NAMES utf8mb4 */",
        ] {
            let e = refused(sql).expect(sql);
            assert_eq!(e.kind, ErrorKind::Invalid);
            assert_eq!(
                e.message,
                "client character set gbk is not supported: use SET NAMES utf8mb4"
            );
        }
        for sql in [
            "SET NAMES utf8mb4",
            "set character set utf8mb4",
            "SET NAMES latin1;",
        ] {
            assert!(refused(sql).is_none(), "{sql}");
        }
        // The ASCII SET still goes through the single-statement check.
        assert_eq!(
            refused("SET NAMES utf8mb4; drop table t").unwrap().message,
            "execute accepts exactly one statement"
        );
        // A safe charset changes nothing.
        assert!(refusal("select '中\\'; x'", DEFAULT, None, false).is_none());
    }

    #[test]
    fn dollar_quoted_bodies_are_refused() {
        for sql in [
            "create function f() returns int language javascript as $$ return 1; $$",
            "create function f() returns int language javascript as $js$return 1$js$",
            "create function f() returns int language javascript as $$ ' $$; drop table t; -- '",
            "select $$x$$",
        ] {
            let e = refusal(sql, DEFAULT, None, false).expect(sql);
            assert_eq!(e.message, "dollar-quoted bodies are not supported", "{sql}");
        }
        for sql in ["select 1 as a$b", "select `$$`", "select '$$'", "select $a"] {
            assert!(refusal(sql, DEFAULT, None, false).is_none(), "{sql}");
        }
    }

    #[test]
    fn multi_statement_lexer() {
        for single in [
            "select 1",
            "select 1;",
            "select 1; ",
            "select 1 ; -- trailing",
            "select 1 /* ; */ ;  # x",
            "select 'a;b', \"c;d\", `e;f`",
            "select 'it''s; fine'",
            "select 'esc\\'; still string'",
            "select 1 -- ; select 2",
        ] {
            assert!(!has_multiple_statements(single, DEFAULT), "{single}");
        }
        for multi in [
            "select 1; select 2",
            "select 1;select 2",
            "select 1;;",
            "select 1 ; -- c\n select 2",
            "select 1 /*! ; select 2 */",
            "select 1 /*M! ; select 2 */",
            "select 'x'; drop table t",
            // `--` without trailing whitespace is not a comment in MySQL.
            "select 1 --;x\n",
            "select 1 -- c\n; select 2",
        ] {
            assert!(has_multiple_statements(multi, DEFAULT), "{multi}");
        }
    }

    #[test]
    fn compound_bodies_are_one_statement() {
        for single in [
            "CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END",
            "CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END;",
            "create definer=`root`@`%` procedure p(in n int)\nbegin\n declare i int default 0;\n \
             declare continue handler for sqlexception begin set i = -1; end;\n \
             lbl: while i < n do set i = i + 1; if i = 2 then iterate lbl; elseif i > 5 then leave lbl; \
             else set @x = 1; end if; end while lbl;\n \
             repeat set i = i - 1; until i <= 0 end repeat;\n \
             case n when 1 then select case when i then 1 else 2 end; else begin select 3; end; end case;\n \
             inner_block: begin select if(i, 1, 2), repeat('a', 2); end inner_block;\nend",
            "CREATE FUNCTION f(x INT) RETURNS INT DETERMINISTIC BEGIN DECLARE y INT; SET y = x * 2; RETURN y; END",
            "CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN SET NEW.a = 1; SET NEW.b = 2; END",
            "CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW FOLLOWS o BEGIN SET NEW.a = 1; END",
            "CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM t; INSERT INTO t VALUES (1); END",
            "BEGIN NOT ATOMIC SELECT 1; SELECT 2; END",
            "CREATE PROCEDURE p() lbl: BEGIN SELECT 'a;b'; /* ; */ SELECT 2; -- ;\n END lbl",
            // Characteristics before the body, and compound bodies other than BEGIN.
            "CREATE DEFINER=CURRENT_USER() FUNCTION f(a DECIMAL(10,2)) RETURNS VARCHAR(20) CHARACTER SET utf8mb4 \
             COLLATE utf8mb4_bin COMMENT 'x; y' LANGUAGE SQL NOT DETERMINISTIC READS SQL DATA \
             SQL SECURITY INVOKER BEGIN DECLARE s VARCHAR(20); SET s = 'a'; RETURN s; END",
            "CREATE PROCEDURE p() MODIFIES SQL DATA lbl: LOOP SELECT 1; LEAVE lbl; END LOOP lbl",
            "CREATE PROCEDURE p() IF @a THEN SELECT 1; ELSE SELECT 2; END IF",
            "CREATE PROCEDURE p() BEGIN DECLARE EXIT HANDLER FOR SQLSTATE VALUE '23000', NOT FOUND, 1062 \
             BEGIN SELECT 1; END; WHILE (SELECT CASE WHEN @a THEN 1 ELSE 0 END) DO SELECT 2; END WHILE; \
             IF CASE @x WHEN 1 THEN 1 END = 1 THEN SELECT t.begin, t.end, @case FROM t; END IF; END",
        ] {
            assert!(!has_multiple_statements(single, DEFAULT), "{single}");
        }
    }

    #[test]
    fn compound_bodies_never_hide_a_second_statement() {
        for multi in [
            "CREATE PROCEDURE p() BEGIN SELECT 1; END; SELECT 2",
            "create procedure p() begin select 1; end; drop table x; end",
            // `begin` used as an identifier is not a block opener.
            "create procedure p() begin select begin from t; end; drop table x; end",
            "create procedure begin() select 1; drop table x; end",
            "create procedure p() begin select case when a then begin else 0 end from t; end; drop table x; end",
            "create procedure p() begin declare c condition for 1; \
             declare exit handler for begin begin select 1; end; end; drop table x; end",
            // Executable comments are not trusted inside a compound body.
            "create procedure p() begin /*!99999 case */ end; drop table x;",
            "create procedure p() begin /*!1 end */ ; drop table x; end",
            // An unterminated body that swallowed a `;` is refused.
            "create procedure p() begin select 1; drop table x",
            // Not a compound statement at all.
            "BEGIN; SELECT 1",
            "CREATE PROCEDURE p() SELECT 1; SELECT 2",
            "create table function (begin int); select 1",
            "CREATE PROCEDURE p() BEGIN SELECT 1; END x y; SELECT 2",
            // Review round 1: a BEGIN / CASE that is not at a statement start opens nothing
            // (each of these ran `DROP TABLE x` on MySQL 8.4 and MariaDB 11.4).
            "create procedure p() select begin from t; drop table x; end",
            "create procedure p() update t set begin = 1; drop table x; end",
            "create procedure p() set @begin = 1; drop table x; end",
            "create trigger tr before insert on y for each row insert into l select begin from t2; drop table x; end",
            "create event e on schedule every 1 day do select begin from t; drop table x; end",
            "create procedure p() begin declare continue handler for sqlexception select begin from t; end; drop table x; end",
            "create procedure p() begin set @case = 1; end; drop table x; end",
            "create procedure p() begin select t.case from t; end; drop table x; end",
            // More of the same family.
            "create procedure p() begin select @@begin; end; drop table x; end",
            "create function f() returns int return (select begin from t); drop table x; end",
            "create procedure p() comment 'begin' select 1; drop table x; end",
            "create procedure p() begin if t.end then select 1; end if; end; drop table x; end",
            "create procedure p() begin if begin then select 1; end if; end; drop table x; end if; end",
            // Structure errors fail closed.
            "create procedure p() begin end if; select 1; end",
            "create procedure p() begin select 1; else select 2; end",
            "create procedure p() begin begin: loop leave begin; end loop; end",
            "create procedure p() begin if a then select 1; end; end; drop table x",
        ] {
            assert!(has_multiple_statements(multi, DEFAULT), "{multi}");
        }
    }

    /// Review round 2: single statements of every shape the tracker knows, each also
    /// followed by `; drop table x` (which must be refused).
    const ROUND2_SINGLES: [&str; 25] = [
        "create function f() returns int return (select 1)",
        "create function f() returns decimal(10,2) deterministic return 1",
        "create function f() returns varchar(10) charset utf8mb4 collate utf8mb4_bin return 'a'",
        "create procedure p() comment 'begin' select 1",
        "create procedure p() comment 'x;y' language sql not deterministic contains sql sql security invoker select 1",
        "create definer = root@localhost procedure p() select 1",
        "create definer=current_user() procedure p() select 1",
        "create definer=`a`@`%` trigger tr before insert on y for each row set new.a = 1",
        "create procedure if not exists p() select 1",
        "create trigger tr before insert on y for each row set new.a = 1",
        "create trigger tr before insert on y for each row follows other set new.a = 1",
        "create event e on schedule every 1 day do begin select 1; end",
        "create event e on schedule every 1 day do select 1",
        "create procedure p() begin end",
        "create procedure p() l: begin select 1; end l",
        "create procedure p() begin not atomic select 1; end",
        "create procedure p() begin if x then select case when a then 1 else 2 end from t; end if; end",
        "create procedure p() begin select case `end` when 1 then 2 end from t; end",
        "create procedure p() begin select t.`end` from t; end",
        "create procedure p() begin -- end;\n select 1; end",
        "create procedure p() begin /* end; */ select 1; end",
        "create procedure p() begin # end;\n select 1; end",
        "create procedure p() begin select 'end;'; end",
        "create procedure p() begin declare c cursor for select begin from t; end",
        "create procedure p() begin declare exit handler for sqlexception begin select 1; end; end",
    ];

    #[test]
    fn round2_singles_are_accepted() {
        let extra =
            "create procedure p() begin repeat set @i = @i + 1; until @i > 3 end repeat; end";
        for single in ROUND2_SINGLES.iter().copied().chain([extra]) {
            for tail in ["", ";", "; \n\t", " ;  -- done\n"] {
                let sql = format!("{single}{tail}");
                assert!(!has_multiple_statements(&sql, DEFAULT), "{sql:?}");
            }
        }
    }

    #[test]
    fn round2_second_statements_are_refused() {
        let extra =
            "create procedure p() begin repeat set @i = @i + 1; until @i > 3 end repeat; end";
        for single in ROUND2_SINGLES.iter().copied().chain([extra]) {
            for tail in ["; drop table x", ";\ndrop table x;", " ; drop table x; end"] {
                let sql = format!("{single}{tail}");
                assert!(has_multiple_statements(&sql, DEFAULT), "{sql:?}");
            }
        }
        // A second CREATE without any separator.
        assert!(has_multiple_statements(
            "create procedure p() begin end create procedure q() begin end",
            DEFAULT
        ));
    }

    #[test]
    fn unsigned_type_name_and_error_codes() {
        let e = MyError::Server(mysql_async::ServerError {
            code: 1317,
            message: "interrupted".into(),
            state: "70100".into(),
        });
        assert_eq!(map_err(&e, true).kind, ErrorKind::Cancelled);
        let e = MyError::Server(mysql_async::ServerError {
            code: 1045,
            message: "denied".into(),
            state: "28000".into(),
        });
        assert_eq!(map_err(&e, false).kind, ErrorKind::Auth);
        let e = MyError::Driver(mysql_async::DriverError::ConnectionClosed);
        assert_eq!(map_err(&e, true).kind, ErrorKind::ConnectionLost);
        assert_eq!(map_err(&e, false).kind, ErrorKind::Connection);
        // MySQL 8 inactivity disconnect (wait_timeout) is a lost connection.
        let e = MyError::Server(mysql_async::ServerError {
            code: 4031,
            message: "disconnected by the server because of inactivity".into(),
            state: "HY000".into(),
        });
        assert_eq!(map_err(&e, true).kind, ErrorKind::ConnectionLost);
    }
}

//! Row changes from the grid: UPDATE / INSERT / DELETE statements built from the table's
//! metadata (`build_change`), their display-only preview (`render_preview`), and the
//! statements that load one full cell value (`build_cell_size`, `build_cell_value`).
//!
//! Every value is a bound parameter, cast like the filters (`query`): PostgreSQL writes
//! `CAST($n::text AS <base_type>)`, the type without its modifier, so the column itself
//! enforces `varchar(n)` / `numeric(p,s)` on assignment (an error, never a silent
//! truncation); MySQL and SQLite bind the text as is. Rows are found by their row key
//! (`TableInfo::row_key`) with the values the grid loaded; `Session::apply` then checks
//! that each UPDATE / DELETE touched exactly one row.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

use super::meta::{ColumnInfo, TableInfo};
use super::query::{Builder, SqlParam, Statement};
use super::sql::{qualified, quote_ident};
use super::{Dialect, ObjectKind};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::value::{BYTES_PREVIEW, CellValue, decode_hex};

/// `ApplyOutcome.error` message when an UPDATE / DELETE did not touch exactly one row.
pub const STALE_ROW: &str = "the row was deleted or its key changed since it was loaded";

/// How long `Session::apply` lets a change wait for a row lock held by another session
/// (PostgreSQL `lock_timeout`, MySQL/MariaDB `innodb_lock_wait_timeout`, spec §4): past
/// it the change fails like any other database error and everything is rolled back.
pub const APPLY_LOCK_TIMEOUT_SECS: u64 = 30;

static LOCK_TIMEOUT_SECS: AtomicU64 = AtomicU64::new(APPLY_LOCK_TIMEOUT_SECS);

/// The lock wait bound of `apply`, in seconds ([`APPLY_LOCK_TIMEOUT_SECS`]).
pub fn apply_lock_timeout_secs() -> u64 {
    LOCK_TIMEOUT_SECS.load(Ordering::Relaxed)
}

/// Tests only: shortens the process-wide lock wait bound.
#[doc(hidden)]
pub fn set_apply_lock_timeout_secs(secs: u64) {
    LOCK_TIMEOUT_SECS.store(secs.max(1), Ordering::Relaxed);
}

/// A value written by a change. `Default` (the column's default) only in an insert.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "camelCase")]
pub enum EditValue {
    Null,
    Default,
    Text(String),
}

/// The loaded values of the row key columns, as `[column, value]` pairs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RowKey(pub Vec<(String, CellValue)>);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RowChange {
    Update {
        key: RowKey,
        set: Vec<(String, EditValue)>,
    },
    Insert {
        values: Vec<(String, EditValue)>,
    },
    Delete {
        key: RowKey,
    },
}

impl RowChange {
    /// UPDATE and DELETE must touch exactly one row (`Session::apply`'s `expect_one`).
    pub fn expects_one_row(&self) -> bool {
        !matches!(self, RowChange::Insert { .. })
    }
}

/// The result of `Session::apply`. Not applied: everything was rolled back, and
/// `error` says why (`failed_index` = the statement that failed, `None` when the commit
/// itself failed).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyOutcome {
    pub applied: bool,
    /// Rows touched by each statement that ran, in order (the failed one included when
    /// it ran but did not touch exactly one row).
    pub affected: Vec<u64>,
    pub failed_index: Option<usize>,
    pub error: Option<AppError>,
}

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Invalid, msg)
}

/// The UPDATE / INSERT / DELETE for one change, refused (`Invalid`) when the table is
/// read-only, a column is unknown or generated, `Default` is used outside an insert, or
/// the row key is incomplete or unusable (NULL or truncated value).
pub fn build_change(d: Dialect, info: &TableInfo, c: &RowChange) -> AppResult<Statement> {
    editable(info)?;
    let table = qualified(d, &info.object);
    let mut b = Builder::new(d);
    match c {
        RowChange::Update { key, set } => {
            if set.is_empty() {
                return Err(invalid("nothing to update"));
            }
            let mut parts = Vec::with_capacity(set.len());
            for (col, v) in once_each(set)? {
                let column = writable(info, col)?;
                let rhs = match v {
                    EditValue::Null => "NULL".to_string(),
                    EditValue::Default => {
                        return Err(invalid("DEFAULT is only allowed in an insert"));
                    }
                    EditValue::Text(t) => b.typed(t, &text_column(column)?.base_type),
                };
                parts.push(format!("{} = {rhs}", quote_ident(d, col)));
            }
            b.sql = format!("UPDATE {table} SET {}", parts.join(", "));
            push_key_where(&mut b, info, key)?;
        }
        RowChange::Insert { values } => {
            let (mut cols, mut vals) = (Vec::new(), Vec::new());
            for (col, v) in once_each(values)? {
                let value = match v {
                    // Left to the database (generated columns included).
                    EditValue::Default => {
                        known(info, col)?;
                        continue;
                    }
                    EditValue::Null => {
                        writable(info, col)?;
                        "NULL".to_string()
                    }
                    EditValue::Text(t) => {
                        let column = text_column(writable(info, col)?)?;
                        b.typed(t, &column.base_type)
                    }
                };
                cols.push(quote_ident(d, col));
                vals.push(value);
            }
            b.sql = if cols.is_empty() {
                match d {
                    Dialect::MySql => format!("INSERT INTO {table} () VALUES ()"),
                    Dialect::Postgres | Dialect::Sqlite => {
                        format!("INSERT INTO {table} DEFAULT VALUES")
                    }
                }
            } else {
                format!(
                    "INSERT INTO {table} ({}) VALUES ({})",
                    cols.join(", "),
                    vals.join(", ")
                )
            };
        }
        RowChange::Delete { key } => {
            b.sql = format!("DELETE FROM {table}");
            push_key_where(&mut b, info, key)?;
        }
    }
    Ok(b.finish())
}

/// `SELECT <size in bytes of column> FROM t WHERE <row key>`: checked before loading a
/// full value (`value::MAX_EDIT_BYTES`). `None` for a binary column: bytes always come back
/// as a preview, so there is nothing to cap.
pub fn build_cell_size(
    d: Dialect,
    info: &TableInfo,
    key: &RowKey,
    column: &str,
) -> AppResult<Option<Statement>> {
    let c = known(info, column)?;
    if c.binary {
        return Ok(None);
    }
    let q = quote_ident(d, column);
    let size = match d {
        Dialect::Postgres => format!("octet_length(CAST({q} AS text))"),
        Dialect::MySql => format!("OCTET_LENGTH({q})"),
        Dialect::Sqlite => format!("length(CAST({q} AS BLOB))"),
    };
    cell_select(d, info, key, &size).map(Some)
}

/// `SELECT <column> FROM t WHERE <row key>` (run with `Session::query_full`).
pub fn build_cell_value(
    d: Dialect,
    info: &TableInfo,
    key: &RowKey,
    column: &str,
) -> AppResult<Statement> {
    known(info, column)?;
    cell_select(d, info, key, &quote_ident(d, column))
}

fn cell_select(d: Dialect, info: &TableInfo, key: &RowKey, expr: &str) -> AppResult<Statement> {
    // Without a row key the row cannot be found: refused with the read-only reason.
    if info.row_key.is_none() {
        editable(info)?;
    }
    let mut b = Builder::new(d);
    b.sql = format!("SELECT {expr} FROM {}", qualified(d, &info.object));
    push_key_where(&mut b, info, key)?;
    Ok(b.finish())
}

/// The statement with each parameter replaced by an escaped literal (`'…'`, `'` doubled;
/// MySQL also doubles `\`; bytes as `'\x…'` on PostgreSQL, `X'…'` elsewhere). For display
/// only: never executed.
pub fn render_preview(d: Dialect, stmt: &Statement) -> String {
    let literal = |p: &SqlParam| match p {
        // MySQL treats `\` as an escape under its default sql_mode: doubled, so the preview
        // never shows another value (or a quote that closes the literal). Under
        // NO_BACKSLASH_ESCAPES the preview shows the backslashes doubled.
        SqlParam::Text(t) if d == Dialect::MySql => {
            format!("'{}'", t.replace('\\', "\\\\").replace('\'', "''"))
        }
        SqlParam::Text(t) => format!("'{}'", t.replace('\'', "''")),
        SqlParam::Bytes(b) => {
            let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
            match d {
                Dialect::Postgres => format!("'\\x{hex}'"),
                Dialect::MySql | Dialect::Sqlite => format!("X'{hex}'"),
            }
        }
    };
    let mut out = String::with_capacity(stmt.sql.len());
    let mut chars = stmt.sql.chars().peekable();
    let mut next = 0;
    while let Some(c) = chars.next() {
        match c {
            // Quoted identifiers and literals are copied as is (a doubled quote stays inside).
            '\'' | '"' | '`' => {
                out.push(c);
                while let Some(x) = chars.next() {
                    out.push(x);
                    if x == c {
                        if chars.peek() == Some(&c) {
                            out.push(c);
                            chars.next();
                        } else {
                            break;
                        }
                    }
                }
            }
            '$' if d == Dialect::Postgres && chars.peek().is_some_and(char::is_ascii_digit) => {
                let mut n = String::new();
                while let Some(x) = chars.peek().copied().filter(char::is_ascii_digit) {
                    n.push(x);
                    chars.next();
                }
                match n
                    .parse::<usize>()
                    .ok()
                    .and_then(|i| stmt.params.get(i.wrapping_sub(1)))
                {
                    Some(p) => out.push_str(&literal(p)),
                    None => {
                        out.push('$');
                        out.push_str(&n);
                    }
                }
            }
            '?' if d != Dialect::Postgres => {
                match stmt.params.get(next) {
                    Some(p) => out.push_str(&literal(p)),
                    None => out.push('?'),
                }
                next += 1;
            }
            _ => out.push(c),
        }
    }
    out
}

/// A failed change whose error hints that the table's metadata is stale (a column or
/// table that no longer exists): the cached `TableInfo` should be re-read.
pub fn suggests_schema_change(e: &AppError) -> bool {
    if e.kind != ErrorKind::Query {
        return false;
    }
    let m = e.message.to_ascii_lowercase();
    [
        "unknown column",
        "no such column",
        "no such table",
        "does not exist",
        "doesn't exist",
    ]
    .iter()
    .any(|hint| m.contains(hint))
}

/// The row key columns of an editable table, else why it is read-only.
fn editable(info: &TableInfo) -> AppResult<&[String]> {
    if info.kind == ObjectKind::View {
        return Err(invalid("table is read-only: it is a view"));
    }
    match &info.row_key {
        Some(k) if info.editable() => Ok(k),
        _ => Err(invalid(
            "table is read-only: no primary key or unique index on NOT NULL columns",
        )),
    }
}

fn known<'a>(info: &'a TableInfo, col: &str) -> AppResult<&'a ColumnInfo> {
    info.column(col)
        .ok_or_else(|| invalid(format!("unknown column {col}")))
}

/// A column that may receive a text value (bytes are not edited as text in v1).
fn text_column(c: &ColumnInfo) -> AppResult<&ColumnInfo> {
    if c.binary {
        return Err(invalid("binary columns can't be edited as text"));
    }
    Ok(c)
}

fn writable<'a>(info: &'a TableInfo, col: &str) -> AppResult<&'a ColumnInfo> {
    let c = known(info, col)?;
    if c.generated {
        return Err(invalid(format!("{col} is a generated column")));
    }
    Ok(c)
}

/// The pairs, refused when a column appears twice.
fn once_each(pairs: &[(String, EditValue)]) -> AppResult<&[(String, EditValue)]> {
    for (i, (col, _)) in pairs.iter().enumerate() {
        if pairs[..i].iter().any(|(c, _)| c == col) {
            return Err(invalid(format!("{col} is set twice")));
        }
    }
    Ok(pairs)
}

/// ` WHERE k1 = … AND k2 = …` over the row key columns, in row key order.
fn push_key_where(b: &mut Builder, info: &TableInfo, key: &RowKey) -> AppResult<()> {
    let cols: &[String] = info.row_key.as_deref().unwrap_or_default();
    if let Some((extra, _)) = key.0.iter().find(|(n, _)| !cols.contains(n)) {
        return Err(invalid(format!("{extra} is not part of the row key")));
    }
    let mut conds = Vec::with_capacity(cols.len());
    for col in cols {
        let mut found = key.0.iter().filter(|(n, _)| n == col);
        let value = match (found.next(), found.next()) {
            (Some((_, v)), None) => v,
            (None, _) => {
                return Err(invalid(format!("row key is incomplete: {col} is missing")));
            }
            (Some(_), Some(_)) => {
                return Err(invalid(format!("row key column {col} is given twice")));
            }
        };
        let column = known(info, col)?;
        let rhs = match key_param(b.d, col, value)? {
            SqlParam::Text(t) => b.typed(&t, &column.base_type),
            SqlParam::Bytes(v) => b.bytes(v),
        };
        conds.push(format!("{} = {rhs}", quote_ident(b.d, col)));
    }
    b.sql.push_str(" WHERE ");
    b.sql.push_str(&conds.join(" AND "));
    Ok(())
}

/// A loaded key value as a parameter: complete bytes natively, everything else as text
/// the database parses back to the same value.
fn key_param(d: Dialect, col: &str, v: &CellValue) -> AppResult<SqlParam> {
    let truncated = || {
        invalid(format!(
            "row key value of {col} is truncated: it cannot be edited"
        ))
    };
    Ok(SqlParam::Text(match v {
        CellValue::Null => return Err(invalid("row has a NULL key: it cannot be edited")),
        CellValue::LongText { .. } => return Err(truncated()),
        CellValue::Bytes { len, hex_preview } => {
            if *len > BYTES_PREVIEW as u64 {
                return Err(truncated());
            }
            return decode_hex(hex_preview)
                .filter(|b| b.len() as u64 == *len)
                .map(SqlParam::Bytes)
                .ok_or_else(|| invalid(format!("row key value of {col} is not valid hex")));
        }
        CellValue::Bool(b) => match (d, b) {
            (Dialect::Postgres, true) => "true".into(),
            (Dialect::Postgres, false) => "false".into(),
            (_, true) => "1".into(),
            (_, false) => "0".into(),
        },
        CellValue::Int(i) => i.to_string(),
        // Shortest representation that parses back to the same double.
        CellValue::Float(f) => format!("{f:?}"),
        CellValue::BigInt(s)
        | CellValue::Decimal(s)
        | CellValue::Text(s)
        | CellValue::Json(s)
        | CellValue::Temporal(s) => s.clone(),
    }))
}

/// Why `Session::apply` stops before COMMIT: `Abort` is returned as `Err` (lost
/// connection, cancel: rolled back), `Failed` as the outcome. The COMMIT step itself goes
/// through [`commit_failed`].
pub(crate) enum Halt {
    Abort(AppError),
    Failed(ApplyOutcome),
}

impl Halt {
    pub(crate) fn into_result(self) -> AppResult<ApplyOutcome> {
        match self {
            Halt::Abort(e) => Err(e),
            Halt::Failed(o) => Ok(o),
        }
    }
}

/// Errors that end `apply` with `Err` instead of a failed outcome.
fn aborts(e: &AppError) -> bool {
    matches!(
        e.kind,
        ErrorKind::ConnectionLost | ErrorKind::Connection | ErrorKind::Cancelled
    )
}

fn failed(index: Option<usize>, affected: Vec<u64>, e: AppError) -> ApplyOutcome {
    ApplyOutcome {
        applied: false,
        affected,
        failed_index: index,
        error: Some(e),
    }
}

pub(crate) fn check_apply_args(stmts: &[Statement], expect_one: &[bool]) -> AppResult<()> {
    if stmts.len() != expect_one.len() {
        return Err(invalid("apply: one expect_one flag per statement"));
    }
    Ok(())
}

/// Records the result of statement `index` (rows touched, or its error); a `Halt` means
/// roll back now.
pub(crate) fn record(
    index: usize,
    expect_one: bool,
    result: AppResult<u64>,
    affected: &mut Vec<u64>,
) -> Result<(), Halt> {
    match result {
        Ok(n) => {
            affected.push(n);
            if expect_one && n != 1 {
                return Err(Halt::Failed(failed(
                    Some(index),
                    std::mem::take(affected),
                    AppError::new(ErrorKind::Query, STALE_ROW),
                )));
            }
            Ok(())
        }
        Err(e) if aborts(&e) => Err(Halt::Abort(e)),
        Err(e) => Err(Halt::Failed(failed(
            Some(index),
            std::mem::take(affected),
            e,
        ))),
    }
}

pub(crate) fn applied(affected: Vec<u64>) -> ApplyOutcome {
    ApplyOutcome {
        applied: true,
        affected,
        failed_index: None,
        error: None,
    }
}

/// Message of an interrupted COMMIT (`Connection`: outcome unknown).
pub const COMMIT_INTERRUPTED: &str =
    "the commit was interrupted: whether it was written is unknown";

/// The COMMIT step failed. A plain error (e.g. a deferred constraint) means nothing was
/// written: a failed outcome. An aborting error is returned as `Err`, and none of them
/// says whether the COMMIT completed on the server: a lost connection stays
/// `ConnectionLost`, a connection error `Connection`, and a cancel that landed on the
/// COMMIT (MySQL `KILL QUERY` → error 1317 → `Cancelled`) becomes `Connection`
/// ([`COMMIT_INTERRUPTED`]) so the caller never reports "cancelled, nothing written" for
/// it. Shared by every engine's `Session::apply`.
pub(crate) fn commit_failed(affected: Vec<u64>, e: AppError) -> AppResult<ApplyOutcome> {
    if e.kind == ErrorKind::Cancelled {
        return Err(AppError::new(ErrorKind::Connection, COMMIT_INTERRUPTED));
    }
    if aborts(&e) {
        return Err(e);
    }
    Ok(failed(None, affected, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::ObjectRef;

    fn column(name: &str, type_name: &str, base_type: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            type_name: type_name.into(),
            base_type: base_type.into(),
            nullable: true,
            default: None,
            auto_increment: false,
            generated: false,
            binary: type_name == "bytea",
            comment: None,
        }
    }

    /// `<schema>.order (id integer, code text, amount numeric(12,2), note text,
    /// upper_note generated, data bytea)`, row key (id, code).
    fn info(schema: &str) -> TableInfo {
        let mut id = column("id", "integer", "integer");
        id.auto_increment = true;
        let mut generated = column("upper_note", "text", "text");
        generated.generated = true;
        TableInfo {
            object: ObjectRef {
                schema: Some(schema.into()),
                name: "order".into(),
            },
            kind: ObjectKind::Table,
            columns: vec![
                id,
                column("code", "text", "text"),
                column("amount", "numeric(12,2)", "numeric"),
                column("note", "text", "text"),
                generated,
                column("data", "bytea", "bytea"),
            ],
            primary_key: vec!["id".into(), "code".into()],
            indexes: vec![],
            foreign_keys: vec![],
            row_key: Some(vec!["id".into(), "code".into()]),
            has_rowid: false,
        }
    }

    fn key(pairs: &[(&str, CellValue)]) -> RowKey {
        RowKey(
            pairs
                .iter()
                .map(|(c, v)| (c.to_string(), v.clone()))
                .collect(),
        )
    }

    fn std_key() -> RowKey {
        key(&[
            ("id", CellValue::Int(7)),
            ("code", CellValue::Text("a'b".into())),
        ])
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

    fn texts(v: &[&str]) -> Vec<SqlParam> {
        v.iter().map(|s| SqlParam::Text(s.to_string())).collect()
    }

    fn update() -> RowChange {
        RowChange::Update {
            key: std_key(),
            set: set(&[("amount", text("12.30")), ("note", EditValue::Null)]),
        }
    }

    fn err(d: Dialect, info: &TableInfo, c: &RowChange) -> String {
        let e = build_change(d, info, c).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Invalid, "{}", e.message);
        e.message
    }

    #[test]
    fn update_sql_per_dialect() {
        let s = build_change(Dialect::Postgres, &info("public"), &update()).unwrap();
        assert_eq!(
            s.sql,
            r#"UPDATE "public"."order" SET "amount" = CAST($1::text AS numeric), "note" = NULL WHERE "id" = CAST($2::text AS integer) AND "code" = CAST($3::text AS text)"#
        );
        assert_eq!(s.params, texts(&["12.30", "7", "a'b"]));

        let s = build_change(Dialect::MySql, &info("shop"), &update()).unwrap();
        assert_eq!(
            s.sql,
            "UPDATE `shop`.`order` SET `amount` = ?, `note` = NULL WHERE `id` = ? AND `code` = ?"
        );
        assert_eq!(s.params, texts(&["12.30", "7", "a'b"]));

        let s = build_change(Dialect::Sqlite, &info("main"), &update()).unwrap();
        assert_eq!(
            s.sql,
            r#"UPDATE "main"."order" SET "amount" = ?, "note" = NULL WHERE "id" = ? AND "code" = ?"#
        );
    }

    #[test]
    fn key_follows_row_key_order_whatever_the_pair_order() {
        let c = RowChange::Delete {
            key: key(&[
                ("code", CellValue::Text("x".into())),
                ("id", CellValue::Int(1)),
            ]),
        };
        let s = build_change(Dialect::MySql, &info("shop"), &c).unwrap();
        assert_eq!(
            s.sql,
            "DELETE FROM `shop`.`order` WHERE `id` = ? AND `code` = ?"
        );
        assert_eq!(s.params, texts(&["1", "x"]));
    }

    #[test]
    fn insert_omits_default_columns() {
        let c = RowChange::Insert {
            values: set(&[
                ("id", EditValue::Default),
                ("code", text("c1")),
                ("amount", EditValue::Null),
                ("upper_note", EditValue::Default),
            ]),
        };
        let s = build_change(Dialect::Postgres, &info("public"), &c).unwrap();
        assert_eq!(
            s.sql,
            r#"INSERT INTO "public"."order" ("code", "amount") VALUES (CAST($1::text AS text), NULL)"#
        );
        assert_eq!(s.params, texts(&["c1"]));
        let s = build_change(Dialect::MySql, &info("shop"), &c).unwrap();
        assert_eq!(
            s.sql,
            "INSERT INTO `shop`.`order` (`code`, `amount`) VALUES (?, NULL)"
        );
    }

    #[test]
    fn insert_of_defaults_only() {
        let c = RowChange::Insert {
            values: set(&[("id", EditValue::Default)]),
        };
        for (d, schema, want) in [
            (
                Dialect::Postgres,
                "public",
                r#"INSERT INTO "public"."order" DEFAULT VALUES"#,
            ),
            (
                Dialect::Sqlite,
                "main",
                r#"INSERT INTO "main"."order" DEFAULT VALUES"#,
            ),
            (
                Dialect::MySql,
                "shop",
                "INSERT INTO `shop`.`order` () VALUES ()",
            ),
        ] {
            let s = build_change(d, &info(schema), &c).unwrap();
            assert_eq!(s.sql, want);
            assert!(s.params.is_empty());
            let empty = RowChange::Insert { values: vec![] };
            assert_eq!(build_change(d, &info(schema), &empty).unwrap().sql, want);
        }
    }

    #[test]
    fn delete_converts_key_values_to_text() {
        let mut t = info("public");
        t.row_key = Some(
            ["b", "big", "dec", "f", "ts", "j", "bin"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        );
        for (n, ty) in [
            ("b", "boolean"),
            ("big", "bigint"),
            ("dec", "numeric"),
            ("f", "double precision"),
            ("ts", "timestamp without time zone"),
            ("j", "jsonb"),
            ("bin", "bytea"),
        ] {
            t.columns.push(column(n, ty, ty));
        }
        let c = RowChange::Delete {
            key: key(&[
                ("b", CellValue::Bool(true)),
                ("big", CellValue::BigInt("9007199254740993".into())),
                ("dec", CellValue::Decimal("12.30".into())),
                ("f", CellValue::Float(0.1)),
                ("ts", CellValue::Temporal("2024-02-29 13:45:01".into())),
                ("j", CellValue::Json(r#"{"a": 1}"#.into())),
                (
                    "bin",
                    CellValue::Bytes {
                        len: 2,
                        hex_preview: "dead".into(),
                    },
                ),
            ]),
        };
        let s = build_change(Dialect::Postgres, &t, &c).unwrap();
        assert_eq!(
            s.sql,
            r#"DELETE FROM "public"."order" WHERE "b" = CAST($1::text AS boolean) AND "big" = CAST($2::text AS bigint) AND "dec" = CAST($3::text AS numeric) AND "f" = CAST($4::text AS double precision) AND "ts" = CAST($5::text AS timestamp without time zone) AND "j" = CAST($6::text AS jsonb) AND "bin" = $7"#
        );
        let mut want = texts(&[
            "true",
            "9007199254740993",
            "12.30",
            "0.1",
            "2024-02-29 13:45:01",
            r#"{"a": 1}"#,
        ]);
        want.push(SqlParam::Bytes(vec![0xde, 0xad]));
        assert_eq!(s.params, want);

        // Booleans are 1 / 0 outside PostgreSQL; bytes stay native.
        let s = build_change(Dialect::MySql, &t, &c).unwrap();
        assert_eq!(s.params[0], SqlParam::Text("1".into()));
        assert_eq!(s.params[6], SqlParam::Bytes(vec![0xde, 0xad]));
        assert!(s.sql.ends_with("AND `bin` = ?"), "{}", s.sql);
        let mut c = c;
        if let RowChange::Delete { key } = &mut c {
            key.0[0].1 = CellValue::Bool(false);
        }
        let s = build_change(Dialect::Sqlite, &t, &c).unwrap();
        assert_eq!(s.params[0], SqlParam::Text("0".into()));
    }

    #[test]
    fn float_key_round_trips() {
        let mut t = info("public");
        t.columns.push(column("f", "real", "real"));
        t.row_key = Some(vec!["f".into()]);
        for f in [0.1f64, 1e300, -2.5e-12, 3.0] {
            let c = RowChange::Delete {
                key: key(&[("f", CellValue::Float(f))]),
            };
            let s = build_change(Dialect::Sqlite, &t, &c).unwrap();
            let SqlParam::Text(p) = &s.params[0] else {
                panic!("text param")
            };
            assert_eq!(p.parse::<f64>().unwrap(), f, "{p}");
        }
    }

    #[test]
    fn tricky_identifiers_are_quoted_and_survive_the_preview() {
        let mut t = info("public");
        t.object.name = "we\"ird`$1?".into();
        t.columns.push(column("a$1", "text", "text"));
        t.columns.push(column("q?", "text", "text"));
        let c = RowChange::Update {
            key: std_key(),
            set: set(&[("a$1", text("x")), ("q?", text("y"))]),
        };
        let s = build_change(Dialect::Postgres, &t, &c).unwrap();
        assert_eq!(
            s.sql,
            r#"UPDATE "public"."we""ird`$1?" SET "a$1" = CAST($1::text AS text), "q?" = CAST($2::text AS text) WHERE "id" = CAST($3::text AS integer) AND "code" = CAST($4::text AS text)"#
        );
        assert_eq!(
            render_preview(Dialect::Postgres, &s),
            r#"UPDATE "public"."we""ird`$1?" SET "a$1" = CAST('x'::text AS text), "q?" = CAST('y'::text AS text) WHERE "id" = CAST('7'::text AS integer) AND "code" = CAST('a''b'::text AS text)"#
        );
        let s = build_change(Dialect::MySql, &t, &c).unwrap();
        assert_eq!(
            s.sql,
            "UPDATE `public`.`we\"ird``$1?` SET `a$1` = ?, `q?` = ? WHERE `id` = ? AND `code` = ?"
        );
        assert_eq!(
            render_preview(Dialect::MySql, &s),
            "UPDATE `public`.`we\"ird``$1?` SET `a$1` = 'x', `q?` = 'y' WHERE `id` = '7' AND `code` = 'a''b'"
        );
        let s = build_change(Dialect::Sqlite, &t, &c).unwrap();
        assert_eq!(
            render_preview(Dialect::Sqlite, &s),
            r#"UPDATE "public"."we""ird`$1?" SET "a$1" = 'x', "q?" = 'y' WHERE "id" = '7' AND "code" = 'a''b'"#
        );
    }

    #[test]
    fn preview_escapes_literals_and_is_never_the_bound_sql() {
        let c = RowChange::Update {
            key: std_key(),
            set: set(&[("note", text("it's '; DROP TABLE x; --"))]),
        };
        for (d, schema) in [
            (Dialect::Postgres, "public"),
            (Dialect::MySql, "shop"),
            (Dialect::Sqlite, "main"),
        ] {
            let s = build_change(d, &info(schema), &c).unwrap();
            let p = render_preview(d, &s);
            assert_ne!(p, s.sql);
            assert!(p.contains("'it''s ''; DROP TABLE x; --'"), "{p}");
            assert!(!p.contains('?') && !p.contains("$1"), "{p}");
        }
        let bytes = Statement {
            sql: "DELETE FROM t WHERE b = $1 AND c = $2".into(),
            params: vec![
                SqlParam::Bytes(vec![0xde, 0xad]),
                SqlParam::Text("x".into()),
            ],
        };
        assert_eq!(
            render_preview(Dialect::Postgres, &bytes),
            r"DELETE FROM t WHERE b = '\xdead' AND c = 'x'"
        );
        let bytes = Statement {
            sql: "DELETE FROM t WHERE b = ?".into(),
            params: vec![SqlParam::Bytes(vec![0x00, 0xff])],
        };
        assert_eq!(
            render_preview(Dialect::MySql, &bytes),
            "DELETE FROM t WHERE b = X'00ff'"
        );
        assert_eq!(
            render_preview(Dialect::Sqlite, &bytes),
            "DELETE FROM t WHERE b = X'00ff'"
        );
        // MySQL: backslashes are escapes under the default sql_mode, so they are doubled
        // (a quote after a backslash must not close the literal).
        let tricky = Statement {
            sql: "DELETE FROM t WHERE a = ? AND b = ?".into(),
            params: texts(&[r"C:\new", r"\'; DROP TABLE users; -- "]),
        };
        assert_eq!(
            render_preview(Dialect::MySql, &tricky),
            r"DELETE FROM t WHERE a = 'C:\\new' AND b = '\\''; DROP TABLE users; -- '"
        );
        assert_eq!(
            render_preview(Dialect::Sqlite, &tricky),
            r"DELETE FROM t WHERE a = 'C:\new' AND b = '\''; DROP TABLE users; -- '"
        );
        // $10 is the tenth parameter, not $1 followed by 0.
        let many = Statement {
            sql: (1..=10)
                .map(|i| format!("${i}"))
                .collect::<Vec<_>>()
                .join(","),
            params: (1..=10).map(|i| SqlParam::Text(format!("v{i}"))).collect(),
        };
        assert_eq!(
            render_preview(Dialect::Postgres, &many),
            "'v1','v2','v3','v4','v5','v6','v7','v8','v9','v10'"
        );
    }

    #[test]
    fn refuses_read_only_tables() {
        let mut view = info("public");
        view.kind = ObjectKind::View;
        assert_eq!(
            err(Dialect::Postgres, &view, &update()),
            "table is read-only: it is a view"
        );
        let mut keyless = info("public");
        keyless.row_key = None;
        assert_eq!(
            err(Dialect::Postgres, &keyless, &update()),
            "table is read-only: no primary key or unique index on NOT NULL columns"
        );
        assert_eq!(
            err(
                Dialect::Postgres,
                &keyless,
                &RowChange::Insert { values: vec![] }
            ),
            "table is read-only: no primary key or unique index on NOT NULL columns"
        );
    }

    #[test]
    fn refuses_bad_columns_and_values() {
        let t = info("public");
        let d = Dialect::Postgres;
        let upd = |s: Vec<(String, EditValue)>| RowChange::Update {
            key: std_key(),
            set: s,
        };
        assert_eq!(
            err(d, &t, &upd(set(&[("nope", text("x"))]))),
            "unknown column nope"
        );
        assert_eq!(
            err(d, &t, &upd(set(&[("upper_note", text("x"))]))),
            "upper_note is a generated column"
        );
        assert_eq!(
            err(
                d,
                &t,
                &RowChange::Insert {
                    values: set(&[("upper_note", text("x"))])
                }
            ),
            "upper_note is a generated column"
        );
        assert_eq!(
            err(
                d,
                &t,
                &RowChange::Insert {
                    values: set(&[("nope", EditValue::Default)])
                }
            ),
            "unknown column nope"
        );
        assert_eq!(
            err(d, &t, &upd(set(&[("note", EditValue::Default)]))),
            "DEFAULT is only allowed in an insert"
        );
        assert_eq!(
            err(
                d,
                &t,
                &upd(set(&[("note", text("a")), ("note", text("b"))]))
            ),
            "note is set twice"
        );
        assert_eq!(err(d, &t, &upd(vec![])), "nothing to update");
    }

    #[test]
    fn refuses_text_in_binary_columns() {
        let t = info("public");
        let d = Dialect::Postgres;
        let upd = RowChange::Update {
            key: std_key(),
            set: set(&[("data", text("\\xdead"))]),
        };
        assert_eq!(err(d, &t, &upd), "binary columns can't be edited as text");
        let ins = RowChange::Insert {
            values: set(&[("code", text("a")), ("data", text("00"))]),
        };
        assert_eq!(err(d, &t, &ins), "binary columns can't be edited as text");
        // NULL and DEFAULT carry no text: allowed.
        let null = RowChange::Update {
            key: std_key(),
            set: set(&[("data", EditValue::Null)]),
        };
        assert!(build_change(d, &t, &null).is_ok());
        let default = RowChange::Insert {
            values: set(&[("code", text("a")), ("data", EditValue::Default)]),
        };
        assert!(build_change(d, &t, &default).is_ok());
    }

    #[test]
    fn refuses_unusable_keys() {
        let t = info("public");
        let d = Dialect::Postgres;
        let del = |k: RowKey| RowChange::Delete { key: k };
        assert_eq!(
            err(d, &t, &del(key(&[("id", CellValue::Int(1))]))),
            "row key is incomplete: code is missing"
        );
        assert_eq!(
            err(
                d,
                &t,
                &del(key(&[
                    ("id", CellValue::Int(1)),
                    ("code", CellValue::Text("x".into())),
                    ("note", CellValue::Text("y".into())),
                ]))
            ),
            "note is not part of the row key"
        );
        assert_eq!(
            err(
                d,
                &t,
                &del(key(&[
                    ("id", CellValue::Int(1)),
                    ("id", CellValue::Int(2)),
                    ("code", CellValue::Text("x".into())),
                ]))
            ),
            "row key column id is given twice"
        );
        assert_eq!(
            err(
                d,
                &t,
                &del(key(&[
                    ("id", CellValue::Null),
                    ("code", CellValue::Text("x".into())),
                ]))
            ),
            "row has a NULL key: it cannot be edited"
        );
        assert_eq!(
            err(
                d,
                &t,
                &del(key(&[
                    ("id", CellValue::Int(1)),
                    (
                        "code",
                        CellValue::LongText {
                            preview: "x".into(),
                            len: 20_000
                        }
                    ),
                ]))
            ),
            "row key value of code is truncated: it cannot be edited"
        );
        let mut bin = info("public");
        bin.row_key = Some(vec!["data".into()]);
        assert_eq!(
            err(
                d,
                &bin,
                &del(key(&[(
                    "data",
                    CellValue::Bytes {
                        len: 65,
                        hex_preview: "00".repeat(64)
                    }
                )]))
            ),
            "row key value of data is truncated: it cannot be edited"
        );
        // Exactly 64 bytes is complete.
        let s = build_change(
            d,
            &bin,
            &del(key(&[(
                "data",
                CellValue::Bytes {
                    len: 64,
                    hex_preview: "ab".repeat(64),
                },
            )])),
        )
        .unwrap();
        assert_eq!(s.params, vec![SqlParam::Bytes(vec![0xab; 64])]);
    }

    #[test]
    fn cell_statements_select_one_column_by_key() {
        let t = info("public");
        let k = std_key();
        let s = build_cell_value(Dialect::Postgres, &t, &k, "note").unwrap();
        assert_eq!(
            s.sql,
            r#"SELECT "note" FROM "public"."order" WHERE "id" = CAST($1::text AS integer) AND "code" = CAST($2::text AS text)"#
        );
        assert_eq!(s.params, texts(&["7", "a'b"]));
        let s = build_cell_size(Dialect::Postgres, &t, &k, "note")
            .unwrap()
            .unwrap();
        assert!(
            s.sql.starts_with(
                r#"SELECT octet_length(CAST("note" AS text)) FROM "public"."order" WHERE"#
            ),
            "{}",
            s.sql
        );
        // Bytes are always a preview: no size to check (any dialect's binary type).
        assert!(
            build_cell_size(Dialect::Postgres, &t, &k, "data")
                .unwrap()
                .is_none()
        );
        let mut my = info("shop");
        my.columns[5].type_name = "varbinary(16)".into();
        assert!(
            build_cell_size(Dialect::MySql, &my, &k, "data")
                .unwrap()
                .is_none()
        );
        let mut lite = info("main");
        lite.columns[5].type_name = "BLOB".into();
        assert!(
            build_cell_size(Dialect::Sqlite, &lite, &k, "data")
                .unwrap()
                .is_none()
        );
        let s = build_cell_size(Dialect::MySql, &info("shop"), &k, "note")
            .unwrap()
            .unwrap();
        assert!(
            s.sql.starts_with("SELECT OCTET_LENGTH(`note`) FROM"),
            "{}",
            s.sql
        );
        let s = build_cell_size(Dialect::Sqlite, &info("main"), &k, "note")
            .unwrap()
            .unwrap();
        assert!(
            s.sql
                .starts_with(r#"SELECT length(CAST("note" AS BLOB)) FROM"#),
            "{}",
            s.sql
        );
        // Generated columns can be read.
        assert!(build_cell_value(Dialect::Sqlite, &info("main"), &k, "upper_note").is_ok());
        let e = build_cell_value(Dialect::Sqlite, &info("main"), &k, "nope").unwrap_err();
        assert_eq!(
            (e.kind, e.message.as_str()),
            (ErrorKind::Invalid, "unknown column nope")
        );
        let mut view = info("main");
        view.kind = ObjectKind::View;
        view.row_key = None;
        assert_eq!(
            build_cell_value(Dialect::Sqlite, &view, &k, "note")
                .unwrap_err()
                .kind,
            ErrorKind::Invalid
        );
    }

    #[test]
    fn serde_shapes() {
        use serde_json::json;
        assert_eq!(
            serde_json::to_value(text("x")).unwrap(),
            json!({"t": "text", "v": "x"})
        );
        assert_eq!(
            serde_json::to_value(EditValue::Default).unwrap(),
            json!({"t": "default"})
        );
        let c: RowChange = serde_json::from_value(json!({
            "kind": "update",
            "key": [["id", {"t": "int", "v": 7}], ["code", {"t": "text", "v": "a'b"}]],
            "set": [["amount", {"t": "text", "v": "12.30"}], ["note", {"t": "null"}]]
        }))
        .unwrap();
        assert_eq!(c, update());
        let c: RowChange = serde_json::from_value(json!({
            "kind": "insert", "values": [["id", {"t": "default"}]]
        }))
        .unwrap();
        assert!(!c.expects_one_row());
        let c: RowChange = serde_json::from_value(json!({
            "kind": "delete",
            "key": [["data", {"t": "bytes", "v": {"len": 1, "hexPreview": "00"}}]]
        }))
        .unwrap();
        assert!(c.expects_one_row());
        let o = ApplyOutcome {
            applied: false,
            affected: vec![1, 0],
            failed_index: Some(1),
            error: Some(AppError::new(ErrorKind::Query, STALE_ROW)),
        };
        assert_eq!(
            serde_json::to_value(&o).unwrap(),
            json!({
                "applied": false, "affected": [1, 0], "failedIndex": 1,
                "error": {"kind": "query", "message": STALE_ROW}
            })
        );
    }

    #[test]
    fn record_enforces_exactly_one_row() {
        let mut affected = vec![];
        assert!(record(0, true, Ok(1), &mut affected).is_ok());
        assert!(record(1, false, Ok(3), &mut affected).is_ok());
        match record(2, true, Ok(0), &mut affected) {
            Err(Halt::Failed(o)) => {
                assert!(!o.applied);
                assert_eq!(o.affected, vec![1, 3, 0]);
                assert_eq!(o.failed_index, Some(2));
                let e = o.error.unwrap();
                assert_eq!((e.kind, e.message.as_str()), (ErrorKind::Query, STALE_ROW));
            }
            _ => panic!("0 rows must fail"),
        }
        let mut affected = vec![];
        assert!(matches!(
            record(0, true, Ok(2), &mut affected),
            Err(Halt::Failed(_))
        ));
        match record(
            4,
            true,
            Err(AppError::new(ErrorKind::Query, "boom")),
            &mut vec![1],
        ) {
            Err(Halt::Failed(o)) => {
                assert_eq!(o.affected, vec![1]);
                assert_eq!(o.failed_index, Some(4));
                assert_eq!(o.error.unwrap().message, "boom");
            }
            _ => panic!("a statement error fails the outcome"),
        }
        for kind in [ErrorKind::ConnectionLost, ErrorKind::Cancelled] {
            match record(0, true, Err(AppError::new(kind, "x")), &mut vec![]) {
                Err(Halt::Abort(e)) => assert_eq!(e.kind, kind),
                _ => panic!("{kind:?} aborts"),
            }
        }
        let o = applied(vec![1, 1]);
        assert!(o.applied && o.failed_index.is_none() && o.error.is_none());
        let o = commit_failed(vec![1], AppError::new(ErrorKind::Query, "deferred")).unwrap();
        assert!(!o.applied && o.failed_index.is_none());
        assert_eq!(o.error.unwrap().message, "deferred");
        assert_eq!(
            commit_failed(vec![], AppError::new(ErrorKind::ConnectionLost, "x"))
                .unwrap_err()
                .kind,
            ErrorKind::ConnectionLost
        );
        let e = commit_failed(vec![], AppError::new(ErrorKind::Connection, "y")).unwrap_err();
        assert_eq!((e.kind, e.message.as_str()), (ErrorKind::Connection, "y"));
        let one = Statement {
            sql: "x".into(),
            params: vec![],
        };
        assert!(check_apply_args(std::slice::from_ref(&one), &[true]).is_ok());
        assert_eq!(
            check_apply_args(&[one], &[]).unwrap_err().kind,
            ErrorKind::Invalid
        );
    }

    /// A cancel (MySQL KILL QUERY → error 1317) that lands on COMMIT does not mean nothing
    /// was written: the COMMIT may have completed. Reported as an unknown outcome.
    #[test]
    fn interrupted_commit_is_an_unknown_outcome() {
        let e = commit_failed(
            vec![1, 1],
            AppError::new(ErrorKind::Cancelled, "interrupted"),
        )
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Connection);
        assert_eq!(e.message, COMMIT_INTERRUPTED);
        assert_eq!(
            COMMIT_INTERRUPTED,
            "the commit was interrupted: whether it was written is unknown"
        );
    }

    #[test]
    fn schema_change_errors() {
        let q = |m: &str| AppError::new(ErrorKind::Query, m);
        for m in [
            "Unknown column 'v' in 'field list'",
            "no such column: v",
            "no such table: main.t",
            r#"column "v" of relation "t" does not exist"#,
            r#"relation "s.t" does not exist"#,
            "Table 'db.t' doesn't exist",
        ] {
            assert!(suggests_schema_change(&q(m)), "{m}");
        }
        for m in [STALE_ROW, "duplicate key value violates unique constraint"] {
            assert!(!suggests_schema_change(&q(m)), "{m}");
        }
        assert!(!suggests_schema_change(&AppError::new(
            ErrorKind::ConnectionLost,
            "no such table"
        )));
    }
}

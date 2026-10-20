//! Parameterized statements for the grid: one page of a table (filters, order, limit) and
//! its capped filtered count. Every value typed by the user is a bound parameter; only
//! identifiers (always quoted) and the explicit "Raw SQL" filter are written into the SQL.
//!
//! PostgreSQL binds each value as text and casts it to the column's type without its
//! modifier (`CAST($n::text AS numeric)` for `numeric(12,2)`: a typmod cast would round or
//! truncate the value before comparing), so the server parses it like a literal. MySQL and
//! SQLite bind the text as is (`?`) and convert it with their own comparison rules.
//!
//! Filters are joined by AND (default) or OR ([`FilterCombine`]); with OR each filter is
//! written between its own parentheses, so no condition can bind to its neighbour.
//!
//! LIKE patterns escape with `!` (`ESCAPE '!'`): a backslash literal would depend on
//! MySQL's NO_BACKSLASH_ESCAPES and PostgreSQL's standard_conforming_strings.

use serde::{Deserialize, Serialize};

use super::meta::TableInfo;
use super::sql::{qualified, quote_ident};
use super::{Dialect, PageRequest, ResultSet, RowCount, SortDir};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::value::CellValue;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "camelCase")]
pub enum SqlParam {
    Text(String),
    Bytes(Vec<u8>),
}

/// SQL with its bound parameters (`$n` on PostgreSQL, `?` elsewhere, in order).
#[derive(Clone, PartialEq)]
pub struct Statement {
    pub sql: String,
    pub params: Vec<SqlParam>,
}

/// Prints the SQL and the parameter count only: values are user data.
impl std::fmt::Debug for Statement {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Statement {{ sql: {:?}, params: <{}> }}",
            self.sql,
            self.params.len()
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterOp {
    Eq,
    Neq,
    Lt,
    Gt,
    Lte,
    Gte,
    In,
    NotIn,
    Between,
    NotBetween,
    Like,
    NotLike,
    Ilike,
    Contains,
    NotContains,
    IsNull,
    IsNotNull,
    /// `values[0]` is written as is between parentheses (the user's own SQL).
    Raw,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    /// `None` = any column (`Eq`, `Contains`, `NotContains`, `Like` only).
    pub column: Option<String>,
    pub op: FilterOp,
    pub values: Vec<String>,
}

/// How the filters of a page are joined. Absent from older frontends: `And`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterCombine {
    #[default]
    And,
    Or,
}

/// `SELECT * FROM t [WHERE …] [ORDER BY …] LIMIT n OFFSET m`. The order is the explicit
/// sort, then the default order (row key, else SQLite's rowid) as a tiebreaker so OFFSET
/// paging stays stable; without a key or rowid, the sort alone (or no ORDER BY).
pub fn build_page(d: Dialect, info: &TableInfo, req: &PageRequest) -> AppResult<Statement> {
    let mut b = Builder::new(d);
    b.sql = format!("SELECT * FROM {}", qualified(d, &info.object));
    b.push_where(info, &req.filters, req.combine)?;
    let mut order = Vec::new();
    if let Some((col, dir)) = &req.sort {
        known_column(info, col)?;
        let dir = match dir {
            SortDir::Asc => "ASC",
            SortDir::Desc => "DESC",
        };
        order.push(format!("{} {dir}", quote_ident(d, col)));
    }
    let sorted = req.sort.as_ref().map(|(c, _)| c.as_str());
    order.extend(
        default_order(d, info)
            .into_iter()
            .filter(|(name, _)| Some(name.as_str()) != sorted)
            .map(|(_, sql)| sql),
    );
    if !order.is_empty() {
        b.sql.push_str(" ORDER BY ");
        b.sql.push_str(&order.join(", "));
    }
    b.sql
        .push_str(&format!(" LIMIT {} OFFSET {}", req.limit, req.offset));
    Ok(b.finish())
}

/// The WHERE clause [`build_page`] writes for `filters` joined by `combine` (`WHERE …`, or
/// "" without filters), with its placeholders: the values are never written into it. A
/// read-only preview (the filter bar's SQL button), refused like the page (unknown column,
/// wrong value count, blank raw SQL).
pub fn where_preview(
    d: Dialect,
    info: &TableInfo,
    filters: &[Filter],
    combine: FilterCombine,
) -> AppResult<String> {
    let mut b = Builder::new(d);
    b.push_where(info, filters, combine)?;
    Ok(b.sql.trim_start().to_string())
}

/// `SELECT COUNT(*) FROM (SELECT 1 FROM t WHERE … LIMIT cap) AS t`: counts at most `cap`
/// rows (see [`read_count`]), the filters joined like the page's.
pub fn build_filtered_count(
    d: Dialect,
    info: &TableInfo,
    filters: &[Filter],
    combine: FilterCombine,
    cap: u64,
) -> AppResult<Statement> {
    let mut b = Builder::new(d);
    b.sql = format!(
        "SELECT COUNT(*) FROM (SELECT 1 FROM {}",
        qualified(d, &info.object)
    );
    b.push_where(info, filters, combine)?;
    b.sql.push_str(&format!(" LIMIT {cap}) AS t"));
    Ok(b.finish())
}

/// The result of a [`build_filtered_count`] statement: `Exact(n)` below `cap`, else
/// `Estimate(cap - 1)` (shown as "at least").
pub fn read_count(rs: &ResultSet, cap: u64) -> AppResult<RowCount> {
    let n = match rs.rows.first().and_then(|r| r.first()) {
        Some(CellValue::Int(n)) => (*n).max(0) as u64,
        Some(CellValue::BigInt(s) | CellValue::Decimal(s)) => s.parse().unwrap_or(u64::MAX),
        _ => return Err(AppError::new(ErrorKind::Query, "count returned no value")),
    };
    Ok(if n >= cap {
        RowCount::Estimate(cap.saturating_sub(1))
    } else {
        RowCount::Exact(n)
    })
}

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Invalid, msg)
}

fn known_column(info: &TableInfo, name: &str) -> AppResult<()> {
    match info.column(name) {
        Some(_) => Ok(()),
        None => Err(invalid(format!("unknown column {name}"))),
    }
}

/// The default order as (column name, SQL) pairs: the row key, else SQLite's rowid.
fn default_order(d: Dialect, info: &TableInfo) -> Vec<(String, String)> {
    if let Some(key) = info.row_key.as_ref().filter(|k| !k.is_empty()) {
        return key.iter().map(|c| (c.clone(), quote_ident(d, c))).collect();
    }
    if d == Dialect::Sqlite && info.has_rowid {
        // A real column may shadow one of the rowid's names.
        return ["rowid", "_rowid_", "oid"]
            .into_iter()
            .find(|alias| {
                !info
                    .columns
                    .iter()
                    .any(|c| c.name.eq_ignore_ascii_case(alias))
            })
            .map(|a| vec![(a.to_string(), a.to_string())])
            .unwrap_or_default();
    }
    Vec::new()
}

/// Binary column types by name (MySQL/MariaDB, SQLite, plain PostgreSQL `bytea`): what
/// the drivers use to set `ColumnInfo::binary` (PostgreSQL also resolves domains).
pub(super) fn is_binary(d: Dialect, type_name: &str) -> bool {
    let t = type_name.trim().to_ascii_lowercase();
    match d {
        Dialect::Postgres => t == "bytea",
        Dialect::MySql => {
            let base = t.split(['(', ' ']).next().unwrap_or("");
            matches!(
                base,
                "binary"
                    | "varbinary"
                    | "tinyblob"
                    | "blob"
                    | "mediumblob"
                    | "longblob"
                    | "bit"
                    | "geometry"
                    | "point"
                    | "linestring"
                    | "polygon"
                    | "multipoint"
                    | "multilinestring"
                    | "multipolygon"
                    | "geometrycollection"
                    | "geomcollection"
            )
        }
        // SQLite: a declared type containing BLOB has BLOB affinity.
        Dialect::Sqlite => t.contains("blob"),
    }
}

/// Accumulates SQL and its parameters, binding values in textual order (also used by
/// `dml`).
pub(super) struct Builder {
    pub(super) d: Dialect,
    pub(super) sql: String,
    params: Vec<SqlParam>,
}

impl Builder {
    pub(super) fn new(d: Dialect) -> Self {
        Builder {
            d,
            sql: String::new(),
            params: Vec::new(),
        }
    }

    pub(super) fn finish(self) -> Statement {
        Statement {
            sql: self.sql,
            params: self.params,
        }
    }

    /// Binds `p` and returns its placeholder (`$n` / `?`).
    fn push(&mut self, p: SqlParam) -> String {
        self.params.push(p);
        match self.d {
            Dialect::Postgres => format!("${}", self.params.len()),
            Dialect::MySql | Dialect::Sqlite => "?".into(),
        }
    }

    fn bind(&mut self, v: &str) -> String {
        self.push(SqlParam::Text(v.to_string()))
    }

    /// Bytes, bound natively (the column's type decides, no cast).
    pub(super) fn bytes(&mut self, b: Vec<u8>) -> String {
        self.push(SqlParam::Bytes(b))
    }

    /// A value compared with (or written to) a column whose type without modifier is
    /// `base_type`.
    pub(super) fn typed(&mut self, v: &str, base_type: &str) -> String {
        let p = self.bind(v);
        match self.d {
            Dialect::Postgres => format!("CAST({p}::text AS {base_type})"),
            Dialect::MySql | Dialect::Sqlite => p,
        }
    }

    /// A pattern (LIKE right-hand side).
    fn text(&mut self, v: &str) -> String {
        let p = self.bind(v);
        match self.d {
            Dialect::Postgres => format!("{p}::text"),
            Dialect::MySql | Dialect::Sqlite => p,
        }
    }

    /// `%value%` with the value's own `!`, `%` and `_` escaped (`ESCAPE '!'`).
    fn contains_pattern(&mut self, v: &str) -> String {
        let escaped = v.replace('!', "!!").replace('%', "!%").replace('_', "!_");
        let p = self.text(&escaped);
        match self.d {
            Dialect::MySql => format!("CONCAT('%', {p}, '%')"),
            Dialect::Postgres | Dialect::Sqlite => format!("'%' || {p} || '%'"),
        }
    }

    fn escape_clause(&self) -> &'static str {
        " ESCAPE '!'"
    }

    /// A column as text (any-column search, and LIKE on PostgreSQL where non-text types
    /// have no LIKE operator).
    fn as_text(&self, quoted: &str) -> String {
        let ty = match self.d {
            Dialect::Postgres => "text",
            Dialect::MySql => "CHAR",
            Dialect::Sqlite => "TEXT",
        };
        format!("CAST({quoted} AS {ty})")
    }

    /// ` WHERE c1 AND c2…`, or ` WHERE (c1) OR (c2)…`: under OR every condition has its
    /// own parentheses (a raw SQL condition keeps its own as well).
    fn push_where(
        &mut self,
        info: &TableInfo,
        filters: &[Filter],
        combine: FilterCombine,
    ) -> AppResult<()> {
        let mut conds = Vec::with_capacity(filters.len());
        for f in filters {
            let c = self.condition(info, f)?;
            conds.push(match combine {
                FilterCombine::And => c,
                FilterCombine::Or => format!("({c})"),
            });
        }
        if !conds.is_empty() {
            self.sql.push_str(" WHERE ");
            self.sql.push_str(&conds.join(match combine {
                FilterCombine::And => " AND ",
                FilterCombine::Or => " OR ",
            }));
        }
        Ok(())
    }

    fn condition(&mut self, info: &TableInfo, f: &Filter) -> AppResult<String> {
        if f.op == FilterOp::Raw {
            return match f.values.as_slice() {
                // Own lines: a trailing `--` comment cannot swallow the parenthesis.
                [sql] if !sql.trim().is_empty() => Ok(format!("(\n{sql}\n)")),
                _ => Err(invalid("filter on raw SQL: expected 1 value(s)")),
            };
        }
        match &f.column {
            Some(col) => self.column_condition(info, col, f),
            None => self.any_column_condition(info, f),
        }
    }

    fn column_condition(&mut self, info: &TableInfo, col: &str, f: &Filter) -> AppResult<String> {
        let column = info
            .column(col)
            .ok_or_else(|| invalid(format!("unknown column {col}")))?;
        check_values(col, f)?;
        let ty = column.base_type.as_str();
        let q = quote_ident(self.d, col);
        let v = &f.values;
        use FilterOp::*;
        Ok(match f.op {
            Eq | Neq | Lt | Gt | Lte | Gte => {
                let op = match f.op {
                    Eq => "=",
                    Neq => "<>",
                    Lt => "<",
                    Gt => ">",
                    Lte => "<=",
                    _ => ">=",
                };
                format!("{q} {op} {}", self.typed(&v[0], ty))
            }
            In | NotIn => {
                let list: Vec<String> = v.iter().map(|x| self.typed(x, ty)).collect();
                let not = if f.op == NotIn { "NOT " } else { "" };
                format!("{q} {not}IN ({})", list.join(", "))
            }
            Between | NotBetween => {
                let (lo, hi) = (self.typed(&v[0], ty), self.typed(&v[1], ty));
                let not = if f.op == NotBetween { "NOT " } else { "" };
                format!("{q} {not}BETWEEN {lo} AND {hi}")
            }
            Like | NotLike | Ilike => {
                let op = match (f.op, self.d) {
                    (NotLike, _) => "NOT LIKE",
                    (Ilike, Dialect::Postgres) => "ILIKE",
                    _ => "LIKE",
                };
                let lhs = self.pattern_lhs(&q);
                format!("{lhs} {op} {}", self.text(&v[0]))
            }
            Contains | NotContains => {
                let op = if f.op == NotContains {
                    "NOT LIKE"
                } else {
                    "LIKE"
                };
                let lhs = self.pattern_lhs(&q);
                let pat = self.contains_pattern(&v[0]);
                format!("{lhs} {op} {pat}{}", self.escape_clause())
            }
            IsNull => format!("{q} IS NULL"),
            IsNotNull => format!("{q} IS NOT NULL"),
            Raw => unreachable!("handled by condition"),
        })
    }

    /// LIKE's left-hand side: PostgreSQL has no LIKE on non-text types.
    fn pattern_lhs(&self, quoted: &str) -> String {
        match self.d {
            Dialect::Postgres => self.as_text(quoted),
            Dialect::MySql | Dialect::Sqlite => quoted.to_string(),
        }
    }

    /// `(CAST(c1 AS text) <op> … OR …)` over the non-binary columns; `NotContains` is
    /// joined by AND and lets NULL cells through (a NULL contains nothing).
    fn any_column_condition(&mut self, info: &TableInfo, f: &Filter) -> AppResult<String> {
        use FilterOp::*;
        if !matches!(f.op, Eq | Contains | NotContains | Like) {
            return Err(invalid(format!(
                "filter on all columns: {:?} needs a column",
                f.op
            )));
        }
        if f.values.len() != 1 {
            return Err(invalid("filter on all columns: expected 1 value(s)"));
        }
        let v = &f.values[0];
        let mut parts = Vec::new();
        for c in info.columns.iter().filter(|c| !c.binary) {
            let q = quote_ident(self.d, &c.name);
            let lhs = self.as_text(&q);
            parts.push(match f.op {
                Eq => format!("{lhs} = {}", self.text(v)),
                Like => format!("{lhs} LIKE {}", self.text(v)),
                Contains => {
                    let pat = self.contains_pattern(v);
                    format!("{lhs} LIKE {pat}{}", self.escape_clause())
                }
                _ => {
                    let pat = self.contains_pattern(v);
                    format!(
                        "({q} IS NULL OR {lhs} NOT LIKE {pat}{})",
                        self.escape_clause()
                    )
                }
            });
        }
        let (join, empty) = if f.op == NotContains {
            (" AND ", "1 = 1")
        } else {
            (" OR ", "1 = 0")
        };
        if parts.is_empty() {
            return Ok(format!("({empty})"));
        }
        Ok(format!("({})", parts.join(join)))
    }
}

fn check_values(col: &str, f: &Filter) -> AppResult<()> {
    use FilterOp::*;
    let n = f.values.len();
    let (ok, want) = match f.op {
        IsNull | IsNotNull => (n == 0, "0"),
        Between | NotBetween => (n == 2, "2"),
        In | NotIn => (n >= 1, "at least 1"),
        _ => (n == 1, "1"),
    };
    if ok {
        Ok(())
    } else {
        Err(invalid(format!(
            "filter on {col}: expected {want} value(s)"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::meta::ColumnInfo;
    use crate::driver::{ObjectKind, ObjectRef};

    /// `base_type` = `type_name` without its modifier, like PostgreSQL's
    /// `format_type(atttypid, -1)` for these simple types.
    fn column(name: &str, type_name: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.into(),
            type_name: type_name.into(),
            base_type: type_name.split('(').next().unwrap_or("").to_string(),
            nullable: true,
            default: None,
            auto_increment: false,
            generated: false,
            binary: is_binary(Dialect::Postgres, type_name)
                || is_binary(Dialect::MySql, type_name)
                || is_binary(Dialect::Sqlite, type_name),
            comment: None,
        }
    }

    fn info_with(schema: &str, columns: Vec<ColumnInfo>) -> TableInfo {
        TableInfo {
            object: ObjectRef {
                schema: Some(schema.into()),
                name: "order".into(),
            },
            kind: ObjectKind::Table,
            columns,
            primary_key: vec!["id".into()],
            indexes: vec![],
            foreign_keys: vec![],
            row_key: Some(vec!["id".into()]),
            has_rowid: false,
        }
    }

    /// `public.order (id integer, amount numeric(12,2), note text, data bytea)`.
    fn pg_info() -> TableInfo {
        info_with(
            "public",
            vec![
                column("id", "integer"),
                column("amount", "numeric(12,2)"),
                column("note", "text"),
                column("data", "bytea"),
            ],
        )
    }

    fn my_info() -> TableInfo {
        info_with(
            "shop",
            vec![
                column("id", "int"),
                column("note", "text"),
                column("data", "varbinary(16)"),
            ],
        )
    }

    fn f(col: &str, op: FilterOp, values: &[&str]) -> Filter {
        Filter {
            column: Some(col.into()),
            op,
            values: values.iter().map(|v| v.to_string()).collect(),
        }
    }

    fn any(op: FilterOp, v: &str) -> Filter {
        Filter {
            column: None,
            op,
            values: vec![v.into()],
        }
    }

    fn req_with(filters: Vec<Filter>) -> PageRequest {
        PageRequest {
            object: ObjectRef {
                schema: Some("public".into()),
                name: "order".into(),
            },
            limit: 300,
            offset: 0,
            sort: None,
            filters,
            combine: FilterCombine::And,
        }
    }

    fn texts(v: &[&str]) -> Vec<SqlParam> {
        v.iter().map(|s| SqlParam::Text(s.to_string())).collect()
    }

    #[test]
    fn eq_filter_casts_on_postgres() {
        let info = pg_info();
        let s = build_page(
            Dialect::Postgres,
            &info,
            &req_with(vec![f("amount", FilterOp::Eq, &["10.5"])]),
        )
        .unwrap();
        assert_eq!(
            s.sql,
            r#"SELECT * FROM "public"."order" WHERE "amount" = CAST($1::text AS numeric) ORDER BY "id" LIMIT 300 OFFSET 0"#
        );
        assert_eq!(s.params, vec![SqlParam::Text("10.5".into())]);
    }

    #[test]
    fn mysql_and_sqlite_bind_text_as_is() {
        let req = req_with(vec![
            f("id", FilterOp::Gte, &["2"]),
            f("note", FilterOp::Neq, &["x"]),
        ]);
        let s = build_page(Dialect::MySql, &my_info(), &req).unwrap();
        assert_eq!(
            s.sql,
            "SELECT * FROM `shop`.`order` WHERE `id` >= ? AND `note` <> ? ORDER BY `id` LIMIT 300 OFFSET 0"
        );
        assert_eq!(s.params, texts(&["2", "x"]));
        let s = build_page(Dialect::Sqlite, &info_with("main", my_info().columns), &req).unwrap();
        assert_eq!(
            s.sql,
            r#"SELECT * FROM "main"."order" WHERE "id" >= ? AND "note" <> ? ORDER BY "id" LIMIT 300 OFFSET 0"#
        );
    }

    #[test]
    fn contains_escapes_wildcards() {
        let req = req_with(vec![f("note", FilterOp::Contains, &["50%"])]);
        let s = build_page(Dialect::MySql, &my_info(), &req).unwrap();
        assert_eq!(
            s.sql,
            "SELECT * FROM `shop`.`order` WHERE `note` LIKE CONCAT('%', ?, '%') ESCAPE '!' ORDER BY `id` LIMIT 300 OFFSET 0"
        );
        assert_eq!(s.params, texts(&["50!%"]));

        let req = req_with(vec![f("note", FilterOp::NotContains, &["a_b\\c!"])]);
        let s = build_page(Dialect::Postgres, &pg_info(), &req).unwrap();
        assert!(
            s.sql.contains(
                r#"WHERE CAST("note" AS text) NOT LIKE '%' || $1::text || '%' ESCAPE '!' ORDER"#
            ),
            "{}",
            s.sql
        );
        // `!` is the escape character: backslashes are plain data.
        assert_eq!(s.params, texts(&["a!_b\\c!!"]));

        // Like keeps the user's pattern as is; Ilike is plain LIKE outside PostgreSQL.
        let req = req_with(vec![
            f("note", FilterOp::Like, &["a%"]),
            f("note", FilterOp::Ilike, &["B_"]),
        ]);
        let s = build_page(Dialect::Sqlite, &info_with("main", my_info().columns), &req).unwrap();
        assert!(
            s.sql
                .contains(r#"WHERE "note" LIKE ? AND "note" LIKE ? ORDER"#),
            "{}",
            s.sql
        );
        assert_eq!(s.params, texts(&["a%", "B_"]));
        let s = build_page(Dialect::Postgres, &pg_info(), &req).unwrap();
        assert!(
            s.sql.contains(
                r#"WHERE CAST("note" AS text) LIKE $1::text AND CAST("note" AS text) ILIKE $2::text ORDER"#
            ),
            "{}",
            s.sql
        );
    }

    #[test]
    fn in_between_null_and_raw() {
        let req = req_with(vec![
            f("id", FilterOp::In, &["1", "2", "3"]),
            f("amount", FilterOp::NotBetween, &["1", "9.5"]),
            f("note", FilterOp::IsNull, &[]),
            f("note", FilterOp::IsNotNull, &[]),
            Filter {
                column: Some("ignored".into()),
                op: FilterOp::Raw,
                values: vec!["id % 2 = 0 OR note = 'x' -- trailing comment".into()],
            },
            f("id", FilterOp::NotIn, &["7"]),
        ]);
        let s = build_page(Dialect::Postgres, &pg_info(), &req).unwrap();
        assert_eq!(
            s.sql,
            "SELECT * FROM \"public\".\"order\" WHERE \
             \"id\" IN (CAST($1::text AS integer), CAST($2::text AS integer), CAST($3::text AS integer)) \
             AND \"amount\" NOT BETWEEN CAST($4::text AS numeric) AND CAST($5::text AS numeric) \
             AND \"note\" IS NULL AND \"note\" IS NOT NULL \
             AND (\nid % 2 = 0 OR note = 'x' -- trailing comment\n) \
             AND \"id\" NOT IN (CAST($6::text AS integer)) \
             ORDER BY \"id\" LIMIT 300 OFFSET 0"
        );
        assert_eq!(s.params, texts(&["1", "2", "3", "1", "9.5", "7"]));

        let req = req_with(vec![
            f("id", FilterOp::Between, &["1", "5"]),
            f("id", FilterOp::In, &["1", "2", "3"]),
        ]);
        let s = build_page(Dialect::MySql, &my_info(), &req).unwrap();
        assert!(
            s.sql
                .contains("WHERE `id` BETWEEN ? AND ? AND `id` IN (?, ?, ?) ORDER"),
            "{}",
            s.sql
        );
        assert_eq!(s.params.len(), 5);
    }

    #[test]
    fn any_column_contains_skips_binary_columns() {
        let req = req_with(vec![any(FilterOp::Contains, "x")]);
        let s = build_page(Dialect::Postgres, &pg_info(), &req).unwrap();
        assert_eq!(
            s.sql,
            "SELECT * FROM \"public\".\"order\" WHERE (\
             CAST(\"id\" AS text) LIKE '%' || $1::text || '%' ESCAPE '!' \
             OR CAST(\"amount\" AS text) LIKE '%' || $2::text || '%' ESCAPE '!' \
             OR CAST(\"note\" AS text) LIKE '%' || $3::text || '%' ESCAPE '!') \
             ORDER BY \"id\" LIMIT 300 OFFSET 0"
        );
        assert_eq!(s.params, texts(&["x", "x", "x"]));

        let s = build_page(Dialect::MySql, &my_info(), &req).unwrap();
        assert!(
            s.sql.contains(
                "WHERE (CAST(`id` AS CHAR) LIKE CONCAT('%', ?, '%') ESCAPE '!' \
                 OR CAST(`note` AS CHAR) LIKE CONCAT('%', ?, '%') ESCAPE '!') ORDER"
            ),
            "{}",
            s.sql
        );
        assert!(!s.sql.contains("`data`"), "{}", s.sql);

        let sq = info_with(
            "main",
            vec![
                column("id", "INTEGER"),
                column("pic", "BLOB"),
                column("n", ""),
            ],
        );
        let s = build_page(
            Dialect::Sqlite,
            &sq,
            &req_with(vec![any(FilterOp::Eq, "1")]),
        )
        .unwrap();
        assert!(
            s.sql
                .contains(r#"WHERE (CAST("id" AS TEXT) = ? OR CAST("n" AS TEXT) = ?) ORDER"#),
            "{}",
            s.sql
        );

        // NotContains: every column, AND-joined, NULL cells pass.
        let s = build_page(
            Dialect::Sqlite,
            &sq,
            &req_with(vec![any(FilterOp::NotContains, "z")]),
        )
        .unwrap();
        assert!(
            s.sql.contains(
                r#"WHERE (("id" IS NULL OR CAST("id" AS TEXT) NOT LIKE '%' || ? || '%' ESCAPE '!') AND ("n" IS NULL OR CAST("n" AS TEXT) NOT LIKE '%' || ? || '%' ESCAPE '!')) ORDER"#
            ),
            "{}",
            s.sql
        );

        // Like across columns; only Eq/Contains/NotContains/Like work without a column.
        let s = build_page(
            Dialect::Sqlite,
            &sq,
            &req_with(vec![any(FilterOp::Like, "1%")]),
        )
        .unwrap();
        assert!(s.sql.contains(r#"CAST("n" AS TEXT) LIKE ?)"#), "{}", s.sql);
        let e = build_page(
            Dialect::Sqlite,
            &sq,
            &req_with(vec![any(FilterOp::Gt, "1")]),
        )
        .unwrap_err();
        assert_eq!(e.kind, ErrorKind::Invalid);

        // Only binary columns: nothing can match.
        let bin = info_with("main", vec![column("pic", "blob")]);
        let s = build_page(
            Dialect::Sqlite,
            &bin,
            &req_with(vec![any(FilterOp::Contains, "x")]),
        )
        .unwrap();
        assert!(s.sql.contains("WHERE (1 = 0)"), "{}", s.sql);
        assert!(s.params.is_empty());
    }

    #[test]
    fn wrong_value_count_is_invalid() {
        for (op, values, want) in [
            (FilterOp::Eq, vec![], "expected 1 value(s)"),
            (FilterOp::Contains, vec!["a", "b"], "expected 1 value(s)"),
            (FilterOp::Between, vec!["1"], "expected 2 value(s)"),
            (
                FilterOp::NotBetween,
                vec!["1", "2", "3"],
                "expected 2 value(s)",
            ),
            (FilterOp::In, vec![], "expected at least 1 value(s)"),
            (FilterOp::IsNull, vec!["x"], "expected 0 value(s)"),
        ] {
            let e = build_page(
                Dialect::Postgres,
                &pg_info(),
                &req_with(vec![f("id", op, &values)]),
            )
            .unwrap_err();
            assert_eq!(e.kind, ErrorKind::Invalid);
            assert_eq!(e.message, format!("filter on id: {want}"), "{op:?}");
        }
        let raw = Filter {
            column: None,
            op: FilterOp::Raw,
            values: vec!["  ".into()],
        };
        let e = build_page(Dialect::Postgres, &pg_info(), &req_with(vec![raw])).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Invalid);
    }

    #[test]
    fn unknown_column_is_invalid() {
        let e = build_page(
            Dialect::Postgres,
            &pg_info(),
            &req_with(vec![f("nope", FilterOp::Eq, &["1"])]),
        )
        .unwrap_err();
        assert_eq!(
            (e.kind, e.message.as_str()),
            (ErrorKind::Invalid, "unknown column nope")
        );
        let mut req = req_with(vec![]);
        req.sort = Some(("nope\"; --".into(), SortDir::Asc));
        let e = build_page(Dialect::Postgres, &pg_info(), &req).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Invalid);
        let e = build_filtered_count(
            Dialect::MySql,
            &my_info(),
            &[f("nope", FilterOp::IsNull, &[])],
            FilterCombine::And,
            10,
        )
        .unwrap_err();
        assert_eq!(e.message, "unknown column nope");
    }

    #[test]
    fn default_order_uses_row_key_then_rowid() {
        let mut info = info_with("main", vec![column("a", "INT"), column("b", "INT")]);
        let mut req = req_with(vec![]);
        req.sort = Some(("b".into(), SortDir::Desc));
        req.offset = 600;
        // An explicit sort is completed by the key (ties would make OFFSET paging unstable).
        let s = build_page(Dialect::Sqlite, &info, &req).unwrap();
        assert_eq!(
            s.sql,
            r#"SELECT * FROM "main"."order" ORDER BY "b" DESC, "id" LIMIT 300 OFFSET 600"#
        );
        // Key columns already sorted on are not repeated.
        info.row_key = Some(vec!["b".into(), "a".into()]);
        let s = build_page(Dialect::Sqlite, &info, &req).unwrap();
        assert!(
            s.sql
                .ends_with(r#"ORDER BY "b" DESC, "a" LIMIT 300 OFFSET 600"#),
            "{}",
            s.sql
        );
        info.row_key = Some(vec!["b".into()]);
        let s = build_page(Dialect::Sqlite, &info, &req).unwrap();
        assert!(
            s.sql.ends_with(r#"ORDER BY "b" DESC LIMIT 300 OFFSET 600"#),
            "{}",
            s.sql
        );
        info.row_key = None;
        info.has_rowid = true;
        let s = build_page(Dialect::Sqlite, &info, &req).unwrap();
        assert!(
            s.sql
                .ends_with(r#"ORDER BY "b" DESC, rowid LIMIT 300 OFFSET 600"#),
            "{}",
            s.sql
        );
        info.has_rowid = false;
        let s = build_page(Dialect::Sqlite, &info, &req).unwrap();
        assert!(
            s.sql.ends_with(r#"ORDER BY "b" DESC LIMIT 300 OFFSET 600"#),
            "{}",
            s.sql
        );
        req.sort = None;
        info.row_key = Some(vec!["a".into(), "b".into()]);
        let s = build_page(Dialect::Sqlite, &info, &req).unwrap();
        assert!(
            s.sql.ends_with(r#"ORDER BY "a", "b" LIMIT 300 OFFSET 600"#),
            "{}",
            s.sql
        );

        info.row_key = None;
        info.has_rowid = true;
        let s = build_page(Dialect::Sqlite, &info, &req).unwrap();
        assert!(
            s.sql.ends_with("ORDER BY rowid LIMIT 300 OFFSET 600"),
            "{}",
            s.sql
        );
        info.columns.push(column("RowId", "TEXT"));
        let s = build_page(Dialect::Sqlite, &info, &req).unwrap();
        assert!(
            s.sql.ends_with("ORDER BY _rowid_ LIMIT 300 OFFSET 600"),
            "{}",
            s.sql
        );

        // No key and no rowid (WITHOUT ROWID is always keyed; views, keyless tables).
        info.has_rowid = false;
        let s = build_page(Dialect::Sqlite, &info, &req).unwrap();
        assert_eq!(
            s.sql,
            r#"SELECT * FROM "main"."order" LIMIT 300 OFFSET 600"#
        );
        // has_rowid only means something on SQLite.
        info.has_rowid = true;
        let s = build_page(Dialect::MySql, &info, &req).unwrap();
        assert_eq!(s.sql, "SELECT * FROM `main`.`order` LIMIT 300 OFFSET 600");
    }

    #[test]
    fn filtered_count_is_capped() {
        let s = build_filtered_count(
            Dialect::Postgres,
            &pg_info(),
            &[f("note", FilterOp::Eq, &["x"])],
            FilterCombine::And,
            500_001,
        )
        .unwrap();
        assert_eq!(
            s.sql,
            r#"SELECT COUNT(*) FROM (SELECT 1 FROM "public"."order" WHERE "note" = CAST($1::text AS text) LIMIT 500001) AS t"#
        );
        assert_eq!(s.params, texts(&["x"]));
        let s =
            build_filtered_count(Dialect::MySql, &my_info(), &[], FilterCombine::Or, 11).unwrap();
        assert_eq!(
            s.sql,
            "SELECT COUNT(*) FROM (SELECT 1 FROM `shop`.`order` LIMIT 11) AS t"
        );

        let rs = |cell: CellValue| ResultSet {
            columns: vec![],
            rows: vec![vec![cell]],
            truncated: false,
        };
        assert_eq!(
            read_count(&rs(CellValue::Int(7)), 11).unwrap(),
            RowCount::Exact(7)
        );
        assert_eq!(
            read_count(&rs(CellValue::Int(10)), 11).unwrap(),
            RowCount::Exact(10)
        );
        assert_eq!(
            read_count(&rs(CellValue::Int(11)), 11).unwrap(),
            RowCount::Estimate(10)
        );
        assert_eq!(
            read_count(&rs(CellValue::Int(500_001)), 500_001).unwrap(),
            RowCount::Estimate(500_000)
        );
        assert_eq!(
            read_count(&rs(CellValue::Null), 11).unwrap_err().kind,
            ErrorKind::Query
        );
    }

    #[test]
    fn filters_combined_with_or() {
        // OR: every filter in its own parentheses, values still bound in textual order.
        let mut req = req_with(vec![
            f("id", FilterOp::Between, &["1", "5"]),
            f("note", FilterOp::Contains, &["x"]),
            Filter {
                column: None,
                op: FilterOp::Raw,
                values: vec!["id = 9 -- trailing comment".into()],
            },
            any(FilterOp::Eq, "7"),
        ]);
        req.combine = FilterCombine::Or;
        let s = build_page(Dialect::Postgres, &pg_info(), &req).unwrap();
        assert_eq!(
            s.sql,
            "SELECT * FROM \"public\".\"order\" WHERE \
             (\"id\" BETWEEN CAST($1::text AS integer) AND CAST($2::text AS integer)) \
             OR (CAST(\"note\" AS text) LIKE '%' || $3::text || '%' ESCAPE '!') \
             OR ((\nid = 9 -- trailing comment\n)) \
             OR ((CAST(\"id\" AS text) = $4::text OR CAST(\"amount\" AS text) = $5::text \
             OR CAST(\"note\" AS text) = $6::text)) \
             ORDER BY \"id\" LIMIT 300 OFFSET 0"
        );
        assert_eq!(s.params, texts(&["1", "5", "x", "7", "7", "7"]));

        // MySQL / SQLite placeholders, and the capped count follows the same combination.
        let req = PageRequest {
            combine: FilterCombine::Or,
            ..req_with(vec![
                f("id", FilterOp::Eq, &["1"]),
                f("note", FilterOp::IsNull, &[]),
            ])
        };
        let s = build_page(Dialect::MySql, &my_info(), &req).unwrap();
        assert!(
            s.sql.contains("WHERE (`id` = ?) OR (`note` IS NULL) ORDER"),
            "{}",
            s.sql
        );
        let s = build_filtered_count(
            Dialect::Sqlite,
            &info_with("main", my_info().columns),
            &req.filters,
            FilterCombine::Or,
            11,
        )
        .unwrap();
        assert_eq!(
            s.sql,
            r#"SELECT COUNT(*) FROM (SELECT 1 FROM "main"."order" WHERE ("id" = ?) OR ("note" IS NULL) LIMIT 11) AS t"#
        );
        assert_eq!(s.params, texts(&["1"]));

        // AND keeps its SQL unchanged; one filter or none reads the same either way.
        let and = build_filtered_count(
            Dialect::MySql,
            &my_info(),
            &req.filters,
            FilterCombine::And,
            11,
        )
        .unwrap();
        assert!(
            and.sql.contains("WHERE `id` = ? AND `note` IS NULL LIMIT"),
            "{}",
            and.sql
        );
        let one = PageRequest {
            combine: FilterCombine::Or,
            ..req_with(vec![f("id", FilterOp::Eq, &["1"])])
        };
        let s = build_page(Dialect::MySql, &my_info(), &one).unwrap();
        assert!(s.sql.contains("WHERE (`id` = ?) ORDER"), "{}", s.sql);
        let none = PageRequest {
            combine: FilterCombine::Or,
            ..req_with(vec![])
        };
        let s = build_page(Dialect::MySql, &my_info(), &none).unwrap();
        assert_eq!(
            s.sql,
            "SELECT * FROM `shop`.`order` ORDER BY `id` LIMIT 300 OFFSET 0"
        );

        // A bad filter is still refused under OR.
        let bad = PageRequest {
            combine: FilterCombine::Or,
            ..req_with(vec![f("nope", FilterOp::Eq, &["1"])])
        };
        assert_eq!(
            build_page(Dialect::MySql, &my_info(), &bad)
                .unwrap_err()
                .kind,
            ErrorKind::Invalid
        );
    }

    #[test]
    fn where_preview_is_the_page_where_without_values() {
        // The filter bar's SQL button: the page's own WHERE, placeholders in place of the
        // values (never written into the text), on every dialect, AND and OR.
        let filters = vec![
            f("id", FilterOp::Between, &["1", "secret-low"]),
            f("note", FilterOp::Contains, &["secret-text"]),
            any(FilterOp::Eq, "secret-any"),
        ];
        for (d, info) in [
            (Dialect::Postgres, pg_info()),
            (Dialect::MySql, my_info()),
            (Dialect::Sqlite, info_with("main", my_info().columns)),
        ] {
            for combine in [FilterCombine::And, FilterCombine::Or] {
                let w = where_preview(d, &info, &filters, combine).unwrap();
                assert!(w.starts_with("WHERE "), "{w}");
                assert!(!w.contains("secret"), "{w}");
                let req = PageRequest {
                    combine,
                    ..req_with(filters.clone())
                };
                let page = build_page(d, &info, &req).unwrap();
                assert!(
                    page.sql.contains(&format!(" {w} ORDER BY")),
                    "{}\n{w}",
                    page.sql
                );
            }
        }
        assert_eq!(
            where_preview(
                Dialect::Postgres,
                &pg_info(),
                &filters[..1],
                FilterCombine::And
            )
            .unwrap(),
            "WHERE \"id\" BETWEEN CAST($1::text AS integer) AND CAST($2::text AS integer)"
        );
        // No filter: no clause. A bad filter is refused as the page refuses it.
        assert_eq!(
            where_preview(Dialect::MySql, &my_info(), &[], FilterCombine::Or).unwrap(),
            ""
        );
        assert_eq!(
            where_preview(
                Dialect::MySql,
                &my_info(),
                &[f("nope", FilterOp::Eq, &["1"])],
                FilterCombine::And
            )
            .unwrap_err()
            .kind,
            ErrorKind::Invalid
        );
    }

    #[test]
    fn statement_debug_hides_params() {
        let s = Statement {
            sql: "SELECT ?".into(),
            params: texts(&["s3cret-value", "other"]),
        };
        let out = format!("{s:?}");
        assert!(!out.contains("s3cret-value"), "{out}");
        assert!(out.contains("params: <2>"), "{out}");
        assert!(out.contains("SELECT ?"), "{out}");
    }

    #[test]
    fn serde_shapes() {
        assert_eq!(
            serde_json::to_value(SqlParam::Text("a".into())).unwrap(),
            serde_json::json!({"t": "text", "v": "a"})
        );
        let f: Filter = serde_json::from_value(serde_json::json!({
            "column": null, "op": "notContains", "values": ["x"]
        }))
        .unwrap();
        assert_eq!((f.column, f.op), (None, FilterOp::NotContains));
        // The frontend still sends pages without filters.
        let req: PageRequest = serde_json::from_value(serde_json::json!({
            "object": {"schema": "public", "name": "t"},
            "limit": 300, "offset": 0, "sort": null
        }))
        .unwrap();
        assert!(req.filters.is_empty());
        // Absent combine = AND (older frontends); camelCase on the wire.
        assert_eq!(req.combine, FilterCombine::And);
        let req: PageRequest = serde_json::from_value(serde_json::json!({
            "object": {"schema": "public", "name": "t"},
            "limit": 300, "offset": 0, "sort": null, "filters": [], "combine": "or"
        }))
        .unwrap();
        assert_eq!(req.combine, FilterCombine::Or);
        assert_eq!(
            serde_json::to_value(FilterCombine::And).unwrap(),
            serde_json::json!("and")
        );
        assert!(serde_json::from_value::<FilterCombine>(serde_json::json!("xor")).is_err());
    }
}

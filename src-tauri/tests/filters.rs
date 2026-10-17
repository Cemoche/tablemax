//! Filtered pages and counts (`query::build_page`, `build_filtered_count`, `Session::query`)
//! on every engine.
//!
//! Each test builds its own schema (PostgreSQL schema, MySQL/MariaDB database, SQLite file)
//! holding `item` (filter targets, a binary column) and `seq` (20 rows inserted out of
//! order, for pagination). Schemas are dropped at the end, even when an assertion fails.

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{mysql_urls, params_from_url, pg_urls, unique_schema};
use tablemax_lib::driver::mysql::connect_mysql;
use tablemax_lib::driver::postgres::connect_postgres;
use tablemax_lib::driver::query::{Filter, FilterOp, build_filtered_count, build_page, read_count};
use tablemax_lib::driver::sqlite::connect_sqlite;
use tablemax_lib::driver::{
    ConnectParams, Dialect, DriverKind, ObjectRef, PageRequest, ResultSet, RowCount, Session,
};
use tablemax_lib::error::{AppResult, ErrorKind};
use tablemax_lib::value::{CellValue, MAX_RESULT_ROWS};

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

/// Drops the test schema/database on drop (a fresh connection on its own runtime).
struct Cleanup {
    params: ConnectParams,
    sql: String,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        let (params, sql) = (self.params.clone(), self.sql.clone());
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                let s = match params.kind {
                    DriverKind::Postgres => connect_postgres(&params).await,
                    _ => connect_mysql(&params).await,
                };
                if let Ok(s) = s {
                    let _ = s.execute(&sql).await;
                    let _ = s.close().await;
                }
            });
        })
        .join();
    }
}

struct Fx {
    s: Arc<dyn Session>,
    schema: String,
    _cleanup: Option<Cleanup>,
    _dir: Option<tempfile::TempDir>,
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

fn raw(sql: &str) -> Filter {
    Filter {
        column: None,
        op: FilterOp::Raw,
        values: vec![sql.into()],
    }
}

fn int(c: &CellValue) -> i64 {
    match c {
        CellValue::Int(n) => *n,
        other => panic!("not an int: {other:?}"),
    }
}

impl Fx {
    fn d(&self) -> Dialect {
        self.s.dialect()
    }

    fn obj(&self, name: &str) -> ObjectRef {
        ObjectRef {
            schema: Some(self.schema.clone()),
            name: name.into(),
        }
    }

    fn q(&self, name: &str) -> String {
        tablemax_lib::driver::sql::qualified(self.d(), &self.obj(name))
    }

    async fn run(&self, sql: &str) {
        self.s
            .execute(sql)
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e:?}"));
    }

    async fn page_at(
        &self,
        name: &str,
        filters: Vec<Filter>,
        limit: u32,
        offset: u64,
    ) -> AppResult<ResultSet> {
        let req = PageRequest {
            object: self.obj(name),
            limit,
            offset,
            sort: None,
            filters,
        };
        let info = self.s.table_info(&req.object).await?;
        let stmt = build_page(self.d(), &info, &req)?;
        self.s.query(&stmt).await
    }

    async fn page(&self, name: &str, filters: Vec<Filter>) -> AppResult<ResultSet> {
        self.page_at(name, filters, 300, 0).await
    }

    /// First-column ids of the filtered page, in page order.
    async fn ids(&self, name: &str, filters: Vec<Filter>) -> Vec<i64> {
        let what = format!("{filters:?}");
        let rs = self
            .page(name, filters)
            .await
            .unwrap_or_else(|e| panic!("{what}: {e:?}"));
        rs.rows.iter().map(|r| int(&r[0])).collect()
    }

    async fn count(&self, name: &str, filters: &[Filter], cap: u64) -> RowCount {
        let info = self.s.table_info(&self.obj(name)).await.unwrap();
        let stmt = build_filtered_count(self.d(), &info, filters, cap).unwrap();
        read_count(&self.s.query(&stmt).await.unwrap(), cap).unwrap()
    }

    /// `item` and `seq`, written for the engine (`bin` = the binary literal for `zz`).
    async fn seed(&self, int: &str, num: &str, text: &str, bin: (&str, &str), backslash: &str) {
        let (item, seq) = (self.q("item"), self.q("seq"));
        let (bin_type, zz) = bin;
        self.run(&format!(
            "CREATE TABLE {item} (id {int} PRIMARY KEY, n {int} NOT NULL, amount {num}, \
             note {text}, data {bin_type})"
        ))
        .await;
        // Out of id order on purpose.
        for row in [
            format!("(4, 40, NULL, 'a{backslash}b', NULL)"),
            "(1, 10, 1.5, '50%', NULL)".to_string(),
            "(6, 60, 6, 'zz top', NULL)".to_string(),
            "(3, 30, 3.25, '5_0', NULL)".to_string(),
            format!("(5, 50, 5, NULL, {zz})"),
            "(2, 20, 2, '50 percent', NULL)".to_string(),
        ] {
            self.run(&format!("INSERT INTO {item} VALUES {row}")).await;
        }
        self.run(&format!(
            "CREATE TABLE {seq} (id {int} PRIMARY KEY, v {int})"
        ))
        .await;
        for i in [
            7, 19, 2, 13, 5, 17, 11, 1, 20, 3, 15, 9, 6, 18, 4, 12, 16, 8, 14, 10,
        ] {
            self.run(&format!("INSERT INTO {seq} VALUES ({i}, {i})"))
                .await;
        }
        // PostgreSQL: updated rows move to the end of the heap.
        self.run(&format!("UPDATE {seq} SET v = v + 1 WHERE id % 3 = 0"))
            .await;
    }
}

async fn pg_fixture(url: &str) -> Fx {
    let params = params_from_url(url, DriverKind::Postgres);
    let s = connect_postgres(&params).await.unwrap();
    let schema = unique_schema();
    let fx = Fx {
        s,
        _cleanup: Some(Cleanup {
            params,
            sql: format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"),
        }),
        _dir: None,
        schema: schema.clone(),
    };
    fx.run(&format!("CREATE SCHEMA \"{schema}\"")).await;
    fx.seed(
        "integer",
        "numeric(12,2)",
        "text",
        ("bytea", "'\\x7a7a'"),
        "\\",
    )
    .await;
    fx
}

async fn mysql_fixture(url: &str, kind: DriverKind) -> Fx {
    let params = params_from_url(url, kind);
    let s = connect_mysql(&params).await.unwrap();
    let schema = unique_schema();
    let fx = Fx {
        s,
        _cleanup: Some(Cleanup {
            params,
            sql: format!("DROP DATABASE IF EXISTS `{schema}`"),
        }),
        _dir: None,
        schema: schema.clone(),
    };
    fx.run(&format!("CREATE DATABASE `{schema}`")).await;
    fx.seed(
        "int",
        "decimal(12,2)",
        "text",
        ("varbinary(8)", "x'7a7a'"),
        "\\\\",
    )
    .await;
    fx
}

async fn sqlite_fixture() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.db");
    rusqlite::Connection::open(&path).unwrap();
    let fx = Fx {
        s: connect_sqlite(&path).await.unwrap(),
        schema: "main".into(),
        _cleanup: None,
        _dir: Some(dir),
    };
    fx.seed("INTEGER", "NUMERIC", "TEXT", ("BLOB", "x'7a7a'"), "\\")
        .await;
    fx
}

/// URL order from `scripts/test-dbs.sh env`: MySQL 8 first, MariaDB 11 second.
fn mysql_targets() -> Vec<(String, DriverKind)> {
    mysql_urls()
        .into_iter()
        .enumerate()
        .map(|(i, u)| {
            let kind = if i == 0 {
                DriverKind::MySql
            } else {
                DriverKind::MariaDb
            };
            (u, kind)
        })
        .collect()
}

/// Every fixture: PostgreSQL, MySQL, MariaDB, SQLite.
async fn all_fixtures() -> Vec<Fx> {
    let mut out = Vec::new();
    for url in pg_urls() {
        out.push(pg_fixture(&url).await);
    }
    for (url, kind) in mysql_targets() {
        out.push(mysql_fixture(&url, kind).await);
    }
    out.push(sqlite_fixture().await);
    out
}

// ---------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------

#[tokio::test]
async fn filters_bind_values() {
    for fx in all_fixtures().await {
        let d = fx.d();
        let injection = "'; drop table item; --";
        assert_eq!(
            fx.ids("item", vec![f("note", FilterOp::Eq, &[injection])])
                .await,
            Vec::<i64>::new(),
            "{d:?}"
        );
        assert_eq!(fx.ids("item", vec![]).await.len(), 6, "{d:?}: table intact");
        // A quote inside a value is data, not SQL.
        assert_eq!(
            fx.ids("item", vec![f("note", FilterOp::Eq, &["50%"])])
                .await,
            [1]
        );

        // Text that is not an integer, compared with an integer column.
        let r = fx.page("item", vec![f("n", FilterOp::Eq, &["abc"])]).await;
        match d {
            // CAST('abc' AS integer) fails on the server.
            Dialect::Postgres => assert_eq!(r.unwrap_err().kind, ErrorKind::Query),
            // MySQL/MariaDB convert 'abc' to 0 (with a warning): no row has n = 0.
            // SQLite keeps 'abc' as text, which never equals an integer.
            Dialect::MySql | Dialect::Sqlite => {
                assert!(r.unwrap().rows.is_empty(), "{d:?}")
            }
        }
        // Typed comparisons: numbers, not text order.
        assert_eq!(
            fx.ids("item", vec![f("n", FilterOp::Gt, &["9"])])
                .await
                .len(),
            6,
            "{d:?}"
        );
        assert_eq!(
            fx.ids("item", vec![f("amount", FilterOp::Lte, &["2.00"])])
                .await,
            [1, 2],
            "{d:?}"
        );
    }
}

#[tokio::test]
async fn contains_matches_literal_percent() {
    for fx in all_fixtures().await {
        let d = fx.d();
        let contains = |v: &str| vec![f("note", FilterOp::Contains, &[v])];
        assert_eq!(fx.ids("item", contains("50%")).await, [1], "{d:?}");
        assert_eq!(fx.ids("item", contains("5_0")).await, [3], "{d:?}");
        assert_eq!(fx.ids("item", contains("a\\b")).await, [4], "{d:?}");
        assert_eq!(fx.ids("item", contains("50")).await, [1, 2], "{d:?}");
        // NOT LIKE: NULL notes are not "not containing" in SQL terms.
        assert_eq!(
            fx.ids("item", vec![f("note", FilterOp::NotContains, &["50"])])
                .await,
            [3, 4, 6],
            "{d:?}"
        );
        // Like takes the pattern as is: `_` is a wildcard there.
        assert_eq!(
            fx.ids("item", vec![f("note", FilterOp::Like, &["5_ %"])])
                .await,
            [2],
            "{d:?}"
        );
        // Ilike is case-insensitive everywhere (PostgreSQL ILIKE, LIKE elsewhere).
        assert_eq!(
            fx.ids("item", vec![f("note", FilterOp::Ilike, &["ZZ%"])])
                .await,
            [6],
            "{d:?}"
        );
        // Contains on a numeric column (text form).
        assert_eq!(
            fx.ids("item", vec![f("amount", FilterOp::Contains, &["3.25"])])
                .await,
            [3],
            "{d:?}"
        );
    }
}

#[tokio::test]
async fn in_and_between() {
    for fx in all_fixtures().await {
        let d = fx.d();
        assert_eq!(
            fx.ids("item", vec![f("id", FilterOp::In, &["1", "3", "99"])])
                .await,
            [1, 3],
            "{d:?}"
        );
        assert_eq!(
            fx.ids("item", vec![f("id", FilterOp::NotIn, &["1", "3"])])
                .await,
            [2, 4, 5, 6],
            "{d:?}"
        );
        assert_eq!(
            fx.ids("item", vec![f("n", FilterOp::Between, &["20", "40"])])
                .await,
            [2, 3, 4],
            "{d:?}"
        );
        assert_eq!(
            fx.ids(
                "item",
                vec![f("amount", FilterOp::NotBetween, &["2", "5.5"])]
            )
            .await,
            [1, 6],
            "{d:?}"
        );
        assert_eq!(
            fx.ids("item", vec![f("amount", FilterOp::IsNull, &[])])
                .await,
            [4],
            "{d:?}"
        );
        // Several filters are joined by AND; Raw is the user's SQL.
        assert_eq!(
            fx.ids(
                "item",
                vec![
                    f("note", FilterOp::IsNotNull, &[]),
                    f("id", FilterOp::Neq, &["1"]),
                    raw("n >= 30"),
                ]
            )
            .await,
            [3, 4, 6],
            "{d:?}"
        );
        let e = fx.page("item", vec![raw("no_such_column = 1")]).await;
        assert_eq!(e.unwrap_err().kind, ErrorKind::Query, "{d:?}");
    }
}

#[tokio::test]
async fn any_column_contains() {
    for fx in all_fixtures().await {
        let d = fx.d();
        // Matches in different columns: note (1, 2) and n = 50 (5).
        assert_eq!(
            fx.ids("item", vec![any(FilterOp::Contains, "50")]).await,
            [1, 2, 5],
            "{d:?}"
        );
        // Row 5 holds the bytes "zz" in its binary column: never searched.
        assert_eq!(
            fx.ids("item", vec![any(FilterOp::Contains, "zz")]).await,
            [6],
            "{d:?}"
        );
        assert_eq!(
            fx.ids("item", vec![any(FilterOp::Eq, "30")]).await,
            [3],
            "{d:?}"
        );
        // Every row but those containing "0" somewhere (NULL cells pass).
        assert_eq!(
            fx.ids("item", vec![any(FilterOp::NotContains, "0")]).await,
            Vec::<i64>::new(),
            "{d:?}"
        );
        assert_eq!(
            fx.ids("item", vec![any(FilterOp::NotContains, "percent")])
                .await,
            [1, 3, 4, 5, 6],
            "{d:?}"
        );
    }
}

#[tokio::test]
async fn filtered_count_exact_and_capped() {
    for fx in all_fixtures().await {
        let d = fx.d();
        let some = [f("n", FilterOp::Gte, &["30"])]; // 4 rows
        assert_eq!(
            fx.count("item", &some, 10).await,
            RowCount::Exact(4),
            "{d:?}"
        );
        assert_eq!(
            fx.count("item", &some, 5).await,
            RowCount::Exact(4),
            "{d:?}"
        );
        // Cap reached: at least cap - 1.
        assert_eq!(
            fx.count("item", &some, 4).await,
            RowCount::Estimate(3),
            "{d:?}"
        );
        assert_eq!(
            fx.count("seq", &[raw("1 = 1")], 6).await,
            RowCount::Estimate(5),
            "{d:?}"
        );
        assert_eq!(
            fx.count("item", &[f("note", FilterOp::Eq, &["nope"])], 4)
                .await,
            RowCount::Exact(0),
            "{d:?}"
        );
    }
}

#[tokio::test]
async fn pagination_is_stable_without_sort() {
    for fx in all_fixtures().await {
        let d = fx.d();
        let mut seen = Vec::new();
        for offset in (0..20).step_by(6) {
            let rs = fx.page_at("seq", vec![], 6, offset).await.unwrap();
            seen.extend(rs.rows.iter().map(|r| int(&r[0])));
        }
        assert_eq!(seen, (1..=20).collect::<Vec<_>>(), "{d:?}");
        // Filters keep the key order.
        let rs = fx
            .page_at("seq", vec![f("v", FilterOp::Gt, &["10"])], 4, 4)
            .await
            .unwrap();
        let ids: Vec<i64> = rs.rows.iter().map(|r| int(&r[0])).collect();
        assert_eq!(ids, [15, 16, 17, 18], "{d:?}");
    }
}

#[tokio::test]
async fn sqlite_keyless_table_pages_by_rowid() {
    let fx = sqlite_fixture().await;
    fx.run("CREATE TABLE logs (v TEXT)").await;
    for v in ["c", "a", "d", "b", "e"] {
        fx.run(&format!("INSERT INTO logs VALUES ('{v}')")).await;
    }
    // Index on v: without ORDER BY, SQLite could scan it in v order.
    fx.run("CREATE INDEX logs_v ON logs (v)").await;
    let info = fx.s.table_info(&fx.obj("logs")).await.unwrap();
    assert!(info.row_key.is_none() && info.has_rowid);
    let mut seen = Vec::new();
    for offset in [0, 2, 4] {
        let rs = fx
            .page_at("logs", vec![f("v", FilterOp::Gte, &["a"])], 2, offset)
            .await
            .unwrap();
        seen.extend(rs.rows.iter().map(|r| r[0].clone()));
    }
    let want: Vec<CellValue> = ["c", "a", "d", "b", "e"]
        .iter()
        .map(|v| CellValue::Text(v.to_string()))
        .collect();
    assert_eq!(seen, want);
}

/// A parameterized page decodes every value exactly like `execute` does.
async fn check_query_decodes_like_execute(fx: &Fx, table: &str) {
    let rs = fx
        .page(table, vec![f("id", FilterOp::Gte, &["0"])])
        .await
        .unwrap();
    let sql = format!("SELECT * FROM {} ORDER BY id", fx.q(table));
    let direct = fx.s.execute(&sql).await.unwrap().result.unwrap();
    assert_eq!(rs.columns, direct.columns, "{:?}", fx.d());
    assert_eq!(rs.rows, direct.rows, "{:?}", fx.d());
    assert_eq!(rs.rows.len(), 2);
    assert!(rs.rows[1][1..].iter().all(|c| *c == CellValue::Null));
}

#[tokio::test]
async fn pg_query_decodes_like_execute() {
    for url in pg_urls() {
        let fx = pg_fixture(&url).await;
        let t = fx.q("types");
        fx.run(&format!(
            "CREATE TABLE {t} (id int PRIMARY KEY, b bool, num numeric(10,3), f float8, \
             ts timestamptz, d date, j jsonb, ip inet, c char(4), arr int[], by bytea, \
             u uuid, iv interval, big bigint, comp int4range)"
        ))
        .await;
        fx.run(&format!(
            "INSERT INTO {t} VALUES (1, true, 1.5, 0.1, '2024-01-02 03:04:05.678+00', \
             '2024-02-29', '{{\"a\": [1, 2]}}', '192.168.0.1', 'ab', '{{1,NULL,3}}', \
             '\\x00ff', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '1 day 02:00:00', \
             9007199254740993, '[1,5)'), (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, \
             NULL, NULL, NULL, NULL, NULL, NULL, NULL)"
        ))
        .await;
        check_query_decodes_like_execute(&fx, "types").await;
        let rs = fx.page("types", vec![]).await.unwrap();
        assert_eq!(rs.rows[0][1], CellValue::Bool(true));
        assert_eq!(rs.rows[0][2], CellValue::Decimal("1.500".into()));
        assert_eq!(rs.rows[0][8], CellValue::Text("ab  ".into()));
        assert_eq!(rs.rows[0][13], CellValue::BigInt("9007199254740993".into()));
    }
}

#[tokio::test]
async fn mysql_query_decodes_like_execute() {
    for (url, kind) in mysql_targets() {
        let fx = mysql_fixture(&url, kind).await;
        let t = fx.q("types");
        fx.run(&format!(
            "CREATE TABLE {t} (id int PRIMARY KEY, num decimal(10,3), fl float, dbl double, \
             dt datetime(3), d date, tm time, y year, j json, vb varbinary(8), bt bit(3), \
             e enum('a','b'), u bigint unsigned, ti tinyint(1))"
        ))
        .await;
        fx.run(&format!(
            "INSERT INTO {t} VALUES (1, 1.5, 1.1, 0.1, '2024-01-02 03:04:05.678', \
             '2024-02-29', '-01:02:03', 2024, '{{\"a\": [1, 2]}}', x'00ff', b'101', 'b', \
             18446744073709551615, 1), (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, \
             NULL, NULL, NULL, NULL, NULL)"
        ))
        .await;
        check_query_decodes_like_execute(&fx, "types").await;
        let rs = fx
            .page("types", vec![f("id", FilterOp::Eq, &["1"])])
            .await
            .unwrap();
        assert_eq!(rs.rows[0][2], CellValue::Float(1.1), "{kind:?}");
        assert_eq!(
            rs.rows[0][4],
            CellValue::Temporal("2024-01-02 03:04:05.678".into())
        );
        assert_eq!(rs.rows[0][7], CellValue::Temporal("2024".into()));
        assert!(matches!(rs.rows[0][8], CellValue::Json(_)), "{kind:?}");
        // The statement and the bound values do not outlive the call.
        let left =
            fx.s.execute("SELECT @__tablemax_sql, @__tablemax_p1")
                .await
                .unwrap()
                .result
                .unwrap();
        assert_eq!(left.rows[0], [CellValue::Null, CellValue::Null], "{kind:?}");
    }
}

#[tokio::test]
async fn sqlite_query_decodes_like_execute() {
    let fx = sqlite_fixture().await;
    fx.run("CREATE TABLE types (id INTEGER PRIMARY KEY, r REAL, t TEXT, b BLOB, n NUMERIC)")
        .await;
    fx.run("INSERT INTO types VALUES (1, 1.5, 'x', x'00ff', '1.50'), (2, NULL, NULL, NULL, NULL)")
        .await;
    check_query_decodes_like_execute(&fx, "types").await;
}

#[tokio::test]
async fn pg_query_caps_rows() {
    for url in pg_urls() {
        let fx = pg_fixture(&url).await;
        let big = fx.q("big");
        fx.run(&format!("CREATE TABLE {big} (id int PRIMARY KEY)"))
            .await;
        let extra = MAX_RESULT_ROWS + 5;
        fx.run(&format!(
            "INSERT INTO {big} SELECT generate_series(1, {extra})"
        ))
        .await;
        let rs = fx
            .page_at("big", vec![f("id", FilterOp::Gt, &["0"])], 20_000, 0)
            .await
            .unwrap();
        assert_eq!(rs.rows.len(), MAX_RESULT_ROWS);
        assert!(rs.truncated);
        // The session is still in sync after the drained rows.
        assert_eq!(
            fx.ids("item", vec![f("id", FilterOp::Eq, &["2"])]).await,
            [2]
        );
    }
}

/// A slow parameterized page is cancelled, and the session keeps working.
async fn check_query_cancel(fx: &Fx, slow: &str) {
    let canceller = fx.s.canceller();
    let s = fx.s.clone();
    let info = s.table_info(&fx.obj("item")).await.unwrap();
    let req = PageRequest {
        object: fx.obj("item"),
        limit: 10,
        offset: 0,
        sort: None,
        filters: vec![f("n", FilterOp::Gt, &["0"]), raw(slow)],
    };
    let stmt = build_page(fx.d(), &info, &req).unwrap();
    let run = tokio::spawn(async move { s.query(&stmt).await });
    let started = std::time::Instant::now();
    let res = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            canceller.cancel().await.unwrap();
            if run.is_finished() {
                return run.await.unwrap();
            }
        }
    })
    .await
    .expect("cancel timed out");
    assert_eq!(res.unwrap_err().kind, ErrorKind::Cancelled, "{:?}", fx.d());
    assert!(started.elapsed() < Duration::from_secs(8));
    assert_eq!(
        fx.ids("item", vec![f("id", FilterOp::Eq, &["3"])]).await,
        [3]
    );
}

#[tokio::test]
async fn pg_query_is_cancellable() {
    for url in pg_urls() {
        let fx = pg_fixture(&url).await;
        check_query_cancel(&fx, "pg_sleep(30) IS NOT NULL").await;
    }
}

#[tokio::test]
async fn mysql_query_is_cancellable() {
    for (url, kind) in mysql_targets() {
        let fx = mysql_fixture(&url, kind).await;
        check_query_cancel(&fx, "SLEEP(30) = 0").await;
    }
}

/// Values travel through session variables (see the MySQL driver): compared directly, a
/// variable would clash with a column of another collation ("Illegal mix of collations");
/// bound with `EXECUTE .. USING` it behaves like a literal.
#[tokio::test]
async fn mysql_filters_work_across_collations() {
    for (url, kind) in mysql_targets() {
        let fx = mysql_fixture(&url, kind).await;
        let t = fx.q("coll");
        fx.run(&format!(
            "CREATE TABLE {t} (id int PRIMARY KEY, \
             a varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci, \
             b varchar(20) CHARACTER SET latin1 COLLATE latin1_swedish_ci, \
             c varchar(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin)"
        ))
        .await;
        fx.run(&format!(
            "INSERT INTO {t} VALUES (1, 'Été', 'Åsa', 'Xy'), (2, 'x', 'y', 'xy')"
        ))
        .await;
        assert_eq!(
            fx.ids("coll", vec![f("a", FilterOp::Eq, &["été"])]).await,
            [1],
            "{kind:?}"
        );
        assert_eq!(
            fx.ids("coll", vec![f("b", FilterOp::Contains, &["ås"])])
                .await,
            [1],
            "{kind:?}"
        );
        assert_eq!(
            fx.ids("coll", vec![f("c", FilterOp::Eq, &["Xy"])]).await,
            [1],
            "{kind:?}"
        );
        assert_eq!(
            fx.ids("coll", vec![any(FilterOp::Contains, "Ét")]).await,
            [1],
            "{kind:?}"
        );
    }
}

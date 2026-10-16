use std::sync::Arc;
use std::time::Duration;

use tablemax_lib::driver::sqlite::connect_sqlite;
use tablemax_lib::driver::{
    DbObject, ObjectKind, ObjectRef, PageRequest, RowCount, Session, SortDir,
};
use tablemax_lib::error::ErrorKind;
use tablemax_lib::value::{CellValue, MAX_RESULT_ROWS};

async fn open() -> (tempfile::TempDir, Arc<dyn Session>) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.db");
    // Create the file with rusqlite directly (driver never creates).
    rusqlite::Connection::open(&path).unwrap();
    let s = connect_sqlite(&path).await.unwrap();
    (dir, s)
}

fn obj(name: &str) -> ObjectRef {
    ObjectRef {
        schema: None,
        name: name.into(),
    }
}

#[tokio::test]
async fn lists_tables_and_views() {
    let (_d, s) = open().await;
    s.execute("CREATE TABLE customers (id INTEGER PRIMARY KEY)")
        .await
        .unwrap();
    s.execute("CREATE VIEW big AS SELECT * FROM customers")
        .await
        .unwrap();
    assert_eq!(s.list_schemas().await.unwrap(), vec!["main".to_string()]);
    let objs = s.list_objects(None).await.unwrap();
    assert_eq!(
        objs,
        vec![
            DbObject {
                schema: Some("main".into()),
                name: "big".into(),
                kind: ObjectKind::View
            },
            DbObject {
                schema: Some("main".into()),
                name: "customers".into(),
                kind: ObjectKind::Table
            },
        ]
    );
}

#[tokio::test]
async fn fetch_page_sorts_and_paginates() {
    let (_d, s) = open().await;
    s.execute("CREATE TABLE n (id INTEGER)").await.unwrap();
    s.execute("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<25) INSERT INTO n SELECT x FROM c")
        .await
        .unwrap();
    let rs = s
        .fetch_page(&PageRequest {
            object: obj("n"),
            limit: 10,
            offset: 10,
            sort: Some(("id".into(), SortDir::Desc)),
        })
        .await
        .unwrap();
    let ids: Vec<_> = rs.rows.iter().map(|r| r[0].clone()).collect();
    let want: Vec<_> = (6..=15).rev().map(CellValue::Int).collect();
    assert_eq!(ids, want);
    assert_eq!(rs.columns[0].type_name, "INTEGER");
    assert!(!rs.truncated);
    assert_eq!(
        s.count_rows(&obj("n"), 500_000).await.unwrap(),
        RowCount::Exact(25)
    );
}

#[tokio::test]
async fn weird_identifier_table_opens() {
    let (_d, s) = open().await;
    s.execute(r#"CREATE TABLE "My ""Table""" (x)"#)
        .await
        .unwrap();
    s.execute(r#"INSERT INTO "My ""Table""" VALUES (1)"#)
        .await
        .unwrap();
    let rs = s
        .fetch_page(&PageRequest {
            object: ObjectRef {
                schema: Some("main".into()),
                name: r#"My "Table""#.into(),
            },
            limit: 10,
            offset: 0,
            sort: None,
        })
        .await
        .unwrap();
    assert_eq!(rs.rows.len(), 1);
}

#[tokio::test]
async fn maps_types_and_null_vs_empty() {
    let (_d, s) = open().await;
    let out = s
        .execute("SELECT NULL, '', 42, 1.5, x'00ff'")
        .await
        .unwrap();
    assert_eq!(out.rows_affected, None);
    let rs = out.result.unwrap();
    assert_eq!(
        rs.rows[0],
        vec![
            CellValue::Null,
            CellValue::Text(String::new()),
            CellValue::Int(42),
            CellValue::Float(1.5),
            CellValue::Bytes {
                len: 2,
                hex_preview: "00ff".into()
            },
        ]
    );
}

#[tokio::test]
async fn long_text_cell_is_truncated() {
    let (_d, s) = open().await;
    s.execute("CREATE TABLE big (t TEXT)").await.unwrap();
    s.execute("INSERT INTO big VALUES (replace(hex(zeroblob(1500000)), '0', 'a'))")
        .await
        .unwrap();
    let rs = s
        .fetch_page(&PageRequest {
            object: obj("big"),
            limit: 10,
            offset: 0,
            sort: None,
        })
        .await
        .unwrap();
    assert!(matches!(
        rs.rows[0][0],
        CellValue::LongText { len: 3_000_000, .. }
    ));
}

#[tokio::test]
async fn execute_ddl_returns_rows_affected_without_result() {
    let (_d, s) = open().await;
    s.execute("CREATE TABLE t (a)").await.unwrap();
    let out = s.execute("INSERT INTO t VALUES (1),(2),(3)").await.unwrap();
    assert!(out.result.is_none());
    assert_eq!(out.rows_affected, Some(3));
}

#[tokio::test]
async fn cancel_interrupts_long_query() {
    let (_d, s) = open().await;
    let s2 = s.clone();
    let h = tokio::spawn(async move {
        s2.execute(
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c",
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    s.canceller().cancel().await.unwrap();
    let res = tokio::time::timeout(Duration::from_secs(2), h)
        .await
        .expect("cancel took too long")
        .unwrap();
    assert_eq!(res.unwrap_err().kind, ErrorKind::Cancelled);
}

#[tokio::test]
async fn missing_file_is_not_found() {
    let err = connect_sqlite(std::path::Path::new("/nonexistent/x.db"))
        .await
        .err()
        .unwrap();
    assert_eq!(err.kind, ErrorKind::NotFound);
}

#[tokio::test]
async fn integers_beyond_js_safe_range_are_bigint() {
    let (_d, s) = open().await;
    let rs = s
        .execute(
            "SELECT 9007199254740991, 9007199254740992, 9223372036854775807, -9223372036854775808",
        )
        .await
        .unwrap()
        .result
        .unwrap();
    assert_eq!(
        rs.rows[0],
        vec![
            CellValue::Int(9_007_199_254_740_991),
            CellValue::BigInt("9007199254740992".into()),
            CellValue::BigInt("9223372036854775807".into()),
            CellValue::BigInt("-9223372036854775808".into()),
        ]
    );
}

#[tokio::test]
async fn sql_results_are_capped() {
    let (_d, s) = open().await;
    let q = |n: u32| {
        format!(
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < {n}) \
             SELECT x FROM c"
        )
    };
    let big = s.execute(&q(10_005)).await.unwrap().result.unwrap();
    assert_eq!(big.rows.len(), MAX_RESULT_ROWS);
    assert!(big.truncated);
    assert_eq!(big.rows[MAX_RESULT_ROWS - 1][0], CellValue::Int(10_000));
    let exact = s.execute(&q(10_000)).await.unwrap().result.unwrap();
    assert_eq!(exact.rows.len(), MAX_RESULT_ROWS);
    assert!(!exact.truncated);
    let page_src = s.execute("SELECT 1").await.unwrap().result.unwrap();
    assert!(!page_src.truncated);
}

#[tokio::test]
async fn capped_infinite_query_returns_and_stays_cancellable() {
    // An unbounded generator stops at the cap instead of running forever.
    let (_d, s) = open().await;
    let rs = tokio::time::timeout(
        Duration::from_secs(5),
        s.execute(
            "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c",
        ),
    )
    .await
    .expect("capped query must return")
    .unwrap()
    .result
    .unwrap();
    assert_eq!(rs.rows.len(), MAX_RESULT_ROWS);
    assert!(rs.truncated);
}

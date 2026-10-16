mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{params_from_url, pg_urls, unique_schema};
use tablemax_lib::driver::postgres::connect_postgres;
use tablemax_lib::driver::{
    ConnectParams, DbObject, DriverKind, ObjectKind, ObjectRef, PageRequest, ResultSet, RowCount,
    Session, SortDir,
};
use tablemax_lib::error::ErrorKind;
use tablemax_lib::value::CellValue;

/// Creates a unique schema and drops it on drop, even when an assertion fails.
struct TestSchema {
    params: ConnectParams,
    name: String,
}

impl Drop for TestSchema {
    fn drop(&mut self) {
        let params = self.params.clone();
        let sql = format!("DROP SCHEMA IF EXISTS \"{}\" CASCADE", self.name);
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                if let Ok(s) = connect_postgres(&params).await {
                    let _ = s.execute(&sql).await;
                    let _ = s.close().await;
                }
            });
        })
        .join();
    }
}

async fn open(url: &str) -> (Arc<dyn Session>, TestSchema) {
    let params = params_from_url(url, DriverKind::Postgres);
    let s = connect_postgres(&params).await.unwrap();
    let name = unique_schema();
    s.execute(&format!("CREATE SCHEMA \"{name}\""))
        .await
        .unwrap();
    (s, TestSchema { params, name })
}

fn only(rs: &ResultSet) -> Vec<CellValue> {
    assert_eq!(rs.rows.len(), 1);
    rs.rows[0].clone()
}

#[tokio::test]
async fn pg_maps_types_exactly() {
    for url in pg_urls() {
        let (s, _g) = open(&url).await;
        let out = s
            .execute(
                "select 1::int8, 9223372036854775807::int8, \
                 12345678901234567890.1234567890::numeric(38,10), 'NaN'::float8, true, \
                 '{\"a\":1}'::jsonb, '\\x00ff'::bytea, ''::text, null::text, \
                 '2026-10-16 12:00:00+00'::timestamptz",
            )
            .await
            .unwrap();
        let row = only(out.result.as_ref().unwrap());
        assert_eq!(row[0], CellValue::Int(1));
        assert_eq!(row[1], CellValue::Int(i64::MAX));
        assert_eq!(
            row[2],
            CellValue::Decimal("12345678901234567890.1234567890".into())
        );
        assert_eq!(row[3], CellValue::Text("NaN".into()));
        assert_eq!(row[4], CellValue::Bool(true));
        assert_eq!(row[5], CellValue::Json(r#"{"a": 1}"#.into()));
        assert_eq!(
            row[6],
            CellValue::Bytes {
                len: 2,
                hex_preview: "00ff".into()
            }
        );
        assert_eq!(row[7], CellValue::Text(String::new()));
        assert_eq!(row[8], CellValue::Null);
        assert!(matches!(row[9], CellValue::Temporal(_)), "{:?}", row[9]);
        s.close().await.unwrap();
    }
}

#[tokio::test]
async fn pg_maps_other_types_as_text_and_floats() {
    for url in pg_urls() {
        let (s, _g) = open(&url).await;
        let out = s
            .execute(
                "select 1.5::float8, 0.1::float4, 'Infinity'::float8, 7::int2, \
                 '3f2504e0-4f89-11d3-9a0c-0305e82c3301'::uuid, '10.0.0.1'::inet, \
                 array[1,2]::int4[], interval '1 day', date '2026-10-16', 'ab'::varchar, 'x'::char(3)",
            )
            .await
            .unwrap();
        let row = only(out.result.as_ref().unwrap());
        assert_eq!(row[0], CellValue::Float(1.5));
        assert!(matches!(row[1], CellValue::Float(_)));
        assert_eq!(row[2], CellValue::Text("Infinity".into()));
        assert_eq!(row[3], CellValue::Int(7));
        assert_eq!(
            row[4],
            CellValue::Text("3f2504e0-4f89-11d3-9a0c-0305e82c3301".into())
        );
        assert_eq!(row[5], CellValue::Text("10.0.0.1".into()));
        assert_eq!(row[6], CellValue::Text("{1,2}".into()));
        assert_eq!(row[7], CellValue::Temporal("1 day".into()));
        assert_eq!(row[8], CellValue::Temporal("2026-10-16".into()));
        assert_eq!(row[9], CellValue::Text("ab".into()));
        assert_eq!(row[10], CellValue::Text("x  ".into()));
        assert_eq!(out.result.unwrap().columns[0].type_name, "float8");
    }
}

#[tokio::test]
async fn pg_execute_reports_rows_affected() {
    for url in pg_urls() {
        let (s, g) = open(&url).await;
        let n = &g.name;
        s.execute(&format!("create table \"{n}\".a (id int)"))
            .await
            .unwrap();
        let ins = s
            .execute(&format!(
                "insert into \"{n}\".a select generate_series(1,7)"
            ))
            .await
            .unwrap();
        assert!(ins.result.is_none());
        assert_eq!(ins.rows_affected, Some(7));
        let err = s.execute("selec 1").await.err().unwrap();
        assert_eq!(err.kind, ErrorKind::Query);
    }
}

#[tokio::test]
async fn pg_lists_schemas_and_objects() {
    for url in pg_urls() {
        let (s, g) = open(&url).await;
        let n = &g.name;
        s.execute(&format!("create table \"{n}\".t (id int primary key)"))
            .await
            .unwrap();
        s.execute(&format!("create view \"{n}\".v as select * from \"{n}\".t"))
            .await
            .unwrap();
        let schemas = s.list_schemas().await.unwrap();
        assert!(schemas.contains(n));
        assert!(schemas.contains(&"public".to_string()));
        for hidden in ["pg_catalog", "information_schema"] {
            assert!(!schemas.iter().any(|x| x == hidden));
        }
        assert!(!schemas.iter().any(|x| x.starts_with("pg_toast")));
        let objs = s.list_objects(Some(n)).await.unwrap();
        assert_eq!(
            objs,
            vec![
                DbObject {
                    schema: Some(n.clone()),
                    name: "t".into(),
                    kind: ObjectKind::Table
                },
                DbObject {
                    schema: Some(n.clone()),
                    name: "v".into(),
                    kind: ObjectKind::View
                },
            ]
        );
    }
}

#[tokio::test]
async fn pg_fetch_page_sort_desc_and_count() {
    for url in pg_urls() {
        let (s, g) = open(&url).await;
        let n = &g.name;
        s.execute(&format!("create table \"{n}\".n (id int)"))
            .await
            .unwrap();
        s.execute(&format!(
            "insert into \"{n}\".n select generate_series(1,25)"
        ))
        .await
        .unwrap();
        let obj = ObjectRef {
            schema: Some(n.clone()),
            name: "n".into(),
        };
        let rs = s
            .fetch_page(&PageRequest {
                object: obj.clone(),
                limit: 5,
                offset: 0,
                sort: Some(("id".into(), SortDir::Desc)),
            })
            .await
            .unwrap();
        let ids: Vec<_> = rs.rows.iter().map(|r| r[0].clone()).collect();
        let want: Vec<_> = (21..=25).rev().map(CellValue::Int).collect();
        assert_eq!(ids, want);
        assert_eq!(
            s.count_rows(&obj, 500_000).await.unwrap(),
            RowCount::Exact(25)
        );
        // Never analyzed (-1/0) or below threshold: exact. Above threshold after ANALYZE: estimate.
        s.execute(&format!("analyze \"{n}\".n")).await.unwrap();
        assert_eq!(
            s.count_rows(&obj, 10).await.unwrap(),
            RowCount::Estimate(25)
        );
        assert_eq!(s.count_rows(&obj, 25).await.unwrap(), RowCount::Exact(25));
    }
}

#[tokio::test]
async fn pg_wrong_password_is_auth_error() {
    for url in pg_urls() {
        let mut params = params_from_url(&url, DriverKind::Postgres);
        params.password = Some("definitely-wrong".into());
        let err = connect_postgres(&params).await.err().expect("must fail");
        assert_eq!(err.kind, ErrorKind::Auth, "{}", err.message);
    }
}

#[tokio::test]
async fn pg_unreachable_host_is_connection_error() {
    let mut params = params_from_url(&pg_urls()[0], DriverKind::Postgres);
    params.port = 1;
    let err = connect_postgres(&params).await.err().expect("must fail");
    assert_eq!(err.kind, ErrorKind::Connection, "{}", err.message);
}

#[tokio::test]
async fn pg_cancel_long_query() {
    for url in pg_urls() {
        let (s, _g) = open(&url).await;
        let canceller = s.canceller();
        let start = std::time::Instant::now();
        let s2 = s.clone();
        let task = tokio::spawn(async move { s2.execute("select pg_sleep(30)").await });
        tokio::time::sleep(Duration::from_millis(300)).await;
        // A stale cancel on PG is harmless: keep cancelling until the query returns.
        let res = tokio::time::timeout(Duration::from_secs(3), async {
            let mut task = task;
            loop {
                canceller.cancel().await.unwrap();
                tokio::select! {
                    r = &mut task => break r.unwrap(),
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                }
            }
        })
        .await
        .expect("cancel timed out");
        assert_eq!(res.err().unwrap().kind, ErrorKind::Cancelled);
        assert!(start.elapsed() < Duration::from_secs(3));
        // Session stays usable.
        assert!(s.execute("select 1").await.is_ok());
    }
}

#[tokio::test]
async fn pg_terminated_backend_reports_connection_lost() {
    for url in pg_urls() {
        let (s, _g) = open(&url).await;
        let pid = match &only(
            &s.execute("select pg_backend_pid()")
                .await
                .unwrap()
                .result
                .unwrap(),
        )[0]
        {
            CellValue::Int(p) => *p,
            other => panic!("pid: {other:?}"),
        };
        let admin = connect_postgres(&params_from_url(&url, DriverKind::Postgres))
            .await
            .unwrap();
        admin
            .execute(&format!("select pg_terminate_backend({pid})"))
            .await
            .unwrap();
        let res = tokio::time::timeout(Duration::from_secs(5), s.execute("select 1"))
            .await
            .expect("call hung after backend termination");
        assert_eq!(res.err().unwrap().kind, ErrorKind::ConnectionLost);
        // And it stays lost.
        let again = tokio::time::timeout(Duration::from_secs(5), s.execute("select 1"))
            .await
            .expect("hung");
        assert_eq!(again.err().unwrap().kind, ErrorKind::ConnectionLost);
    }
}

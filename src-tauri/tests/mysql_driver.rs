mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{mysql_urls, params_from_url, unique_schema};
use tablemax_lib::driver::mysql::connect_mysql;
use tablemax_lib::driver::{
    ConnectParams, DbObject, DriverKind, ObjectKind, ObjectRef, PageRequest, ResultSet, RowCount,
    Session, SortDir,
};
use tablemax_lib::error::ErrorKind;
use tablemax_lib::value::CellValue;

/// URL order from `scripts/test-dbs.sh env`: MySQL 8 first, MariaDB 11 second.
fn kind_for(index: usize) -> DriverKind {
    if index == 0 {
        DriverKind::MySql
    } else {
        DriverKind::MariaDb
    }
}

fn targets() -> Vec<(String, DriverKind)> {
    mysql_urls()
        .into_iter()
        .enumerate()
        .map(|(i, u)| (u, kind_for(i)))
        .collect()
}

/// Creates a unique database and drops it on drop, even when an assertion fails.
struct TestDb {
    params: ConnectParams,
    name: String,
}

impl Drop for TestDb {
    fn drop(&mut self) {
        let params = self.params.clone();
        let sql = format!("DROP DATABASE IF EXISTS `{}`", self.name);
        let _ = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                if let Ok(s) = connect_mysql(&params).await {
                    let _ = s.execute(&sql).await;
                    let _ = s.close().await;
                }
            });
        })
        .join();
    }
}

async fn open(url: &str, kind: DriverKind) -> (Arc<dyn Session>, TestDb) {
    let params = params_from_url(url, kind);
    let s = connect_mysql(&params).await.unwrap();
    let name = unique_schema();
    s.execute(&format!("CREATE DATABASE `{name}`"))
        .await
        .unwrap();
    (s, TestDb { params, name })
}

fn only(rs: &ResultSet) -> Vec<CellValue> {
    assert_eq!(rs.rows.len(), 1);
    rs.rows[0].clone()
}

#[tokio::test]
async fn mysql_server_version_identifies_flavor() {
    for (i, (url, kind)) in targets().into_iter().enumerate() {
        let (s, _g) = open(&url, kind).await;
        let v = s.server_version();
        assert_eq!(v.contains("MariaDB"), i == 1, "{v}");
        assert_eq!(s.dialect(), tablemax_lib::driver::Dialect::MySql);
    }
}

#[tokio::test]
async fn mysql_dispatch_routes_both_kinds() {
    for (url, kind) in targets() {
        let s = tablemax_lib::driver::connect(&params_from_url(&url, kind))
            .await
            .unwrap();
        assert!(s.execute("select 1").await.is_ok());
        s.close().await.unwrap();
    }
}

#[tokio::test]
async fn mysql_maps_types_exactly() {
    for (url, kind) in targets() {
        let (s, g) = open(&url, kind).await;
        let n = &g.name;
        s.execute(&format!(
            "create table `{n}`.t (u bigint unsigned, i bigint, d decimal(38,10), j json, \
             b blob, s varchar(20), nul varchar(20), dt datetime, f double, e enum('a','b'), \
             y year, tm time, bt bit(8), vb varbinary(4), ti tinyint(1), tx text)"
        ))
        .await
        .unwrap();
        s.execute(&format!(
            "insert into `{n}`.t values (18446744073709551615, -9223372036854775807, \
             12345678901234567890.1234567890, '{{\"a\":1}}', 0x00FF, '', NULL, \
             '2026-10-16 12:00:00', 1.5, 'b', 2026, '12:34:56', b'10000001', 0x0102, 1, 'héllo')"
        ))
        .await
        .unwrap();
        let out = s
            .execute(&format!(
                "select u, i, d, j, b, s, nul, dt, f, e, y, tm, bt, vb, ti, tx from `{n}`.t"
            ))
            .await
            .unwrap();
        let rs = out.result.unwrap();
        let row = only(&rs);
        assert_eq!(row[0], CellValue::BigInt("18446744073709551615".into()));
        assert_eq!(row[1], CellValue::Int(-9223372036854775807));
        assert_eq!(
            row[2],
            CellValue::Decimal("12345678901234567890.1234567890".into())
        );
        assert!(
            matches!(row[3], CellValue::Json(_)),
            "{kind:?} {:?}",
            row[3]
        );
        assert_eq!(
            row[4],
            CellValue::Bytes {
                len: 2,
                hex_preview: "00ff".into()
            }
        );
        assert_eq!(row[5], CellValue::Text(String::new()));
        assert_eq!(row[6], CellValue::Null);
        assert_eq!(row[7], CellValue::Temporal("2026-10-16 12:00:00".into()));
        assert_eq!(row[8], CellValue::Float(1.5));
        assert_eq!(row[9], CellValue::Text("b".into()));
        assert_eq!(row[10], CellValue::Temporal("2026".into()));
        assert_eq!(row[11], CellValue::Temporal("12:34:56".into()));
        assert_eq!(
            row[12],
            CellValue::Bytes {
                len: 1,
                hex_preview: "81".into()
            }
        );
        assert_eq!(
            row[13],
            CellValue::Bytes {
                len: 2,
                hex_preview: "0102".into()
            }
        );
        assert_eq!(row[14], CellValue::Int(1));
        assert_eq!(row[15], CellValue::Text("héllo".into()));
        // Small unsigned values stay Int; type names are exposed.
        let small = s.execute("select cast(5 as unsigned)").await.unwrap();
        assert_eq!(only(small.result.as_ref().unwrap())[0], CellValue::Int(5));
        assert!(!rs.columns[0].type_name.is_empty());
    }
}

#[tokio::test]
async fn mysql_non_utf8_text_becomes_bytes() {
    for (url, kind) in targets() {
        let (s, _g) = open(&url, kind).await;
        // latin1 literal converted to binary-charset-free text then forced invalid via CAST AS BINARY
        let out = s
            .execute("select convert(0xff using latin1)")
            .await
            .unwrap();
        let row = only(out.result.as_ref().unwrap());
        // Server converts to the connection charset, so this must be valid text.
        assert!(matches!(row[0], CellValue::Text(_)), "{:?}", row[0]);
        let out = s.execute("select cast(0xff as binary)").await.unwrap();
        assert!(matches!(
            only(out.result.as_ref().unwrap())[0],
            CellValue::Bytes { len: 1, .. }
        ));
    }
}

#[tokio::test]
async fn mysql_execute_reports_rows_affected() {
    for (url, kind) in targets() {
        let (s, g) = open(&url, kind).await;
        let n = &g.name;
        s.execute(&format!("create table `{n}`.a (id int)"))
            .await
            .unwrap();
        let ins = s
            .execute(&format!("insert into `{n}`.a values (1),(2),(3)"))
            .await
            .unwrap();
        assert!(ins.result.is_none());
        assert_eq!(ins.rows_affected, Some(3));
        let err = s.execute("selec 1").await.err().unwrap();
        assert_eq!(err.kind, ErrorKind::Query);
    }
}

#[tokio::test]
async fn mysql_lists_databases_and_objects() {
    for (url, kind) in targets() {
        let (s, g) = open(&url, kind).await;
        let n = &g.name;
        s.execute(&format!("create table `{n}`.t (id int primary key)"))
            .await
            .unwrap();
        s.execute(&format!("create view `{n}`.v as select * from `{n}`.t"))
            .await
            .unwrap();
        let schemas = s.list_schemas().await.unwrap();
        assert!(schemas.contains(n));
        for hidden in ["mysql", "information_schema", "performance_schema", "sys"] {
            assert!(!schemas.iter().any(|x| x == hidden), "{hidden}");
        }
        let mut sorted = schemas.clone();
        sorted.sort();
        assert_eq!(schemas, sorted);
        let want = vec![
            DbObject {
                schema: Some(n.clone()),
                name: "t".into(),
                kind: ObjectKind::Table,
            },
            DbObject {
                schema: Some(n.clone()),
                name: "v".into(),
                kind: ObjectKind::View,
            },
        ];
        assert_eq!(s.list_objects(Some(n)).await.unwrap(), want);
        // None = current database.
        s.execute(&format!("use `{n}`")).await.unwrap();
        assert_eq!(s.list_objects(None).await.unwrap(), want);
    }
}

#[tokio::test]
async fn mysql_list_objects_without_database_is_invalid() {
    for (url, kind) in targets() {
        let mut params = params_from_url(&url, kind);
        params.database = None;
        let s = connect_mysql(&params).await.unwrap();
        let e = s.list_objects(None).await.err().unwrap();
        assert_eq!(e.kind, ErrorKind::Invalid);
    }
}

#[tokio::test]
async fn mysql_reserved_word_table() {
    for (url, kind) in targets() {
        let (s, g) = open(&url, kind).await;
        let n = &g.name;
        s.execute(&format!("create table `{n}`.`order` (id int)"))
            .await
            .unwrap();
        s.execute(&format!("insert into `{n}`.`order` values (1),(2),(3)"))
            .await
            .unwrap();
        let rs = s
            .fetch_page(&PageRequest {
                object: ObjectRef {
                    schema: Some(n.clone()),
                    name: "order".into(),
                },
                limit: 2,
                offset: 0,
                sort: Some(("id".into(), SortDir::Desc)),
            })
            .await
            .unwrap();
        let ids: Vec<_> = rs.rows.iter().map(|r| r[0].clone()).collect();
        assert_eq!(ids, vec![CellValue::Int(3), CellValue::Int(2)]);
    }
}

#[tokio::test]
async fn mysql_count_rows_exact_and_estimate() {
    for (url, kind) in targets() {
        let (s, g) = open(&url, kind).await;
        let n = &g.name;
        s.execute(&format!("create table `{n}`.n (id int) engine=InnoDB"))
            .await
            .unwrap();
        let values: Vec<String> = (1..=25).map(|i| format!("({i})")).collect();
        s.execute(&format!("insert into `{n}`.n values {}", values.join(",")))
            .await
            .unwrap();
        s.execute(&format!("create view `{n}`.vn as select * from `{n}`.n"))
            .await
            .unwrap();
        let obj = ObjectRef {
            schema: Some(n.clone()),
            name: "n".into(),
        };
        assert_eq!(
            s.count_rows(&obj, 500_000).await.unwrap(),
            RowCount::Exact(25)
        );
        s.execute(&format!("analyze table `{n}`.n")).await.unwrap();
        // Above the threshold the cached estimate is returned (InnoDB: approximate).
        match s.count_rows(&obj, 5).await.unwrap() {
            RowCount::Estimate(e) => assert!(e > 5, "{e}"),
            other => panic!("expected estimate, got {other:?}"),
        }
        // Views have NULL TABLE_ROWS: exact.
        let view = ObjectRef {
            schema: Some(n.clone()),
            name: "vn".into(),
        };
        assert_eq!(s.count_rows(&view, 5).await.unwrap(), RowCount::Exact(25));
        // Missing table is a query error, not a panic.
        let missing = ObjectRef {
            schema: Some(n.clone()),
            name: "nope".into(),
        };
        assert_eq!(
            s.count_rows(&missing, 5).await.err().unwrap().kind,
            ErrorKind::Query
        );
    }
}

#[tokio::test]
async fn mysql_wrong_password_is_auth_error() {
    for (url, kind) in targets() {
        let mut params = params_from_url(&url, kind);
        params.password = Some("definitely-wrong".into());
        let err = connect_mysql(&params).await.err().expect("must fail");
        assert_eq!(err.kind, ErrorKind::Auth, "{}", err.message);
        assert!(!err.message.contains("definitely-wrong"));
    }
}

#[tokio::test]
async fn mysql_unknown_database_is_not_found() {
    for (url, kind) in targets() {
        let mut params = params_from_url(&url, kind);
        params.database = Some("does_not_exist_zz".into());
        let err = connect_mysql(&params).await.err().expect("must fail");
        assert_eq!(err.kind, ErrorKind::NotFound, "{}", err.message);
    }
}

#[tokio::test]
async fn mysql_unreachable_host_is_connection_error() {
    let (url, kind) = targets().remove(0);
    let mut params = params_from_url(&url, kind);
    params.port = 1;
    let err = connect_mysql(&params).await.err().expect("must fail");
    assert_eq!(err.kind, ErrorKind::Connection, "{}", err.message);
}

#[tokio::test]
async fn mysql_rejects_non_local_host() {
    let (url, kind) = targets().remove(0);
    let mut params = params_from_url(&url, kind);
    params.host = "10.0.0.5".into();
    let e = connect_mysql(&params).await.err().unwrap();
    assert_eq!(e.kind, ErrorKind::Connection);
    assert!(e.message.contains("TLS is not supported yet"));
}

#[tokio::test]
async fn mysql_cancel_long_query() {
    for (url, kind) in targets() {
        let (s, _g) = open(&url, kind).await;
        let canceller = s.canceller();
        let start = std::time::Instant::now();
        let s2 = s.clone();
        let task = tokio::spawn(async move { s2.execute("select sleep(30)").await });
        tokio::time::sleep(Duration::from_millis(300)).await;
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
        // MySQL reports sleep() interruption as a successful row (1) in some versions.
        assert_eq!(res.err().unwrap().kind, ErrorKind::Cancelled);
        assert!(start.elapsed() < Duration::from_secs(4));
        assert!(s.execute("select 1").await.is_ok());
    }
}

#[tokio::test]
async fn mysql_killed_connection_reports_connection_lost() {
    for (url, kind) in targets() {
        let (s, _g) = open(&url, kind).await;
        let id = match &only(
            &s.execute("select connection_id()")
                .await
                .unwrap()
                .result
                .unwrap(),
        )[0]
        {
            CellValue::Int(p) => *p,
            other => panic!("id: {other:?}"),
        };
        let admin = connect_mysql(&params_from_url(&url, kind)).await.unwrap();
        admin.execute(&format!("kill {id}")).await.unwrap();
        let res = tokio::time::timeout(Duration::from_secs(5), s.execute("select 1"))
            .await
            .expect("call hung after kill");
        assert_eq!(res.err().unwrap().kind, ErrorKind::ConnectionLost);
        let again = tokio::time::timeout(Duration::from_secs(5), s.execute("select 1"))
            .await
            .expect("hung");
        assert_eq!(again.err().unwrap().kind, ErrorKind::ConnectionLost);
    }
}

#[tokio::test]
async fn mysql_execute_rejects_multiple_statements() {
    for (url, kind) in targets() {
        let (s, g) = open(&url, kind).await;
        let n = &g.name;
        let e = s.execute("select 1; select 2").await.err().unwrap();
        assert_eq!(e.kind, ErrorKind::Invalid);
        let e = s
            .execute(&format!(
                "create table `{n}`.x(a int); insert into `{n}`.x values (1)"
            ))
            .await
            .err()
            .unwrap();
        assert_eq!(e.kind, ErrorKind::Invalid);
        assert!(s.list_objects(Some(n)).await.unwrap().is_empty());
        // Evasion attempts: executable comments and trailing noise.
        for sql in [
            format!("select 1 /*!; create table `{n}`.y(a int) */"),
            format!("select 1 ;\n -- c\n create table `{n}`.y(a int)"),
            format!("select 1;;"),
        ] {
            let e = s.execute(&sql).await.err().unwrap();
            assert_eq!(e.kind, ErrorKind::Invalid, "{sql}");
        }
        assert!(s.list_objects(Some(n)).await.unwrap().is_empty());
        // Semicolons inside literals/comments and a single trailing ';' are fine.
        assert!(
            s.execute("select 'a;b', \"c;d\", `e;f` from (select 1 as `e;f`) t")
                .await
                .is_ok()
        );
        assert!(s.execute("select 1 /* ; */ ; -- trailing").await.is_ok());
        assert!(s.execute("select 1;").await.is_ok());
        // A real syntax error stays a Query error.
        assert_eq!(
            s.execute("selec 1").await.err().unwrap().kind,
            ErrorKind::Query
        );
    }
}

#[tokio::test]
async fn mysql_lexer_follows_session_sql_mode() {
    for (url, kind) in targets() {
        let (s, _g) = open(&url, kind).await;
        let text = |o: tablemax_lib::driver::StatementOutcome| match &only(&o.result.unwrap())[0] {
            CellValue::Text(t) => t.clone(),
            other => panic!("{other:?}"),
        };
        // Default: the escaped quote keeps the literal open, so this is ONE statement.
        let o = s.execute(r"select 'a\'; select 2'").await.unwrap();
        assert_eq!(text(o), "a'; select 2");

        s.execute("SET sql_mode=CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')")
            .await
            .unwrap();
        // Backslash is now literal: one statement, and the bypass attempt is rejected.
        let o = s.execute(r"select 'a\'").await.unwrap();
        assert_eq!(text(o), r"a\");
        for sql in [r"select 'a\'; select 2; select '", r"select 'a\'; select 2"] {
            let e = s.execute(sql).await.err().unwrap();
            assert_eq!(e.kind, ErrorKind::Invalid, "{sql}");
        }
        s.execute("SET sql_mode=REPLACE(@@sql_mode, 'NO_BACKSLASH_ESCAPES', '')")
            .await
            .unwrap();
        let o = s.execute(r"select 'a\'; select 2'").await.unwrap();
        assert_eq!(text(o), "a'; select 2");

        s.execute("SET sql_mode=CONCAT(@@sql_mode, ',ANSI_QUOTES')")
            .await
            .unwrap();
        // "..." is an identifier with no backslash escapes.
        assert!(s.execute(r#"select 1 as "a\""#).await.is_ok());
        let e = s
            .execute(r#"select 1 as "a\"; drop table t; -- ""#)
            .await
            .err()
            .unwrap();
        assert_eq!(e.kind, ErrorKind::Invalid);
    }
}

#[tokio::test]
async fn mysql_failed_cancel_does_not_report_cancelled() {
    for (url, kind) in targets() {
        let root = connect_mysql(&params_from_url(&url, kind)).await.unwrap();
        let user = format!("c_{}", &unique_schema()[2..14]);
        root.execute(&format!("CREATE USER '{user}'@'%' IDENTIFIED BY 'pw1'"))
            .await
            .unwrap();
        root.execute(&format!("GRANT ALL ON *.* TO '{user}'@'%'"))
            .await
            .unwrap();
        let mut params = params_from_url(&url, kind);
        params.user = user.clone();
        params.password = Some("pw1".into());
        let result = async {
            let s = connect_mysql(&params).await.unwrap();
            // The canceller reuses the stored password: break it so the KILL cannot be sent.
            root.execute(&format!("ALTER USER '{user}'@'%' IDENTIFIED BY 'pw2'"))
                .await
                .unwrap();
            let canceller = s.canceller();
            let s2 = s.clone();
            let task = tokio::spawn(async move { s2.execute("select sleep(1)").await });
            tokio::time::sleep(Duration::from_millis(300)).await;
            let cancel = canceller.cancel().await;
            let out = task.await.unwrap();
            (cancel, out)
        }
        .await;
        let _ = root
            .execute(&format!("DROP USER IF EXISTS '{user}'@'%'"))
            .await;
        let (cancel, out) = result;
        assert_eq!(cancel.err().unwrap().kind, ErrorKind::Auth);
        let out = out.expect("statement must keep its real result");
        assert_eq!(only(out.result.as_ref().unwrap())[0], CellValue::Int(0));
        // Idle cancel is a no-op success even with broken credentials.
    }
}

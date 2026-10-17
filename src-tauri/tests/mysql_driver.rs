mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{mysql_urls, params_from_url, ssl, tls_file, unique_schema};
use tablemax_lib::driver::mysql::connect_mysql;
use tablemax_lib::driver::query::build_page;
use tablemax_lib::driver::tls::{SslConfig, SslMode};
use tablemax_lib::driver::{
    ConnectParams, DbObject, DriverKind, ObjectKind, ObjectRef, PageRequest, ResultSet, RowCount,
    Session, SortDir,
};
use tablemax_lib::error::ErrorKind;
use tablemax_lib::value::{CellValue, MAX_RESULT_ROWS, TEXT_PREVIEW_CHARS};

/// One page the way the manager builds it: metadata, `build_page`, `query`.
async fn page(s: &dyn Session, req: PageRequest) -> ResultSet {
    let info = s.table_info(&req.object).await.unwrap();
    let stmt = build_page(s.dialect(), &info, &req).unwrap();
    s.query(&stmt).await.unwrap()
}

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
        // Beyond 2^53 an int travels as exact digits (JS numbers would round it).
        assert_eq!(row[1], CellValue::BigInt("-9223372036854775807".into()));
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
        let rs = page(
            &*s,
            PageRequest {
                object: ObjectRef {
                    schema: Some(n.clone()),
                    name: "order".into(),
                },
                limit: 2,
                offset: 0,
                sort: Some(("id".into(), SortDir::Desc)),
                filters: vec![],
            },
        )
        .await;
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

/// Runs `select sleep(30)` and cancels it: must end as `Cancelled` within 4 s, and the
/// session must stay usable.
async fn assert_sleep_is_cancelled(s: &Arc<dyn Session>) {
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

/// The server can send an interrupted `SLEEP()`'s row (MySQL answers it with a normal
/// result, not error 1317) before the `KILL QUERY` reply reaches the canceller: the
/// statement must still report `Cancelled`. Several sessions at once widen that window.
#[tokio::test]
async fn mysql_cancel_reported_even_when_the_result_beats_the_kill_reply() {
    for (url, kind) in targets() {
        let mut rounds = Vec::new();
        for _ in 0..6 {
            let url = url.clone();
            rounds.push(tokio::spawn(async move {
                let (s, _g) = open(&url, kind).await;
                for round in 0..5 {
                    let canceller = s.canceller();
                    let s2 = s.clone();
                    let task = tokio::spawn(async move { s2.execute("select sleep(30)").await });
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    canceller.cancel().await.unwrap();
                    let res = tokio::time::timeout(Duration::from_secs(4), task)
                        .await
                        .expect("cancel timed out")
                        .unwrap();
                    match res {
                        Err(e) => assert_eq!(e.kind, ErrorKind::Cancelled, "{url} round {round}"),
                        Ok(out) => panic!("{url} round {round}: cancelled sleep returned {:?}", out.result),
                    }
                    assert!(s.execute("select 1").await.is_ok());
                }
            }));
        }
        for r in rounds {
            r.await.unwrap();
        }
    }
}

#[tokio::test]
async fn mysql_cancel_long_query() {
    for (url, kind) in targets() {
        let (s, _g) = open(&url, kind).await;
        assert_sleep_is_cancelled(&s).await;
    }
}

/// The session's `Ssl_cipher` (empty when the connection is not encrypted).
async fn ssl_cipher(s: &Arc<dyn Session>) -> CellValue {
    let out = s
        .execute("SHOW SESSION STATUS LIKE 'Ssl_cipher'")
        .await
        .unwrap();
    only(out.result.as_ref().unwrap())[1].clone()
}

fn assert_encrypted(cipher: &CellValue) {
    match cipher {
        CellValue::Text(c) => assert!(!c.is_empty(), "connection is not encrypted"),
        other => panic!("Ssl_cipher: {other:?}"),
    }
}

fn my_params(url: &str, kind: DriverKind, host: &str, ssl: SslConfig) -> ConnectParams {
    let mut p = params_from_url(url, kind);
    p.host = host.into();
    p.ssl = ssl;
    p
}

#[tokio::test]
async fn mysql_require_encrypts() {
    for (url, kind) in targets() {
        let p = my_params(&url, kind, "127.0.0.1", ssl(SslMode::Require, None));
        let s = connect_mysql(&p).await.unwrap();
        assert_encrypted(&ssl_cipher(&s).await);
        s.close().await.unwrap();
    }
}

#[tokio::test]
async fn mysql_disable_stays_cleartext() {
    for (url, kind) in targets() {
        let p = my_params(&url, kind, "127.0.0.1", ssl(SslMode::Disable, None));
        let s = connect_mysql(&p).await.unwrap();
        assert_eq!(ssl_cipher(&s).await, CellValue::Text(String::new()));
        s.close().await.unwrap();
    }
}

#[tokio::test]
async fn mysql_verify_full_ok_on_localhost() {
    for (url, kind) in targets() {
        let p = my_params(
            &url,
            kind,
            "localhost",
            ssl(SslMode::VerifyFull, Some("ca.pem")),
        );
        let s = connect_mysql(&p).await.unwrap();
        assert_encrypted(&ssl_cipher(&s).await);
        s.close().await.unwrap();
    }
}

#[tokio::test]
async fn mysql_verify_full_rejects_wrong_name() {
    for (url, kind) in targets() {
        // The test certificate has no IP:127.0.0.1 SAN.
        let p = my_params(
            &url,
            kind,
            "127.0.0.1",
            ssl(SslMode::VerifyFull, Some("ca.pem")),
        );
        let e = connect_mysql(&p).await.err().expect("must fail");
        assert_eq!(e.kind, ErrorKind::Connection, "{}", e.message);
        assert!(e.message.contains("not valid for name"), "{}", e.message);
    }
}

#[tokio::test]
async fn mysql_verify_full_rejects_foreign_ca() {
    for (url, kind) in targets() {
        let p = my_params(
            &url,
            kind,
            "localhost",
            ssl(SslMode::VerifyFull, Some("foreign-ca.pem")),
        );
        let e = connect_mysql(&p).await.err().expect("must fail");
        assert_eq!(e.kind, ErrorKind::Connection, "{}", e.message);
    }
}

#[tokio::test]
async fn mysql_verify_ca_is_not_supported() {
    for (url, kind) in targets() {
        let p = my_params(
            &url,
            kind,
            "localhost",
            ssl(SslMode::VerifyCa, Some("ca.pem")),
        );
        let e = connect_mysql(&p).await.err().expect("must fail");
        assert_eq!(e.kind, ErrorKind::Invalid, "{}", e.message);
        assert!(
            e.message.contains("verify-ca is not supported"),
            "{}",
            e.message
        );
    }
}

#[tokio::test]
async fn mysql_client_cert_is_presented() {
    for (url, kind) in targets() {
        let root = connect_mysql(&params_from_url(&url, kind)).await.unwrap();
        let user = format!("x_{}", &unique_schema()[2..14]);
        root.execute(&format!("CREATE USER '{user}'@'%' REQUIRE X509"))
            .await
            .unwrap();
        let mut p = my_params(
            &url,
            kind,
            "localhost",
            ssl(SslMode::VerifyFull, Some("ca.pem")),
        );
        p.user = user.clone();
        p.password = None;
        // The throwaway user has no grants on the test database.
        p.database = None;
        let without = connect_mysql(&p).await.map(|_| ());
        p.ssl.cert_file = Some(tls_file("client.pem"));
        p.ssl.key_file = Some(tls_file("client.key"));
        let with = connect_mysql(&p).await;
        let _ = root
            .execute(&format!("DROP USER IF EXISTS '{user}'@'%'"))
            .await;
        assert!(
            without.is_err(),
            "REQUIRE X509 user logged in without a cert"
        );
        let s = with.unwrap();
        assert_encrypted(&ssl_cipher(&s).await);
        s.close().await.unwrap();
    }
}

#[tokio::test]
async fn mysql_cancel_over_tls() {
    for (url, kind) in targets() {
        let p = my_params(&url, kind, "127.0.0.1", ssl(SslMode::Require, None));
        let s = connect_mysql(&p).await.unwrap();
        assert_encrypted(&ssl_cipher(&s).await);
        assert_sleep_is_cancelled(&s).await;
        s.close().await.unwrap();
    }
}

#[tokio::test]
async fn mysql_dial_targets_address_and_keeps_tls_name() {
    for (url, kind) in targets() {
        let base = params_from_url(&url, kind);
        // `mysql8` / `mariadb11` do not resolve on the host but are in the certificate:
        // TCP goes to `dial`, TLS verifies the name (and the canceller follows the same route).
        let name = if kind == DriverKind::MySql {
            "mysql8"
        } else {
            "mariadb11"
        };
        let mut p = my_params(&url, kind, name, ssl(SslMode::VerifyFull, Some("ca.pem")));
        p.dial = Some(format!("127.0.0.1:{}", base.port).parse().unwrap());
        let s = connect_mysql(&p).await.unwrap();
        assert_encrypted(&ssl_cipher(&s).await);
        assert_sleep_is_cancelled(&s).await;
        s.close().await.unwrap();
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
            "select 1;;".to_string(),
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

/// After `SET NAMES gbk` (and the other client charsets whose multi-byte characters can
/// end with a 0x5C byte) the server reads `\'` after such a character as the end of the
/// string, so the lexer would miss a second statement: every statement is refused until
/// the charset is back to a safe one (an ASCII SET is still accepted to get there).
#[tokio::test]
async fn mysql_refuses_multibyte_unsafe_client_charsets() {
    for (url, kind) in targets() {
        let (s, g) = open(&url, kind).await;
        let n = &g.name;
        s.execute(&format!("create table `{n}`.t(a int)"))
            .await
            .unwrap();
        // UTF-8 `中` is E4 B8 AD: read as gbk, `AD 5C` is one character and eats the `\`.
        let payload = format!("select '中\\'; drop table `{n}`.t; -- '");
        for set in [
            "SET NAMES gbk",
            "set character set big5",
            "SET character_set_client = sjis",
            "SET NAMES cp932",
            "SET NAMES gb18030",
        ] {
            if set.contains("gb18030") && kind == DriverKind::MariaDb {
                continue; // MariaDB has no gb18030.
            }
            s.execute(set).await.unwrap();
            for sql in [payload.as_str(), "select 1"] {
                let e = s.execute(sql).await.err().unwrap();
                assert_eq!(e.kind, ErrorKind::Invalid, "{set}: {sql}");
                assert!(
                    e.message.contains("client character set")
                        && e.message.contains("SET NAMES utf8mb4"),
                    "{set}: {}",
                    e.message
                );
            }
            s.execute("SET NAMES utf8mb4").await.unwrap();
            assert_eq!(s.list_objects(Some(n)).await.unwrap().len(), 1, "{set}");
            // Back to normal: the same text is one statement (a string literal).
            assert!(s.execute(&payload).await.is_ok(), "{set}");
        }
        // A failing statement that changes nothing is followed by a re-read too.
        s.execute("SET NAMES gbk").await.unwrap();
        assert!(s.execute("SET NAMES no_such_charset").await.is_err());
        assert_eq!(
            s.execute("select 1").await.err().unwrap().kind,
            ErrorKind::Invalid
        );
        s.execute("SET NAMES utf8mb4").await.unwrap();
        assert!(s.execute("select 1").await.is_ok());
    }
}

/// MySQL 9 JavaScript routines (`AS $$ … $$`) hide their body from the lexer: refused.
#[tokio::test]
async fn mysql_refuses_dollar_quoted_bodies() {
    for (url, kind) in targets() {
        let (s, g) = open(&url, kind).await;
        let n = &g.name;
        for sql in [
            format!("create function `{n}`.f() returns int language javascript as $$ return 1; $$"),
            format!(
                "create function `{n}`.f() returns int language javascript as $js$ return 1 $js$"
            ),
            format!(
                "create function `{n}`.f() returns int language javascript as $$ ' $$; drop database `{n}`; -- '"
            ),
        ] {
            let e = s.execute(&sql).await.err().unwrap();
            assert_eq!(e.kind, ErrorKind::Invalid, "{sql}");
            assert!(e.message.contains("dollar-quoted"), "{}", e.message);
        }
        // `$` inside identifiers is not a dollar quote.
        assert!(s.execute("select 1 as a$b, 2 as `$$`").await.is_ok());
    }
}

/// The modes are re-read after a failing statement as well: a MariaDB anonymous block
/// keeps a `SET NAMES` it ran before failing. (Stored routines, and these blocks for
/// sql_mode, restore the caller's values when they return.)
#[tokio::test]
async fn mysql_modes_are_reread_after_an_error() {
    for (url, kind) in targets() {
        if kind != DriverKind::MariaDb {
            continue;
        }
        let (s, _g) = open(&url, kind).await;
        let e = s
            .execute("BEGIN NOT ATOMIC SET NAMES gbk; SIGNAL SQLSTATE '45000'; END")
            .await
            .err()
            .unwrap();
        assert_eq!(e.kind, ErrorKind::Query);
        let e = s.execute("select 1").await.err().unwrap();
        assert_eq!(e.kind, ErrorKind::Invalid);
        assert!(
            e.message.contains("client character set gbk"),
            "{}",
            e.message
        );
        s.execute("SET NAMES utf8mb4").await.unwrap();
        assert!(s.execute("select 1").await.is_ok());
    }
}

/// The session modes are re-read after EVERY statement: a comment-prefixed or
/// executable-comment EXECUTE (or MariaDB EXECUTE IMMEDIATE on a built string) changes
/// the charset / sql_mode without any keyword the driver could spot.
#[tokio::test]
async fn mysql_modes_changed_by_disguised_statements_are_seen() {
    for (url, kind) in targets() {
        let (s, g) = open(&url, kind).await;
        let n = &g.name;
        s.execute(&format!("create table `{n}`.t(a int)"))
            .await
            .unwrap();
        let payload = format!("select '中\\'; drop table `{n}`.t; -- '");
        s.execute("PREPARE cs FROM 'SET NAMES gbk'").await.unwrap();
        let mut switches = vec![
            "/* x */ EXECUTE cs",
            "/*! EXECUTE cs */",
            "-- c\nEXECUTE cs",
        ];
        if kind == DriverKind::MariaDb {
            switches.push("-- c\nEXECUTE IMMEDIATE CONCAT('SET NA','MES gbk')");
        }
        for switch in switches {
            s.execute(switch).await.unwrap();
            let e = s.execute(&payload).await.err().unwrap();
            assert_eq!(e.kind, ErrorKind::Invalid, "{switch}");
            assert!(
                e.message.contains("client character set gbk"),
                "{switch}: {}",
                e.message
            );
            s.execute("SET NAMES utf8mb4").await.unwrap();
            assert_eq!(s.list_objects(Some(n)).await.unwrap().len(), 1, "{switch}");
        }
        // Same for NO_BACKSLASH_ESCAPES.
        s.execute(
            "PREPARE nb FROM 'SET SESSION sql_mode = CONCAT(@@sql_mode, '',NO_BACKSLASH_ESCAPES'')'",
        )
        .await
        .unwrap();
        s.execute("/* x */ EXECUTE nb").await.unwrap();
        let e = s
            .execute(&format!(r"select 'a\'; drop table `{n}`.t; -- '"))
            .await
            .err()
            .unwrap();
        assert_eq!(e.kind, ErrorKind::Invalid);
        assert_eq!(s.list_objects(Some(n)).await.unwrap().len(), 1);
    }
}

/// Objects of the test database, counted from a fresh session (the test session's
/// sql_select_limit would also limit this metadata read).
async fn table_count_elsewhere(g: &TestDb) -> usize {
    let admin = connect_mysql(&g.params).await.unwrap();
    let count = admin.list_objects(Some(&g.name)).await.unwrap().len();
    admin.close().await.unwrap();
    count
}

/// `sql_select_limit = 0` must not blind the session-state re-read (an empty answer was
/// once taken as "default modes, safe charset").
#[tokio::test]
async fn mysql_sql_select_limit_does_not_hide_the_session_state() {
    for (url, kind) in targets() {
        let (s, g) = open(&url, kind).await;
        let n = &g.name;
        s.execute(&format!("create table `{n}`.t(a int)"))
            .await
            .unwrap();
        s.execute("SET SESSION sql_select_limit = 0").await.unwrap();
        s.execute("SET NAMES gbk").await.unwrap();
        let e = s
            .execute(&format!("select '中\\'; drop table `{n}`.t; -- '"))
            .await
            .err()
            .unwrap();
        assert_eq!(e.kind, ErrorKind::Invalid, "{}", e.message);
        assert!(
            e.message.contains("client character set gbk"),
            "{}",
            e.message
        );
        assert_eq!(table_count_elsewhere(&g).await, 1);
        s.execute("SET NAMES utf8mb4").await.unwrap();
        s.execute("SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')")
            .await
            .unwrap();
        let e = s
            .execute(&format!(r"select 'a\'; drop table `{n}`.t; -- '"))
            .await
            .err()
            .unwrap();
        assert_eq!(e.kind, ErrorKind::Invalid, "{}", e.message);
        assert_eq!(table_count_elsewhere(&g).await, 1);
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

/// `n` rows numbered 1..=n, without recursion limits (MySQL caps CTE depth at 1000).
fn numbers(n: u32) -> String {
    let d = "(select 0 n union all select 1 union all select 2 union all select 3 \
             union all select 4 union all select 5 union all select 6 union all select 7 \
             union all select 8 union all select 9)";
    format!(
        "select a.n + 10*b.n + 100*c.n + 1000*d.n + 10000*e.n + 1 as g \
         from {d} a, {d} b, {d} c, {d} d, {d} e \
         where a.n + 10*b.n + 100*c.n + 1000*d.n + 10000*e.n < {n} order by g"
    )
}

#[tokio::test]
async fn mysql_huge_json_cell_is_truncated() {
    for (url, kind) in targets() {
        let (s, g) = open(&url, kind).await;
        let n = &g.name;
        s.execute(&format!("create table `{n}`.j (j json)"))
            .await
            .unwrap();
        s.execute(&format!(
            "insert into `{n}`.j values (json_object('k', repeat('x', 20000))), ('[1]')"
        ))
        .await
        .unwrap();
        let rs = s
            .execute(&format!("select j from `{n}`.j"))
            .await
            .unwrap()
            .result
            .unwrap();
        assert_eq!(rs.rows.len(), 2);
        let mut seen_long = false;
        for row in &rs.rows {
            match &row[0] {
                CellValue::LongText { preview, len } => {
                    assert_eq!(preview.chars().count(), TEXT_PREVIEW_CHARS, "{kind:?}");
                    assert!(*len > 20_000, "{kind:?} {len}");
                    seen_long = true;
                }
                CellValue::Json(s) => assert_eq!(s, "[1]", "{kind:?}"),
                other => panic!("{kind:?}: unexpected {other:?}"),
            }
        }
        assert!(seen_long, "{kind:?}");
    }
}

#[tokio::test]
async fn mysql_sql_results_are_capped() {
    for (url, kind) in targets() {
        let (s, _g) = open(&url, kind).await;
        let big = s.execute(&numbers(10_005)).await.unwrap().result.unwrap();
        assert_eq!(big.rows.len(), MAX_RESULT_ROWS, "{kind:?}");
        assert!(big.truncated, "{kind:?}");
        assert_eq!(big.rows[MAX_RESULT_ROWS - 1][0], CellValue::Int(10_000));
        let exact = s.execute(&numbers(10_000)).await.unwrap().result.unwrap();
        assert_eq!(exact.rows.len(), MAX_RESULT_ROWS, "{kind:?}");
        assert!(!exact.truncated, "{kind:?}");
        // The connection stays in sync after a capped result.
        let one = s.execute("select 7").await.unwrap().result.unwrap();
        assert_eq!(only(&one)[0], CellValue::Int(7));
        assert!(!one.truncated);
    }
}

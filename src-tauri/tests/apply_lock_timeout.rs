//! `Session::apply` bounds how long a change waits for a row lock held by someone else
//! (PostgreSQL `lock_timeout`, MySQL/MariaDB `innodb_lock_wait_timeout`): the wait ends as
//! a normal failure of that change, everything is rolled back, and the session's own
//! setting is restored. Own binary: it shortens the process-wide bound to one second.

mod common;

use std::time::{Duration, Instant};

use common::{mysql_urls, params_from_url, pg_urls, unique_schema};
use tablemax_lib::driver::dml::set_apply_lock_timeout_secs;
use tablemax_lib::driver::mysql::connect_mysql;
use tablemax_lib::driver::postgres::connect_postgres;
use tablemax_lib::driver::query::{SqlParam, Statement};
use tablemax_lib::driver::{DriverKind, Session};
use tablemax_lib::error::ErrorKind;
use tablemax_lib::value::CellValue;

async fn first_text(s: &dyn Session, sql: &str) -> String {
    let out = s.execute(sql).await.unwrap();
    match out.result.unwrap().rows[0][0].clone() {
        CellValue::Text(t) => t,
        CellValue::Int(n) => n.to_string(),
        CellValue::BigInt(t) | CellValue::Decimal(t) => t,
        other => panic!("{other:?}"),
    }
}

/// `holder` holds row 1 of `table`; `s` applies [row 2, row 1] and must give up on row 1.
async fn assert_lock_wait_is_bounded(holder: &dyn Session, s: &dyn Session, table: &str, begin: &str) {
    holder.execute(begin).await.unwrap();
    holder
        .execute(&format!("UPDATE {table} SET v = 10 WHERE id = 1"))
        .await
        .unwrap();
    let ph = |n: usize| match s.dialect() {
        tablemax_lib::driver::Dialect::Postgres => format!("CAST(${n}::text AS integer)"),
        _ => "?".to_string(),
    };
    let stmt = |id: &str| Statement {
        sql: format!("UPDATE {table} SET v = {} WHERE id = {}", ph(1), ph(2)),
        params: vec![SqlParam::Text("99".into()), SqlParam::Text(id.into())],
    };
    let started = Instant::now();
    let outcome = tokio::time::timeout(
        Duration::from_secs(20),
        s.apply(&[stmt("2"), stmt("1")], &[true, true]),
    )
    .await
    .expect("the lock wait must be bounded")
    .unwrap();
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(!outcome.applied, "{outcome:?}");
    assert_eq!(outcome.failed_index, Some(1), "{outcome:?}");
    assert_eq!(outcome.error.unwrap().kind, ErrorKind::Query);
    holder.execute("ROLLBACK").await.unwrap();
    // Row 2 was rolled back with the rest.
    assert_eq!(
        first_text(s, &format!("SELECT v FROM {table} WHERE id = 2")).await,
        "2"
    );
}

#[tokio::test]
async fn lock_waits_are_bounded_and_settings_restored() {
    set_apply_lock_timeout_secs(1);
    for url in pg_urls() {
        let p = params_from_url(&url, DriverKind::Postgres);
        let (holder, s) = (
            connect_postgres(&p).await.unwrap(),
            connect_postgres(&p).await.unwrap(),
        );
        let schema = unique_schema();
        let t = format!("\"{schema}\".t");
        holder
            .execute(&format!("CREATE SCHEMA \"{schema}\""))
            .await
            .unwrap();
        holder
            .execute(&format!("CREATE TABLE {t} (id int PRIMARY KEY, v int)"))
            .await
            .unwrap();
        holder
            .execute(&format!("INSERT INTO {t} VALUES (1, 1), (2, 2)"))
            .await
            .unwrap();
        assert_lock_wait_is_bounded(&*holder, &*s, &t, "BEGIN").await;
        assert_eq!(first_text(&*s, "SHOW lock_timeout").await, "0");
        holder
            .execute(&format!("DROP SCHEMA \"{schema}\" CASCADE"))
            .await
            .unwrap();
    }
    for (i, url) in mysql_urls().into_iter().enumerate() {
        let kind = if i == 0 {
            DriverKind::MySql
        } else {
            DriverKind::MariaDb
        };
        let p = params_from_url(&url, kind);
        let (holder, s) = (
            connect_mysql(&p).await.unwrap(),
            connect_mysql(&p).await.unwrap(),
        );
        let before = first_text(&*s, "SELECT @@SESSION.innodb_lock_wait_timeout").await;
        let schema = unique_schema();
        let t = format!("`{schema}`.t");
        holder
            .execute(&format!("CREATE DATABASE `{schema}`"))
            .await
            .unwrap();
        holder
            .execute(&format!("CREATE TABLE {t} (id int PRIMARY KEY, v int)"))
            .await
            .unwrap();
        holder
            .execute(&format!("INSERT INTO {t} VALUES (1, 1), (2, 2)"))
            .await
            .unwrap();
        assert_lock_wait_is_bounded(&*holder, &*s, &t, "START TRANSACTION").await;
        assert_eq!(
            first_text(&*s, "SELECT @@SESSION.innodb_lock_wait_timeout").await,
            before,
            "{kind:?}"
        );
        holder
            .execute(&format!("DROP DATABASE `{schema}`"))
            .await
            .unwrap();
    }
}

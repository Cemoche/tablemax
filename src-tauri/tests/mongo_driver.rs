//! MongoDB driver integration tests against the test server(s) (`TABLEMAX_TEST_MONGO_URLS`,
//! user `root`; `TABLEMAX_TEST_MONGO_READER_URL`, user `reader`). The test sshd reaches
//! the server as `mongo7:27017`. Needs `TABLEMAX_EXPERIMENTAL=mongodb` (`test-dbs.sh env`).
mod common;

use std::sync::Arc;

use common::{mongo_params, mongo_reader_url, mongo_urls, ssh_addr, ssl};
use tablemax_lib::driver::mongo::options::check_tunnel;
use tablemax_lib::driver::tls::SslMode;
use tablemax_lib::driver::{
    self, AnySession, ConnectParams, DbObject, DocumentSession, ObjectKind, ObjectRef, RowCount,
};
use tablemax_lib::error::{AppResult, ErrorKind};
use tablemax_lib::ssh::known_hosts::KnownHosts;
use tablemax_lib::ssh::tunnel::{HostKeyPolicy, SshAuthMaterial, SshTarget, open_tunnel};
use tablemax_lib::store::MongoSettings;

const DB: &str = "tablemax_test";

async fn connect(p: &ConnectParams) -> AppResult<Arc<dyn DocumentSession>> {
    let s = driver::connect(p).await?;
    assert!(matches!(s, AnySession::Documents(_)));
    Ok(s.documents()?.clone())
}

/// `p` with a short server selection timeout, for connections expected to fail.
fn fail_fast(mut p: ConnectParams) -> ConnectParams {
    p.mongo
        .as_mut()
        .unwrap()
        .options
        .push(("serverSelectionTimeoutMS".into(), "3000".into()));
    p
}

fn obj(db: &str, name: &str) -> ObjectRef {
    ObjectRef {
        schema: Some(db.into()),
        name: name.into(),
    }
}

fn names(objects: &[DbObject]) -> Vec<(String, ObjectKind)> {
    objects.iter().map(|o| (o.name.clone(), o.kind)).collect()
}

fn seeded() -> Vec<(String, ObjectKind)> {
    vec![
        ("customers".into(), ObjectKind::Table),
        ("orders".into(), ObjectKind::Table),
        ("paid_orders".into(), ObjectKind::View),
    ]
}

/// (major, minor) of a version string such as `7.0.14`.
fn major_minor(v: &str) -> (u32, u32) {
    let mut it = v.split('.').map(|n| n.parse::<u32>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0))
}

#[tokio::test]
async fn connects_and_reports_version() {
    for url in mongo_urls() {
        let p = mongo_params(&url);
        let any = driver::connect(&p).await.unwrap();
        assert!(any.sql().is_err(), "a document session has no SQL");
        let s = any.documents().unwrap().clone();
        let v = s.server_version();
        assert!(major_minor(&v) >= (4, 4), "{v}");
        assert!(!s.is_lost());
        s.close().await.unwrap();
        assert!(s.is_lost());
        let e = s.list_schemas().await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::ConnectionLost);
    }
}

#[tokio::test]
async fn lists_databases_collections_and_views() {
    for url in mongo_urls() {
        let s = connect(&mongo_params(&url)).await.unwrap();
        let dbs = s.list_schemas().await.unwrap();
        for db in [DB, "admin"] {
            assert!(dbs.contains(&db.to_string()), "{dbs:?}");
        }
        assert_eq!(s.list_databases().await.unwrap(), dbs);

        let objects = s.list_objects(Some(DB)).await.unwrap();
        assert_eq!(names(&objects), seeded(), "no system.* collection");
        assert!(objects.iter().all(|o| o.schema.as_deref() == Some(DB)));
        // `None`: the connection's database.
        assert_eq!(s.list_objects(None).await.unwrap(), objects);

        let catalog = s.catalog(Some(DB)).await.unwrap();
        assert_eq!(catalog.schema.as_deref(), Some(DB));
        let tables: Vec<_> = catalog
            .tables
            .iter()
            .map(|t| (t.name.clone(), t.kind))
            .collect();
        assert_eq!(tables, seeded());
        assert!(catalog.tables.iter().all(|t| t.columns.is_empty()));

        // A collection: the server's estimate; a view: counted, capped.
        assert_eq!(
            s.count_rows(&obj(DB, "orders"), 1000).await.unwrap(),
            RowCount::Estimate(4)
        );
        assert_eq!(
            s.count_rows(&obj(DB, "paid_orders"), 1000).await.unwrap(),
            RowCount::Exact(2)
        );
        assert_eq!(
            s.count_rows(&obj(DB, "paid_orders"), 1).await.unwrap(),
            RowCount::Estimate(1)
        );
        let e = s.count_rows(&obj(DB, "nope"), 1000).await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::NotFound, "{}", e.message);
        s.close().await.unwrap();
    }
}

#[tokio::test]
async fn restricted_user_lists_authorized_databases() {
    let s = connect(&mongo_params(&mongo_reader_url())).await.unwrap();
    assert_eq!(s.list_schemas().await.unwrap(), vec![DB.to_string()]);
    assert_eq!(names(&s.list_objects(Some(DB)).await.unwrap()), seeded());
    assert_eq!(
        s.count_rows(&obj(DB, "paid_orders"), 1000).await.unwrap(),
        RowCount::Exact(2)
    );
    s.close().await.unwrap();
}

/// TLS connections the server has accepted so far (`serverStatus.transportSecurity`).
async fn tls_connections(url: &str) -> i64 {
    let client = mongodb::Client::with_uri_str(url).await.unwrap();
    let status = client
        .database("admin")
        .run_command(mongodb::bson::doc! { "serverStatus": 1 })
        .await
        .unwrap();
    let ts = status.get_document("transportSecurity").unwrap();
    let total = ts
        .iter()
        .filter_map(|(_, v)| v.as_i64().or(v.as_i32().map(i64::from)))
        .sum();
    client.shutdown().immediate(true).await;
    total
}

#[tokio::test]
async fn tls_verify_full_with_ca_file() {
    for url in mongo_urls() {
        let before = tls_connections(&url).await;
        let mut p = mongo_params(&url);
        p.host = "localhost".into();
        p.ssl = ssl(SslMode::VerifyFull, Some("ca.pem"));
        let s = connect(&p).await.unwrap();
        assert!(s.list_schemas().await.unwrap().contains(&DB.to_string()));
        s.close().await.unwrap();
        assert!(tls_connections(&url).await > before);
    }
}

#[tokio::test]
async fn tls_verify_full_without_ca_fails() {
    for url in mongo_urls() {
        // The Mozilla roots do not know the test CA.
        let mut p = fail_fast(mongo_params(&url));
        p.host = "localhost".into();
        p.ssl = ssl(SslMode::VerifyFull, None);
        let e = connect(&p).await.err().expect("an unknown CA must fail");
        assert_eq!(e.kind, ErrorKind::Connection, "{}", e.message);
        // With the CA but a name the certificate does not hold.
        let mut p = fail_fast(mongo_params(&url));
        p.ssl = ssl(SslMode::VerifyFull, Some("ca.pem"));
        let e = connect(&p)
            .await
            .err()
            .expect("127.0.0.1 is not in the SAN");
        assert_eq!(e.kind, ErrorKind::Connection, "{}", e.message);
    }
}

#[tokio::test]
async fn tls_require_accepts_unknown_ca() {
    for url in mongo_urls() {
        let before = tls_connections(&url).await;
        let mut p = mongo_params(&url);
        p.ssl = ssl(SslMode::Require, None);
        let s = connect(&p).await.unwrap();
        assert!(s.list_schemas().await.unwrap().contains(&DB.to_string()));
        s.close().await.unwrap();
        assert!(tls_connections(&url).await > before);
    }
}

#[tokio::test]
async fn through_ssh_tunnel() {
    let (host, port) = ssh_addr();
    let target = SshTarget {
        host,
        port,
        user: "tunnel".into(),
        auth: SshAuthMaterial::Password("tunnel-pass".into()),
    };
    let dir = tempfile::tempdir().unwrap();
    let policy = |accept| HostKeyPolicy {
        known_hosts: KnownHosts {
            system: None,
            app: dir.path().join("known_hosts"),
        },
        accept_fingerprint: accept,
    };
    let tunnel = match open_tunnel(&target, "mongo7", 27017, &policy(None)).await {
        Err(e) if e.kind == ErrorKind::HostKeyUnknown => {
            open_tunnel(&target, "mongo7", 27017, &policy(Some(e.message)))
                .await
                .unwrap()
        }
        other => other.unwrap(),
    };
    for mode in [SslMode::Disable, SslMode::Require] {
        let mut p = mongo_params(&mongo_urls()[0]);
        p.host = "mongo7".into();
        p.port = 27017;
        p.ssl = ssl(mode, None);
        p.dial = Some(tunnel.local_addr());
        let s = connect(&p).await.unwrap();
        assert!(s.list_schemas().await.unwrap().contains(&DB.to_string()));
        assert_eq!(names(&s.list_objects(Some(DB)).await.unwrap()), seeded());
        s.close().await.unwrap();
    }
    let mut p = mongo_params(&mongo_urls()[0]);
    p.ssl = ssl(SslMode::VerifyFull, Some("ca.pem"));
    p.dial = Some(tunnel.local_addr());
    let e = connect(&p)
        .await
        .err()
        .expect("verify-full is refused over SSH");
    assert_eq!(e.kind, ErrorKind::Invalid, "{}", e.message);
    tunnel.close().await;
}

fn settings(p: &mut ConnectParams) -> &mut MongoSettings {
    p.mongo.as_mut().unwrap()
}

#[test]
fn ssh_refuses_verify_full_srv_and_multi_host() {
    let base = || {
        let mut p = mongo_params("mongodb://u:p@db.example:27017/shop");
        p.ssl = ssl(SslMode::Disable, None);
        p
    };
    assert!(check_tunnel(&base()).is_ok());
    let mut p = base();
    p.ssl.mode = SslMode::Require;
    assert!(check_tunnel(&p).is_ok());

    let mut p = base();
    p.ssl.mode = SslMode::VerifyFull;
    let e = check_tunnel(&p).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Invalid);
    assert!(e.message.contains("verify-full"), "{}", e.message);

    let mut p = base();
    settings(&mut p).srv = true;
    let e = check_tunnel(&p).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Invalid);
    assert!(e.message.contains("mongodb+srv"), "{}", e.message);

    let mut p = base();
    settings(&mut p).extra_hosts = vec!["b.example:27017".into()];
    let e = check_tunnel(&p).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Invalid);
    assert!(e.message.contains("replica set"), "{}", e.message);

    let mut p = base();
    settings(&mut p).replica_set = Some("rs0".into());
    let e = check_tunnel(&p).unwrap_err();
    assert_eq!(e.kind, ErrorKind::Invalid);
    assert!(e.message.contains("replica set"), "{}", e.message);
}

#[tokio::test]
async fn wrong_password_is_auth_error() {
    const WRONG: &str = "wr0ng-s3cret-pw";
    for url in mongo_urls() {
        let mut p = fail_fast(mongo_params(&url));
        p.password = Some(WRONG.into());
        let e = connect(&p).await.err().expect("a wrong password must fail");
        assert_eq!(e.kind, ErrorKind::Auth, "{}", e.message);
        assert!(!e.message.contains(WRONG), "{}", e.message);
        assert!(!e.message.contains("<redacted>"), "{}", e.message);
    }
    let mut p = fail_fast(mongo_params(&mongo_reader_url()));
    p.password = Some(WRONG.into());
    let e = connect(&p).await.err().expect("a wrong password must fail");
    assert_eq!(e.kind, ErrorKind::Auth, "{}", e.message);
    assert!(!e.message.contains(WRONG), "{}", e.message);
    assert!(!e.message.contains("<redacted>"), "{}", e.message);
}

#[tokio::test]
async fn cancel_returns_at_once() {
    let s = connect(&mongo_params(&mongo_urls()[0])).await.unwrap();
    let c = s.canceller();
    // Nothing in flight: a cancel is harmless and the next call works.
    c.cancel().await.unwrap();
    assert!(s.list_schemas().await.unwrap().contains(&DB.to_string()));
    s.close().await.unwrap();
}

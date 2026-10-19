//! MongoDB client options from a saved connection (rules: "Global Constraints" of
//! `docs/superpowers/plans/2026-10-19-tablemax-mongodb-01-read.md`, spec §5).
//!
//! The hosts, the user, the authentication database, `replicaSet` and the allowed advanced
//! options go through a connection string parsed by the crate (`mongodb+srv://` needs its
//! DNS lookup), built **without the password**; the password, the mechanism, TLS, the
//! topology and the read preference are set on the parsed options afterwards.

use std::time::Duration;

use mongodb::options::{
    AuthMechanism, ClientOptions, ReadPreference, SelectionCriteria, Tls, TlsOptions,
};

use crate::driver::ConnectParams;
use crate::driver::tls::SslMode;
use crate::error::{AppError, AppResult, ErrorKind};
use crate::store::{MongoAuth, MongoSettings};

/// The advanced URI options a connection may keep (`MongoSettings::options`); any other key
/// is not applied.
pub const ALLOWED_OPTIONS: &[&str] = &[
    "readPreference",
    "readPreferenceTags",
    "maxStalenessSeconds",
    "appName",
    "connectTimeoutMS",
    "serverSelectionTimeoutMS",
    "socketTimeoutMS",
    "heartbeatFrequencyMS",
    "localThresholdMS",
    "maxPoolSize",
    "minPoolSize",
    "maxIdleTimeMS",
    "retryReads",
    "directConnection",
];

/// Allowed (other tools use it, so an imported URI keeps it) but refused by the Rust
/// driver ("does not support socketTimeoutMS"): kept in the settings, never sent.
const NOT_SENT: &[&str] = &["socketTimeoutMS"];

/// Server selection gives up after this long unless `serverSelectionTimeoutMS` says
/// otherwise (the driver's own default, 30 s, leaves a wrong host or certificate hanging).
pub const DEFAULT_SERVER_SELECTION_TIMEOUT: Duration = Duration::from_secs(10);

const TLS_MODES: &str =
    "MongoDB connections support the TLS modes disable, require and verify-full only";

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::new(ErrorKind::Invalid, msg)
}

/// Percent-encodes everything but the URI unreserved characters.
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `host:port` of the URI host list; IPv6 literals get their brackets.
fn host_port(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// A saved `host:port` (extra hosts): nothing that would change the URI's structure.
fn check_host(h: &str) -> AppResult<&str> {
    let h = h.trim();
    if h.is_empty() || h.contains(['/', '?', '@', ',', '#', '&', '=', ' ']) {
        return Err(invalid(format!("invalid MongoDB host \"{h}\"")));
    }
    Ok(h)
}

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.map(str::trim).filter(|s| !s.is_empty())
}

/// One host, SCRAM, no option.
fn default_settings() -> MongoSettings {
    MongoSettings {
        srv: false,
        extra_hosts: Vec::new(),
        auth_source: None,
        auth_mechanism: MongoAuth::Default,
        replica_set: None,
        options: Vec::new(),
    }
}

/// The connection's MongoDB settings (`None`: [`default_settings`]).
fn settings(p: &ConnectParams) -> MongoSettings {
    p.mongo.clone().unwrap_or_else(default_settings)
}

/// The saved option whose key is `key` (URI keys ignore case).
fn allowed_key(key: &str) -> Option<&'static str> {
    ALLOWED_OPTIONS
        .iter()
        .find(|k| k.eq_ignore_ascii_case(key.trim()))
        .copied()
}

/// The connection string without the password (see the module comment).
fn connection_string(p: &ConnectParams, m: &MongoSettings) -> AppResult<String> {
    let scheme = if m.srv { "mongodb+srv" } else { "mongodb" };
    let user = p.user.trim();
    let userinfo = if user.is_empty() {
        String::new()
    } else {
        format!("{}@", enc(user))
    };
    let hosts = match p.dial {
        // Through the SSH tunnel: its local end (check_tunnel allows one host only).
        Some(addr) => addr.to_string(),
        None if m.srv => check_host(&p.host)?.to_string(),
        None => {
            let mut hosts = vec![host_port(check_host(&p.host)?, p.port)];
            for h in &m.extra_hosts {
                hosts.push(check_host(h)?.to_string());
            }
            hosts.join(",")
        }
    };
    let mut query: Vec<String> = Vec::new();
    let mut path_db = String::new();
    if !user.is_empty() {
        match non_empty(m.auth_source.as_deref()) {
            Some(source) => query.push(format!("authSource={}", enc(source))),
            None if m.auth_mechanism == MongoAuth::Plain => {
                query.push(format!("authSource={}", enc("$external")))
            }
            // The crate then authenticates against the URI database, else `admin` (or the
            // TXT record's authSource for `mongodb+srv://`).
            None => {
                if let Some(db) = non_empty(p.database.as_deref()) {
                    path_db = enc(db);
                }
            }
        }
    }
    if let Some(rs) = non_empty(m.replica_set.as_deref()) {
        query.push(format!("replicaSet={}", enc(rs)));
    }
    for (key, value) in &m.options {
        let Some(key) = allowed_key(key) else {
            continue;
        };
        if NOT_SENT.contains(&key) {
            continue;
        }
        // Through SSH the topology is forced to one direct host below.
        if key == "directConnection" && p.dial.is_some() {
            continue;
        }
        query.push(format!("{key}={}", enc(value.trim())));
    }
    let query = if query.is_empty() {
        String::new()
    } else {
        format!("?{}", query.join("&"))
    };
    Ok(format!("{scheme}://{userinfo}{hosts}/{path_db}{query}"))
}

/// A crate error about the options (bad value, invalid combination), as `Invalid`.
fn option_error(e: mongodb::error::Error) -> AppError {
    let msg = match e.kind.as_ref() {
        mongodb::error::ErrorKind::InvalidArgument { message, .. } => message.clone(),
        mongodb::error::ErrorKind::DnsResolve { message, .. } => {
            return AppError::new(
                ErrorKind::Connection,
                format!("DNS lookup failed: {message}"),
            );
        }
        _ => e.to_string(),
    };
    invalid(format!("invalid MongoDB connection settings: {msg}"))
}

/// The client options of `p`: hosts (`mongodb+srv://` resolved through DNS), credential,
/// TLS, topology, read preference and the allowed advanced options. Through an SSH tunnel
/// (`p.dial`), [`check_tunnel`] applies and the tunnel's end is the only, direct host.
pub async fn client_options(p: &ConnectParams) -> AppResult<ClientOptions> {
    let m = settings(p);
    if p.dial.is_some() {
        check_tunnel(p)?;
    }
    let tls = match p.ssl.mode {
        SslMode::Disable => Tls::Disabled,
        SslMode::Require | SslMode::VerifyFull => {
            if p.ssl.cert_file.is_some() || p.ssl.key_file.is_some() {
                return Err(invalid(
                    "client certificates are not supported for MongoDB connections",
                ));
            }
            let mut o = TlsOptions::default();
            o.ca_file_path = non_empty(p.ssl.ca_file.as_deref()).map(Into::into);
            if p.ssl.mode == SslMode::Require {
                o.allow_invalid_certificates = Some(true);
            }
            Tls::Enabled(o)
        }
        SslMode::Prefer | SslMode::VerifyCa => return Err(invalid(TLS_MODES)),
    };
    let uri = connection_string(p, &m)?;
    let mut o = ClientOptions::parse(uri.as_str())
        .await
        .map_err(option_error)?;
    if let Some(c) = o.credential.as_mut() {
        c.password = p.password.clone();
        c.mechanism = match m.auth_mechanism {
            MongoAuth::Default => None,
            MongoAuth::ScramSha1 => Some(AuthMechanism::ScramSha1),
            MongoAuth::ScramSha256 => Some(AuthMechanism::ScramSha256),
            MongoAuth::Plain => Some(AuthMechanism::Plain),
        };
    }
    o.tls = Some(tls);
    let discovery = m.srv || !m.extra_hosts.is_empty() || o.repl_set_name.is_some();
    if p.dial.is_some() || (!discovery && o.direct_connection.is_none()) {
        o.direct_connection = Some(true);
    }
    if o.selection_criteria.is_none() {
        o.selection_criteria = Some(SelectionCriteria::ReadPreference(
            ReadPreference::PrimaryPreferred { options: None },
        ));
    }
    if o.server_selection_timeout.is_none() {
        o.server_selection_timeout = Some(DEFAULT_SERVER_SELECTION_TIMEOUT);
    }
    Ok(o)
}

/// Refuses what an SSH tunnel cannot carry: it leads to one `host:port` and the driver
/// verifies the certificate against the name it dials (the tunnel's `127.0.0.1`).
/// Call before opening a tunnel for a MongoDB connection.
pub fn check_tunnel(p: &ConnectParams) -> AppResult<()> {
    let m = settings(p);
    if m.srv {
        return Err(invalid(
            "mongodb+srv:// connections cannot go through an SSH tunnel: the hosts come from \
             a DNS record and the tunnel leads to one host; enter that host instead",
        ));
    }
    if !m.extra_hosts.is_empty() || non_empty(m.replica_set.as_deref()).is_some() {
        return Err(invalid(
            "a replica set (several hosts or replicaSet) cannot be reached through an SSH \
             tunnel, which leads to one host; connect to one member directly",
        ));
    }
    if p.ssl.mode == SslMode::VerifyFull {
        return Err(invalid(
            "TLS verify-full is not available through an SSH tunnel: the certificate would \
             be checked against 127.0.0.1; use require (the tunnel already encrypts and \
             authenticates the path to the SSH server) or disable",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::DriverKind;
    use crate::driver::tls::SslConfig;

    fn params(host: &str, m: MongoSettings) -> ConnectParams {
        ConnectParams {
            kind: DriverKind::MongoDb,
            host: host.into(),
            port: 27017,
            user: "u".into(),
            password: Some("p@ss:word".into()),
            database: Some("shop".into()),
            sqlite_path: None,
            ssl: SslConfig {
                mode: SslMode::Disable,
                ..Default::default()
            },
            dial: None,
            mongo: Some(m),
        }
    }

    /// The settings of a connection saved without any (`mongo: None`).
    fn base() -> MongoSettings {
        let mut p = params("h", default_settings());
        p.mongo = None;
        settings(&p)
    }

    fn hosts(o: &ClientOptions) -> Vec<String> {
        o.hosts.iter().map(ToString::to_string).collect()
    }

    #[tokio::test]
    async fn single_host_is_direct() {
        let o = client_options(&params("db.example", base())).await.unwrap();
        assert_eq!(hosts(&o), ["db.example:27017"]);
        assert_eq!(o.direct_connection, Some(true));
        assert_eq!(o.repl_set_name, None);
        assert_eq!(o.tls, Some(Tls::Disabled));
        assert_eq!(
            o.server_selection_timeout,
            Some(DEFAULT_SERVER_SELECTION_TIMEOUT)
        );
        // An explicit directConnection=false is kept (single host, discovery asked for).
        let m = MongoSettings {
            options: vec![("directconnection".into(), "false".into())],
            ..base()
        };
        let o = client_options(&params("db.example", m)).await.unwrap();
        assert_eq!(o.direct_connection, Some(false));
    }

    #[tokio::test]
    async fn replica_set_or_hosts_discover() {
        let m = MongoSettings {
            extra_hosts: vec!["b.example:27018".into(), "c.example:27019".into()],
            ..base()
        };
        let o = client_options(&params("a.example", m)).await.unwrap();
        assert_eq!(
            hosts(&o),
            ["a.example:27017", "b.example:27018", "c.example:27019"]
        );
        assert_ne!(o.direct_connection, Some(true));

        let m = MongoSettings {
            replica_set: Some("rs0".into()),
            ..base()
        };
        let o = client_options(&params("a.example", m)).await.unwrap();
        assert_eq!(o.repl_set_name.as_deref(), Some("rs0"));
        assert_ne!(o.direct_connection, Some(true));

        // An IPv6 literal goes into the URI with its brackets; the driver keeps the bare
        // address.
        let o = client_options(&params("::1", base())).await.unwrap();
        assert_eq!(
            o.hosts,
            [mongodb::options::ServerAddress::Tcp {
                host: "::1".into(),
                port: Some(27017)
            }]
        );
        // A host that would change the URI's structure is refused.
        let m = MongoSettings {
            extra_hosts: vec!["evil/?x=1".into()],
            ..base()
        };
        let e = client_options(&params("a", m)).await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Invalid);
    }

    #[tokio::test]
    async fn auth_source_and_plain_mechanism() {
        // No authSource: the connection's database.
        let o = client_options(&params("h", base())).await.unwrap();
        let c = o.credential.clone().unwrap();
        assert_eq!(c.username.as_deref(), Some("u"));
        assert_eq!(c.password.as_deref(), Some("p@ss:word"));
        assert_eq!(c.source.as_deref(), Some("shop"));
        assert_eq!(c.mechanism, None);
        // No database either: admin.
        let mut p = params("h", base());
        p.database = None;
        let c = client_options(&p).await.unwrap().credential.unwrap();
        assert_eq!(c.source.as_deref(), Some("admin"));
        // authSource wins.
        let m = MongoSettings {
            auth_source: Some("admin2".into()),
            auth_mechanism: MongoAuth::ScramSha256,
            ..base()
        };
        let c = client_options(&params("h", m))
            .await
            .unwrap()
            .credential
            .unwrap();
        assert_eq!(c.source.as_deref(), Some("admin2"));
        assert_eq!(c.mechanism, Some(AuthMechanism::ScramSha256));
        // PLAIN (LDAP): $external.
        let m = MongoSettings {
            auth_mechanism: MongoAuth::Plain,
            ..base()
        };
        let c = client_options(&params("h", m))
            .await
            .unwrap()
            .credential
            .unwrap();
        assert_eq!(c.source.as_deref(), Some("$external"));
        assert_eq!(c.mechanism, Some(AuthMechanism::Plain));
        assert_eq!(c.password.as_deref(), Some("p@ss:word"));
        // A user name with URI characters survives.
        let mut p = params("h", base());
        p.user = "a@b/c:d".into();
        let c = client_options(&p).await.unwrap().credential.unwrap();
        assert_eq!(c.username.as_deref(), Some("a@b/c:d"));
        // No user: no credential at all.
        let mut p = params("h", base());
        p.user = String::new();
        assert!(client_options(&p).await.unwrap().credential.is_none());
    }

    #[tokio::test]
    async fn read_preference_default_primary_preferred() {
        let o = client_options(&params("h", base())).await.unwrap();
        assert_eq!(
            o.selection_criteria,
            Some(SelectionCriteria::ReadPreference(
                ReadPreference::PrimaryPreferred { options: None }
            ))
        );
        let m = MongoSettings {
            options: vec![("readPreference".into(), "secondary".into())],
            ..base()
        };
        let o = client_options(&params("h", m)).await.unwrap();
        assert!(
            matches!(
                o.selection_criteria,
                Some(SelectionCriteria::ReadPreference(
                    ReadPreference::Secondary { .. }
                ))
            ),
            "{:?}",
            o.selection_criteria
        );
    }

    #[tokio::test]
    async fn allowed_options_applied() {
        let m = MongoSettings {
            options: vec![
                ("appName".into(), "Table Max&x=1".into()),
                ("maxPoolSize".into(), "7".into()),
                ("serverSelectionTimeoutMS".into(), "2500".into()),
                ("connectTimeoutMS".into(), "1500".into()),
                ("retryReads".into(), "false".into()),
                ("readPreference".into(), "nearest".into()),
                ("readPreferenceTags".into(), "dc:ny,rack:1".into()),
                // Not sent (the Rust driver refuses it), not an error.
                ("socketTimeoutMS".into(), "1000".into()),
                // Not allowed: never applied.
                ("tlsAllowInvalidHostnames".into(), "true".into()),
                ("retryWrites".into(), "false".into()),
                ("w".into(), "0".into()),
            ],
            ..base()
        };
        let o = client_options(&params("h", m)).await.unwrap();
        assert_eq!(o.app_name.as_deref(), Some("Table Max&x=1"));
        assert_eq!(o.max_pool_size, Some(7));
        assert_eq!(
            o.server_selection_timeout,
            Some(Duration::from_millis(2500))
        );
        assert_eq!(o.connect_timeout, Some(Duration::from_millis(1500)));
        assert_eq!(o.retry_reads, Some(false));
        assert_eq!(o.retry_writes, None);
        assert_eq!(o.write_concern, None);
        match &o.selection_criteria {
            Some(SelectionCriteria::ReadPreference(ReadPreference::Nearest {
                options: Some(opts),
            })) => {
                let tags = opts.tag_sets.clone().unwrap();
                assert_eq!(tags.len(), 1);
                assert_eq!(tags[0].get("dc").map(String::as_str), Some("ny"));
                assert_eq!(tags[0].get("rack").map(String::as_str), Some("1"));
            }
            other => panic!("{other:?}"),
        }
        // A bad value is Invalid, named by the crate.
        let m = MongoSettings {
            options: vec![("maxPoolSize".into(), "lots".into())],
            ..base()
        };
        let e = client_options(&params("h", m)).await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Invalid);
        assert!(!e.message.contains("p@ss:word"), "{}", e.message);
    }

    #[tokio::test]
    async fn tls_modes_map_to_driver_options() {
        let mut p = params("h", base());
        p.ssl = SslConfig {
            mode: SslMode::Require,
            ca_file: Some("/ca.pem".into()),
            ..Default::default()
        };
        match client_options(&p).await.unwrap().tls {
            Some(Tls::Enabled(o)) => {
                assert_eq!(o.allow_invalid_certificates, Some(true));
                assert_eq!(o.ca_file_path, Some("/ca.pem".into()));
            }
            other => panic!("{other:?}"),
        }
        p.ssl.mode = SslMode::VerifyFull;
        match client_options(&p).await.unwrap().tls {
            Some(Tls::Enabled(o)) => assert_eq!(o.allow_invalid_certificates, None),
            other => panic!("{other:?}"),
        }
        for mode in [SslMode::Prefer, SslMode::VerifyCa] {
            p.ssl.mode = mode;
            let e = client_options(&p).await.unwrap_err();
            assert_eq!(e.kind, ErrorKind::Invalid, "{mode:?}");
        }
        p.ssl.mode = SslMode::Require;
        p.ssl.cert_file = Some("/c.pem".into());
        let e = client_options(&p).await.unwrap_err();
        assert!(e.message.contains("client certificates"), "{}", e.message);
    }

    #[tokio::test]
    async fn through_tunnel_dials_its_end_directly() {
        let mut p = params("mongo7", base());
        p.dial = Some("127.0.0.1:40123".parse().unwrap());
        let o = client_options(&p).await.unwrap();
        assert_eq!(hosts(&o), ["127.0.0.1:40123"]);
        assert_eq!(o.direct_connection, Some(true));
        // directConnection=false cannot undo it.
        p.mongo = Some(MongoSettings {
            options: vec![("directConnection".into(), "false".into())],
            ..base()
        });
        assert_eq!(
            client_options(&p).await.unwrap().direct_connection,
            Some(true)
        );
        p.ssl.mode = SslMode::VerifyFull;
        assert_eq!(
            client_options(&p).await.unwrap_err().kind,
            ErrorKind::Invalid
        );
    }
}

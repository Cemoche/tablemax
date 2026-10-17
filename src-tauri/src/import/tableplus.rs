//! Parser of decrypted TablePlus connection exports (`.tableplusconnection`).
//! Format: `docs/research/2026-10-17-tableplusconnection-format.md`.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::driver::DriverKind;
use crate::driver::tls::{SslConfig, default_ssl_mode};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::store::{ConnectionConfig, EnvTag, PasswordMode, SshAuth, SshSettings};

/// Name given to an exported connection without one.
const UNNAMED: &str = "Imported connection";
/// Color of imported connections (exports carry none).
const COLOR: &str = "swatch-1";
const KEY_FILE_MISSING: &str =
    "SSH key file not included in the export: choose it in the connection settings";

/// One connection read from an export. `config.id` is empty (assigned on save).
pub struct ImportedConnection {
    pub config: ConnectionConfig,
    /// DB password (`DatabasePassword`).
    pub password: Option<String>,
    /// SSH password (`ServerPassword`) or SSH key passphrase (`DatabaseKeyPassword`).
    pub ssh_secret: Option<String>,
}

impl std::fmt::Debug for ImportedConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let redact = |s: &Option<String>| s.as_ref().map(|_| "<redacted>");
        f.debug_struct("ImportedConnection")
            .field("config", &self.config)
            .field("password", &redact(&self.password))
            .field("ssh_secret", &redact(&self.ssh_secret))
            .finish()
    }
}

/// Something the import skipped or could not carry over, shown to the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportWarning {
    /// Name of the connection the warning is about.
    pub entry: String,
    pub message: String,
}

fn not_an_export() -> AppError {
    AppError::new(ErrorKind::Invalid, "not a TablePlus export")
}

/// Parses a decrypted export: a JSON array of connections and groups (an element with
/// `IsExpanded` or `IsExpaned` is a group, nesting `groups` and `connections`). Missing
/// keys read as empty, unknown keys are ignored, ports and booleans may be strings or
/// numbers. Connections of other drivers are skipped with a warning.
pub fn parse_export(plain: &[u8]) -> AppResult<(Vec<ImportedConnection>, Vec<ImportWarning>)> {
    let root: Value = serde_json::from_slice(plain).map_err(|_| not_an_export())?;
    let items = root.as_array().ok_or_else(not_an_export)?;
    let mut parsed = Parsed::default();
    parsed.items(items, &[])?;
    Ok((parsed.connections, parsed.warnings))
}

#[derive(Default)]
struct Parsed {
    connections: Vec<ImportedConnection>,
    warnings: Vec<ImportWarning>,
}

impl Parsed {
    fn warn(&mut self, entry: &str, message: impl Into<String>) {
        self.warnings.push(ImportWarning {
            entry: entry.to_string(),
            message: message.into(),
        });
    }

    /// `path`: names of the enclosing groups, outermost first.
    fn items(&mut self, items: &[Value], path: &[String]) -> AppResult<()> {
        for item in items {
            let obj = item.as_object().ok_or_else(not_an_export)?;
            if obj.contains_key("IsExpanded") || obj.contains_key("IsExpaned") {
                let mut inner = path.to_vec();
                let name = text(obj, "Name");
                if !name.trim().is_empty() {
                    inner.push(name.trim().to_string());
                }
                self.items(list(obj, "groups"), &inner)?;
                self.items(list(obj, "connections"), &inner)?;
            } else {
                self.connection(obj, path);
            }
        }
        Ok(())
    }

    fn connection(&mut self, obj: &Map<String, Value>, path: &[String]) {
        let name = Some(text(obj, "ConnectionName"))
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| UNNAMED.to_string());
        let driver = text(obj, "Driver");
        let Some(kind) = driver_kind(&driver) else {
            let message = if driver.is_empty() {
                "missing driver".to_string()
            } else {
                format!("unsupported driver {driver}")
            };
            self.warn(&name, message);
            return;
        };
        let group = (!path.is_empty()).then(|| path.join(" / "));
        let env_tag = env_tag(
            &Some(text(obj, "Tag"))
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| text(obj, "Enviroment")),
        );
        let mut config = ConnectionConfig {
            id: String::new(),
            name,
            color: COLOR.to_string(),
            env_tag,
            kind,
            host: String::new(),
            port: 0,
            user: String::new(),
            database: None,
            sqlite_path: None,
            password_mode: PasswordMode::None,
            group,
            ssl: SslConfig::default(),
            ssh: None,
        };
        if kind == DriverKind::Sqlite {
            config.sqlite_path = Some(text(obj, "DatabasePath")).filter(|p| !p.is_empty());
            self.connections.push(ImportedConnection {
                config,
                password: None,
                ssh_secret: None,
            });
            return;
        }
        let default = default_port(kind);
        config.port = match port(obj, "DatabasePort") {
            Ok(port) => port.unwrap_or(default),
            Err(raw) => {
                self.warn(&config.name, format!("invalid port {raw}: using {default}"));
                default
            }
        };
        config.host = text(obj, "DatabaseHost");
        config.user = text(obj, "DatabaseUser");
        config.database = secret(obj, "DatabaseName");
        let password = secret(obj, "DatabasePassword");
        config.password_mode = if password.is_some() {
            PasswordMode::Keyring
        } else {
            PasswordMode::Ask
        };
        let mut ssh_secret = None;
        if flag(obj, "isOverSSH") {
            let (ssh, secret) = self.ssh(obj, &config.name);
            config.ssh = Some(ssh);
            ssh_secret = secret;
        }
        config.ssl.mode = default_ssl_mode(&config.host, config.ssh.is_some());
        self.connections.push(ImportedConnection {
            config,
            password,
            ssh_secret,
        });
    }

    /// SSH settings and secret. Password auth when `ServerPassword` is set, else key
    /// auth (the key path is never exported) with `DatabaseKeyPassword` as passphrase.
    fn ssh(&mut self, obj: &Map<String, Value>, entry: &str) -> (SshSettings, Option<String>) {
        let (auth, secret) = match secret(obj, "ServerPassword") {
            Some(password) => (SshAuth::Password, Some(password)),
            None => (SshAuth::Key, secret(obj, "DatabaseKeyPassword")),
        };
        let port = port(obj, "ServerPort").unwrap_or_else(|raw| {
            self.warn(entry, format!("invalid SSH port {raw}: using the default"));
            None
        });
        if auth == SshAuth::Key {
            self.warn(entry, KEY_FILE_MISSING);
        }
        let secret_mode = match (&secret, auth) {
            (Some(_), _) => PasswordMode::Keyring,
            (None, SshAuth::Password) => PasswordMode::Ask,
            (None, _) => PasswordMode::None,
        };
        let ssh = SshSettings {
            host: text(obj, "ServerAddress"),
            port,
            user: Some(text(obj, "ServerUser")).filter(|u| !u.is_empty()),
            auth,
            key_file: None,
            secret_mode,
        };
        (ssh, secret)
    }
}

fn driver_kind(driver: &str) -> Option<DriverKind> {
    match driver.to_ascii_lowercase().as_str() {
        "mysql" => Some(DriverKind::MySql),
        "mariadb" => Some(DriverKind::MariaDb),
        "postgresql" => Some(DriverKind::Postgres),
        "sqlite" => Some(DriverKind::Sqlite),
        _ => None,
    }
}

fn default_port(kind: DriverKind) -> u16 {
    match kind {
        DriverKind::Postgres => 5432,
        DriverKind::MySql | DriverKind::MariaDb => 3306,
        DriverKind::Sqlite => 0,
    }
}

fn env_tag(tag: &str) -> EnvTag {
    match tag.trim().to_ascii_lowercase().as_str() {
        "development" | "dev" => EnvTag::Dev,
        "testing" | "staging" => EnvTag::Staging,
        "production" | "prod" => EnvTag::Prod,
        _ => EnvTag::Local,
    }
}

/// A scalar as text (strings as is, numbers and booleans printed); else empty.
fn text(obj: &Map<String, Value>, key: &str) -> String {
    match obj.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

/// A non-empty text value (empty = absent).
fn secret(obj: &Map<String, Value>, key: &str) -> Option<String> {
    Some(text(obj, key)).filter(|s| !s.is_empty())
}

/// `1`, `true`, `"1"` or `"true"`.
fn flag(obj: &Map<String, Value>, key: &str) -> bool {
    match obj.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => s.trim() == "1" || s.trim().eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// `Ok(None)` when empty, `Err(raw)` when not a port number.
fn port(obj: &Map<String, Value>, key: &str) -> Result<Option<u16>, String> {
    let raw = text(obj, key);
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    match raw.parse::<u16>() {
        Ok(port) if port != 0 => Ok(Some(port)),
        _ => Err(raw.to_string()),
    }
}

/// An array value; anything else reads as empty.
fn list<'a>(obj: &'a Map<String, Value>, key: &str) -> &'a [Value] {
    obj.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::DriverKind;
    use crate::driver::tls::SslMode;
    use crate::store::{EnvTag, PasswordMode, SshAuth};

    fn parse(json: &str) -> (Vec<ImportedConnection>, Vec<ImportWarning>) {
        parse_export(json.as_bytes()).unwrap()
    }

    fn one(json: &str) -> ImportedConnection {
        let (mut conns, _) = parse(json);
        assert_eq!(conns.len(), 1, "{conns:?}");
        conns.remove(0)
    }

    #[test]
    fn unreadable_json_is_not_an_export() {
        for bad in [
            &b"not json"[..],
            b"{\"a\":1}",
            b"\"x\"",
            b"[1]",
            b"\xff\xfe",
        ] {
            let err = parse_export(bad).unwrap_err();
            assert_eq!(err.kind, ErrorKind::Invalid);
            assert_eq!(err.message, "not a TablePlus export");
        }
    }

    #[test]
    fn missing_keys_are_empty_and_unknown_keys_ignored() {
        let c = one(r#"[{"Driver":"PostgreSQL","Whatever":{"x":[1]},"Favorites":{"a":"pinned"}}]"#);
        let cfg = &c.config;
        assert_eq!(cfg.id, "");
        assert_eq!(cfg.name, "Imported connection");
        assert_eq!(cfg.kind, DriverKind::Postgres);
        assert_eq!(cfg.host, "");
        assert_eq!(cfg.port, 5432);
        assert_eq!(cfg.user, "");
        assert_eq!(cfg.database, None);
        assert_eq!(cfg.sqlite_path, None);
        assert_eq!(cfg.password_mode, PasswordMode::Ask);
        assert_eq!(cfg.group, None);
        assert_eq!(cfg.color, "swatch-1");
        assert_eq!(cfg.env_tag, EnvTag::Local);
        assert!(cfg.ssh.is_none());
        assert!(c.password.is_none() && c.ssh_secret.is_none());
    }

    #[test]
    fn ports_and_booleans_accept_strings_or_numbers() {
        let c = one(
            r#"[{"ConnectionName":"n","Driver":"MySQL","DatabaseHost":"db","DatabasePort":3310,
                "isOverSSH":true,"ServerAddress":"jump","ServerPort":2200,"ServerUser":"u",
                "ServerPassword":"sp"}]"#,
        );
        assert_eq!(c.config.port, 3310);
        let ssh = c.config.ssh.unwrap();
        assert_eq!(ssh.port, Some(2200));
        assert_eq!(ssh.auth, SshAuth::Password);
        for over in [r#""1""#, "1", "true"] {
            let json =
                format!(r#"[{{"Driver":"MySQL","isOverSSH":{over},"ServerAddress":"jump"}}]"#);
            assert!(one(&json).config.ssh.is_some(), "isOverSSH {over}");
        }
        for over in [r#""0""#, "0", "false", "null"] {
            let json = format!(r#"[{{"Driver":"MySQL","isOverSSH":{over}}}]"#);
            assert!(one(&json).config.ssh.is_none(), "isOverSSH {over}");
        }
    }

    #[test]
    fn empty_port_takes_the_driver_default() {
        for (driver, port) in [("MySQL", 3306), ("MariaDB", 3306), ("PostgreSQL", 5432)] {
            let json = format!(r#"[{{"Driver":"{driver}","DatabasePort":""}}]"#);
            assert_eq!(one(&json).config.port, port, "{driver}");
        }
        let json = r#"[{"Driver":"SQLite","DatabasePath":"/x.db","DatabasePort":""}]"#;
        assert_eq!(one(json).config.port, 0);
    }

    #[test]
    fn invalid_port_takes_the_default_with_a_warning() {
        let (conns, warnings) =
            parse(r#"[{"ConnectionName":"p","Driver":"PostgreSQL","DatabasePort":"99999"}]"#);
        assert_eq!(conns[0].config.port, 5432);
        assert_eq!(
            warnings,
            [ImportWarning {
                entry: "p".into(),
                message: "invalid port 99999: using 5432".into()
            }]
        );
    }

    #[test]
    fn env_tag_from_tag_then_enviroment() {
        let cases = [
            (r#""Tag":"local""#, EnvTag::Local),
            (r#""Tag":"development""#, EnvTag::Dev),
            (r#""Tag":"dev""#, EnvTag::Dev),
            (r#""Tag":"testing""#, EnvTag::Staging),
            (r#""Tag":"Staging""#, EnvTag::Staging),
            (r#""Tag":"production""#, EnvTag::Prod),
            (r#""Tag":"prod""#, EnvTag::Prod),
            (r#""Tag":"other""#, EnvTag::Local),
            (r#""Enviroment":"production""#, EnvTag::Prod),
            (r#""Tag":"dev","Enviroment":"production""#, EnvTag::Dev),
        ];
        for (keys, tag) in cases {
            let json = format!(r#"[{{"Driver":"MySQL",{keys}}}]"#);
            assert_eq!(one(&json).config.env_tag, tag, "{keys}");
        }
    }

    #[test]
    fn groups_nest_with_either_expanded_key() {
        let (conns, _) = parse(
            r#"[{"Name":"A","IsExpanded":true,"groups":[{"Name":"B","IsExpaned":0,
                "connections":[{"ConnectionName":"deep","Driver":"MySQL"}]}],
                "connections":[{"ConnectionName":"top","Driver":"MySQL"}]},
               {"ConnectionName":"root","Driver":"MySQL"}]"#,
        );
        let got: Vec<_> = conns
            .iter()
            .map(|c| (c.config.name.as_str(), c.config.group.as_deref()))
            .collect();
        assert_eq!(
            got,
            [("deep", Some("A / B")), ("top", Some("A")), ("root", None)]
        );
    }

    #[test]
    fn secrets_and_modes() {
        let c = one(r#"[{"Driver":"MySQL","DatabasePassword":"pw"}]"#);
        assert_eq!(c.password.as_deref(), Some("pw"));
        assert_eq!(c.config.password_mode, PasswordMode::Keyring);
        let c = one(r#"[{"Driver":"MySQL","DatabasePassword":""}]"#);
        assert_eq!(c.password, None);
        assert_eq!(c.config.password_mode, PasswordMode::Ask);
        // SQLite has neither password nor tunnel.
        let c = one(
            r#"[{"Driver":"SQLite","DatabasePath":"/x.db","DatabasePassword":"pw",
                "isOverSSH":1,"ServerAddress":"jump","ServerPassword":"sp"}]"#,
        );
        assert_eq!(c.password, None);
        assert_eq!(c.ssh_secret, None);
        assert_eq!(c.config.password_mode, PasswordMode::None);
        assert!(c.config.ssh.is_none());
        assert_eq!(c.config.sqlite_path.as_deref(), Some("/x.db"));
    }

    #[test]
    fn ssh_key_auth_takes_the_passphrase_and_warns() {
        let (conns, warnings) = parse(
            r#"[{"ConnectionName":"k","Driver":"PostgreSQL","isOverSSH":1,"ServerAddress":"jump",
                "ServerUser":"","DatabaseKeyPassword":"kp"}]"#,
        );
        let ssh = conns[0].config.ssh.clone().unwrap();
        assert_eq!(ssh.auth, SshAuth::Key);
        assert_eq!(ssh.key_file, None);
        assert_eq!(ssh.user, None);
        assert_eq!(ssh.port, None);
        assert_eq!(ssh.secret_mode, PasswordMode::Keyring);
        assert_eq!(conns[0].ssh_secret.as_deref(), Some("kp"));
        assert_eq!(
            warnings,
            [ImportWarning {
                entry: "k".into(),
                message:
                    "SSH key file not included in the export: choose it in the connection settings"
                        .into()
            }]
        );
        let c = one(r#"[{"Driver":"PostgreSQL","isOverSSH":1,"ServerAddress":"jump"}]"#);
        let ssh = c.config.ssh.unwrap();
        assert_eq!(ssh.auth, SshAuth::Key);
        assert_eq!(ssh.secret_mode, PasswordMode::None);
        assert_eq!(c.ssh_secret, None);
    }

    #[test]
    fn ssl_mode_follows_the_host() {
        let c = one(r#"[{"Driver":"PostgreSQL","DatabaseHost":"db.example.com"}]"#);
        assert_eq!(c.config.ssl.mode, SslMode::VerifyFull);
        let c = one(
            r#"[{"Driver":"PostgreSQL","DatabaseHost":"db.example.com","isOverSSH":1,
                "ServerAddress":"jump"}]"#,
        );
        assert_eq!(c.config.ssl.mode, SslMode::Prefer);
        let c = one(r#"[{"Driver":"MySQL","DatabaseHost":"localhost"}]"#);
        assert_eq!(c.config.ssl.mode, SslMode::Prefer);
    }

    #[test]
    fn debug_hides_secrets() {
        let c = one(
            r#"[{"Driver":"MySQL","DatabasePassword":"top-secret-db","isOverSSH":1,
                "ServerAddress":"jump","ServerPassword":"top-secret-ssh"}]"#,
        );
        let dbg = format!("{c:?}");
        assert!(!dbg.contains("top-secret"), "{dbg}");
        assert!(dbg.contains("<redacted>"), "{dbg}");
    }
}

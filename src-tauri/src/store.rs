use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::driver::DriverKind;
use crate::driver::tls::{SslConfig, default_ssl_mode};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::secrets::{SecretKey, SecretKind, SecretStore};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EnvTag {
    Local,
    Dev,
    Staging,
    Prod,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PasswordMode {
    Keyring,
    Ask,
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SshAuth {
    Password,
    Key,
    Agent,
}

/// Safe mode of a connection (see `safety.rs`): which statements need a confirmation
/// before anything of their batch is sent.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SafeMode {
    /// Nothing is confirmed.
    Off,
    /// Every statement is confirmed.
    ConfirmAll,
    /// Every statement not recognised as a read is confirmed.
    ConfirmWrites,
}

/// SSH tunnel settings of a connection. Contains no secret fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshSettings {
    /// A `~/.ssh/config` alias or a host name.
    pub host: String,
    /// Overrides the config's `Port` (default 22).
    pub port: Option<u16>,
    /// Overrides the config's `User`.
    pub user: Option<String>,
    pub auth: SshAuth,
    /// Private key for `Key` auth; else the config's `IdentityFile` or `~/.ssh/id_*`.
    pub key_file: Option<String>,
    /// Where the SSH password (`Password`) or key passphrase (`Key`) lives; always
    /// `None` for `Agent`.
    pub secret_mode: PasswordMode,
}

impl SshSettings {
    /// The keyring entry of this auth method's secret (`None` for the agent).
    pub fn secret_kind(&self) -> Option<SecretKind> {
        match self.auth {
            SshAuth::Password => Some(SecretKind::SshPassword),
            SshAuth::Key => Some(SecretKind::SshPassphrase),
            SshAuth::Agent => None,
        }
    }

    /// Auth message for a missing secret of this auth method.
    pub fn secret_required(&self) -> AppError {
        let what = match self.auth {
            SshAuth::Key => "ssh passphrase required",
            SshAuth::Password | SshAuth::Agent => "ssh password required",
        };
        AppError::new(ErrorKind::Auth, what)
    }
}

/// Persisted connection settings. Contains no secret fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub color: String,
    pub env_tag: EnvTag,
    pub kind: DriverKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: Option<String>,
    pub sqlite_path: Option<String>,
    pub password_mode: PasswordMode,
    pub group: Option<String>,
    /// Absent from Plan 1 configs: `Prefer`.
    #[serde(default)]
    pub ssl: SslConfig,
    /// Database reached through this SSH server (`host`/`port` as seen from it).
    #[serde(default)]
    pub ssh: Option<SshSettings>,
    /// `None` ("Default (by environment)", and every config saved before safe mode
    /// existed): `safety::effective_safe_mode` derives it from `env_tag`.
    #[serde(default)]
    pub safe_mode: Option<SafeMode>,
}

pub struct ConnectionStore {
    conn: Mutex<Connection>,
}

fn io_err(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorKind::Io, format!("connection store: {e}"))
}

/// `create_dir_all` whose new folders are owner-only (0700) on Unix.
pub(crate) fn create_private_dir_all(path: &Path) -> std::io::Result<()> {
    let mut b = std::fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(path)
}

/// Makes `path` owner-only (0600) on Unix; a no-op elsewhere. A file system without
/// permission support (EPERM / ENOTSUP, e.g. some FUSE or vfat mounts) must not make the
/// app unusable: those refusals are ignored, any other error is returned.
pub(crate) fn make_file_private(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tolerate_no_chmod(std::fs::set_permissions(
            path,
            std::fs::Permissions::from_mode(0o600),
        ))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// EPERM (1) / ENOTSUP (95 on Linux, 45 on macOS and the BSDs) from a chmod: the file
/// system cannot change modes, so the default stays. Everything else is a real error.
fn tolerate_no_chmod(r: std::io::Result<()>) -> std::io::Result<()> {
    const EPERM: i32 = 1;
    const ENOTSUP: i32 = if cfg!(target_os = "linux") { 95 } else { 45 };
    match r {
        Err(e)
            if e.kind() == std::io::ErrorKind::Unsupported
                || matches!(e.raw_os_error(), Some(EPERM) | Some(ENOTSUP)) =>
        {
            Ok(())
        }
        other => other,
    }
}

impl ConnectionStore {
    /// Opens (creating it if needed) the store at `path`. On Unix the file is owner-only
    /// (0600) and a missing folder is created owner-only (0700): app.db holds the
    /// history and the session, which may contain values the user typed. Deleted rows
    /// are overwritten (`secure_delete`), so clearing the history really erases it.
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            create_private_dir_all(parent).map_err(io_err)?;
        }
        if !path.exists() {
            // Created empty first so that it never exists with the default mode.
            let mut o = std::fs::OpenOptions::new();
            o.write(true).create(true).truncate(false);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                o.mode(0o600);
            }
            o.open(path).map_err(io_err)?;
        }
        make_file_private(path).map_err(io_err)?;
        let conn = Connection::open(path).map_err(io_err)?;
        conn.execute_batch("PRAGMA secure_delete = ON;")
            .map_err(io_err)?;
        Self::migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn migrate(conn: &Connection) -> AppResult<()> {
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(io_err)?;
        if v < 1 {
            conn.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS connections(
                     id TEXT PRIMARY KEY,
                     name TEXT NOT NULL,
                     config_json TEXT NOT NULL
                 );
                 PRAGMA user_version = 1;
                 COMMIT;",
            )
            .map_err(io_err)?;
        }
        if v < 2 {
            // Plan 4: query history and the restorable session. Existing rows are kept.
            conn.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS query_history(
                     id INTEGER PRIMARY KEY,
                     connection_id TEXT NOT NULL,
                     sql TEXT NOT NULL,
                     executed_at INTEGER NOT NULL,
                     elapsed_ms INTEGER,
                     rows INTEGER,
                     error TEXT
                 );
                 CREATE INDEX IF NOT EXISTS query_history_by_connection
                     ON query_history(connection_id, executed_at DESC);
                 CREATE TABLE IF NOT EXISTS session_state(
                     id INTEGER PRIMARY KEY CHECK (id = 1),
                     version INTEGER NOT NULL,
                     json TEXT NOT NULL,
                     saved_at INTEGER NOT NULL
                 );
                 PRAGMA user_version = 2;
                 COMMIT;",
            )
            .map_err(io_err)?;
        }
        Ok(())
    }

    /// Runs `f` on the store's connection (blocking; callers use `spawn_blocking`).
    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> AppResult<T>) -> AppResult<T> {
        let conn = self.lock()?;
        f(&conn)
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|_| io_err("store lock poisoned"))
    }

    /// Parses a stored config. A config saved before SSL settings existed (no `ssl`
    /// key) gets the default mode for its host (`default_ssl_mode`), not the serde
    /// default: a remote host must not silently switch to unverified TLS. SQLite has
    /// no TLS and keeps the default.
    fn parse(json: &str) -> AppResult<ConnectionConfig> {
        let value: serde_json::Value = serde_json::from_str(json).map_err(io_err)?;
        let legacy = value.get("ssl").is_none();
        let mut cfg: ConnectionConfig = serde_json::from_value(value).map_err(io_err)?;
        if legacy && cfg.kind != DriverKind::Sqlite {
            cfg.ssl.mode = default_ssl_mode(&cfg.host, cfg.ssh.is_some());
        }
        Ok(cfg)
    }

    pub fn list(&self) -> AppResult<Vec<ConnectionConfig>> {
        let conn = self.lock()?;
        let mut stmt = conn
            .prepare("SELECT config_json FROM connections ORDER BY name COLLATE NOCASE, id")
            .map_err(io_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(io_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(Self::parse(&row.map_err(io_err)?)?);
        }
        Ok(out)
    }

    pub fn get(&self, id: &str) -> AppResult<ConnectionConfig> {
        let conn = self.lock()?;
        let json: Option<String> = conn
            .query_row(
                "SELECT config_json FROM connections WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .map_err(io_err)?;
        match json {
            Some(j) => Self::parse(&j),
            None => Err(AppError::new(
                ErrorKind::NotFound,
                format!("connection {id} not found"),
            )),
        }
    }

    pub fn upsert(&self, cfg: &ConnectionConfig) -> AppResult<()> {
        let json = serde_json::to_string(cfg).map_err(io_err)?;
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO connections(id, name, config_json) VALUES(?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, config_json = excluded.config_json",
            params![cfg.id, cfg.name, json],
        )
        .map_err(io_err)?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute("DELETE FROM connections WHERE id = ?1", params![id])
            .map_err(io_err)?;
        // The history of a connection goes with it (it may hold sensitive values).
        conn.execute(
            "DELETE FROM query_history WHERE connection_id = ?1",
            params![id],
        )
        .map_err(io_err)?;
        Ok(())
    }
}

/// True when both configs designate the same server account, reached through the same
/// SSH target with the same TLS settings: a stored keyring secret may only be used for
/// a config whose identity matches the stored one (so weakening TLS verification or
/// changing the CA also requires the secrets again).
pub fn same_identity(a: &ConnectionConfig, b: &ConnectionConfig) -> bool {
    a.kind == b.kind
        && a.ssl == b.ssl
        && a.host == b.host
        && a.port == b.port
        && a.user == b.user
        && a.database == b.database
        && a.sqlite_path == b.sqlite_path
        && match (&a.ssh, &b.ssh) {
            (None, None) => true,
            (Some(x), Some(y)) => {
                x.host == y.host
                    && x.port == y.port
                    && x.user == y.user
                    && x.auth == y.auth
                    && x.key_file == y.key_file
            }
            _ => false,
        }
}

/// Saves `cfg` (assigning an id when empty), its DB password per `password_mode` and
/// its SSH secret per `ssh.secret_mode` (`SshPassword` for password auth,
/// `SshPassphrase` for key auth; the other kind is removed, and both are removed
/// without SSH or with the agent).
///
/// Keyring mode without a new secret keeps the stored one, but only when the
/// connection identity (`same_identity`) is unchanged; changing it requires the secret
/// again (Auth "password required", then "ssh password required" / "ssh passphrase
/// required"; nothing is modified), so a secret never follows an edit to another host,
/// account or SSH server.
///
/// SQLite has no password nor tunnel: the mode is forced to `None`, `ssh` is dropped,
/// any secret is ignored and the keyring is never required (stale secrets are removed
/// best-effort).
///
/// A new connection (empty id) owns no secret yet: nothing is removed, so saving one
/// without secrets never needs the keyring.
pub fn save_connection(
    store: &ConnectionStore,
    secrets: &dyn SecretStore,
    mut cfg: ConnectionConfig,
    password: Option<String>,
    ssh_secret: Option<String>,
) -> AppResult<ConnectionConfig> {
    if cfg.kind == DriverKind::Sqlite {
        cfg.password_mode = PasswordMode::None;
        cfg.ssh = None;
        if cfg.id.is_empty() {
            cfg.id = uuid::Uuid::new_v4().to_string();
        } else {
            for kind in SecretKind::ALL {
                let _ = secrets.delete(&SecretKey::new(cfg.id.clone(), kind));
            }
        }
        store.upsert(&cfg)?;
        return Ok(cfg);
    }
    if let Some(ssh) = cfg.ssh.as_mut()
        && ssh.auth == SshAuth::Agent
    {
        ssh.secret_mode = PasswordMode::None;
    }
    let keeps_db = cfg.password_mode == PasswordMode::Keyring && password.is_none();
    let keeps_ssh = cfg
        .ssh
        .as_ref()
        .is_some_and(|s| s.secret_mode == PasswordMode::Keyring && ssh_secret.is_none());
    let fresh = cfg.id.is_empty();
    if fresh {
        cfg.id = uuid::Uuid::new_v4().to_string();
    } else if keeps_db || keeps_ssh {
        match store.get(&cfg.id) {
            Ok(stored) if !same_identity(&stored, &cfg) => {
                return Err(match &cfg.ssh {
                    Some(ssh) if !keeps_db => ssh.secret_required(),
                    _ => AppError::new(ErrorKind::Auth, "password required"),
                });
            }
            Ok(_) => {}
            Err(e) if e.kind == ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    let key = SecretKey::new(cfg.id.clone(), SecretKind::DbPassword);
    match (cfg.password_mode, password) {
        (PasswordMode::Keyring, Some(pw)) => secrets.set(&key, &pw)?,
        (PasswordMode::Keyring, None) => {}
        _ if fresh => {}
        _ => secrets.delete(&key)?,
    }
    let own = cfg.ssh.as_ref().and_then(SshSettings::secret_kind);
    for kind in [SecretKind::SshPassword, SecretKind::SshPassphrase] {
        let key = SecretKey::new(cfg.id.clone(), kind);
        let mode = cfg.ssh.as_ref().map(|s| s.secret_mode);
        match (own == Some(kind), mode, &ssh_secret) {
            (true, Some(PasswordMode::Keyring), Some(secret)) => secrets.set(&key, secret)?,
            (true, Some(PasswordMode::Keyring), None) => {}
            _ if fresh => {}
            _ => secrets.delete(&key)?,
        }
    }
    store.upsert(&cfg)?;
    Ok(cfg)
}

pub fn delete_connection(
    store: &ConnectionStore,
    secrets: &dyn SecretStore,
    id: &str,
) -> AppResult<()> {
    // SQLite connections never own a secret: clean up best-effort, never block on the keyring.
    let sqlite = matches!(store.get(id), Ok(c) if c.kind == DriverKind::Sqlite);
    // Attempt every kind even if one fails; keep the row so the user can retry.
    let mut first_err: Option<AppError> = None;
    for kind in SecretKind::ALL {
        if let Err(e) = secrets.delete(&SecretKey::new(id, kind)) {
            first_err.get_or_insert(e);
        }
    }
    if let Some(e) = first_err
        && !sqlite
    {
        return Err(e);
    }
    store.delete(id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::tls::SslMode;
    use crate::secrets::MemorySecretStore;

    fn cfg(name: &str, mode: PasswordMode) -> ConnectionConfig {
        ConnectionConfig {
            id: String::new(),
            name: name.into(),
            color: "#fff".into(),
            env_tag: EnvTag::Dev,
            kind: DriverKind::Postgres,
            host: "localhost".into(),
            port: 5432,
            user: "u".into(),
            database: Some("d".into()),
            sqlite_path: None,
            password_mode: mode,
            group: None,
            ssl: SslConfig::default(),
            ssh: None,
            safe_mode: None,
        }
    }

    fn ssh_settings(auth: SshAuth, mode: PasswordMode) -> SshSettings {
        SshSettings {
            host: "bastion.example.com".into(),
            port: Some(22),
            user: Some("deploy".into()),
            auth,
            key_file: (auth == SshAuth::Key).then(|| "/home/u/.ssh/id_ed25519".into()),
            secret_mode: mode,
        }
    }

    fn ssh_cfg(auth: SshAuth) -> ConnectionConfig {
        let mut c = cfg("tunnelled", PasswordMode::Keyring);
        c.ssh = Some(ssh_settings(auth, PasswordMode::Keyring));
        c
    }

    fn open(dir: &tempfile::TempDir) -> ConnectionStore {
        ConnectionStore::open(&dir.path().join("sub").join("app.db")).unwrap()
    }

    #[test]
    fn save_roundtrip_and_sorted_list() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let sec = MemorySecretStore::new();
        let b = save_connection(&store, &sec, cfg("b", PasswordMode::Ask), None, None).unwrap();
        let a = save_connection(&store, &sec, cfg("A", PasswordMode::Ask), None, None).unwrap();
        assert!(!a.id.is_empty() && a.id != b.id);
        let names: Vec<_> = store.list().unwrap().into_iter().map(|c| c.name).collect();
        assert_eq!(names, ["A", "b"]);
        assert_eq!(store.get(&b.id).unwrap(), b);
    }

    #[test]
    fn password_goes_to_secret_store_not_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub").join("app.db");
        let store = ConnectionStore::open(&path).unwrap();
        let sec = MemorySecretStore::new();
        let saved = save_connection(
            &store,
            &sec,
            cfg("x", PasswordMode::Keyring),
            Some("s3cr3t-PW".into()),
            None,
        )
        .unwrap();
        assert_eq!(
            sec.get(&SecretKey::new(saved.id.clone(), SecretKind::DbPassword))
                .unwrap()
                .as_deref(),
            Some("s3cr3t-PW")
        );
        drop(store);
        let needle = b"s3cr3t-PW";
        let mut files = 0;
        for e in std::fs::read_dir(path.parent().unwrap()).unwrap() {
            let bytes = std::fs::read(e.unwrap().path()).unwrap();
            files += 1;
            assert!(!bytes.windows(needle.len()).any(|w| w == needle));
        }
        assert!(files >= 1);
    }

    #[test]
    fn keyring_mode_without_password_keeps_existing_secret() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let sec = MemorySecretStore::new();
        let saved = save_connection(
            &store,
            &sec,
            cfg("x", PasswordMode::Keyring),
            Some("pw".into()),
            None,
        )
        .unwrap();
        let mut again = saved.clone();
        again.name = "renamed".into();
        save_connection(&store, &sec, again, None, None).unwrap();
        let key = SecretKey::new(saved.id.clone(), SecretKind::DbPassword);
        assert_eq!(sec.get(&key).unwrap().as_deref(), Some("pw"));
        assert_eq!(store.get(&saved.id).unwrap().name, "renamed");
    }

    #[test]
    fn save_connection_with_changed_identity_requires_password() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let sec = MemorySecretStore::new();
        let saved = save_connection(
            &store,
            &sec,
            cfg("x", PasswordMode::Keyring),
            Some("pw".into()),
            None,
        )
        .unwrap();
        let key = SecretKey::new(saved.id.clone(), SecretKind::DbPassword);
        type Edit = fn(&mut ConnectionConfig);
        let edits: [Edit; 10] = [
            |c| c.host = "127.0.0.2".into(),
            |c| c.port = 5433,
            |c| c.user = "other".into(),
            |c| c.database = Some("other".into()),
            |c| c.kind = DriverKind::MySql,
            |c| c.sqlite_path = Some("/tmp/x.db".into()),
            // Weaker or different TLS verification must not reuse the stored password.
            |c| c.ssl.mode = SslMode::Disable,
            |c| c.ssl.ca_file = Some("/other/ca.pem".into()),
            |c| c.ssl.cert_file = Some("/other/client.pem".into()),
            |c| c.ssl.key_file = Some("/other/client.key".into()),
        ];
        for edit in edits {
            let mut changed = saved.clone();
            changed.name = "renamed".into();
            edit(&mut changed);
            let err = save_connection(&store, &sec, changed, None, None).unwrap_err();
            assert_eq!(err.kind, ErrorKind::Auth);
            assert_eq!(err.message, "password required");
            assert_eq!(
                store.get(&saved.id).unwrap(),
                saved,
                "row must be unchanged"
            );
            assert_eq!(sec.get(&key).unwrap().as_deref(), Some("pw"));
        }
        // With a new password the edit goes through and the secret is replaced.
        let mut changed = saved.clone();
        changed.host = "127.0.0.2".into();
        save_connection(&store, &sec, changed.clone(), Some("pw2".into()), None).unwrap();
        assert_eq!(store.get(&saved.id).unwrap(), changed);
        assert_eq!(sec.get(&key).unwrap().as_deref(), Some("pw2"));
    }

    #[test]
    fn switching_to_ask_mode_deletes_secret() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let sec = MemorySecretStore::new();
        let saved = save_connection(
            &store,
            &sec,
            cfg("x", PasswordMode::Keyring),
            Some("pw".into()),
            None,
        )
        .unwrap();
        let mut ask = saved.clone();
        ask.password_mode = PasswordMode::Ask;
        save_connection(&store, &sec, ask, None, None).unwrap();
        assert_eq!(
            sec.get(&SecretKey::new(saved.id, SecretKind::DbPassword))
                .unwrap(),
            None
        );
    }

    #[test]
    fn delete_connection_removes_all_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let sec = MemorySecretStore::new();
        let saved = save_connection(
            &store,
            &sec,
            cfg("x", PasswordMode::Keyring),
            Some("pw".into()),
            None,
        )
        .unwrap();
        for k in SecretKind::ALL {
            sec.set(&SecretKey::new(saved.id.clone(), k), "v").unwrap();
        }
        delete_connection(&store, &sec, &saved.id).unwrap();
        for k in SecretKind::ALL {
            assert_eq!(sec.get(&SecretKey::new(saved.id.clone(), k)).unwrap(), None);
        }
        assert_eq!(store.get(&saved.id).unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn chmod_refused_by_the_file_system_is_tolerated() {
        use std::io::{Error, ErrorKind as IoKind};
        assert!(tolerate_no_chmod(Err(Error::from_raw_os_error(1))).is_ok());
        #[cfg(target_os = "linux")]
        assert!(tolerate_no_chmod(Err(Error::from_raw_os_error(95))).is_ok());
        assert!(tolerate_no_chmod(Err(Error::from(IoKind::Unsupported))).is_ok());
        assert!(tolerate_no_chmod(Ok(())).is_ok());
        // Not found, EACCES, EIO... stay fatal.
        for code in [2, 13, 5] {
            assert!(
                tolerate_no_chmod(Err(Error::from_raw_os_error(code))).is_err(),
                "{code}"
            );
        }
    }

    #[test]
    fn get_missing_is_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        assert_eq!(store.get("nope").unwrap_err().kind, ErrorKind::NotFound);
    }

    #[test]
    fn serde_shape_is_camel_case_without_secrets() {
        let v = serde_json::to_value(cfg("x", PasswordMode::Keyring)).unwrap();
        assert_eq!(v["envTag"], "dev");
        assert_eq!(v["passwordMode"], "keyring");
        assert_eq!(v["kind"], "postgres");
        assert!(v.get("password").is_none());
    }

    struct FailingDelete {
        inner: MemorySecretStore,
        fail: SecretKind,
        attempted: Mutex<Vec<SecretKind>>,
    }

    impl SecretStore for FailingDelete {
        fn available(&self) -> bool {
            true
        }
        fn set(&self, k: &SecretKey, v: &str) -> AppResult<()> {
            self.inner.set(k, v)
        }
        fn get(&self, k: &SecretKey) -> AppResult<Option<String>> {
            self.inner.get(k)
        }
        fn delete(&self, k: &SecretKey) -> AppResult<()> {
            self.attempted.lock().unwrap().push(k.kind);
            if k.kind == self.fail {
                return Err(AppError::new(ErrorKind::Secret, "boom"));
            }
            self.inner.delete(k)
        }
    }

    /// A keyring that is unavailable: every call fails.
    struct BrokenSecrets;

    impl SecretStore for BrokenSecrets {
        fn available(&self) -> bool {
            false
        }
        fn set(&self, _: &SecretKey, _: &str) -> AppResult<()> {
            Err(AppError::new(ErrorKind::Secret, "no keyring"))
        }
        fn get(&self, _: &SecretKey) -> AppResult<Option<String>> {
            Err(AppError::new(ErrorKind::Secret, "no keyring"))
        }
        fn delete(&self, _: &SecretKey) -> AppResult<()> {
            Err(AppError::new(ErrorKind::Secret, "no keyring"))
        }
    }

    fn sqlite_cfg(mode: PasswordMode) -> ConnectionConfig {
        let mut c = cfg("lite", mode);
        c.kind = DriverKind::Sqlite;
        c.host = String::new();
        c.port = 0;
        c.user = String::new();
        c.database = None;
        c.sqlite_path = Some("/tmp/x.db".into());
        c
    }

    #[test]
    fn sqlite_save_never_needs_the_keyring() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        // Even a keyring-mode config with a typed password: nothing is stored.
        let saved = save_connection(
            &store,
            &BrokenSecrets,
            sqlite_cfg(PasswordMode::Keyring),
            Some("ignored".into()),
            None,
        )
        .unwrap();
        assert_eq!(saved.password_mode, PasswordMode::None);
        assert_eq!(store.get(&saved.id).unwrap(), saved);
        // Re-saving an existing SQLite connection (also with a changed path) works too.
        let mut again = saved.clone();
        again.sqlite_path = Some("/tmp/y.db".into());
        again.password_mode = PasswordMode::Keyring;
        let again = save_connection(&store, &BrokenSecrets, again, None, None).unwrap();
        assert_eq!(again.password_mode, PasswordMode::None);
        assert_eq!(
            store.get(&saved.id).unwrap().sqlite_path.as_deref(),
            Some("/tmp/y.db")
        );
    }

    #[test]
    fn sqlite_save_drops_a_stale_password() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let sec = MemorySecretStore::new();
        let mut c = sqlite_cfg(PasswordMode::None);
        c.id = "lite-id".into();
        let key = SecretKey::new("lite-id", SecretKind::DbPassword);
        sec.set(&key, "stale").unwrap();
        save_connection(&store, &sec, c, Some("typed".into()), None).unwrap();
        assert_eq!(sec.get(&key).unwrap(), None);
    }

    #[test]
    fn delete_connection_keeps_row_when_secret_delete_fails() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let sec = FailingDelete {
            inner: MemorySecretStore::new(),
            fail: SecretKind::DbPassword,
            attempted: Mutex::new(vec![]),
        };
        let mut saved = cfg("x", PasswordMode::Ask);
        saved.id = "fixed-id".into();
        store.upsert(&saved).unwrap();
        for k in SecretKind::ALL {
            sec.inner
                .set(&SecretKey::new(saved.id.clone(), k), "v")
                .unwrap();
        }
        let err = delete_connection(&store, &sec, &saved.id).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Secret);
        assert!(store.get(&saved.id).is_ok());
        assert_eq!(*sec.attempted.lock().unwrap(), SecretKind::ALL.to_vec());
        assert_eq!(
            sec.inner
                .get(&SecretKey::new(saved.id.clone(), SecretKind::SshPassword))
                .unwrap(),
            None
        );
    }

    #[test]
    fn plan1_config_json_still_parses() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let legacy = |id: &str, host: &str| {
            format!(
                r##"{{"id":"{id}","name":"old","color":"#888","envTag":"dev","kind":"postgres",
                "host":"{host}","port":5432,"user":"u","database":null,"sqlitePath":null,
                "passwordMode":"keyring","group":null}}"##
            )
        };
        let conn = store.lock().unwrap();
        for (id, host) in [("local", "localhost"), ("remote", "db.example.com")] {
            conn.execute(
                "INSERT INTO connections(id, name, config_json) VALUES(?1, 'old', ?2)",
                params![id, legacy(id, host)],
            )
            .unwrap();
        }
        drop(conn);
        // A legacy local host keeps Prefer; a legacy remote host is verified, never
        // silently downgraded to unverified TLS.
        let local = store.get("local").unwrap();
        assert_eq!(local.ssl, SslConfig::default());
        assert_eq!(local.ssl.mode, SslMode::Prefer);
        assert_eq!(local.ssh, None);
        let remote = store.get("remote").unwrap();
        assert_eq!(remote.ssl.mode, SslMode::VerifyFull);
        assert_eq!(remote.ssl.ca_file, None);
        assert_eq!(remote.ssh, None);
        let listed: Vec<_> = store
            .list()
            .unwrap()
            .into_iter()
            .map(|c| c.ssl.mode)
            .collect();
        assert!(listed.contains(&SslMode::VerifyFull), "{listed:?}");

        // An explicit mode is never rewritten.
        let mut explicit = cfg("explicit", PasswordMode::Ask);
        explicit.host = "db.example.com".into();
        explicit.ssl.mode = SslMode::Require;
        let saved =
            save_connection(&store, &MemorySecretStore::new(), explicit, None, None).unwrap();
        assert_eq!(store.get(&saved.id).unwrap().ssl.mode, SslMode::Require);
    }

    #[test]
    fn ssh_settings_serde_shape_is_camel_case() {
        let v = serde_json::to_value(ssh_cfg(SshAuth::Key)).unwrap();
        assert_eq!(v["ssl"]["mode"], "prefer");
        assert_eq!(v["ssh"]["auth"], "key");
        assert_eq!(v["ssh"]["keyFile"], "/home/u/.ssh/id_ed25519");
        assert_eq!(v["ssh"]["secretMode"], "keyring");
        let back: ConnectionConfig = serde_json::from_value(v).unwrap();
        assert_eq!(back, ssh_cfg(SshAuth::Key));
    }

    #[test]
    fn ssh_secret_follows_auth_kind() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let sec = MemorySecretStore::new();
        let saved = save_connection(
            &store,
            &sec,
            ssh_cfg(SshAuth::Password),
            Some("db-pw".into()),
            Some("ssh-pw".into()),
        )
        .unwrap();
        let pw_key = SecretKey::new(saved.id.clone(), SecretKind::SshPassword);
        let pp_key = SecretKey::new(saved.id.clone(), SecretKind::SshPassphrase);
        assert_eq!(sec.get(&pw_key).unwrap().as_deref(), Some("ssh-pw"));
        assert_eq!(sec.get(&pp_key).unwrap(), None);

        let mut key = saved.clone();
        key.ssh = Some(ssh_settings(SshAuth::Key, PasswordMode::Keyring));
        save_connection(
            &store,
            &sec,
            key,
            Some("db-pw".into()),
            Some("key-pass".into()),
        )
        .unwrap();
        assert_eq!(sec.get(&pp_key).unwrap().as_deref(), Some("key-pass"));
        assert_eq!(sec.get(&pw_key).unwrap(), None);
        // The DB password is untouched by SSH changes.
        let db_key = SecretKey::new(saved.id.clone(), SecretKind::DbPassword);
        assert_eq!(sec.get(&db_key).unwrap().as_deref(), Some("db-pw"));

        // Agent: no SSH secret at all, and the mode is forced to None.
        let mut agent = saved.clone();
        agent.ssh = Some(ssh_settings(SshAuth::Agent, PasswordMode::Keyring));
        let agent = save_connection(
            &store,
            &sec,
            agent,
            Some("db-pw".into()),
            Some("ignored".into()),
        )
        .unwrap();
        assert_eq!(agent.ssh.unwrap().secret_mode, PasswordMode::None);
        assert_eq!(sec.get(&pp_key).unwrap(), None);
        assert_eq!(sec.get(&pw_key).unwrap(), None);
    }

    #[test]
    fn removing_ssh_deletes_both_ssh_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let sec = MemorySecretStore::new();
        let saved = save_connection(
            &store,
            &sec,
            ssh_cfg(SshAuth::Password),
            Some("db-pw".into()),
            Some("ssh-pw".into()),
        )
        .unwrap();
        sec.set(
            &SecretKey::new(saved.id.clone(), SecretKind::SshPassphrase),
            "stale",
        )
        .unwrap();
        let mut direct = saved.clone();
        direct.ssh = None;
        save_connection(&store, &sec, direct, Some("db-pw".into()), None).unwrap();
        for kind in [SecretKind::SshPassword, SecretKind::SshPassphrase] {
            assert_eq!(
                sec.get(&SecretKey::new(saved.id.clone(), kind)).unwrap(),
                None
            );
        }
    }

    #[test]
    fn ssh_secret_ask_mode_is_not_stored() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let sec = MemorySecretStore::new();
        let mut c = ssh_cfg(SshAuth::Password);
        c.ssh = Some(ssh_settings(SshAuth::Password, PasswordMode::Ask));
        let saved =
            save_connection(&store, &sec, c, Some("db-pw".into()), Some("typed".into())).unwrap();
        let key = SecretKey::new(saved.id.clone(), SecretKind::SshPassword);
        assert_eq!(sec.get(&key).unwrap(), None);
    }

    #[test]
    fn keyring_ssh_secret_is_kept_when_identity_is_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let sec = MemorySecretStore::new();
        let saved = save_connection(
            &store,
            &sec,
            ssh_cfg(SshAuth::Password),
            Some("db-pw".into()),
            Some("ssh-pw".into()),
        )
        .unwrap();
        let mut renamed = saved.clone();
        renamed.name = "renamed".into();
        save_connection(&store, &sec, renamed, None, None).unwrap();
        let key = SecretKey::new(saved.id.clone(), SecretKind::SshPassword);
        assert_eq!(sec.get(&key).unwrap().as_deref(), Some("ssh-pw"));
        assert_eq!(store.get(&saved.id).unwrap().name, "renamed");
    }

    #[test]
    fn changing_ssh_host_requires_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let sec = MemorySecretStore::new();
        let saved = save_connection(
            &store,
            &sec,
            ssh_cfg(SshAuth::Password),
            Some("db-pw".into()),
            Some("ssh-pw".into()),
        )
        .unwrap();
        let ssh_key = SecretKey::new(saved.id.clone(), SecretKind::SshPassword);
        let db_key = SecretKey::new(saved.id.clone(), SecretKind::DbPassword);
        let unchanged = |store: &ConnectionStore| {
            assert_eq!(
                store.get(&saved.id).unwrap(),
                saved,
                "row must be unchanged"
            );
            assert_eq!(sec.get(&db_key).unwrap().as_deref(), Some("db-pw"));
            assert_eq!(sec.get(&ssh_key).unwrap().as_deref(), Some("ssh-pw"));
        };
        let mut moved = saved.clone();
        moved.ssh.as_mut().unwrap().host = "other-bastion".into();
        let err = save_connection(&store, &sec, moved.clone(), None, None).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Auth);
        assert_eq!(err.message, "password required");
        unchanged(&store);

        // A new DB password alone is not enough: the SSH secret must be typed again too.
        let err =
            save_connection(&store, &sec, moved.clone(), Some("db-pw2".into()), None).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Auth);
        assert_eq!(err.message, "ssh password required");
        unchanged(&store);

        type Edit = fn(&mut SshSettings);
        let edits: [Edit; 4] = [
            |s| s.port = Some(2222),
            |s| s.user = Some("root".into()),
            |s| s.key_file = Some("/other/key".into()),
            |s| s.port = None,
        ];
        for edit in edits {
            let mut changed = saved.clone();
            edit(changed.ssh.as_mut().unwrap());
            let err =
                save_connection(&store, &sec, changed, Some("db-pw".into()), None).unwrap_err();
            assert_eq!(err.message, "ssh password required");
            unchanged(&store);
        }
        // Key auth reports the passphrase as the missing secret.
        let mut key = saved.clone();
        key.ssh = Some(ssh_settings(SshAuth::Key, PasswordMode::Keyring));
        let err = save_connection(&store, &sec, key, Some("db-pw".into()), None).unwrap_err();
        assert_eq!(err.message, "ssh passphrase required");
        unchanged(&store);

        // With both secrets the edit goes through.
        save_connection(
            &store,
            &sec,
            moved.clone(),
            Some("db-pw2".into()),
            Some("ssh-pw2".into()),
        )
        .unwrap();
        assert_eq!(store.get(&saved.id).unwrap(), moved);
        assert_eq!(sec.get(&ssh_key).unwrap().as_deref(), Some("ssh-pw2"));
    }

    #[test]
    fn same_identity_covers_ssh_target() {
        let a = ssh_cfg(SshAuth::Password);
        let mut b = a.clone();
        b.name = "other name".into();
        b.ssh.as_mut().unwrap().secret_mode = PasswordMode::Ask;
        assert!(same_identity(&a, &b));
        // TLS settings are part of the identity: a downgrade needs the secrets again.
        let mut tls = a.clone();
        tls.ssl.mode = SslMode::VerifyFull;
        assert!(!same_identity(&a, &tls));
        let mut c = a.clone();
        c.ssh.as_mut().unwrap().auth = SshAuth::Agent;
        assert!(!same_identity(&a, &c));
        let mut d = a.clone();
        d.ssh = None;
        assert!(!same_identity(&a, &d));
    }

    #[test]
    fn config_json_has_no_secret() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let sec = MemorySecretStore::new();
        let saved = save_connection(
            &store,
            &sec,
            ssh_cfg(SshAuth::Password),
            Some("DB-s3cret".into()),
            Some("SSH-s3cret".into()),
        )
        .unwrap();
        let json: String = store
            .lock()
            .unwrap()
            .query_row(
                "SELECT config_json FROM connections WHERE id = ?1",
                params![saved.id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(json.contains("bastion.example.com"), "{json}");
        assert!(!json.contains("DB-s3cret"), "{json}");
        assert!(!json.contains("SSH-s3cret"), "{json}");
    }

    #[test]
    fn sqlite_save_drops_ssh() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let mut c = sqlite_cfg(PasswordMode::None);
        c.ssh = Some(ssh_settings(SshAuth::Password, PasswordMode::Keyring));
        let saved = save_connection(&store, &BrokenSecrets, c, None, Some("x".into())).unwrap();
        assert_eq!(saved.ssh, None);
        assert_eq!(store.get(&saved.id).unwrap().ssh, None);
    }

    #[test]
    fn new_connection_without_secrets_needs_no_keyring() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let mut c = ssh_cfg(SshAuth::Key);
        c.password_mode = PasswordMode::Ask;
        c.ssh.as_mut().unwrap().secret_mode = PasswordMode::None;
        // A fresh id owns no secret: nothing to remove, so the keyring is not touched.
        let saved = save_connection(&store, &BrokenSecrets, c, None, None).unwrap();
        assert_eq!(store.get(&saved.id).unwrap(), saved);
        // Editing it removes stale secrets, which needs the keyring.
        let err = save_connection(&store, &BrokenSecrets, saved, None, None).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Secret);
    }

    #[test]
    fn legacy_sqlite_config_keeps_default_ssl() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let json = r##"{"id":"lite","name":"old","color":"#888","envTag":"dev","kind":"sqlite",
            "host":"","port":0,"user":"","database":null,"sqlitePath":"/tmp/x.db",
            "passwordMode":"none","group":null}"##;
        store
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO connections(id, name, config_json) VALUES('lite', 'old', ?1)",
                params![json],
            )
            .unwrap();
        // An empty host is not "local": without the SQLite exception it would get VerifyFull.
        assert_eq!(store.get("lite").unwrap().ssl, SslConfig::default());
    }
}

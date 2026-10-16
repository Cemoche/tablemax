use std::path::Path;
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::driver::DriverKind;
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
}

pub struct ConnectionStore {
    conn: Mutex<Connection>,
}

fn io_err(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorKind::Io, format!("connection store: {e}"))
}

impl ConnectionStore {
    pub fn open(path: &Path) -> AppResult<Self> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).map_err(io_err)?;
        }
        let conn = Connection::open(path).map_err(io_err)?;
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
        Ok(())
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|_| io_err("store lock poisoned"))
    }

    fn parse(json: &str) -> AppResult<ConnectionConfig> {
        serde_json::from_str(json).map_err(io_err)
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
        Ok(())
    }
}

/// True when both configs designate the same server account: a stored keyring
/// secret may only be used for a config whose identity matches the stored one.
pub fn same_identity(a: &ConnectionConfig, b: &ConnectionConfig) -> bool {
    a.kind == b.kind
        && a.host == b.host
        && a.port == b.port
        && a.user == b.user
        && a.database == b.database
        && a.sqlite_path == b.sqlite_path
}

/// Saves `cfg` (assigning an id when empty) and its password per `password_mode`.
/// Keyring mode without a new password keeps the stored secret, but only when the
/// connection identity is unchanged; changing it requires a new password (Auth
/// "password required", nothing is modified), so a secret never follows an edit to
/// another host or account.
///
/// SQLite has no password: the mode is forced to `None`, any password is ignored and
/// the keyring is never required (a stale secret is removed best-effort).
pub fn save_connection(
    store: &ConnectionStore,
    secrets: &dyn SecretStore,
    mut cfg: ConnectionConfig,
    password: Option<String>,
) -> AppResult<ConnectionConfig> {
    if cfg.kind == DriverKind::Sqlite {
        cfg.password_mode = PasswordMode::None;
        if cfg.id.is_empty() {
            cfg.id = uuid::Uuid::new_v4().to_string();
        } else {
            let _ = secrets.delete(&SecretKey::new(cfg.id.clone(), SecretKind::DbPassword));
        }
        store.upsert(&cfg)?;
        return Ok(cfg);
    }
    if cfg.id.is_empty() {
        cfg.id = uuid::Uuid::new_v4().to_string();
    } else if cfg.password_mode == PasswordMode::Keyring && password.is_none() {
        match store.get(&cfg.id) {
            Ok(stored) if !same_identity(&stored, &cfg) => {
                return Err(AppError::new(ErrorKind::Auth, "password required"));
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
        _ => secrets.delete(&key)?,
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
        }
    }

    fn open(dir: &tempfile::TempDir) -> ConnectionStore {
        ConnectionStore::open(&dir.path().join("sub").join("app.db")).unwrap()
    }

    #[test]
    fn save_roundtrip_and_sorted_list() {
        let dir = tempfile::tempdir().unwrap();
        let store = open(&dir);
        let sec = MemorySecretStore::new();
        let b = save_connection(&store, &sec, cfg("b", PasswordMode::Ask), None).unwrap();
        let a = save_connection(&store, &sec, cfg("A", PasswordMode::Ask), None).unwrap();
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
        )
        .unwrap();
        let mut again = saved.clone();
        again.name = "renamed".into();
        save_connection(&store, &sec, again, None).unwrap();
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
        )
        .unwrap();
        let key = SecretKey::new(saved.id.clone(), SecretKind::DbPassword);
        type Edit = fn(&mut ConnectionConfig);
        let edits: [Edit; 6] = [
            |c| c.host = "127.0.0.2".into(),
            |c| c.port = 5433,
            |c| c.user = "other".into(),
            |c| c.database = Some("other".into()),
            |c| c.kind = DriverKind::MySql,
            |c| c.sqlite_path = Some("/tmp/x.db".into()),
        ];
        for edit in edits {
            let mut changed = saved.clone();
            changed.name = "renamed".into();
            edit(&mut changed);
            let err = save_connection(&store, &sec, changed, None).unwrap_err();
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
        save_connection(&store, &sec, changed.clone(), Some("pw2".into())).unwrap();
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
        )
        .unwrap();
        let mut ask = saved.clone();
        ask.password_mode = PasswordMode::Ask;
        save_connection(&store, &sec, ask, None).unwrap();
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
        )
        .unwrap();
        assert_eq!(saved.password_mode, PasswordMode::None);
        assert_eq!(store.get(&saved.id).unwrap(), saved);
        // Re-saving an existing SQLite connection (also with a changed path) works too.
        let mut again = saved.clone();
        again.sqlite_path = Some("/tmp/y.db".into());
        again.password_mode = PasswordMode::Keyring;
        let again = save_connection(&store, &BrokenSecrets, again, None).unwrap();
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
        save_connection(&store, &sec, c, Some("typed".into())).unwrap();
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
}

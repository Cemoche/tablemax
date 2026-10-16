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

pub fn save_connection(
    store: &ConnectionStore,
    secrets: &dyn SecretStore,
    mut cfg: ConnectionConfig,
    password: Option<String>,
) -> AppResult<ConnectionConfig> {
    if cfg.id.is_empty() {
        cfg.id = uuid::Uuid::new_v4().to_string();
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
    store.delete(id)?;
    for kind in SecretKind::ALL {
        secrets.delete(&SecretKey::new(id, kind))?;
    }
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
}

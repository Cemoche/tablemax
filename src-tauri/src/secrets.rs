use std::collections::HashMap;
use std::sync::Mutex;

use crate::error::{AppError, AppResult, ErrorKind};

/// Keyring service name. It was the app identifier until that changed to
/// `io.github.cemoche.tablemax` (#49); kept as is so saved passwords stay readable.
pub const SERVICE: &str = "dev.tablemax.app";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
    DbPassword,
    SshPassword,
    SshPassphrase,
}

impl SecretKind {
    pub const ALL: [SecretKind; 3] = [
        SecretKind::DbPassword,
        SecretKind::SshPassword,
        SecretKind::SshPassphrase,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SecretKind::DbPassword => "db_password",
            SecretKind::SshPassword => "ssh_password",
            SecretKind::SshPassphrase => "ssh_passphrase",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretKey {
    pub connection_id: String,
    pub kind: SecretKind,
}

impl SecretKey {
    pub fn new(connection_id: impl Into<String>, kind: SecretKind) -> Self {
        Self {
            connection_id: connection_id.into(),
            kind,
        }
    }

    pub fn username(&self) -> String {
        format!("{}:{}", self.connection_id, self.kind.as_str())
    }
}

pub trait SecretStore: Send + Sync {
    fn available(&self) -> bool;
    fn set(&self, key: &SecretKey, value: &str) -> AppResult<()>;
    fn get(&self, key: &SecretKey) -> AppResult<Option<String>>;
    fn delete(&self, key: &SecretKey) -> AppResult<()>;
}

pub struct KeyringSecretStore;

fn secret_err(op: &str, e: keyring::Error) -> AppError {
    // The keyring error never carries the secret value; only the operation and error text.
    AppError::new(ErrorKind::Secret, format!("keyring {op} failed: {e}"))
}

fn entry(key: &SecretKey) -> AppResult<keyring::Entry> {
    keyring::Entry::new(SERVICE, &key.username()).map_err(|e| secret_err("entry", e))
}

impl SecretStore for KeyringSecretStore {
    fn available(&self) -> bool {
        keyring::Entry::store_status().is_ok()
    }

    fn set(&self, key: &SecretKey, value: &str) -> AppResult<()> {
        entry(key)?
            .set_password(value)
            .map_err(|e| secret_err("set", e))
    }

    fn get(&self, key: &SecretKey) -> AppResult<Option<String>> {
        match entry(key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(secret_err("get", e)),
        }
    }

    fn delete(&self, key: &SecretKey) -> AppResult<()> {
        match entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(secret_err("delete", e)),
        }
    }
}

/// In-memory store for tests.
#[derive(Default)]
pub struct MemorySecretStore {
    map: Mutex<HashMap<String, String>>,
}

impl MemorySecretStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl SecretStore for MemorySecretStore {
    fn available(&self) -> bool {
        true
    }

    fn set(&self, key: &SecretKey, value: &str) -> AppResult<()> {
        self.map
            .lock()
            .unwrap()
            .insert(key.username(), value.to_string());
        Ok(())
    }

    fn get(&self, key: &SecretKey) -> AppResult<Option<String>> {
        Ok(self.map.lock().unwrap().get(&key.username()).cloned())
    }

    fn delete(&self, key: &SecretKey) -> AppResult<()> {
        self.map.lock().unwrap().remove(&key.username());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn username_suffixes() {
        assert_eq!(
            SecretKey::new("c1", SecretKind::DbPassword).username(),
            "c1:db_password"
        );
        assert_eq!(
            SecretKey::new("c1", SecretKind::SshPassword).username(),
            "c1:ssh_password"
        );
        assert_eq!(
            SecretKey::new("c1", SecretKind::SshPassphrase).username(),
            "c1:ssh_passphrase"
        );
    }

    #[test]
    fn memory_store_semantics() {
        let s = MemorySecretStore::new();
        let k = SecretKey::new("x", SecretKind::DbPassword);
        assert_eq!(s.get(&k).unwrap(), None);
        s.delete(&k).unwrap();
        s.set(&k, "v").unwrap();
        assert_eq!(s.get(&k).unwrap().as_deref(), Some("v"));
        s.delete(&k).unwrap();
        assert_eq!(s.get(&k).unwrap(), None);
    }

    #[test]
    #[ignore = "touches the real OS keyring; run manually with --ignored"]
    fn keyring_roundtrip_real_os_store() {
        let s = KeyringSecretStore;
        assert!(s.available(), "no OS keyring available");
        let k = SecretKey::new(
            format!("test-{}", uuid::Uuid::new_v4()),
            SecretKind::DbPassword,
        );
        assert_eq!(s.get(&k).unwrap(), None);
        s.set(&k, "roundtrip-pw").unwrap();
        assert_eq!(s.get(&k).unwrap().as_deref(), Some("roundtrip-pw"));
        s.delete(&k).unwrap();
        assert_eq!(s.get(&k).unwrap(), None);
        s.delete(&k).unwrap();
    }
}

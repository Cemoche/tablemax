//! Import of connections from other tools' export files.
//!
//! Flow: `preview` decrypts and parses the file and keeps the parsed entries, secrets
//! included, in memory only ([`PendingImports`], keyed by a random `import_id`) while the
//! frontend receives configs and has-secret flags; `commit` saves the chosen entries and
//! drops the pending import. Secrets never leave the backend.

pub mod rncryptor;
pub mod tableplus;

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::secrets::{SecretKey, SecretKind, SecretStore};
use crate::store::{
    ConnectionConfig, ConnectionStore, PasswordMode, same_identity, save_connection,
};
use tableplus::{ImportWarning, ImportedConnection};

/// Largest export file read.
pub const MAX_EXPORT_SIZE: u64 = 10 * 1024 * 1024;
/// How long a previewed import stays committable.
pub const IMPORT_TTL: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportItem {
    /// Position in the pending import (what `commit` takes).
    pub index: usize,
    /// Empty `id`; no secret.
    pub config: ConnectionConfig,
    pub has_password: bool,
    pub has_ssh_secret: bool,
    /// Id of an existing connection with the same identity or the same name.
    pub duplicate_of: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub import_id: String,
    pub items: Vec<ImportItem>,
    pub warnings: Vec<ImportWarning>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub saved: Vec<ConnectionConfig>,
    pub warnings: Vec<ImportWarning>,
}

/// Reads an export file of at most [`MAX_EXPORT_SIZE`] bytes.
pub fn read_export(path: &Path) -> AppResult<Vec<u8>> {
    let io = |e: std::io::Error| {
        AppError::new(
            ErrorKind::Io,
            format!("cannot read {}: {e}", path.display()),
        )
    };
    let too_large = || AppError::new(ErrorKind::Invalid, "file too large");
    let file = File::open(path).map_err(io)?;
    if file.metadata().map_err(io)?.len() > MAX_EXPORT_SIZE {
        return Err(too_large());
    }
    let mut data = Vec::new();
    // Bounded even if the file grows after the size check.
    file.take(MAX_EXPORT_SIZE + 1)
        .read_to_end(&mut data)
        .map_err(io)?;
    if data.len() as u64 > MAX_EXPORT_SIZE {
        return Err(too_large());
    }
    Ok(data)
}

/// Preview rows for `entries`: configs and has-secret flags (never the secrets), each
/// matched against the `existing` connections: same identity (`same_identity`) and
/// name first, else same identity, else same name.
pub fn preview_items(
    entries: &[ImportedConnection],
    existing: &[ConnectionConfig],
) -> Vec<ImportItem> {
    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let cfg = &entry.config;
            let identity = |c: &&ConnectionConfig| same_identity(c, cfg);
            let name = |c: &&ConnectionConfig| c.name == cfg.name;
            ImportItem {
                index,
                config: cfg.clone(),
                has_password: entry.password.is_some(),
                has_ssh_secret: entry.ssh_secret.is_some(),
                duplicate_of: existing
                    .iter()
                    .find(|c| identity(c) && name(c))
                    .or_else(|| existing.iter().find(identity))
                    .or_else(|| existing.iter().find(name))
                    .map(|c| c.id.clone()),
            }
        })
        .collect()
}

const KEYRING_FALLBACK: &str =
    "keyring unavailable: secrets not saved, you will be asked for them when connecting";

/// Saves `entries` as new connections, never failing as a whole: an entry that cannot
/// be saved becomes a warning, and so does one saved in `Ask` mode because its secrets
/// could not go to the keyring.
pub fn commit_entries(
    store: &ConnectionStore,
    secrets: &dyn SecretStore,
    entries: Vec<ImportedConnection>,
) -> ImportResult {
    let keyring = secrets.available();
    let mut result = ImportResult {
        saved: Vec::new(),
        warnings: Vec::new(),
    };
    for entry in entries {
        let name = entry.config.name.clone();
        let warning = match commit_one(store, secrets, keyring, entry) {
            Ok((saved, in_keyring)) => {
                result.saved.push(saved);
                (!in_keyring).then(|| KEYRING_FALLBACK.to_string())
            }
            Err(e) => Some(format!("not saved: {}", e.message)),
        };
        if let Some(message) = warning {
            result.warnings.push(ImportWarning {
                entry: name,
                message,
            });
        }
    }
    result
}

/// Saves one entry with its secrets in the keyring (`true`), or, when the keyring is
/// unavailable or refuses them, in `Ask` mode without them (`false`).
fn commit_one(
    store: &ConnectionStore,
    secrets: &dyn SecretStore,
    keyring: bool,
    entry: ImportedConnection,
) -> AppResult<(ConnectionConfig, bool)> {
    let ImportedConnection {
        mut config,
        password,
        ssh_secret,
    } = entry;
    config.id = String::new();
    if password.is_none() && ssh_secret.is_none() {
        return Ok((save_connection(store, secrets, config, None, None)?, true));
    }
    if keyring {
        // Own id up front, so secrets stored before a failure can be removed.
        let mut keyed = config.clone();
        keyed.id = uuid::Uuid::new_v4().to_string();
        let id = keyed.id.clone();
        match save_connection(store, secrets, keyed, password, ssh_secret) {
            Ok(saved) => return Ok((saved, true)),
            Err(e) => {
                for kind in SecretKind::ALL {
                    let _ = secrets.delete(&SecretKey::new(id.clone(), kind));
                }
                if e.kind != ErrorKind::Secret {
                    return Err(e);
                }
            }
        }
    }
    if config.password_mode == PasswordMode::Keyring {
        config.password_mode = PasswordMode::Ask;
    }
    if let Some(ssh) = config.ssh.as_mut()
        && ssh.secret_mode == PasswordMode::Keyring
    {
        ssh.secret_mode = PasswordMode::Ask;
    }
    Ok((save_connection(store, secrets, config, None, None)?, false))
}

struct Pending {
    created: Instant,
    entries: Vec<ImportedConnection>,
}

/// Previewed imports waiting for their commit, secrets included (memory only). An
/// import expires after its TTL or at its first commit.
pub struct PendingImports {
    ttl: Duration,
    map: Mutex<HashMap<String, Pending>>,
}

impl std::fmt::Debug for PendingImports {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PendingImports")
            .field("ttl", &self.ttl)
            .field("entries", &"<redacted>")
            .finish()
    }
}

fn import_expired() -> AppError {
    AppError::new(ErrorKind::NotFound, "import expired")
}

impl PendingImports {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            map: Mutex::new(HashMap::new()),
        }
    }

    /// The live imports (expired ones are dropped first).
    fn live(&self) -> MutexGuard<'_, HashMap<String, Pending>> {
        // Map updates never panic half-way, so a poisoned lock still holds consistent data.
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, p| p.created.elapsed() < self.ttl);
        map
    }

    /// Stores `entries` and returns their new `import_id`.
    pub fn insert(&self, entries: Vec<ImportedConnection>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let pending = Pending {
            created: Instant::now(),
            entries,
        };
        self.live().insert(id.clone(), pending);
        id
    }

    /// Removes the import and returns its entries at `indexes` (each once, in the given
    /// order). NotFound "import expired" for an unknown or expired id; an index out of
    /// range is Invalid and keeps the import.
    pub fn take(&self, import_id: &str, indexes: &[usize]) -> AppResult<Vec<ImportedConnection>> {
        let mut map = self.live();
        let len = map.get(import_id).ok_or_else(import_expired)?.entries.len();
        if let Some(bad) = indexes.iter().find(|&&i| i >= len) {
            return Err(AppError::new(
                ErrorKind::Invalid,
                format!("unknown import entry {bad}"),
            ));
        }
        let pending = map.remove(import_id).ok_or_else(import_expired)?;
        let mut slots: Vec<_> = pending.entries.into_iter().map(Some).collect();
        Ok(indexes.iter().filter_map(|&i| slots[i].take()).collect())
    }
}

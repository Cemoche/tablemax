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
use std::future::Future;
use std::io::Read;
use std::path::{Path, PathBuf};
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

    /// Drops the import and its secrets now (an unknown or expired id is a no-op).
    pub fn discard(&self, import_id: &str) {
        self.live().remove(import_id);
    }
}

/// The export file the user last picked in the native picker. Kept server-side (the
/// webview never sends a path) so a retry with another password re-reads the same file.
#[derive(Debug, Default)]
pub struct LastPick(Mutex<Option<PathBuf>>);

impl LastPick {
    /// The file to read: the remembered one when `reuse` is set and one exists, else the
    /// one `pick` returns, which becomes the remembered one. `None` = picker cancelled
    /// (the previous pick is kept).
    pub async fn resolve<F, Fut>(&self, reuse: bool, pick: F) -> AppResult<Option<PathBuf>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = AppResult<Option<PathBuf>>>,
    {
        if reuse && let Some(path) = self.get() {
            return Ok(Some(path));
        }
        let picked = pick().await?;
        if let Some(path) = &picked {
            *self.lock() = Some(path.clone());
        }
        Ok(picked)
    }

    fn get(&self) -> Option<PathBuf> {
        self.lock().clone()
    }

    fn lock(&self) -> MutexGuard<'_, Option<PathBuf>> {
        // A plain assignment never panics half-way: a poisoned lock still holds a path.
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// A picker that counts its calls and returns `path`.
    fn picker<'a>(
        calls: &'a Cell<u32>,
        path: Option<&'a str>,
    ) -> impl FnOnce() -> std::future::Ready<AppResult<Option<PathBuf>>> + 'a {
        move || {
            calls.set(calls.get() + 1);
            std::future::ready(Ok(path.map(PathBuf::from)))
        }
    }

    #[tokio::test]
    async fn last_pick_reuses_the_remembered_file() {
        let last = LastPick::default();
        let calls = Cell::new(0);
        // Nothing remembered yet: the picker opens even when reuse is asked.
        let got = last
            .resolve(true, picker(&calls, Some("/a")))
            .await
            .unwrap();
        assert_eq!((got, calls.get()), (Some(PathBuf::from("/a")), 1));
        // Reuse: no picker.
        let got = last
            .resolve(true, picker(&calls, Some("/b")))
            .await
            .unwrap();
        assert_eq!((got, calls.get()), (Some(PathBuf::from("/a")), 1));
        // No reuse: the picker opens and its choice replaces the remembered one.
        let got = last
            .resolve(false, picker(&calls, Some("/b")))
            .await
            .unwrap();
        assert_eq!((got, calls.get()), (Some(PathBuf::from("/b")), 2));
        let got = last.resolve(true, picker(&calls, None)).await.unwrap();
        assert_eq!((got, calls.get()), (Some(PathBuf::from("/b")), 2));
    }

    #[tokio::test]
    async fn last_pick_keeps_the_file_when_the_picker_is_cancelled_or_fails() {
        let last = LastPick::default();
        let calls = Cell::new(0);
        assert_eq!(
            last.resolve(false, picker(&calls, None)).await.unwrap(),
            None
        );
        // A cancel remembers nothing.
        assert_eq!(
            last.resolve(true, picker(&calls, None)).await.unwrap(),
            None
        );
        assert_eq!(calls.get(), 2);
        last.resolve(false, picker(&calls, Some("/a")))
            .await
            .unwrap();
        assert_eq!(
            last.resolve(false, picker(&calls, None)).await.unwrap(),
            None
        );
        let failing = || std::future::ready(Err(AppError::new(ErrorKind::Io, "no dialog")));
        assert_eq!(
            last.resolve(false, failing).await.unwrap_err().kind,
            ErrorKind::Io
        );
        let got = last.resolve(true, picker(&calls, None)).await.unwrap();
        assert_eq!(got, Some(PathBuf::from("/a")));
    }

    fn entry(name: &str) -> ImportedConnection {
        let config: ConnectionConfig = serde_json::from_value(serde_json::json!({
            "id": "", "name": name, "color": "swatch-1", "envTag": "local", "kind": "sqlite",
            "host": "", "port": 0, "user": "", "database": null, "sqlitePath": "/x.db",
            "passwordMode": "keyring", "group": null,
        }))
        .unwrap();
        ImportedConnection {
            config,
            password: Some("pw".into()),
            ssh_secret: None,
        }
    }

    #[test]
    fn discard_drops_the_pending_import() {
        let pending = PendingImports::new(IMPORT_TTL);
        let kept = pending.insert(vec![entry("kept")]);
        let dropped = pending.insert(vec![entry("dropped")]);
        pending.discard(&dropped);
        pending.discard("unknown");
        let err = pending.take(&dropped, &[0]).unwrap_err();
        assert_eq!(
            (err.kind, err.message.as_str()),
            (ErrorKind::NotFound, "import expired")
        );
        assert_eq!(pending.take(&kept, &[0]).unwrap()[0].config.name, "kept");
    }
}

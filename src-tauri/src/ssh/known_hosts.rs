//! Host key verification against the system and app `known_hosts` files.
use std::path::{Path, PathBuf};

use russh::keys::{HashAlg, PublicKey};

use crate::error::{AppError, AppResult, ErrorKind};

#[derive(Debug, Clone, PartialEq)]
pub enum HostKeyVerdict {
    Known,
    Unknown { fingerprint: String },
    Changed { fingerprint: String },
    /// A known_hosts file could not be read or parsed, so the key cannot be
    /// checked. Fail closed: never offer to trust. Task 3 maps this to
    /// `ErrorKind::Connection` with the message
    /// "cannot verify the SSH host key: <reason>".
    Unverifiable { reason: String },
}

pub struct KnownHosts {
    /// `~/.ssh/known_hosts`, read only.
    pub system: Option<PathBuf>,
    /// `<app_data_dir>/known_hosts`, the only file ever written.
    pub app: PathBuf,
}

/// `SHA256:...` fingerprint, same format as `ssh-keygen -lf`.
pub fn fingerprint(key: &PublicKey) -> String {
    key.fingerprint(HashAlg::Sha256).to_string()
}

enum FileVerdict {
    Known,
    Unknown,
    Changed,
    Unverifiable(String),
}

fn check_file(path: &Path, host: &str, port: u16, key: &PublicKey) -> FileVerdict {
    match russh::keys::check_known_hosts_path(host, port, key, path) {
        Ok(true) => FileVerdict::Known,
        Ok(false) => FileVerdict::Unknown,
        Err(russh::keys::Error::KeyChanged { .. }) => FileVerdict::Changed,
        Err(russh::keys::Error::IO(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            FileVerdict::Unknown
        }
        Err(e) => FileVerdict::Unverifiable(format!("{}: {e}", path.display())),
    }
}

impl KnownHosts {
    pub fn verify(&self, host: &str, port: u16, key: &PublicKey) -> HostKeyVerdict {
        let verdicts: Vec<FileVerdict> = self
            .system
            .iter()
            .chain(std::iter::once(&self.app))
            .map(|p| check_file(p, host, port, key))
            .collect();
        let fingerprint = fingerprint(key);
        // Changed > Unverifiable > Known > Unknown.
        if verdicts.iter().any(|v| matches!(v, FileVerdict::Changed)) {
            return HostKeyVerdict::Changed { fingerprint };
        }
        let reasons: Vec<&str> = verdicts
            .iter()
            .filter_map(|v| match v {
                FileVerdict::Unverifiable(r) => Some(r.as_str()),
                _ => None,
            })
            .collect();
        if !reasons.is_empty() {
            return HostKeyVerdict::Unverifiable { reason: reasons.join("; ") };
        }
        if verdicts.iter().any(|v| matches!(v, FileVerdict::Known)) {
            HostKeyVerdict::Known
        } else {
            HostKeyVerdict::Unknown { fingerprint }
        }
    }

    /// Appends the key to the app file. Never touches the system file.
    pub fn trust(&self, host: &str, port: u16, key: &PublicKey) -> AppResult<()> {
        if let Some(parent) = self.app.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?;
        }
        russh::keys::known_hosts::learn_known_hosts_path(host, port, key, &self.app)
            .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::{Algorithm, PrivateKey};

    fn key() -> PublicKey {
        PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
            .unwrap()
            .public_key()
            .clone()
    }

    fn kh(dir: &Path) -> KnownHosts {
        KnownHosts { system: None, app: dir.join("app").join("known_hosts") }
    }

    #[test]
    fn unknown_then_trusted_then_known() {
        let dir = tempfile::tempdir().unwrap();
        let (kh, k) = (kh(dir.path()), key());
        match kh.verify("db.example", 22, &k) {
            HostKeyVerdict::Unknown { fingerprint } => assert!(fingerprint.starts_with("SHA256:")),
            other => panic!("expected Unknown, got {other:?}"),
        }
        kh.trust("db.example", 22, &k).unwrap();
        assert_eq!(kh.verify("db.example", 22, &k), HostKeyVerdict::Known);
    }

    #[test]
    fn changed_host_key_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let (kh, k1, k2) = (kh(dir.path()), key(), key());
        kh.trust("db.example", 22, &k1).unwrap();
        let before = std::fs::read_to_string(&kh.app).unwrap();
        assert_eq!(
            kh.verify("db.example", 22, &k2),
            HostKeyVerdict::Changed { fingerprint: fingerprint(&k2) }
        );
        assert_eq!(std::fs::read_to_string(&kh.app).unwrap(), before);
    }

    #[test]
    fn system_file_is_read_and_never_written() {
        let dir = tempfile::tempdir().unwrap();
        let sys = dir.path().join("sys_known_hosts");
        let k = key();
        russh::keys::known_hosts::learn_known_hosts_path("db.example", 22, &k, &sys).unwrap();
        let before = std::fs::read_to_string(&sys).unwrap();
        let kh = KnownHosts { system: Some(sys.clone()), ..kh(dir.path()) };
        assert_eq!(kh.verify("db.example", 22, &k), HostKeyVerdict::Known);
        let other = key();
        kh.trust("other.example", 22, &other).unwrap();
        assert_eq!(std::fs::read_to_string(&sys).unwrap(), before);
        assert!(std::fs::read_to_string(&kh.app).unwrap().contains("other.example"));
    }

    #[test]
    fn non_default_port_entries() {
        let dir = tempfile::tempdir().unwrap();
        let (kh, k) = (kh(dir.path()), key());
        kh.trust("db.example", 2222, &k).unwrap();
        assert_eq!(kh.verify("db.example", 2222, &k), HostKeyVerdict::Known);
        assert!(matches!(kh.verify("db.example", 22, &k), HostKeyVerdict::Unknown { .. }));
    }

    #[test]
    fn garbage_matching_line_is_unverifiable_even_if_app_knows_key() {
        let dir = tempfile::tempdir().unwrap();
        let k = key();
        let sys = dir.path().join("sys");
        std::fs::write(&sys, "db.example ssh-ed25519 !!!notbase64!!!\n").unwrap();
        let kh = KnownHosts { system: Some(sys.clone()), ..kh(dir.path()) };
        kh.trust("db.example", 22, &k).unwrap();
        match kh.verify("db.example", 22, &k) {
            HostKeyVerdict::Unverifiable { reason } => assert!(reason.contains("sys")),
            other => panic!("expected Unverifiable, got {other:?}"),
        }
    }

    #[test]
    fn missing_system_file_is_nothing_known() {
        let dir = tempfile::tempdir().unwrap();
        let k = key();
        let kh = KnownHosts { system: Some(dir.path().join("absent")), ..kh(dir.path()) };
        assert!(matches!(kh.verify("h", 22, &k), HostKeyVerdict::Unknown { .. }));
        kh.trust("h", 22, &k).unwrap();
        assert_eq!(kh.verify("h", 22, &k), HostKeyVerdict::Known);
    }

    #[test]
    fn changed_in_either_file_wins_over_known_in_the_other() {
        let dir = tempfile::tempdir().unwrap();
        let (k1, k2) = (key(), key());
        let sys = dir.path().join("sys");
        let kh = KnownHosts { system: Some(sys.clone()), ..kh(dir.path()) };
        // system has k1, app has k2; presented k2 -> system Changed, app Known
        russh::keys::known_hosts::learn_known_hosts_path("h", 22, &k1, &sys).unwrap();
        kh.trust("h", 22, &k2).unwrap();
        assert_eq!(kh.verify("h", 22, &k2), HostKeyVerdict::Changed { fingerprint: fingerprint(&k2) });
        // presented k1 -> system Known, app Changed
        assert_eq!(kh.verify("h", 22, &k1), HostKeyVerdict::Changed { fingerprint: fingerprint(&k1) });
    }
}

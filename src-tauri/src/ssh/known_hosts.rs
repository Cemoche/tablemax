//! Host key verification against the system and app `known_hosts` files.
use std::path::{Path, PathBuf};

use russh::keys::{Algorithm, HashAlg, PublicKey};

use crate::error::{AppError, AppResult, ErrorKind};

#[derive(Debug, Clone, PartialEq)]
pub enum HostKeyVerdict {
    Known,
    Unknown {
        fingerprint: String,
    },
    /// The host has recorded keys and none is the presented one (same algorithm or
    /// not): never trusted.
    Changed {
        fingerprint: String,
    },
    /// A known_hosts file could not be read or parsed, so the key cannot be
    /// checked. Fail closed: never offer to trust. Task 3 maps this to
    /// `ErrorKind::Connection` with the message
    /// "cannot verify the SSH host key: <reason>".
    Unverifiable {
        reason: String,
    },
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

/// The client's host key algorithms (russh defaults) with those of the keys recorded
/// for the host first, like OpenSSH: a server known by its ECDSA key is asked for
/// that key rather than its Ed25519 one, which would read as a changed key. An
/// `ssh-rsa` entry brings every RSA signature variant forward.
pub fn preferred_host_key_algorithms(recorded: &[Algorithm]) -> Vec<Algorithm> {
    let rsa = |a: &Algorithm| matches!(a, Algorithm::Rsa { .. });
    let is_recorded = |a: &Algorithm| recorded.iter().any(|r| r == a || (rsa(r) && rsa(a)));
    let (first, rest): (Vec<Algorithm>, Vec<Algorithm>) = russh::Preferred::DEFAULT
        .key
        .iter()
        .cloned()
        .partition(is_recorded);
    first.into_iter().chain(rest).collect()
}

enum FileVerdict {
    Known,
    Unknown,
    Changed,
    Unverifiable(String),
}

/// The keys `path` records for `host:port` (none when the file does not exist). The
/// file is opened first: russh reads a file it cannot open (e.g. permission denied) as
/// empty, which would turn a known host into a first contact.
fn recorded_keys(path: &Path, host: &str, port: u16) -> Result<Vec<PublicKey>, String> {
    let reason = |e: &dyn std::fmt::Display| format!("{}: {e}", path.display());
    match std::fs::File::open(path) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(reason(&e)),
    }
    match russh::keys::known_hosts::known_host_keys_path(host, port, path) {
        Ok(keys) => Ok(keys.into_iter().map(|(_, k)| k).collect()),
        Err(e) => Err(reason(&e)),
    }
}

/// russh's `check_known_hosts_path` only reports a changed key of the same algorithm
/// and reads a recorded key of another algorithm as unknown: compare with every
/// recorded key of the host instead.
fn check_file(path: &Path, host: &str, port: u16, key: &PublicKey) -> FileVerdict {
    match recorded_keys(path, host, port) {
        Err(reason) => FileVerdict::Unverifiable(reason),
        Ok(keys) if keys.is_empty() => FileVerdict::Unknown,
        Ok(keys) if keys.iter().any(|k| k.key_data() == key.key_data()) => FileVerdict::Known,
        Ok(_) => FileVerdict::Changed,
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
            return HostKeyVerdict::Unverifiable {
                reason: reasons.join("; "),
            };
        }
        if verdicts.iter().any(|v| matches!(v, FileVerdict::Known)) {
            HostKeyVerdict::Known
        } else {
            HostKeyVerdict::Unknown { fingerprint }
        }
    }

    /// Algorithms of the keys recorded for `host:port` in both files, in file order,
    /// without duplicates. Unreadable files are skipped (`verify` reports them).
    pub fn host_key_algorithms(&self, host: &str, port: u16) -> Vec<Algorithm> {
        let mut out: Vec<Algorithm> = Vec::new();
        let files = self.system.iter().chain(std::iter::once(&self.app));
        for key in files.flat_map(|p| recorded_keys(p, host, port).unwrap_or_default()) {
            let alg = key.algorithm();
            if !out.contains(&alg) {
                out.push(alg);
            }
        }
        out
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
        KnownHosts {
            system: None,
            app: dir.join("app").join("known_hosts"),
        }
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
            HostKeyVerdict::Changed {
                fingerprint: fingerprint(&k2)
            }
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
        let kh = KnownHosts {
            system: Some(sys.clone()),
            ..kh(dir.path())
        };
        assert_eq!(kh.verify("db.example", 22, &k), HostKeyVerdict::Known);
        let other = key();
        kh.trust("other.example", 22, &other).unwrap();
        assert_eq!(std::fs::read_to_string(&sys).unwrap(), before);
        assert!(
            std::fs::read_to_string(&kh.app)
                .unwrap()
                .contains("other.example")
        );
    }

    #[test]
    fn non_default_port_entries() {
        let dir = tempfile::tempdir().unwrap();
        let (kh, k) = (kh(dir.path()), key());
        kh.trust("db.example", 2222, &k).unwrap();
        assert_eq!(kh.verify("db.example", 2222, &k), HostKeyVerdict::Known);
        assert!(matches!(
            kh.verify("db.example", 22, &k),
            HostKeyVerdict::Unknown { .. }
        ));
    }

    #[test]
    fn garbage_matching_line_is_unverifiable_even_if_app_knows_key() {
        let dir = tempfile::tempdir().unwrap();
        let k = key();
        let sys = dir.path().join("sys");
        std::fs::write(&sys, "db.example ssh-ed25519 !!!notbase64!!!\n").unwrap();
        let kh = KnownHosts {
            system: Some(sys.clone()),
            ..kh(dir.path())
        };
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
        let kh = KnownHosts {
            system: Some(dir.path().join("absent")),
            ..kh(dir.path())
        };
        assert!(matches!(
            kh.verify("h", 22, &k),
            HostKeyVerdict::Unknown { .. }
        ));
        kh.trust("h", 22, &k).unwrap();
        assert_eq!(kh.verify("h", 22, &k), HostKeyVerdict::Known);
    }

    /// A fixed RSA public key (generating one is slow in debug builds).
    const RSA_PUB: &str = "AAAAB3NzaC1yc2EAAAADAQABAAABAQDXkbuvYN3N6Sx24+wNWKlKIMFDAMvbnZ2lJckza6l9AZWH8UxTznFEOdlyalb+9mh5hkV9B3hKfJnchBcezO9PGTNyBqJEem1kQPQSF+nlU6f2zMFFD1VQ/JCtHoLifzDhu/J/a9CT8OVnsvfBP3NQtkNh5WSgo14o0B8Q/tiu4itnsEEaJ58k4Pvb/vXkdX68Ec/LH/6625KwY/2wEAW4KaxqtEIfbyW70xGmSAFvWOi3Ec/NhBuX7x//ejyD6b9SyCALEaYk9Fvrdg6EfEFflJ5QXSZQ3P62qCZuq/6Ryu3UoJ1FSR90saBo93nDI4lnjT8oUp1LxuU5UpnjY8AV";

    fn rsa_key() -> PublicKey {
        russh::keys::parse_public_key_base64(RSA_PUB).unwrap()
    }

    fn ecdsa_key() -> PublicKey {
        let alg = Algorithm::Ecdsa {
            curve: russh::keys::EcdsaCurve::NistP256,
        };
        PrivateKey::random(&mut rand::rng(), alg)
            .unwrap()
            .public_key()
            .clone()
    }

    #[test]
    fn key_of_another_algorithm_than_the_recorded_one_is_changed() {
        let dir = tempfile::tempdir().unwrap();
        let (kh, recorded) = (kh(dir.path()), key());
        kh.trust("db.example", 22, &recorded).unwrap();
        let before = std::fs::read_to_string(&kh.app).unwrap();
        let presented = rsa_key();
        assert_eq!(
            kh.verify("db.example", 22, &presented),
            HostKeyVerdict::Changed {
                fingerprint: fingerprint(&presented)
            }
        );
        assert_eq!(std::fs::read_to_string(&kh.app).unwrap(), before);
        // Same in the system file.
        let sys = dir.path().join("sys");
        std::fs::write(&sys, format!("db.example ssh-rsa {RSA_PUB}\n")).unwrap();
        let kh = KnownHosts {
            system: Some(sys),
            app: dir.path().join("none"),
        };
        let ed = key();
        assert_eq!(
            kh.verify("db.example", 22, &ed),
            HostKeyVerdict::Changed {
                fingerprint: fingerprint(&ed)
            }
        );
    }

    #[test]
    fn any_recorded_key_of_the_host_matches() {
        let dir = tempfile::tempdir().unwrap();
        let (kh, ed, ec) = (kh(dir.path()), key(), ecdsa_key());
        kh.trust("db.example", 22, &ed).unwrap();
        kh.trust("db.example", 22, &ec).unwrap();
        assert_eq!(kh.verify("db.example", 22, &ec), HostKeyVerdict::Known);
        assert_eq!(kh.verify("db.example", 22, &ed), HostKeyVerdict::Known);
        // Another host's keys say nothing about this one.
        assert!(matches!(
            kh.verify("other.example", 22, &ec),
            HostKeyVerdict::Unknown { .. }
        ));
    }

    #[test]
    fn recorded_algorithms_of_both_files() {
        let dir = tempfile::tempdir().unwrap();
        let sys = dir.path().join("sys");
        std::fs::write(&sys, format!("db.example ssh-rsa {RSA_PUB}\n")).unwrap();
        let kh = KnownHosts {
            system: Some(sys),
            ..kh(dir.path())
        };
        kh.trust("db.example", 22, &ecdsa_key()).unwrap();
        kh.trust("other.example", 22, &key()).unwrap();
        assert_eq!(
            kh.host_key_algorithms("db.example", 22),
            vec![
                Algorithm::Rsa { hash: None },
                Algorithm::Ecdsa {
                    curve: russh::keys::EcdsaCurve::NistP256
                }
            ]
        );
        assert!(kh.host_key_algorithms("nowhere.example", 22).is_empty());
    }

    #[test]
    fn preferred_algorithms_put_the_recorded_ones_first() {
        let default: Vec<Algorithm> = russh::Preferred::DEFAULT.key.to_vec();
        assert_eq!(preferred_host_key_algorithms(&[]), default);
        let p256 = Algorithm::Ecdsa {
            curve: russh::keys::EcdsaCurve::NistP256,
        };
        let prefs = preferred_host_key_algorithms(std::slice::from_ref(&p256));
        assert_eq!(prefs[0], p256);
        assert_eq!(prefs[1], Algorithm::Ed25519);
        assert_eq!(prefs.len(), default.len());
        // An ssh-rsa entry prefers every RSA signature variant, strongest first.
        let prefs = preferred_host_key_algorithms(&[Algorithm::Rsa { hash: None }]);
        assert_eq!(
            prefs[..3],
            [
                Algorithm::Rsa {
                    hash: Some(HashAlg::Sha512)
                },
                Algorithm::Rsa {
                    hash: Some(HashAlg::Sha256)
                },
                Algorithm::Rsa { hash: None },
            ]
        );
        assert_eq!(prefs[3], Algorithm::Ed25519);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_file_is_unverifiable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let (kh, k) = (kh(dir.path()), key());
        kh.trust("db.example", 22, &k).unwrap();
        std::fs::set_permissions(&kh.app, std::fs::Permissions::from_mode(0o000)).unwrap();
        if std::fs::File::open(&kh.app).is_ok() {
            eprintln!("skipped: running as root, chmod 000 does not deny reads");
            return;
        }
        let verdict = kh.verify("db.example", 22, &k);
        std::fs::set_permissions(&kh.app, std::fs::Permissions::from_mode(0o600)).unwrap();
        match verdict {
            HostKeyVerdict::Unverifiable { reason } => {
                assert!(reason.contains("known_hosts"), "{reason}")
            }
            other => panic!("expected Unverifiable, got {other:?}"),
        }
    }

    #[test]
    fn changed_in_either_file_wins_over_known_in_the_other() {
        let dir = tempfile::tempdir().unwrap();
        let (k1, k2) = (key(), key());
        let sys = dir.path().join("sys");
        let kh = KnownHosts {
            system: Some(sys.clone()),
            ..kh(dir.path())
        };
        // system has k1, app has k2; presented k2 -> system Changed, app Known
        russh::keys::known_hosts::learn_known_hosts_path("h", 22, &k1, &sys).unwrap();
        kh.trust("h", 22, &k2).unwrap();
        assert_eq!(
            kh.verify("h", 22, &k2),
            HostKeyVerdict::Changed {
                fingerprint: fingerprint(&k2)
            }
        );
        // presented k1 -> system Known, app Changed
        assert_eq!(
            kh.verify("h", 22, &k1),
            HostKeyVerdict::Changed {
                fingerprint: fingerprint(&k1)
            }
        );
    }
}

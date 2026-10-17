//! SSH target resolution: the form's SSH settings merged with `~/.ssh/config` (host
//! alias, port, user, identity files) into the target a tunnel connects to.

use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult, ErrorKind};
use crate::ssh::config::SshConfigFile;
use crate::ssh::tunnel::{SshAuthMaterial, SshTarget};
use crate::store::{SshAuth, SshSettings};

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.filter(|s| !s.trim().is_empty())
}

/// The user's home directory (`HOME`, else `USERPROFILE`).
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// The SSH target for `ssh`: `config.resolve(host)`, overridden by the form's port and
/// user. Key auth uses the form's key file, else the first existing `IdentityFile`,
/// else the first existing `~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa` (like OpenSSH).
pub fn resolve_ssh_target(
    ssh: &SshSettings,
    config: &SshConfigFile,
    home: Option<&Path>,
    secret: Option<String>,
) -> AppResult<SshTarget> {
    if ssh.host.trim().is_empty() {
        return Err(AppError::new(ErrorKind::Invalid, "ssh host required"));
    }
    let resolved = config.resolve(&ssh.host);
    let user = non_empty(ssh.user.as_deref())
        .or(non_empty(resolved.user.as_deref()))
        .ok_or_else(|| AppError::new(ErrorKind::Invalid, "ssh user required"))?
        .to_string();
    let auth = match ssh.auth {
        SshAuth::Agent => SshAuthMaterial::Agent,
        SshAuth::Password => {
            SshAuthMaterial::Password(secret.ok_or_else(|| ssh.secret_required())?)
        }
        SshAuth::Key => {
            let path = match non_empty(ssh.key_file.as_deref()) {
                Some(path) => PathBuf::from(path),
                None => {
                    let defaults = home.into_iter().flat_map(|h| {
                        ["id_ed25519", "id_ecdsa", "id_rsa"].map(|n| h.join(".ssh").join(n))
                    });
                    resolved
                        .identity_files
                        .iter()
                        .cloned()
                        .chain(defaults)
                        .find(|p| p.is_file())
                        .ok_or_else(|| AppError::new(ErrorKind::Invalid, "ssh key file required"))?
                }
            };
            SshAuthMaterial::Key {
                path,
                passphrase: secret,
            }
        }
    };
    Ok(SshTarget {
        host: resolved.host_name,
        port: ssh.port.unwrap_or(resolved.port),
        user,
        auth,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::PasswordMode;

    fn ssh(auth: SshAuth) -> SshSettings {
        SshSettings {
            host: "bastion".into(),
            port: None,
            user: None,
            auth,
            key_file: None,
            secret_mode: PasswordMode::Keyring,
        }
    }

    fn touch(path: &std::path::Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "key").unwrap();
    }

    #[test]
    fn ssh_target_form_fields_win_over_the_config() {
        let home = tempfile::tempdir().unwrap();
        let config = SshConfigFile::parse(
            "Host bastion\n  HostName bastion.example.com\n  Port 2200\n  User cfg-user\n",
            home.path(),
        );
        let mut s = ssh(SshAuth::Password);
        let t = resolve_ssh_target(&s, &config, Some(home.path()), Some("pw".into())).unwrap();
        assert_eq!(
            (t.host.as_str(), t.port, t.user.as_str()),
            ("bastion.example.com", 2200, "cfg-user")
        );
        assert!(matches!(t.auth, SshAuthMaterial::Password(ref p) if p == "pw"));
        s.port = Some(22);
        s.user = Some("form-user".into());
        let t = resolve_ssh_target(&s, &config, Some(home.path()), Some("pw".into())).unwrap();
        assert_eq!((t.port, t.user.as_str()), (22, "form-user"));
        // An empty user field counts as absent.
        s.user = Some(String::new());
        let t = resolve_ssh_target(&s, &config, Some(home.path()), Some("pw".into())).unwrap();
        assert_eq!(t.user, "cfg-user");
    }

    #[test]
    fn ssh_target_without_user_or_password_is_refused() {
        let home = tempfile::tempdir().unwrap();
        let config = SshConfigFile::default();
        let e =
            resolve_ssh_target(&ssh(SshAuth::Agent), &config, Some(home.path()), None).unwrap_err();
        assert_eq!(
            (e.kind, e.message.as_str()),
            (ErrorKind::Invalid, "ssh user required")
        );
        let mut s = ssh(SshAuth::Password);
        s.user = Some("u".into());
        let e = resolve_ssh_target(&s, &config, Some(home.path()), None).unwrap_err();
        assert_eq!(
            (e.kind, e.message.as_str()),
            (ErrorKind::Auth, "ssh password required")
        );
        s.auth = SshAuth::Agent;
        let t = resolve_ssh_target(&s, &config, Some(home.path()), Some("x".into())).unwrap();
        assert!(matches!(t.auth, SshAuthMaterial::Agent));
        assert_eq!((t.host.as_str(), t.port), ("bastion", 22));
    }

    #[test]
    fn ssh_key_file_resolution_order() {
        let home = tempfile::tempdir().unwrap();
        let h = home.path();
        let key_of = |s: &SshSettings, config: &SshConfigFile| match resolve_ssh_target(
            s,
            config,
            Some(h),
            Some("pp".into()),
        ) {
            Ok(t) => match t.auth {
                SshAuthMaterial::Key { path, passphrase } => {
                    assert_eq!(passphrase.as_deref(), Some("pp"));
                    Ok(path)
                }
                other => panic!("{other:?}"),
            },
            Err(e) => Err(e),
        };
        let mut s = ssh(SshAuth::Key);
        s.user = Some("u".into());
        let empty = SshConfigFile::default();
        let e = key_of(&s, &empty).unwrap_err();
        assert_eq!(
            (e.kind, e.message.as_str()),
            (ErrorKind::Invalid, "ssh key file required")
        );

        // OpenSSH defaults, in order: id_ed25519, id_ecdsa, id_rsa.
        touch(&h.join(".ssh/id_rsa"));
        assert_eq!(key_of(&s, &empty).unwrap(), h.join(".ssh/id_rsa"));
        touch(&h.join(".ssh/id_ecdsa"));
        assert_eq!(key_of(&s, &empty).unwrap(), h.join(".ssh/id_ecdsa"));
        touch(&h.join(".ssh/id_ed25519"));
        assert_eq!(key_of(&s, &empty).unwrap(), h.join(".ssh/id_ed25519"));

        // The first existing IdentityFile beats the defaults.
        touch(&h.join("keys/second"));
        let config = SshConfigFile::parse(
            "Host bastion\n  IdentityFile ~/keys/first\n  IdentityFile ~/keys/second\n",
            h,
        );
        assert_eq!(key_of(&s, &config).unwrap(), h.join("keys/second"));

        // The form's key file beats everything, even when it does not exist (the
        // tunnel then reports it as unreadable).
        s.key_file = Some("/elsewhere/key".into());
        assert_eq!(
            key_of(&s, &config).unwrap(),
            PathBuf::from("/elsewhere/key")
        );
    }
}

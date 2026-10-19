//! TablePlus export import, against real exports made by TablePlus Linux
//! (`tests/fixtures/tableplus/README.md`: password, contents).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tablemax_lib::driver::DriverKind;
use tablemax_lib::driver::tls::SslMode;
use tablemax_lib::error::{AppError, AppResult, ErrorKind};
use tablemax_lib::import::rncryptor;
use tablemax_lib::import::tableplus::{ImportWarning, ImportedConnection, parse_export};
use tablemax_lib::manager::SessionManager;
use tablemax_lib::secrets::{MemorySecretStore, SecretKey, SecretKind, SecretStore};
use tablemax_lib::ssh::known_hosts::KnownHosts;
use tablemax_lib::store::{ConnectionStore, PasswordMode, SshAuth};

const PASSWORD: &str = "fixture-pass";
const SECRETS: [&str; 3] = ["demo-pass", "ssh-demo-pass", "key-demo-pass"];
const KEY_WARNING: &str =
    "SSH key file not included in the export: choose it in the connection settings";

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/tableplus")
        .join(format!("{name}.tableplusconnection"))
}

fn load(name: &str) -> (Vec<ImportedConnection>, Vec<ImportWarning>) {
    let data = std::fs::read(fixture(name)).unwrap();
    let plain = rncryptor::decrypt(&data, PASSWORD).unwrap();
    parse_export(&plain).unwrap()
}

/// name, kind, host, port, user, database, sqlite path, group, DB password, SSH secret.
type Row = (
    String,
    DriverKind,
    String,
    u16,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn rows(conns: &[ImportedConnection]) -> Vec<Row> {
    conns
        .iter()
        .map(|c| {
            let k = &c.config;
            (
                k.name.clone(),
                k.kind,
                k.host.clone(),
                k.port,
                k.user.clone(),
                k.database.clone(),
                k.sqlite_path.clone(),
                k.group.clone(),
                c.password.clone(),
                c.ssh_secret.clone(),
            )
        })
        .collect()
}

fn s(v: &str) -> Option<String> {
    Some(v.to_string())
}

fn sqlite_row(name: &str, path: &str, group: Option<&str>) -> Row {
    (
        name.into(),
        DriverKind::Sqlite,
        String::new(),
        0,
        String::new(),
        None,
        s(path),
        group.map(Into::into),
        None,
        None,
    )
}

fn server_row(
    name: &str,
    kind: DriverKind,
    port: u16,
    group: Option<&str>,
    password: bool,
    ssh_secret: Option<&str>,
) -> Row {
    (
        name.into(),
        kind,
        "127.0.0.1".into(),
        port,
        "demo".into(),
        s("shop"),
        None,
        group.map(Into::into),
        password.then(|| "demo-pass".into()),
        ssh_secret.map(Into::into),
    )
}

/// The rows of "Export all", with or without the passwords.
fn all_rows(pw: bool) -> Vec<Row> {
    let ssh = |secret: &'static str| pw.then_some(secret);
    vec![
        sqlite_row(
            "fixture-nested-sqlite",
            "/home/demo/nested.sqlite3",
            Some("Fixture Group / Nested Group"),
        ),
        server_row(
            "fixture-grouped-mysql",
            DriverKind::MySql,
            3306,
            Some("Fixture Group"),
            pw,
            None,
        ),
        server_row("fixture-mysql", DriverKind::MySql, 3306, None, pw, None),
        server_row("fixture-mariadb", DriverKind::MariaDb, 3307, None, pw, None),
        server_row(
            "fixture-postgres",
            DriverKind::Postgres,
            5432,
            None,
            pw,
            None,
        ),
        sqlite_row("fixture-sqlite", "/home/demo/shop.sqlite3", None),
        server_row(
            "fixture-ssh-password",
            DriverKind::Postgres,
            5432,
            None,
            pw,
            ssh("ssh-demo-pass"),
        ),
        server_row(
            "fixture-ssh-key",
            DriverKind::MySql,
            3306,
            None,
            pw,
            ssh("key-demo-pass"),
        ),
        server_row("fixture-ssl", DriverKind::Postgres, 5432, None, pw, None),
    ]
}

fn key_warning(entry: &str) -> ImportWarning {
    ImportWarning {
        entry: entry.into(),
        message: KEY_WARNING.into(),
    }
}

#[test]
fn parses_every_fixture() {
    let (conns, warnings) = load("all-with-passwords");
    assert_eq!(rows(&conns), all_rows(true));
    assert_eq!(warnings, [key_warning("fixture-ssh-key")]);

    // Without the passwords, the SSH password connection cannot be told apart from key
    // auth (no `ServerPassword`): it is imported as key auth, with the key warning.
    let (conns, warnings) = load("all-without-passwords");
    assert_eq!(rows(&conns), all_rows(false));
    assert_eq!(
        warnings,
        [
            key_warning("fixture-ssh-password"),
            key_warning("fixture-ssh-key")
        ]
    );

    let (conns, warnings) = load("group");
    assert_eq!(rows(&conns), all_rows(true)[..2]);
    assert!(warnings.is_empty());

    let (conns, warnings) = load("single-grouped");
    assert_eq!(
        rows(&conns),
        [server_row(
            "fixture-grouped-mysql",
            DriverKind::MySql,
            3306,
            None,
            true,
            None
        )]
    );
    assert!(warnings.is_empty());

    let (conns, warnings) = load("single-ssh-key");
    assert_eq!(
        rows(&conns),
        [server_row(
            "fixture-ssh-key",
            DriverKind::MySql,
            3306,
            None,
            true,
            Some("key-demo-pass")
        )]
    );
    assert_eq!(warnings, [key_warning("fixture-ssh-key")]);

    for name in [
        "all-with-passwords",
        "all-without-passwords",
        "group",
        "single-grouped",
        "single-ssh-key",
    ] {
        for c in load(name).0 {
            let k = &c.config;
            assert!(k.id.is_empty(), "{name}: {k:?}");
            assert_eq!(k.color, "swatch-1");
            let mode = match (k.kind, c.password.is_some()) {
                (DriverKind::Sqlite, _) => PasswordMode::None,
                (_, true) => PasswordMode::Keyring,
                (_, false) => PasswordMode::Ask,
            };
            assert_eq!(k.password_mode, mode, "{name}: {}", k.name);
        }
    }
}

#[test]
fn wrong_export_password_is_rejected() {
    let data = std::fs::read(fixture("single-grouped")).unwrap();
    let err = rncryptor::decrypt(&data, "fixture-pass2").unwrap_err();
    assert_eq!(err.kind, ErrorKind::Invalid);
    assert_eq!(err.message, "wrong password or corrupted file");
}

#[test]
fn ssh_and_ssl_fields_are_mapped() {
    let (conns, _) = load("all-with-passwords");
    let by_name = |n: &str| conns.iter().find(|c| c.config.name == n).unwrap();

    let pw = by_name("fixture-ssh-password");
    let ssh = pw.config.ssh.as_ref().unwrap();
    assert_eq!(ssh.host, "bastion.example.test");
    assert_eq!(ssh.port, Some(22));
    assert_eq!(ssh.user.as_deref(), Some("sshdemo"));
    assert_eq!(ssh.auth, SshAuth::Password);
    assert_eq!(ssh.key_file, None);
    assert_eq!(ssh.secret_mode, PasswordMode::Keyring);
    assert_eq!(pw.config.ssl.mode, SslMode::Prefer);

    let key = by_name("fixture-ssh-key");
    let ssh = key.config.ssh.as_ref().unwrap();
    assert_eq!(ssh.host, "bastion.example.test");
    assert_eq!(ssh.port, Some(2222));
    assert_eq!(ssh.user.as_deref(), Some("sshdemo"));
    assert_eq!(ssh.auth, SshAuth::Key);
    assert_eq!(ssh.key_file, None);
    assert_eq!(ssh.secret_mode, PasswordMode::Keyring);

    // SSL settings are not exported: the default for the host applies, no files.
    let ssl = &by_name("fixture-ssl").config;
    assert!(ssl.ssh.is_none());
    assert_eq!(ssl.ssl.mode, SslMode::Prefer);
    assert_eq!(
        (&ssl.ssl.ca_file, &ssl.ssl.cert_file, &ssl.ssl.key_file),
        (&None, &None, &None)
    );

    let (conns, _) = load("all-without-passwords");
    for c in conns.iter().filter_map(|c| c.config.ssh.as_ref()) {
        assert_eq!((c.auth, c.secret_mode), (SshAuth::Key, PasswordMode::None));
    }
}

#[test]
fn unsupported_driver_is_skipped_with_warning() {
    let json = r#"[{"ConnectionName":"cache","Driver":"Redis","DatabaseHost":"127.0.0.1",
                    "DatabasePort":"6379","DatabasePassword":"redis-pass"},
                   {"ConnectionName":"pg","Driver":"PostgreSQL","DatabaseHost":"127.0.0.1",
                    "DatabasePort":"5432","DatabaseUser":"demo"}]"#;
    let (conns, warnings) = parse_export(json.as_bytes()).unwrap();
    assert_eq!(conns.len(), 1);
    assert_eq!(conns[0].config.name, "pg");
    assert_eq!(conns[0].config.kind, DriverKind::Postgres);
    assert_eq!(
        warnings,
        [ImportWarning {
            entry: "cache".into(),
            message: "unsupported driver Redis".into()
        }]
    );
}

struct Fx {
    dir: tempfile::TempDir,
    secrets: Arc<dyn SecretStore>,
    mgr: SessionManager,
}

fn manager_with(secrets: Arc<dyn SecretStore>, ttl: Option<Duration>) -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let store = ConnectionStore::open(&dir.path().join("app.db")).unwrap();
    let known_hosts = KnownHosts {
        system: None,
        app: dir.path().join("known_hosts"),
    };
    let mut mgr = SessionManager::new(Arc::new(store), secrets.clone(), known_hosts);
    if let Some(ttl) = ttl {
        mgr = mgr.with_import_ttl(ttl);
    }
    Fx { dir, secrets, mgr }
}

fn memory_manager() -> Fx {
    manager_with(Arc::new(MemorySecretStore::new()), None)
}

fn assert_no_secret(text: &str) {
    for secret in SECRETS {
        assert!(!text.contains(secret), "{secret} leaked in {text}");
    }
}

#[tokio::test]
async fn preview_never_contains_secrets() {
    let fx = memory_manager();
    for name in ["all-with-passwords", "single-ssh-key", "group"] {
        let preview = fx
            .mgr
            .import_tableplus_preview(fixture(name), PASSWORD.into())
            .await
            .unwrap();
        let json = serde_json::to_string(&preview).unwrap();
        assert_no_secret(&json);
        assert_no_secret(&format!("{preview:?}"));
        assert!(json.contains("\"hasPassword\":true"), "{json}");
        assert!(json.contains("\"importId\""), "{json}");
    }
    assert_no_secret(&format!("{:?}", load("all-with-passwords").0));
}

#[tokio::test]
async fn preview_flags_and_indexes() {
    let fx = memory_manager();
    let preview = fx
        .mgr
        .import_tableplus_preview(fixture("all-with-passwords"), PASSWORD.into())
        .await
        .unwrap();
    assert!(!preview.import_id.is_empty());
    assert_eq!(preview.warnings, [key_warning("fixture-ssh-key")]);
    let got: Vec<_> = preview
        .items
        .iter()
        .map(|i| {
            (
                i.index,
                i.config.name.as_str(),
                i.has_password,
                i.has_ssh_secret,
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            (0, "fixture-nested-sqlite", false, false),
            (1, "fixture-grouped-mysql", true, false),
            (2, "fixture-mysql", true, false),
            (3, "fixture-mariadb", true, false),
            (4, "fixture-postgres", true, false),
            (5, "fixture-sqlite", false, false),
            (6, "fixture-ssh-password", true, true),
            (7, "fixture-ssh-key", true, true),
            (8, "fixture-ssl", true, false),
        ]
    );
    assert!(preview.items.iter().all(|i| i.duplicate_of.is_none()));
    assert!(preview.items.iter().all(|i| i.config.id.is_empty()));
}

#[tokio::test]
async fn preview_errors() {
    let fx = memory_manager();
    let err = fx
        .mgr
        .import_tableplus_preview(fixture("group"), "nope".into())
        .await
        .unwrap_err();
    assert_eq!(
        (err.kind, err.message.as_str()),
        (ErrorKind::Invalid, "wrong password or corrupted file")
    );

    let big = fx.dir.path().join("big.tableplusconnection");
    let f = std::fs::File::create(&big).unwrap();
    f.set_len(10 * 1024 * 1024 + 1).unwrap();
    let err = fx
        .mgr
        .import_tableplus_preview(big, PASSWORD.into())
        .await
        .unwrap_err();
    assert_eq!(
        (err.kind, err.message.as_str()),
        (ErrorKind::Invalid, "file too large")
    );

    let err = fx
        .mgr
        .import_tableplus_preview(fx.dir.path().join("missing"), PASSWORD.into())
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Io);
}

fn secret(store: &dyn SecretStore, id: &str, kind: SecretKind) -> Option<String> {
    store.get(&SecretKey::new(id, kind)).unwrap()
}

fn all_indexes() -> Vec<usize> {
    (0..9).collect()
}

#[tokio::test]
async fn commit_stores_secrets_in_keyring_and_flags_duplicates() {
    let fx = memory_manager();
    let preview = fx
        .mgr
        .import_tableplus_preview(fixture("all-with-passwords"), PASSWORD.into())
        .await
        .unwrap();
    let result = fx
        .mgr
        .import_tableplus_commit(&preview.import_id, &all_indexes())
        .await
        .unwrap();
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
    assert_eq!(result.saved.len(), 9);
    assert!(result.saved.iter().all(|c| !c.id.is_empty()));
    let listed = fx.mgr.list_connections().await.unwrap();
    assert_eq!(listed.len(), 9);

    let sec = fx.secrets.as_ref();
    for c in &result.saved {
        let db = secret(sec, &c.id, SecretKind::DbPassword);
        let ssh_pw = secret(sec, &c.id, SecretKind::SshPassword);
        let pass = secret(sec, &c.id, SecretKind::SshPassphrase);
        let want = match c.name.as_str() {
            "fixture-nested-sqlite" | "fixture-sqlite" => (None, None, None),
            "fixture-ssh-password" => (s("demo-pass"), s("ssh-demo-pass"), None),
            "fixture-ssh-key" => (s("demo-pass"), None, s("key-demo-pass")),
            _ => (s("demo-pass"), None, None),
        };
        assert_eq!((db, ssh_pw, pass), want, "{}", c.name);
    }
    let ssh_pw = result
        .saved
        .iter()
        .find(|c| c.name == "fixture-ssh-password")
        .unwrap();
    assert_eq!(ssh_pw.password_mode, PasswordMode::Keyring);
    assert_eq!(
        ssh_pw.ssh.as_ref().unwrap().secret_mode,
        PasswordMode::Keyring
    );

    // The pending import is gone after its commit.
    let err = fx
        .mgr
        .import_tableplus_commit(&preview.import_id, &all_indexes())
        .await
        .unwrap_err();
    assert_eq!(
        (err.kind, err.message.as_str()),
        (ErrorKind::NotFound, "import expired")
    );

    // Same file again: every entry points at the connection saved from it.
    let again = fx
        .mgr
        .import_tableplus_preview(fixture("all-with-passwords"), PASSWORD.into())
        .await
        .unwrap();
    for item in &again.items {
        let saved = result
            .saved
            .iter()
            .find(|c| c.name == item.config.name)
            .unwrap();
        assert_eq!(item.duplicate_of.as_deref(), Some(saved.id.as_str()));
    }

    // Nothing secret on disk.
    drop(fx.mgr);
    for entry in std::fs::read_dir(fx.dir.path()).unwrap() {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        for secret in SECRETS {
            let needle = secret.as_bytes();
            assert!(
                !bytes.windows(needle.len()).any(|w| w == needle),
                "{secret} on disk"
            );
        }
    }
}

#[tokio::test]
async fn duplicate_by_name_or_identity() {
    let fx = memory_manager();
    let first = fx
        .mgr
        .import_tableplus_preview(fixture("single-grouped"), PASSWORD.into())
        .await
        .unwrap();
    let mut renamed = first.items[0].config.clone();
    renamed.name = "renamed".into();
    let by_identity = fx.mgr.save_connection(renamed, None, None).await.unwrap();
    let mut other = first.items[0].config.clone();
    other.host = "10.0.0.9".into();
    other.name = "fixture-ssh-key".into();
    let by_name = fx.mgr.save_connection(other, None, None).await.unwrap();

    let preview = fx
        .mgr
        .import_tableplus_preview(fixture("single-grouped"), PASSWORD.into())
        .await
        .unwrap();
    assert_eq!(
        preview.items[0].duplicate_of.as_deref(),
        Some(by_identity.id.as_str())
    );
    let preview = fx
        .mgr
        .import_tableplus_preview(fixture("single-ssh-key"), PASSWORD.into())
        .await
        .unwrap();
    assert_eq!(
        preview.items[0].duplicate_of.as_deref(),
        Some(by_name.id.as_str())
    );
}

#[tokio::test]
async fn commit_saves_only_the_chosen_entries() {
    let fx = memory_manager();
    let preview = fx
        .mgr
        .import_tableplus_preview(fixture("all-with-passwords"), PASSWORD.into())
        .await
        .unwrap();
    // An unknown index rejects the commit and keeps the import.
    let err = fx
        .mgr
        .import_tableplus_commit(&preview.import_id, &[1, 9])
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::Invalid);
    assert!(fx.mgr.list_connections().await.unwrap().is_empty());

    let result = fx
        .mgr
        .import_tableplus_commit(&preview.import_id, &[7, 2, 7])
        .await
        .unwrap();
    let names: Vec<_> = result.saved.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["fixture-ssh-key", "fixture-mysql"]);
    assert_eq!(fx.mgr.list_connections().await.unwrap().len(), 2);
}

#[tokio::test]
async fn pending_import_expires() {
    let fx = manager_with(Arc::new(MemorySecretStore::new()), Some(Duration::ZERO));
    let preview = fx
        .mgr
        .import_tableplus_preview(fixture("group"), PASSWORD.into())
        .await
        .unwrap();
    let err = fx
        .mgr
        .import_tableplus_commit(&preview.import_id, &[0, 1])
        .await
        .unwrap_err();
    assert_eq!(
        (err.kind, err.message.as_str()),
        (ErrorKind::NotFound, "import expired")
    );
    let err = fx
        .mgr
        .import_tableplus_commit("not-an-import", &[])
        .await
        .unwrap_err();
    assert_eq!(err.kind, ErrorKind::NotFound);
    assert!(fx.mgr.list_connections().await.unwrap().is_empty());
}

#[tokio::test]
async fn retry_rereads_the_picked_file_without_the_picker() {
    let fx = memory_manager();
    let picks = Mutex::new(0);
    let pick = || async {
        *picks.lock().unwrap() += 1;
        Ok(Some(fixture("group")))
    };
    let err = fx
        .mgr
        .import_tableplus_preview_picked("nope".into(), false, pick)
        .await
        .unwrap_err();
    assert_eq!(err.message, "wrong password or corrupted file");
    let preview = fx
        .mgr
        .import_tableplus_preview_picked(PASSWORD.into(), true, || async {
            panic!("the picker must not reopen on a retry")
        })
        .await
        .unwrap()
        .expect("the remembered file is read");
    assert_eq!(preview.items.len(), 2);
    assert_eq!(*picks.lock().unwrap(), 1);

    let cancelled = fx
        .mgr
        .import_tableplus_preview_picked(PASSWORD.into(), false, || async { Ok(None) })
        .await
        .unwrap();
    assert!(cancelled.is_none());
}

#[tokio::test]
async fn discard_drops_the_pending_import() {
    let fx = memory_manager();
    let preview = fx
        .mgr
        .import_tableplus_preview(fixture("group"), PASSWORD.into())
        .await
        .unwrap();
    fx.mgr.import_tableplus_discard(&preview.import_id);
    fx.mgr.import_tableplus_discard("not-an-import");
    let err = fx
        .mgr
        .import_tableplus_commit(&preview.import_id, &[0])
        .await
        .unwrap_err();
    assert_eq!(
        (err.kind, err.message.as_str()),
        (ErrorKind::NotFound, "import expired")
    );
    assert!(fx.mgr.list_connections().await.unwrap().is_empty());
}

/// A keyring that is unavailable: every call fails.
struct NoKeyring;

impl SecretStore for NoKeyring {
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

/// A keyring that reports itself available but refuses to store the SSH secrets.
#[derive(Default)]
struct RefusesSsh(Mutex<HashMap<String, String>>);

impl SecretStore for RefusesSsh {
    fn available(&self) -> bool {
        true
    }
    fn set(&self, k: &SecretKey, v: &str) -> AppResult<()> {
        if k.kind != SecretKind::DbPassword {
            return Err(AppError::new(
                ErrorKind::Secret,
                "keyring set failed: locked",
            ));
        }
        self.0.lock().unwrap().insert(k.username(), v.into());
        Ok(())
    }
    fn get(&self, k: &SecretKey) -> AppResult<Option<String>> {
        Ok(self.0.lock().unwrap().get(&k.username()).cloned())
    }
    fn delete(&self, k: &SecretKey) -> AppResult<()> {
        self.0.lock().unwrap().remove(&k.username());
        Ok(())
    }
}

const ASK_WARNING: &str =
    "keyring unavailable: secrets not saved, you will be asked for them when connecting";

#[tokio::test]
async fn unavailable_keyring_saves_in_ask_mode_with_warning() {
    let fx = manager_with(Arc::new(NoKeyring), None);
    let preview = fx
        .mgr
        .import_tableplus_preview(fixture("all-with-passwords"), PASSWORD.into())
        .await
        .unwrap();
    let result = fx
        .mgr
        .import_tableplus_commit(&preview.import_id, &all_indexes())
        .await
        .unwrap();
    assert_eq!(result.saved.len(), 9);
    for c in &result.saved {
        let want = if c.kind == DriverKind::Sqlite {
            PasswordMode::None
        } else {
            PasswordMode::Ask
        };
        assert_eq!(c.password_mode, want, "{}", c.name);
        if let Some(ssh) = &c.ssh {
            assert_eq!(ssh.secret_mode, PasswordMode::Ask, "{}", c.name);
        }
    }
    let warned: Vec<_> = result.warnings.iter().map(|w| w.entry.as_str()).collect();
    assert_eq!(
        warned,
        [
            "fixture-grouped-mysql",
            "fixture-mysql",
            "fixture-mariadb",
            "fixture-postgres",
            "fixture-ssh-password",
            "fixture-ssh-key",
            "fixture-ssl",
        ]
    );
    assert!(result.warnings.iter().all(|w| w.message == ASK_WARNING));
    assert_eq!(fx.mgr.list_connections().await.unwrap().len(), 9);
}

#[tokio::test]
async fn failing_keyring_set_falls_back_to_ask_mode() {
    let store = Arc::new(RefusesSsh::default());
    let fx = manager_with(store.clone(), None);
    let preview = fx
        .mgr
        .import_tableplus_preview(fixture("all-with-passwords"), PASSWORD.into())
        .await
        .unwrap();
    let result = fx
        .mgr
        .import_tableplus_commit(&preview.import_id, &[2, 6])
        .await
        .unwrap();
    let [mysql, tunnelled] = &result.saved[..] else {
        panic!("{:?}", result.saved)
    };
    assert_eq!(mysql.password_mode, PasswordMode::Keyring);
    assert_eq!(
        secret(store.as_ref(), &mysql.id, SecretKind::DbPassword).as_deref(),
        Some("demo-pass")
    );
    assert_eq!(tunnelled.name, "fixture-ssh-password");
    assert_eq!(tunnelled.password_mode, PasswordMode::Ask);
    assert_eq!(
        tunnelled.ssh.as_ref().unwrap().secret_mode,
        PasswordMode::Ask
    );
    // The DB password stored before the SSH secret failed was cleaned up: only the
    // MySQL password is left.
    let left: Vec<_> = store.0.lock().unwrap().keys().cloned().collect();
    assert_eq!(left, [format!("{}:db_password", mysql.id)]);
    assert_eq!(
        result.warnings,
        [ImportWarning {
            entry: "fixture-ssh-password".into(),
            message: ASK_WARNING.into()
        }]
    );
    assert_eq!(fx.mgr.list_connections().await.unwrap().len(), 2);
}

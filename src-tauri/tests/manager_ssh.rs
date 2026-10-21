//! SessionManager over SSH tunnels, against the test sshd (`TABLEMAX_TEST_SSH`), which
//! reaches the databases as `pg16:5432`, `mysql8:3306` and `mariadb11:3306`. Those
//! names only resolve on the sshd side, so a connection that works went through the
//! tunnel. Every test uses its own app `known_hosts` in a tempdir and no system file.
mod common;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{CountingSecrets, mysql_urls, params_from_url, pg_urls, ssh_addr, ssh_file};
use tablemax_lib::driver::DriverKind;
use tablemax_lib::driver::tls::SslConfig;
use tablemax_lib::error::{AppResult, ErrorKind};
use tablemax_lib::manager::{ExecEvent, SessionManager, WorkspaceInfo};
use tablemax_lib::secrets::{MemorySecretStore, SecretKey, SecretKind, SecretStore};
use tablemax_lib::ssh::config::SshConfigFile;
use tablemax_lib::ssh::known_hosts::KnownHosts;
use tablemax_lib::store::{
    ConnectionConfig, ConnectionStore, EnvTag, PasswordMode, SshAuth, SshSettings,
};
use tempfile::TempDir;
use tokio::sync::mpsc;

const SSH_USER: &str = "tunnel";
const SSH_PASSWORD: &str = "tunnel-pass";
const WAIT: Duration = Duration::from_secs(15);

struct Fx {
    dir: TempDir,
    secrets: Arc<MemorySecretStore>,
    mgr: Arc<SessionManager>,
}

impl Fx {
    fn known_hosts_path(&self) -> std::path::PathBuf {
        self.dir.path().join("known_hosts")
    }
}

/// A manager with an empty `~/.ssh/config` (or `ssh_config`), a tempdir app
/// `known_hosts` and no system `known_hosts`.
fn fixture_with(ssh_config: SshConfigFile) -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let store = ConnectionStore::open(&dir.path().join("app.db")).unwrap();
    let secrets = Arc::new(MemorySecretStore::new());
    let known_hosts = KnownHosts {
        system: None,
        app: dir.path().join("known_hosts"),
    };
    let mgr = SessionManager::new(Arc::new(store), secrets.clone(), known_hosts)
        .with_ssh_config(ssh_config);
    Fx {
        dir,
        secrets,
        mgr: Arc::new(mgr),
    }
}

fn fixture() -> Fx {
    fixture_with(SshConfigFile::default())
}

fn ssh_settings(auth: SshAuth, secret_mode: PasswordMode) -> SshSettings {
    let (host, port) = ssh_addr();
    SshSettings {
        host,
        port: Some(port),
        user: Some(SSH_USER.into()),
        auth,
        key_file: None,
        secret_mode,
    }
}

/// PostgreSQL 16 as seen from the sshd (`pg16:5432`), DB password in the keyring.
fn pg_over_ssh(ssh: SshSettings) -> (ConnectionConfig, Option<String>) {
    let p = params_from_url(&pg_urls()[0], DriverKind::Postgres);
    let cfg = ConnectionConfig {
        id: String::new(),
        name: "pg via ssh".into(),
        color: "#888".into(),
        env_tag: EnvTag::Local,
        kind: DriverKind::Postgres,
        host: "pg16".into(),
        port: 5432,
        user: p.user,
        database: p.database,
        sqlite_path: None,
        password_mode: PasswordMode::Keyring,
        group: None,
        ssl: SslConfig::default(),
        ssh: Some(ssh),
        safe_mode: None,
        mongo: None,
    };
    (cfg, p.password)
}

/// Opens the workspace, confirming the host key like the UI does: a first attempt
/// without fingerprint must fail with `HostKeyUnknown`, the second confirms it.
async fn open_confirming(
    fx: &Fx,
    id: &str,
    password: Option<&str>,
    ssh_secret: Option<&str>,
) -> WorkspaceInfo {
    let pw = || password.map(String::from);
    let secret = || ssh_secret.map(String::from);
    let e = fx
        .mgr
        .open_workspace(id, pw(), secret(), None)
        .await
        .expect_err("an unknown host key must not connect");
    assert_eq!(e.kind, ErrorKind::HostKeyUnknown, "{}", e.message);
    fx.mgr
        .open_workspace(id, pw(), secret(), Some(e.message))
        .await
        .unwrap()
}

fn read(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// Runs a 30 s sleep on the SQL session and cancels it: the batch must end cancelled.
async fn assert_sleep_is_cancelled(mgr: &Arc<SessionManager>, sid: &str, sleep_sql: &str) {
    let events: Arc<Mutex<Vec<String>>> = Arc::default();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let sink = {
        let events = events.clone();
        move |e: ExecEvent| {
            let s = match &e {
                ExecEvent::StatementStarted { index } => format!("started{index}"),
                ExecEvent::StatementFinished { index, .. } => format!("finished{index}"),
                ExecEvent::StatementFailed { index, error } => {
                    format!("failed{index}:{:?}", error.kind)
                }
                ExecEvent::BatchFinished { cancelled } => format!("batch:{cancelled}"),
            };
            events.lock().unwrap().push(s.clone());
            let _ = tx.send(s);
        }
    };
    let (m, s, q) = (mgr.clone(), sid.to_string(), sleep_sql.to_string());
    let batch = tokio::spawn(async move {
        m.execute_batch(&s, vec![q, "select 2".into()], false, sink)
            .await
    });
    tokio::time::timeout(WAIT, async {
        while let Some(s) = rx.recv().await {
            if s == "started0" {
                return;
            }
        }
    })
    .await
    .expect("statement never started");
    // Let the statement reach the server before cancelling.
    tokio::time::sleep(Duration::from_millis(300)).await;
    tokio::time::timeout(WAIT, mgr.cancel(sid))
        .await
        .expect("cancel timed out")
        .unwrap();
    tokio::time::timeout(WAIT, batch)
        .await
        .expect("batch did not stop")
        .unwrap()
        .unwrap();
    assert_eq!(
        *events.lock().unwrap(),
        ["started0", "failed0:Cancelled", "batch:true"]
    );
}

async fn assert_select_one(mgr: &SessionManager, sid: &str) -> AppResult<()> {
    let events: Arc<Mutex<Vec<String>>> = Arc::default();
    let sink = {
        let events = events.clone();
        move |e: ExecEvent| {
            if let ExecEvent::StatementFailed { error, .. } = &e {
                events
                    .lock()
                    .unwrap()
                    .push(format!("failed:{}", error.message));
            }
        }
    };
    mgr.execute_batch(sid, vec!["select 1".into()], false, sink)
        .await?;
    assert!(
        events.lock().unwrap().is_empty(),
        "{:?}",
        events.lock().unwrap()
    );
    Ok(())
}

#[tokio::test]
async fn open_workspace_over_ssh_asks_for_unknown_host_key() {
    let fx = fixture();
    let (cfg, pw) = pg_over_ssh(ssh_settings(SshAuth::Password, PasswordMode::Keyring));
    let saved = fx
        .mgr
        .save_connection(cfg, pw, Some(SSH_PASSWORD.into()))
        .await
        .unwrap();

    let e = fx
        .mgr
        .open_workspace(&saved.id, None, None, None)
        .await
        .unwrap_err();
    assert_eq!(e.kind, ErrorKind::HostKeyUnknown, "{}", e.message);
    assert!(e.message.starts_with("SHA256:"), "{}", e.message);
    assert_eq!(read(&fx.known_hosts_path()), None, "nothing trusted yet");

    let ws = fx
        .mgr
        .open_workspace(&saved.id, None, None, Some(e.message))
        .await
        .unwrap();
    let schemas = fx
        .mgr
        .browse(&ws.workspace_id)
        .await
        .unwrap()
        .list_schemas()
        .await
        .unwrap();
    assert!(schemas.iter().any(|s| s == "public"), "{schemas:?}");
    let (ssh_host, ssh_port) = ssh_addr();
    let trusted = read(&fx.known_hosts_path()).expect("host key trusted in the app file");
    assert!(
        trusted.contains(&format!("[{ssh_host}]:{ssh_port}")),
        "{trusted}"
    );
    fx.mgr.close_workspace(&ws.workspace_id).await.unwrap();

    // Trusted now: no confirmation needed.
    let ws = fx
        .mgr
        .open_workspace(&saved.id, None, None, None)
        .await
        .unwrap();
    fx.mgr.close_workspace(&ws.workspace_id).await.unwrap();
}

#[tokio::test]
async fn sql_sessions_and_cancel_use_the_tunnel() {
    let fx = fixture();
    let (cfg, pw) = pg_over_ssh(ssh_settings(SshAuth::Password, PasswordMode::Keyring));
    let saved = fx
        .mgr
        .save_connection(cfg, pw, Some(SSH_PASSWORD.into()))
        .await
        .unwrap();
    let ws = open_confirming(&fx, &saved.id, None, None).await;
    let sid = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
    assert_sleep_is_cancelled(&fx.mgr, &sid, "select pg_sleep(30)").await;
    // The session stays usable after the cancel.
    assert_select_one(&fx.mgr, &sid).await.unwrap();
    let tunnel = fx.mgr.workspace_tunnel(&ws.workspace_id).await.unwrap();
    fx.mgr.close_workspace(&ws.workspace_id).await.unwrap();
    assert!(
        !tunnel.is_alive(),
        "closing the workspace closes its tunnel"
    );
}

/// Through SSH the tunnel counts the workspace's bytes (#112): the database protocol's
/// bytes, browse connection and SQL sessions alike, never the SSH keepalives.
#[tokio::test]
async fn throughput_counts_the_tunnel_traffic() {
    let fx = fixture();
    let (cfg, pw) = pg_over_ssh(ssh_settings(SshAuth::Password, PasswordMode::Keyring));
    let saved = fx
        .mgr
        .save_connection(cfg, pw, Some(SSH_PASSWORD.into()))
        .await
        .unwrap();
    let ws = open_confirming(&fx, &saved.id, None, None).await;
    let id = ws.workspace_id.as_str();
    assert!(ws.capabilities.throughput);
    assert_eq!(fx.mgr.workspace_throughput(id).unwrap(), None);
    let tunnel = fx.mgr.workspace_tunnel(id).await.unwrap();
    let before = tunnel.traffic().totals();

    fx.mgr
        .browse(id)
        .await
        .unwrap()
        .execute("SELECT repeat('x', 300000)")
        .await
        .unwrap();
    let sid = fx.mgr.open_sql_session(id).await.unwrap();
    assert_select_one(&fx.mgr, &sid).await.unwrap();
    let after = tunnel.traffic().totals();
    assert!(after.read - before.read >= 300_000, "{before:?} {after:?}");
    assert!(after.written > before.written, "{before:?} {after:?}");

    tokio::time::sleep(Duration::from_millis(600)).await;
    let rate = fx.mgr.workspace_throughput(id).unwrap().expect("a rate");
    assert!(rate.read_per_sec >= 300_000 / 4, "{rate:?}");
    fx.mgr.close_workspace(id).await.unwrap();
}

#[tokio::test]
async fn mysql_and_mariadb_over_ssh_with_key_auth() {
    let fx = fixture();
    let urls = mysql_urls();
    for (url, kind, host) in [
        (&urls[0], DriverKind::MySql, "mysql8"),
        (&urls[1], DriverKind::MariaDb, "mariadb11"),
    ] {
        let p = params_from_url(url, kind);
        let mut ssh = ssh_settings(SshAuth::Key, PasswordMode::None);
        ssh.key_file = Some(ssh_file("id_ed25519").to_string_lossy().into_owned());
        let cfg = ConnectionConfig {
            id: String::new(),
            name: format!("{host} via ssh"),
            color: "#888".into(),
            env_tag: EnvTag::Local,
            kind,
            host: host.into(),
            port: 3306,
            user: p.user,
            database: p.database,
            sqlite_path: None,
            password_mode: PasswordMode::Keyring,
            group: None,
            ssl: SslConfig::default(),
            ssh: Some(ssh),
            safe_mode: None,
            mongo: None,
        };
        let saved = fx.mgr.save_connection(cfg, p.password, None).await.unwrap();
        // The app known_hosts is shared by both connections: confirm only once.
        let ws = match fx.mgr.open_workspace(&saved.id, None, None, None).await {
            Err(e) if e.kind == ErrorKind::HostKeyUnknown => fx
                .mgr
                .open_workspace(&saved.id, None, None, Some(e.message))
                .await
                .unwrap(),
            other => other.unwrap(),
        };
        let sid = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
        assert_sleep_is_cancelled(&fx.mgr, &sid, "select sleep(30)").await;
        assert_select_one(&fx.mgr, &sid).await.unwrap();
        fx.mgr.close_workspace(&ws.workspace_id).await.unwrap();
    }
}

#[tokio::test]
async fn ask_mode_ssh_secret_is_held_for_sql_sessions() {
    let fx = fixture();
    let (cfg, pw) = pg_over_ssh(ssh_settings(SshAuth::Password, PasswordMode::Ask));
    let saved = fx
        .mgr
        .save_connection(cfg, pw, Some(SSH_PASSWORD.into()))
        .await
        .unwrap();
    let key = SecretKey::new(saved.id.clone(), SecretKind::SshPassword);
    assert_eq!(
        fx.secrets.get(&key).unwrap(),
        None,
        "ask mode stores nothing"
    );

    // Without the secret: asked for before any network I/O.
    let e = fx
        .mgr
        .open_workspace(&saved.id, None, None, None)
        .await
        .unwrap_err();
    assert_eq!(e.kind, ErrorKind::Auth);
    assert_eq!(e.message, "ssh password required");

    let ws = open_confirming(&fx, &saved.id, None, Some(SSH_PASSWORD)).await;
    let a = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
    assert_select_one(&fx.mgr, &a).await.unwrap();
    // Even a new tunnel (the old one died) reuses the secret typed at opening.
    fx.mgr
        .workspace_tunnel(&ws.workspace_id)
        .await
        .unwrap()
        .close()
        .await;
    let b = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
    assert_select_one(&fx.mgr, &b).await.unwrap();
    fx.mgr.close_workspace(&ws.workspace_id).await.unwrap();
}

#[tokio::test]
async fn reopens_tunnel_after_it_dies() {
    let fx = fixture();
    let (cfg, pw) = pg_over_ssh(ssh_settings(SshAuth::Password, PasswordMode::Keyring));
    let saved = fx
        .mgr
        .save_connection(cfg, pw, Some(SSH_PASSWORD.into()))
        .await
        .unwrap();
    let ws = open_confirming(&fx, &saved.id, None, None).await;
    let old = fx.mgr.workspace_tunnel(&ws.workspace_id).await.unwrap();
    let browse = fx.mgr.browse(&ws.workspace_id).await.unwrap();
    old.close().await;
    assert!(!old.is_alive());

    // The connection that went through the dead tunnel is lost.
    let e = tokio::time::timeout(WAIT, browse.list_schemas())
        .await
        .expect("browse must fail, not hang")
        .unwrap_err();
    assert!(
        matches!(e.kind, ErrorKind::ConnectionLost | ErrorKind::Connection),
        "{:?} {}",
        e.kind,
        e.message
    );

    let sid = fx.mgr.open_sql_session(&ws.workspace_id).await.unwrap();
    assert_select_one(&fx.mgr, &sid).await.unwrap();
    let new = fx.mgr.workspace_tunnel(&ws.workspace_id).await.unwrap();
    assert!(new.is_alive());
    assert!(!Arc::ptr_eq(&old, &new), "a new tunnel was opened");
    assert_sleep_is_cancelled(&fx.mgr, &sid, "select pg_sleep(30)").await;
    fx.mgr.close_workspace(&ws.workspace_id).await.unwrap();
    assert!(!new.is_alive());
}

/// After the saved connection was moved to another SSH account (with its own stored
/// password), a workspace still on the old one must not read the keyring to reopen its
/// tunnel: that secret belongs to the new target.
#[tokio::test]
async fn reopened_tunnel_never_reads_the_keyring_after_ssh_retarget() {
    let dir = tempfile::tempdir().unwrap();
    let store = ConnectionStore::open(&dir.path().join("app.db")).unwrap();
    let secrets = Arc::new(CountingSecrets::default());
    let known_hosts = KnownHosts {
        system: None,
        app: dir.path().join("known_hosts"),
    };
    let mgr = Arc::new(
        SessionManager::new(Arc::new(store), secrets.clone(), known_hosts)
            .with_ssh_config(SshConfigFile::default()),
    );
    // `fx.secrets` is not the manager's keyring here: `secrets` (counting) is.
    let fx = Fx {
        dir,
        secrets: Arc::new(MemorySecretStore::new()),
        mgr,
    };
    let (cfg, pw) = pg_over_ssh(ssh_settings(SshAuth::Password, PasswordMode::Keyring));
    let saved = fx
        .mgr
        .save_connection(cfg, pw.clone(), Some(SSH_PASSWORD.into()))
        .await
        .unwrap();
    // DB password typed (held), SSH password from the keyring.
    let ws = open_confirming(&fx, &saved.id, pw.as_deref(), None).await;
    let id = ws.workspace_id.as_str();

    let mut moved = saved.clone();
    moved.ssh.as_mut().unwrap().user = Some("someone-else".into());
    fx.mgr
        .save_connection(moved, pw.clone(), Some("their-ssh-password".into()))
        .await
        .unwrap();
    fx.mgr.workspace_tunnel(id).await.unwrap().close().await;
    secrets.reset();
    for e in [
        fx.mgr.open_sql_session(id).await.unwrap_err(),
        fx.mgr.browse(id).await.err().unwrap(),
    ] {
        assert_eq!(
            (e.kind, e.message.as_str()),
            (ErrorKind::Auth, "ssh password required")
        );
    }
    assert_eq!(
        secrets.gets(),
        0,
        "the keyring must not be read for the old target"
    );
    fx.mgr.close_workspace(id).await.unwrap();
}

/// Browsing (schemas, objects, pages) recovers by itself: no need to reopen the
/// workspace. A browse and a SQL tab racing on a dead tunnel share one new tunnel.
#[tokio::test]
async fn browse_recovers_after_tunnel_dies() {
    let fx = fixture();
    let (cfg, pw) = pg_over_ssh(ssh_settings(SshAuth::Password, PasswordMode::Ask));
    let saved = fx.mgr.save_connection(cfg, pw, None).await.unwrap();
    let ws = open_confirming(&fx, &saved.id, None, Some(SSH_PASSWORD)).await;
    let id = ws.workspace_id.as_str();
    let before = fx.mgr.browse(id).await.unwrap();
    // Unchanged while the tunnel lives.
    assert!(Arc::ptr_eq(&before, &fx.mgr.browse(id).await.unwrap()));
    let old = fx.mgr.workspace_tunnel(id).await.unwrap();
    old.close().await;

    let (browse, sid) = tokio::join!(fx.mgr.browse(id), fx.mgr.open_sql_session(id));
    let (browse, sid) = (browse.unwrap(), sid.unwrap());
    assert!(!Arc::ptr_eq(&before, &browse), "browse was reconnected");
    let new = fx.mgr.workspace_tunnel(id).await.unwrap();
    assert!(new.is_alive() && !Arc::ptr_eq(&old, &new));
    // Both went through the same new tunnel: a second reopen would have closed the
    // first new tunnel and broken one of them.
    let schemas = tokio::time::timeout(WAIT, browse.list_schemas())
        .await
        .unwrap()
        .unwrap();
    assert!(schemas.iter().any(|s| s == "public"), "{schemas:?}");
    assert_select_one(&fx.mgr, &sid).await.unwrap();
    assert!(Arc::ptr_eq(
        &new,
        &fx.mgr.workspace_tunnel(id).await.unwrap()
    ));
    assert!(Arc::ptr_eq(&browse, &fx.mgr.browse(id).await.unwrap()));

    // A SQL tab that reopened the tunnel first also lets browsing recover.
    new.close().await;
    let sid2 = fx.mgr.open_sql_session(id).await.unwrap();
    let browse2 = fx.mgr.browse(id).await.unwrap();
    assert!(!Arc::ptr_eq(&browse, &browse2));
    browse2.list_schemas().await.unwrap();
    assert_select_one(&fx.mgr, &sid2).await.unwrap();
    fx.mgr.close_workspace(id).await.unwrap();
    assert_eq!(
        fx.mgr.browse(id).await.err().unwrap().kind,
        ErrorKind::NotFound
    );
}

#[tokio::test]
async fn ssh_user_from_config_alias() {
    let (ssh_host, ssh_port) = ssh_addr();
    let home = tempfile::tempdir().unwrap();
    let config = SshConfigFile::parse(
        &format!("Host tm-sshd\n  HostName {ssh_host}\n  Port {ssh_port}\n  User {SSH_USER}\n"),
        home.path(),
    );
    let fx = fixture_with(config);
    assert_eq!(fx.mgr.ssh_hosts().await.unwrap(), ["tm-sshd"]);

    let ssh = SshSettings {
        host: "tm-sshd".into(),
        port: None,
        user: None,
        auth: SshAuth::Password,
        key_file: None,
        secret_mode: PasswordMode::Keyring,
    };
    let (cfg, pw) = pg_over_ssh(ssh);
    let saved = fx
        .mgr
        .save_connection(cfg, pw, Some(SSH_PASSWORD.into()))
        .await
        .unwrap();
    let ws = open_confirming(&fx, &saved.id, None, None).await;
    let schemas = fx
        .mgr
        .browse(&ws.workspace_id)
        .await
        .unwrap()
        .list_schemas()
        .await
        .unwrap();
    assert!(schemas.iter().any(|s| s == "public"), "{schemas:?}");
    // The host key is recorded under the resolved name, not the alias.
    let trusted = read(&fx.known_hosts_path()).unwrap();
    assert!(
        trusted.contains(&format!("[{ssh_host}]:{ssh_port}")),
        "{trusted}"
    );
    fx.mgr.close_workspace(&ws.workspace_id).await.unwrap();
}

#[tokio::test]
async fn test_connection_over_ssh_for_unsaved_config() {
    let fx = fixture();
    let (cfg, pw) = pg_over_ssh(ssh_settings(SshAuth::Password, PasswordMode::Ask));
    let secret = || Some(SSH_PASSWORD.to_string());
    let e = fx
        .mgr
        .test_connection(&cfg, pw.clone(), secret(), None)
        .await
        .unwrap_err();
    assert_eq!(e.kind, ErrorKind::HostKeyUnknown, "{}", e.message);
    let version = fx
        .mgr
        .test_connection(&cfg, pw, secret(), Some(e.message))
        .await
        .unwrap();
    assert!(version.contains("16"), "{version}");
}

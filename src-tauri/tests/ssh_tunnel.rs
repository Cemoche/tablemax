//! SSH tunnel integration tests against the test sshd (`TABLEMAX_TEST_SSH`), which
//! reaches the databases as `pg16:5432`, `mysql8:3306` and `mariadb11:3306`.
//! Every test uses its own app `known_hosts` in a tempdir and no system file.
mod common;

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::{mysql_urls, params_from_url, pg_urls, ssh_addr, ssh_file, ssl};
use russh::keys::{Algorithm, PrivateKey};
use tablemax_lib::driver::tls::{SslConfig, SslMode};
use tablemax_lib::driver::{self, ConnectParams, DriverKind, Session};
use tablemax_lib::error::{AppResult, ErrorKind};
use tablemax_lib::ssh::known_hosts::KnownHosts;
use tablemax_lib::ssh::tunnel::{
    HostKeyPolicy, SshAuthMaterial, SshTarget, SshTunnel, open_tunnel,
};
use tablemax_lib::value::CellValue;
use tempfile::TempDir;

const SSH_USER: &str = "tunnel";
const SSH_PASSWORD: &str = "tunnel-pass";

fn target(auth: SshAuthMaterial) -> SshTarget {
    let (host, port) = ssh_addr();
    SshTarget {
        host,
        port,
        user: SSH_USER.into(),
        auth,
    }
}

fn password() -> SshAuthMaterial {
    SshAuthMaterial::Password(SSH_PASSWORD.into())
}

fn key(name: &str, passphrase: Option<&str>) -> SshAuthMaterial {
    SshAuthMaterial::Key {
        path: ssh_file(name),
        passphrase: passphrase.map(String::from),
    }
}

fn app_known_hosts(dir: &TempDir) -> std::path::PathBuf {
    dir.path().join("app").join("known_hosts")
}

fn policy(dir: &TempDir, accept: Option<String>) -> HostKeyPolicy {
    HostKeyPolicy {
        known_hosts: KnownHosts {
            system: None,
            app: app_known_hosts(dir),
        },
        accept_fingerprint: accept,
    }
}

fn read(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// The fingerprint the test sshd presents (asked with an empty known_hosts).
async fn server_fingerprint() -> String {
    let dir = tempfile::tempdir().unwrap();
    let e = open_tunnel(&target(password()), "pg16", 5432, &policy(&dir, None))
        .await
        .err()
        .expect("an unknown host must not connect");
    assert_eq!(e.kind, ErrorKind::HostKeyUnknown, "{}", e.message);
    e.message
}

/// Opens a tunnel with a fresh app known_hosts, confirming the host key like the UI:
/// first attempt without `accept_fingerprint`, second with the fingerprint it reported.
async fn open_trusted(
    auth: SshAuthMaterial,
    remote_host: &str,
    remote_port: u16,
) -> (TempDir, AppResult<Arc<SshTunnel>>) {
    let dir = tempfile::tempdir().unwrap();
    let t = target(auth);
    let res = match open_tunnel(&t, remote_host, remote_port, &policy(&dir, None)).await {
        Err(e) if e.kind == ErrorKind::HostKeyUnknown => {
            open_tunnel(&t, remote_host, remote_port, &policy(&dir, Some(e.message))).await
        }
        other => other,
    };
    (dir, res)
}

/// PostgreSQL params for `host:5432` as seen from sshd, dialled through the tunnel.
fn pg_via(tunnel: &SshTunnel, host: &str, ssl: SslConfig) -> ConnectParams {
    let mut p = params_from_url(&pg_urls()[0], DriverKind::Postgres);
    p.host = host.into();
    p.port = 5432;
    p.ssl = ssl;
    p.dial = Some(tunnel.local_addr());
    p
}

/// (url, kind, host as seen from sshd) for MySQL 8 then MariaDB 11.
fn mysql_targets() -> Vec<(String, DriverKind, &'static str)> {
    let urls = mysql_urls();
    vec![
        (urls[0].clone(), DriverKind::MySql, "mysql8"),
        (urls[1].clone(), DriverKind::MariaDb, "mariadb11"),
    ]
}

fn mysql_via(tunnel: &SshTunnel, url: &str, kind: DriverKind, host: &str) -> ConnectParams {
    let mut p = params_from_url(url, kind);
    p.host = host.into();
    p.port = 3306;
    p.ssl = ssl(SslMode::Disable, None);
    p.dial = Some(tunnel.local_addr());
    p
}

async fn assert_select_one(s: &Arc<dyn Session>) {
    let out = s.execute("select 1").await.unwrap();
    let rs = out.result.expect("select returns rows");
    assert_eq!(rs.rows, vec![vec![CellValue::Int(1)]]);
}

async fn assert_pg_reachable(tunnel: &SshTunnel) {
    let s = driver::connect(&pg_via(tunnel, "pg16", ssl(SslMode::Disable, None)))
        .await
        .unwrap();
    assert_select_one(&s).await;
    s.close().await.unwrap();
}

/// Runs `sql` (a 30 s sleep) and cancels it: must end as `Cancelled` within 4 s, and
/// the session must stay usable.
async fn assert_sleep_is_cancelled(s: &Arc<dyn Session>, sql: &'static str) {
    let canceller = s.canceller();
    let start = Instant::now();
    let s2 = s.clone();
    let task = tokio::spawn(async move { s2.execute(sql).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    let res = tokio::time::timeout(Duration::from_secs(3), async {
        let mut task = task;
        loop {
            canceller.cancel().await.unwrap();
            tokio::select! {
                r = &mut task => break r.unwrap(),
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
        }
    })
    .await
    .expect("cancel timed out");
    assert_eq!(res.err().unwrap().kind, ErrorKind::Cancelled);
    assert!(start.elapsed() < Duration::from_secs(4));
    assert_select_one(s).await;
}

#[tokio::test]
async fn unknown_host_key_requires_confirmation() {
    let dir = tempfile::tempdir().unwrap();
    let t = target(password());
    let e = open_tunnel(&t, "pg16", 5432, &policy(&dir, None))
        .await
        .err()
        .expect("an unknown host must not connect");
    assert_eq!(e.kind, ErrorKind::HostKeyUnknown, "{}", e.message);
    assert!(e.message.starts_with("SHA256:"), "{}", e.message);
    // The prompt names the server the key is checked and stored for.
    let (host, port) = ssh_addr();
    assert_eq!(e.host.as_deref(), Some(format!("{host}:{port}").as_str()));
    assert_eq!(read(&app_known_hosts(&dir)), None, "nothing is trusted yet");

    // A fingerprint that does not match the presented key trusts nothing.
    let wrong = open_tunnel(&t, "pg16", 5432, &policy(&dir, Some("SHA256:bogus".into())))
        .await
        .err()
        .unwrap();
    assert_eq!(wrong.kind, ErrorKind::HostKeyUnknown);
    assert_eq!(read(&app_known_hosts(&dir)), None);

    let tunnel = open_tunnel(&t, "pg16", 5432, &policy(&dir, Some(e.message.clone())))
        .await
        .unwrap();
    let kh = read(&app_known_hosts(&dir)).expect("key written to the app known_hosts");
    assert!(kh.contains(&format!("[{host}]:{port}")), "{kh}");
    assert_pg_reachable(&tunnel).await;
    tunnel.close().await;

    // Now known: no confirmation needed.
    let again = open_tunnel(&t, "pg16", 5432, &policy(&dir, None))
        .await
        .unwrap();
    again.close().await;
}

#[tokio::test]
async fn tunnel_refuses_changed_host_key() {
    let real = server_fingerprint().await;
    let dir = tempfile::tempdir().unwrap();
    let p = policy(&dir, Some(real.clone()));
    let other = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    let (host, port) = ssh_addr();
    p.known_hosts
        .trust(&host, port, other.public_key())
        .unwrap();
    let before = read(&app_known_hosts(&dir)).unwrap();

    // Refused even though the presented fingerprint is "accepted".
    let e = open_tunnel(&target(password()), "pg16", 5432, &p)
        .await
        .err()
        .expect("a changed host key must block the connection");
    assert_eq!(e.kind, ErrorKind::HostKeyChanged, "{}", e.message);
    assert_eq!(e.message, real);
    assert_eq!(e.host.as_deref(), Some(format!("{host}:{port}").as_str()));
    assert_eq!(read(&app_known_hosts(&dir)).unwrap(), before);
}

/// `[host]:port <type> <base64>` of the test sshd's host key `name` (test-secrets.sh).
fn sshd_host_key_line(name: &str) -> String {
    let (host, port) = ssh_addr();
    let public = std::fs::read_to_string(ssh_file(&format!("host/{name}.pub"))).unwrap();
    let mut parts = public.split_whitespace();
    let (kind, b64) = (parts.next().unwrap(), parts.next().unwrap());
    format!("[{host}]:{port} {kind} {b64}\n")
}

#[tokio::test]
async fn recorded_ecdsa_host_key_is_asked_for_and_known() {
    // The sshd also has an Ed25519 key, which it presents by default.
    let dir = tempfile::tempdir().unwrap();
    let path = app_known_hosts(&dir);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let line = sshd_host_key_line("ssh_host_ecdsa_key");
    assert!(line.contains("ecdsa-sha2-nistp256"), "{line}");
    std::fs::write(&path, &line).unwrap();
    let tunnel = open_tunnel(&target(password()), "pg16", 5432, &policy(&dir, None))
        .await
        .expect("the recorded ECDSA key must be negotiated and recognised");
    assert_pg_reachable(&tunnel).await;
    tunnel.close().await;
    assert_eq!(read(&path).unwrap(), line, "nothing new trusted");
}

#[tokio::test]
async fn recorded_key_of_another_algorithm_blocks() {
    let real = server_fingerprint().await;
    let dir = tempfile::tempdir().unwrap();
    let path = app_known_hosts(&dir);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    // An RSA key on record: the sshd has none, so it presents another type of key.
    let (host, port) = ssh_addr();
    let rsa = std::fs::read_to_string(ssh_file("id_rsa_pem.pub")).unwrap();
    let rsa = rsa.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
    let recorded = format!("[{host}]:{port} {rsa}\n");
    std::fs::write(&path, &recorded).unwrap();
    for accept in [None, Some(real.clone())] {
        let e = open_tunnel(&target(password()), "pg16", 5432, &policy(&dir, accept))
            .await
            .err()
            .expect("a key of another type than the recorded one must block");
        assert_eq!(e.kind, ErrorKind::HostKeyChanged, "{}", e.message);
        assert_eq!(e.message, real);
        assert_eq!(read(&path).unwrap(), recorded, "known_hosts untouched");
    }
}

#[tokio::test]
async fn unverifiable_known_hosts_blocks_without_trusting() {
    let real = server_fingerprint().await;
    let dir = tempfile::tempdir().unwrap();
    let path = app_known_hosts(&dir);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let garbage = "[127.0.0.1]:2222 ssh-ed25519 !!!notbase64!!!\n";
    std::fs::write(&path, garbage).unwrap();

    for accept in [None, Some(real)] {
        let e = open_tunnel(&target(password()), "pg16", 5432, &policy(&dir, accept))
            .await
            .err()
            .expect("an unreadable known_hosts entry must block the connection");
        assert_eq!(e.kind, ErrorKind::Connection, "{}", e.message);
        assert!(
            e.message.starts_with("cannot verify the SSH host key: "),
            "{}",
            e.message
        );
        assert_eq!(read(&path).unwrap(), garbage);
    }
}

#[tokio::test]
async fn password_auth_reaches_postgres() {
    let (_dir, tunnel) = open_trusted(password(), "pg16", 5432).await;
    let tunnel = tunnel.unwrap();
    assert!(tunnel.is_alive());
    assert!(tunnel.local_addr().ip().is_loopback());
    assert_pg_reachable(&tunnel).await;
    tunnel.close().await;
}

#[tokio::test]
async fn key_auth_reaches_mysql_and_mariadb() {
    for (url, kind, host) in mysql_targets() {
        let (_dir, tunnel) = open_trusted(key("id_ed25519", None), host, 3306).await;
        let tunnel = tunnel.unwrap();
        let s = driver::connect(&mysql_via(&tunnel, &url, kind, host))
            .await
            .unwrap();
        assert_select_one(&s).await;
        s.close().await.unwrap();
        tunnel.close().await;
    }
}

#[tokio::test]
async fn pem_rsa_key_auth() {
    let (_dir, tunnel) = open_trusted(key("id_rsa_pem", None), "pg16", 5432).await;
    let tunnel = tunnel.unwrap();
    assert_pg_reachable(&tunnel).await;
    tunnel.close().await;
}

#[tokio::test]
async fn ecdsa_key_auth() {
    let (_dir, tunnel) = open_trusted(key("id_ecdsa", None), "pg16", 5432).await;
    let tunnel = tunnel.unwrap();
    assert_pg_reachable(&tunnel).await;
    tunnel.close().await;
}

#[tokio::test]
async fn encrypted_legacy_pem_key_auth() {
    let pem = std::fs::read_to_string(ssh_file("id_rsa_pem_enc")).unwrap();
    assert!(
        pem.contains("Proc-Type: 4,ENCRYPTED") && pem.contains("DEK-Info: AES-128-CBC,"),
        "test key must be a legacy encrypted PEM"
    );
    for passphrase in [None, Some("wrong")] {
        let (_dir, res) = open_trusted(key("id_rsa_pem_enc", passphrase), "pg16", 5432).await;
        let e = res.err().expect("must ask for the passphrase");
        assert_eq!(e.kind, ErrorKind::Auth, "{passphrase:?}: {}", e.message);
        assert_eq!(e.message, "ssh passphrase required", "{passphrase:?}");
    }
    let (_dir, tunnel) = open_trusted(key("id_rsa_pem_enc", Some("key-pass")), "pg16", 5432).await;
    let tunnel = tunnel.unwrap();
    assert_pg_reachable(&tunnel).await;
    tunnel.close().await;
}

#[tokio::test]
async fn encrypted_key_without_passphrase_requires_it() {
    for passphrase in [None, Some("wrong")] {
        let (_dir, res) = open_trusted(key("id_ed25519_enc", passphrase), "pg16", 5432).await;
        let e = res.err().expect("must ask for the passphrase");
        assert_eq!(e.kind, ErrorKind::Auth, "{passphrase:?}: {}", e.message);
        assert_eq!(e.message, "ssh passphrase required", "{passphrase:?}");
    }
    let (_dir, tunnel) = open_trusted(key("id_ed25519_enc", Some("key-pass")), "pg16", 5432).await;
    let tunnel = tunnel.unwrap();
    assert_pg_reachable(&tunnel).await;
    tunnel.close().await;
}

#[tokio::test]
async fn wrong_password_fails_auth() {
    let (_dir, res) = open_trusted(SshAuthMaterial::Password("nope".into()), "pg16", 5432).await;
    let e = res.err().expect("wrong password must fail");
    assert_eq!(e.kind, ErrorKind::Auth, "{}", e.message);
    assert_eq!(e.message, "ssh authentication failed");
}

#[tokio::test]
async fn missing_password_is_required() {
    let (_dir, res) = open_trusted(SshAuthMaterial::Password(String::new()), "pg16", 5432).await;
    let e = res.err().expect("an empty password must be asked for");
    assert_eq!(e.kind, ErrorKind::Auth, "{}", e.message);
    assert_eq!(e.message, "ssh password required");
}

#[tokio::test]
async fn unauthorized_key_fails_auth() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("id_stranger");
    let stranger = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap();
    std::fs::write(
        &path,
        stranger
            .to_openssh(russh::keys::ssh_key::LineEnding::LF)
            .unwrap(),
    )
    .unwrap();
    let auth = SshAuthMaterial::Key {
        path,
        passphrase: None,
    };
    let (_kh, res) = open_trusted(auth, "pg16", 5432).await;
    let e = res
        .err()
        .expect("a key missing from authorized_keys must fail");
    assert_eq!(e.kind, ErrorKind::Auth, "{}", e.message);
    assert_eq!(e.message, "ssh authentication failed");
}

#[tokio::test]
async fn verify_full_through_tunnel_uses_real_host_name() {
    let (_dir, tunnel) = open_trusted(password(), "pg16", 5432).await;
    let tunnel = tunnel.unwrap();
    // `pg16` is in the certificate; TCP still goes to the tunnel's local end.
    let p = pg_via(&tunnel, "pg16", ssl(SslMode::VerifyFull, Some("ca.pem")));
    let s = driver::connect(&p).await.unwrap();
    assert_select_one(&s).await;
    s.close().await.unwrap();
    // The certificate has no IP:127.0.0.1 SAN: verifying the dial address must fail.
    let p = pg_via(
        &tunnel,
        "127.0.0.1",
        ssl(SslMode::VerifyFull, Some("ca.pem")),
    );
    let e = driver::connect(&p)
        .await
        .err()
        .expect("wrong name must fail");
    assert_eq!(e.kind, ErrorKind::Connection, "{}", e.message);
    assert!(e.message.contains("not valid for name"), "{}", e.message);
    tunnel.close().await;
}

#[tokio::test]
async fn mysql_verify_full_through_tunnel_uses_real_host_name() {
    for (url, kind, host) in mysql_targets() {
        let (_dir, tunnel) = open_trusted(password(), host, 3306).await;
        let tunnel = tunnel.unwrap();
        // `mysql8` / `mariadb11` are in the certificate; TCP goes to the tunnel's end.
        let mut p = mysql_via(&tunnel, &url, kind, host);
        p.ssl = ssl(SslMode::VerifyFull, Some("ca.pem"));
        let s = driver::connect(&p)
            .await
            .unwrap_or_else(|e| panic!("{host}: {}", e.message));
        assert_select_one(&s).await;
        s.close().await.unwrap();
        // No IP:127.0.0.1 SAN: verifying the dial address instead must fail.
        p.host = "127.0.0.1".into();
        let e = driver::connect(&p)
            .await
            .err()
            .unwrap_or_else(|| panic!("{host}: wrong name must fail"));
        assert_eq!(e.kind, ErrorKind::Connection, "{host}: {}", e.message);
        tunnel.close().await;
    }
}

#[tokio::test]
async fn cancel_through_tunnel() {
    let (_dir, tunnel) = open_trusted(password(), "pg16", 5432).await;
    let tunnel = tunnel.unwrap();
    let s = driver::connect(&pg_via(&tunnel, "pg16", ssl(SslMode::Disable, None)))
        .await
        .unwrap();
    assert_sleep_is_cancelled(&s, "select pg_sleep(30)").await;
    s.close().await.unwrap();
    tunnel.close().await;

    let (url, kind, host) = mysql_targets().remove(0);
    let (_dir, tunnel) = open_trusted(password(), host, 3306).await;
    let tunnel = tunnel.unwrap();
    let s = driver::connect(&mysql_via(&tunnel, &url, kind, host))
        .await
        .unwrap();
    assert_sleep_is_cancelled(&s, "select sleep(30)").await;
    s.close().await.unwrap();
    tunnel.close().await;
}

#[tokio::test]
async fn several_connections_share_one_tunnel() {
    let (_dir, tunnel) = open_trusted(password(), "pg16", 5432).await;
    let tunnel = tunnel.unwrap();
    let p = pg_via(&tunnel, "pg16", ssl(SslMode::Disable, None));
    let (a, b, c) = tokio::join!(
        driver::connect(&p),
        driver::connect(&p),
        driver::connect(&p)
    );
    let sessions = [a.unwrap(), b.unwrap(), c.unwrap()];
    // All three run a statement at the same time over the same SSH session.
    let pids = futures_util::future::join_all(sessions.iter().map(|s| async move {
        let out = s
            .execute("select pg_backend_pid()::int8, pg_sleep(0.3)::text")
            .await
            .unwrap();
        out.result.unwrap().rows[0][0].clone()
    }))
    .await;
    assert_ne!(pids[0], pids[1]);
    assert_ne!(pids[1], pids[2]);
    assert_ne!(pids[0], pids[2]);
    for s in &sessions {
        s.close().await.unwrap();
    }
    assert!(tunnel.is_alive());
    tunnel.close().await;
}

#[tokio::test]
async fn closed_tunnel_reports_dead() {
    let (_dir, tunnel) = open_trusted(password(), "pg16", 5432).await;
    let tunnel = tunnel.unwrap();
    let p = pg_via(&tunnel, "pg16", ssl(SslMode::Disable, None));
    assert!(tunnel.is_alive());
    tunnel.close().await;
    assert!(!tunnel.is_alive());
    let e = driver::connect(&p)
        .await
        .err()
        .expect("closed tunnel must refuse");
    assert_eq!(e.kind, ErrorKind::Connection, "{}", e.message);
}

#[tokio::test]
async fn dropped_tunnel_stops_listening() {
    let (_dir, tunnel) = open_trusted(password(), "pg16", 5432).await;
    let tunnel = tunnel.unwrap();
    let addr = tunnel.local_addr();
    assert!(tokio::net::TcpStream::connect(addr).await.is_ok());
    drop(tunnel);
    let deadline = Instant::now() + Duration::from_secs(2);
    while tokio::net::TcpStream::connect(addr).await.is_ok() {
        assert!(Instant::now() < deadline, "dropped tunnel still listens");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn unreachable_ssh_server_is_connection_error() {
    let dir = tempfile::tempdir().unwrap();
    let mut t = target(password());
    t.port = 1;
    let e = open_tunnel(&t, "pg16", 5432, &policy(&dir, None))
        .await
        .err()
        .expect("nothing listens on port 1");
    assert_eq!(e.kind, ErrorKind::Connection, "{}", e.message);
}

#[tokio::test]
async fn unreachable_forward_target_fails_db_not_tunnel() {
    let (_dir, tunnel) = open_trusted(password(), "no-such-host.invalid", 5432).await;
    let tunnel = tunnel.unwrap();
    let p = pg_via(&tunnel, "no-such-host.invalid", ssl(SslMode::Disable, None));
    let e = driver::connect(&p)
        .await
        .err()
        .expect("unreachable target must fail");
    assert_eq!(e.kind, ErrorKind::Connection, "{}", e.message);
    assert!(tunnel.is_alive(), "the tunnel survives a failed forward");
    tunnel.close().await;
}

/// Kills the throwaway ssh-agent when the test ends.
struct Agent(std::process::Child);

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Runs `agent_auth_child` in a child process of this test binary, with
/// `SSH_AUTH_SOCK` set (or removed) only in the child's environment, so parallel tests
/// never see a mutated process environment.
fn run_agent_child(sock: Option<&Path>, expect: &str) {
    let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
    cmd.args(["agent_auth_child", "--exact", "--ignored", "--nocapture"])
        .env("TABLEMAX_AGENT_EXPECT", expect);
    match sock {
        Some(s) => cmd.env("SSH_AUTH_SOCK", s),
        None => cmd.env_remove("SSH_AUTH_SOCK"),
    };
    let out = cmd.output().unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success() && stdout.contains("1 passed"),
        "agent child ({expect}) failed:\n{stdout}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn agent_auth_reaches_postgres() {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("agent.sock");
    let agent = std::process::Command::new("ssh-agent")
        .arg("-D")
        .arg("-a")
        .arg(&sock)
        .stdout(std::process::Stdio::null())
        .spawn()
        .expect("ssh-agent must be installed");
    let _agent = Agent(agent);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !sock.exists() {
        assert!(Instant::now() < deadline, "ssh-agent did not start");
        std::thread::sleep(Duration::from_millis(20));
    }
    let added = std::process::Command::new("ssh-add")
        .arg("-q")
        .arg(ssh_file("id_ed25519"))
        .env("SSH_AUTH_SOCK", &sock)
        .output()
        .unwrap();
    assert!(
        added.status.success(),
        "{}",
        String::from_utf8_lossy(&added.stderr)
    );

    run_agent_child(Some(&sock), "ok");
    run_agent_child(None, "absent");
}

#[tokio::test]
#[ignore = "run by agent_auth_reaches_postgres in a child process with its own SSH_AUTH_SOCK"]
async fn agent_auth_child() {
    let expect =
        std::env::var("TABLEMAX_AGENT_EXPECT").expect("run by agent_auth_reaches_postgres");
    let (_dir, res) = open_trusted(SshAuthMaterial::Agent, "pg16", 5432).await;
    match expect.as_str() {
        "ok" => {
            let tunnel = res.unwrap();
            assert_pg_reachable(&tunnel).await;
            tunnel.close().await;
        }
        "absent" => {
            let e = res.err().expect("no agent must fail");
            assert_eq!(e.kind, ErrorKind::Auth, "{}", e.message);
            assert_eq!(e.message, "ssh agent not available");
        }
        other => panic!("unexpected TABLEMAX_AGENT_EXPECT {other}"),
    }
}

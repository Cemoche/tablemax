//! SSH local-forward tunnel (russh): one SSH session per tunnel, a listener on
//! `127.0.0.1:0`, and one `direct-tcpip` channel per accepted connection, so every
//! database connection of a workspace (browsing, SQL tabs, cancel requests) shares it.
//!
//! The host key is checked against `KnownHosts` during the key exchange, before any
//! secret is sent: unknown keys are only trusted when the user confirmed the exact
//! fingerprint; a changed or unverifiable key always blocks the connection.
//!
//! Secrets (password, passphrase) never appear in `Debug` output or error messages.
use std::borrow::Cow;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::Disconnect;
use russh::client::{self, AuthResult, Handle};
use russh::keys::agent::AgentIdentity;
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::{JoinHandle, JoinSet};

use super::known_hosts::{HostKeyVerdict, KnownHosts, preferred_host_key_algorithms};
use crate::error::{AppError, AppResult, ErrorKind};

/// TCP connect + SSH key exchange must finish within this delay.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub enum SshAuthMaterial {
    Password(String),
    Key {
        path: PathBuf,
        passphrase: Option<String>,
    },
    /// The running agent (`SSH_AUTH_SOCK` on Unix, the OpenSSH pipe on Windows).
    Agent,
}

impl std::fmt::Debug for SshAuthMaterial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SshAuthMaterial::Password(_) => f.write_str("Password(<redacted>)"),
            SshAuthMaterial::Key { path, passphrase } => f
                .debug_struct("Key")
                .field("path", path)
                .field("passphrase", &passphrase.as_ref().map(|_| "<redacted>"))
                .finish(),
            SshAuthMaterial::Agent => f.write_str("Agent"),
        }
    }
}

#[derive(Debug, Clone)]
pub struct SshTarget {
    /// Resolved host name (after `~/.ssh/config`), also the `known_hosts` name.
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuthMaterial,
}

pub struct HostKeyPolicy {
    pub known_hosts: KnownHosts,
    /// Fingerprint the user confirmed after a `HostKeyUnknown` error. Only trusts an
    /// unknown key with exactly this fingerprint; never overrides a changed key.
    pub accept_fingerprint: Option<String>,
}

fn auth_err(message: &str) -> AppError {
    AppError::new(ErrorKind::Auth, message)
}

fn ssh_err(target: &SshTarget, e: impl std::fmt::Display) -> AppError {
    AppError::new(
        ErrorKind::Connection,
        format!("ssh {}:{}: {e}", target.host, target.port),
    )
}

/// Checks the server key during the key exchange and keeps the reason of a refusal,
/// which russh would otherwise report as a generic `UnknownKey`.
struct TunnelHandler {
    host: String,
    port: u16,
    known_hosts: KnownHosts,
    accept_fingerprint: Option<String>,
    refusal: Arc<Mutex<Option<AppError>>>,
}

/// `host:port` as the host-key prompt shows it (`[v6]:port` for an IPv6 address).
fn host_label(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

impl TunnelHandler {
    fn decide(&self, server: &PublicKeyOrCertificate) -> Result<(), AppError> {
        let label = || host_label(&self.host, self.port);
        // For a host certificate only the underlying key is pinned (no CA trust).
        let key = server.public_key();
        match self.known_hosts.verify(&self.host, self.port, &key) {
            HostKeyVerdict::Known => Ok(()),
            HostKeyVerdict::Unknown { fingerprint }
                if self.accept_fingerprint.as_deref() == Some(fingerprint.as_str()) =>
            {
                self.known_hosts.trust(&self.host, self.port, &key)
            }
            HostKeyVerdict::Unknown { fingerprint } => {
                Err(AppError::new(ErrorKind::HostKeyUnknown, fingerprint).with_host(label()))
            }
            HostKeyVerdict::Changed { fingerprint } => {
                Err(AppError::new(ErrorKind::HostKeyChanged, fingerprint).with_host(label()))
            }
            HostKeyVerdict::Unverifiable { reason } => Err(AppError::new(
                ErrorKind::Connection,
                format!("cannot verify the SSH host key: {reason}"),
            )),
        }
    }
}

impl client::Handler for TunnelHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        match self.decide(server) {
            Ok(()) => Ok(true),
            Err(e) => {
                *self.refusal.lock().unwrap_or_else(|p| p.into_inner()) = Some(e);
                Ok(false)
            }
        }
    }
}

type DynAgent = AgentClient<Box<dyn AgentStream + Send + Unpin + 'static>>;

/// Authentication material checked before any network traffic, so a missing secret is
/// reported without connecting.
enum Credentials {
    Password(String),
    Key(Box<PrivateKey>),
    Agent(DynAgent),
}

fn load_key(path: &Path, passphrase: Option<&str>) -> AppResult<PrivateKey> {
    let passphrase = passphrase.filter(|p| !p.is_empty());
    match russh::keys::load_secret_key(path, passphrase) {
        Ok(key) => Ok(key),
        Err(russh::keys::Error::KeyIsEncrypted) => Err(auth_err("ssh passphrase required")),
        Err(russh::keys::Error::IO(e)) => Err(AppError::new(
            ErrorKind::Io,
            format!("cannot read SSH key {}: {e}", path.display()),
        )),
        // A wrong passphrase surfaces as a decryption/format error: if the key is
        // encrypted, ask for the passphrase again.
        Err(e) => match russh::keys::load_secret_key(path, None) {
            Err(russh::keys::Error::KeyIsEncrypted) => Err(auth_err("ssh passphrase required")),
            _ => Err(AppError::new(
                ErrorKind::Invalid,
                format!("unusable SSH key {}: {e}", path.display()),
            )),
        },
    }
}

async fn connect_agent() -> AppResult<DynAgent> {
    let unavailable = || auth_err("ssh agent not available");
    #[cfg(unix)]
    {
        let sock = std::env::var_os("SSH_AUTH_SOCK").filter(|s| !s.is_empty());
        let sock = sock.ok_or_else(unavailable)?;
        let agent = AgentClient::connect_uds(sock)
            .await
            .map_err(|_| unavailable())?;
        Ok(agent.dynamic())
    }
    #[cfg(windows)]
    {
        let agent = AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent")
            .await
            .map_err(|_| unavailable())?;
        Ok(agent.dynamic())
    }
}

async fn credentials(auth: &SshAuthMaterial) -> AppResult<Credentials> {
    match auth {
        SshAuthMaterial::Password(p) if p.is_empty() => Err(auth_err("ssh password required")),
        SshAuthMaterial::Password(p) => Ok(Credentials::Password(p.clone())),
        SshAuthMaterial::Key { path, passphrase } => Ok(Credentials::Key(Box::new(load_key(
            path,
            passphrase.as_deref(),
        )?))),
        SshAuthMaterial::Agent => Ok(Credentials::Agent(connect_agent().await?)),
    }
}

async fn authenticate(
    h: &mut Handle<TunnelHandler>,
    target: &SshTarget,
    creds: Credentials,
) -> AppResult<()> {
    let user = target.user.as_str();
    let success = match creds {
        Credentials::Password(pw) => h
            .authenticate_password(user, pw)
            .await
            .map_err(|e| ssh_err(target, e))?
            .success(),
        Credentials::Key(key) => {
            // Only used for RSA keys (rsa-sha2-256/512 when the server supports them).
            let hash = h
                .best_supported_rsa_hash()
                .await
                .map_err(|e| ssh_err(target, e))?
                .flatten();
            h.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(*key), hash))
                .await
                .map_err(|e| ssh_err(target, e))?
                .success()
        }
        Credentials::Agent(mut agent) => {
            let identities = agent
                .request_identities()
                .await
                .map_err(|_| auth_err("ssh agent not available"))?;
            let hash = h
                .best_supported_rsa_hash()
                .await
                .map_err(|e| ssh_err(target, e))?
                .flatten();
            let mut success = false;
            for id in identities {
                // Certificates held by the agent are not offered (plain keys only).
                let AgentIdentity::PublicKey { key, .. } = id else {
                    continue;
                };
                let res = h
                    .authenticate_publickey_with(user, key, hash, &mut agent)
                    .await
                    .map_err(|e| ssh_err(target, e))?;
                if let AuthResult::Success = res {
                    success = true;
                    break;
                }
            }
            success
        }
    };
    if success {
        Ok(())
    } else {
        Err(auth_err("ssh authentication failed"))
    }
}

pub struct SshTunnel {
    local_addr: SocketAddr,
    session: Arc<Handle<TunnelHandler>>,
    /// Accept loop; owns the per-connection forwarding tasks, aborted with it.
    accept: JoinHandle<()>,
    closed: AtomicBool,
}

impl SshTunnel {
    /// Local end (`127.0.0.1:<port>`) to use as `ConnectParams.dial`.
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// False once closed, or when the SSH session or the listener has ended.
    pub fn is_alive(&self) -> bool {
        !self.closed.load(Ordering::SeqCst)
            && !self.session.is_closed()
            && !self.accept.is_finished()
    }

    /// Stops listening, drops every forwarded connection and ends the SSH session.
    pub async fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.accept.abort();
        let _ = self
            .session
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        // Aborting the accept loop drops the listener and every forwarding task; the
        // session ends once the last handle (ours, dropped now) is gone.
        self.accept.abort();
    }
}

async fn forward(
    session: Arc<Handle<TunnelHandler>>,
    mut sock: TcpStream,
    peer: SocketAddr,
    remote_host: String,
    remote_port: u16,
) {
    let channel = session
        .channel_open_direct_tcpip(
            remote_host,
            u32::from(remote_port),
            peer.ip().to_string(),
            u32::from(peer.port()),
        )
        .await;
    // Unreachable target: dropping `sock` closes it, so only this DB connection fails.
    let Ok(channel) = channel else { return };
    let _ = sock.set_nodelay(true);
    let mut stream = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
}

async fn accept_loop(
    listener: TcpListener,
    session: Arc<Handle<TunnelHandler>>,
    remote_host: String,
    remote_port: u16,
) {
    let mut conns = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((sock, peer)) => {
                    conns.spawn(forward(session.clone(), sock, peer, remote_host.clone(), remote_port));
                }
                // Per-connection failures (e.g. too many open files): back off a little.
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            },
            Some(_) = conns.join_next(), if !conns.is_empty() => {}
        }
    }
}

/// Opens an SSH session to `target` and forwards a local port to
/// `remote_host:remote_port` (resolved by the SSH server).
pub async fn open_tunnel(
    target: &SshTarget,
    remote_host: &str,
    remote_port: u16,
    policy: &HostKeyPolicy,
) -> AppResult<Arc<SshTunnel>> {
    let creds = credentials(&target.auth).await?;

    let refusal = Arc::new(Mutex::new(None));
    let handler = TunnelHandler {
        host: target.host.clone(),
        port: target.port,
        known_hosts: KnownHosts {
            system: policy.known_hosts.system.clone(),
            app: policy.known_hosts.app.clone(),
        },
        accept_fingerprint: policy.accept_fingerprint.clone(),
        refusal: refusal.clone(),
    };
    // Ask for the key type known_hosts records for this server, as OpenSSH does.
    let recorded = policy
        .known_hosts
        .host_key_algorithms(&target.host, target.port);
    let config = Arc::new(client::Config {
        preferred: russh::Preferred {
            key: Cow::Owned(preferred_host_key_algorithms(&recorded)),
            ..Default::default()
        },
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    });
    let connected = tokio::time::timeout(
        CONNECT_TIMEOUT,
        client::connect(config, (target.host.as_str(), target.port), handler),
    )
    .await
    .map_err(|_| ssh_err(target, "connection timed out"))?;
    let mut session = match connected {
        Ok(h) => h,
        Err(e) => {
            let refused = refusal.lock().unwrap_or_else(|p| p.into_inner()).take();
            return Err(refused.unwrap_or_else(|| ssh_err(target, e)));
        }
    };

    if let Err(e) = authenticate(&mut session, target, creds).await {
        let _ = session
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
        return Err(e);
    }

    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|e| {
            AppError::new(
                ErrorKind::Io,
                format!("cannot listen for the SSH tunnel: {e}"),
            )
        })?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?;
    let session = Arc::new(session);
    let accept = tokio::spawn(accept_loop(
        listener,
        session.clone(),
        remote_host.to_string(),
        remote_port,
    ));
    Ok(Arc::new(SshTunnel {
        local_addr,
        session,
        accept,
        closed: AtomicBool::new(false),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_labels() {
        assert_eq!(host_label("db.example", 22), "db.example:22");
        assert_eq!(host_label("127.0.0.1", 2222), "127.0.0.1:2222");
        assert_eq!(host_label("::1", 22), "[::1]:22");
    }

    #[test]
    fn debug_redacts_secrets() {
        let pw = format!("{:?}", SshAuthMaterial::Password("s3cret-pw".into()));
        assert!(
            !pw.contains("s3cret-pw") && pw.contains("<redacted>"),
            "{pw}"
        );
        let key = SshAuthMaterial::Key {
            path: "/k/id".into(),
            passphrase: Some("s3cret-pass".into()),
        };
        let target = format!(
            "{:?}",
            SshTarget {
                host: "h".into(),
                port: 22,
                user: "u".into(),
                auth: key,
            }
        );
        assert!(!target.contains("s3cret-pass"), "{target}");
        assert!(
            target.contains("/k/id") && target.contains("<redacted>"),
            "{target}"
        );
    }
}

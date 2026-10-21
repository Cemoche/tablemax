//! Loopback relay for direct network connections (#112): a listener on `127.0.0.1:0`
//! whose accepted connections are forwarded byte for byte to the database server, their
//! bytes counted into the workspace's [`Traffic`].
//!
//! A direct PostgreSQL, MySQL or MariaDB workspace dials the relay's local end
//! (`ConnectParams.dial`) exactly as an SSH workspace dials its tunnel's, while `host`
//! stays the TLS and display name. The drivers need no hook of their own: mysql_async
//! cannot be given a caller-made stream, and one path for every engine keeps the
//! counting in one place. TLS stays end to end (the relay copies the encrypted bytes).
//!
//! The driver only sees its local connection close when the server cannot be reached,
//! so the relay keeps the reason ([`Relay::take_failure`]) for the manager to report
//! instead of the driver's "unexpected end of file".
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::net::{TcpListener, TcpSocket, TcpStream, lookup_host};
use tokio::task::{JoinHandle, JoinSet};

use crate::error::{AppError, AppResult, ErrorKind};
use crate::traffic::{Traffic, pump};

/// Bound on reaching the server (resolution and TCP connect); the drivers give up after
/// the same delay.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

type Failure = Arc<Mutex<Option<AppError>>>;

pub struct Relay {
    local_addr: SocketAddr,
    /// Accept loop; owns the per-connection forwarding tasks, aborted with it.
    accept: JoinHandle<()>,
    failure: Failure,
}

impl Relay {
    /// Listens on a free loopback port and forwards each connection to `host:port`.
    pub async fn open(host: &str, port: u16, traffic: Arc<Traffic>) -> AppResult<Arc<Relay>> {
        let io_err = |e: std::io::Error| {
            AppError::new(ErrorKind::Io, format!("cannot listen for the relay: {e}"))
        };
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(io_err)?;
        let local_addr = listener.local_addr().map_err(io_err)?;
        let failure = Failure::default();
        let accept = tokio::spawn(accept_loop(
            listener,
            host.to_string(),
            port,
            traffic,
            failure.clone(),
        ));
        Ok(Arc::new(Relay {
            local_addr,
            accept,
            failure,
        }))
    }

    /// Local end (`127.0.0.1:<port>`) to use as `ConnectParams.dial`.
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Why the last forwarded connection could not reach the server (cleared).
    pub fn take_failure(&self) -> Option<AppError> {
        self.failure
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        // Drops the listener and every forwarding task (their connections close).
        self.accept.abort();
    }
}

/// `host:port` as an error shows it (`[v6]:port` for an IPv6 address).
fn host_label(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// Tries each address of `host` in turn, like the drivers do. Keepalive on, with the
/// system's timing, as tokio-postgres sets it by default.
async fn connect_server(host: &str, port: u16) -> std::io::Result<TcpStream> {
    let mut last = None;
    for addr in lookup_host((host, port)).await? {
        let socket = if addr.is_ipv4() {
            TcpSocket::new_v4()?
        } else {
            TcpSocket::new_v6()?
        };
        socket.set_keepalive(true)?;
        match socket.connect(addr).await {
            Ok(stream) => {
                stream.set_nodelay(true)?;
                return Ok(stream);
            }
            Err(e) => last = Some(e),
        }
    }
    Err(last
        .unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no address found")))
}

async fn forward(
    mut sock: TcpStream,
    host: Arc<str>,
    port: u16,
    traffic: Arc<Traffic>,
    failure: Failure,
) {
    let _ = sock.set_nodelay(true);
    let label = || host_label(&host, port);
    let server = match tokio::time::timeout(CONNECT_TIMEOUT, connect_server(&host, port)).await {
        Ok(Ok(server)) => server,
        Ok(Err(e)) => {
            let e = AppError::new(
                ErrorKind::Connection,
                format!("cannot connect to {}: {e}", label()),
            );
            *failure.lock().unwrap_or_else(|p| p.into_inner()) = Some(e);
            return;
        }
        Err(_) => {
            let e = AppError::new(
                ErrorKind::Connection,
                format!("cannot connect to {}: connection timed out", label()),
            );
            *failure.lock().unwrap_or_else(|p| p.into_inner()) = Some(e);
            return;
        }
    };
    let _ = pump(&mut sock, server, traffic).await;
}

async fn accept_loop(
    listener: TcpListener,
    host: String,
    port: u16,
    traffic: Arc<Traffic>,
    failure: Failure,
) {
    let host: Arc<str> = host.into();
    let mut conns = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((sock, _)) => {
                    conns.spawn(forward(sock, host.clone(), port, traffic.clone(), failure.clone()));
                }
                // Per-connection failures (e.g. too many open files): back off a little.
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            },
            Some(_) = conns.join_next(), if !conns.is_empty() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traffic::Totals;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A one-connection echo server on loopback that answers every byte with two.
    async fn doubling_server() -> SocketAddr {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            loop {
                let n = s.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                let mut out = buf[..n].to_vec();
                out.extend_from_slice(&buf[..n]);
                s.write_all(&out).await.unwrap();
            }
        });
        addr
    }

    #[tokio::test]
    async fn relay_forwards_and_counts_exactly() {
        let server = doubling_server().await;
        let traffic = Arc::new(Traffic::default());
        let relay = Relay::open("127.0.0.1", server.port(), traffic.clone())
            .await
            .unwrap();
        assert!(relay.local_addr().ip().is_loopback());

        let mut c = TcpStream::connect(relay.local_addr()).await.unwrap();
        let sent = vec![9u8; 10_000];
        c.write_all(&sent).await.unwrap();
        let mut back = vec![0u8; 20_000];
        c.read_exact(&mut back).await.unwrap();
        assert!(back.iter().all(|b| *b == 9));
        assert_eq!(
            traffic.totals(),
            Totals {
                read: 20_000,
                written: 10_000
            }
        );
        assert!(relay.take_failure().is_none());
    }

    #[tokio::test]
    async fn relay_keeps_why_the_server_was_unreachable() {
        // A port nothing listens on: bind one, note it, close it.
        let closed = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);

        let traffic = Arc::new(Traffic::default());
        let relay = Relay::open("127.0.0.1", port, traffic.clone())
            .await
            .unwrap();
        let mut c = TcpStream::connect(relay.local_addr()).await.unwrap();
        // The driver side only sees its connection end.
        let mut buf = [0u8; 1];
        let n = tokio::time::timeout(Duration::from_secs(5), c.read(&mut buf))
            .await
            .expect("the relay must close the local side")
            .unwrap_or(0);
        assert_eq!(n, 0);
        let e = relay.take_failure().expect("the reason is kept");
        assert_eq!(e.kind, ErrorKind::Connection);
        assert!(
            e.message
                .starts_with(&format!("cannot connect to 127.0.0.1:{port}: ")),
            "{}",
            e.message
        );
        assert!(relay.take_failure().is_none(), "taken once");
        assert_eq!(traffic.totals(), Totals::default());
    }

    #[tokio::test]
    async fn dropping_the_relay_stops_listening() {
        let traffic = Arc::new(Traffic::default());
        let relay = Relay::open("127.0.0.1", 9, traffic).await.unwrap();
        let addr = relay.local_addr();
        drop(relay);
        // The aborted accept loop drops the listener (give the runtime a moment).
        let mut refused = false;
        for _ in 0..50 {
            if TcpStream::connect(addr).await.is_err() {
                refused = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(refused, "nothing listens once the relay is dropped");
    }

    #[test]
    fn host_labels() {
        assert_eq!(host_label("db.example", 5432), "db.example:5432");
        assert_eq!(host_label("::1", 3306), "[::1]:3306");
    }
}

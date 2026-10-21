//! Counted direct connections (#112): a [`Route`] tells a driver to count the bytes of a
//! direct (non-SSH) connection into the workspace's [`Traffic`].
//!
//! - PostgreSQL opens the TCP stream itself ([`connect_server`]), wraps it in
//!   `Counted` and hands it to tokio-postgres (`connect_raw`, `cancel_query_raw`): no
//!   listener at all.
//! - mysql_async cannot be given a stream (it dials TCP or a Unix socket itself, and over
//!   a Unix socket it skips TLS and sends the password in clear text). Each MySQL / MariaDB
//!   connection (session, cancel, `Prefer` retry) therefore dials a [`OneShot`] relay
//!   opened just for it: a listener on `127.0.0.1:0` that accepts exactly one connection,
//!   closes at once, and forwards that connection byte for byte (TLS stays end to end).
//!   It is never an open forwarder: once the driver's connection is in, nothing else can
//!   reach the server through it, and a listener nobody dials closes after
//!   [`CONNECT_TIMEOUT`].
//!
//! When the relay cannot reach the server, the driver only sees its local connection
//! close, so the relay keeps the reason ([`OneShot::take_failure`]).
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::net::{TcpListener, TcpSocket, TcpStream, lookup_host};

use crate::error::{AppError, AppResult, ErrorKind};
use crate::traffic::{Traffic, pump};

/// Bound on reaching the server (resolution and TCP connect), and on the driver dialing
/// a one-shot relay; the drivers give up after the same delay.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// A direct connection to count: the server's `host:port` and the workspace's counter.
#[derive(Clone)]
pub struct Route {
    pub host: String,
    pub port: u16,
    pub traffic: Arc<Traffic>,
}

/// `host:port` as an error shows it (`[v6]:port` for an IPv6 address).
fn host_label(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn unreachable(host: &str, port: u16, why: impl std::fmt::Display) -> AppError {
    AppError::new(
        ErrorKind::Connection,
        format!("cannot connect to {}: {why}", host_label(host, port)),
    )
}

/// Connects to `host:port`, trying each address in turn like the drivers do, within
/// [`CONNECT_TIMEOUT`]. Keepalive on with the system's timing (tokio-postgres' default),
/// no Nagle delay.
pub async fn connect_server(host: &str, port: u16) -> AppResult<TcpStream> {
    let attempt = async {
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
        Err(last.unwrap_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "no address found")
        }))
    };
    match tokio::time::timeout(CONNECT_TIMEOUT, attempt).await {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(e)) => Err(unreachable(host, port, e)),
        Err(_) => Err(unreachable(host, port, "connection timed out")),
    }
}

type Failure = Arc<Mutex<Option<AppError>>>;

/// A loopback relay for ONE connection (see the module docs).
pub struct OneShot {
    local_addr: SocketAddr,
    failure: Failure,
}

impl OneShot {
    /// Listens on a free loopback port; the first connection accepted is forwarded to
    /// `route`'s server and counted, then the listener is closed.
    pub async fn open(route: &Route) -> AppResult<OneShot> {
        let io_err = |e: std::io::Error| {
            AppError::new(ErrorKind::Io, format!("cannot listen for the relay: {e}"))
        };
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(io_err)?;
        let local_addr = listener.local_addr().map_err(io_err)?;
        let failure = Failure::default();
        tokio::spawn(relay_one(listener, route.clone(), failure.clone()));
        Ok(OneShot {
            local_addr,
            failure,
        })
    }

    /// Where the driver connects (`127.0.0.1:<port>`).
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Why the relay could not reach the server, if it could not (taken once).
    pub fn take_failure(&self) -> Option<AppError> {
        self.failure
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take()
    }
}

async fn relay_one(listener: TcpListener, route: Route, failure: Failure) {
    let accepted = tokio::time::timeout(CONNECT_TIMEOUT, listener.accept()).await;
    // One connection only: nothing else is accepted, whatever happens next.
    drop(listener);
    let Ok(Ok((mut sock, _))) = accepted else {
        return;
    };
    let _ = sock.set_nodelay(true);
    match connect_server(&route.host, route.port).await {
        Ok(server) => {
            let _ = pump(&mut sock, server, route.traffic).await;
        }
        // Recorded before `sock` drops, so the driver's error comes after it.
        Err(e) => *failure.lock().unwrap_or_else(|p| p.into_inner()) = Some(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traffic::Totals;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// An echo server on loopback that answers every byte with two, for any number of
    /// connections; counts the connections it accepted.
    async fn doubling_server() -> (SocketAddr, Arc<std::sync::atomic::AtomicUsize>) {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = accepted.clone();
        tokio::spawn(async move {
            loop {
                let (mut s, _) = listener.accept().await.unwrap();
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buf = [0u8; 4096];
                    loop {
                        let n = s.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        let mut out = buf[..n].to_vec();
                        out.extend_from_slice(&buf[..n]);
                        if s.write_all(&out).await.is_err() {
                            break;
                        }
                    }
                });
            }
        });
        (addr, accepted)
    }

    fn route(port: u16, traffic: &Arc<Traffic>) -> Route {
        Route {
            host: "127.0.0.1".into(),
            port,
            traffic: traffic.clone(),
        }
    }

    #[tokio::test]
    async fn one_shot_forwards_and_counts_exactly() {
        let (server, _) = doubling_server().await;
        let traffic = Arc::new(Traffic::default());
        let hop = OneShot::open(&route(server.port(), &traffic))
            .await
            .unwrap();
        assert!(hop.local_addr().ip().is_loopback());

        let mut c = TcpStream::connect(hop.local_addr()).await.unwrap();
        c.write_all(&[9u8; 10_000]).await.unwrap();
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
        assert!(hop.take_failure().is_none());
    }

    /// The security property: once the driver's connection is in, a second connection to
    /// the relay's port is refused and never reaches the server.
    #[tokio::test]
    async fn one_shot_refuses_a_second_connection() {
        let (server, accepted) = doubling_server().await;
        let traffic = Arc::new(Traffic::default());
        let hop = OneShot::open(&route(server.port(), &traffic))
            .await
            .unwrap();
        let mut first = TcpStream::connect(hop.local_addr()).await.unwrap();
        first.write_all(b"x").await.unwrap();
        let mut two = [0u8; 2];
        first.read_exact(&mut two).await.unwrap();

        let second = TcpStream::connect(hop.local_addr()).await;
        assert!(
            second.is_err(),
            "the listener is closed after the first connection"
        );
        assert_eq!(accepted.load(std::sync::atomic::Ordering::SeqCst), 1);
        // The first connection still works.
        first.write_all(b"y").await.unwrap();
        first.read_exact(&mut two).await.unwrap();
        assert_eq!(&two, b"yy");
    }

    /// A relay nobody dials does not stay open.
    #[tokio::test(start_paused = true)]
    async fn one_shot_closes_when_nobody_connects() {
        let traffic = Arc::new(Traffic::default());
        let hop = OneShot::open(&route(9, &traffic)).await.unwrap();
        let addr = hop.local_addr();
        tokio::time::sleep(CONNECT_TIMEOUT + Duration::from_secs(1)).await;
        // Let the relay task run its timeout branch.
        tokio::task::yield_now().await;
        tokio::time::resume();
        let mut refused = false;
        for _ in 0..50 {
            if TcpStream::connect(addr).await.is_err() {
                refused = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(refused, "nothing listens once the wait is over");
    }

    #[tokio::test]
    async fn one_shot_keeps_why_the_server_was_unreachable() {
        // A port nothing listens on: bind one, note it, close it.
        let closed = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);

        let traffic = Arc::new(Traffic::default());
        let hop = OneShot::open(&route(port, &traffic)).await.unwrap();
        let mut c = TcpStream::connect(hop.local_addr()).await.unwrap();
        // The driver side only sees its connection end.
        let mut buf = [0u8; 1];
        let n = tokio::time::timeout(Duration::from_secs(5), c.read(&mut buf))
            .await
            .expect("the relay must close the local side")
            .unwrap_or(0);
        assert_eq!(n, 0);
        let e = hop.take_failure().expect("the reason is kept");
        assert_eq!(e.kind, ErrorKind::Connection);
        assert!(
            e.message
                .starts_with(&format!("cannot connect to 127.0.0.1:{port}: ")),
            "{}",
            e.message
        );
        assert!(hop.take_failure().is_none(), "taken once");
        assert_eq!(traffic.totals(), Totals::default());
    }

    #[tokio::test]
    async fn connect_server_says_where_it_failed() {
        let closed = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = closed.local_addr().unwrap().port();
        drop(closed);
        let e = connect_server("127.0.0.1", port).await.unwrap_err();
        assert_eq!(e.kind, ErrorKind::Connection);
        assert!(
            e.message
                .starts_with(&format!("cannot connect to 127.0.0.1:{port}: ")),
            "{}",
            e.message
        );
    }

    #[test]
    fn host_labels() {
        assert_eq!(host_label("db.example", 5432), "db.example:5432");
        assert_eq!(host_label("::1", 3306), "[::1]:3306");
    }
}

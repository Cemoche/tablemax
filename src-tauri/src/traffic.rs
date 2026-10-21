//! Network traffic of a workspace (#112): the bytes read from and written to the database
//! server by every network connection of the workspace (browse, SQL sessions, cancel
//! requests), shown as a rate in the status pill.
//!
//! Bytes are counted where the app owns the byte stream, by wrapping the server side in
//! [`Counted`]: the SSH tunnel's forwarding loop (`ssh::tunnel`, through [`pump`]), the
//! PostgreSQL driver's own stream and the MySQL one-shot relays (`relay`). Counting costs one
//! relaxed atomic add per read or write call (never per byte), with no lock and no
//! allocation; the rate is only computed when asked ([`RateWindow::sample`], polled by
//! the pill while it shows the workspace). Only byte counts are kept, never content.

use std::collections::VecDeque;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

/// Byte counters of one workspace, shared by its tunnel or relay.
#[derive(Debug, Default)]
pub struct Traffic {
    read: AtomicU64,
    written: AtomicU64,
}

/// Bytes moved since a [`Traffic`] was created.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Totals {
    /// Received from the server.
    pub read: u64,
    /// Sent to the server.
    pub written: u64,
}

impl Traffic {
    pub fn totals(&self) -> Totals {
        Totals {
            read: self.read.load(Relaxed),
            written: self.written.load(Relaxed),
        }
    }
}

/// A stream whose reads and writes are added to a [`Traffic`]: wrap the server side,
/// so what is read from it counts as read from the server.
pub struct Counted<S> {
    inner: S,
    traffic: Arc<Traffic>,
}

impl<S> Counted<S> {
    pub fn new(inner: S, traffic: Arc<Traffic>) -> Self {
        Self { inner, traffic }
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Counted<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let before = buf.filled().len();
        let res = Pin::new(&mut this.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = res {
            let n = buf.filled().len() - before;
            if n > 0 {
                this.traffic.read.fetch_add(n as u64, Relaxed);
            }
        }
        res
    }
}

impl<S: AsyncWrite + Unpin> Counted<S> {
    fn count_written(&self, res: &Poll<io::Result<usize>>) {
        if let Poll::Ready(Ok(n)) = res
            && *n > 0
        {
            self.traffic.written.fetch_add(*n as u64, Relaxed);
        }
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Counted<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let res = Pin::new(&mut this.inner).poll_write(cx, buf);
        this.count_written(&res);
        res
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let res = Pin::new(&mut this.inner).poll_write_vectored(cx, bufs);
        this.count_written(&res);
        res
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

/// Buffer per direction of a forwarded connection: large result pages move in fewer
/// wakeups than with tokio's 8 KiB default.
const PUMP_BUFFER: usize = 64 * 1024;

/// Forwards bytes between the driver's `local` end and `server` until either side
/// closes, counting what crosses into `traffic` (read = from the server).
pub async fn pump<L, S>(local: &mut L, server: S, traffic: Arc<Traffic>) -> io::Result<()>
where
    L: AsyncRead + AsyncWrite + Unpin + ?Sized,
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut server = Counted::new(server, traffic);
    tokio::io::copy_bidirectional_with_sizes(local, &mut server, PUMP_BUFFER, PUMP_BUFFER)
        .await
        .map(|_| ())
}

/// Bytes per second over the last [`RATE_WINDOW`], as sent to the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Throughput {
    pub read_per_sec: u64,
    pub written_per_sec: u64,
}

/// The rate is measured over (about) this much time.
pub const RATE_WINDOW: Duration = Duration::from_secs(2);
/// A shorter span gives no rate: a few bytes over a few milliseconds would read as a burst.
pub const MIN_SPAN: Duration = Duration::from_millis(500);
/// A reference older than this means the rate was not asked for a while (the pill showed
/// another workspace): the window starts over instead of averaging over the gap.
pub const MAX_SPAN: Duration = Duration::from_secs(4);
/// Samples closer than this to the previous one replace it (bounds the window's length).
const MIN_SAMPLE_GAP: Duration = Duration::from_millis(100);

/// Sliding window of [`Totals`] samples; the rate is the difference between the newest
/// sample and the one at (or just before) the window's start.
#[derive(Debug, Default)]
pub struct RateWindow {
    samples: VecDeque<(Instant, Totals)>,
}

impl RateWindow {
    /// Records `totals` at `now` and returns the rate since the window's reference, or
    /// `None` while there is no usable reference yet (first sample, or too recent).
    pub fn sample(&mut self, now: Instant, totals: Totals) -> Option<Throughput> {
        let len = self.samples.len();
        match self.samples.back_mut() {
            // Never the reference itself (`len > 1`): only a later sample is replaced.
            Some(last) if len > 1 && now.saturating_duration_since(last.0) < MIN_SAMPLE_GAP => {
                *last = (now, totals);
            }
            _ => self.samples.push_back((now, totals)),
        }
        // Keep one reference at or before the window's start, drop the older ones.
        while self.samples.len() > 1
            && now.saturating_duration_since(self.samples[1].0) >= RATE_WINDOW
        {
            self.samples.pop_front();
        }
        let (since, first) = self.samples[0];
        let span = now.saturating_duration_since(since);
        if span > MAX_SPAN {
            self.samples.drain(..self.samples.len() - 1);
            return None;
        }
        if span < MIN_SPAN {
            return None;
        }
        let per_sec = |to: u64, from: u64| {
            (to.saturating_sub(from) as f64 / span.as_secs_f64()).round() as u64
        };
        Some(Throughput {
            read_per_sec: per_sec(totals.read, first.read),
            written_per_sec: per_sec(totals.written, first.written),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn counted_counts_reads_and_writes_exactly() {
        let (a, mut b) = tokio::io::duplex(64);
        let traffic = Arc::new(Traffic::default());
        let mut counted = Counted::new(a, traffic.clone());

        counted.write_all(b"hello world").await.unwrap();
        let mut got = [0u8; 11];
        b.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"hello world");
        assert_eq!(
            traffic.totals(),
            Totals {
                read: 0,
                written: 11
            }
        );

        // More than the duplex buffer: several partial reads, each counted once.
        let big = vec![7u8; 1000];
        let writer = tokio::spawn(async move {
            b.write_all(&big).await.unwrap();
            b
        });
        let mut back = vec![0u8; 1000];
        counted.read_exact(&mut back).await.unwrap();
        let _b = writer.await.unwrap();
        assert_eq!(
            traffic.totals(),
            Totals {
                read: 1000,
                written: 11
            }
        );

        // A read at end of stream adds nothing.
        drop(_b);
        let mut rest = Vec::new();
        counted.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
        assert_eq!(
            traffic.totals(),
            Totals {
                read: 1000,
                written: 11
            }
        );
    }

    #[tokio::test]
    async fn counted_counts_vectored_writes() {
        let (a, mut b) = tokio::io::duplex(64);
        let traffic = Arc::new(Traffic::default());
        let mut counted = Counted::new(a, traffic.clone());
        let bufs = [io::IoSlice::new(b"abc"), io::IoSlice::new(b"de")];
        let n = counted.write_vectored(&bufs).await.unwrap();
        let mut got = vec![0u8; n];
        b.read_exact(&mut got).await.unwrap();
        assert_eq!(traffic.totals().written, n as u64);
    }

    #[tokio::test]
    async fn pump_forwards_and_counts_both_directions() {
        let (mut driver, local) = tokio::io::duplex(1024);
        let (server_side, mut server) = tokio::io::duplex(1024);
        let traffic = Arc::new(Traffic::default());
        let t = traffic.clone();
        let relay = tokio::spawn(async move {
            let mut local = local;
            pump(&mut local, server_side, t).await
        });

        let query = vec![1u8; 300];
        driver.write_all(&query).await.unwrap();
        let mut got = vec![0u8; 300];
        server.read_exact(&mut got).await.unwrap();
        let rows = vec![2u8; 5000];
        server.write_all(&rows).await.unwrap();
        let mut back = vec![0u8; 5000];
        driver.read_exact(&mut back).await.unwrap();
        assert_eq!(back, rows);

        drop(driver);
        drop(server);
        relay.await.unwrap().ok();
        assert_eq!(
            traffic.totals(),
            Totals {
                read: 5000,
                written: 300
            }
        );
    }

    fn totals(read: u64, written: u64) -> Totals {
        Totals { read, written }
    }

    #[test]
    fn rate_needs_a_reference_old_enough() {
        let t0 = Instant::now();
        let mut w = RateWindow::default();
        assert_eq!(
            w.sample(t0, totals(0, 0)),
            None,
            "first sample: no reference"
        );
        assert_eq!(
            w.sample(t0 + Duration::from_millis(100), totals(5000, 10)),
            None,
            "a span under MIN_SPAN gives no rate"
        );
        assert_eq!(
            w.sample(t0 + Duration::from_secs(1), totals(2000, 100)),
            Some(Throughput {
                read_per_sec: 2000,
                written_per_sec: 100
            })
        );
    }

    #[test]
    fn rate_is_zero_when_idle() {
        let t0 = Instant::now();
        let mut w = RateWindow::default();
        w.sample(t0, totals(123, 45));
        assert_eq!(
            w.sample(t0 + Duration::from_secs(1), totals(123, 45)),
            Some(Throughput {
                read_per_sec: 0,
                written_per_sec: 0
            })
        );
    }

    #[test]
    fn rate_slides_over_the_window() {
        let t0 = Instant::now();
        let s = Duration::from_secs(1);
        let mut w = RateWindow::default();
        w.sample(t0, totals(0, 0));
        // 10 000 bytes in the first second, nothing after.
        assert_eq!(
            w.sample(t0 + s, totals(10_000, 0)).unwrap().read_per_sec,
            10_000
        );
        assert_eq!(
            w.sample(t0 + 2 * s, totals(10_000, 0))
                .unwrap()
                .read_per_sec,
            5_000
        );
        // The burst leaves the 2 s window: back to 0.
        assert_eq!(
            w.sample(t0 + 3 * s, totals(10_000, 0))
                .unwrap()
                .read_per_sec,
            0
        );
        // 3 000 more over the last second, averaged over the 2 s window.
        assert_eq!(
            w.sample(t0 + 4 * s, totals(13_000, 0))
                .unwrap()
                .read_per_sec,
            1_500
        );
        assert!(w.samples.len() <= 3, "{:?}", w.samples);
    }

    #[test]
    fn rate_rounds_to_whole_bytes() {
        let t0 = Instant::now();
        let mut w = RateWindow::default();
        w.sample(t0, totals(0, 0));
        let r = w
            .sample(t0 + Duration::from_millis(1500), totals(1000, 1))
            .unwrap();
        assert_eq!(
            r,
            Throughput {
                read_per_sec: 667,
                written_per_sec: 1
            }
        );
    }

    #[test]
    fn rate_starts_over_after_a_long_gap() {
        let t0 = Instant::now();
        let mut w = RateWindow::default();
        w.sample(t0, totals(0, 0));
        // Not asked for a minute: no average over the gap.
        let later = t0 + Duration::from_secs(60);
        assert_eq!(w.sample(later, totals(6_000_000, 0)), None);
        assert_eq!(
            w.sample(later + Duration::from_secs(1), totals(6_000_100, 0))
                .unwrap()
                .read_per_sec,
            100
        );
    }

    #[test]
    fn rapid_samples_keep_the_window_short() {
        let t0 = Instant::now();
        let mut w = RateWindow::default();
        for i in 0..1000u64 {
            w.sample(t0 + Duration::from_millis(i), totals(i, 0));
        }
        assert!(w.samples.len() <= 3, "{}", w.samples.len());
        let r = w.sample(t0 + Duration::from_millis(1000), totals(1000, 0));
        assert_eq!(r.unwrap().read_per_sec, 1000);
    }
}

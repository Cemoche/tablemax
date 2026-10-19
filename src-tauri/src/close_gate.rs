//! Window close handshake. The main window's close is held until the frontend has
//! flushed its session (event `session-flush-requested`, answered by the command
//! `window_close_confirmed`), or until [`CLOSE_FALLBACK`] elapsed: a stuck or crashed
//! frontend never blocks quitting.

use std::sync::Mutex;
use std::time::Duration;

/// Event sent to the window when its close is requested.
pub const FLUSH_EVENT: &str = "session-flush-requested";

/// How long the frontend has to confirm before the window closes anyway.
pub const CLOSE_FALLBACK: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// No close requested yet.
    Idle,
    /// Close held back, waiting for the frontend (or the fallback timer).
    Pending,
    /// The real close may go through.
    Allowed,
}

/// What to do with a `CloseRequested` event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseDecision {
    /// Let the window close.
    Allow,
    /// Prevent the close. `first`: this is the first request, so send the flush event
    /// and arm the fallback timer (later requests while pending do neither).
    Defer { first: bool },
}

#[derive(Debug)]
pub struct CloseGate(Mutex<Phase>);

impl Default for CloseGate {
    fn default() -> Self {
        Self(Mutex::new(Phase::Idle))
    }
}

impl CloseGate {
    fn phase(&self) -> std::sync::MutexGuard<'_, Phase> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn on_close_requested(&self) -> CloseDecision {
        let mut p = self.phase();
        match *p {
            Phase::Allowed => CloseDecision::Allow,
            Phase::Pending => CloseDecision::Defer { first: false },
            Phase::Idle => {
                *p = Phase::Pending;
                CloseDecision::Defer { first: true }
            }
        }
    }

    /// The frontend confirmed, or the fallback fired. True when the caller must now
    /// close the window (false when a close was already allowed: no double close).
    pub fn confirm(&self) -> bool {
        let mut p = self.phase();
        if *p == Phase::Allowed {
            return false;
        }
        *p = Phase::Allowed;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_request_defers_and_arms_the_timer() {
        let g = CloseGate::default();
        assert_eq!(g.on_close_requested(), CloseDecision::Defer { first: true });
    }

    #[test]
    fn repeated_requests_while_pending_do_not_rearm() {
        let g = CloseGate::default();
        g.on_close_requested();
        assert_eq!(g.on_close_requested(), CloseDecision::Defer { first: false });
    }

    #[test]
    fn confirmed_close_is_not_intercepted_again() {
        let g = CloseGate::default();
        g.on_close_requested();
        assert!(g.confirm());
        assert_eq!(g.on_close_requested(), CloseDecision::Allow);
    }

    #[test]
    fn confirm_after_fallback_does_not_close_twice() {
        let g = CloseGate::default();
        g.on_close_requested();
        assert!(g.confirm(), "the fallback closes");
        assert!(!g.confirm(), "a late confirmation does nothing");
    }

    #[test]
    fn fallback_is_short() {
        assert!(CLOSE_FALLBACK <= Duration::from_secs(3));
    }
}

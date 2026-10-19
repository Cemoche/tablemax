//! The restorable session (open tabs, layout) as one JSON document in `app.db`. The
//! backend never interprets it: the frontend validates the JSON and its version, and
//! it holds no secret.

use rusqlite::{OptionalExtension, params};

use crate::error::{AppError, AppResult, ErrorKind};
use crate::history::now_ms;
use crate::store::ConnectionStore;

const MAX_SESSION_BYTES: usize = 5 * 1024 * 1024;
/// Layout version of the `session_state` row itself (the document has its own).
const ROW_VERSION: i64 = 1;

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorKind::Io, format!("session: {e}"))
}

pub fn save_session(store: &ConnectionStore, json: &str) -> AppResult<()> {
    if json.len() > MAX_SESSION_BYTES {
        return Err(AppError::new(ErrorKind::Invalid, "session too large"));
    }
    store.with_conn(|conn| {
        conn.execute(
            "INSERT INTO session_state(id, version, json, saved_at) VALUES(1, ?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET version = excluded.version, json = excluded.json,
                 saved_at = excluded.saved_at",
            params![ROW_VERSION, json, now_ms()],
        )
        .map_err(db_err)?;
        Ok(())
    })
}

/// The stored text as is; `None` when nothing was saved (or the table is missing).
pub fn load_session(store: &ConnectionStore) -> AppResult<Option<String>> {
    store.with_conn(|conn| {
        match conn
            .query_row("SELECT json FROM session_state WHERE id = 1", [], |r| {
                r.get::<_, String>(0)
            })
            .optional()
        {
            Ok(v) => Ok(v),
            Err(e) if e.to_string().contains("no such table") => Ok(None),
            Err(e) => Err(db_err(e)),
        }
    })
}

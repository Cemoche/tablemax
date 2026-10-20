//! Per-connection query history, kept in `app.db`. The SQL text is stored as executed
//! (it may contain values the user typed), so it is capped per connection, can be
//! cleared (app.db runs with `secure_delete`, so cleared rows are overwritten), and is
//! deleted with its connection. Statements that may carry a password are not recorded.

use rusqlite::params;
use serde::Serialize;

use crate::error::{AppError, AppResult, ErrorKind};
use crate::store::ConnectionStore;

/// Entries kept per connection; the oldest are deleted beyond it.
pub const HISTORY_CAP: usize = 1000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub connection_id: String,
    pub sql: String,
    /// Milliseconds since the Unix epoch.
    pub executed_at: i64,
    pub elapsed_ms: Option<u64>,
    /// Rows returned, or rows touched by a write.
    pub rows: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewHistoryEntry {
    pub connection_id: String,
    pub sql: String,
    pub executed_at: i64,
    pub elapsed_ms: Option<u64>,
    pub rows: Option<u64>,
    pub error: Option<String>,
}

fn db_err(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorKind::Io, format!("history: {e}"))
}

/// Milliseconds since the Unix epoch, now.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// True when `sql` may carry a password: it holds the word IDENTIFIED or PASSWORD (any
/// case, as a whole word: `CREATE/ALTER USER … IDENTIFIED BY`, `SET PASSWORD`,
/// PostgreSQL `… PASSWORD '…'`). Such statements are never recorded.
pub fn has_credentials(sql: &str) -> bool {
    sql.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .any(|w| w.eq_ignore_ascii_case("identified") || w.eq_ignore_ascii_case("password"))
}

pub fn record(store: &ConnectionStore, e: NewHistoryEntry) -> AppResult<()> {
    record_many(store, vec![e], false)
}

/// Inserts `entries` in order, then prunes each touched connection once, all in ONE
/// transaction. With `only_existing`, entries of a connection that is no longer saved
/// are skipped (a batch finishing after its connection was deleted must not leave
/// orphaned rows behind). Entries whose SQL may carry a password ([`has_credentials`])
/// are dropped.
pub fn record_many(
    store: &ConnectionStore,
    entries: Vec<NewHistoryEntry>,
    only_existing: bool,
) -> AppResult<()> {
    let entries: Vec<NewHistoryEntry> = entries
        .into_iter()
        .filter(|e| !has_credentials(&e.sql))
        .collect();
    if entries.is_empty() {
        return Ok(());
    }
    store.with_conn(|conn| {
        let tx = conn.unchecked_transaction().map_err(db_err)?;
        let mut touched: Vec<&str> = Vec::new();
        for e in &entries {
            if only_existing {
                let exists: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM connections WHERE id = ?1)",
                        params![e.connection_id],
                        |r| r.get(0),
                    )
                    .map_err(db_err)?;
                if !exists {
                    continue;
                }
            }
            tx.execute(
                "INSERT INTO query_history(connection_id, sql, executed_at, elapsed_ms, rows, error)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    e.connection_id,
                    e.sql,
                    e.executed_at,
                    e.elapsed_ms.map(|v| v as i64),
                    e.rows.map(|v| v as i64),
                    e.error
                ],
            )
            .map_err(db_err)?;
            if !touched.contains(&e.connection_id.as_str()) {
                touched.push(&e.connection_id);
            }
        }
        for id in touched {
            tx.execute(
                "DELETE FROM query_history WHERE connection_id = ?1 AND id NOT IN (
                     SELECT id FROM query_history WHERE connection_id = ?1
                     ORDER BY executed_at DESC, id DESC LIMIT ?2)",
                params![id, HISTORY_CAP as i64],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)
    })
}

/// Most recent first. `search` is a case-insensitive substring of the SQL text.
pub fn list(
    store: &ConnectionStore,
    connection_id: &str,
    search: Option<&str>,
    limit: u32,
) -> AppResult<Vec<HistoryEntry>> {
    let needle = search.filter(|s| !s.is_empty()).map(str::to_lowercase);
    store.with_conn(|conn| {
        // At most HISTORY_CAP rows per connection: filtering in Rust keeps the match
        // Unicode-aware and free of LIKE wildcards.
        let sql_limit: i64 = if needle.is_some() {
            -1
        } else {
            i64::from(limit)
        };
        let mut stmt = conn
            .prepare(
                "SELECT id, connection_id, sql, executed_at, elapsed_ms, rows, error
                 FROM query_history WHERE connection_id = ?1
                 ORDER BY executed_at DESC, id DESC LIMIT ?2",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![connection_id, sql_limit], |r| {
                Ok(HistoryEntry {
                    id: r.get(0)?,
                    connection_id: r.get(1)?,
                    sql: r.get(2)?,
                    executed_at: r.get(3)?,
                    elapsed_ms: r.get::<_, Option<i64>>(4)?.map(|v| v as u64),
                    rows: r.get::<_, Option<i64>>(5)?.map(|v| v as u64),
                    error: r.get(6)?,
                })
            })
            .map_err(db_err)?;
        let mut out = Vec::new();
        for row in rows {
            let entry = row.map_err(db_err)?;
            if needle
                .as_ref()
                .is_some_and(|n| !entry.sql.to_lowercase().contains(n))
            {
                continue;
            }
            out.push(entry);
            if out.len() >= limit as usize {
                break;
            }
        }
        Ok(out)
    })
}

/// Deletes one entry of `connection_id` (an id of another connection, or one already gone,
/// changes nothing).
pub fn delete(store: &ConnectionStore, connection_id: &str, id: i64) -> AppResult<()> {
    store.with_conn(|conn| {
        conn.execute(
            "DELETE FROM query_history WHERE connection_id = ?1 AND id = ?2",
            params![connection_id, id],
        )
        .map_err(db_err)?;
        Ok(())
    })
}

pub fn clear(store: &ConnectionStore, connection_id: &str) -> AppResult<()> {
    store.with_conn(|conn| {
        conn.execute(
            "DELETE FROM query_history WHERE connection_id = ?1",
            params![connection_id],
        )
        .map_err(db_err)?;
        Ok(())
    })
}

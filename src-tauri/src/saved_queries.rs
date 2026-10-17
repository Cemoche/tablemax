//! Saved queries: one `.sql` file per query in `<queries dir>/<connection id>/`.
//! Names come from the user, so they are validated hard: a name can never address a
//! path outside its connection's folder.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;

use crate::error::{AppError, AppResult, ErrorKind};

const EXT: &str = "sql";
const MAX_NAME_CHARS: usize = 120;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedQuery {
    pub name: String,
    /// Milliseconds since the Unix epoch.
    pub modified_at: i64,
    pub size: u64,
}

fn io_err(e: impl std::fmt::Display) -> AppError {
    AppError::new(ErrorKind::Io, format!("saved queries: {e}"))
}

fn invalid_name() -> AppError {
    AppError::new(ErrorKind::Invalid, "invalid query name")
}

fn not_found(name: &str) -> AppError {
    AppError::new(ErrorKind::NotFound, format!("saved query {name} not found"))
}

const RESERVED: [&str; 4] = ["con", "prn", "aux", "nul"];

fn is_reserved(name: &str) -> bool {
    // Windows reserves the device name with any extension ("con.sql" included).
    let stem = name.split('.').next().unwrap_or(name).to_lowercase();
    if RESERVED.contains(&stem.as_str()) {
        return true;
    }
    ["com", "lpt"].iter().any(|p| {
        stem.strip_prefix(p)
            .is_some_and(|d| d.len() == 1 && matches!(d.as_bytes()[0], b'1'..=b'9'))
    })
}

pub fn validate_name(name: &str) -> AppResult<()> {
    let n = name.chars().count();
    let bad_char = |c: char| {
        c.is_control()
            || matches!(
                c,
                '/' | '\\' | '\0' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
    };
    if n == 0
        || n > MAX_NAME_CHARS
        || name.contains("..")
        || name.chars().any(bad_char)
        || name.ends_with(' ')
        || name.ends_with('.')
        || name.starts_with(' ')
        || is_reserved(name)
    {
        return Err(invalid_name());
    }
    Ok(())
}

/// A connection id is a plain folder name: ids are UUIDs, nothing else is accepted.
fn validate_connection_id(id: &str) -> AppResult<()> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::new(ErrorKind::Invalid, "invalid connection id"));
    }
    Ok(())
}

fn conn_dir(base: &Path, connection_id: &str) -> AppResult<PathBuf> {
    validate_connection_id(connection_id)?;
    Ok(base.join(connection_id))
}

fn file_path(base: &Path, connection_id: &str, name: &str) -> AppResult<PathBuf> {
    validate_name(name)?;
    Ok(conn_dir(base, connection_id)?.join(format!("{name}.{EXT}")))
}

/// Refuses anything but a plain file (a symlink planted in the folder is not followed).
fn plain_file(path: &Path, name: &str) -> AppResult<fs::Metadata> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_file() => Ok(m),
        Ok(_) => Err(invalid_name()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(not_found(name)),
        Err(e) => Err(io_err(e)),
    }
}

fn mtime_ms(m: &fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn list(base: &Path, connection_id: &str) -> AppResult<Vec<SavedQuery>> {
    let dir = conn_dir(base, connection_id)?;
    let rd = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(io_err(e)),
    };
    let mut out = Vec::new();
    for entry in rd {
        let entry = entry.map_err(io_err)?;
        let Ok(file_name) = entry.file_name().into_string() else {
            continue;
        };
        let Some(name) = file_name.strip_suffix(&format!(".{EXT}")) else {
            continue;
        };
        if validate_name(name).is_err() {
            continue;
        }
        let Ok(meta) = fs::symlink_metadata(entry.path()) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        out.push(SavedQuery {
            name: name.to_string(),
            modified_at: mtime_ms(&meta),
            size: meta.len(),
        });
    }
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(out)
}

pub fn read(base: &Path, connection_id: &str, name: &str) -> AppResult<String> {
    let path = file_path(base, connection_id, name)?;
    plain_file(&path, name)?;
    fs::read_to_string(&path).map_err(io_err)
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Writes to a temporary file in the same folder, then renames it over the target, so
/// a crash never leaves a half-written query.
pub fn write(base: &Path, connection_id: &str, name: &str, sql: &str) -> AppResult<()> {
    let path = file_path(base, connection_id, name)?;
    if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
        return Err(invalid_name());
    }
    let dir = conn_dir(base, connection_id)?;
    fs::create_dir_all(&dir).map_err(io_err)?;
    let tmp = dir.join(format!(
        ".tmp-{}-{}",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(sql.as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, &path)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(io_err(e));
    }
    Ok(())
}

/// True when both paths designate the very same file (device + inode on Unix; the
/// canonical paths elsewhere).
fn is_same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (fs::metadata(a), fs::metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(x), Ok(y)) if x == y)
    }
}

pub fn rename(base: &Path, connection_id: &str, from: &str, to: &str) -> AppResult<()> {
    let src = file_path(base, connection_id, from)?;
    let dst = file_path(base, connection_id, to)?;
    plain_file(&src, from)?;
    // Refuse to overwrite another file. A case-only rename onto the same file (a
    // case-insensitive filesystem) is fine; on a case-sensitive one `a` and `A` are
    // different files and the check applies.
    let same_file = is_same_file(&src, &dst);
    if fs::symlink_metadata(&dst).is_ok() && !same_file {
        return Err(AppError::new(
            ErrorKind::Invalid,
            "a query with that name already exists",
        ));
    }
    fs::rename(&src, &dst).map_err(io_err)
}

pub fn delete(base: &Path, connection_id: &str, name: &str) -> AppResult<()> {
    let path = file_path(base, connection_id, name)?;
    plain_file(&path, name)?;
    fs::remove_file(&path).map_err(io_err)
}

/// Removes a connection's whole folder (when the connection is deleted).
pub fn remove_connection_dir(base: &Path, connection_id: &str) -> AppResult<()> {
    let dir = conn_dir(base, connection_id)?;
    match fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(e)),
    }
}

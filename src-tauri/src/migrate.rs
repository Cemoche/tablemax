//! Moves the app data directory when the app identifier changes.
//!
//! The data directory is named after `tauri.conf.json > identifier`
//! (`$XDG_DATA_HOME/<identifier>` on Linux, `~/Library/Application Support/<identifier>` on
//! macOS, `%APPDATA%\<identifier>` on Windows). Directories of earlier identifiers sit next
//! to the current one, so their content can be moved with renames on the same file system.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::error::AppResult;
use crate::store::ConnectionStore;

/// Identifiers used by earlier versions, newest first.
pub const PREVIOUS_IDENTIFIERS: &[&str] = &["dev.tablemax.app"];

/// Webview entries recreated per profile, holding no user data (`mediakeys`: WebKitGTK's
/// media key salt, written before the app's setup runs). When the current directory already
/// has one, the old copy is deleted instead of being left behind.
const DISPOSABLE: &[&str] = &["mediakeys"];

/// What `migrate_data_dir` did.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    NothingToDo,
    /// `moved` entries went from `from` into the current directory; `left` entries stayed
    /// in `from` because the current directory already had an entry with that name.
    Moved { from: PathBuf, moved: usize, left: usize },
}

/// Moves the data of the newest previous directory that holds an `app.db` into `current`.
///
/// Does nothing when `current` already has its own `app.db` (this version already ran:
/// never overwrite). Entries that already exist in `current` (the webview may create its
/// own files there before this runs) are left in the old directory, which is removed only
/// when it ends up empty.
pub fn migrate_data_dir(current: &Path, previous: &[&str]) -> io::Result<Outcome> {
    if current.join("app.db").exists() {
        return Ok(Outcome::NothingToDo);
    }
    let Some(parent) = current.parent() else {
        return Ok(Outcome::NothingToDo);
    };
    let Some(from) = previous
        .iter()
        .map(|id| parent.join(id))
        .find(|dir| dir != current && dir.join("app.db").is_file())
    else {
        return Ok(Outcome::NothingToDo);
    };

    fs::create_dir_all(current)?;
    let (mut moved, mut left) = (0, 0);
    for entry in fs::read_dir(&from)? {
        let entry = entry?;
        let target = current.join(entry.file_name());
        // symlink_metadata: a dangling symlink in `current` still counts as taken.
        if fs::symlink_metadata(&target).is_ok() {
            if DISPOSABLE.iter().any(|d| entry.file_name() == *d) {
                remove_entry(&entry.path())?;
            } else {
                left += 1;
            }
            continue;
        }
        fs::rename(entry.path(), &target)?;
        moved += 1;
    }
    if left == 0 {
        // Best effort: something created in the meantime only keeps the directory.
        let _ = fs::remove_dir(&from);
    }
    Ok(Outcome::Moved { from, moved, left })
}

fn remove_entry(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path)?.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

/// After a move: SQLite connections whose file was inside the old data directory (the
/// demo database, for instance) point to the same file in the new one. Returns how many
/// connections were updated.
pub fn rebase_sqlite_paths(store: &ConnectionStore, from: &Path, to: &Path) -> AppResult<usize> {
    let mut updated = 0;
    for mut cfg in store.list()? {
        // Path::starts_with compares whole components: `<old>-backup/x` is not inside `<old>`.
        let rebased = cfg
            .sqlite_path
            .as_deref()
            .and_then(|p| Path::new(p).strip_prefix(from).ok())
            .map(|rest| to.join(rest));
        if let Some(path) = rebased.and_then(|p| p.to_str().map(str::to_owned)) {
            cfg.sqlite_path = Some(path);
            store.upsert(&cfg)?;
            updated += 1;
        }
    }
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::driver::DriverKind;
    use crate::driver::tls::SslConfig;
    use crate::store::{EnvTag, PasswordMode};

    const OLD: &str = "dev.tablemax.app";
    const NEW: &str = "io.github.cemoche.tablemax";

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn moves_the_old_directory_content_and_removes_it() {
        let root = tempfile::tempdir().unwrap();
        let (old, new) = (root.path().join(OLD), root.path().join(NEW));
        write(&old.join("app.db"), "db");
        write(&old.join("settings.json"), "{}");
        write(&old.join("queries").join("q.sql"), "select 1");

        let outcome = migrate_data_dir(&new, &[OLD]).unwrap();

        assert_eq!(outcome, Outcome::Moved { from: old.clone(), moved: 3, left: 0 });
        assert_eq!(read(&new.join("app.db")), "db");
        assert_eq!(read(&new.join("settings.json")), "{}");
        assert_eq!(read(&new.join("queries").join("q.sql")), "select 1");
        assert!(!old.exists(), "the emptied old directory is removed");
    }

    #[test]
    fn never_overwrites_a_current_app_db() {
        let root = tempfile::tempdir().unwrap();
        let (old, new) = (root.path().join(OLD), root.path().join(NEW));
        write(&old.join("app.db"), "old");
        write(&new.join("app.db"), "new");

        assert_eq!(migrate_data_dir(&new, &[OLD]).unwrap(), Outcome::NothingToDo);
        assert_eq!(read(&new.join("app.db")), "new");
        assert_eq!(read(&old.join("app.db")), "old", "the old data is left alone");
    }

    #[test]
    fn keeps_entries_the_webview_already_created() {
        let root = tempfile::tempdir().unwrap();
        let (old, new) = (root.path().join(OLD), root.path().join(NEW));
        write(&old.join("app.db"), "db");
        write(&old.join("localstorage").join("old.sqlite"), "old ui state");
        write(&new.join("localstorage").join("new.sqlite"), "fresh ui state");

        let outcome = migrate_data_dir(&new, &[OLD]).unwrap();

        assert_eq!(outcome, Outcome::Moved { from: old.clone(), moved: 1, left: 1 });
        assert_eq!(read(&new.join("app.db")), "db");
        assert_eq!(read(&new.join("localstorage").join("new.sqlite")), "fresh ui state");
        assert_eq!(read(&old.join("localstorage").join("old.sqlite")), "old ui state");
    }

    #[test]
    fn drops_the_old_copy_of_disposable_webview_entries() {
        let root = tempfile::tempdir().unwrap();
        let (old, new) = (root.path().join(OLD), root.path().join(NEW));
        write(&old.join("app.db"), "db");
        write(&old.join("mediakeys").join("v1").join("salt"), "old salt");
        write(&new.join("mediakeys").join("v1").join("salt"), "new salt");

        let outcome = migrate_data_dir(&new, &[OLD]).unwrap();

        assert_eq!(outcome, Outcome::Moved { from: old.clone(), moved: 1, left: 0 });
        assert_eq!(read(&new.join("mediakeys").join("v1").join("salt")), "new salt");
        assert!(!old.exists(), "nothing worth keeping is left, so the old directory goes");
    }

    #[test]
    fn nothing_without_a_previous_app_db() {
        let root = tempfile::tempdir().unwrap();
        let new = root.path().join(NEW);
        assert_eq!(migrate_data_dir(&new, &[OLD]).unwrap(), Outcome::NothingToDo);
        assert!(!new.exists(), "no directory is created when there is nothing to move");

        // A previous directory without app.db (e.g. only webview files) is not data.
        write(&root.path().join(OLD).join("localstorage").join("x"), "x");
        assert_eq!(migrate_data_dir(&new, &[OLD]).unwrap(), Outcome::NothingToDo);
        assert!(root.path().join(OLD).join("localstorage").join("x").exists());
    }

    #[test]
    fn takes_the_newest_previous_directory_with_data() {
        let root = tempfile::tempdir().unwrap();
        let new = root.path().join(NEW);
        write(&root.path().join("older.id").join("app.db"), "older");
        write(&root.path().join("newer.id").join("app.db"), "newer");

        migrate_data_dir(&new, &["newer.id", "older.id"]).unwrap();

        assert_eq!(read(&new.join("app.db")), "newer");
        assert!(root.path().join("older.id").join("app.db").exists());
    }

    #[test]
    fn ignores_its_own_identifier_in_the_list() {
        let root = tempfile::tempdir().unwrap();
        let new = root.path().join(NEW);
        write(&new.join("settings.json"), "{}");
        assert_eq!(migrate_data_dir(&new, &[NEW]).unwrap(), Outcome::NothingToDo);
    }

    fn sqlite_cfg(id: &str, path: &str) -> crate::store::ConnectionConfig {
        crate::store::ConnectionConfig {
            id: id.into(),
            name: id.into(),
            color: "#fff".into(),
            env_tag: EnvTag::Dev,
            kind: DriverKind::Sqlite,
            host: String::new(),
            port: 0,
            user: String::new(),
            database: None,
            sqlite_path: Some(path.into()),
            password_mode: PasswordMode::None,
            group: None,
            ssl: SslConfig::default(),
            ssh: None,
            safe_mode: None,
            mongo: None,
        }
    }

    #[test]
    fn rebases_sqlite_files_that_were_inside_the_old_directory() {
        let root = tempfile::tempdir().unwrap();
        let (old, new) = (root.path().join(OLD), root.path().join(NEW));
        let store = ConnectionStore::open(&new.join("app.db")).unwrap();
        let inside = old.join("demo").join("shop.sqlite");
        store.upsert(&sqlite_cfg("demo", inside.to_str().unwrap())).unwrap();
        store.upsert(&sqlite_cfg("mine", "/home/u/data/mine.sqlite")).unwrap();
        // A sibling whose name only starts with the old directory's name is not inside it.
        let sibling = root.path().join(format!("{OLD}-backup")).join("x.sqlite");
        store.upsert(&sqlite_cfg("sibling", sibling.to_str().unwrap())).unwrap();

        assert_eq!(rebase_sqlite_paths(&store, &old, &new).unwrap(), 1);

        let path = |id: &str| store.get(id).unwrap().sqlite_path.unwrap();
        assert_eq!(path("demo"), new.join("demo").join("shop.sqlite").to_str().unwrap());
        assert_eq!(path("mine"), "/home/u/data/mine.sqlite");
        assert_eq!(path("sibling"), sibling.to_str().unwrap());
        assert_eq!(rebase_sqlite_paths(&store, &old, &new).unwrap(), 0, "idempotent");
    }
}

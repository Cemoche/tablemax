//! Persisted user settings: `<app_data_dir>/settings.json`, versioned, written atomically.
//! Out-of-range values are clamped to their bounds; an unreadable file gives defaults and
//! is never rewritten by `load`. An editor font family outside the safe grammar
//! (`is_valid_font_family`) is reset to "" (the default font) by `clamped`, on load and on
//! save alike, without touching the other fields.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, ErrorKind};

pub const SETTINGS_VERSION: u32 = 1;
pub const EDITOR_FONT_SIZE: (u32, u32) = (10, 24);
pub const PAGE_SIZE: (u32, u32) = (50, 5000);
pub const EXACT_COUNT_THRESHOLD: (u64, u64) = (10_000, 100_000_000);
pub const AUTO_LIMIT_VALUE: (u32, u32) = (1, 1_000_000);
pub const EDITOR_FONT_FAMILY_MAX: usize = 200;

/// The font families the editor accepts (mirrored by `isValidFontFamily` in
/// src/features/settings/bounds.ts): "" (default font), or comma-separated names, each
/// unquoted (ASCII letters, digits, spaces, `-`, `_`) or wholly quoted with `'` or `"`
/// around the same characters; at most 200 characters. ASCII only on purpose: it keeps
/// the grammar trivially free of anything CSS could read as syntax (`; { } ( ) : / \ < >`,
/// stray quotes, escapes); a font whose name has other characters is not settable yet.
pub fn is_valid_font_family(s: &str) -> bool {
    if s.is_empty() {
        return true;
    }
    if s.len() > EDITOR_FONT_FAMILY_MAX {
        return false;
    }
    let name_ok = |n: &str| {
        !n.trim().is_empty()
            && n.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_')
    };
    s.split(',').all(|part| {
        let p = part.trim_matches(' ');
        let quoted = |q: char| {
            p.len() >= 2 && p.starts_with(q) && p.ends_with(q) && name_ok(&p[1..p.len() - 1])
        };
        name_ok(p) || quoted('\'') || quoted('"')
    })
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub version: u32,
    pub theme: Theme,
    /// Empty = use the `--font-mono` token.
    pub editor_font_family: String,
    pub editor_font_size: u32,
    pub page_size: u32,
    pub exact_count_threshold: u64,
    pub auto_limit_default: bool,
    pub auto_limit_value: u32,
    /// Action id to shortcut; empty = defaults.
    pub keymap: BTreeMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            theme: Theme::System,
            editor_font_family: String::new(),
            editor_font_size: 13,
            page_size: 300,
            exact_count_threshold: 500_000,
            auto_limit_default: false,
            auto_limit_value: 1000,
            keymap: BTreeMap::new(),
        }
    }
}

impl Settings {
    /// Returns these settings with every numeric value brought into its bounds and an
    /// unsafe editor font family replaced by "" (the default font).
    pub fn clamped(mut self) -> Self {
        self.version = SETTINGS_VERSION;
        if !is_valid_font_family(&self.editor_font_family) {
            self.editor_font_family = String::new();
        }
        self.editor_font_size = self.editor_font_size.clamp(EDITOR_FONT_SIZE.0, EDITOR_FONT_SIZE.1);
        self.page_size = self.page_size.clamp(PAGE_SIZE.0, PAGE_SIZE.1);
        self.exact_count_threshold = self
            .exact_count_threshold
            .clamp(EXACT_COUNT_THRESHOLD.0, EXACT_COUNT_THRESHOLD.1);
        self.auto_limit_value = self.auto_limit_value.clamp(AUTO_LIMIT_VALUE.0, AUTO_LIMIT_VALUE.1);
        self
    }
}

/// Reads the settings file. A missing, unreadable or invalid file gives the defaults and
/// is left untouched.
pub fn load(path: &Path) -> Settings {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Settings>(&bytes).ok())
        .map(Settings::clamped)
        .unwrap_or_default()
}

/// Serialises saves: they share one temp file name.
static SAVE_LOCK: Mutex<()> = Mutex::new(());

/// Writes the clamped settings atomically (temp file in the same directory, then rename).
pub fn save(path: &Path, settings: &Settings) -> AppResult<()> {
    let io = |e: std::io::Error| AppError::new(ErrorKind::Io, e.to_string());
    let json = serde_json::to_vec_pretty(&settings.clone().clamped())
        .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?;
    let dir = path
        .parent()
        .ok_or_else(|| AppError::new(ErrorKind::Io, "settings path has no parent directory"))?;
    std::fs::create_dir_all(dir).map_err(io)?;
    // Same directory as the target so the rename stays on one filesystem.
    let tmp = path.with_extension("json.tmp");
    let _guard = SAVE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let result = (|| {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&json)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(io(e));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(dir: &tempfile::TempDir) -> std::path::PathBuf {
        dir.path().join("settings.json")
    }

    #[test]
    fn settings_defaults_and_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load(&path(&dir)), Settings::default());
        let mut s = Settings {
            theme: Theme::Dark,
            editor_font_family: "Fira Code".into(),
            editor_font_size: 16,
            ..Settings::default()
        };
        s.keymap.insert("run".into(), "Mod-Enter".into());
        save(&path(&dir), &s).unwrap();
        assert_eq!(load(&path(&dir)), s);
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path(&dir)).unwrap()).unwrap();
        assert_eq!(raw["version"], 1);
        assert_eq!(raw["theme"], "dark");
        assert_eq!(raw["editorFontSize"], 16);
        assert_eq!(raw["keymap"]["run"], "Mod-Enter");
    }

    #[test]
    fn missing_fields_fall_back_per_field() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path(&dir), r#"{"theme":"light","pageSize":100,"future":1}"#).unwrap();
        let s = load(&path(&dir));
        assert_eq!(s.theme, Theme::Light);
        assert_eq!(s.page_size, 100);
        assert_eq!(s.editor_font_size, 13);
    }

    #[test]
    fn out_of_range_values_are_clamped() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings {
            editor_font_size: 99,
            page_size: 1,
            exact_count_threshold: 5,
            auto_limit_value: 0,
            ..Settings::default()
        };
        save(&path(&dir), &s).unwrap();
        let loaded = load(&path(&dir));
        assert_eq!(loaded.editor_font_size, 24);
        assert_eq!(loaded.page_size, 50);
        assert_eq!(loaded.exact_count_threshold, 10_000);
        assert_eq!(loaded.auto_limit_value, 1);
        // Clamped on load too, for a hand-edited file.
        std::fs::write(path(&dir), r#"{"editorFontSize":2,"pageSize":999999}"#).unwrap();
        let loaded = load(&path(&dir));
        assert_eq!(loaded.editor_font_size, 10);
        assert_eq!(loaded.page_size, 5000);
    }

    #[test]
    fn invalid_file_gives_defaults_and_is_not_overwritten_on_load() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["not json {", r#"{"pageSize":"many"}"#, r#"{"theme":"purple"}"#] {
            std::fs::write(path(&dir), bad).unwrap();
            assert_eq!(load(&path(&dir)), Settings::default());
            assert_eq!(std::fs::read_to_string(path(&dir)).unwrap(), bad);
        }
    }

    #[test]
    fn atomic_write() {
        let dir = tempfile::tempdir().unwrap();
        save(&path(&dir), &Settings::default()).unwrap();
        let s = Settings {
            page_size: 100,
            ..Settings::default()
        };
        save(&path(&dir), &s).unwrap();
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["settings.json".to_string()]);
        assert_eq!(load(&path(&dir)).page_size, 100);
    }

    #[test]
    fn concurrent_saves_leave_a_valid_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = path(&dir);
        let inputs: Vec<Settings> = (0..16)
            .map(|i| Settings {
                page_size: 100 + i,
                ..Settings::default()
            })
            .collect();
        let handles: Vec<_> = inputs
            .iter()
            .cloned()
            .map(|s| {
                let p = p.clone();
                std::thread::spawn(move || save(&p, &s))
            })
            .collect();
        for h in handles {
            h.join().unwrap().unwrap();
        }
        assert!(inputs.contains(&load(&p)));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn font_family_grammar() {
        for ok in [
            "",
            "Fira Code",
            "\"Fira Code\", monospace",
            "JetBrains Mono, monospace",
            "'Source Code Pro',monospace",
            "my_font-2",
        ] {
            assert!(is_valid_font_family(ok), "should accept {ok:?}");
        }
        let too_long = "a".repeat(201);
        for bad in [
            "x; } .a { color: red",
            "url(x)",
            "a:b",
            "\"Fira",
            "'Fira\"",
            "Fira'",
            "a/b",
            "a\\b",
            "<b>",
            "a{b}",
            "a,,b",
            "a,",
            "   ",
            "\"\"",
            "\"a\"b",
            "Fira\nCode",
            too_long.as_str(),
        ] {
            assert!(!is_valid_font_family(bad), "should reject {bad:?}");
        }
        assert!(is_valid_font_family(&"a".repeat(200)));
    }

    #[test]
    fn injected_font_family_resets_only_that_field() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            path(&dir),
            r#"{"theme":"dark","pageSize":100,"editorFontFamily":"x; } .a { color: red"}"#,
        )
        .unwrap();
        let s = load(&path(&dir));
        assert_eq!(s.editor_font_family, "");
        assert_eq!(s.theme, Theme::Dark);
        assert_eq!(s.page_size, 100);
        // settings_set stores what `clamped` returns: the bad family is dropped there too.
        let set = Settings {
            editor_font_family: "url(x)".into(),
            editor_font_size: 16,
            ..Settings::default()
        }
        .clamped();
        assert_eq!(set.editor_font_family, "");
        assert_eq!(set.editor_font_size, 16);
        let kept = Settings {
            editor_font_family: "\"Fira Code\", monospace".into(),
            ..Settings::default()
        }
        .clamped();
        assert_eq!(kept.editor_font_family, "\"Fira Code\", monospace");
    }
}

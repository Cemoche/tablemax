//! Persisted user settings: `<app_data_dir>/settings.json`, versioned, written atomically.
//! Out-of-range values are clamped to their bounds; an unreadable file gives defaults and
//! is never rewritten by `load`.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, ErrorKind};

pub const SETTINGS_VERSION: u32 = 1;
pub const EDITOR_FONT_SIZE: (u32, u32) = (10, 24);
pub const PAGE_SIZE: (u32, u32) = (50, 5000);
pub const EXACT_COUNT_THRESHOLD: (u64, u64) = (10_000, 100_000_000);
pub const AUTO_LIMIT_VALUE: (u32, u32) = (1, 1_000_000);

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
    /// Returns these settings with every numeric value brought into its bounds.
    pub fn clamped(mut self) -> Self {
        self.version = SETTINGS_VERSION;
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
    let mut file = std::fs::File::create(&tmp).map_err(io)?;
    file.write_all(&json).map_err(io)?;
    file.sync_all().map_err(io)?;
    drop(file);
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        io(e)
    })?;
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
        let mut s = Settings::default();
        s.page_size = 100;
        save(&path(&dir), &s).unwrap();
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["settings.json".to_string()]);
        assert_eq!(load(&path(&dir)).page_size, 100);
    }
}

//! Persisted user settings: `<app_data_dir>/settings.json`, versioned, written atomically.
//! Out-of-range values are clamped to their bounds; an unreadable file gives defaults and
//! is never rewritten by `load`. An editor font family outside the safe grammar
//! (`is_valid_font_family`) is reset to "" (the default font) by `clamped`, on load and on
//! save alike, without touching the other fields. Keymap entries with an unknown action id
//! or a spec outside the shortcut grammar (`is_valid_shortcut`) are dropped one by one; a
//! malformed keymap never makes the load fail.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult, ErrorKind};

pub const SETTINGS_VERSION: u32 = 1;
pub const EDITOR_FONT_SIZE: (u32, u32) = (10, 24);
/// Font size of the data (grid, sidebar tree), same bounds as the editor's.
pub const DATA_FONT_SIZE: (u32, u32) = (10, 24);
/// Native webview zoom of the whole interface, 90 % to 130 % in steps of 5 %.
pub const INTERFACE_SCALE: (f32, f32) = (0.9, 1.3);
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

/// The action ids a keymap entry may name, in the order of `src/lib/keymap-actions.json`
/// (a test checks both lists against that file; the frontend registry is src/lib/keymap.ts).
pub const KEYMAP_ACTION_IDS: &[&str] = &[
    "query.new",
    "tab.close",
    "tab.next",
    "tab.previous",
    "palette.all",
    "settings.open",
    "query.save",
    "history.toggle",
    "editor.run",
    "editor.runAll",
    "editor.format",
    "editor.comment",
    "grid.commit",
    "grid.rowDetails",
    "grid.viewData",
    "grid.viewStructure",
    "grid.back",
    "font.increase",
    "font.decrease",
    "database.open",
    "editor.open",
    "workspace.reload",
];
/// At most this many keymap entries are kept (defensive: one per known id fits well below).
pub const KEYMAP_MAX_ENTRIES: usize = 64;
/// Longest shortcut spec accepted.
pub const KEYMAP_SPEC_MAX: usize = 32;

/// The canonical shortcut grammar (mirrored by `isValidShortcut` in src/lib/keymap.ts):
/// `Modifier+…+Key`, modifiers among `Mod`, `Ctrl`, `Meta`, `Alt`, `Shift`, each at most
/// once, in any order; the key is one uppercase ASCII letter or digit, one of
/// `` , . / ; - = [ ] \ ` ``, or a named key (`Enter`, `Tab`, `Escape`, `Space`,
/// `Backspace`, `Delete`, `ArrowUp`/`Down`/`Left`/`Right`, `F1`–`F12`). At least one of
/// `Mod`, `Ctrl`, `Meta`, `Alt` unless the key is F1–F12 (Shift alone is not enough); at most
/// 32 characters, ASCII only.
pub fn is_valid_shortcut(spec: &str) -> bool {
    if spec.is_empty() || spec.len() > KEYMAP_SPEC_MAX || !spec.is_ascii() {
        return false;
    }
    let mut parts: Vec<&str> = spec.split('+').collect();
    let Some(key) = parts.pop() else {
        return false;
    };
    let mut seen: Vec<&str> = Vec::new();
    for m in parts {
        if !matches!(m, "Mod" | "Ctrl" | "Meta" | "Alt" | "Shift") || seen.contains(&m) {
            return false;
        }
        seen.push(m);
    }
    let function_key = key
        .strip_prefix('F')
        .and_then(|n| if n.starts_with('0') { None } else { n.parse::<u8>().ok() })
        .is_some_and(|n| (1..=12).contains(&n));
    let char_key = key.len() == 1
        && key.chars().all(|c| {
            c.is_ascii_uppercase() || c.is_ascii_digit() || ",./;-=[]\\`".contains(c)
        });
    let named_key = matches!(
        key,
        "Enter"
            | "Tab"
            | "Escape"
            | "Space"
            | "Backspace"
            | "Delete"
            | "ArrowUp"
            | "ArrowDown"
            | "ArrowLeft"
            | "ArrowRight"
    );
    // Shift alone is not enough (it would take an uppercase letter or reverse Tab away).
    (function_key || char_key || named_key) && (function_key || seen.iter().any(|m| *m != "Shift"))
}

/// The entries of `keymap` with a known action id and a valid spec, at most `max` of them.
fn clean_keymap(keymap: BTreeMap<String, String>, max: usize) -> BTreeMap<String, String> {
    keymap
        .into_iter()
        .filter(|(id, spec)| KEYMAP_ACTION_IDS.contains(&id.as_str()) && is_valid_shortcut(spec))
        .take(max)
        .collect()
}

/// Reads `keymap` leniently: an object keeps its string values (other values and any
/// non-object give nothing), so one bad entry never makes the whole file unreadable.
fn lenient_keymap<'de, D>(deserializer: D) -> Result<BTreeMap<String, String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(match value {
        serde_json::Value::Object(map) => map
            .into_iter()
            .filter_map(|(k, v)| match v {
                serde_json::Value::String(s) => Some((k, s)),
                _ => None,
            })
            .collect(),
        _ => BTreeMap::new(),
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

// PartialEq only: `interface_scale` is a float.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    /// Action id to shortcut; empty = defaults. Cleaned by `clamped` (`clean_keymap`).
    #[serde(deserialize_with = "lenient_keymap")]
    pub keymap: BTreeMap<String, String>,
    /// Zoom factor of the whole interface (`commands::window_set_zoom`); 1.0 = 100 %.
    pub interface_scale: f32,
    /// Font size of the data: grid and sidebar tree.
    pub data_font_size: u32,
    /// Native window decorations instead of the frameless window with the toolbar as its
    /// title bar; applied at startup (`commands::apply_window_settings`).
    pub use_system_title_bar: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: SETTINGS_VERSION,
            theme: Theme::System,
            editor_font_family: String::new(),
            editor_font_size: 13,
            page_size: 300,
            exact_count_threshold: crate::value::EXACT_COUNT_THRESHOLD,
            auto_limit_default: false,
            auto_limit_value: 1000,
            keymap: BTreeMap::new(),
            interface_scale: 1.0,
            data_font_size: 13,
            use_system_title_bar: false,
        }
    }
}

impl Settings {
    /// Returns these settings with every numeric value brought into its bounds (the
    /// interface scale also on a 5 % step), an unsafe editor font family replaced by ""
    /// (the default font) and the keymap entries with an unknown action id or an invalid
    /// spec dropped (at most 64 kept).
    pub fn clamped(mut self) -> Self {
        self.version = SETTINGS_VERSION;
        self.keymap = clean_keymap(std::mem::take(&mut self.keymap), KEYMAP_MAX_ENTRIES);
        if !is_valid_font_family(&self.editor_font_family) {
            self.editor_font_family = String::new();
        }
        self.editor_font_size = self.editor_font_size.clamp(EDITOR_FONT_SIZE.0, EDITOR_FONT_SIZE.1);
        self.data_font_size = self.data_font_size.clamp(DATA_FONT_SIZE.0, DATA_FONT_SIZE.1);
        self.interface_scale = clamp_interface_scale(self.interface_scale);
        self.page_size = self.page_size.clamp(PAGE_SIZE.0, PAGE_SIZE.1);
        self.exact_count_threshold = self
            .exact_count_threshold
            .clamp(EXACT_COUNT_THRESHOLD.0, EXACT_COUNT_THRESHOLD.1);
        self.auto_limit_value = self.auto_limit_value.clamp(AUTO_LIMIT_VALUE.0, AUTO_LIMIT_VALUE.1);
        self
    }
}

/// `scale` within `INTERFACE_SCALE`, on a 5 % step; 1.0 when it is not a number.
pub fn clamp_interface_scale(scale: f32) -> f32 {
    if !scale.is_finite() {
        return 1.0;
    }
    ((scale.clamp(INTERFACE_SCALE.0, INTERFACE_SCALE.1) * 20.0).round() / 20.0)
        .clamp(INTERFACE_SCALE.0, INTERFACE_SCALE.1)
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
        s.keymap.insert("editor.run".into(), "Mod+Enter".into());
        save(&path(&dir), &s).unwrap();
        assert_eq!(load(&path(&dir)), s);
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path(&dir)).unwrap()).unwrap();
        assert_eq!(raw["version"], 1);
        assert_eq!(raw["theme"], "dark");
        assert_eq!(raw["editorFontSize"], 16);
        assert_eq!(raw["keymap"]["editor.run"], "Mod+Enter");
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
    fn interface_scale_and_data_font_size_clamped() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings {
            interface_scale: 3.0,
            data_font_size: 99,
            ..Settings::default()
        };
        save(&path(&dir), &s).unwrap();
        let loaded = load(&path(&dir));
        assert_eq!(loaded.interface_scale, 1.3);
        assert_eq!(loaded.data_font_size, 24);
        // Hand-edited file: clamped on load, and the scale snaps to a 5 % step.
        std::fs::write(path(&dir), r#"{"interfaceScale":0.2,"dataFontSize":2}"#).unwrap();
        let loaded = load(&path(&dir));
        assert_eq!(loaded.interface_scale, 0.9);
        assert_eq!(loaded.data_font_size, 10);
        let snapped = Settings {
            interface_scale: 1.12,
            ..Settings::default()
        }
        .clamped();
        assert_eq!(snapped.interface_scale, 1.1);
        let not_a_number = Settings {
            interface_scale: f32::NAN,
            ..Settings::default()
        }
        .clamped();
        assert_eq!(not_a_number.interface_scale, 1.0);
        // On the wire (JSON text) the scale stays a round number, not 1.149999976….
        let json = serde_json::to_string(&Settings {
            interface_scale: 1.15,
            ..Settings::default()
        })
        .unwrap();
        assert!(json.contains(r#""interfaceScale":1.15,"#), "{json}");
        assert!(json.contains(r#""dataFontSize":13"#), "{json}");
    }

    #[test]
    fn old_settings_get_new_defaults() {
        let dir = tempfile::tempdir().unwrap();
        // A file written before the interface size and the data font size existed.
        std::fs::write(
            path(&dir),
            r#"{"version":1,"theme":"dark","editorFontFamily":"","editorFontSize":16,"pageSize":300,
                "exactCountThreshold":500000,"autoLimitDefault":false,"autoLimitValue":1000,"keymap":{}}"#,
        )
        .unwrap();
        let s = load(&path(&dir));
        assert_eq!(s.theme, Theme::Dark);
        assert_eq!(s.editor_font_size, 16, "saved editor size kept");
        assert_eq!(s.interface_scale, 1.0);
        assert_eq!(s.data_font_size, 13);
    }

    #[test]
    fn system_title_bar_defaults_off_and_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!Settings::default().use_system_title_bar);
        // A file written before the setting existed keeps the frameless window.
        std::fs::write(path(&dir), r#"{"version":1,"theme":"dark"}"#).unwrap();
        assert!(!load(&path(&dir)).use_system_title_bar);
        let s = Settings {
            use_system_title_bar: true,
            ..Settings::default()
        };
        save(&path(&dir), &s).unwrap();
        assert!(load(&path(&dir)).use_system_title_bar);
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path(&dir)).unwrap()).unwrap();
        assert_eq!(raw["useSystemTitleBar"], true);
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

    #[test]
    fn keymap_action_ids_match_the_shared_fixture() {
        // The frontend registry (src/lib/keymap.ts) is checked against the same file.
        let fixture: Vec<String> =
            serde_json::from_str(include_str!("../../src/lib/keymap-actions.json")).unwrap();
        assert_eq!(KEYMAP_ACTION_IDS.to_vec(), fixture);
    }

    #[test]
    fn shortcut_grammar() {
        for ok in [
            "Mod+K",
            "Ctrl+Shift+Tab",
            "Shift+Mod+F",
            "Meta+Alt+Ctrl+Shift+Z",
            "Mod+,",
            "Mod+.",
            "Mod+/",
            "Mod+;",
            "Mod+-",
            "Mod+=",
            "Mod+[",
            "Mod+]",
            "Mod+\\",
            "Mod+`",
            "Alt+1",
            "Ctrl+0",
            "Mod+Enter",
            "Alt+Tab",
            "Ctrl+Escape",
            "Ctrl+Space",
            "Mod+Backspace",
            "Mod+Delete",
            "Alt+ArrowUp",
            "Alt+ArrowDown",
            "Alt+ArrowLeft",
            "Alt+ArrowRight",
            "F5",
            "F12",
            "Shift+F1",
            "Meta+Ctrl+Alt+Shift+Mod+ArrowUp",
        ] {
            assert!(is_valid_shortcut(ok), "should accept {ok:?}");
        }
        for bad in [
            "",
            "K",
            "Enter",
            "1",
            "Mod",
            "Mod+",
            "+K",
            "Mod++",
            "Mod+k",
            "mod+K",
            "Cmd+K",
            "Mod+Mod+K",
            "Ctrl+Shift+Shift+K",
            "Mod-Enter",
            "Mod+KK",
            "Mod+F13",
            "Mod+F0",
            "F",
            "Mod+Home",
            "Mod+\u{e9}",
            "Mod+ K",
            "Mod+K ",
            "Mod+<",
            "Mod+'",
            "Mod+\"",
            "Ctrl+Meta+Alt+Shift+Mod+ArrowRight+",
            "Meta+Ctrl+Alt+Shift+Mod+Backspace",
        ] {
            assert!(!is_valid_shortcut(bad), "should reject {bad:?}");
        }
    }

    #[test]
    fn shift_alone_is_not_a_modifier_except_on_a_function_key() {
        for bad in [
            "Shift+K",
            "Shift+Tab",
            "Shift+1",
            "Shift+Enter",
            "Shift+/",
            "Shift+ArrowUp",
        ] {
            assert!(!is_valid_shortcut(bad), "should reject {bad:?}");
        }
        for ok in [
            "Shift+F5",
            "Mod+Shift+K",
            "Ctrl+Shift+Tab",
            "Alt+Shift+1",
            "Meta+Shift+Enter",
        ] {
            assert!(is_valid_shortcut(ok), "should accept {ok:?}");
        }
    }

    #[test]
    fn clamped_drops_unknown_ids_and_invalid_specs() {
        let mut s = Settings {
            page_size: 100,
            ..Settings::default()
        };
        s.keymap.insert("editor.run".into(), "Mod+Shift+R".into());
        s.keymap.insert("grid.commit".into(), "Mod-S".into());
        s.keymap.insert("unknown.action".into(), "Mod+U".into());
        s.keymap.insert("query.new".into(), "Mod+<script>".into());
        let c = s.clamped();
        assert_eq!(
            c.keymap,
            BTreeMap::from([("editor.run".to_string(), "Mod+Shift+R".to_string())])
        );
        assert_eq!(c.page_size, 100);
    }

    #[test]
    fn keymap_keeps_at_most_the_cap() {
        let all: BTreeMap<String, String> = KEYMAP_ACTION_IDS
            .iter()
            .map(|id| (id.to_string(), "F5".to_string()))
            .collect();
        assert_eq!(clean_keymap(all.clone(), KEYMAP_MAX_ENTRIES).len(), KEYMAP_ACTION_IDS.len());
        assert_eq!(clean_keymap(all, 2).len(), 2);
        // Hundreds of junk entries cost nothing: none survive.
        let junk: BTreeMap<String, String> =
            (0..500).map(|i| (format!("x{i}"), "Mod+K".to_string())).collect();
        assert!(clean_keymap(junk, KEYMAP_MAX_ENTRIES).is_empty());
        assert!(KEYMAP_ACTION_IDS.len() <= KEYMAP_MAX_ENTRIES);
    }

    #[test]
    fn a_bad_keymap_never_fails_the_load() {
        let dir = tempfile::tempdir().unwrap();
        for (raw, kept) in [
            (r#"{"pageSize":100,"keymap":{"editor.run":"Mod+R","grid.commit":5}}"#, 1),
            (r#"{"pageSize":100,"keymap":{"editor.run":"Mod+R","nope":"Mod+N","query.new":"Mod-N"}}"#, 1),
            (r#"{"pageSize":100,"keymap":["editor.run"]}"#, 0),
            (r#"{"pageSize":100,"keymap":"Mod+K"}"#, 0),
            (r#"{"pageSize":100,"keymap":null}"#, 0),
        ] {
            std::fs::write(path(&dir), raw).unwrap();
            let s = load(&path(&dir));
            assert_eq!(s.page_size, 100, "{raw}");
            assert_eq!(s.keymap.len(), kept, "{raw}");
            if kept == 1 {
                assert_eq!(s.keymap["editor.run"], "Mod+R");
            }
        }
    }
}

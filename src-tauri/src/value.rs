use serde::{Deserialize, Serialize};

pub const DEFAULT_PAGE_SIZE: u32 = 300;
pub const EXACT_COUNT_THRESHOLD: u64 = 500_000;
/// A filtered count stops at this many rows (one past the threshold: "500,000+").
pub const FILTERED_COUNT_CAP: u64 = EXACT_COUNT_THRESHOLD + 1;
pub const TEXT_PREVIEW_CHARS: usize = 10_000;
pub const BYTES_PREVIEW: usize = 64;
/// Hard cap on the rows a SQL-tab statement returns (`ResultSet::truncated` when hit).
pub const MAX_RESULT_ROWS: usize = 10_000;
/// Largest integer magnitude a JavaScript number holds exactly (2^53 - 1).
pub const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "t", content = "v", rename_all = "camelCase")]
pub enum CellValue {
    Null,
    Bool(bool),
    Int(i64),
    BigInt(String),
    Float(f64),
    Decimal(String),
    Text(String),
    LongText {
        preview: String,
        len: u64,
    },
    #[serde(rename_all = "camelCase")]
    Bytes {
        len: u64,
        hex_preview: String,
    },
    Json(String),
    Temporal(String),
}

/// Integer cell. Values outside JavaScript's safe range travel as exact digits
/// (`BigInt`), since the frontend would round a JSON number above 2^53.
pub fn int_value(v: i64) -> CellValue {
    if v.unsigned_abs() > JS_MAX_SAFE_INTEGER {
        CellValue::BigInt(v.to_string())
    } else {
        CellValue::Int(v)
    }
}

/// JSON cell; above `TEXT_PREVIEW_CHARS` characters it becomes `LongText` like text.
pub fn json_value(s: String) -> CellValue {
    match text_value(s) {
        CellValue::Text(s) => CellValue::Json(s),
        long => long,
    }
}

/// Text cell; truncated to `TEXT_PREVIEW_CHARS` characters (never splits a char).
pub fn text_value(s: String) -> CellValue {
    match s.char_indices().nth(TEXT_PREVIEW_CHARS) {
        None => CellValue::Text(s),
        Some((cut, _)) => CellValue::LongText {
            preview: s[..cut].to_string(),
            len: s.chars().count() as u64,
        },
    }
}

pub fn bytes_value(b: &[u8]) -> CellValue {
    use std::fmt::Write;
    let mut hex_preview = String::with_capacity(BYTES_PREVIEW * 2);
    for byte in b.iter().take(BYTES_PREVIEW) {
        let _ = write!(hex_preview, "{byte:02x}");
    }
    CellValue::Bytes {
        len: b.len() as u64,
        hex_preview,
    }
}

pub fn float_value(f: f64) -> CellValue {
    if f.is_finite() {
        CellValue::Float(f)
    } else if f.is_nan() {
        CellValue::Text("NaN".into())
    } else if f > 0.0 {
        CellValue::Text("Infinity".into())
    } else {
        CellValue::Text("-Infinity".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_text_is_truncated() {
        let v = text_value("é".repeat(TEXT_PREVIEW_CHARS + 5));
        assert!(
            matches!(v, CellValue::LongText { ref preview, len } if preview.chars().count() == TEXT_PREVIEW_CHARS && len == (TEXT_PREVIEW_CHARS + 5) as u64)
        );
    }
    #[test]
    fn bytes_preview_and_non_finite_floats() {
        assert_eq!(
            bytes_value(&[0xde, 0xad, 0x00]),
            CellValue::Bytes {
                len: 3,
                hex_preview: "dead00".into()
            }
        );
        assert_eq!(float_value(f64::NAN), CellValue::Text("NaN".into()));
    }
    #[test]
    fn int_value_keeps_js_safe_range_as_int() {
        const MAX_SAFE: i64 = 9_007_199_254_740_991; // 2^53 - 1
        assert_eq!(int_value(0), CellValue::Int(0));
        assert_eq!(int_value(MAX_SAFE), CellValue::Int(MAX_SAFE));
        assert_eq!(int_value(-MAX_SAFE), CellValue::Int(-MAX_SAFE));
        assert_eq!(
            int_value(MAX_SAFE + 1),
            CellValue::BigInt("9007199254740992".into())
        );
        assert_eq!(
            int_value(-MAX_SAFE - 1),
            CellValue::BigInt("-9007199254740992".into())
        );
        assert_eq!(
            int_value(i64::MAX),
            CellValue::BigInt("9223372036854775807".into())
        );
        assert_eq!(
            int_value(i64::MIN),
            CellValue::BigInt("-9223372036854775808".into())
        );
        assert_eq!(
            serde_json::to_string(&int_value(i64::MAX)).unwrap(),
            r#"{"t":"bigInt","v":"9223372036854775807"}"#
        );
    }
    #[test]
    fn json_value_is_capped_like_text() {
        assert_eq!(json_value("{}".into()), CellValue::Json("{}".into()));
        let exact = format!("\"{}\"", "a".repeat(TEXT_PREVIEW_CHARS - 2));
        assert_eq!(json_value(exact.clone()), CellValue::Json(exact));
        let big = format!("[\"{}\"]", "é".repeat(TEXT_PREVIEW_CHARS));
        let n = big.chars().count() as u64;
        assert!(
            matches!(json_value(big), CellValue::LongText { ref preview, len } if preview.chars().count() == TEXT_PREVIEW_CHARS && len == n)
        );
    }
    #[test]
    fn cell_value_serializes_tagged() {
        assert_eq!(
            serde_json::to_string(&CellValue::BigInt("18446744073709551615".into())).unwrap(),
            r#"{"t":"bigInt","v":"18446744073709551615"}"#
        );
        assert_eq!(
            serde_json::to_string(&CellValue::Null).unwrap(),
            r#"{"t":"null"}"#
        );
    }
}

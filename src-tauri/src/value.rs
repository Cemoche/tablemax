use serde::{Deserialize, Serialize};

pub const DEFAULT_PAGE_SIZE: u32 = 300;
pub const EXACT_COUNT_THRESHOLD: u64 = 500_000;
pub const TEXT_PREVIEW_CHARS: usize = 10_000;
pub const BYTES_PREVIEW: usize = 64;

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

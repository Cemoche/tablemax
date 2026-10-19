//! Experimental features, switched on by the `TABLEMAX_EXPERIMENTAL` environment variable
//! (a comma-separated list such as `mongodb`). Until MongoDB leaves this state it exists
//! for the user only when the variable names it.

use serde::Serialize;

use crate::error::{AppError, AppResult, ErrorKind};

pub const ENV_VAR: &str = "TABLEMAX_EXPERIMENTAL";

/// Whether `feature` is named in `value`, a comma-separated list (spaces are ignored).
pub fn experimental_in(value: Option<&str>, feature: &str) -> bool {
    value.is_some_and(|v| v.split(',').any(|f| f.trim() == feature))
}

/// Whether `feature` is switched on by `TABLEMAX_EXPERIMENTAL`.
pub fn experimental(feature: &str) -> bool {
    experimental_in(std::env::var(ENV_VAR).ok().as_deref(), feature)
}

/// Refuses a MongoDB connection while the feature is off (`enabled` is
/// `experimental("mongodb")`).
pub fn ensure_mongodb_enabled(enabled: bool) -> AppResult<()> {
    if enabled {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorKind::Invalid,
            format!("MongoDB support is experimental and switched off; set {ENV_VAR}=mongodb to use it"),
        ))
    }
}

/// What the interface may offer, from the experimental flags.
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppFlags {
    pub mongodb: bool,
}

pub fn app_flags() -> AppFlags {
    AppFlags {
        mongodb: experimental("mongodb"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;

    #[test]
    fn experimental_flag_parsing() {
        assert!(experimental_in(Some("mongodb"), "mongodb"));
        assert!(experimental_in(Some(" sql , mongodb "), "mongodb"));
        assert!(!experimental_in(Some(""), "mongodb"));
        assert!(!experimental_in(None, "mongodb"));
        assert!(!experimental_in(Some("mongodb2,xmongodb"), "mongodb"));
    }

    #[test]
    fn ensure_mongodb_enabled_refuses_when_off() {
        assert!(ensure_mongodb_enabled(true).is_ok());
        let err = ensure_mongodb_enabled(false).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
        assert!(err.message.contains("MongoDB support is experimental"));
    }
}

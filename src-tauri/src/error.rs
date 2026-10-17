use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    Connection,
    Auth,
    Query,
    Cancelled,
    ConnectionLost,
    NotFound,
    Secret,
    Io,
    Invalid,
    HostKeyUnknown,
    HostKeyChanged,
}

#[derive(Debug, thiserror::Error, Serialize)]
#[error("{message}")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    /// The SSH server (`host:port`, after `~/.ssh/config`) a `HostKeyUnknown` /
    /// `HostKeyChanged` error is about: the name its key is checked and stored under.
    /// Serialized only when set, so every other error keeps the `{kind, message}` shape.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            host: None,
        }
    }

    pub fn with_host(mut self, host: impl Into<String>) -> Self {
        self.host = Some(host.into());
        self
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_is_serialized_only_when_set() {
        let plain = AppError::new(ErrorKind::Auth, "password required");
        assert_eq!(
            serde_json::to_string(&plain).unwrap(),
            r#"{"kind":"auth","message":"password required"}"#
        );
        let hk = AppError::new(ErrorKind::HostKeyUnknown, "SHA256:x").with_host("db.example:2222");
        assert_eq!(
            serde_json::to_string(&hk).unwrap(),
            r#"{"kind":"hostKeyUnknown","message":"SHA256:x","host":"db.example:2222"}"#
        );
    }
}

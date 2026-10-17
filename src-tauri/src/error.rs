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
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;

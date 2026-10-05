use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Every failure a command can report to the webview.
///
/// Serialised as `{ code, message }`. The code is stable and machine-readable; the message is for
/// people. Internal detail that could help an attacker is never included.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("The session is locked")]
    SessionLocked,

    #[error("Statement rejected: {0}")]
    StatementRejected(String),

    #[error("Unsupported value: {0}")]
    UnsupportedValue(String),

    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("Migration error: {0}")]
    Migration(String),

    #[error("Export refused: {0}")]
    ExportRejected(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Internal error: {0}")]
    Internal(String),
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::SessionLocked => "session_locked",
            AppError::StatementRejected(_) => "statement_rejected",
            AppError::UnsupportedValue(_) => "unsupported_value",
            AppError::Database(_) => "database",
            AppError::Migration(_) => "migration",
            AppError::ExportRejected(_) => "export_rejected",
            AppError::Io(_) => "io",
            AppError::Internal(_) => "internal",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;

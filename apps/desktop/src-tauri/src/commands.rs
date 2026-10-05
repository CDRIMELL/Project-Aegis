//! Commands callable from the webview. Each one states its trust assumption by going through
//! [`AppState::database`], which enforces the session gate (ADR 0010).

use serde::Serialize;
use tauri::State;

use crate::db::{QueryResult, Statement};
use crate::error::AppResult;
use crate::export::{write_export, ExportResult};
use crate::AppState;

#[tauri::command(async)]
pub fn db_query(state: State<'_, AppState>, statement: Statement) -> AppResult<QueryResult> {
    state.database()?.query(&statement)
}

#[tauri::command(async)]
pub fn db_batch(
    state: State<'_, AppState>,
    statements: Vec<Statement>,
) -> AppResult<Vec<QueryResult>> {
    state.database()?.batch(&statements)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: &'static str,
    database_path: Option<String>,
    schema_migrations: usize,
    sqlite_version: &'static str,
    encryption: &'static str,
    session_unlocked: bool,
}

/// Diagnostic facts about this build and its storage. Readable while locked: it exposes no data.
#[tauri::command(async)]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        database_path: state
            .db
            .path()
            .map(|path| path.to_string_lossy().into_owned()),
        schema_migrations: state.schema_migrations,
        sqlite_version: state.db.sqlite_version(),
        encryption: state.db.encryption().label(),
        session_unlocked: state.gate.is_unlocked(),
    }
}

/// Writes a report the webview has built to the exports folder (ADR 0025). Gated like the data
/// it was built from. The name is validated natively; the webview cannot choose where it goes.
#[tauri::command(async)]
pub fn export_report(
    state: State<'_, AppState>,
    file_name: String,
    contents: String,
) -> AppResult<ExportResult> {
    state.gate.ensure_unlocked()?;
    write_export(&state.data_dir, &file_name, &contents)
}

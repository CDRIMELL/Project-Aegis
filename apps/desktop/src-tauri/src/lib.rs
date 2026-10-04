//! AEGIS native core.
//!
//! Responsibilities: own the SQLite connection, apply migrations, enforce the session gate and
//! expose a deliberately small command surface. Simulation rules do not live here (ADR 0002).

mod commands;
mod db;
mod error;
mod security;

use tauri::Manager;

use db::{Database, Encryption, OpenOptions};
use error::AppResult;
use security::SessionGate;

const DATABASE_FILE: &str = "aegis.db";
const BACKUP_DIR: &str = "backups";

pub struct AppState {
    db: Database,
    gate: SessionGate,
    schema_migrations: usize,
}

impl AppState {
    /// The only way a command reaches persistent data.
    fn database(&self) -> AppResult<&Database> {
        self.gate.ensure_unlocked()?;
        Ok(&self.db)
    }
}

fn initialise(app: &tauri::App) -> Result<AppState, Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    let db = Database::open(OpenOptions {
        path: data_dir.join(DATABASE_FILE),
        encryption: Encryption::None,
    })?;
    let report = db.migrate(Some(&data_dir.join(BACKUP_DIR)))?;

    let gate = SessionGate::new();
    // No authentication exists yet; phase 9 replaces this call with a login flow (ADR 0010).
    gate.open_without_authentication();

    Ok(AppState {
        db,
        gate,
        schema_migrations: report.total,
    })
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state = initialise(app)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::db_query,
            commands::db_batch,
            commands::app_info,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start AEGIS");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;

    #[test]
    fn data_is_unreachable_while_the_session_is_locked() {
        let state = AppState {
            db: Database::open_in_memory().unwrap(),
            gate: SessionGate::new(),
            schema_migrations: 0,
        };
        assert!(matches!(state.database(), Err(AppError::SessionLocked)));

        state.gate.open_without_authentication();
        assert!(state.database().is_ok());

        state.gate.lock();
        assert!(matches!(state.database(), Err(AppError::SessionLocked)));
    }
}

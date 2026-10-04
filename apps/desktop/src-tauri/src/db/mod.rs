//! The persistence core: one SQLite connection, owned here and nowhere else (ADR 0003).

mod guard;
pub mod migrations;
mod value;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{params_from_iter, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use crate::error::{AppError, AppResult};
use migrations::{Migration, MigrationReport};

/// How the database file is protected at rest.
///
/// Only `None` exists today. An encrypted variant carrying key material is added in the security
/// phase; because every caller goes through [`OpenOptions`], nothing else has to change (ADR 0010).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum Encryption {
    #[default]
    None,
}

impl Encryption {
    pub fn label(self) -> &'static str {
        match self {
            Encryption::None => "none",
        }
    }
}

#[derive(Debug, Clone)]
pub struct OpenOptions {
    pub path: PathBuf,
    pub encryption: Encryption,
}

/// How the caller wants the result shaped. Mirrors Drizzle's `sqlite-proxy` contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    Run,
    All,
    Values,
    Get,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Statement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<JsonValue>,
    pub method: Method,
}

/// Rows are arrays of column values. For [`Method::Get`], `rows` is the single row itself, or
/// `null` when nothing matched. For [`Method::Run`] it is an empty array.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QueryResult {
    pub rows: JsonValue,
}

pub struct Database {
    conn: Mutex<Connection>,
    path: Option<PathBuf>,
    encryption: Encryption,
}

impl Database {
    pub fn open(options: OpenOptions) -> AppResult<Self> {
        if let Some(parent) = options.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = match options.encryption {
            Encryption::None => Connection::open(&options.path)?,
        };
        // WAL keeps the file consistent if the process dies mid-write; with NORMAL sync a power
        // loss can drop the most recent transactions but cannot corrupt the database.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        Self::configure(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: Some(options.path),
            encryption: options.encryption,
        })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> AppResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::configure(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
            path: None,
            encryption: Encryption::None,
        })
    }

    fn configure(conn: &Connection) -> AppResult<()> {
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(Duration::from_secs(5))?;
        Ok(())
    }

    fn lock(&self) -> AppResult<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| AppError::Internal("database connection lock was poisoned".into()))
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    pub fn encryption(&self) -> Encryption {
        self.encryption
    }

    pub fn sqlite_version(&self) -> &'static str {
        rusqlite::version()
    }

    /// Applies embedded migrations, backing the file up first if it already holds data.
    pub fn migrate(&self, backup_dir: Option<&Path>) -> AppResult<MigrationReport> {
        self.migrate_with(&migrations::embedded()?, backup_dir)
    }

    pub fn migrate_with(
        &self,
        migrations: &[Migration],
        backup_dir: Option<&Path>,
    ) -> AppResult<MigrationReport> {
        migrations::run(&mut *self.lock()?, migrations, backup_dir)
    }

    /// Runs one statement.
    pub fn query(&self, statement: &Statement) -> AppResult<QueryResult> {
        execute(&*self.lock()?, statement)
    }

    /// Runs every statement in one transaction. If any statement fails, none take effect.
    pub fn batch(&self, statements: &[Statement]) -> AppResult<Vec<QueryResult>> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let results = statements
            .iter()
            .map(|statement| execute(&tx, statement))
            .collect::<AppResult<Vec<_>>>()?;
        tx.commit()?;
        Ok(results)
    }
}

fn execute(conn: &Connection, statement: &Statement) -> AppResult<QueryResult> {
    guard::check(&statement.sql)?;

    let params = statement
        .params
        .iter()
        .map(value::to_sql)
        .collect::<AppResult<Vec<_>>>()?;
    let mut prepared = conn.prepare_cached(&statement.sql)?;

    if statement.method == Method::Run {
        prepared.execute(params_from_iter(params))?;
        return Ok(QueryResult {
            rows: JsonValue::Array(Vec::new()),
        });
    }

    let column_count = prepared.column_count();
    let mut rows = prepared.query(params_from_iter(params))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut values = Vec::with_capacity(column_count);
        for index in 0..column_count {
            values.push(value::from_sql(row.get_ref(index)?)?);
        }
        out.push(JsonValue::Array(values));
        if statement.method == Method::Get {
            break;
        }
    }

    Ok(QueryResult {
        rows: match statement.method {
            Method::Get => out.into_iter().next().unwrap_or(JsonValue::Null),
            _ => JsonValue::Array(out),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn statement(sql: &str, params: JsonValue, method: Method) -> Statement {
        Statement {
            sql: sql.into(),
            params: params.as_array().cloned().unwrap_or_default(),
            method,
        }
    }

    fn database() -> Database {
        let database = Database::open_in_memory().unwrap();
        database.migrate(None).unwrap();
        database
    }

    const INSERT_CLOCK: &str =
        "INSERT INTO sim_clock (id, sim_time_ms, tick, speed, running) VALUES (1, ?, ?, ?, ?)";

    #[test]
    fn shapes_results_per_method() {
        let db = database();
        db.query(&statement(
            INSERT_CLOCK,
            json!([1000, 1, 10, true]),
            Method::Run,
        ))
        .unwrap();

        let select = "SELECT tick, speed, running FROM sim_clock WHERE id = ?";
        assert_eq!(
            db.query(&statement(select, json!([1]), Method::All))
                .unwrap()
                .rows,
            json!([[1, 10, 1]])
        );
        assert_eq!(
            db.query(&statement(select, json!([1]), Method::Values))
                .unwrap()
                .rows,
            json!([[1, 10, 1]])
        );
        assert_eq!(
            db.query(&statement(select, json!([1]), Method::Get))
                .unwrap()
                .rows,
            json!([1, 10, 1])
        );
        assert_eq!(
            db.query(&statement(select, json!([2]), Method::Get))
                .unwrap()
                .rows,
            json!(null)
        );
    }

    #[test]
    fn batch_commits_all_statements_together() {
        let db = database();
        let results = db
            .batch(&[
                statement(INSERT_CLOCK, json!([0, 0, 1, true]), Method::Run),
                statement(
                    "UPDATE sim_clock SET tick = 5 WHERE id = 1",
                    json!([]),
                    Method::Run,
                ),
                statement("SELECT tick FROM sim_clock", json!([]), Method::All),
            ])
            .unwrap();
        assert_eq!(results[2].rows, json!([[5]]));
    }

    #[test]
    fn batch_rolls_back_everything_when_one_statement_fails() {
        let db = database();
        db.query(&statement(
            INSERT_CLOCK,
            json!([0, 0, 1, true]),
            Method::Run,
        ))
        .unwrap();

        let outcome = db.batch(&[
            statement(
                "UPDATE sim_clock SET tick = 999 WHERE id = 1",
                json!([]),
                Method::Run,
            ),
            // Violates the speed CHECK constraint.
            statement(
                "UPDATE sim_clock SET speed = 3 WHERE id = 1",
                json!([]),
                Method::Run,
            ),
        ]);
        assert!(matches!(outcome, Err(AppError::Database(_))));

        let tick = db
            .query(&statement(
                "SELECT tick FROM sim_clock",
                json!([]),
                Method::Get,
            ))
            .unwrap();
        assert_eq!(tick.rows, json!([0]));
    }

    #[test]
    fn a_rejected_statement_aborts_the_whole_batch() {
        let db = database();
        let outcome = db.batch(&[
            statement(INSERT_CLOCK, json!([0, 0, 1, true]), Method::Run),
            statement("COMMIT", json!([]), Method::Run),
        ]);
        assert!(matches!(outcome, Err(AppError::StatementRejected(_))));

        let rows = db
            .query(&statement(
                "SELECT count(*) FROM sim_clock",
                json!([]),
                Method::Get,
            ))
            .unwrap();
        assert_eq!(rows.rows, json!([0]));
    }

    #[test]
    fn the_connection_is_usable_after_a_failed_batch() {
        let db = database();
        let _ = db.batch(&[statement(
            "INSERT INTO missing_table VALUES (1)",
            json!([]),
            Method::Run,
        )]);
        db.batch(&[statement(
            INSERT_CLOCK,
            json!([0, 0, 1, false]),
            Method::Run,
        )])
        .unwrap();
    }

    #[test]
    fn rejects_transaction_control_and_pragma_over_ipc() {
        let db = database();
        for sql in [
            "BEGIN",
            "COMMIT",
            "PRAGMA foreign_keys = OFF",
            "DROP TABLE sim_clock",
        ] {
            assert!(matches!(
                db.query(&statement(sql, json!([]), Method::Run)),
                Err(AppError::StatementRejected(_))
            ));
        }
    }

    #[test]
    fn file_databases_use_wal_and_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let options = OpenOptions {
            path: dir.path().join("nested").join("aegis.db"),
            encryption: Encryption::None,
        };

        let db = Database::open(options.clone()).unwrap();
        db.migrate(Some(&dir.path().join("backups"))).unwrap();
        db.query(&statement(
            INSERT_CLOCK,
            json!([5000, 5, 100, true]),
            Method::Run,
        ))
        .unwrap();
        let mode: String = db
            .lock()
            .unwrap()
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        drop(db);

        let reopened = Database::open(options).unwrap();
        let report = reopened.migrate(None).unwrap();
        assert!(report.applied.is_empty());
        let row = reopened
            .query(&statement(
                "SELECT sim_time_ms, tick, speed, running FROM sim_clock",
                json!([]),
                Method::Get,
            ))
            .unwrap();
        assert_eq!(row.rows, json!([5000, 5, 100, 1]));
    }
}

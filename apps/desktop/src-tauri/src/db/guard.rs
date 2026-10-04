//! Statement guard for SQL arriving over IPC (ADR 0003, ADR 0010).
//!
//! Only data statements are accepted. Transaction control must never arrive from the webview,
//! because a `BEGIN` left open across calls would break the all-or-nothing guarantee of batches.
//! Schema changes come only from embedded migrations, and connection-level settings (`PRAGMA`,
//! `ATTACH`) are never the webview's to change.

use crate::error::{AppError, AppResult};

const ALLOWED_KEYWORDS: [&str; 6] = ["SELECT", "INSERT", "UPDATE", "DELETE", "REPLACE", "WITH"];

/// Returns the first keyword of a statement, skipping whitespace and SQL comments.
fn leading_keyword(sql: &str) -> Option<String> {
    let mut rest = sql;
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("--") {
            rest = after.split_once('\n').map_or("", |(_, tail)| tail);
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after.split_once("*/").map_or("", |(_, tail)| tail);
        } else {
            break;
        }
    }
    let keyword: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    (!keyword.is_empty()).then_some(keyword)
}

pub fn check(sql: &str) -> AppResult<()> {
    match leading_keyword(sql) {
        Some(keyword) if ALLOWED_KEYWORDS.contains(&keyword.as_str()) => Ok(()),
        Some(keyword) => Err(AppError::StatementRejected(format!(
            "{keyword} statements are not permitted over IPC"
        ))),
        None => Err(AppError::StatementRejected(
            "statement has no leading keyword".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_data_statements() {
        for sql in [
            "select 1",
            "  SELECT * FROM sim_clock",
            "insert into t values (1)",
            "UPDATE t SET x = 1",
            "delete from t",
            "WITH c AS (SELECT 1) SELECT * FROM c",
            "-- note\n/* block */ select 1",
        ] {
            assert!(check(sql).is_ok(), "should allow: {sql}");
        }
    }

    #[test]
    fn rejects_transaction_control_schema_and_connection_statements() {
        for sql in [
            "BEGIN",
            "begin immediate",
            "COMMIT",
            "END",
            "ROLLBACK",
            "SAVEPOINT sp0",
            "RELEASE sp0",
            "PRAGMA foreign_keys = OFF",
            "ATTACH DATABASE 'x' AS y",
            "DETACH y",
            "VACUUM",
            "DROP TABLE sim_clock",
            "CREATE TABLE t (x)",
            "ALTER TABLE t ADD COLUMN y",
            "/* hidden */ -- still hidden\n  commit",
            "",
            "   ",
            "-- only a comment",
            "/* unterminated",
            "(select 1)",
        ] {
            assert!(
                matches!(check(sql), Err(AppError::StatementRejected(_))),
                "should reject: {sql}"
            );
        }
    }
}

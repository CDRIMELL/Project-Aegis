//! Report export (ADR 0025).
//!
//! The one place the application writes a file other than its database. It writes text the
//! webview supplies into a single folder inside the application's data directory, under a name
//! that is validated here. It cannot be made to write anywhere else, and it reads nothing.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};

pub const EXPORT_DIR: &str = "exports";
const MAX_NAME_LEN: usize = 120;
const MAX_CONTENT_BYTES: usize = 32 * 1024 * 1024;
const EXTENSIONS: [&str; 2] = ["csv", "json"];
/// How many files of the same name may exist before the export is refused.
const MAX_COPIES: u32 = 999;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// The file's name as written, which differs from the name asked for if that was taken.
    pub file_name: String,
    pub path: String,
    pub bytes: usize,
}

fn rejected(reason: &str) -> AppError {
    AppError::ExportRejected(reason.to_owned())
}

/// Splits a valid export name into its stem and extension.
///
/// A name is letters, digits, `-`, `_` and `.` only, so it has no separators, no drive, no
/// parent-directory component and nothing a shell or a file system treats specially.
fn validate_name(name: &str) -> AppResult<(&str, &str)> {
    if name.is_empty() || name.len() > MAX_NAME_LEN {
        return Err(rejected("the file name is empty or too long"));
    }
    if !name
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(rejected(
            "the file name may contain only letters, digits, '-', '_' and '.'",
        ));
    }
    let (stem, extension) = name
        .rsplit_once('.')
        .ok_or_else(|| rejected("the file name has no extension"))?;
    if !EXTENSIONS.contains(&extension) {
        return Err(rejected("only .csv and .json files can be exported"));
    }
    // No leading dot, and no `..` anywhere: with separators already excluded this cannot leave
    // the folder, but a name like that is never one this application produces.
    if stem.is_empty() || stem.starts_with('.') || name.contains("..") {
        return Err(rejected("the file name is not a valid export name"));
    }
    Ok((stem, extension))
}

/// Writes `contents` to `<data_dir>/exports/<file_name>` and says where it went.
///
/// An existing file is never overwritten: `-2`, `-3`, ... is added to the name instead.
pub fn write_export(data_dir: &Path, file_name: &str, contents: &str) -> AppResult<ExportResult> {
    let (stem, extension) = validate_name(file_name)?;
    if contents.len() > MAX_CONTENT_BYTES {
        return Err(rejected("the export is too large"));
    }
    let directory = data_dir.join(EXPORT_DIR);
    fs::create_dir_all(&directory)?;

    for copy in 1..=MAX_COPIES {
        let name = if copy == 1 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem}-{copy}.{extension}")
        };
        let path: PathBuf = directory.join(&name);
        // `create_new` fails if the file exists, atomically: two exports cannot take one name.
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(contents.as_bytes())?;
                file.sync_all()?;
                return Ok(ExportResult {
                    file_name: name,
                    path: path.to_string_lossy().into_owned(),
                    bytes: contents.len(),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(rejected("too many exports of the same name already exist"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_into_the_exports_folder_and_reports_where() {
        let dir = tempfile::tempdir().unwrap();
        let result = write_export(
            dir.path(),
            "aegis-missions-20261004T1200Z.csv",
            "a,b\r\n1,2\r\n",
        )
        .unwrap();
        let expected = dir
            .path()
            .join("exports")
            .join("aegis-missions-20261004T1200Z.csv");
        assert_eq!(result.file_name, "aegis-missions-20261004T1200Z.csv");
        assert_eq!(result.path, expected.to_string_lossy());
        assert_eq!(result.bytes, 10);
        // Exactly the bytes given: no byte-order mark, no line-ending translation.
        assert_eq!(fs::read(expected).unwrap(), b"a,b\r\n1,2\r\n");
    }

    #[test]
    fn never_overwrites_an_existing_export() {
        let dir = tempfile::tempdir().unwrap();
        let first = write_export(dir.path(), "aegis-fleet.json", "{\"n\":1}").unwrap();
        let second = write_export(dir.path(), "aegis-fleet.json", "{\"n\":2}").unwrap();
        let third = write_export(dir.path(), "aegis-fleet.json", "{\"n\":3}").unwrap();
        assert_eq!(first.file_name, "aegis-fleet.json");
        assert_eq!(second.file_name, "aegis-fleet-2.json");
        assert_eq!(third.file_name, "aegis-fleet-3.json");
        let exports = dir.path().join("exports");
        assert_eq!(
            fs::read_to_string(exports.join("aegis-fleet.json")).unwrap(),
            "{\"n\":1}"
        );
        assert_eq!(
            fs::read_to_string(exports.join("aegis-fleet-2.json")).unwrap(),
            "{\"n\":2}"
        );
        assert_eq!(fs::read_dir(exports).unwrap().count(), 3);
    }

    #[test]
    fn refuses_any_name_that_could_leave_the_folder_or_is_not_an_export() {
        let dir = tempfile::tempdir().unwrap();
        let outside = dir.path().join("outside.csv");
        for name in [
            "",
            "../outside.csv",
            "..\\outside.csv",
            "exports/../../outside.csv",
            "sub/report.csv",
            "sub\\report.csv",
            "C:\\Windows\\report.csv",
            "C:report.csv",
            "/etc/report.csv",
            "\\\\server\\share\\report.csv",
            "report.csv:stream",
            "..csv",
            ".csv",
            ".hidden.csv",
            "report..csv",
            "report",
            "report.txt",
            "report.exe",
            "report.csv.exe",
            "report.CSV",
            "report .csv",
            "report\u{202e}vsc.csv",
            "report\0.csv",
            "aegis.db",
            "con.csv ",
        ] {
            let result = write_export(dir.path(), name, "x");
            assert!(
                matches!(result, Err(AppError::ExportRejected(_))),
                "{name:?} should have been refused"
            );
        }
        assert!(!outside.exists());
        // Nothing was written, and the folder was not even created.
        assert!(!dir.path().join("exports").exists());
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn refuses_a_name_that_is_too_long_or_contents_that_are_too_large() {
        let dir = tempfile::tempdir().unwrap();
        let long = format!("{}.csv", "a".repeat(MAX_NAME_LEN));
        assert!(matches!(
            write_export(dir.path(), &long, "x"),
            Err(AppError::ExportRejected(_))
        ));
        let large = "x".repeat(MAX_CONTENT_BYTES + 1);
        assert!(matches!(
            write_export(dir.path(), "large.csv", &large),
            Err(AppError::ExportRejected(_))
        ));
        assert!(!dir.path().join("exports").exists());
    }

    #[test]
    fn leaves_everything_else_in_the_data_directory_alone() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("aegis.db"), b"database").unwrap();
        write_export(dir.path(), "aegis-summary.csv", "ok").unwrap();
        assert_eq!(fs::read(dir.path().join("aegis.db")).unwrap(), b"database");
        let mut entries: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        entries.sort();
        assert_eq!(entries, ["aegis.db", "exports"]);
    }
}

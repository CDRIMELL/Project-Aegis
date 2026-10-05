# 0025 — Report export

- Status: Accepted
- Date: 2026-10-05

## Context

A report should be usable outside the application: in a spreadsheet, or by a script. The window
has no access to the file system, by design (ADR 0010): its only native commands run SQL against
the application's own database.

## Decision

### The content is built by pure functions

`packages/domain/src/report/export.ts` turns a report into CSV or JSON text. The output is a
function of the report alone:

- columns in a fixed order, rows in the report's order (simulation time, then identifier);
- times as simulation time in UTC, ISO 8601, and as ticks; never wall-clock time;
- numbers in plain decimal notation with a full stop, whatever the machine's locale;
- CSV per RFC 4180: CRLF line ends, a field quoted when it contains a comma, a quote or a line
  break, quotes doubled; a text field that begins with `=`, `+`, `-` or `@` is prefixed with an
  apostrophe so a spreadsheet does not run it as a formula;
- JSON with a `meta` object (what the report is, the period in ticks and simulation time, the
  simulation time it is as of, the world's model version, and that the content is simulated) and a
  `rows` array carrying the same fields as the CSV.

An export contains simulated records and the names of reference records. It contains nothing from
`sys_*`, no path, and nothing about the session.

### One native command writes the file

`export_report(file_name, contents)` writes into `exports` inside the application's data
directory and returns the path it wrote. It is gated by the session like the data commands.

- The file name is validated natively: letters, digits, `-`, `_` and `.` only, ending in `.csv`
  or `.json`, at most 120 characters, no separators. The command cannot be made to write anywhere
  else, and cannot read anything.
- An existing file of the same name is not overwritten: the command adds `-2`, `-3` and so on to the name.
- Contents are limited to 32 MB.

The file name is built from the report, the period and the simulation time, so the same export
gets the same name on any machine.

No file dialog, and no file-system or dialog plugin: the window gains one narrow command and no
general capability.

## Consequences

- Exports are found in one known folder. The path is shown after each export. There is no "save
  as"; choosing a location would need a wider grant and can be added later if wanted.
- Export is deterministic: the same world, report and period give byte-identical files.
- The native command is small enough to test completely.

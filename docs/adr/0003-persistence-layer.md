# 0003 — Rust-owned SQLite connection; Drizzle over `sqlite-proxy`

- Status: Accepted
- Date: 2026-10-04

## Context

Drizzle ORM cannot open a SQLite file from a webview: there is no Node runtime there. The common
workaround, `tauri-plugin-sql`, uses a connection pool, so a transaction issued as several IPC calls
is not guaranteed to stay on one connection. The handover requires genuinely transactional updates.

## Decision

- The Rust core owns **one** `rusqlite` connection (bundled SQLite, WAL mode, foreign keys on).
- It exposes two commands:
  - `db_query(sql, params, method)` — one statement.
  - `db_batch(statements)` — all statements inside one SQLite transaction; any failure rolls the
    whole batch back.
- TypeScript uses Drizzle's `sqlite-proxy` driver against an `SqlTransport` interface
  (`query` + `batch`). The desktop app supplies a Tauri transport; Node supplies a `node:sqlite`
  transport used by tests and, later, by command-line tooling.
- Multi-statement writes use `db.batch(...)` only. Rust rejects `BEGIN`, `COMMIT`, `ROLLBACK`,
  `SAVEPOINT`, `RELEASE`, `ATTACH`, `DETACH`, `PRAGMA` and `VACUUM` arriving over IPC, so a
  transaction can never be left open across calls.
- Schema lives in `@aegis/db` (`schema.ts`). `drizzle-kit generate` produces SQL migrations, which
  are embedded in the Rust binary and applied at startup, each in its own transaction. A consistent
  backup (`VACUUM INTO`) is taken before pending migrations run against an existing database.

## Consequences

- Transactions are real: one connection, one `BEGIN … COMMIT` per batch, enforced in Rust.
- Tests exercise the same Drizzle driver and the same SQL as production, differing only in transport.
- The migration runner exists twice: Rust (production) and a small Node runner (tests and tooling).
  Both read the same files and the same journal; a Rust test asserts the embedded set applies cleanly.
- Interactive transactions (read, decide in TypeScript, write, all in one transaction) are not
  available. The single simulation writer does not need them: it decides in memory and writes a batch.
- The webview can issue arbitrary DML. That is acceptable because the app loads no remote content
  and the CSP forbids it; authentication gating happens in Rust (ADR 0010).
- 64-bit integers above 2^53 lose precision crossing IPC as JSON numbers. Simulation time in
  milliseconds stays far below that bound.

/** How Drizzle wants the result of a statement shaped. */
export type SqlMethod = 'run' | 'all' | 'values' | 'get';

export interface SqlStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly method: SqlMethod;
}

/**
 * Rows are arrays of column values in select order, never keyed objects.
 * - `all` / `values`: an array of rows.
 * - `get`: the single row itself, or `null` when nothing matched.
 * - `run`: an empty array.
 */
export interface SqlResult {
  readonly rows: unknown[] | null;
}

/**
 * The only path between TypeScript and SQLite (ADR 0003).
 *
 * `batch` runs every statement in one transaction: either all take effect or none do.
 * Implementations: Tauri IPC in the desktop app, `node:sqlite` in tests and tooling.
 */
export interface SqlTransport {
  query(statement: SqlStatement): Promise<SqlResult>;
  batch(statements: readonly SqlStatement[]): Promise<SqlResult[]>;
}

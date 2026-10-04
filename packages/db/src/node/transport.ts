import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { SqlResult, SqlStatement, SqlTransport } from '../transport';

/**
 * {@link SqlTransport} backed by Node's built-in SQLite.
 *
 * Used by tests and command-line tooling. It mirrors the guarantees of the native transport in
 * the desktop app: one connection, and `batch` as a single all-or-nothing transaction.
 */
export class NodeSqliteTransport implements SqlTransport {
  readonly connection: DatabaseSync;

  /** @param path A file path, or `:memory:` for a private in-memory database. */
  constructor(path: string) {
    this.connection = new DatabaseSync(path);
    this.connection.exec('PRAGMA foreign_keys = ON');
    if (path !== ':memory:') {
      this.connection.exec('PRAGMA journal_mode = WAL');
      this.connection.exec('PRAGMA synchronous = NORMAL');
    }
  }

  query(statement: SqlStatement): Promise<SqlResult> {
    try {
      return Promise.resolve(this.execute(statement));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  batch(statements: readonly SqlStatement[]): Promise<SqlResult[]> {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((statement) => this.execute(statement));
      this.connection.exec('COMMIT');
      return Promise.resolve(results);
    } catch (error) {
      this.connection.exec('ROLLBACK');
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  close(): void {
    this.connection.close();
  }

  private execute({ sql, params, method }: SqlStatement): SqlResult {
    const prepared = this.connection.prepare(sql);
    const values = params as SQLInputValue[];
    if (method === 'run') {
      prepared.run(...values);
      return { rows: [] };
    }
    prepared.setReturnArrays(true);
    const rows = prepared.all(...values) as unknown[];
    return method === 'get' ? { rows: (rows[0] as unknown[] | undefined) ?? null } : { rows };
  }
}

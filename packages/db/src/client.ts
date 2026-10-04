import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from './schema';
import type { SqlResult, SqlTransport } from './transport';

// Drizzle's proxy typings declare `rows: any[]`, but its `get` path expects a falsy value for
// "no row". The transport contract uses `null` for that; this adapts one to the other.
function toDrizzle(result: SqlResult): { rows: unknown[] } {
  return { rows: (result.rows ?? undefined) as unknown[] };
}

/**
 * Typed database handle over a transport.
 *
 * Use `db.batch([...])` for every multi-statement write. `db.transaction()` must not be used:
 * it would issue BEGIN and COMMIT as separate calls, which the native side rejects by design.
 */
export function createDb(transport: SqlTransport) {
  return drizzle(
    async (sql, params, method) => toDrizzle(await transport.query({ sql, params, method })),
    async (statements) => (await transport.batch(statements)).map(toDrizzle),
    { schema },
  );
}

export type AegisDb = ReturnType<typeof createDb>;

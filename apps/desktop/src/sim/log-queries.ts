import { schema, type AegisDb } from '@aegis/db';
import type { LogEntry } from '@aegis/sim';
import { desc, eq } from 'drizzle-orm';

/*
 * Reads of the command and event log (ADR 0018) for display.
 *
 * The simulation writes the log in its checkpoints; the interface only ever reads it. A screen
 * therefore shows the log as of the last checkpoint, which follows every command at once and
 * world events within a couple of seconds.
 */

const { simLog } = schema;

let db: AegisDb;

export function bindSimDb(database: AegisDb): void {
  db = database;
}

type LogRow = typeof simLog.$inferSelect;

function toEntry(row: LogRow): LogEntry {
  let payload: LogEntry['payload'] = {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      payload = parsed as LogEntry['payload'];
    }
  } catch {
    // A payload that cannot be read is shown as empty; the entry itself is still history.
  }
  return { ...row, payload };
}

/** Everything recorded about one mission, oldest first. */
export async function loadMissionLog(missionId: string): Promise<LogEntry[]> {
  const rows = await db
    .select()
    .from(simLog)
    .where(eq(simLog.missionId, missionId))
    .orderBy(simLog.seq);
  return rows.map(toEntry);
}

/** The most recent entries of the whole log, newest first. */
export async function loadRecentLog(limit = 50): Promise<LogEntry[]> {
  const rows = await db.select().from(simLog).orderBy(desc(simLog.seq)).limit(limit);
  return rows.map(toEntry);
}

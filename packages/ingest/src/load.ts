import { schema, type AegisDb } from '@aegis/db';
import { eq, getTableColumns, getTableName, sql, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { contentHash } from './content-hash';
import { PIPELINE_VERSION, sourceId, type Issue, type NormalisedDataset } from './model';
import { DATA_SOURCES, type DataSourceId } from './sources';

const { refDataSource, refIngestionIssue, refIngestionJob } = schema;

/** Rows per INSERT statement; keeps each statement well under SQLite's parameter limit. */
const CHUNK_ROWS = 250;

/** A reference table: every one has the provenance columns the loader relies on. */
export type ReferenceTable = SQLiteTable & {
  id: SQLiteColumn;
  dataset: SQLiteColumn;
  contentHash: SQLiteColumn;
};

export interface JobReport {
  readonly jobId: number;
  readonly dataset: string;
  readonly table: string;
  readonly status: 'succeeded' | 'failed';
  readonly rowsRead: number;
  readonly rowsSkipped: number;
  readonly rowsRejected: number;
  readonly rowsInserted: number;
  readonly rowsUpdated: number;
  readonly rowsUnchanged: number;
  readonly rowsMissingFromSource: number;
  readonly issueCount: number;
  readonly error: string | null;
}

export interface LoadOptions {
  /** Wall-clock source for job timestamps. The only non-deterministic input to a load. */
  readonly now: () => number;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** An error's message followed by the messages of its causes, so the root reason is not lost. */
function describeError(error: unknown): string {
  const parts: string[] = [];
  for (let current = error; current !== undefined && parts.length < 4;) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(typeof current === 'string' ? current : JSON.stringify(current));
      break;
    }
  }
  return parts.join(' <- ');
}

/** `SET col = excluded.col` for every column except the key. */
function overwriteAllColumns(table: SQLiteTable): Record<string, SQL> {
  const set: Record<string, SQL> = {};
  for (const [property, column] of Object.entries(getTableColumns(table))) {
    if (property !== 'id') {
      set[property] = sql.raw(`excluded."${column.name}"`);
    }
  }
  return set;
}

/**
 * Loads one normalised dataset into its table (ADR 0012).
 *
 * - Rows are keyed by `<source>:<source key>`; only new or changed rows are written, so loading
 *   the same input again changes nothing.
 * - All row writes, all issues and the job result commit in one transaction.
 * - A failure is recorded on the job and reported; no partial data is left behind.
 */
export async function loadDataset<Row extends { sourceKey: string }>(
  db: AegisDb,
  table: ReferenceTable,
  data: NormalisedDataset<Row>,
  options: LoadOptions,
): Promise<JobReport> {
  const source = DATA_SOURCES[data.sourceId as DataSourceId];
  const issues: Issue[] = [...data.issues];

  // Register the source and open the job. This commits on its own so a failed load leaves a record.
  const [, opened] = await db.batch([
    db
      .insert(refDataSource)
      .values(source)
      .onConflictDoUpdate({ target: refDataSource.id, set: { ...source } }),
    db
      .insert(refIngestionJob)
      .values({
        dataset: data.dataset,
        sourceId: data.sourceId,
        pipelineVersion: PIPELINE_VERSION,
        status: 'running',
        startedWallMs: options.now(),
        rawUrl: data.raw.url,
        rawSha256: data.raw.sha256,
        rawRetrievedAt: data.raw.retrievedAt,
      })
      .returning({ id: refIngestionJob.id }),
  ]);
  const jobId = opened[0]?.id;
  if (jobId === undefined) {
    throw new Error('Could not create an ingestion job record');
  }

  // Keep the first record for each key; later duplicates are reported.
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of data.rows) {
    const id = sourceId(data.sourceId, row.sourceKey);
    if (byId.has(id)) {
      issues.push({
        severity: 'error',
        code: 'duplicate_key',
        recordKey: row.sourceKey,
        message: 'A record with this key appeared earlier in the same input; this one was ignored.',
      });
      continue;
    }
    byId.set(id, {
      ...row,
      id,
      dataset: data.dataset,
      sourceId: data.sourceId,
      contentHash: contentHash(row),
    });
  }

  const counts = {
    rowsRead: data.rowsRead,
    rowsSkipped: data.rowsSkipped,
    rowsRejected: issues.filter((issue) => issue.severity === 'error').length,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsUnchanged: 0,
    rowsMissingFromSource: 0,
    issueCount: issues.length,
  };
  const report = (status: JobReport['status'], error: string | null): JobReport => ({
    jobId,
    dataset: data.dataset,
    table: getTableName(table),
    status,
    ...counts,
    error,
  });

  try {
    const existing = (await db
      .select({ id: table.id, contentHash: table.contentHash })
      .from(table)
      .where(eq(table.dataset, data.dataset))) as { id: string; contentHash: string }[];
    const existingHash = new Map(existing.map((row) => [row.id, row.contentHash]));

    const toWrite: Record<string, unknown>[] = [];
    for (const [id, row] of byId) {
      const previous = existingHash.get(id);
      if (previous === undefined) {
        counts.rowsInserted++;
      } else if (previous !== row.contentHash) {
        counts.rowsUpdated++;
      } else {
        counts.rowsUnchanged++;
        continue;
      }
      toWrite.push({ ...row, jobId });
    }
    counts.rowsMissingFromSource = existing.filter((row) => !byId.has(row.id)).length;

    const set = overwriteAllColumns(table);
    const rowWrites = chunks(toWrite, CHUNK_ROWS).map((chunk) =>
      db.insert(table).values(chunk).onConflictDoUpdate({ target: table.id, set }),
    );
    const issueWrites = chunks(issues, CHUNK_ROWS).map((chunk) =>
      db.insert(refIngestionIssue).values(chunk.map((issue) => ({ ...issue, jobId }))),
    );

    // One transaction: rows, issues and the job outcome commit together or not at all.
    await db.batch([
      db
        .update(refIngestionJob)
        .set({ status: 'succeeded', finishedWallMs: options.now(), ...counts })
        .where(eq(refIngestionJob.id, jobId)),
      ...rowWrites,
      ...issueWrites,
    ]);
    return report('succeeded', null);
  } catch (cause) {
    const message = describeError(cause);
    counts.rowsInserted = 0;
    counts.rowsUpdated = 0;
    counts.rowsUnchanged = 0;
    await db
      .update(refIngestionJob)
      .set({ status: 'failed', finishedWallMs: options.now(), error: message, ...counts })
      .where(eq(refIngestionJob.id, jobId));
    return report('failed', message);
  }
}

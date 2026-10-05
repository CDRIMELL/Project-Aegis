import { loadReportData, type AegisDb } from '@aegis/db';
import {
  buildReport,
  exportFileName,
  previousPeriod,
  reportTable,
  toCsv,
  toJson,
  type Report,
  type ReportFilter,
  type ReportPeriod,
  type ReportTableName,
} from '@aegis/domain';
import { MAINTENANCE } from '@aegis/sim';
import { writeExport, type ExportResult } from '../platform/tauri';

/*
 * Reads and exports for the Reports screens (ADR 0024, ADR 0025).
 *
 * A report is read from the database as of the last checkpoint. The simulation is never asked:
 * it does not know reports exist.
 */

let db: AegisDb;

export function bindReportDb(database: AegisDb): void {
  db = database;
}

export interface LoadedReports {
  readonly current: Report;
  /** The period of the same length before; `null` when the world is not that old. */
  readonly previous: Report | null;
}

const CACHE_SIZE = 6;
const cache = new Map<string, Promise<LoadedReports | null>>();

/**
 * The report for a period and for the period before it, from one read. `checkpointSeq` is what
 * the caller knows to be on disk: the same checkpoint and period are read once.
 */
export function loadReports(
  period: ReportPeriod,
  checkpointSeq: number,
): Promise<LoadedReports | null> {
  const key = `${checkpointSeq}:${period.fromTick}:${period.toTick}`;
  const held = cache.get(key);
  if (held) return held;

  const before = previousPeriod(period);
  const reading = loadReportData(db, before?.fromTick ?? period.fromTick, period.toTick).then(
    (data) =>
      data && {
        current: buildReport(data, period, MAINTENANCE),
        previous: before ? buildReport(data, before, MAINTENANCE) : null,
      },
  );
  cache.set(key, reading);
  // A failed read is not kept: the next attempt reads again.
  reading.catch(() => cache.delete(key));
  for (const old of [...cache.keys()].slice(0, Math.max(0, cache.size - CACHE_SIZE))) {
    cache.delete(old);
  }
  return reading;
}

export type ExportFormat = 'csv' | 'json';

/** Writes one of a report's tables, as it is filtered on screen, to the exports folder. */
export function exportReport(
  name: ReportTableName,
  report: Report,
  filter: ReportFilter,
  format: ExportFormat,
): Promise<ExportResult> {
  const table = reportTable(name, report, filter);
  const contents = format === 'csv' ? toCsv(table) : toJson(table, report, filter);
  return writeExport(exportFileName(name, report, format), contents);
}

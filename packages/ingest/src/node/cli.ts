/**
 * Reference-data command line.
 *
 *   npm run data:fetch            download raw source files and pin them in data/sources.lock.json
 *   npm run data:aircraft-specs   re-extract aircraft characteristics from Wikipedia
 *   npm run data:import [-- --db <path>]
 *                                 import everything into a database (default: the app's database)
 */
import { join } from 'node:path';
import { openNodeDatabase } from '@aegis/db/node';
import { importReferenceData } from '../import';
import type { JobReport } from '../load';
import { readCuratedTypes } from '../sources/aircraft';
import {
  CURATED_ATTRIBUTES,
  CURATED_TYPES,
  REMOTE_FILES,
  fetchRemote,
  readCurated,
  readRemote,
  type RemoteName,
} from './raw';
import { refreshAircraftSpecs } from './wikipedia';

const DEFAULT_DATABASE = join(process.env.APPDATA ?? '.', 'dev.aegis.desktop', 'aegis.db');

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const curatedTypesInput = () =>
  readCurated(CURATED_TYPES, (text) => `${readCuratedTypes(text).revisedAt}T00:00:00.000Z`);

async function fetchAll(): Promise<void> {
  for (const name of Object.keys(REMOTE_FILES) as RemoteName[]) {
    const result = await fetchRemote(name, () => new Date());
    console.log(
      `${name.padEnd(10)} ${String(result.bytes).padStart(10)} bytes  ${result.sha256.slice(0, 12)}  ${result.changed ? 'UPDATED in lock' : 'unchanged'}`,
    );
  }
}

async function aircraftSpecs(): Promise<void> {
  const { types } = readCuratedTypes(curatedTypesInput().text);
  const outcomes = await refreshAircraftSpecs(types, () => new Date());
  console.table(outcomes);
  const without = outcomes.filter((outcome) => outcome.attributeCount === 0);
  console.log(
    `${outcomes.length - without.length} of ${outcomes.length} types have extracted characteristics.`,
  );
}

function printReports(reports: readonly JobReport[]): void {
  console.table(
    reports.map((report) => ({
      dataset: report.dataset,
      status: report.status,
      read: report.rowsRead,
      skipped: report.rowsSkipped,
      rejected: report.rowsRejected,
      inserted: report.rowsInserted,
      updated: report.rowsUpdated,
      unchanged: report.rowsUnchanged,
      missing: report.rowsMissingFromSource,
      issues: report.issueCount,
    })),
  );
  for (const report of reports) {
    if (report.error) console.error(`${report.dataset} FAILED: ${report.error}`);
  }
}

async function importAll(): Promise<void> {
  const path = option('db') ?? DEFAULT_DATABASE;
  const database = openNodeDatabase(path);
  try {
    const started = performance.now();
    const reports = await importReferenceData(
      database.db,
      {
        countries: readRemote('countries'),
        airports: readRemote('airports'),
        runways: readRemote('runways'),
        cities: readRemote('cities'),
        aircraftTypes: curatedTypesInput(),
        aircraftAttributes: readCurated(
          CURATED_ATTRIBUTES,
          (text) => (JSON.parse(text) as { retrievedAt: string }).retrievedAt,
        ),
      },
      { now: () => Date.now() },
    );
    console.log(`Database: ${path}`);
    printReports(reports);
    console.log(`Finished in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    if (reports.length < 6 || reports.some((report) => report.status !== 'succeeded')) {
      process.exitCode = 1;
    }
  } finally {
    database.close();
  }
}

const commands: Record<string, () => Promise<void>> = {
  fetch: fetchAll,
  'aircraft-specs': aircraftSpecs,
  import: importAll,
};

const command = commands[process.argv[2] ?? ''];
if (!command) {
  console.error(`Usage: cli.ts <${Object.keys(commands).join(' | ')}> [--db <path>]`);
  process.exitCode = 2;
} else {
  await command();
}

/**
 * Reference-data command line.
 *
 *   npm run data:fetch            download raw source files and pin them in data/sources.lock.json
 *   npm run data:aircraft-specs   re-extract aircraft characteristics from Wikipedia
 *   npm run data:import [-- --db <path>]
 *                                 normalise the raw sources and load them into a database
 *   npm run data:pack             build the reference data pack shipped inside the application
 *   npm run data:install-pack [-- --db <path>]
 *                                 install the built pack into a database, as the application does
 *
 * The default database is the application's own.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openNodeDatabase } from '@aegis/db/node';
import { prepareCountries, prepareCountryLabels, prepareShapes } from '../basemap';
import {
  loadReferenceData,
  normaliseReferenceData,
  type PreparedDataset,
  type ReferenceInputs,
} from '../import';
import type { JobReport } from '../load';
import { PACK_MANIFEST_FILE, buildPack, installPack, type PackReader } from '../pack';
import { readCuratedTypes } from '../sources/aircraft';
import { curatedCharacteristicsRevisedAt } from '../sources/aircraft-curated';
import {
  BASEMAP_DIR,
  CURATED_ATTRIBUTES,
  CURATED_CHARACTERISTICS,
  CURATED_TYPES,
  PACK_DIR,
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

const midnight = (date: string) => `${date}T00:00:00.000Z`;

const curatedTypesInput = () =>
  readCurated(CURATED_TYPES, (text) => midnight(readCuratedTypes(text).revisedAt));

/** Every raw input, read from disk and checked against the lock. No network access. */
function readInputs(): ReferenceInputs {
  return {
    countries: readRemote('countries'),
    airports: readRemote('airports'),
    runways: readRemote('runways'),
    cities: readRemote('cities'),
    aircraftTypes: curatedTypesInput(),
    aircraftAttributes: readCurated(
      CURATED_ATTRIBUTES,
      (text) => (JSON.parse(text) as { retrievedAt: string }).retrievedAt,
    ),
    aircraftCharacteristics: readCurated(CURATED_CHARACTERISTICS, (text) =>
      midnight(curatedCharacteristicsRevisedAt(text)),
    ),
  };
}

async function fetchAll(): Promise<void> {
  for (const name of Object.keys(REMOTE_FILES) as RemoteName[]) {
    const result = await fetchRemote(name, () => new Date());
    console.log(
      `${name.padEnd(22)} ${String(result.bytes).padStart(10)} bytes  ${result.sha256.slice(0, 12)}  ${result.changed ? 'UPDATED in lock' : 'unchanged'}`,
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

function requireAllSucceeded(reports: readonly JobReport[], expected: number): void {
  if (reports.length !== expected || reports.some((report) => report.status !== 'succeeded')) {
    process.exitCode = 1;
  }
}

async function importAll(): Promise<void> {
  const path = option('db') ?? DEFAULT_DATABASE;
  const database = openNodeDatabase(path);
  try {
    const started = performance.now();
    const prepared: PreparedDataset[] = normaliseReferenceData(readInputs());
    const reports = await loadReferenceData(database.db, prepared, { now: () => Date.now() });
    console.log(`Database: ${path}`);
    printReports(reports);
    console.log(`Finished in ${((performance.now() - started) / 1000).toFixed(1)} s`);
    requireAllSucceeded(reports, prepared.length);
  } finally {
    database.close();
  }
}

async function pack(): Promise<void> {
  const built = await buildPack(normaliseReferenceData(readInputs()));
  rmSync(PACK_DIR, { recursive: true, force: true });
  mkdirSync(PACK_DIR, { recursive: true });
  for (const [file, text] of Object.entries(built.files)) {
    writeFileSync(join(PACK_DIR, file), text);
  }
  console.table(
    Object.entries(built.files).map(([file, text]) => ({
      file,
      bytes: Buffer.byteLength(text),
    })),
  );
  console.log(`Pack written to ${PACK_DIR}`);
  console.log(`Manifest SHA-256: ${built.manifestSha256}`);
}

function directoryReader(directory: string): PackReader {
  return { readText: (file) => Promise.resolve(readFileSync(join(directory, file), 'utf8')) };
}

async function installBuiltPack(): Promise<void> {
  const path = option('db') ?? DEFAULT_DATABASE;
  const directory = option('pack') ?? PACK_DIR;
  const database = openNodeDatabase(path);
  try {
    const started = performance.now();
    const result = await installPack(database.db, directoryReader(directory), {
      now: () => Date.now(),
    });
    console.log(`Database: ${path}`);
    console.log(`Pack:     ${join(directory, PACK_MANIFEST_FILE)}`);
    console.log(`Manifest SHA-256: ${result.manifestSha256}`);
    console.log(`Result: ${result.status}`);
    if (result.status !== 'already_installed') printReports(result.reports);
    if (result.status === 'failed') {
      console.error(result.error);
      process.exitCode = 1;
    }
    console.log(`Finished in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  } finally {
    database.close();
  }
}

/** Builds the offline basemap files the map loads (ADR 0008). Coordinates: 2, 3 and 4 decimals. */
function basemap(): Promise<void> {
  const outputs: Record<string, object> = {
    'land-110m.json': prepareCountries(readRemote('basemap-countries-110m').text, 2),
    'land-50m.json': prepareCountries(readRemote('basemap-countries-50m').text, 3),
    'land-10m.json': prepareCountries(readRemote('basemap-countries-10m').text, 4),
    'borders-50m.json': prepareShapes(readRemote('basemap-borders-50m').text, 3),
    'borders-10m.json': prepareShapes(readRemote('basemap-borders-10m').text, 4),
    'lakes-50m.json': prepareShapes(readRemote('basemap-lakes-50m').text, 3),
    'lakes-10m.json': prepareShapes(readRemote('basemap-lakes-10m').text, 4),
    'country-labels.json': prepareCountryLabels(readRemote('basemap-countries-50m').text),
  };
  rmSync(BASEMAP_DIR, { recursive: true, force: true });
  mkdirSync(BASEMAP_DIR, { recursive: true });
  const written = Object.entries(outputs).map(([file, content]) => {
    const text = JSON.stringify(content);
    writeFileSync(join(BASEMAP_DIR, file), text);
    return { file, bytes: Buffer.byteLength(text) };
  });
  console.table(written);
  console.log(`Basemap written to ${BASEMAP_DIR}`);
  return Promise.resolve();
}

const commands: Record<string, () => Promise<void>> = {
  basemap,
  fetch: fetchAll,
  'aircraft-specs': aircraftSpecs,
  import: importAll,
  pack,
  'install-pack': installBuiltPack,
};

const command = commands[process.argv[2] ?? ''];
if (!command) {
  console.error(`Usage: cli.ts <${Object.keys(commands).join(' | ')}> [--db <path>]`);
  process.exitCode = 2;
} else {
  await command();
}

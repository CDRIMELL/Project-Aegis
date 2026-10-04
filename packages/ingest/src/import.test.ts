import { schema } from '@aegis/db';
import { openNodeDatabase, type NodeDatabase } from '@aegis/db/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importReferenceData, type ReferenceInputs } from './import';
import { loadDataset, type JobReport } from './load';
import type { NormalisedDataset, RunwayRecord } from './model';
import {
  AIRCRAFT_ATTRIBUTES_JSON,
  AIRCRAFT_TYPES_JSON,
  AIRPORTS_CSV,
  CITIES_GEOJSON,
  COUNTRIES_CSV,
  RUNWAYS_CSV,
  rawFixture,
} from './testing';

const REFERENCE_TABLES = [
  'ref_data_source',
  'ref_country',
  'ref_location',
  'ref_runway',
  'ref_aircraft_type',
  'ref_aircraft_attribute',
] as const;

function inputs(overrides: Partial<Record<keyof ReferenceInputs, string>> = {}): ReferenceInputs {
  return {
    countries: rawFixture(overrides.countries ?? COUNTRIES_CSV, 'countries'),
    airports: rawFixture(overrides.airports ?? AIRPORTS_CSV, 'airports'),
    runways: rawFixture(overrides.runways ?? RUNWAYS_CSV, 'runways'),
    cities: rawFixture(overrides.cities ?? CITIES_GEOJSON, 'cities'),
    aircraftTypes: rawFixture(overrides.aircraftTypes ?? AIRCRAFT_TYPES_JSON, 'aircraft-types'),
    aircraftAttributes: rawFixture(
      overrides.aircraftAttributes ?? AIRCRAFT_ATTRIBUTES_JSON,
      'aircraft-attributes',
    ),
  };
}

/** A clock that advances on every read, so job timestamps differ between runs. */
function tickingClock(start = 1_800_000_000_000) {
  let now = start;
  return { now: () => (now += 1000) };
}

describe('importReferenceData', () => {
  let database: NodeDatabase;

  const all = (sql: string) => database.transport.connection.prepare(sql).all();
  const dump = (target: NodeDatabase = database) =>
    Object.fromEntries(
      REFERENCE_TABLES.map((table) => [
        table,
        target.transport.connection.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
      ]),
    );
  const summary = (reports: readonly JobReport[]) =>
    reports.map((r) => [r.dataset, r.status, r.rowsInserted, r.rowsUpdated, r.rowsUnchanged]);

  beforeEach(() => {
    database = openNodeDatabase(':memory:');
  });
  afterEach(() => {
    database.close();
  });

  it('imports every dataset in dependency order with full accounting', async () => {
    const reports = await importReferenceData(database.db, inputs(), tickingClock());

    expect(summary(reports)).toEqual([
      ['ourairports-countries', 'succeeded', 3, 0, 0],
      ['ourairports-airports', 'succeeded', 4, 0, 0],
      ['ourairports-runways', 'succeeded', 3, 0, 0],
      ['natural-earth-cities', 'succeeded', 3, 0, 0],
      ['aircraft-types', 'succeeded', 4, 0, 0],
      ['aircraft-attributes', 'succeeded', 3, 0, 0],
    ]);

    const airports = reports[1];
    expect(airports).toMatchObject({ rowsRead: 8, rowsSkipped: 2, rowsRejected: 2, issueCount: 6 });
    // Every record read is accounted for: imported, skipped or rejected.
    expect(airports?.rowsRead).toBe(
      (airports?.rowsInserted ?? 0) + (airports?.rowsSkipped ?? 0) + (airports?.rowsRejected ?? 0),
    );
  });

  it('gives every row a source-derived key and a link to the job that wrote it', async () => {
    const reports = await importReferenceData(database.db, inputs(), tickingClock());
    const heathrow = all("SELECT * FROM ref_location WHERE id = 'ourairports:2434'")[0];
    expect(heathrow).toMatchObject({
      dataset: 'ourairports-airports',
      source_id: 'ourairports',
      source_key: '2434',
      job_id: reports[1]?.jobId,
      icao: 'EGLL',
    });

    const job = all(`SELECT * FROM ref_ingestion_job WHERE id = ${reports[1]?.jobId}`)[0];
    expect(job).toMatchObject({
      status: 'succeeded',
      raw_url: 'fixture://airports',
      raw_sha256: '0'.repeat(64),
      raw_retrieved_at: '2026-10-01T00:00:00.000Z',
      rows_inserted: 4,
    });

    expect(all('SELECT id, licence FROM ref_data_source ORDER BY id')).toEqual([
      { id: 'aegis-curated', licence: 'Project-owned' },
      { id: 'natural-earth', licence: 'Public domain' },
      { id: 'ourairports', licence: 'Public domain' },
      { id: 'wikipedia', licence: 'CC BY-SA 4.0 (article text)' },
    ]);
  });

  it('records every issue against its job, so nothing is dropped silently', async () => {
    const reports = await importReferenceData(database.db, inputs(), tickingClock());
    const stored = all(
      `SELECT severity, code, record_key FROM ref_ingestion_issue WHERE job_id = ${reports[1]?.jobId} ORDER BY id`,
    );
    expect(stored).toHaveLength(6);
    expect(stored).toContainEqual({
      severity: 'error',
      code: 'invalid_coordinates',
      record_key: '9001',
    });
    expect(stored).toContainEqual({
      severity: 'warning',
      code: 'unknown_country',
      record_key: '9003',
    });
  });

  it('is idempotent: importing the same input again changes no reference row', async () => {
    const clock = tickingClock();
    await importReferenceData(database.db, inputs(), clock);
    const before = dump();

    const second = await importReferenceData(database.db, inputs(), clock);

    expect(summary(second)).toEqual([
      ['ourairports-countries', 'succeeded', 0, 0, 3],
      ['ourairports-airports', 'succeeded', 0, 0, 4],
      ['ourairports-runways', 'succeeded', 0, 0, 3],
      ['natural-earth-cities', 'succeeded', 0, 0, 3],
      ['aircraft-types', 'succeeded', 0, 0, 4],
      ['aircraft-attributes', 'succeeded', 0, 0, 3],
    ]);
    expect(dump()).toEqual(before);
    // The run itself is still on record.
    expect(all('SELECT count(*) AS n FROM ref_ingestion_job')).toEqual([{ n: 12 }]);
  });

  it('is reproducible: the same input builds identical tables in a fresh database', async () => {
    await importReferenceData(database.db, inputs(), tickingClock(1_800_000_000_000));
    const other = openNodeDatabase(':memory:');
    try {
      await importReferenceData(other.db, inputs(), tickingClock(1_900_000_000_000));
      expect(dump(other)).toEqual(dump());
    } finally {
      other.close();
    }
  });

  it('writes only the rows that changed and re-attributes them to the new job', async () => {
    const clock = tickingClock();
    const first = await importReferenceData(database.db, inputs(), clock);
    const renamed = AIRPORTS_CSV.replace('RAF Brize Norton', 'Brize Norton Airfield');

    const second = await importReferenceData(database.db, inputs({ airports: renamed }), clock);

    expect(summary(second)[1]).toEqual(['ourairports-airports', 'succeeded', 0, 1, 3]);
    const rows = all(
      "SELECT id, name, job_id FROM ref_location WHERE dataset = 'ourairports-airports' ORDER BY id",
    );
    expect(rows).toContainEqual({
      id: 'ourairports:2532',
      name: 'Brize Norton Airfield',
      job_id: second[1]?.jobId,
    });
    expect(rows).toContainEqual({
      id: 'ourairports:2434',
      name: 'London Heathrow Airport',
      job_id: first[1]?.jobId,
    });
  });

  it('reports records that vanished from the source but keeps them', async () => {
    const clock = tickingClock();
    await importReferenceData(database.db, inputs(), clock);
    const withoutJfk = AIRPORTS_CSV.split('\n')
      .filter((line) => !line.startsWith('3622,'))
      .join('\n');

    const second = await importReferenceData(database.db, inputs({ airports: withoutJfk }), clock);

    expect(second[1]).toMatchObject({ rowsMissingFromSource: 1, rowsUnchanged: 3 });
    expect(all("SELECT name FROM ref_location WHERE id = 'ourairports:3622'")).toHaveLength(1);
  });

  it('keeps the first of two records with the same key and reports the second', async () => {
    const duplicated = `${COUNTRIES_CSV}999,"GB","Great Britain (duplicate)","EU",,\n`;
    const reports = await importReferenceData(
      database.db,
      inputs({ countries: duplicated }),
      tickingClock(),
    );

    expect(reports[0]).toMatchObject({ rowsInserted: 3, rowsRejected: 1 });
    expect(all("SELECT name FROM ref_country WHERE iso2 = 'GB'")).toEqual([
      { name: 'United Kingdom' },
    ]);
    expect(all("SELECT code FROM ref_ingestion_issue WHERE code = 'duplicate_key'")).toHaveLength(
      1,
    );
  });

  it('stops after a failed dataset instead of importing what depends on it', async () => {
    database.transport.connection.exec('DROP TABLE ref_runway');

    const reports = await importReferenceData(database.db, inputs(), tickingClock());

    expect(reports.map((report) => [report.dataset, report.status])).toEqual([
      ['ourairports-countries', 'succeeded'],
      ['ourairports-airports', 'succeeded'],
      ['ourairports-runways', 'failed'],
    ]);
    expect(reports[2]?.error).toMatch(/no such table/i);
    expect(all("SELECT count(*) AS n FROM ref_location WHERE kind = 'city'")).toEqual([{ n: 0 }]);
  });
});

describe('loadDataset failure handling', () => {
  let database: NodeDatabase;
  const all = (sql: string) => database.transport.connection.prepare(sql).all();

  beforeEach(async () => {
    database = openNodeDatabase(':memory:');
    await importReferenceData(database.db, inputs(), tickingClock());
  });
  afterEach(() => {
    database.close();
  });

  const runway = (sourceKey: string, locationId: string): RunwayRecord => ({
    sourceKey,
    confidence: 'medium',
    verification: 'source_asserted',
    locationId,
    lengthM: 1000,
    widthM: 30,
    surface: 'ASP',
    lighted: false,
    closed: false,
    lowEndIdent: '01',
    highEndIdent: '19',
    lowEndHeadingDeg: null,
    highEndHeadingDeg: null,
  });

  it('writes nothing when any row cannot be written, and records the failed job', async () => {
    const before = all('SELECT id, content_hash, job_id FROM ref_runway ORDER BY id');
    const data: NormalisedDataset<RunwayRecord> = {
      dataset: 'ourairports-runways',
      sourceId: 'ourairports',
      raw: {
        url: 'fixture://bad-runways',
        sha256: 'f'.repeat(64),
        retrievedAt: '2026-10-02T00:00:00.000Z',
      },
      rowsRead: 2,
      rowsSkipped: 0,
      rows: [
        runway('900001', 'ourairports:2434'),
        // No such location: violates the foreign key, so the whole dataset must roll back.
        runway('900002', 'ourairports:does-not-exist'),
      ],
      issues: [{ severity: 'warning', code: 'test_warning', recordKey: '900001', message: 'note' }],
    };

    const report = await loadDataset(database.db, schema.refRunway, data, tickingClock());

    expect(report).toMatchObject({ status: 'failed', rowsInserted: 0, rowsUpdated: 0 });
    expect(report.error).toMatch(/FOREIGN KEY/i);
    expect(all('SELECT id, content_hash, job_id FROM ref_runway ORDER BY id')).toEqual(before);
    expect(
      all(
        `SELECT status, error IS NOT NULL AS has_error FROM ref_ingestion_job WHERE id = ${report.jobId}`,
      ),
    ).toEqual([{ status: 'failed', has_error: 1 }]);
    expect(
      all(`SELECT count(*) AS n FROM ref_ingestion_issue WHERE job_id = ${report.jobId}`),
    ).toEqual([{ n: 0 }]);
  });

  it('enforces coordinate ranges in the database as a last line of defence', () => {
    expect(() => {
      database.transport.connection.exec(
        "UPDATE ref_location SET lat = 91 WHERE id = 'ourairports:2434'",
      );
    }).toThrow(/CHECK constraint/i);
  });
});

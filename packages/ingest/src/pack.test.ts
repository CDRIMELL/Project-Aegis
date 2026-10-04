import { openNodeDatabase, type NodeDatabase } from '@aegis/db/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importReferenceData, normaliseReferenceData, type ReferenceInputs } from './import';
import { PIPELINE_VERSION } from './model';
import {
  PACK_FORMAT_VERSION,
  PACK_MANIFEST_FILE,
  PackError,
  buildPack,
  installPack,
  installedPack,
  openPack,
  type PackManifest,
  type PackReader,
} from './pack';
import {
  AIRCRAFT_ATTRIBUTES_JSON,
  AIRCRAFT_CHARACTERISTICS_JSON,
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

function inputs(airports = AIRPORTS_CSV): ReferenceInputs {
  return {
    countries: rawFixture(COUNTRIES_CSV, 'countries'),
    airports: rawFixture(airports, 'airports'),
    runways: rawFixture(RUNWAYS_CSV, 'runways'),
    cities: rawFixture(CITIES_GEOJSON, 'cities'),
    aircraftTypes: rawFixture(AIRCRAFT_TYPES_JSON, 'aircraft-types'),
    aircraftAttributes: rawFixture(AIRCRAFT_ATTRIBUTES_JSON, 'aircraft-attributes'),
    aircraftCharacteristics: rawFixture(AIRCRAFT_CHARACTERISTICS_JSON, 'aircraft-characteristics'),
  };
}

function clock(start = 1_800_000_000_000) {
  let now = start;
  return { now: () => (now += 1000) };
}

function memoryReader(files: Readonly<Record<string, string>>): PackReader & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readText(file) {
      reads.push(file);
      const text = files[file];
      return text === undefined
        ? Promise.reject(new Error(`missing pack file ${file}`))
        : Promise.resolve(text);
    },
  };
}

const dump = (database: NodeDatabase) =>
  Object.fromEntries(
    REFERENCE_TABLES.map((table) => [
      table,
      database.transport.connection.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
    ]),
  );

const count = (database: NodeDatabase, table: string) =>
  Number(database.transport.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);

describe('buildPack', () => {
  it('is deterministic: the same input gives byte-identical files and manifest hash', async () => {
    const first = await buildPack(normaliseReferenceData(inputs()));
    const second = await buildPack(normaliseReferenceData(inputs()));
    expect(second.files).toEqual(first.files);
    expect(second.manifestSha256).toBe(first.manifestSha256);
  });

  it('changes its identity when any record changes', async () => {
    const original = await buildPack(normaliseReferenceData(inputs()));
    const changed = await buildPack(
      normaliseReferenceData(inputs(AIRPORTS_CSV.replace('RAF Brize Norton', 'Brize Norton'))),
    );
    expect(changed.manifestSha256).not.toBe(original.manifestSha256);
  });

  it('records the format, the pipeline version and the original raw input of every dataset', async () => {
    const pack = await buildPack(normaliseReferenceData(inputs()));
    const manifest = JSON.parse(pack.files[PACK_MANIFEST_FILE] ?? '') as PackManifest;

    expect(manifest.formatVersion).toBe(PACK_FORMAT_VERSION);
    expect(manifest.pipelineVersion).toBe(PIPELINE_VERSION);
    expect(manifest.datasets.map((entry) => [entry.dataset, entry.table, entry.rows])).toEqual([
      ['ourairports-countries', 'ref_country', 3],
      ['ourairports-airports', 'ref_location', 4],
      ['ourairports-runways', 'ref_runway', 3],
      ['natural-earth-cities', 'ref_location', 3],
      ['aircraft-types', 'ref_aircraft_type', 4],
      ['aircraft-attributes', 'ref_aircraft_attribute', 3],
      ['aircraft-characteristics-curated', 'ref_aircraft_attribute', 4],
    ]);
    expect(manifest.datasets[1]?.raw).toEqual({
      url: 'fixture://airports',
      sha256: '0'.repeat(64),
      retrievedAt: '2026-10-01T00:00:00.000Z',
    });
  });
});

describe('installPack', () => {
  let database: NodeDatabase;

  beforeEach(() => {
    database = openNodeDatabase(':memory:');
  });
  afterEach(() => {
    database.close();
  });

  it('produces exactly the reference state a direct import produces', async () => {
    const pack = await buildPack(normaliseReferenceData(inputs()));
    const result = await installPack(database.db, memoryReader(pack.files), clock());
    expect(result.status).toBe('installed');

    const direct = openNodeDatabase(':memory:');
    try {
      await importReferenceData(direct.db, inputs(), clock(1_900_000_000_000));
      expect(dump(database)).toEqual(dump(direct));
    } finally {
      direct.close();
    }
  });

  it('carries provenance, source hashes and issues through the pack', async () => {
    const pack = await buildPack(normaliseReferenceData(inputs()));
    await installPack(database.db, memoryReader(pack.files), clock());
    const all = (sql: string) => database.transport.connection.prepare(sql).all();

    expect(
      all(
        `SELECT j.dataset, j.status, j.raw_url, j.raw_sha256, j.raw_retrieved_at
           FROM ref_location l JOIN ref_ingestion_job j ON j.id = l.job_id
          WHERE l.id = 'ourairports:2434'`,
      ),
    ).toEqual([
      {
        dataset: 'ourairports-airports',
        status: 'succeeded',
        raw_url: 'fixture://airports',
        raw_sha256: '0'.repeat(64),
        raw_retrieved_at: '2026-10-01T00:00:00.000Z',
      },
    ]);
    expect(all("SELECT code FROM ref_ingestion_issue WHERE record_key = '9001'")).toEqual([
      { code: 'invalid_coordinates' },
    ]);
  });

  it('records the installed pack and does nothing when asked to install it again', async () => {
    const pack = await buildPack(normaliseReferenceData(inputs()));
    const time = clock();
    await installPack(database.db, memoryReader(pack.files), time);

    expect(await installedPack(database.db)).toMatchObject({
      manifestSha256: pack.manifestSha256,
      formatVersion: PACK_FORMAT_VERSION,
      pipelineVersion: PIPELINE_VERSION,
      datasetCount: 7,
      rowCount: 24,
    });

    const jobs = count(database, 'ref_ingestion_job');
    const reader = memoryReader(pack.files);
    const again = await installPack(database.db, reader, time);

    expect(again.status).toBe('already_installed');
    // Only the manifest was read; no dataset was parsed or loaded.
    expect(reader.reads).toEqual([PACK_MANIFEST_FILE]);
    expect(count(database, 'ref_ingestion_job')).toBe(jobs);
    expect(count(database, 'ref_pack_install')).toBe(1);
  });

  it('upgrades to a newer pack, writing only what changed', async () => {
    const time = clock();
    const v1 = await buildPack(normaliseReferenceData(inputs()));
    await installPack(database.db, memoryReader(v1.files), time);

    const v2 = await buildPack(
      normaliseReferenceData(inputs(AIRPORTS_CSV.replace('RAF Brize Norton', 'Brize Norton'))),
    );
    const result = await installPack(database.db, memoryReader(v2.files), time);

    expect(result.status).toBe('installed');
    if (result.status !== 'installed') return;
    expect(result.reports.map((r) => [r.rowsInserted, r.rowsUpdated])).toEqual([
      [0, 0],
      [0, 1],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    expect(count(database, 'ref_pack_install')).toBe(2);
    expect((await installedPack(database.db))?.manifestSha256).toBe(v2.manifestSha256);
  });

  it('refuses a pack with a corrupt file, before writing anything', async () => {
    const pack = await buildPack(normaliseReferenceData(inputs()));
    const file = 'natural-earth-cities.json';
    const tampered = { ...pack.files, [file]: (pack.files[file] ?? '').replace('Paris', 'Pariz') };

    await expect(installPack(database.db, memoryReader(tampered), clock())).rejects.toThrow(
      /natural-earth-cities\.json is corrupt/,
    );
    expect(count(database, 'ref_country')).toBe(0);
    expect(count(database, 'ref_ingestion_job')).toBe(0);
    expect(await installedPack(database.db)).toBeNull();
  });

  it('refuses a pack with a missing file, before writing anything', async () => {
    const pack = await buildPack(normaliseReferenceData(inputs()));
    const rest = Object.fromEntries(
      Object.entries(pack.files).filter(([file]) => file !== 'ourairports-runways.json'),
    );

    await expect(installPack(database.db, memoryReader(rest), clock())).rejects.toThrow(
      /missing pack file/,
    );
    expect(count(database, 'ref_country')).toBe(0);
  });

  it('refuses packs of another format or pipeline version', async () => {
    const pack = await buildPack(normaliseReferenceData(inputs()));
    const manifest = JSON.parse(pack.files[PACK_MANIFEST_FILE] ?? '') as PackManifest;
    const withManifest = (changed: object) =>
      memoryReader({
        ...pack.files,
        [PACK_MANIFEST_FILE]: JSON.stringify({ ...manifest, ...changed }),
      });

    await expect(
      openPack(withManifest({ formatVersion: PACK_FORMAT_VERSION + 1 })),
    ).rejects.toThrow(/format .* is not supported/);
    await expect(openPack(withManifest({ pipelineVersion: PIPELINE_VERSION + 1 }))).rejects.toThrow(
      /built by pipeline/,
    );
    await expect(openPack(withManifest({ datasets: [] }))).rejects.toThrow(PackError);
    await expect(openPack(memoryReader({ [PACK_MANIFEST_FILE]: 'not json' }))).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('does not record a pack whose install failed, and completes it on the next attempt', async () => {
    const pack = await buildPack(normaliseReferenceData(inputs()));
    const time = clock();
    // Simulate an install interrupted after two datasets by making the third table unavailable.
    database.transport.connection.exec('ALTER TABLE ref_runway RENAME TO ref_runway_hidden');

    const interrupted = await installPack(database.db, memoryReader(pack.files), time);

    expect(interrupted.status).toBe('failed');
    expect(await installedPack(database.db)).toBeNull();
    expect(count(database, 'ref_location')).toBe(4);

    database.transport.connection.exec('ALTER TABLE ref_runway_hidden RENAME TO ref_runway');
    const resumed = await installPack(database.db, memoryReader(pack.files), time);

    expect(resumed.status).toBe('installed');
    if (resumed.status !== 'installed') return;
    // Datasets written before the interruption are found unchanged; the rest are inserted.
    expect(resumed.reports.map((r) => [r.rowsInserted, r.rowsUnchanged])).toEqual([
      [0, 3],
      [0, 4],
      [3, 0],
      [3, 0],
      [4, 0],
      [3, 0],
      [4, 0],
    ]);
    expect((await installedPack(database.db))?.manifestSha256).toBe(pack.manifestSha256);
  });
});

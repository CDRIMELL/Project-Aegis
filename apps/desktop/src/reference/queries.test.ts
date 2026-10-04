import { openNodeDatabase, type NodeDatabase } from '@aegis/db/node';
import {
  buildPack,
  importReferenceData,
  installPack,
  normaliseReferenceData,
  type ReferenceInputs,
} from '@aegis/ingest';
import {
  AIRCRAFT_ATTRIBUTES_JSON,
  AIRCRAFT_CHARACTERISTICS_JSON,
  AIRCRAFT_TYPES_JSON,
  AIRPORTS_CSV,
  CITIES_GEOJSON,
  COUNTRIES_CSV,
  RUNWAYS_CSV,
  rawFixture,
} from '@aegis/ingest/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locationFeatures, runwayFeatures } from '../map/features';
import {
  bindReferenceDb,
  likePattern,
  loadCountryDetail,
  loadIssueSummary,
  loadLocationDetail,
  loadMapLocations,
  loadMapRunways,
  loadReferenceSummary,
  searchLocations,
} from './queries';

const INPUTS: ReferenceInputs = {
  countries: rawFixture(COUNTRIES_CSV, 'countries'),
  airports: rawFixture(AIRPORTS_CSV, 'airports'),
  runways: rawFixture(RUNWAYS_CSV, 'runways'),
  cities: rawFixture(CITIES_GEOJSON, 'cities'),
  aircraftTypes: rawFixture(AIRCRAFT_TYPES_JSON, 'aircraft-types'),
  aircraftAttributes: rawFixture(AIRCRAFT_ATTRIBUTES_JSON, 'aircraft-attributes'),
  aircraftCharacteristics: rawFixture(AIRCRAFT_CHARACTERISTICS_JSON, 'aircraft-characteristics'),
};

describe('reference queries', () => {
  let database: NodeDatabase;
  let now = 1_800_000_000_000;
  const clock = { now: () => (now += 1000) };

  beforeAll(async () => {
    database = openNodeDatabase(':memory:');
    bindReferenceDb(database.db);
    // Two imports, so "most recent import" has something to choose between.
    await importReferenceData(database.db, INPUTS, clock);
    await importReferenceData(database.db, INPUTS, clock);
  });
  afterAll(() => {
    database.close();
  });

  it('reads every location with the columns the map needs', async () => {
    const rows = await loadMapLocations();
    expect(rows).toHaveLength(7);
    const { features } = locationFeatures(rows);
    expect(
      features.find((feature) => feature.properties.id === 'ourairports:2434')?.properties,
    ).toEqual({
      id: 'ourairports:2434',
      group: 'aerodrome',
      kind: 'airport_large',
      name: 'London Heathrow Airport',
      code: 'EGLL',
      minZoom: 2.5,
      labelMinZoom: 5,
      priority: 100,
    });
    expect(features.filter((feature) => feature.properties.group === 'city')).toHaveLength(3);
  });

  it('reads only runways that can be drawn', async () => {
    const rows = await loadMapRunways();
    expect(rows.map((row) => row.id).sort()).toEqual(['ourairports:238168', 'ourairports:238169']);
    expect(runwayFeatures(rows).features).toHaveLength(2);
  });

  it('describes a location with its country, runways and full provenance', async () => {
    const detail = await loadLocationDetail('ourairports:2434');
    expect(detail?.location).toMatchObject({ name: 'London Heathrow Airport', icao: 'EGLL' });
    expect(detail?.country).toEqual({ iso2: 'GB', name: 'United Kingdom', continent: 'EU' });
    expect(detail?.runways.map((runway) => runway.lowEndIdent)).toEqual(['09L', '09R']);
    expect(detail?.provenance).toMatchObject({
      sourceName: 'OurAirports',
      licence: 'Public domain',
      confidence: 'medium',
      verification: 'source_asserted',
      sourceKey: '2434',
      rawUrl: 'fixture://airports',
      rawSha256: '0'.repeat(64),
      rawRetrievedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(detail?.provenance.importedWallMs).toBeGreaterThan(0);
  });

  it('describes a city without aerodrome fields, and a place with no country', async () => {
    const london = await loadLocationDetail('natural-earth:1159151295');
    expect(london?.location).toMatchObject({ kind: 'city', population: 8567000, icao: null });
    expect(london?.runways).toEqual([]);
    expect(london?.provenance.sourceName).toBe('Natural Earth');

    const noCountry = await loadLocationDetail('natural-earth:1159150001');
    expect(noCountry?.country).toBeNull();
  });

  it('returns null for an unknown record', async () => {
    expect(await loadLocationDetail('ourairports:does-not-exist')).toBeNull();
    expect(await loadCountryDetail('ZZ')).toBeNull();
  });

  it('describes a country with counts of what is held for it', async () => {
    const detail = await loadCountryDetail('GB');
    expect(detail).toMatchObject({
      iso2: 'GB',
      name: 'United Kingdom',
      continent: 'EU',
      counts: { airport_large: 1, airport_medium: 1, airport_small: 0, city: 1 },
    });
    expect(detail?.provenance).toMatchObject({ sourceName: 'OurAirports', confidence: 'high' });
  });

  describe('search', () => {
    it('finds by ICAO or IATA code in any letter case, exact matches first', async () => {
      expect((await searchLocations('egvn'))[0]).toMatchObject({
        name: 'RAF Brize Norton',
        code: 'EGVN',
      });
      expect((await searchLocations('JFK'))[0]?.name).toBe('John F Kennedy International Airport');
    });

    it('finds by part of a name, larger places first', async () => {
      const names = (await searchLocations('london')).map((result) => result.name);
      expect(names).toEqual(['London Heathrow Airport', 'London']);
    });

    it('ignores queries too short to be meaningful', async () => {
      expect(await searchLocations('l')).toEqual([]);
      expect(await searchLocations('   ')).toEqual([]);
    });

    it('treats wildcard characters literally', async () => {
      expect(await searchLocations('%%')).toEqual([]);
      expect(await searchLocations('__')).toEqual([]);
      expect(likePattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%');
    });

    it('respects the result limit', async () => {
      expect(await searchLocations('a', 3)).toEqual([]);
      expect((await searchLocations('an', 2)).length).toBeLessThanOrEqual(2);
    });
  });

  it('summarises each dataset from its most recent successful import only', async () => {
    const summary = await loadReferenceSummary();
    expect(summary.pack).toBeNull();
    expect(
      summary.datasets.map((dataset) => [dataset.dataset, dataset.rows, dataset.issues]),
    ).toEqual([
      ['ourairports-countries', 3, 0],
      ['ourairports-airports', 4, 6],
      ['ourairports-runways', 3, 1],
      ['natural-earth-cities', 3, 3],
      ['aircraft-types', 4, 0],
      ['aircraft-attributes', 3, 3],
      ['aircraft-characteristics-curated', 4, 1],
    ]);
    expect(summary.datasets[1]).toMatchObject({
      sourceName: 'OurAirports',
      licence: 'Public domain',
    });
  });

  it('groups issues by reason without double counting earlier imports', async () => {
    const issues = await loadIssueSummary();
    const airports = issues.filter((issue) => issue.dataset === 'ourairports-airports');
    expect(airports.reduce((total, issue) => total + issue.count, 0)).toBe(6);
    expect(airports).toContainEqual({
      dataset: 'ourairports-airports',
      severity: 'error',
      code: 'invalid_coordinates',
      count: 1,
    });
  });

  it('reports the installed pack once one has been installed', async () => {
    const pack = await buildPack(normaliseReferenceData(INPUTS));
    await installPack(
      database.db,
      { readText: (file) => Promise.resolve(pack.files[file] ?? '') },
      clock,
    );
    const summary = await loadReferenceSummary();
    expect(summary.pack).toMatchObject({ manifestSha256: pack.manifestSha256, rowCount: 24 });
    expect(summary.datasets).toHaveLength(7);
  });
});

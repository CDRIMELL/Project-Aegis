import { describe, expect, it } from 'vitest';
import {
  AIRCRAFT_ATTRIBUTES_JSON,
  AIRCRAFT_CHARACTERISTICS_JSON,
  AIRCRAFT_TYPES_JSON,
  AIRPORTS_CSV,
  CITIES_GEOJSON,
  COUNTRIES_CSV,
  RUNWAYS_CSV,
  rawFixture,
} from '../testing';
import { normaliseAircraftAttributes, normaliseAircraftTypes, readCuratedTypes } from './aircraft';
import { normaliseCuratedCharacteristics } from './aircraft-curated';
import { normaliseCities } from './natural-earth';
import { normaliseAirports, normaliseCountries, normaliseRunways } from './ourairports';

const KNOWN_COUNTRIES = new Set(['GB', 'US', 'FR']);
const codes = (issues: readonly { code: string }[]) => issues.map((issue) => issue.code).sort();

describe('OurAirports countries', () => {
  it('normalises valid rows with provenance', () => {
    const result = normaliseCountries(rawFixture(COUNTRIES_CSV));
    expect(result.dataset).toBe('ourairports-countries');
    expect(result.rowsRead).toBe(3);
    expect(result.issues).toEqual([]);
    expect(result.rows[0]).toEqual({
      sourceKey: 'GB',
      confidence: 'high',
      verification: 'source_asserted',
      iso2: 'GB',
      name: 'United Kingdom',
      continent: 'EU',
    });
  });

  it('rejects bad codes, names and continents with a reason each', () => {
    const csv =
      'id,code,name,continent\n1,gb,Lower,EU\n2,XX,,EU\n3,YY,Somewhere,ZZ\n4,DE,Germany,EU\n';
    const result = normaliseCountries(rawFixture(csv));
    expect(result.rows.map((row) => row.iso2)).toEqual(['DE']);
    expect(codes(result.issues)).toEqual([
      'invalid_continent',
      'invalid_country_code',
      'missing_name',
    ]);
    expect(result.issues.every((issue) => issue.severity === 'error')).toBe(true);
  });

  it('fails loudly when the file is not the expected dataset', () => {
    expect(() => normaliseCountries(rawFixture('a,b\n1,2\n'))).toThrow(/missing expected columns/);
  });
});

describe('OurAirports airports', () => {
  const result = normaliseAirports(rawFixture(AIRPORTS_CSV), KNOWN_COUNTRIES);
  const byKey = new Map(result.rows.map((row) => [row.sourceKey, row]));

  it('imports airports, converting elevation to metres', () => {
    expect(byKey.get('2434')).toEqual({
      sourceKey: '2434',
      confidence: 'medium',
      verification: 'source_asserted',
      kind: 'airport_large',
      name: 'London Heathrow Airport',
      lat: 51.4706,
      lon: -0.461941,
      elevationM: 25.3,
      countryIso2: 'GB',
      regionCode: 'GB-ENG',
      municipality: 'London',
      ident: 'EGLL',
      icao: 'EGLL',
      iata: 'LHR',
      scheduledService: true,
      population: null,
    });
    expect(byKey.get('2532')?.kind).toBe('airport_medium');
  });

  it('skips out-of-scope aerodrome types without calling them defects', () => {
    expect(result.rowsRead).toBe(8);
    expect(result.rowsSkipped).toBe(2);
    expect(byKey.has('6523')).toBe(false);
    expect(byKey.has('9004')).toBe(false);
  });

  it('rejects records without a valid position or name', () => {
    expect(byKey.has('9001')).toBe(false);
    expect(byKey.has('9002')).toBe(false);
    const errors = result.issues.filter((issue) => issue.severity === 'error');
    expect(errors.map((issue) => [issue.code, issue.recordKey])).toEqual([
      ['invalid_coordinates', '9001'],
      ['missing_name', '9002'],
    ]);
  });

  it('keeps a record but drops an implausible field, with a warning for each', () => {
    expect(byKey.get('9003')).toMatchObject({
      name: 'Caveat Strip',
      elevationM: null,
      countryIso2: null,
      icao: null,
      iata: null,
    });
    const warnings = result.issues.filter((issue) => issue.recordKey === '9003');
    expect(codes(warnings)).toEqual([
      'implausible_elevation',
      'invalid_iata_code',
      'invalid_icao_code',
      'unknown_country',
    ]);
    expect(warnings.every((issue) => issue.severity === 'warning')).toBe(true);
  });

  it('is deterministic: the same input gives identical output', () => {
    expect(normaliseAirports(rawFixture(AIRPORTS_CSV), KNOWN_COUNTRIES)).toEqual(result);
  });
});

describe('OurAirports runways', () => {
  const result = normaliseRunways(rawFixture(RUNWAYS_CSV), new Set(['2434', '2532']));

  it('imports runways of imported aerodromes and links them', () => {
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({
      sourceKey: '238168',
      locationId: 'ourairports:2434',
      lengthM: 3901.1,
      widthM: 50,
      surface: 'ASP',
      lighted: true,
      closed: false,
      lowEndIdent: '09L',
      highEndIdent: '27R',
      lowEndHeadingDeg: 89.6,
      highEndHeadingDeg: 269.7,
      lowEndLat: 51.4775,
      lowEndLon: -0.489428,
      highEndLat: 51.4777,
      highEndLon: -0.433264,
    });
  });

  it('skips runways of aerodromes that were not imported', () => {
    expect(result.rowsSkipped).toBe(1);
  });

  it('treats zero as unknown and warns about impossible headings', () => {
    const brize = result.rows.find((row) => row.sourceKey === '238400');
    expect(brize).toMatchObject({ widthM: null, lowEndHeadingDeg: null, highEndHeadingDeg: null });
    expect(result.issues.map((issue) => [issue.severity, issue.code, issue.recordKey])).toEqual([
      ['warning', 'invalid_heading', '238400'],
    ]);
  });
});

describe('Natural Earth cities', () => {
  const result = normaliseCities(rawFixture(CITIES_GEOJSON), KNOWN_COUNTRIES);

  it('imports cities with population and country', () => {
    expect(result.rows.map((row) => row.name)).toEqual(['London', 'Paris', 'Hargeysa']);
    expect(result.rows[0]).toMatchObject({
      sourceKey: '1159151295',
      kind: 'city',
      lat: 51.5,
      lon: -0.1167,
      countryIso2: 'GB',
      population: 8567000,
      municipality: 'Westminster',
      confidence: 'high',
    });
  });

  it('keeps a city whose country code is a placeholder, without the link', () => {
    expect(result.rows[2]?.countryIso2).toBeNull();
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'unknown_country',
        recordKey: '1159150001',
      }),
    );
  });

  it('rejects features with impossible coordinates or missing identifiers', () => {
    expect(result.rowsRead).toBe(5);
    const errors = result.issues.filter((issue) => issue.severity === 'error');
    expect(codes(errors)).toEqual(['invalid_coordinates', 'invalid_feature']);
  });
});

describe('aircraft types', () => {
  it('normalises curated types', () => {
    const result = normaliseAircraftTypes(rawFixture(AIRCRAFT_TYPES_JSON));
    expect(result.issues).toEqual([]);
    expect(result.rows[0]).toEqual({
      sourceKey: 'typhoon',
      confidence: 'high',
      verification: 'unverified',
      slug: 'typhoon',
      name: 'Eurofighter Typhoon',
      manufacturer: 'Eurofighter',
      category: 'fast_jet',
      engineType: 'turbofan',
      engineCount: 2,
      ukServiceName: 'Typhoon FGR4',
      roles: '["air_defence","multirole"]',
      referenceUrl: 'https://en.wikipedia.org/wiki/Eurofighter_Typhoon',
    });
  });

  it('rejects any entry carrying a field outside the agreed reference scope', () => {
    const file = JSON.parse(AIRCRAFT_TYPES_JSON) as { types: Record<string, unknown>[] };
    file.types[0] = { ...file.types[0], armament: ['anything'] };
    file.types[1] = { ...file.types[1], roles: ['strike_planning'] };
    const result = normaliseAircraftTypes(rawFixture(JSON.stringify(file)));

    expect(result.rows.map((row) => row.slug)).toEqual(['f-35b', 'a380']);
    expect(result.issues.map((issue) => [issue.code, issue.recordKey])).toEqual([
      ['invalid_aircraft_type', 'typhoon'],
      ['invalid_aircraft_type', 'apache'],
    ]);
    expect(result.issues[0]?.message).toMatch(/armament/);
  });
});

describe('aircraft characteristics', () => {
  const curated = readCuratedTypes(AIRCRAFT_TYPES_JSON).types;
  const result = normaliseAircraftAttributes(rawFixture(AIRCRAFT_ATTRIBUTES_JSON), curated);

  it('attributes each value to the exact article revision it came from', () => {
    expect(result.rows[0]).toEqual({
      sourceKey: 'typhoon/length_m',
      confidence: 'medium',
      verification: 'source_asserted',
      typeId: 'aegis-curated:typhoon',
      key: 'length_m',
      value: 15.96,
      sourceText: 'length m=15.96',
      sourceUrl: 'https://en.wikipedia.org/w/index.php?oldid=1377610122',
      note: 'Article section: "Specifications".',
    });
  });

  it('lowers confidence and records the caveat for a close variant', () => {
    const apache = result.rows.find((row) => row.sourceKey === 'apache/rotor_diameter_m');
    expect(apache).toMatchObject({
      confidence: 'low',
      note: 'Article section: "Specifications (AH-64A/D)". Describes the AH-64A/D, not the AH-64E.',
    });
  });

  it('refuses values that describe a materially different variant', () => {
    expect(result.rows.some((row) => row.typeId === 'aegis-curated:f-35b')).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'specs_not_applicable',
        recordKey: 'f-35b',
      }),
    );
  });

  it('reports every type left without characteristics', () => {
    const gaps = result.issues.filter((issue) => issue.code === 'no_characteristics');
    expect(gaps.map((issue) => issue.recordKey)).toEqual(['f-35b', 'a380']);
  });

  it('rejects an extract for a type that is not curated', () => {
    const orphan = normaliseAircraftAttributes(
      rawFixture(AIRCRAFT_ATTRIBUTES_JSON),
      curated.slice(1),
    );
    expect(orphan.issues).toContainEqual(
      expect.objectContaining({ code: 'unknown_aircraft_type', recordKey: 'typhoon' }),
    );
  });
});

describe('runway threshold positions', () => {
  const header =
    'id,airport_ref,length_ft,width_ft,surface,lighted,closed,le_ident,he_ident,le_latitude_deg,le_longitude_deg,he_latitude_deg,he_longitude_deg';
  const run = (rows: string) =>
    normaliseRunways(rawFixture(`${header}\n${rows}\n`), new Set(['1']));

  it('keeps both ends or neither', () => {
    const result = run(
      '10,1,5000,100,ASP,1,0,09,27,51.1,-1.2,51.1,-1.1\n11,1,5000,100,ASP,1,0,18,36,,,,',
    );
    expect(result.rows[0]).toMatchObject({
      lowEndLat: 51.1,
      lowEndLon: -1.2,
      highEndLat: 51.1,
      highEndLon: -1.1,
    });
    expect(result.rows[1]).toMatchObject({
      lowEndLat: null,
      lowEndLon: null,
      highEndLat: null,
      highEndLon: null,
    });
    expect(result.issues).toEqual([]);
  });

  it('drops incomplete or impossible positions with a warning, keeping the runway', () => {
    const result = run(
      '12,1,5000,100,ASP,1,0,09,27,51.1,-1.2,,\n13,1,5000,100,ASP,1,0,09,27,95,-1.2,51.1,-1.1',
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.lowEndLat === null && row.highEndLon === null)).toBe(
      true,
    );
    expect(result.issues.map((issue) => [issue.severity, issue.code, issue.recordKey])).toEqual([
      ['warning', 'invalid_runway_position', '12'],
      ['warning', 'invalid_runway_position', '13'],
    ]);
  });
});

describe('curated aircraft characteristics', () => {
  const curated = readCuratedTypes(AIRCRAFT_TYPES_JSON).types;
  const result = normaliseCuratedCharacteristics(
    rawFixture(AIRCRAFT_CHARACTERISTICS_JSON),
    curated,
  );
  const row = (key: string) => result.rows.find((candidate) => candidate.key === key);

  it('keeps the publisher wording and marks hand-entered values unverified', () => {
    expect(row('length_m')).toEqual({
      sourceKey: 'a380/length_m',
      confidence: 'high',
      verification: 'unverified',
      typeId: 'aegis-curated:a380',
      key: 'length_m',
      value: 72.72,
      sourceText: 'Overall length 72.72 m',
      sourceUrl: 'https://example.org/aircraft/a380',
      note: 'Example Air Force, aircraft page, retrieved 2026-10-04.',
    });
  });

  it('converts from the unit the source used', () => {
    expect(row('max_speed_kmh')?.value).toBe(1028);
    expect(row('service_ceiling_m')?.value).toBe(12802);
    expect(row('max_takeoff_mass_kg')?.value).toBe(79000);
  });

  it('lowers confidence when the entry carries a caveat', () => {
    expect(row('max_speed_kmh')).toMatchObject({
      confidence: 'medium',
      note: 'Example Air Force, aircraft page, retrieved 2026-10-04. Rounded by the source.',
    });
  });

  it('reports a value that could not be established instead of inventing one', () => {
    expect(result.rows.some((candidate) => candidate.typeId === 'aegis-curated:f-35b')).toBe(false);
    expect(result.issues).toEqual([
      {
        severity: 'warning',
        code: 'value_not_established',
        recordKey: 'f-35b/length_m',
        message: 'No official page retrieved.',
      },
    ]);
  });

  it('rejects unit mismatches, unknown types and fields outside the agreed scope', () => {
    const base = {
      type: 'a380',
      key: 'length_m',
      sourceValue: 10,
      sourceUnit: 'm',
      sourceText: 'x',
      sourceName: 'x',
      sourceUrl: 'https://example.org/',
      retrievedAt: '2026-10-04',
    };
    const file = JSON.stringify({
      revisedAt: '2026-10-04',
      entries: [
        { ...base, sourceUnit: 'kg' },
        { ...base, type: 'not-curated' },
        { ...base, payloadKg: 1000 },
        { ...base, key: 'weapon_stations' },
        { ...base, sourceValue: -1 },
      ],
    });
    const bad = normaliseCuratedCharacteristics(rawFixture(file), curated);
    expect(bad.rows).toEqual([]);
    expect(codes(bad.issues)).toEqual([
      'invalid_characteristic',
      'invalid_characteristic',
      'invalid_characteristic',
      'unit_mismatch',
      'unknown_aircraft_type',
    ]);
  });
});

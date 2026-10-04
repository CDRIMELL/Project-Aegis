import type { RawInput } from './model';

/** Wraps fixture text as a raw input with fixed provenance, for tests. */
export function rawFixture(text: string, name = 'fixture'): RawInput {
  return {
    url: `fixture://${name}`,
    sha256: '0'.repeat(64),
    retrievedAt: '2026-10-01T00:00:00.000Z',
    text,
  };
}

export const COUNTRIES_CSV = `"id","code","name","continent","wikipedia_link","keywords"
302791,"GB","United Kingdom","EU","https://en.wikipedia.org/wiki/United_Kingdom","Great Britain"
302755,"US","United States","NA","https://en.wikipedia.org/wiki/United_States","America"
302634,"FR","France","EU","https://en.wikipedia.org/wiki/France",
`;

const AIRPORT_HEADER =
  '"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"';

export const AIRPORTS_CSV = `${AIRPORT_HEADER}
2434,"EGLL","large_airport","London Heathrow Airport",51.4706,-0.461941,83,"EU","GB","GB-ENG","London","yes","EGLL","LHR","EGLL",,,,
2532,"EGVN","medium_airport","RAF Brize Norton",51.75,-1.58362,288,"EU","GB","GB-ENG","Brize Norton","no","EGVN","BZZ","EGVN",,,,
3622,"KJFK","large_airport","John F Kennedy International Airport",40.639447,-73.779317,13,"NA","US","US-NY","New York","yes","KJFK","JFK","KJFK","JFK",,,
6523,"00A","heliport","Total RF Heliport",40.070985,-74.933689,11,"NA","US","US-PA","Bensalem","no",,,"K00A","00A",,,
9001,"XX01","small_airport","Bad Latitude Field",123.4,10,100,"EU","GB","GB-ENG",,"no",,,,,,,
9002,"XX02","small_airport","",51,0,100,"EU","GB","GB-ENG",,"no",,,,,,,
9003,"XX03","small_airport","Caveat Strip",52.1,-1.2,99999,"EU","ZZ","ZZ-X",,"no","egx","TOOLONG",,,,,
9004,"XX04","closed","Closed Field",52,0,10,"EU","GB","GB-ENG",,"no",,,,,,,
`;

const RUNWAY_HEADER =
  '"id","airport_ref","airport_ident","length_ft","width_ft","surface","lighted","closed","le_ident","le_latitude_deg","le_longitude_deg","le_elevation_ft","le_heading_degT","le_displaced_threshold_ft","he_ident","he_latitude_deg","he_longitude_deg","he_elevation_ft","he_heading_degT","he_displaced_threshold_ft"';

export const RUNWAYS_CSV = `${RUNWAY_HEADER}
238168,2434,"EGLL",12799,164,"ASP",1,0,"09L",51.4775,-0.489428,79,89.6,1004,"27R",51.4777,-0.433264,78,269.7,
238169,2434,"EGLL",12001,148,"ASP",1,0,"09R",51.4649,-0.486795,75,89.6,,"27L",51.465,-0.434074,77,269.7,
238400,2532,"EGVN",10007,0,"ASP",1,0,"07",,,,999,,"25",,,,,
269408,6523,"00A",80,80,"ASPH-G",1,0,"H1",,,,,,,,,,,
`;

export const CITIES_GEOJSON = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        ne_id: 1159151295,
        name: 'London',
        iso_a2: 'GB',
        adm1name: 'Westminster',
        pop_max: 8567000,
      },
      geometry: { type: 'Point', coordinates: [-0.1167, 51.5] },
    },
    {
      type: 'Feature',
      properties: {
        ne_id: 1159151627,
        name: 'Paris',
        iso_a2: 'FR',
        adm1name: 'Île-de-France',
        pop_max: 9904000,
      },
      geometry: { type: 'Point', coordinates: [2.3333, 48.8667] },
    },
    {
      type: 'Feature',
      properties: {
        ne_id: 1159150001,
        name: 'Hargeysa',
        iso_a2: '-99',
        adm1name: null,
        pop_max: 477876,
      },
      geometry: { type: 'Point', coordinates: [44.065, 9.56] },
    },
    {
      type: 'Feature',
      properties: { ne_id: 1159150002, name: 'Nowhere', iso_a2: 'GB', pop_max: 0 },
      geometry: { type: 'Point', coordinates: [200, 95] },
    },
    {
      type: 'Feature',
      properties: { name: 'No Id' },
      geometry: { type: 'Point', coordinates: [0, 0] },
    },
  ],
});

export const AIRCRAFT_TYPES_JSON = JSON.stringify({
  revisedAt: '2026-10-04',
  types: [
    {
      slug: 'typhoon',
      name: 'Eurofighter Typhoon',
      manufacturer: 'Eurofighter',
      category: 'fast_jet',
      engineType: 'turbofan',
      engineCount: 2,
      ukServiceName: 'Typhoon FGR4',
      roles: ['air_defence', 'multirole'],
      wikipedia: 'Eurofighter Typhoon',
    },
    {
      slug: 'apache',
      name: 'Boeing AH-64 Apache',
      manufacturer: 'Boeing',
      category: 'rotary',
      engineType: 'turboshaft',
      engineCount: 2,
      roles: ['battlefield_helicopter'],
      wikipedia: 'Boeing AH-64 Apache',
      specCaveat: 'Describes the AH-64A/D, not the AH-64E.',
    },
    {
      slug: 'f-35b',
      name: 'Lockheed Martin F-35B Lightning II',
      manufacturer: 'Lockheed Martin',
      category: 'fast_jet',
      engineType: 'turbofan',
      engineCount: 1,
      roles: ['multirole'],
      wikipedia: 'Lockheed Martin F-35 Lightning II',
      specsNotApplicable: 'Describes the F-35A.',
    },
    {
      slug: 'a380',
      name: 'Airbus A380-800',
      manufacturer: 'Airbus',
      category: 'airliner',
      engineType: 'turbofan',
      engineCount: 4,
      roles: ['passenger'],
      wikipedia: 'Airbus A380',
    },
  ],
});

const OFFICIAL = {
  sourceName: 'Example Air Force, aircraft page',
  sourceUrl: 'https://example.org/aircraft/a380',
  retrievedAt: '2026-10-04',
};

export const AIRCRAFT_CHARACTERISTICS_JSON = JSON.stringify({
  revisedAt: '2026-10-04',
  entries: [
    {
      type: 'a380',
      key: 'length_m',
      sourceValue: 72.72,
      sourceUnit: 'm',
      sourceText: 'Overall length 72.72 m',
      ...OFFICIAL,
    },
    {
      type: 'a380',
      key: 'max_speed_kmh',
      sourceValue: 555,
      sourceUnit: 'kt',
      sourceText: 'Maximum speed 555kt',
      note: 'Rounded by the source.',
      ...OFFICIAL,
    },
    {
      type: 'a380',
      key: 'service_ceiling_m',
      sourceValue: 42000,
      sourceUnit: 'ft',
      sourceText: 'Maximum altitude 42,000ft',
      ...OFFICIAL,
    },
    {
      type: 'a380',
      key: 'max_takeoff_mass_kg',
      sourceValue: 79,
      sourceUnit: 't',
      sourceText: 'Max take-off weight 79.00 tonnes',
      ...OFFICIAL,
    },
    { type: 'f-35b', key: 'length_m', sourceValue: null, reason: 'No official page retrieved.' },
  ],
});

export const AIRCRAFT_ATTRIBUTES_JSON = JSON.stringify({
  retrievedAt: '2026-10-04T10:00:00.000Z',
  types: {
    typhoon: {
      page: 'Eurofighter Typhoon',
      revisionId: 1377610122,
      revisionTimestamp: '2026-09-30T04:24:38Z',
      heading: 'Specifications',
      attributes: [
        { key: 'length_m', value: 15.96, sourceText: 'length m=15.96' },
        { key: 'max_takeoff_mass_kg', value: 23500, sourceText: 'max takeoff weight kg=23500' },
      ],
    },
    apache: {
      page: 'Boeing AH-64 Apache',
      revisionId: 1370000001,
      revisionTimestamp: '2026-09-20T00:00:00Z',
      heading: 'Specifications (AH-64A/D)',
      attributes: [{ key: 'rotor_diameter_m', value: 14.63, sourceText: 'rot dia ft=48' }],
    },
    'f-35b': {
      page: 'Lockheed Martin F-35 Lightning II',
      revisionId: 1370000002,
      revisionTimestamp: '2026-09-20T00:00:00Z',
      heading: 'Specifications (F-35A)',
      attributes: [{ key: 'length_m', value: 15.67, sourceText: 'length ft=51.4' }],
    },
  },
});

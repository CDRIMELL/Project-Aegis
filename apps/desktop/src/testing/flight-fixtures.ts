import type { ReferenceInputs } from '@aegis/ingest';
import { rawFixture } from '@aegis/ingest/testing';

/*
 * Reference inputs for flight tests: a few real aerodromes and three real types, with the
 * characteristics the reference data holds for them, in the pipeline's own input formats.
 */

const AIRPORT_HEADER =
  '"id","ident","type","name","latitude_deg","longitude_deg","elevation_ft","continent","iso_country","iso_region","municipality","scheduled_service","icao_code","iata_code","gps_code","local_code","home_link","wikipedia_link","keywords"';

const AIRPORTS = `${AIRPORT_HEADER}
2470,"EGPK","large_airport","Glasgow Prestwick Airport",55.509399,-4.586670,65,"EU","GB","GB-SCT","Glasgow","yes","EGPK","PIK","EGPK",,,,
2448,"EGHQ","medium_airport","Cornwall Airport Newquay",50.440601,-4.995410,390,"EU","GB","GB-ENG","Newquay","yes","EGHQ","NQY","EGHQ",,,,
4175,"LCRA","medium_airport","RAF Akrotiri",34.590401,32.987900,76,"AS","CY","CY-02","Akrotiri","no","LCRA","AKT","LCRA",,,,
3622,"KJFK","large_airport","John F Kennedy International Airport",40.639447,-73.779317,13,"NA","US","US-NY","New York","yes","KJFK","JFK","KJFK","JFK",,,
2434,"EGLL","large_airport","London Heathrow Airport",51.4706,-0.461941,83,"EU","GB","GB-ENG","London","yes","EGLL","LHR","EGLL",,,,
2429,"EGCC","large_airport","Manchester Airport",53.353699,-2.27495,257,"EU","GB","GB-ENG","Manchester","yes","EGCC","MAN","EGCC",,,,
2513,"EHAM","large_airport","Amsterdam Airport Schiphol",52.308601,4.76389,-11,"EU","NL","NL-NH","Amsterdam","yes","EHAM","AMS","EHAM",,,,
4185,"LFPG","large_airport","Charles de Gaulle International Airport",49.012798,2.55,392,"EU","FR","FR-IDF","Paris","yes","LFPG","CDG","LFPG",,,,
2544,"EIDW","large_airport","Dublin Airport",53.421299,-6.27007,242,"EU","IE","IE-D","Dublin","yes","EIDW","DUB","EIDW",,,,
`;

const COUNTRIES = `"id","code","name","continent","wikipedia_link","keywords"
302791,"GB","United Kingdom","EU",,
302755,"US","United States","NA",,
302618,"CY","Cyprus","AS",,
302735,"NL","Netherlands","EU",,
302687,"FR","France","EU",,
302708,"IE","Ireland","EU",,
`;

const RUNWAYS =
  '"id","airport_ref","airport_ident","length_ft","width_ft","surface","lighted","closed","le_ident","le_latitude_deg","le_longitude_deg","le_elevation_ft","le_heading_degT","le_displaced_threshold_ft","he_ident","he_latitude_deg","he_longitude_deg","he_elevation_ft","he_heading_degT","he_displaced_threshold_ft"\n';

const type = (
  slug: string,
  name: string,
  category: string,
  engineType: string,
  engineCount: number,
) => ({
  slug,
  name,
  manufacturer: 'Manufacturer',
  category,
  engineType,
  engineCount,
  roles: ['multirole'],
  wikipedia: name,
});

const TYPES = {
  revisedAt: '2026-10-04',
  types: [
    type('typhoon', 'Eurofighter Typhoon', 'fast_jet', 'turbofan', 2),
    type('a400m', 'Airbus A400M Atlas', 'transport', 'turboprop', 4),
    type('c-17', 'Boeing C-17 Globemaster III', 'transport', 'turbofan', 4),
    type('voyager', 'Airbus A330 MRTT', 'tanker', 'turbofan', 2),
  ],
};

const block = (page: string, values: Record<string, number>) => ({
  page,
  revisionId: 1,
  revisionTimestamp: '2026-10-01T00:00:00Z',
  heading: 'Specifications',
  attributes: Object.entries(values).map(([key, value]) => ({
    key,
    value,
    sourceText: `${key}=${value}`,
  })),
});

const ATTRIBUTES = {
  retrievedAt: '2026-10-04T10:00:00.000Z',
  types: {
    typhoon: block('Eurofighter Typhoon', {
      empty_mass_kg: 11000,
      max_takeoff_mass_kg: 23500,
      max_speed_kmh: 2495,
      range_km: 2900,
      ferry_range_km: 3790,
      service_ceiling_m: 16764,
    }),
    a400m: block('Airbus A400M Atlas', {
      empty_mass_kg: 78600,
      max_takeoff_mass_kg: 141000,
      cruise_speed_kmh: 781,
      range_km: 3300,
      ferry_range_km: 8700,
      service_ceiling_m: 12200,
    }),
    'c-17': block('Boeing C-17 Globemaster III', {
      empty_mass_kg: 128140,
      max_takeoff_mass_kg: 265352,
      cruise_speed_kmh: 833,
      range_km: 4482,
      ferry_range_km: 11538,
      service_ceiling_m: 13716,
    }),
  },
};

export const FLIGHT_REFERENCE_INPUTS: ReferenceInputs = {
  countries: rawFixture(COUNTRIES, 'countries'),
  airports: rawFixture(AIRPORTS, 'airports'),
  runways: rawFixture(RUNWAYS, 'runways'),
  cities: rawFixture(JSON.stringify({ type: 'FeatureCollection', features: [] }), 'cities'),
  aircraftTypes: rawFixture(JSON.stringify(TYPES), 'aircraft-types'),
  aircraftAttributes: rawFixture(JSON.stringify(ATTRIBUTES), 'aircraft-attributes'),
  aircraftCharacteristics: rawFixture(
    JSON.stringify({ revisedAt: '2026-10-04', entries: [] }),
    'aircraft-characteristics',
  ),
};

import { schema, type AegisDb } from '@aegis/db';
import { loadDataset, type JobReport, type LoadOptions, type ReferenceTable } from './load';
import type { NormalisedDataset, RawInput } from './model';
import {
  normaliseAircraftAttributes,
  normaliseAircraftTypes,
  readCuratedTypes,
} from './sources/aircraft';
import { normaliseCuratedCharacteristics } from './sources/aircraft-curated';
import { applyRangeConditions } from './sources/range-conditions';
import { normaliseCities } from './sources/natural-earth';
import { normaliseAirports, normaliseCountries, normaliseRunways } from './sources/ourairports';

export interface ReferenceInputs {
  readonly countries: RawInput;
  readonly airports: RawInput;
  readonly runways: RawInput;
  readonly cities: RawInput;
  readonly aircraftTypes: RawInput;
  readonly aircraftAttributes: RawInput;
  readonly aircraftCharacteristics: RawInput;
  /** Conditions under which published ranges hold. Without it every condition is unknown. */
  readonly aircraftRangeConditions?: RawInput;
}

/** Tables a dataset may be loaded into, by SQL name. */
export const REFERENCE_TABLES = {
  ref_country: schema.refCountry,
  ref_location: schema.refLocation,
  ref_runway: schema.refRunway,
  ref_aircraft_type: schema.refAircraftType,
  ref_aircraft_attribute: schema.refAircraftAttribute,
} as const satisfies Record<string, ReferenceTable>;

export type ReferenceTableName = keyof typeof REFERENCE_TABLES;

/** A normalised dataset and the table it belongs in. Plain data: this is what a data pack holds. */
export interface PreparedDataset {
  readonly table: ReferenceTableName;
  readonly data: NormalisedDataset<{ sourceKey: string }>;
}

/**
 * Normalises every reference dataset, in dependency order: countries, aerodromes, runways, cities,
 * aircraft types, aircraft characteristics. Pure: same inputs, same output.
 */
export function normaliseReferenceData(inputs: ReferenceInputs): PreparedDataset[] {
  const countries = normaliseCountries(inputs.countries);
  const knownCountries = new Set(countries.rows.map((row) => row.iso2));
  const airports = normaliseAirports(inputs.airports, knownCountries);
  const airportKeys = new Set(airports.rows.map((row) => row.sourceKey));
  const curatedTypes = readCuratedTypes(inputs.aircraftTypes.text).types;
  const conditions = inputs.aircraftRangeConditions?.text ?? null;

  return [
    { table: 'ref_country', data: countries },
    { table: 'ref_location', data: airports },
    { table: 'ref_runway', data: normaliseRunways(inputs.runways, airportKeys) },
    { table: 'ref_location', data: normaliseCities(inputs.cities, knownCountries) },
    { table: 'ref_aircraft_type', data: normaliseAircraftTypes(inputs.aircraftTypes) },
    {
      table: 'ref_aircraft_attribute',
      data: applyRangeConditions(
        normaliseAircraftAttributes(inputs.aircraftAttributes, curatedTypes),
        conditions,
        'wikipedia',
      ),
    },
    {
      table: 'ref_aircraft_attribute',
      data: applyRangeConditions(
        normaliseCuratedCharacteristics(inputs.aircraftCharacteristics, curatedTypes),
        conditions,
        'aegis-curated',
      ),
    },
  ];
}

export interface LoadReferenceOptions extends LoadOptions {
  /** Called before each dataset is loaded. */
  readonly onDataset?: (dataset: string, index: number, total: number) => void;
}

/**
 * Loads prepared datasets in order. Each dataset is its own transaction. If one fails, those after
 * it are not attempted; the returned reports end with the failed job.
 */
export async function loadReferenceData(
  db: AegisDb,
  prepared: readonly PreparedDataset[],
  options: LoadReferenceOptions,
): Promise<JobReport[]> {
  const reports: JobReport[] = [];
  for (const [index, { table, data }] of prepared.entries()) {
    options.onDataset?.(data.dataset, index, prepared.length);
    const report = await loadDataset(db, REFERENCE_TABLES[table], data, options);
    reports.push(report);
    if (report.status !== 'succeeded') break;
  }
  return reports;
}

/** Normalises raw inputs and loads them: the path used by `npm run data:import`. */
export function importReferenceData(
  db: AegisDb,
  inputs: ReferenceInputs,
  options: LoadReferenceOptions,
): Promise<JobReport[]> {
  return loadReferenceData(db, normaliseReferenceData(inputs), options);
}

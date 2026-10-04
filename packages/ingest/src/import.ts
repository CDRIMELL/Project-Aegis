import { schema, type AegisDb } from '@aegis/db';
import { loadDataset, type JobReport, type LoadOptions } from './load';
import type { RawInput } from './model';
import {
  normaliseAircraftAttributes,
  normaliseAircraftTypes,
  readCuratedTypes,
} from './sources/aircraft';
import { normaliseCities } from './sources/natural-earth';
import { normaliseAirports, normaliseCountries, normaliseRunways } from './sources/ourairports';

export interface ReferenceInputs {
  readonly countries: RawInput;
  readonly airports: RawInput;
  readonly runways: RawInput;
  readonly cities: RawInput;
  readonly aircraftTypes: RawInput;
  readonly aircraftAttributes: RawInput;
}

/**
 * Imports every reference dataset in dependency order: countries, aerodromes, runways, cities,
 * aircraft types, aircraft characteristics.
 *
 * Each dataset is its own transaction. If one fails, the datasets that depend on it are not
 * attempted; the returned reports end with the failed job.
 */
export async function importReferenceData(
  db: AegisDb,
  inputs: ReferenceInputs,
  options: LoadOptions,
): Promise<JobReport[]> {
  const reports: JobReport[] = [];
  const run = async (load: Promise<JobReport>): Promise<boolean> => {
    const report = await load;
    reports.push(report);
    return report.status === 'succeeded';
  };

  const countries = normaliseCountries(inputs.countries);
  const knownCountries = new Set(countries.rows.map((row) => row.iso2));
  if (!(await run(loadDataset(db, schema.refCountry, countries, options)))) return reports;

  const airports = normaliseAirports(inputs.airports, knownCountries);
  if (!(await run(loadDataset(db, schema.refLocation, airports, options)))) return reports;

  const airportKeys = new Set(airports.rows.map((row) => row.sourceKey));
  const runways = normaliseRunways(inputs.runways, airportKeys);
  if (!(await run(loadDataset(db, schema.refRunway, runways, options)))) return reports;

  const cities = normaliseCities(inputs.cities, knownCountries);
  if (!(await run(loadDataset(db, schema.refLocation, cities, options)))) return reports;

  const types = normaliseAircraftTypes(inputs.aircraftTypes);
  if (!(await run(loadDataset(db, schema.refAircraftType, types, options)))) return reports;

  const curated = readCuratedTypes(inputs.aircraftTypes.text).types;
  const attributes = normaliseAircraftAttributes(inputs.aircraftAttributes, curated);
  await run(loadDataset(db, schema.refAircraftAttribute, attributes, options));

  return reports;
}

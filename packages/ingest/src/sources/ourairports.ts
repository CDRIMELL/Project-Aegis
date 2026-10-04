import { feet, feetToMetres, isValidLatLon } from '@aegis/domain';
import type { schema } from '@aegis/db';
import { parseCsv, type CsvRecord } from '../csv';
import {
  IssueLog,
  sourceId,
  type CountryRecord,
  type LocationRecord,
  type NormalisedDataset,
  type RawInput,
  type RunwayRecord,
} from '../model';

const SOURCE = 'ourairports';

/*
 * OurAirports is community-maintained and makes no accuracy guarantee, so its aerodrome records
 * are rated `medium`. They are taken mechanically from an identified file: `source_asserted`.
 */
const AERODROME_PROVENANCE = { confidence: 'medium', verification: 'source_asserted' } as const;

/** Aerodrome types imported, and what they become. Every other type is out of scope and skipped. */
const AIRPORT_KINDS: Readonly<Record<string, schema.LocationKind>> = {
  large_airport: 'airport_large',
  medium_airport: 'airport_medium',
  small_airport: 'airport_small',
};

const CONTINENTS = new Set(['AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA']);

function text(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/** Parses a number; `null` when blank, `NaN` when present but not numeric. */
function number(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) return null;
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function feetAsMetres(value: number, decimals: number): number {
  return round(feetToMetres(feet(value)), decimals);
}

function requireColumns(
  header: readonly string[],
  required: readonly string[],
  file: string,
): void {
  const missing = required.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new Error(`${file} is missing expected columns: ${missing.join(', ')}`);
  }
}

function reportMalformed(
  log: IssueLog,
  malformed: readonly { line: number; reason: string }[],
): void {
  for (const row of malformed) {
    log.error('malformed_row', null, `Line ${row.line}: ${row.reason}`);
  }
}

function describe(dataset: string, raw: RawInput) {
  return {
    dataset,
    sourceId: SOURCE,
    raw: { url: raw.url, sha256: raw.sha256, retrievedAt: raw.retrievedAt },
  };
}

export function normaliseCountries(raw: RawInput): NormalisedDataset<CountryRecord> {
  const csv = parseCsv(raw.text);
  requireColumns(csv.header, ['code', 'name', 'continent'], 'countries.csv');
  const log = new IssueLog();
  reportMalformed(log, csv.malformed);

  const rows: CountryRecord[] = [];
  for (const { values, line } of csv.records) {
    const code = text(values.code);
    const name = text(values.name);
    const continent = text(values.continent);
    if (!code || !/^[A-Z]{2}$/.test(code)) {
      log.error(
        'invalid_country_code',
        code,
        `Line ${line}: country code must be two capital letters`,
      );
      continue;
    }
    if (!name) {
      log.error('missing_name', code, `Line ${line}: country has no name`);
      continue;
    }
    if (!continent || !CONTINENTS.has(continent)) {
      log.error('invalid_continent', code, `Line ${line}: unknown continent "${continent ?? ''}"`);
      continue;
    }
    rows.push({
      sourceKey: code,
      confidence: 'high',
      verification: 'source_asserted',
      iso2: code,
      name,
      continent,
    });
  }
  return {
    ...describe('ourairports-countries', raw),
    rowsRead: csv.records.length + csv.malformed.length,
    rowsSkipped: 0,
    rows,
    issues: log.issues,
  };
}

function normaliseAirport(
  { values, line }: CsvRecord,
  kind: schema.LocationKind,
  knownCountries: ReadonlySet<string>,
  log: IssueLog,
): LocationRecord | null {
  const key = text(values.id);
  if (!key || !/^\d+$/.test(key)) {
    log.error('invalid_id', key, `Line ${line}: aerodrome id must be a whole number`);
    return null;
  }
  const name = text(values.name);
  if (!name) {
    log.error('missing_name', key, `Line ${line}: aerodrome has no name`);
    return null;
  }
  const lat = number(values.latitude_deg);
  const lon = number(values.longitude_deg);
  if (lat === null || lon === null || !isValidLatLon(lat, lon)) {
    log.error(
      'invalid_coordinates',
      key,
      `Line ${line}: coordinates "${values.latitude_deg ?? ''}", "${values.longitude_deg ?? ''}" are not a valid position`,
    );
    return null;
  }

  // Problems below lose one field, not the record.
  let elevationM: number | null = null;
  const elevationFt = number(values.elevation_ft);
  if (elevationFt !== null) {
    if (Number.isNaN(elevationFt) || elevationFt < -1500 || elevationFt > 30000) {
      log.warning(
        'implausible_elevation',
        key,
        `Elevation "${values.elevation_ft ?? ''}" ft was dropped`,
      );
    } else {
      elevationM = feetAsMetres(elevationFt, 1);
    }
  }

  let countryIso2 = text(values.iso_country);
  if (countryIso2 !== null && !knownCountries.has(countryIso2)) {
    log.warning('unknown_country', key, `Country code "${countryIso2}" is not in the country list`);
    countryIso2 = null;
  }

  let icao = text(values.icao_code);
  if (icao !== null && !/^[A-Z]{4}$/.test(icao)) {
    log.warning(
      'invalid_icao_code',
      key,
      `ICAO code "${icao}" is not four capital letters and was dropped`,
    );
    icao = null;
  }
  let iata = text(values.iata_code);
  if (iata !== null && !/^[A-Z0-9]{3}$/.test(iata)) {
    log.warning(
      'invalid_iata_code',
      key,
      `IATA code "${iata}" is not three characters and was dropped`,
    );
    iata = null;
  }

  const service = text(values.scheduled_service);
  return {
    sourceKey: key,
    ...AERODROME_PROVENANCE,
    kind,
    name,
    lat,
    lon,
    elevationM,
    countryIso2,
    regionCode: text(values.iso_region),
    municipality: text(values.municipality),
    ident: text(values.ident),
    icao,
    iata,
    scheduledService: service === 'yes' ? true : service === 'no' ? false : null,
    population: null,
  };
}

/**
 * @param knownCountries ISO codes present in the country dataset. An aerodrome naming any other
 * code keeps its record but loses the country link, with a warning.
 */
export function normaliseAirports(
  raw: RawInput,
  knownCountries: ReadonlySet<string>,
): NormalisedDataset<LocationRecord> {
  const csv = parseCsv(raw.text);
  requireColumns(
    csv.header,
    ['id', 'ident', 'type', 'name', 'latitude_deg', 'longitude_deg', 'elevation_ft', 'iso_country'],
    'airports.csv',
  );
  const log = new IssueLog();
  reportMalformed(log, csv.malformed);

  const rows: LocationRecord[] = [];
  let skipped = 0;
  for (const record of csv.records) {
    const kind = AIRPORT_KINDS[record.values.type ?? ''];
    if (!kind) {
      skipped++;
      continue;
    }
    const row = normaliseAirport(record, kind, knownCountries, log);
    if (row) rows.push(row);
  }
  return {
    ...describe('ourairports-airports', raw),
    rowsRead: csv.records.length + csv.malformed.length,
    rowsSkipped: skipped,
    rows,
    issues: log.issues,
  };
}

function heading(
  value: string | undefined,
  key: string,
  end: string,
  log: IssueLog,
): number | null {
  const parsed = number(value);
  if (parsed === null) return null;
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 360) {
    log.warning('invalid_heading', key, `${end} heading "${value ?? ''}" was dropped`);
    return null;
  }
  return parsed;
}

function dimension(
  value: string | undefined,
  key: string,
  name: string,
  log: IssueLog,
): number | null {
  const parsed = number(value);
  if (parsed === null) return null;
  if (Number.isNaN(parsed) || parsed <= 0) {
    // Zero is how the source commonly records "unknown"; it is not reported as a defect.
    if (parsed !== 0) {
      log.warning('invalid_dimension', key, `Runway ${name} "${value ?? ''}" ft was dropped`);
    }
    return null;
  }
  return feetAsMetres(parsed, 1);
}

/**
 * @param importedAirportKeys Source ids of the aerodromes that were imported. Runways of any other
 * aerodrome (heliports, closed fields and so on) are out of scope and skipped.
 */
export function normaliseRunways(
  raw: RawInput,
  importedAirportKeys: ReadonlySet<string>,
): NormalisedDataset<RunwayRecord> {
  const csv = parseCsv(raw.text);
  requireColumns(
    csv.header,
    [
      'id',
      'airport_ref',
      'length_ft',
      'width_ft',
      'surface',
      'lighted',
      'closed',
      'le_ident',
      'he_ident',
    ],
    'runways.csv',
  );
  const log = new IssueLog();
  reportMalformed(log, csv.malformed);

  const rows: RunwayRecord[] = [];
  let skipped = 0;
  for (const { values, line } of csv.records) {
    const airportKey = text(values.airport_ref);
    if (!airportKey || !importedAirportKeys.has(airportKey)) {
      skipped++;
      continue;
    }
    const key = text(values.id);
    if (!key || !/^\d+$/.test(key)) {
      log.error('invalid_id', key, `Line ${line}: runway id must be a whole number`);
      continue;
    }
    rows.push({
      sourceKey: key,
      ...AERODROME_PROVENANCE,
      locationId: sourceId(SOURCE, airportKey),
      lengthM: dimension(values.length_ft, key, 'length', log),
      widthM: dimension(values.width_ft, key, 'width', log),
      surface: text(values.surface),
      lighted: text(values.lighted) === '1',
      closed: text(values.closed) === '1',
      lowEndIdent: text(values.le_ident),
      highEndIdent: text(values.he_ident),
      lowEndHeadingDeg: heading(values.le_heading_degT, key, 'Low-end', log),
      highEndHeadingDeg: heading(values.he_heading_degT, key, 'High-end', log),
    });
  }
  return {
    ...describe('ourairports-runways', raw),
    rowsRead: csv.records.length + csv.malformed.length,
    rowsSkipped: skipped,
    rows,
    issues: log.issues,
  };
}

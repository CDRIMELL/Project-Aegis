import { schema, type AegisDb } from '@aegis/db';
import { asc, desc, eq, isNotNull, or, sql } from 'drizzle-orm';
import type { MapLocationRow, MapRunwayRow } from '../map/features';

/*
 * Read-only queries over reference data, for the UI. Reference tables are never written from here:
 * only the ingestion pipeline writes them (ADR 0012).
 */

let db: AegisDb;

/**
 * Sets the database these queries read. The application binds the native transport at start-up;
 * tests bind an in-memory database.
 */
export function bindReferenceDb(database: AegisDb): void {
  db = database;
}
const { refCountry, refDataSource, refIngestionJob, refLocation, refPackInstall, refRunway } =
  schema;

/** Every location, with just the columns the map draws from. */
export function loadMapLocations(): Promise<MapLocationRow[]> {
  return db
    .select({
      id: refLocation.id,
      kind: refLocation.kind,
      name: refLocation.name,
      lat: refLocation.lat,
      lon: refLocation.lon,
      ident: refLocation.ident,
      icao: refLocation.icao,
      iata: refLocation.iata,
      population: refLocation.population,
      scheduledService: refLocation.scheduledService,
    })
    .from(refLocation);
}

/** Runways that have both threshold positions and so can be drawn. */
export function loadMapRunways(): Promise<MapRunwayRow[]> {
  return db
    .select({
      id: refRunway.id,
      locationId: refRunway.locationId,
      lowEndIdent: refRunway.lowEndIdent,
      highEndIdent: refRunway.highEndIdent,
      lowEndLat: refRunway.lowEndLat,
      lowEndLon: refRunway.lowEndLon,
      highEndLat: refRunway.highEndLat,
      highEndLon: refRunway.highEndLon,
      closed: refRunway.closed,
    })
    .from(refRunway)
    .where(isNotNull(refRunway.lowEndLat));
}

/** Where a record came from: its source, and the import run that wrote it. */
export interface Provenance {
  readonly sourceName: string;
  readonly sourceUrl: string;
  readonly licence: string;
  readonly confidence: schema.Confidence;
  readonly verification: schema.Verification;
  readonly sourceKey: string;
  readonly rawUrl: string;
  readonly rawSha256: string;
  readonly rawRetrievedAt: string;
  readonly importedWallMs: number | null;
}

const provenanceColumns = {
  sourceName: refDataSource.name,
  sourceUrl: refDataSource.url,
  licence: refDataSource.licence,
  rawUrl: refIngestionJob.rawUrl,
  rawSha256: refIngestionJob.rawSha256,
  rawRetrievedAt: refIngestionJob.rawRetrievedAt,
  importedWallMs: refIngestionJob.finishedWallMs,
};

export type LocationRecord = typeof refLocation.$inferSelect;
export type RunwayRecord = typeof refRunway.$inferSelect;

export interface LocationDetail {
  readonly location: LocationRecord;
  readonly country: {
    readonly iso2: string;
    readonly name: string;
    readonly continent: string;
  } | null;
  readonly runways: RunwayRecord[];
  readonly provenance: Provenance;
}

export async function loadLocationDetail(id: string): Promise<LocationDetail | null> {
  const [found] = await db
    .select({ location: refLocation, ...provenanceColumns })
    .from(refLocation)
    .innerJoin(refDataSource, eq(refDataSource.id, refLocation.sourceId))
    .innerJoin(refIngestionJob, eq(refIngestionJob.id, refLocation.jobId))
    .where(eq(refLocation.id, id));
  if (!found) return null;
  const { location, ...source } = found;

  const [countries, runways] = await Promise.all([
    location.countryIso2
      ? db
          .select({ iso2: refCountry.iso2, name: refCountry.name, continent: refCountry.continent })
          .from(refCountry)
          .where(eq(refCountry.iso2, location.countryIso2))
      : Promise.resolve([]),
    db
      .select()
      .from(refRunway)
      .where(eq(refRunway.locationId, id))
      .orderBy(desc(refRunway.lengthM)),
  ]);

  return {
    location,
    country: countries[0] ?? null,
    runways,
    provenance: {
      ...source,
      confidence: location.confidence,
      verification: location.verification,
      sourceKey: location.sourceKey,
    },
  };
}

export interface CountryDetail {
  readonly iso2: string;
  readonly name: string;
  readonly continent: string;
  /** Locations held for this country, by kind. */
  readonly counts: Readonly<Record<schema.LocationKind, number>>;
  readonly provenance: Provenance;
}

export async function loadCountryDetail(iso2: string): Promise<CountryDetail | null> {
  const [found] = await db
    .select({ country: refCountry, ...provenanceColumns })
    .from(refCountry)
    .innerJoin(refDataSource, eq(refDataSource.id, refCountry.sourceId))
    .innerJoin(refIngestionJob, eq(refIngestionJob.id, refCountry.jobId))
    .where(eq(refCountry.iso2, iso2));
  if (!found) return null;
  const { country, ...source } = found;

  const kinds = await db
    .select({ kind: refLocation.kind, count: sql<number>`count(*)` })
    .from(refLocation)
    .where(eq(refLocation.countryIso2, iso2))
    .groupBy(refLocation.kind);
  const counts = { airport_large: 0, airport_medium: 0, airport_small: 0, city: 0 };
  for (const row of kinds) counts[row.kind] = row.count;

  return {
    iso2: country.iso2,
    name: country.name,
    continent: country.continent,
    counts,
    provenance: {
      ...source,
      confidence: country.confidence,
      verification: country.verification,
      sourceKey: country.sourceKey,
    },
  };
}

export interface SearchResult {
  readonly id: string;
  readonly kind: schema.LocationKind;
  readonly name: string;
  readonly code: string | null;
  readonly countryIso2: string | null;
  readonly municipality: string | null;
  readonly lat: number;
  readonly lon: number;
}

/** Escapes the characters that are wildcards in a LIKE pattern. */
export function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

/**
 * Finds locations by ICAO code, IATA code or name. Exact code matches come first, then larger
 * places before smaller ones.
 */
export async function searchLocations(query: string, limit = 12): Promise<SearchResult[]> {
  const term = query.trim();
  if (term.length < 2) return [];
  const code = term.toUpperCase();
  const rows = await db
    .select({
      id: refLocation.id,
      kind: refLocation.kind,
      name: refLocation.name,
      icao: refLocation.icao,
      iata: refLocation.iata,
      countryIso2: refLocation.countryIso2,
      municipality: refLocation.municipality,
      lat: refLocation.lat,
      lon: refLocation.lon,
    })
    .from(refLocation)
    .where(
      or(
        eq(refLocation.icao, code),
        eq(refLocation.iata, code),
        sql`${refLocation.name} LIKE ${likePattern(term)} ESCAPE '\\'`,
      ),
    )
    .orderBy(
      desc(sql`${refLocation.icao} = ${code} OR ${refLocation.iata} = ${code}`),
      asc(
        sql`CASE ${refLocation.kind} WHEN 'airport_large' THEN 0 WHEN 'city' THEN 1 WHEN 'airport_medium' THEN 2 ELSE 3 END`,
      ),
      desc(sql`coalesce(${refLocation.population}, 0)`),
      asc(refLocation.name),
    )
    .limit(limit);
  return rows.map(({ icao, iata, ...row }) => ({ ...row, code: icao ?? iata }));
}

export interface DatasetSummary {
  readonly dataset: string;
  readonly sourceName: string;
  readonly licence: string;
  readonly rows: number;
  readonly issues: number;
  readonly rawRetrievedAt: string;
  readonly rawSha256: string;
  readonly importedWallMs: number | null;
}

/** Restricts to each dataset's most recent successful import. */
const LATEST_SUCCESSFUL_JOB = sql`${refIngestionJob.id} IN (SELECT max(id) FROM ref_ingestion_job WHERE status = 'succeeded' GROUP BY dataset)`;

export interface ReferenceSummary {
  readonly pack: typeof refPackInstall.$inferSelect | null;
  readonly datasets: DatasetSummary[];
}

/** One line per dataset, describing its most recent successful import. */
export async function loadReferenceSummary(): Promise<ReferenceSummary> {
  const [packs, datasets] = await Promise.all([
    db.select().from(refPackInstall).orderBy(desc(refPackInstall.id)).limit(1),
    db
      .select({
        dataset: refIngestionJob.dataset,
        sourceName: refDataSource.name,
        licence: refDataSource.licence,
        rows: sql<number>`${refIngestionJob.rowsInserted} + ${refIngestionJob.rowsUpdated} + ${refIngestionJob.rowsUnchanged}`,
        issues: refIngestionJob.issueCount,
        rawRetrievedAt: refIngestionJob.rawRetrievedAt,
        rawSha256: refIngestionJob.rawSha256,
        importedWallMs: refIngestionJob.finishedWallMs,
      })
      .from(refIngestionJob)
      .innerJoin(refDataSource, eq(refDataSource.id, refIngestionJob.sourceId))
      .where(LATEST_SUCCESSFUL_JOB)
      .orderBy(asc(refIngestionJob.id)),
  ]);
  return { pack: packs[0] ?? null, datasets };
}

export interface IssueSummary {
  readonly dataset: string;
  readonly severity: schema.IssueSeverity;
  readonly code: string;
  readonly count: number;
}

/** Issues from each dataset's most recent import, grouped by reason. */
export function loadIssueSummary(): Promise<IssueSummary[]> {
  const { refIngestionIssue } = schema;
  return db
    .select({
      dataset: refIngestionJob.dataset,
      severity: refIngestionIssue.severity,
      code: refIngestionIssue.code,
      count: sql<number>`count(*)`,
    })
    .from(refIngestionIssue)
    .innerJoin(refIngestionJob, eq(refIngestionJob.id, refIngestionIssue.jobId))
    .where(LATEST_SUCCESSFUL_JOB)
    .groupBy(refIngestionJob.dataset, refIngestionIssue.severity, refIngestionIssue.code)
    .orderBy(asc(refIngestionJob.id), desc(sql`count(*)`));
}

export type AircraftTypeRecord = typeof schema.refAircraftType.$inferSelect;
export type AircraftAttributeRecord = typeof schema.refAircraftAttribute.$inferSelect;

/** Every reference aircraft type with every characteristic any source asserts for it. */
export async function loadAircraftTypes(): Promise<{
  types: AircraftTypeRecord[];
  attributes: AircraftAttributeRecord[];
}> {
  const [types, attributes] = await Promise.all([
    db.select().from(schema.refAircraftType).orderBy(asc(schema.refAircraftType.name)),
    db.select().from(schema.refAircraftAttribute),
  ]);
  return { types, attributes };
}

/** One aerodrome by reference id, or by ICAO code. */
export async function loadAerodrome(
  key: { readonly id: string } | { readonly icao: string },
): Promise<LocationRecord | null> {
  const rows = await db
    .select()
    .from(refLocation)
    .where('id' in key ? eq(refLocation.id, key.id) : eq(refLocation.icao, key.icao))
    .limit(1);
  const found = rows[0];
  return found && found.kind !== 'city' ? found : null;
}

/** Aerodromes matching a search, for choosing a home or a destination. */
export async function searchAerodromes(query: string, limit = 8): Promise<SearchResult[]> {
  const results = await searchLocations(query, limit * 3);
  return results.filter((result) => result.kind !== 'city').slice(0, limit);
}

import { sql } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/*
 * Reference data (ADR 0012). Written only by the ingestion pipeline, never by the simulation.
 * Re-exported from `schema.ts`, which is the file drizzle-kit reads.
 */

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

/**
 * - `unverified`: entered by hand, not yet checked against a retrieved source.
 * - `source_asserted`: taken mechanically from one identified source at a recorded revision.
 * - `cross_checked`: agrees across two independent sources.
 */
export const VERIFICATION_LEVELS = ['unverified', 'source_asserted', 'cross_checked'] as const;
export type Verification = (typeof VERIFICATION_LEVELS)[number];

/** A publisher of reference data and the terms under which its data is used. */
export const refDataSource = sqliteTable('ref_data_source', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  publisher: text('publisher').notNull(),
  url: text('url').notNull(),
  licence: text('licence').notNull(),
  licenceNote: text('licence_note'),
});

export const INGESTION_STATUSES = ['running', 'succeeded', 'failed'] as const;

/** One import run of one dataset. The audit record behind every reference row. */
export const refIngestionJob = sqliteTable(
  'ref_ingestion_job',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    dataset: text('dataset').notNull(),
    sourceId: text('source_id')
      .notNull()
      .references(() => refDataSource.id),
    pipelineVersion: integer('pipeline_version').notNull(),
    status: text('status', { enum: INGESTION_STATUSES }).notNull(),
    startedWallMs: integer('started_wall_ms').notNull(),
    finishedWallMs: integer('finished_wall_ms'),
    /** Where the raw input came from and exactly which bytes were read. */
    rawUrl: text('raw_url').notNull(),
    rawSha256: text('raw_sha256').notNull(),
    rawRetrievedAt: text('raw_retrieved_at').notNull(),
    rowsRead: integer('rows_read').notNull().default(0),
    /** Read but deliberately not imported, for example heliports. Not a defect. */
    rowsSkipped: integer('rows_skipped').notNull().default(0),
    rowsRejected: integer('rows_rejected').notNull().default(0),
    rowsInserted: integer('rows_inserted').notNull().default(0),
    rowsUpdated: integer('rows_updated').notNull().default(0),
    rowsUnchanged: integer('rows_unchanged').notNull().default(0),
    /** Present in the database from this dataset but absent from this input. Kept, not deleted. */
    rowsMissingFromSource: integer('rows_missing_from_source').notNull().default(0),
    issueCount: integer('issue_count').notNull().default(0),
    error: text('error'),
  },
  (t) => [index('ref_ingestion_job_dataset_idx').on(t.dataset, t.id)],
);

export const ISSUE_SEVERITIES = ['error', 'warning'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

/** A record that was rejected (`error`) or imported with a caveat (`warning`), and why. */
export const refIngestionIssue = sqliteTable(
  'ref_ingestion_issue',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobId: integer('job_id')
      .notNull()
      .references(() => refIngestionJob.id),
    severity: text('severity', { enum: ISSUE_SEVERITIES }).notNull(),
    code: text('code').notNull(),
    recordKey: text('record_key'),
    message: text('message').notNull(),
  },
  (t) => [index('ref_ingestion_issue_job_idx').on(t.jobId)],
);

/** Columns every reference record carries. The id is always `<source_id>:<source_key>`. */
const provenance = () => ({
  id: text('id').primaryKey(),
  /** The dataset that owns this row; one dataset maps to one raw input. */
  dataset: text('dataset').notNull(),
  sourceId: text('source_id')
    .notNull()
    .references(() => refDataSource.id),
  sourceKey: text('source_key').notNull(),
  /** The import run that last inserted or changed this row. */
  jobId: integer('job_id')
    .notNull()
    .references(() => refIngestionJob.id),
  confidence: text('confidence', { enum: CONFIDENCE_LEVELS }).notNull(),
  verification: text('verification', { enum: VERIFICATION_LEVELS }).notNull(),
  /** Hash of the normalised content, used to detect change between imports. */
  contentHash: text('content_hash').notNull(),
});

export const refCountry = sqliteTable('ref_country', {
  ...provenance(),
  /** ISO 3166-1 alpha-2, or the source's user-assigned code where no ISO code exists. */
  iso2: text('iso2').notNull().unique(),
  name: text('name').notNull(),
  /** Two-letter continent code as used by the source (AF, AN, AS, EU, NA, OC, SA). */
  continent: text('continent').notNull(),
});

export const LOCATION_KINDS = ['airport_large', 'airport_medium', 'airport_small', 'city'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/** A real place on the map: an aerodrome or a city. */
export const refLocation = sqliteTable(
  'ref_location',
  {
    ...provenance(),
    kind: text('kind', { enum: LOCATION_KINDS }).notNull(),
    name: text('name').notNull(),
    lat: real('lat').notNull(),
    lon: real('lon').notNull(),
    elevationM: real('elevation_m'),
    countryIso2: text('country_iso2').references(() => refCountry.iso2),
    /** ISO 3166-2 style region code where the source provides one. */
    regionCode: text('region_code'),
    municipality: text('municipality'),
    /** The source's own identifier for an aerodrome; often but not always the ICAO code. */
    ident: text('ident'),
    icao: text('icao'),
    iata: text('iata'),
    scheduledService: integer('scheduled_service', { mode: 'boolean' }),
    population: integer('population'),
  },
  (t) => [
    check('ref_location_lat_range', sql`${t.lat} between -90 and 90`),
    check('ref_location_lon_range', sql`${t.lon} between -180 and 180`),
    index('ref_location_kind_idx').on(t.kind),
    index('ref_location_country_idx').on(t.countryIso2),
    index('ref_location_icao_idx').on(t.icao),
    index('ref_location_iata_idx').on(t.iata),
  ],
);

export const refRunway = sqliteTable(
  'ref_runway',
  {
    ...provenance(),
    locationId: text('location_id')
      .notNull()
      .references(() => refLocation.id),
    lengthM: real('length_m'),
    widthM: real('width_m'),
    /** Surface as written by the source; not normalised to a controlled vocabulary yet. */
    surface: text('surface'),
    lighted: integer('lighted', { mode: 'boolean' }).notNull(),
    closed: integer('closed', { mode: 'boolean' }).notNull(),
    lowEndIdent: text('low_end_ident'),
    highEndIdent: text('high_end_ident'),
    lowEndHeadingDeg: real('low_end_heading_deg'),
    highEndHeadingDeg: real('high_end_heading_deg'),
  },
  (t) => [index('ref_runway_location_idx').on(t.locationId)],
);

export const AIRCRAFT_CATEGORIES = [
  'fast_jet',
  'transport',
  'tanker',
  'isr',
  'maritime_patrol',
  'trainer',
  'rotary',
  'uncrewed',
  'airliner',
  'regional_airliner',
  'business_jet',
  'freighter',
] as const;
export type AircraftCategory = (typeof AIRCRAFT_CATEGORIES)[number];

export const ENGINE_TYPES = ['turbofan', 'turboprop', 'turboshaft', 'piston'] as const;
export type EngineType = (typeof ENGINE_TYPES)[number];

/**
 * A real aircraft type. Identity and coarse classification only: no weapon, sensor, payload or
 * signature data is held anywhere in AEGIS (ADR 0011).
 */
export const refAircraftType = sqliteTable('ref_aircraft_type', {
  ...provenance(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  manufacturer: text('manufacturer').notNull(),
  category: text('category', { enum: AIRCRAFT_CATEGORIES }).notNull(),
  engineType: text('engine_type', { enum: ENGINE_TYPES }).notNull(),
  engineCount: integer('engine_count').notNull(),
  /** Designation in UK military service, where the type is or was publicly in such service. */
  ukServiceName: text('uk_service_name'),
  /** JSON array of coarse role tags, for example ["air_defence","multirole"]. */
  roles: text('roles').notNull(),
  referenceUrl: text('reference_url').notNull(),
});

export const AIRCRAFT_ATTRIBUTE_KEYS = [
  'length_m',
  'wingspan_m',
  'rotor_diameter_m',
  'height_m',
  'empty_mass_kg',
  'max_takeoff_mass_kg',
  'max_speed_kmh',
  'cruise_speed_kmh',
  'range_km',
  'ferry_range_km',
  'service_ceiling_m',
] as const;
export type AircraftAttributeKey = (typeof AIRCRAFT_ATTRIBUTE_KEYS)[number];

/**
 * One published characteristic of an aircraft type, as asserted by one source. Two sources that
 * disagree produce two rows; nothing is silently reconciled.
 */
export const refAircraftAttribute = sqliteTable(
  'ref_aircraft_attribute',
  {
    ...provenance(),
    typeId: text('type_id')
      .notNull()
      .references(() => refAircraftType.id),
    key: text('key', { enum: AIRCRAFT_ATTRIBUTE_KEYS }).notNull(),
    /** In the unit named by the key's suffix. */
    value: real('value').notNull(),
    /** The assertion exactly as the source wrote it, before unit conversion. */
    sourceText: text('source_text').notNull(),
    sourceUrl: text('source_url').notNull(),
    note: text('note'),
  },
  (t) => [index('ref_aircraft_attribute_type_idx').on(t.typeId, t.key)],
);

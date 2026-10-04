import { schema } from '@aegis/db';
import { KILOGRAMS_PER_POUND, METRES_PER_FOOT, METRES_PER_NAUTICAL_MILE } from '@aegis/domain';
import { z } from 'zod';
import {
  IssueLog,
  sourceId,
  type AircraftAttributeRecord,
  type NormalisedDataset,
  type RawInput,
} from '../model';
import type { CuratedAircraftType } from './aircraft';

/*
 * Hand-entered aircraft characteristics (ADR 0012, ADR 0013).
 *
 * Each value is copied from a named official page with the publisher's own wording kept in
 * `sourceText`. Values are stored in the source's unit and converted here, so no arithmetic is done
 * by hand. A value that could not be established is recorded as `null` with the reason.
 */

type Dimension = 'm' | 'kg' | 'kmh' | 'km';

/** Units a source may use, and how each converts to the stored unit of its dimension. */
const SOURCE_UNITS = {
  m: { dimension: 'm', factor: 1 },
  ft: { dimension: 'm', factor: METRES_PER_FOOT },
  kg: { dimension: 'kg', factor: 1 },
  t: { dimension: 'kg', factor: 1000 },
  lb: { dimension: 'kg', factor: KILOGRAMS_PER_POUND },
  kmh: { dimension: 'kmh', factor: 1 },
  kt: { dimension: 'kmh', factor: METRES_PER_NAUTICAL_MILE / 1000 },
  km: { dimension: 'km', factor: 1 },
  nmi: { dimension: 'km', factor: METRES_PER_NAUTICAL_MILE / 1000 },
} as const satisfies Record<string, { dimension: Dimension; factor: number }>;

type SourceUnit = keyof typeof SOURCE_UNITS;

/** Lengths keep centimetres; everything else is stored to the whole unit. */
const DECIMALS: Readonly<Record<schema.AircraftAttributeKey, number>> = {
  length_m: 2,
  wingspan_m: 2,
  rotor_diameter_m: 2,
  height_m: 2,
  empty_mass_kg: 0,
  max_takeoff_mass_kg: 0,
  max_speed_kmh: 0,
  cruise_speed_kmh: 0,
  range_km: 0,
  ferry_range_km: 0,
  service_ceiling_m: 0,
};

function dimensionOf(key: schema.AircraftAttributeKey): Dimension {
  return key.slice(key.lastIndexOf('_') + 1) as Dimension;
}

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const key = z.enum(schema.AIRCRAFT_ATTRIBUTE_KEYS);

// `.strict()`: an entry may carry nothing beyond these fields (ADR 0011).
const established = z
  .object({
    type: slug,
    key,
    sourceValue: z.number().positive(),
    sourceUnit: z.enum(Object.keys(SOURCE_UNITS) as [SourceUnit, ...SourceUnit[]]),
    /** The publisher's wording, so the entry can be checked against the page. */
    sourceText: z.string().trim().min(1),
    sourceName: z.string().trim().min(1),
    sourceUrl: z.url(),
    retrievedAt: z.iso.date(),
    note: z.string().trim().min(1).optional(),
  })
  .strict();

const notEstablished = z
  .object({
    type: slug,
    key,
    sourceValue: z.null(),
    reason: z.string().trim().min(1),
  })
  .strict();

const curatedFile = z
  .object({
    revisedAt: z.iso.date(),
    entries: z.array(z.unknown()),
  })
  .strict();

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** The date the curated file was last revised, used as its retrieval time. */
export function curatedCharacteristicsRevisedAt(text: string): string {
  return curatedFile.parse(JSON.parse(text)).revisedAt;
}

export function normaliseCuratedCharacteristics(
  raw: RawInput,
  curatedTypes: readonly CuratedAircraftType[],
): NormalisedDataset<AircraftAttributeRecord> {
  const file = curatedFile.parse(JSON.parse(raw.text));
  const known = new Set(curatedTypes.map((type) => type.slug));
  const log = new IssueLog();
  const rows: AircraftAttributeRecord[] = [];

  file.entries.forEach((candidate, index) => {
    const gap = notEstablished.safeParse(candidate);
    if (gap.success) {
      const recordKey = `${gap.data.type}/${gap.data.key}`;
      if (known.has(gap.data.type)) {
        log.warning('value_not_established', recordKey, gap.data.reason);
      } else {
        log.error('unknown_aircraft_type', recordKey, 'Entry refers to a type that is not curated');
      }
      return;
    }

    const result = established.safeParse(candidate);
    if (!result.success) {
      log.error('invalid_characteristic', null, `Entry ${index}: ${z.prettifyError(result.error)}`);
      return;
    }
    const entry = result.data;
    const recordKey = `${entry.type}/${entry.key}`;
    if (!known.has(entry.type)) {
      log.error('unknown_aircraft_type', recordKey, 'Entry refers to a type that is not curated');
      return;
    }
    const unit = SOURCE_UNITS[entry.sourceUnit];
    if (unit.dimension !== dimensionOf(entry.key)) {
      log.error(
        'unit_mismatch',
        recordKey,
        `A value in "${entry.sourceUnit}" cannot describe ${entry.key}`,
      );
      return;
    }

    rows.push({
      sourceKey: recordKey,
      // An official publisher's figure, but entered by hand and not yet independently checked.
      confidence: entry.note ? 'medium' : 'high',
      verification: 'unverified',
      typeId: sourceId('aegis-curated', entry.type),
      key: entry.key,
      value: round(entry.sourceValue * unit.factor, DECIMALS[entry.key]),
      sourceText: entry.sourceText,
      sourceUrl: entry.sourceUrl,
      note: [`${entry.sourceName}, retrieved ${entry.retrievedAt}.`, entry.note]
        .filter(Boolean)
        .join(' '),
    });
  });

  return {
    dataset: 'aircraft-characteristics-curated',
    sourceId: 'aegis-curated',
    raw: { url: raw.url, sha256: raw.sha256, retrievedAt: raw.retrievedAt },
    rowsRead: file.entries.length,
    rowsSkipped: 0,
    rows,
    issues: log.issues,
  };
}

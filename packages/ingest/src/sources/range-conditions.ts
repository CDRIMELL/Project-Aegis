import { KILOGRAMS_PER_POUND } from '@aegis/domain';
import { z } from 'zod';
import {
  IssueLog,
  type AircraftAttributeRecord,
  type Issue,
  type NormalisedDataset,
} from '../model';

/*
 * Conditions under which a published range holds (ADR 0019, ADR 0023).
 *
 * A range figure means little without its loading: the same aircraft flies much further empty
 * than full. This curated file records, for each range and ferry range, what the source says
 * about payload, fuel, speed and altitude, and external fuel, in the source's own words.
 *
 * What a source does not state is "unknown" and is never guessed. A loading that AEGIS does not
 * hold at all (ADR 0011) is "not_recorded". A range with no entry here has every condition
 * unknown, and is stored as such.
 */

const UNKNOWN = 'unknown';
const RANGE_KEYS = ['range_km', 'ferry_range_km'] as const;
const MASS_UNITS = { kg: 1, t: 1000, lb: KILOGRAMS_PER_POUND } as const;

const slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const text = z.string().trim().min(1);
const stated = z.union([z.literal(UNKNOWN), text]);

const entry = z
  .object({
    type: slug,
    key: z.enum(RANGE_KEYS),
    /** Which source's figure the conditions belong to. */
    source: z.enum(['wikipedia', 'aegis-curated']),
    /** The source's wording, so the entry can be checked against the page. */
    sourceText: text,
    sourceName: text,
    sourceUrl: z.url(),
    retrievedAt: z.iso.date(),
    /** The payload carried, in the source's unit; converted in code. */
    payload: z.union([
      z.literal(UNKNOWN),
      z.literal('not_recorded'),
      z
        .object({
          sourceValue: z.number().positive(),
          sourceUnit: z.enum(['kg', 't', 'lb']),
        })
        .strict(),
    ]),
    /** Where a payload's mass comes from a second source, that source. */
    payloadSource: z
      .object({ sourceText: text, sourceName: text, sourceUrl: z.url() })
      .strict()
      .optional(),
    /** Whether the figure includes fuel carried outside the aircraft's own tanks. */
    externalFuel: z.union([z.literal(UNKNOWN), z.boolean()]),
    fuel: stated,
    speedAltitude: stated,
    note: text.optional(),
  })
  .strict();

const conditionsFile = z.object({ revisedAt: z.iso.date(), entries: z.array(entry) }).strict();

/** The conditions of one range figure, as stored with the reference record. */
export interface RangeConditions {
  /** Payload in kilograms; "unknown" when the source does not state one. */
  readonly payloadKg: number | 'unknown' | 'not_recorded';
  readonly externalFuel: boolean | 'unknown';
  readonly fuel: string;
  readonly speedAltitude: string;
  /** The source's wording; `null` when no source states any condition. */
  readonly sourceText: string | null;
  readonly sourceName: string | null;
  readonly sourceUrl: string | null;
  readonly note: string | null;
}

/** A range for which no source states any condition. */
export const UNKNOWN_CONDITIONS: RangeConditions = {
  payloadKg: UNKNOWN,
  externalFuel: UNKNOWN,
  fuel: UNKNOWN,
  speedAltitude: UNKNOWN,
  sourceText: null,
  sourceName: null,
  sourceUrl: null,
  note: null,
};

/** The date the curated file was last revised, used as its retrieval time. */
export function rangeConditionsRevisedAt(raw: string): string {
  return conditionsFile.parse(JSON.parse(raw)).revisedAt;
}

/** The variant a section heading names: "Specifications (C-17A)" gives "C-17A". */
export function variantFromHeading(heading: string | null): string | null {
  if (!heading) return null;
  const open = heading.indexOf('(');
  const close = heading.lastIndexOf(')');
  if (open >= 0 && close > open) return heading.slice(open + 1, close).trim() || null;
  const trimmed = heading.trim();
  return /^specifications?$/i.test(trimmed) ? null : trimmed;
}

/**
 * Attaches conditions to every range and ferry-range record of a dataset. Records with no curated
 * entry are marked unknown. Returns the dataset with any problems in the curated file added to
 * its issues.
 */
export function applyRangeConditions(
  dataset: NormalisedDataset<AircraftAttributeRecord>,
  rawConditions: string | null,
  source: 'wikipedia' | 'aegis-curated',
): NormalisedDataset<AircraftAttributeRecord> {
  const log = new IssueLog();
  const bySubject = new Map<string, RangeConditions>();
  if (rawConditions !== null) {
    const file = conditionsFile.parse(JSON.parse(rawConditions));
    for (const item of file.entries) {
      if (item.source !== source) continue;
      const subject = `${item.type}/${item.key}`;
      if (bySubject.has(subject)) {
        log.error('duplicate_range_conditions', subject, 'More than one entry for this range');
        continue;
      }
      const payloadKg =
        typeof item.payload === 'string'
          ? item.payload
          : Math.round(item.payload.sourceValue * MASS_UNITS[item.payload.sourceUnit]);
      bySubject.set(subject, {
        payloadKg,
        externalFuel: item.externalFuel,
        fuel: item.fuel,
        speedAltitude: item.speedAltitude,
        sourceText: item.payloadSource
          ? `${item.sourceText}; ${item.payloadSource.sourceName}: ${item.payloadSource.sourceText}`
          : item.sourceText,
        sourceName: item.sourceName,
        sourceUrl: item.sourceUrl,
        note: item.note ?? null,
      });
    }
  }

  const used = new Set<string>();
  const rows = dataset.rows.map((row) => {
    if (!(RANGE_KEYS as readonly string[]).includes(row.key)) return row;
    const found = bySubject.get(row.sourceKey);
    if (found) used.add(row.sourceKey);
    return { ...row, conditions: JSON.stringify(found ?? UNKNOWN_CONDITIONS) };
  });
  for (const subject of bySubject.keys()) {
    if (!used.has(subject)) {
      log.warning(
        'range_conditions_unused',
        subject,
        'Conditions are recorded for a range this source does not give',
      );
    }
  }
  const issues: Issue[] = [...dataset.issues, ...log.issues];
  return { ...dataset, rows, issues };
}

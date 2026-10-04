import { schema } from '@aegis/db';
import { z } from 'zod';
import {
  IssueLog,
  sourceId,
  type AircraftAttributeRecord,
  type AircraftTypeRecord,
  type NormalisedDataset,
  type RawInput,
} from '../model';

/** Coarse role vocabulary. Deliberately abstract; see ADR 0011. */
export const ROLE_TAGS = [
  'air_defence',
  'multirole',
  'strategic_airlift',
  'tactical_airlift',
  'air_refuelling',
  'airborne_early_warning',
  'isr',
  'maritime_patrol',
  'training',
  'heavy_lift',
  'medium_lift',
  'battlefield_helicopter',
  'maritime_helicopter',
  'remotely_piloted',
  'vip_transport',
  'passenger',
  'cargo',
] as const;

const slug = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be lower-case words joined by hyphens');

/*
 * `.strict()` is a safety boundary, not a style choice: a curated entry carrying any field that is
 * not listed here (weapons, sensors, payload, ...) is rejected outright.
 */
const curatedType = z
  .object({
    slug,
    name: z.string().trim().min(1),
    manufacturer: z.string().trim().min(1),
    category: z.enum(schema.AIRCRAFT_CATEGORIES),
    engineType: z.enum(schema.ENGINE_TYPES),
    engineCount: z.int().min(1).max(8),
    ukServiceName: z.string().trim().min(1).optional(),
    roles: z.array(z.enum(ROLE_TAGS)).min(1),
    /** Title of the English Wikipedia article used as the public reference for this type. */
    wikipedia: z.string().trim().min(1),
    /**
     * The article's specification block describes a close variant. Its values are imported with
     * low confidence and this text attached.
     */
    specCaveat: z.string().trim().min(1).optional(),
    /**
     * The article's specification block describes a materially different variant. Its values are
     * not imported at all; the gap is reported with this reason.
     */
    specsNotApplicable: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((type) => !(type.specCaveat && type.specsNotApplicable), {
    message: 'specCaveat and specsNotApplicable are mutually exclusive',
  });

const curatedFile = z
  .object({
    revisedAt: z.iso.date(),
    types: z.array(z.unknown()),
  })
  .strict();

export type CuratedAircraftType = z.infer<typeof curatedType>;

export function wikipediaUrl(title: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
}

/** Parses the curated type list, returning valid entries and reporting the rest. */
export function readCuratedTypes(text: string): {
  revisedAt: string;
  types: CuratedAircraftType[];
  issues: IssueLog;
  total: number;
} {
  const file = curatedFile.parse(JSON.parse(text));
  const issues = new IssueLog();
  const types: CuratedAircraftType[] = [];
  file.types.forEach((candidate, index) => {
    const result = curatedType.safeParse(candidate);
    if (result.success) {
      types.push(result.data);
    } else {
      const key =
        typeof candidate === 'object' && candidate !== null && 'slug' in candidate
          ? String(candidate.slug)
          : null;
      issues.error(
        'invalid_aircraft_type',
        key,
        `Entry ${index}: ${z.prettifyError(result.error)}`,
      );
    }
  });
  return { revisedAt: file.revisedAt, types, issues, total: file.types.length };
}

export function normaliseAircraftTypes(raw: RawInput): NormalisedDataset<AircraftTypeRecord> {
  const { types, issues, total } = readCuratedTypes(raw.text);
  const rows: AircraftTypeRecord[] = types.map((type) => ({
    sourceKey: type.slug,
    // Identity facts are well established but were entered by hand.
    confidence: 'high',
    verification: 'unverified',
    slug: type.slug,
    name: type.name,
    manufacturer: type.manufacturer,
    category: type.category,
    engineType: type.engineType,
    engineCount: type.engineCount,
    ukServiceName: type.ukServiceName ?? null,
    roles: JSON.stringify(type.roles),
    referenceUrl: wikipediaUrl(type.wikipedia),
  }));
  return {
    dataset: 'aircraft-types',
    sourceId: 'aegis-curated',
    raw: { url: raw.url, sha256: raw.sha256, retrievedAt: raw.retrievedAt },
    rowsRead: total,
    rowsSkipped: 0,
    rows,
    issues: issues.issues,
  };
}

const extractedFile = z
  .object({
    retrievedAt: z.iso.datetime(),
    types: z.record(
      slug,
      z
        .object({
          page: z.string().min(1),
          revisionId: z.int().positive(),
          revisionTimestamp: z.iso.datetime(),
          /** Section heading above the specification block, naming the variant it describes. */
          heading: z.string().nullable(),
          attributes: z.array(
            z
              .object({
                key: z.enum(schema.AIRCRAFT_ATTRIBUTE_KEYS),
                value: z.number().positive(),
                sourceText: z.string().min(1),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

export type ExtractedAttributesFile = z.infer<typeof extractedFile>;

/**
 * Characteristics extracted from Wikipedia by `npm run data:aircraft-specs`.
 *
 * @param curatedTypes The curated type list. An extract for a type that is not curated is rejected;
 * a curated type with no extract is reported as a gap.
 */
export function normaliseAircraftAttributes(
  raw: RawInput,
  curatedTypes: readonly CuratedAircraftType[],
): NormalisedDataset<AircraftAttributeRecord> {
  const file = extractedFile.parse(JSON.parse(raw.text));
  const log = new IssueLog();
  const bySlug = new Map(curatedTypes.map((type) => [type.slug, type]));
  const rows: AircraftAttributeRecord[] = [];
  let read = 0;

  for (const [typeSlug, extract] of Object.entries(file.types)) {
    read += extract.attributes.length;
    const type = bySlug.get(typeSlug);
    if (!type) {
      log.error('unknown_aircraft_type', typeSlug, 'Extract refers to a type that is not curated');
      continue;
    }
    if (type.specsNotApplicable) {
      log.error('specs_not_applicable', typeSlug, `Extract ignored: ${type.specsNotApplicable}`);
      continue;
    }
    const variant = extract.heading ? `Article section: "${extract.heading}".` : null;
    const note = [variant, type.specCaveat].filter(Boolean).join(' ') || null;
    for (const attribute of extract.attributes) {
      rows.push({
        sourceKey: `${typeSlug}/${attribute.key}`,
        // A tertiary source; lower still when the block is known to describe another variant.
        confidence: type.specCaveat ? 'low' : 'medium',
        verification: 'source_asserted',
        typeId: sourceId('aegis-curated', typeSlug),
        key: attribute.key,
        value: attribute.value,
        sourceText: attribute.sourceText,
        sourceUrl: `https://en.wikipedia.org/w/index.php?oldid=${extract.revisionId}`,
        note,
      });
    }
  }

  for (const type of curatedTypes) {
    const extract = file.types[type.slug];
    if (type.specsNotApplicable) {
      log.warning(
        'no_characteristics',
        type.slug,
        `No characteristics held for ${type.name}. ${type.specsNotApplicable}`,
      );
    } else if (!extract || extract.attributes.length === 0) {
      log.warning(
        'no_characteristics',
        type.slug,
        `No characteristics held for ${type.name}. Its article has no machine-readable specification block.`,
      );
    }
  }

  return {
    dataset: 'aircraft-attributes',
    sourceId: 'wikipedia',
    raw: { url: raw.url, sha256: raw.sha256, retrievedAt: raw.retrievedAt },
    rowsRead: read,
    rowsSkipped: 0,
    rows,
    issues: log.issues,
  };
}

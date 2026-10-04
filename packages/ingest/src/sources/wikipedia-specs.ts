import {
  KILOGRAMS_PER_POUND,
  METRES_PER_FOOT,
  METRES_PER_NAUTICAL_MILE,
  METRES_PER_STATUTE_MILE,
} from '@aegis/domain';
import type { schema } from '@aegis/db';

/*
 * Reads numeric facts out of the `{{Aircraft specs}}` template used by English Wikipedia aircraft
 * articles. Only the parameters listed below are read. Free-text parameters (armament, avionics,
 * capacity and so on) are never read: AEGIS holds no such data (ADR 0011).
 */

export interface ExtractedAttribute {
  readonly key: schema.AircraftAttributeKey;
  /** In the unit named by the key's suffix. */
  readonly value: number;
  /** The template parameters the value came from, verbatim, for example `span ft=35 | span in=8`. */
  readonly sourceText: string;
}

export interface ExtractedSpecs {
  /** The section heading above the template, for example `Specifications (CH-47F)`. */
  readonly heading: string | null;
  readonly attributes: ExtractedAttribute[];
}

type Unit = { readonly suffix: string; readonly toTarget: number };

const FEET: Unit = { suffix: 'ft', toTarget: METRES_PER_FOOT };
const LENGTH_UNITS: readonly Unit[] = [{ suffix: 'm', toTarget: 1 }, FEET];
const MASS_UNITS: readonly Unit[] = [
  { suffix: 'kg', toTarget: 1 },
  { suffix: 'lb', toTarget: KILOGRAMS_PER_POUND },
];
const SPEED_UNITS: readonly Unit[] = [
  { suffix: 'kmh', toTarget: 1 },
  { suffix: 'kts', toTarget: METRES_PER_NAUTICAL_MILE / 1000 },
  { suffix: 'mph', toTarget: METRES_PER_STATUTE_MILE / 1000 },
];
const DISTANCE_UNITS: readonly Unit[] = [
  { suffix: 'km', toTarget: 1 },
  { suffix: 'nmi', toTarget: METRES_PER_NAUTICAL_MILE / 1000 },
  { suffix: 'miles', toTarget: METRES_PER_STATUTE_MILE / 1000 },
];

interface Mapping {
  readonly key: schema.AircraftAttributeKey;
  readonly parameter: string;
  readonly units: readonly Unit[];
  readonly decimals: number;
  /** Lowest and highest value that could be genuine, in the target unit. */
  readonly plausible: readonly [number, number];
}

const MAPPINGS: readonly Mapping[] = [
  { key: 'length_m', parameter: 'length', units: LENGTH_UNITS, decimals: 2, plausible: [2, 100] },
  { key: 'wingspan_m', parameter: 'span', units: LENGTH_UNITS, decimals: 2, plausible: [2, 100] },
  {
    key: 'rotor_diameter_m',
    parameter: 'rot dia',
    units: LENGTH_UNITS,
    decimals: 2,
    plausible: [2, 50],
  },
  { key: 'height_m', parameter: 'height', units: LENGTH_UNITS, decimals: 2, plausible: [1, 30] },
  {
    key: 'empty_mass_kg',
    parameter: 'empty weight',
    units: MASS_UNITS,
    decimals: 0,
    plausible: [200, 400_000],
  },
  {
    key: 'max_takeoff_mass_kg',
    parameter: 'max takeoff weight',
    units: MASS_UNITS,
    decimals: 0,
    plausible: [300, 700_000],
  },
  {
    key: 'max_speed_kmh',
    parameter: 'max speed',
    units: SPEED_UNITS,
    decimals: 0,
    plausible: [100, 3600],
  },
  {
    key: 'cruise_speed_kmh',
    parameter: 'cruise speed',
    units: SPEED_UNITS,
    decimals: 0,
    plausible: [100, 3000],
  },
  {
    key: 'range_km',
    parameter: 'range',
    units: DISTANCE_UNITS,
    decimals: 0,
    plausible: [100, 20_000],
  },
  {
    key: 'ferry_range_km',
    parameter: 'ferry range',
    units: DISTANCE_UNITS,
    decimals: 0,
    plausible: [100, 25_000],
  },
  {
    key: 'service_ceiling_m',
    parameter: 'ceiling',
    units: LENGTH_UNITS,
    decimals: 0,
    plausible: [1000, 25_000],
  },
];

/** Returns the text between the braces of the first `{{Aircraft specs ...}}`, or `null`. */
function templateBody(wikitext: string): { body: string; start: number } | null {
  const open = /\{\{\s*aircraft specs\b/i.exec(wikitext);
  if (!open) return null;
  let depth = 0;
  for (let i = open.index; i < wikitext.length - 1; i++) {
    const pair = wikitext.slice(i, i + 2);
    if (pair === '{{') {
      depth++;
      i++;
    } else if (pair === '}}') {
      depth--;
      i++;
      if (depth === 0) {
        return { body: wikitext.slice(open.index + 2, i - 1), start: open.index };
      }
    }
  }
  return null;
}

/** Splits a template body into top-level `name=value` parameters. */
function parameters(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let current = '';
  const flush = () => {
    const equals = current.indexOf('=');
    if (equals > 0) {
      const name = current.slice(0, equals).trim().toLowerCase();
      if (!out.has(name)) out.set(name, current.slice(equals + 1).trim());
    }
    current = '';
  };
  for (let i = 0; i < body.length; i++) {
    const pair = body.slice(i, i + 2);
    if (pair === '{{' || pair === '[[') {
      depth++;
      current += pair;
      i++;
    } else if (pair === '}}' || pair === ']]') {
      depth--;
      current += pair;
      i++;
    } else if (body.charAt(i) === '|' && depth === 0) {
      flush();
    } else {
      current += body.charAt(i);
    }
  }
  flush();
  return out;
}

/** A parameter value counts only if it is a bare number, optionally followed by a comment or ref. */
function bareNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const cleaned = value
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[\s\S]*$/i, '')
    .trim();
  return /^\d{1,3}(,\d{3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(cleaned)
    ? Number(cleaned.replaceAll(',', ''))
    : null;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function sectionHeading(wikitext: string, before: number): string | null {
  const headings = [...wikitext.slice(0, before).matchAll(/^=+\s*(.+?)\s*=+\s*$/gm)];
  return headings.at(-1)?.[1] ?? null;
}

/**
 * Extracts the supported characteristics from an article's wikitext.
 * Returns `null` when the article has no `{{Aircraft specs}}` template.
 * A parameter that is absent, not a plain number or outside its plausible range is left out.
 */
export function extractAircraftSpecs(wikitext: string): ExtractedSpecs | null {
  const template = templateBody(wikitext);
  if (!template) return null;
  const params = parameters(template.body);

  const attributes: ExtractedAttribute[] = [];
  for (const mapping of MAPPINGS) {
    for (const unit of mapping.units) {
      const name = `${mapping.parameter} ${unit.suffix}`;
      const amount = bareNumber(params.get(name));
      if (amount === null) continue;

      let total = amount;
      let sourceText = `${name}=${params.get(name)?.split(/<|\n/)[0]?.trim() ?? ''}`;
      // Lengths in feet may carry a separate inches parameter.
      if (unit === FEET) {
        const inchesName = `${mapping.parameter} in`;
        const inches = bareNumber(params.get(inchesName));
        if (inches !== null) {
          total += inches / 12;
          sourceText += ` | ${inchesName}=${inches}`;
        }
      }

      const value = round(total * unit.toTarget, mapping.decimals);
      if (value >= mapping.plausible[0] && value <= mapping.plausible[1]) {
        attributes.push({ key: mapping.key, value, sourceText });
      }
      break;
    }
  }
  return { heading: sectionHeading(wikitext, template.start), attributes };
}

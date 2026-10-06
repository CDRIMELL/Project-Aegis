import { AERODROME_SIZES } from '@aegis/domain';
import {
  derivePerformance,
  type EngineType,
  type PerformanceResult,
  type RoutePoint,
  type TypeCharacteristics,
} from '@aegis/domain';
import type { AircraftOrder } from '@aegis/sim';

/*
 * The bridge from reference data to the simulation (ADR 0016).
 *
 * These functions read sourced records and produce what a command needs: an order for a simulated
 * aircraft, or a route point for a real aerodrome. This is the only place reference data flows
 * towards the simulation, and it flows as a copy: the simulation never reads `ref_*` itself.
 */

/** The parts of a reference type record this module uses. */
export interface TypeRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly manufacturer: string;
  readonly category: string;
  readonly engineType: string;
  readonly engineCount: number;
  readonly ukServiceName: string | null;
}

/** The parts of a reference characteristic record this module uses. */
export interface AttributeRow {
  readonly typeId: string;
  readonly key: string;
  readonly value: number;
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly sourceText: string;
  readonly confidence: 'high' | 'medium' | 'low';
  readonly verification: 'unverified' | 'source_asserted' | 'cross_checked';
  readonly note: string | null;
  /** The variant the source's figure is for, where it names one. */
  readonly variant?: string | null;
  /** JSON: the conditions the source states for a range figure. */
  readonly conditions?: string | null;
}

/** The conditions a source states for a range figure. "unknown" is what the source leaves out. */
export interface RangeConditions {
  readonly payloadKg: number | 'unknown' | 'not_recorded';
  readonly externalFuel: boolean | 'unknown';
  readonly fuel: string;
  readonly speedAltitude: string;
  readonly sourceText: string | null;
  readonly note: string | null;
}

/** Reads the stored conditions of a range record. `null` when the record holds none. */
export function parseConditions(text: string | null | undefined): RangeConditions | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<RangeConditions>;
    return {
      payloadKg:
        typeof parsed.payloadKg === 'number' || parsed.payloadKg === 'not_recorded'
          ? parsed.payloadKg
          : 'unknown',
      externalFuel: typeof parsed.externalFuel === 'boolean' ? parsed.externalFuel : 'unknown',
      fuel: typeof parsed.fuel === 'string' ? parsed.fuel : 'unknown',
      speedAltitude: typeof parsed.speedAltitude === 'string' ? parsed.speedAltitude : 'unknown',
      sourceText: typeof parsed.sourceText === 'string' ? parsed.sourceText : null,
      note: typeof parsed.note === 'string' ? parsed.note : null,
    };
  } catch {
    return null;
  }
}

/** The conditions of a range in words: what the source states, and plainly what it does not. */
export function describeConditions(conditions: RangeConditions | null): string {
  if (!conditions) return 'The source states no conditions for this figure.';
  const parts: string[] = [];
  if (typeof conditions.payloadKg === 'number') {
    parts.push(`payload ${Math.round(conditions.payloadKg).toLocaleString('en-GB')} kg`);
  } else {
    parts.push(
      conditions.payloadKg === 'not_recorded' ? 'loading stated but not held' : 'payload unknown',
    );
  }
  parts.push(
    conditions.externalFuel === 'unknown'
      ? 'external fuel unknown'
      : conditions.externalFuel
        ? 'with external fuel'
        : 'internal fuel only',
  );
  parts.push(conditions.fuel === 'unknown' ? 'fuel state unknown' : conditions.fuel);
  parts.push(
    conditions.speedAltitude === 'unknown'
      ? 'speed and altitude unknown'
      : conditions.speedAltitude,
  );
  return `Source conditions: ${parts.join('; ')}.`;
}

/** A sourced value chosen for use, with where it came from. */
export interface SourcedValue {
  readonly value: number;
  readonly confidence: AttributeRow['confidence'];
  readonly verification: AttributeRow['verification'];
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly sourceText: string;
  readonly note: string | null;
  readonly variant: string | null;
  readonly conditions: RangeConditions | null;
}

export interface CatalogueEntry {
  readonly type: TypeRow;
  /** The value used for each characteristic, where any source gives one. */
  readonly sourced: Readonly<Record<string, SourcedValue>>;
  readonly characteristics: TypeCharacteristics;
  readonly performance: PerformanceResult;
}

const CONFIDENCE_RANK = { high: 0, medium: 1, low: 2 } as const;

/**
 * Where two sources give the same characteristic, the more confident one is used; a tie goes to
 * the source whose id sorts first, so the choice never depends on row order. Both stay in the
 * reference tables.
 */
export function chooseSourced(attributes: readonly AttributeRow[]): Record<string, SourcedValue> {
  const chosen: Record<string, AttributeRow> = {};
  for (const attribute of attributes) {
    const current = chosen[attribute.key];
    const better =
      !current ||
      CONFIDENCE_RANK[attribute.confidence] < CONFIDENCE_RANK[current.confidence] ||
      (CONFIDENCE_RANK[attribute.confidence] === CONFIDENCE_RANK[current.confidence] &&
        attribute.sourceId < current.sourceId);
    if (better) chosen[attribute.key] = attribute;
  }
  return Object.fromEntries(
    Object.entries(chosen).map(([key, a]) => [
      key,
      {
        value: a.value,
        confidence: a.confidence,
        verification: a.verification,
        sourceId: a.sourceId,
        sourceUrl: a.sourceUrl,
        sourceText: a.sourceText,
        note: a.note,
        variant: a.variant ?? null,
        conditions: parseConditions(a.conditions),
      },
    ]),
  );
}

export function buildCatalogue(
  types: readonly TypeRow[],
  attributes: readonly AttributeRow[],
): CatalogueEntry[] {
  const byType = new Map<string, AttributeRow[]>();
  for (const attribute of attributes) {
    const list = byType.get(attribute.typeId) ?? [];
    list.push(attribute);
    byType.set(attribute.typeId, list);
  }
  return types.map((type) => {
    const sourced = chooseSourced(byType.get(type.id) ?? []);
    const value = (key: string) => sourced[key]?.value ?? null;
    const rangeConditions = sourced.range_km?.conditions ?? null;
    const ferryConditions = sourced.ferry_range_km?.conditions ?? null;
    const characteristics: TypeCharacteristics = {
      category: type.category,
      engineType: type.engineType as EngineType,
      emptyMassKg: value('empty_mass_kg'),
      maxTakeoffMassKg: value('max_takeoff_mass_kg'),
      cruiseSpeedKmh: value('cruise_speed_kmh'),
      maxSpeedKmh: value('max_speed_kmh'),
      rangeKm: value('range_km'),
      ferryRangeKm: value('ferry_range_km'),
      serviceCeilingM: value('service_ceiling_m'),
      fuelCapacityKg: value('fuel_capacity_kg'),
      fuelCapacityL: value('fuel_capacity_l'),
      rangePayloadKg:
        typeof rangeConditions?.payloadKg === 'number' ? rangeConditions.payloadKg : null,
      ferryExternalFuel:
        typeof ferryConditions?.externalFuel === 'boolean' ? ferryConditions.externalFuel : null,
      rangeConditionsText: rangeConditions?.sourceText ?? null,
      ferryConditionsText: ferryConditions?.sourceText ?? null,
    };
    return { type, sourced, characteristics, performance: derivePerformance(characteristics) };
  });
}

/** The parts of a reference location record needed to fly to it. */
export interface AerodromeRow {
  readonly id: string;
  /** The reference kind: `airport_large`, `airport_medium` or `airport_small`. */
  readonly kind?: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly elevationM: number | null;
  readonly icao: string | null;
  readonly iata: string | null;
  readonly ident?: string | null;
}

/**
 * A copy of a reference aerodrome for the simulation to fly between. An elevation the source does
 * not give is taken as sea level.
 */
export function aerodromePoint(row: AerodromeRow): RoutePoint {
  const code = row.icao ?? row.iata ?? row.ident ?? null;
  const size = AERODROME_SIZES.find((each) => row.kind === `airport_${each}`);
  return {
    kind: 'aerodrome',
    name: row.name,
    ...(code !== null && { code }),
    lat: row.lat,
    lon: row.lon,
    elevationM: row.elevationM ?? 0,
    refId: row.id,
    // The sourced size class, which is all the simulation knows of what the aerodrome can do.
    ...(size && { size }),
  };
}

/** What the simulation needs to create an instance of a reference type. */
export function orderFor(entry: CatalogueEntry, home: RoutePoint): AircraftOrder {
  return {
    typeId: entry.type.id,
    typeName: entry.type.name,
    category: entry.type.category,
    performance: entry.performance.available ? entry.performance.model : null,
    performanceMissing: entry.performance.available ? [] : entry.performance.missing,
    home,
  };
}

/**
 * The starter fleet (ADR 0011, ADR 0016): a few real types, with fictional identities, at civil
 * aerodromes chosen for the fictional operator. It does not reproduce any real basing.
 */
export const STARTER_FLEET: readonly { readonly slug: string; readonly homeIcao: string }[] = [
  { slug: 'typhoon', homeIcao: 'EGPK' },
  { slug: 'typhoon', homeIcao: 'EGPK' },
  { slug: 'a400m', homeIcao: 'EGHQ' },
  { slug: 'c-17', homeIcao: 'EGHQ' },
];

/**
 * Orders for the starter fleet. An entry whose type or aerodrome is not in the reference data is
 * left out and reported, never replaced with something else.
 */
export function starterOrders(
  catalogue: readonly CatalogueEntry[],
  aerodromes: readonly AerodromeRow[],
): { orders: AircraftOrder[]; missing: string[] } {
  const orders: AircraftOrder[] = [];
  const missing: string[] = [];
  for (const { slug, homeIcao } of STARTER_FLEET) {
    const entry = catalogue.find((candidate) => candidate.type.slug === slug);
    const home = aerodromes.find((candidate) => candidate.icao === homeIcao);
    if (!entry) missing.push(`aircraft type "${slug}"`);
    if (!home) missing.push(`aerodrome ${homeIcao}`);
    if (entry && home) orders.push(orderFor(entry, aerodromePoint(home)));
  }
  return { orders, missing: [...new Set(missing)] };
}

import type { RoutePoint } from '../flight/route';

/*
 * What an aerodrome can do for an aircraft on the ground (ADR 0028).
 *
 * The size class is reference data: OurAirports classes every aerodrome as large, medium or
 * small. Everything derived from it here is a simulation assumption about a class of aerodrome,
 * never a statement about a named one.
 */

export const AERODROME_SIZES = ['large', 'medium', 'small'] as const;
/** The sourced size class of an aerodrome. */
export type AerodromeSize = (typeof AERODROME_SIZES)[number];

/** The kinds of finite ground resource. Post-flight checks use neither. */
export const RESOURCE_KINDS = ['fuel', 'handling'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export interface AerodromeCapability {
  /** False for a place that is not an aerodrome: nothing can be serviced there. */
  readonly servicing: boolean;
  /** The class the figures were taken from; `null` when the point carries none. */
  readonly size: AerodromeSize | null;
  /** Aircraft that can be fuelled at once. */
  readonly fuelPoints: number;
  /** Multiplies the rate at which an aircraft takes fuel. */
  readonly fuelRateFactor: number;
  /** Aircraft that can have payload handled at once. */
  readonly handlingPoints: number;
  readonly payloadRateKgS: number;
}

/**
 * The simulation's assumptions, by size class. They are not reference data and are never
 * presented as such.
 */
export const AERODROME_CAPABILITY = {
  large: { fuelPoints: 2, fuelRateFactor: 1, handlingPoints: 2, payloadRateKgS: 50 },
  medium: { fuelPoints: 1, fuelRateFactor: 1, handlingPoints: 1, payloadRateKgS: 30 },
  small: { fuelPoints: 1, fuelRateFactor: 0.5, handlingPoints: 1, payloadRateKgS: 15 },
  statement:
    'What an aerodrome can do is assumed from its size class alone: a large aerodrome fuels two aircraft at once and handles payload for two, at 3,000 kg a minute; a medium one fuels one and handles one, at 1,800 kg a minute; a small one fuels one at half the rate and handles one, at 900 kg a minute. An aerodrome whose class is not recorded is treated as medium.',
} as const;

const NOTHING: AerodromeCapability = {
  servicing: false,
  size: null,
  fuelPoints: 0,
  fuelRateFactor: 0,
  handlingPoints: 0,
  payloadRateKgS: 0,
};

/** What can be done for an aircraft at a place. */
export function aerodromeCapability(point: RoutePoint | null): AerodromeCapability {
  if (!point || point.kind !== 'aerodrome') return NOTHING;
  const size = point.size ?? null;
  return { servicing: true, size, ...AERODROME_CAPABILITY[size ?? 'medium'] };
}

/**
 * A point given the size class the reference data holds for it, where it is an aerodrome that
 * lacks one and the class is known (ADR 0029). Anything else is returned as it is: a class is
 * never replaced, and never supplied where the reference data has none.
 */
export function classifiedPoint(
  point: RoutePoint,
  sizes: Readonly<Record<string, AerodromeSize>>,
): RoutePoint {
  if (point.kind !== 'aerodrome' || point.size !== undefined || point.refId === undefined) {
    return point;
  }
  const size = sizes[point.refId];
  return size === undefined ? point : { ...point, size };
}

/** How many aircraft a kind of resource serves at once at an aerodrome. */
export function resourcePoints(capability: AerodromeCapability, kind: ResourceKind): number {
  return kind === 'fuel' ? capability.fuelPoints : capability.handlingPoints;
}

/**
 * What makes two points the same aerodrome: the reference record, or failing that the position
 * to about a hundred metres.
 */
export function aerodromeKey(point: RoutePoint): string {
  return point.refId ?? `${point.lat.toFixed(3)},${point.lon.toFixed(3)}`;
}

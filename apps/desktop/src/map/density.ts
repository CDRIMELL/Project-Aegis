/*
 * Level-of-detail rules for reference locations.
 *
 * The map holds about 55,000 locations. Each is given the lowest zoom at which it appears, so the
 * world view shows a few hundred significant places and detail arrives as the user zooms in.
 * These numbers are presentation tuning, not facts about the places.
 */

export type LocationKind = 'airport_large' | 'airport_medium' | 'airport_small' | 'city';

export interface DensityInput {
  readonly kind: LocationKind;
  readonly population: number | null;
  readonly scheduledService: boolean | null;
}

/** Lowest zoom at which a location's marker is drawn. */
export function markerMinZoom({ kind, population, scheduledService }: DensityInput): number {
  switch (kind) {
    case 'airport_large':
      return 2.5;
    case 'airport_medium':
      return scheduledService ? 4.5 : 5.5;
    case 'airport_small':
      return scheduledService ? 6.5 : 8;
    case 'city': {
      const people = population ?? 0;
      if (people >= 5_000_000) return 2;
      if (people >= 1_000_000) return 3.5;
      if (people >= 250_000) return 5;
      if (people >= 50_000) return 6.5;
      return 8;
    }
  }
}

/** Lowest zoom at which a location's label is drawn. Always at or after its marker. */
export function labelMinZoom(input: DensityInput): number {
  switch (input.kind) {
    case 'airport_large':
      return 5;
    case 'airport_medium':
      return 7.5;
    case 'airport_small':
      return 10;
    case 'city':
      return markerMinZoom(input) + 0.5;
  }
}

/**
 * Drawing priority when labels compete for space: lower wins. Larger places beat smaller ones;
 * among cities, population decides.
 */
export function labelPriority({ kind, population }: DensityInput): number {
  switch (kind) {
    case 'airport_large':
      return 100;
    case 'airport_medium':
      return 300;
    case 'airport_small':
      return 500;
    case 'city':
      // 10 million people -> 0, 10,000 people -> 300.
      return Math.round(
        Math.min(Math.max(700 - 100 * Math.log10(Math.max(population ?? 1, 1)), 0), 600),
      );
  }
}

/** Runways are drawn from this zoom, where an aerodrome is more than a point. */
export const RUNWAY_MIN_ZOOM = 9;

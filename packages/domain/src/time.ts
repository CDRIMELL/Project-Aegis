declare const simInstantBrand: unique symbol;

/**
 * A point on the simulation timeline: whole milliseconds since the Unix epoch (UTC).
 *
 * Branded so a wall-clock timestamp cannot be passed where simulation time is expected.
 */
export type SimInstant = number & { readonly [simInstantBrand]: true };

export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;

export function simInstant(epochMs: number): SimInstant {
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
    throw new RangeError(`Simulation instant must be a non-negative safe integer, got ${epochMs}`);
  }
  return epochMs as SimInstant;
}

export function addMs(instant: SimInstant, deltaMs: number): SimInstant {
  return simInstant(instant + deltaMs);
}

/** ISO 8601 UTC rendering, e.g. `2026-10-04T12:30:05Z`. */
export function formatUtc(instant: SimInstant): string {
  return new Date(instant).toISOString().replace('.000Z', 'Z');
}

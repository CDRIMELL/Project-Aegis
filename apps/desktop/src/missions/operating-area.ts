import { greatCircleDistance, type RoutePoint } from '@aegis/domain';
import { aerodromePoint, type AerodromeRow } from '../fleet/catalogue';

/*
 * The operating area (ADR 0017): the public aerodromes copied into a world so that opportunity
 * generation never reads reference tables.
 *
 * Aerodromes are chosen by the size class OurAirports gives them and by distance, nothing else.
 * No military classification is read, inferred or stored.
 */

/** How many aerodromes an operating area holds. */
export const OPERATING_AREA_SIZE = 60;

/**
 * The `limit` candidates nearest to any of the fleet's home aerodromes, nearest first. Candidates
 * without an ICAO code are left out. Ties go to the lower reference id, so the result never
 * depends on the order the rows arrive in.
 */
export function chooseOperatingArea(
  candidates: readonly AerodromeRow[],
  homes: readonly RoutePoint[],
  limit = OPERATING_AREA_SIZE,
): RoutePoint[] {
  if (homes.length === 0) return [];
  return candidates
    .filter((row) => row.icao !== null && row.icao.length > 0)
    .map((row) => ({
      row,
      distanceM: Math.min(...homes.map((home) => greatCircleDistance(home, row))),
    }))
    .sort((a, b) => a.distanceM - b.distanceM || a.row.id.localeCompare(b.row.id))
    .slice(0, limit)
    .map(({ row }) => aerodromePoint(row));
}

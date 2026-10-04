import { dmath, greatCircleDistance, type LatLon, type RoutePoint } from '@aegis/domain';
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

/** The fleet has moved materially when its centre is this far from where the area was chosen. */
export const RECENTRE_DISTANCE_M = 250_000;

/**
 * The centre of the fleet's home aerodromes: the mean of their positions on the sphere, so it is
 * right across the antimeridian and near the poles. `null` for a fleet with no homes, or one
 * whose homes cancel out exactly.
 */
export function fleetCentre(homes: readonly LatLon[]): LatLon | null {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const home of homes) {
    const lat = (home.lat * dmath.PI) / 180;
    const lon = (home.lon * dmath.PI) / 180;
    x += dmath.cos(lat) * dmath.cos(lon);
    y += dmath.cos(lat) * dmath.sin(lon);
    z += dmath.sin(lat);
  }
  const length = Math.sqrt(x * x + y * y + z * z);
  if (homes.length === 0 || length < 1e-9) return null;
  // Rounded to a few metres: the centre is recorded in the log and need not be finer.
  const round = (degrees: number) => Math.round(degrees * 10_000) / 10_000;
  return {
    lat: round((dmath.asin(z / length) * 180) / dmath.PI),
    lon: round((dmath.atan2(y, x) * 180) / dmath.PI),
  };
}

/**
 * Whether the operating area should be chosen afresh (ADR 0022): it has no recorded centre, or
 * the fleet's centre has moved `RECENTRE_DISTANCE_M` or more from it.
 */
export function needsRecentre(centre: LatLon, areaCentre: LatLon | null): boolean {
  return areaCentre === null || greatCircleDistance(centre, areaCentre) >= RECENTRE_DISTANCE_M;
}

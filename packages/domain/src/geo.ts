import { degrees, metres, type Degrees, type Metres } from './units';

/*
 * Geodesy on a sphere.
 *
 * MODEL ASSUMPTION: the Earth is treated as a sphere of mean radius 6,371,008.8 m (IUGG). Against
 * the WGS 84 ellipsoid this is in error by up to about 0.5 % in distance. That is appropriate for
 * a simplified operations simulation and is not suitable for navigation.
 */

export const EARTH_MEAN_RADIUS_M = 6_371_008.8;

/** About 6 mm on the surface. Below this, two points are treated as coincident. */
const NEGLIGIBLE_ANGLE_RAD = 1e-9;

export interface LatLon {
  /** Degrees north, within [-90, 90]. */
  readonly lat: number;
  /** Degrees east, within [-180, 180]. */
  readonly lon: number;
}

const toRadians = (deg: number): number => (deg * Math.PI) / 180;
const toDegrees = (rad: number): number => (rad * 180) / Math.PI;

export function isValidLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  );
}

export function latLon(lat: number, lon: number): LatLon {
  if (!isValidLatLon(lat, lon)) {
    throw new RangeError(`Invalid coordinates: lat ${lat}, lon ${lon}`);
  }
  return { lat, lon };
}

/** Wraps any longitude into [-180, 180). */
export function normaliseLongitude(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * Angular distance between two points in radians.
 *
 * Uses the arctangent form of the great-circle formula, which stays accurate at every separation.
 * The simpler haversine form loses about a centimetre of precision near antipodal points.
 */
function centralAngle(from: LatLon, to: LatLon): number {
  const phi1 = toRadians(from.lat);
  const phi2 = toRadians(to.lat);
  const dLambda = toRadians(to.lon - from.lon);
  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinPhi2 = Math.sin(phi2);
  const cosPhi2 = Math.cos(phi2);
  const cosDLambda = Math.cos(dLambda);

  const y = Math.hypot(
    cosPhi2 * Math.sin(dLambda),
    cosPhi1 * sinPhi2 - sinPhi1 * cosPhi2 * cosDLambda,
  );
  const x = sinPhi1 * sinPhi2 + cosPhi1 * cosPhi2 * cosDLambda;
  return Math.atan2(y, x);
}

/** Great-circle distance along the surface. */
export function greatCircleDistance(from: LatLon, to: LatLon): Metres {
  return metres(centralAngle(from, to) * EARTH_MEAN_RADIUS_M);
}

/**
 * Initial true bearing when leaving `from` for `to` along the great circle, in [0, 360).
 * Undefined in the mathematical sense when the points coincide; returns 0 in that case.
 */
export function initialBearing(from: LatLon, to: LatLon): Degrees {
  const phi1 = toRadians(from.lat);
  const phi2 = toRadians(to.lat);
  const dLambda = toRadians(to.lon - from.lon);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return degrees((toDegrees(Math.atan2(y, x)) + 360) % 360);
}

/**
 * Point a given fraction of the way along the great circle from `from` to `to`.
 * `fraction` 0 is `from`, 1 is `to`. Antipodal pairs have no unique great circle and are rejected.
 */
export function intermediatePoint(from: LatLon, to: LatLon, fraction: number): LatLon {
  if (!(fraction >= 0 && fraction <= 1)) {
    throw new RangeError(`Fraction must be within [0, 1], got ${fraction}`);
  }
  const delta = centralAngle(from, to);
  if (delta < NEGLIGIBLE_ANGLE_RAD) {
    // Closer than a few millimetres: the spherical formula would divide by ~0, and a straight
    // interpolation is exact to well below any meaningful precision.
    return {
      lat: from.lat + (to.lat - from.lat) * fraction,
      lon: normaliseLongitude(from.lon + normaliseLongitude(to.lon - from.lon) * fraction),
    };
  }
  if (Math.PI - delta < NEGLIGIBLE_ANGLE_RAD) {
    throw new RangeError('Intermediate point is undefined for antipodal points');
  }
  const sinDelta = Math.sin(delta);
  const a = Math.sin((1 - fraction) * delta) / sinDelta;
  const b = Math.sin(fraction * delta) / sinDelta;
  const phi1 = toRadians(from.lat);
  const phi2 = toRadians(to.lat);
  const lambda1 = toRadians(from.lon);
  const lambda2 = toRadians(to.lon);

  const x = a * Math.cos(phi1) * Math.cos(lambda1) + b * Math.cos(phi2) * Math.cos(lambda2);
  const y = a * Math.cos(phi1) * Math.sin(lambda1) + b * Math.cos(phi2) * Math.sin(lambda2);
  const z = a * Math.sin(phi1) + b * Math.sin(phi2);

  return {
    lat: toDegrees(Math.atan2(z, Math.hypot(x, y))),
    lon: normaliseLongitude(toDegrees(Math.atan2(y, x))),
  };
}

/** Point reached by travelling `distance` from `from` on an initial true bearing. */
export function destinationPoint(from: LatLon, bearing: Degrees, distance: Metres): LatLon {
  const delta = distance / EARTH_MEAN_RADIUS_M;
  const theta = toRadians(bearing);
  const phi1 = toRadians(from.lat);
  const lambda1 = toRadians(from.lon);

  const sinPhi2 =
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta);
  const phi2 = Math.asin(Math.max(-1, Math.min(1, sinPhi2)));
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * sinPhi2,
    );

  return { lat: toDegrees(phi2), lon: normaliseLongitude(toDegrees(lambda2)) };
}

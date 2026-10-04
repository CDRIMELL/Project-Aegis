import { greatCircleDistance, initialBearing, intermediatePoint, isValidLatLon } from '../geo';

/** A place a route passes through. Aerodromes carry the reference id they were resolved from. */
export interface RoutePoint {
  readonly kind: 'aerodrome' | 'waypoint';
  readonly name: string;
  /** Short identifier of an aerodrome (ICAO, else IATA), for display. */
  readonly code?: string;
  readonly lat: number;
  readonly lon: number;
  /** Ground elevation. Only meaningful for aerodromes; 0 for free waypoints. */
  readonly elevationM: number;
  /** Reference location id for an aerodrome. A soft link: the coordinates above are what is flown. */
  readonly refId?: string;
}

export interface RouteLeg {
  readonly from: RoutePoint;
  readonly to: RoutePoint;
  readonly distanceM: number;
  /** Initial true bearing of the leg. */
  readonly bearingDeg: number;
  /** Distance from the route's start to the start of this leg. */
  readonly startM: number;
}

/** A route with its legs measured once. Derived from points; never persisted. */
export interface RouteGeometry {
  readonly points: readonly RoutePoint[];
  readonly legs: readonly RouteLeg[];
  readonly totalM: number;
}

export function routeGeometry(points: readonly RoutePoint[]): RouteGeometry {
  const legs: RouteLeg[] = [];
  let startM = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i] as RoutePoint;
    const to = points[i + 1] as RoutePoint;
    const distanceM = greatCircleDistance(from, to);
    legs.push({ from, to, distanceM, bearingDeg: initialBearing(from, to), startM });
    startM += distanceM;
  }
  return { points, legs, totalM: startM };
}

export interface RoutePosition {
  readonly lat: number;
  readonly lon: number;
  /** True heading along the route at this point. */
  readonly headingDeg: number;
  /** Index of the leg being flown. */
  readonly legIndex: number;
}

/** Where an aircraft is after flying `distanceM` along the route. Clamped to the route's ends. */
export function positionAlong(route: RouteGeometry, distanceM: number): RoutePosition {
  const first = route.legs[0];
  if (!first) {
    const only = route.points[0];
    return { lat: only?.lat ?? 0, lon: only?.lon ?? 0, headingDeg: 0, legIndex: 0 };
  }
  const clamped = Math.min(Math.max(distanceM, 0), route.totalM);
  let legIndex = route.legs.length - 1;
  for (let i = 0; i < route.legs.length; i++) {
    const leg = route.legs[i] as RouteLeg;
    if (clamped < leg.startM + leg.distanceM) {
      legIndex = i;
      break;
    }
  }
  const leg = route.legs[legIndex] as RouteLeg;
  const fraction = leg.distanceM === 0 ? 1 : Math.min((clamped - leg.startM) / leg.distanceM, 1);
  const point = intermediatePoint(leg.from, leg.to, fraction);
  // Heading changes along a great circle; near the leg's end, keep the leg's last direction.
  const headingDeg = fraction < 0.999 ? initialBearing(point, leg.to) : finalBearing(leg);
  return { lat: point.lat, lon: point.lon, headingDeg, legIndex };
}

/** Bearing on arrival at the end of a leg. */
function finalBearing(leg: RouteLeg): number {
  return (initialBearing(leg.to, leg.from) + 180) % 360;
}

/** Reasons a list of points cannot be flown as a route. Empty when it can. */
export function routeProblems(points: readonly RoutePoint[]): string[] {
  const problems: string[] = [];
  if (points.length < 2) {
    return ['A route needs an origin and a destination.'];
  }
  if (points[0]?.kind !== 'aerodrome' || points.at(-1)?.kind !== 'aerodrome') {
    problems.push('A route must start and end at an aerodrome.');
  }
  points.forEach((point, index) => {
    if (!isValidLatLon(point.lat, point.lon)) {
      problems.push(`Point ${index + 1} (${point.name}) is not a valid position.`);
    }
  });
  if (problems.length > 0) return problems;
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i] as RoutePoint;
    const to = points[i + 1] as RoutePoint;
    const distanceM = greatCircleDistance(from, to);
    if (distanceM < 1) {
      problems.push(`${from.name} and ${to.name} are at the same position.`);
    } else if (distanceM > 19_900_000) {
      problems.push(
        `${from.name} and ${to.name} are on opposite sides of the Earth; add a waypoint.`,
      );
    }
  }
  return problems;
}

/**
 * Evenly spaced waypoints along the direct great circle, so a long route can be seen and edited.
 * They lie on the direct path and do not change its length.
 */
export function directRoute(
  origin: RoutePoint,
  destination: RoutePoint,
  spacingM = 1_500_000,
): RoutePoint[] {
  const distanceM = greatCircleDistance(origin, destination);
  const count = distanceM > 19_900_000 ? 0 : Math.floor(distanceM / spacingM);
  const waypoints: RoutePoint[] = [];
  for (let i = 1; i <= count; i++) {
    const point = intermediatePoint(origin, destination, i / (count + 1));
    waypoints.push({
      kind: 'waypoint',
      name: `WP${i}`,
      lat: point.lat,
      lon: point.lon,
      elevationM: 0,
    });
  }
  return [origin, ...waypoints, destination];
}

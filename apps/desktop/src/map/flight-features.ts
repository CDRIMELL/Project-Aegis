import { intermediatePoint, positionAlong, routeGeometry, type RoutePoint } from '@aegis/domain';
import type { FlightView } from '@aegis/sim';
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';

/*
 * GeoJSON for the simulation and interaction tiers: aircraft, their routes, and the draft plan
 * being edited. Pure functions; the map controller only draws what these return.
 */

/** Number of intermediate vertices per 1,000 km when drawing a great-circle leg. */
const VERTICES_PER_1000_KM = 12;

/**
 * A great-circle leg as a polyline. Longitudes continue past ±180 instead of wrapping, so a leg
 * across the antimeridian draws as one line, not a streak across the whole map.
 */
export function legCoordinates(
  from: RoutePoint,
  to: RoutePoint,
  distanceM: number,
): [number, number][] {
  const segments = Math.max(1, Math.ceil((distanceM / 1_000_000) * VERTICES_PER_1000_KM));
  const out: [number, number][] = [];
  let previousLon = from.lon;
  for (let i = 0; i <= segments; i++) {
    const point = i === 0 ? from : i === segments ? to : intermediatePoint(from, to, i / segments);
    let lon = point.lon;
    while (lon - previousLon > 180) lon -= 360;
    while (lon - previousLon < -180) lon += 360;
    out.push([lon, point.lat]);
    previousLon = lon;
  }
  return out;
}

function routeCoordinates(points: readonly RoutePoint[]): [number, number][] {
  const route = routeGeometry(points);
  const out: [number, number][] = [];
  for (const leg of route.legs) {
    const coordinates = legCoordinates(leg.from, leg.to, leg.distanceM);
    // Keep longitudes continuous from one leg to the next.
    const offset =
      out.length > 0
        ? Math.round(((out.at(-1)?.[0] ?? 0) - (coordinates[0]?.[0] ?? 0)) / 360) * 360
        : 0;
    out.push(
      ...coordinates
        .slice(out.length > 0 ? 1 : 0)
        .map(([lon, lat]): [number, number] => [lon + offset, lat]),
    );
  }
  return out;
}

export interface AircraftSample {
  readonly aircraftId: string;
  readonly lat: number;
  readonly lon: number;
  readonly headingDeg: number;
}

export interface AircraftMarkerProperties {
  readonly id: string;
  readonly heading: number;
  readonly selected: boolean;
}

export function aircraftFeatures(
  samples: readonly AircraftSample[],
  selectedId: string | null,
): FeatureCollection<Point, AircraftMarkerProperties> {
  return {
    type: 'FeatureCollection',
    features: samples.map((sample) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [sample.lon, sample.lat] },
      properties: {
        id: sample.aircraftId,
        heading: sample.headingDeg,
        selected: sample.aircraftId === selectedId,
      },
    })),
  };
}

/** The planned route of each active flight, as one line per flight. */
export function activeRouteFeatures(
  flights: readonly FlightView[],
  selectedAircraftId: string | null,
): FeatureCollection<LineString, { id: string; selected: boolean }> {
  return {
    type: 'FeatureCollection',
    features: flights.map((flight) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: routeCoordinates(flight.points) },
      properties: { id: flight.aircraftId, selected: flight.aircraftId === selectedAircraftId },
    })),
  };
}

export type DraftPointRole = 'origin' | 'destination' | 'waypoint' | 'midpoint';

export interface DraftPointProperties {
  readonly role: DraftPointRole;
  /** Index into the plan's points; for a midpoint, the index of the point before it. */
  readonly index: number;
  readonly label: string;
}

/**
 * The draft plan as map features: the route line, a handle for every point, and a small handle at
 * the middle of every leg that adds a waypoint there.
 */
export function draftFeatures(points: readonly RoutePoint[]): {
  route: FeatureCollection<LineString>;
  handles: FeatureCollection<Point, DraftPointProperties>;
} {
  if (points.length < 2) {
    return {
      route: { type: 'FeatureCollection', features: [] },
      handles: { type: 'FeatureCollection', features: [] },
    };
  }
  const handles: Feature<Point, DraftPointProperties>[] = points.map((point, index) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
    properties: {
      role: index === 0 ? 'origin' : index === points.length - 1 ? 'destination' : 'waypoint',
      index,
      label: point.code ?? point.name,
    },
  }));
  for (let index = 0; index + 1 < points.length; index++) {
    const middle = intermediatePoint(
      points[index] as RoutePoint,
      points[index + 1] as RoutePoint,
      0.5,
    );
    handles.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [middle.lon, middle.lat] },
      properties: { role: 'midpoint', index, label: '' },
    });
  }
  return {
    route: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: routeCoordinates(points) },
        },
      ],
    },
    handles: { type: 'FeatureCollection', features: handles },
  };
}

/** A flight's position at two consecutive simulation updates, with when each was received. */
export interface SamplePair {
  readonly previous: FlightView;
  readonly latest: FlightView;
  readonly previousAtMs: number;
  readonly latestAtMs: number;
}

/**
 * Where to draw an aircraft at a moment between simulation updates.
 *
 * This is display smoothing only. The aircraft is drawn one update behind, moving along its own
 * route from the previous reported distance to the latest, so it never leaves the route, never
 * overshoots and never affects the simulation.
 */
export function interpolateAircraft(pair: SamplePair, nowMs: number): AircraftSample {
  const { previous, latest } = pair;
  const interval = pair.latestAtMs - pair.previousAtMs;
  const fraction =
    interval <= 0 ? 1 : Math.min(Math.max((nowMs - pair.latestAtMs) / interval, 0), 1);
  if (previous.id !== latest.id || fraction >= 1) {
    return {
      aircraftId: latest.aircraftId,
      lat: latest.lat,
      lon: latest.lon,
      headingDeg: latest.headingDeg,
    };
  }
  const distanceM = previous.distanceM + (latest.distanceM - previous.distanceM) * fraction;
  const position = positionAlong(routeGeometry(latest.points), distanceM);
  return {
    aircraftId: latest.aircraftId,
    lat: position.lat,
    lon: position.lon,
    headingDeg: position.headingDeg,
  };
}

import {
  intermediatePoint,
  positionAlong,
  remainingPoints,
  routeGeometry,
  type RoutePoint,
} from '@aegis/domain';
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

export function routeCoordinates(points: readonly RoutePoint[]): [number, number][] {
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

export interface RouteProperties {
  readonly id: string;
  readonly selected: boolean;
  /** True for the part already flown, which is drawn dimmer. */
  readonly flown: boolean;
}

/**
 * The route of each active flight as two lines: what it has flown, and what is still to come.
 * The route is the one the flight is on now, whatever it was launched with (ADR 0026).
 */
export function activeRouteFeatures(
  flights: readonly FlightView[],
  selectedAircraftId: string | null,
): FeatureCollection<LineString, RouteProperties> {
  const features: Feature<LineString, RouteProperties>[] = [];
  for (const flight of flights) {
    const here: RoutePoint = {
      kind: 'waypoint',
      name: 'Present position',
      lat: flight.lat,
      lon: flight.lon,
      elevationM: 0,
    };
    const ahead = remainingPoints(
      { points: flight.points, cruiseAltitudeM: 0, cruiseSpeedKmh: 1 },
      flight.distanceM,
    );
    const behind = flight.points.slice(0, flight.points.length - ahead.length);
    const base = { id: flight.aircraftId, selected: flight.aircraftId === selectedAircraftId };
    const line = (points: readonly RoutePoint[], flown: boolean) => {
      // A leg of no length (the aircraft exactly on a point) draws nothing.
      const distinct = points.filter(
        (point, index) =>
          index === 0 ||
          point.lat !== points[index - 1]?.lat ||
          point.lon !== points[index - 1]?.lon,
      );
      if (distinct.length < 2) return;
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: routeCoordinates(distinct) },
        properties: { ...base, flown },
      });
    };
    line([...behind, here], true);
    line([here, ...ahead], false);
  }
  return { type: 'FeatureCollection', features };
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

/** Degrees added round the fleet, so that an aircraft is never on the edge of the view. */
const FLEET_MARGIN_DEG = 1.5;

/**
 * The box round every aircraft, as west, south, east, north: where each is on the ground, and
 * where each is in the air. `null` when there are none. A commander taking command is shown
 * this, and not the whole world (ADR 0031).
 */
export function fleetBounds(fleet: {
  readonly aircraft: readonly { readonly location: { lat: number; lon: number } | null }[];
  readonly activeFlights: readonly { readonly lat: number; readonly lon: number }[];
}): [number, number, number, number] | null {
  const points = [
    ...fleet.aircraft.flatMap((aircraft) => (aircraft.location ? [aircraft.location] : [])),
    ...fleet.activeFlights,
  ];
  if (points.length === 0) return null;
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  return [
    Math.max(-180, Math.min(...lons) - FLEET_MARGIN_DEG),
    Math.max(-85, Math.min(...lats) - FLEET_MARGIN_DEG),
    Math.min(180, Math.max(...lons) + FLEET_MARGIN_DEG),
    Math.min(85, Math.max(...lats) + FLEET_MARGIN_DEG),
  ];
}

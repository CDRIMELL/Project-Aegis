import {
  conditionsAt,
  degrees,
  destinationPoint,
  isOpenEvent,
  metres,
  type WeatherModel,
  type WorldEvent,
} from '@aegis/domain';
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';

/*
 * GeoJSON for the simulated environment and world events (ADR 0021, ADR 0022).
 *
 * The weather is sampled on a coarse grid over the visible map, at a spacing that suits the zoom,
 * so the map carries a few hundred samples at most however far out the view is. This is display
 * only: the simulation samples the same field itself, where its aircraft are.
 */

/** West, south, east, north, in degrees. Longitudes may run past ±180 when the view wraps. */
export type Bounds = readonly [number, number, number, number];

/** The altitude the wind layer shows: a typical cruise level. */
export const WIND_LAYER_ALTITUDE_M = 9000;
/** The most grid points sampled for one view. */
const MAX_GRID_POINTS = 700;

/** Grid spacing in degrees for a zoom level: coarse when zoomed out, finer when zoomed in. */
export function gridSpacing(zoom: number): number {
  if (zoom < 2.5) return 10;
  if (zoom < 4) return 5;
  if (zoom < 5.5) return 2.5;
  if (zoom < 7) return 1;
  return 0.5;
}

/** Grid points covering the bounds, aligned to the spacing so they do not swim as the map moves. */
export function gridPoints(
  bounds: Bounds,
  zoom: number,
): { lat: number; lon: number; spacing: number }[] {
  const [west, south, east, north] = bounds;
  let spacing = gridSpacing(zoom);
  const count = (step: number) =>
    (Math.floor(east / step) - Math.ceil(west / step) + 1) *
    (Math.floor(Math.min(north, 85) / step) - Math.ceil(Math.max(south, -85) / step) + 1);
  // A very wide window at a fine zoom would be too many points; coarsen until it is not.
  while (count(spacing) > MAX_GRID_POINTS) spacing *= 2;
  const points: { lat: number; lon: number; spacing: number }[] = [];
  for (let i = Math.ceil(Math.max(south, -85) / spacing); i * spacing <= Math.min(north, 85); i++) {
    for (let j = Math.ceil(west / spacing); j * spacing <= east; j++) {
      points.push({ lat: i * spacing, lon: j * spacing, spacing });
    }
  }
  return points;
}

export interface WeatherLayers {
  readonly wind: boolean;
  readonly precipitation: boolean;
}

export interface WeatherFeatures {
  readonly precipitation: FeatureCollection<Polygon, { intensity: number }>;
  readonly wind: FeatureCollection<LineString, { speed: number }>;
}

const EMPTY = { type: 'FeatureCollection' as const, features: [] };

/** The weather over the visible map at one tick, for the layers that are switched on. */
export function weatherFeatures(
  weather: WeatherModel,
  tick: number,
  bounds: Bounds,
  zoom: number,
  layers: WeatherLayers,
): WeatherFeatures {
  if (!layers.wind && !layers.precipitation) return { precipitation: EMPTY, wind: EMPTY };
  const cells: Feature<Polygon, { intensity: number }>[] = [];
  const arrows: Feature<LineString, { speed: number }>[] = [];

  for (const { lat, lon, spacing } of gridPoints(bounds, zoom)) {
    if (layers.precipitation) {
      const { precipitation } = conditionsAt(weather, tick, { lat, lon }, 0);
      if (precipitation > 0.02) {
        const half = spacing / 2;
        const top = Math.min(lat + half, 89);
        const bottom = Math.max(lat - half, -89);
        cells.push({
          type: 'Feature',
          properties: { intensity: Math.round(precipitation * 100) / 100 },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [lon - half, bottom],
                [lon + half, bottom],
                [lon + half, top],
                [lon - half, top],
                [lon - half, bottom],
              ],
            ],
          },
        });
      }
    }
    if (layers.wind) {
      const aloft = conditionsAt(weather, tick, { lat, lon }, WIND_LAYER_ALTITUDE_M);
      if (aloft.windSpeedKmh >= 15) {
        // An arrow pointing the way the wind blows, longer for a stronger wind.
        const length = spacing * 0.42 * Math.min(aloft.windSpeedKmh / 200, 1);
        const east = (aloft.windEastKmh / aloft.windSpeedKmh) * length;
        const north = (aloft.windNorthKmh / aloft.windSpeedKmh) * length;
        // Degrees of longitude are narrower away from the equator.
        const widen = 1 / Math.max(Math.cos((lat * Math.PI) / 180), 0.2);
        const tail: [number, number] = [lon - east * widen, lat - north];
        const head: [number, number] = [lon + east * widen, lat + north];
        const barb = (sign: number): [number, number] => [
          head[0] - (east * 0.5 - sign * north * 0.3) * widen,
          head[1] - (north * 0.5 + sign * east * 0.3),
        ];
        arrows.push({
          type: 'Feature',
          properties: { speed: Math.round(aloft.windSpeedKmh) },
          geometry: { type: 'LineString', coordinates: [tail, head, barb(1), head, barb(-1)] },
        });
      }
    }
  }
  return {
    precipitation: { type: 'FeatureCollection', features: cells },
    wind: { type: 'FeatureCollection', features: arrows },
  };
}

export interface EventFeatureProperties {
  readonly eventId: string;
  readonly eventType: string;
  readonly active: boolean;
  readonly label: string;
}

export interface EventFeatures {
  readonly areas: FeatureCollection<Polygon, EventFeatureProperties>;
  readonly points: FeatureCollection<Point, EventFeatureProperties>;
}

const RING_VERTICES = 48;

function ring(centre: { lat: number; lon: number }, radiusM: number): [number, number][] {
  const out: [number, number][] = [];
  let previousLon = centre.lon;
  for (let i = 0; i <= RING_VERTICES; i++) {
    const at = destinationPoint(
      centre,
      degrees(((i % RING_VERTICES) * 360) / RING_VERTICES),
      metres(radiusM),
    );
    let lon = at.lon;
    while (lon - previousLon > 180) lon -= 360;
    while (lon - previousLon < -180) lon += 360;
    out.push([lon, at.lat]);
    previousLon = lon;
  }
  return out;
}

const SHORT_LABEL: Readonly<Record<string, string>> = {
  aerodrome_closure: 'CLOSED',
  navigation_disruption: 'NAV DISRUPTED',
  logistics_disruption: 'LOGISTICS',
  severe_weather: 'SEVERE WEATHER',
};

/** Events that are announced or under way and have somewhere to be drawn. */
export function eventFeatures(events: readonly WorldEvent[]): EventFeatures {
  const areas: Feature<Polygon, EventFeatureProperties>[] = [];
  const points: Feature<Point, EventFeatureProperties>[] = [];
  for (const event of events) {
    if (!isOpenEvent(event.status)) continue;
    const word = SHORT_LABEL[event.type];
    if (!word) continue;
    const properties: EventFeatureProperties = {
      eventId: event.id,
      eventType: event.type,
      active: event.status === 'active',
      label: `${word}${event.status === 'scheduled' ? ' (announced)' : ''} · ${event.id}`,
    };
    if (event.centre && event.radiusM !== null) {
      areas.push({
        type: 'Feature',
        properties,
        geometry: { type: 'Polygon', coordinates: [ring(event.centre, event.radiusM)] },
      });
      points.push({
        type: 'Feature',
        properties,
        geometry: { type: 'Point', coordinates: [event.centre.lon, event.centre.lat] },
      });
    } else if (event.place) {
      points.push({
        type: 'Feature',
        properties,
        geometry: { type: 'Point', coordinates: [event.place.lon, event.place.lat] },
      });
    }
  }
  return {
    areas: { type: 'FeatureCollection', features: areas },
    points: { type: 'FeatureCollection', features: points },
  };
}

/** A string that changes exactly when the drawn events would. */
export function eventFeaturesKey(events: readonly WorldEvent[]): string {
  return events
    .filter((event) => isOpenEvent(event.status))
    .map((event) => `${event.id}:${event.status}`)
    .join('|');
}

/** The box around an event: west, south, east, north. `null` when it has no place. */
export function eventBounds(event: WorldEvent): Bounds | null {
  if (event.centre && event.radiusM !== null) {
    const coordinates = ring(event.centre, event.radiusM * 1.3);
    const lons = coordinates.map(([lon]) => lon);
    const lats = coordinates.map(([, lat]) => lat);
    return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
  }
  if (event.place) {
    return [event.place.lon - 1.5, event.place.lat - 1, event.place.lon + 1.5, event.place.lat + 1];
  }
  return null;
}

import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import { labelMinZoom, labelPriority, markerMinZoom, type LocationKind } from './density';

/* Converts reference rows into the GeoJSON the map's reference tier draws. Pure functions. */

export interface MapLocationRow {
  readonly id: string;
  readonly kind: LocationKind;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly ident: string | null;
  readonly icao: string | null;
  readonly iata: string | null;
  readonly population: number | null;
  readonly scheduledService: boolean | null;
}

export interface LocationProperties {
  readonly id: string;
  readonly group: 'aerodrome' | 'city';
  readonly kind: LocationKind;
  readonly name: string;
  /** Short identifier for an aerodrome: ICAO, else IATA, else the source's own. Empty for cities. */
  readonly code: string;
  readonly minZoom: number;
  readonly labelMinZoom: number;
  readonly priority: number;
}

export type LocationFeature = Feature<Point, LocationProperties>;

export function locationFeatures(
  rows: readonly MapLocationRow[],
): FeatureCollection<Point, LocationProperties> {
  return {
    type: 'FeatureCollection',
    features: rows.map((row) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [row.lon, row.lat] },
      properties: {
        id: row.id,
        group: row.kind === 'city' ? 'city' : 'aerodrome',
        kind: row.kind,
        name: row.name,
        code: row.kind === 'city' ? '' : (row.icao ?? row.iata ?? row.ident ?? ''),
        minZoom: markerMinZoom(row),
        labelMinZoom: labelMinZoom(row),
        priority: labelPriority(row),
      },
    })),
  };
}

export interface MapRunwayRow {
  readonly id: string;
  readonly locationId: string;
  readonly lowEndIdent: string | null;
  readonly highEndIdent: string | null;
  readonly lowEndLat: number | null;
  readonly lowEndLon: number | null;
  readonly highEndLat: number | null;
  readonly highEndLon: number | null;
  readonly closed: boolean;
}

export interface RunwayProperties {
  readonly id: string;
  readonly locationId: string;
  /** For example `07/25`. */
  readonly name: string;
  readonly closed: boolean;
}

/** Runway designator pair, omitting an end the source does not name. */
export function runwayName(low: string | null, high: string | null): string {
  return [low, high].filter((end) => end !== null && end.length > 0).join('/');
}

/** Runways with both threshold positions become lines; the rest have no geometry to draw. */
export function runwayFeatures(
  rows: readonly MapRunwayRow[],
): FeatureCollection<LineString, RunwayProperties> {
  const features: Feature<LineString, RunwayProperties>[] = [];
  for (const row of rows) {
    if (
      row.lowEndLat === null ||
      row.lowEndLon === null ||
      row.highEndLat === null ||
      row.highEndLon === null
    ) {
      continue;
    }
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [row.lowEndLon, row.lowEndLat],
          [row.highEndLon, row.highEndLat],
        ],
      },
      properties: {
        id: row.id,
        locationId: row.locationId,
        name: runwayName(row.lowEndIdent, row.highEndIdent),
        closed: row.closed,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Lines of latitude and longitude every `stepDegrees`, as one feature per line. */
export function graticule(stepDegrees: number): FeatureCollection<LineString> {
  if (!(stepDegrees > 0) || 180 % stepDegrees !== 0) {
    throw new RangeError(`Graticule step must divide 180 evenly, got ${stepDegrees}`);
  }
  const features: Feature<LineString>[] = [];
  const line = (coordinates: [number, number][]): Feature<LineString> => ({
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates },
  });
  // Web Mercator cannot show the poles; stop the meridians where the projection does.
  const LAT_LIMIT = 85;
  for (let lon = -180; lon <= 180; lon += stepDegrees) {
    features.push(
      line([
        [lon, -LAT_LIMIT],
        [lon, LAT_LIMIT],
      ]),
    );
  }
  for (let lat = -90 + stepDegrees; lat < 90; lat += stepDegrees) {
    if (Math.abs(lat) > LAT_LIMIT) continue;
    features.push(
      line([
        [-180, lat],
        [180, lat],
      ]),
    );
  }
  return { type: 'FeatureCollection', features };
}

const SCALE_STEPS_M = [
  50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000,
  2_000_000, 5_000_000,
];

export interface ScaleBar {
  readonly widthPx: number;
  readonly label: string;
}

/** The longest round distance that fits in `maxWidthPx` at the given ground resolution. */
export function scaleBar(metresPerPixel: number, maxWidthPx = 120): ScaleBar {
  const maxMetres = metresPerPixel * maxWidthPx;
  const distance = [...SCALE_STEPS_M].reverse().find((step) => step <= maxMetres) ?? 50;
  return {
    widthPx: Math.round(distance / metresPerPixel),
    label: distance >= 1000 ? `${distance / 1000} km` : `${distance} m`,
  };
}

/** `51.7500° N  001.5836° W` */
export function formatCoordinates(lat: number, lon: number): string {
  const part = (value: number, positive: string, negative: string, width: number) =>
    `${Math.abs(value).toFixed(4).padStart(width, '0')}° ${value >= 0 ? positive : negative}`;
  return `${part(lat, 'N', 'S', 7)}  ${part(lon, 'E', 'W', 8)}`;
}

import { z } from 'zod';

/*
 * Offline basemap preparation (ADR 0008).
 *
 * Natural Earth GeoJSON is reduced to what the map draws: geometry at a stated coordinate
 * precision and a handful of properties. The basemap is presentation only. It is not reference
 * data: nothing here enters the `ref_*` tables, and the only link to them is a country's ISO code.
 */

type Position = [number, number];

const position = z.array(z.number()).min(2);
const geometry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Polygon'), coordinates: z.array(z.array(position)) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(z.array(position))) }),
  z.object({ type: z.literal('LineString'), coordinates: z.array(position) }),
  z.object({ type: z.literal('MultiLineString'), coordinates: z.array(z.array(position)) }),
]);
const collection = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(
    z.object({
      properties: z.record(z.string(), z.unknown()).nullable(),
      geometry: geometry.nullable(),
    }),
  ),
});

type Geometry = z.infer<typeof geometry>;

export interface BasemapFeature {
  readonly type: 'Feature';
  readonly properties: Readonly<Record<string, string | number | null>>;
  readonly geometry: { readonly type: string; readonly coordinates: unknown };
}

export interface BasemapCollection {
  readonly type: 'FeatureCollection';
  readonly features: BasemapFeature[];
}

/** Rounds a line and removes points that became identical to their predecessor. */
function simplifyLine(
  line: readonly number[][],
  decimals: number,
  minimumPoints: number,
): Position[] {
  const factor = 10 ** decimals;
  const out: Position[] = [];
  for (const point of line) {
    const x = Math.round((point[0] ?? 0) * factor) / factor;
    const y = Math.round((point[1] ?? 0) * factor) / factor;
    const previous = out.at(-1);
    if (!previous || previous[0] !== x || previous[1] !== y) {
      out.push([x, y]);
    }
  }
  return out.length >= minimumPoints ? out : [];
}

/** A ring needs four points to enclose an area; a line needs two. Degenerate parts are dropped. */
function simplifyGeometry(source: Geometry, decimals: number): BasemapFeature['geometry'] | null {
  const rings = (polygon: readonly number[][][]) =>
    polygon.map((ring) => simplifyLine(ring, decimals, 4)).filter((ring) => ring.length > 0);

  switch (source.type) {
    case 'Polygon': {
      const coordinates = rings(source.coordinates);
      return coordinates.length > 0 ? { type: 'Polygon', coordinates } : null;
    }
    case 'MultiPolygon': {
      const coordinates = source.coordinates.map(rings).filter((polygon) => polygon.length > 0);
      return coordinates.length > 0 ? { type: 'MultiPolygon', coordinates } : null;
    }
    case 'LineString': {
      const coordinates = simplifyLine(source.coordinates, decimals, 2);
      return coordinates.length > 0 ? { type: 'LineString', coordinates } : null;
    }
    case 'MultiLineString': {
      const coordinates = source.coordinates
        .map((line) => simplifyLine(line, decimals, 2))
        .filter((line) => line.length > 0);
      return coordinates.length > 0 ? { type: 'MultiLineString', coordinates } : null;
    }
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** ISO 3166-1 alpha-2, or `null` for territories Natural Earth gives a placeholder code. */
function isoCode(properties: Readonly<Record<string, unknown>>): string | null {
  const code = text(properties.ISO_A2_EH) ?? text(properties.ISO_A2);
  return code && /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Country polygons with name and ISO code. */
export function prepareCountries(geojson: string, decimals: number): BasemapCollection {
  const features: BasemapFeature[] = [];
  for (const feature of collection.parse(JSON.parse(geojson)).features) {
    const shape = feature.geometry && simplifyGeometry(feature.geometry, decimals);
    if (!shape) continue;
    const properties = feature.properties ?? {};
    features.push({
      type: 'Feature',
      properties: { iso2: isoCode(properties), name: text(properties.NAME) },
      geometry: shape,
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Geometry only: lakes and land boundary lines carry no properties the map uses. */
export function prepareShapes(geojson: string, decimals: number): BasemapCollection {
  const features: BasemapFeature[] = [];
  for (const feature of collection.parse(JSON.parse(geojson)).features) {
    const shape = feature.geometry && simplifyGeometry(feature.geometry, decimals);
    if (shape) features.push({ type: 'Feature', properties: {}, geometry: shape });
  }
  return { type: 'FeatureCollection', features };
}

function boundsOf(source: Geometry): [number, number, number, number] {
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  const visit = (value: unknown): void => {
    if (Array.isArray(value) && typeof value[0] === 'number' && typeof value[1] === 'number') {
      west = Math.min(west, value[0]);
      east = Math.max(east, value[0]);
      south = Math.min(south, value[1]);
      north = Math.max(north, value[1]);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    }
  };
  visit(source.coordinates);
  const round = (value: number) => Math.round(value * 100) / 100;
  return [round(west), round(south), round(east), round(north)];
}

/**
 * One label point per country, at the position Natural Earth recommends, with the country's
 * bounding box so the map can frame it. `labelRank` is Natural Earth's own prominence ranking
 * (lower is more prominent) and drives which names appear at which zoom.
 */
export function prepareCountryLabels(geojson: string): BasemapCollection {
  const features: BasemapFeature[] = [];
  for (const feature of collection.parse(JSON.parse(geojson)).features) {
    const properties = feature.properties ?? {};
    const name = text(properties.NAME);
    const x = properties.LABEL_X;
    const y = properties.LABEL_Y;
    if (!feature.geometry || !name || typeof x !== 'number' || typeof y !== 'number') continue;
    const [west, south, east, north] = boundsOf(feature.geometry);
    features.push({
      type: 'Feature',
      properties: {
        iso2: isoCode(properties),
        name,
        labelRank: typeof properties.LABELRANK === 'number' ? properties.LABELRANK : 6,
        west,
        south,
        east,
        north,
      },
      geometry: { type: 'Point', coordinates: [x, y] },
    });
  }
  features.sort((a, b) => String(a.properties.name).localeCompare(String(b.properties.name)));
  return { type: 'FeatureCollection', features };
}

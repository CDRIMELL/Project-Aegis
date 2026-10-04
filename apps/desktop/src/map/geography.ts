/*
 * Continents, as the widest level of the location hierarchy:
 * world > continent > country > region or city > aerodrome > runway.
 *
 * Codes are the ones the country reference data uses. The boxes are framing hints for the camera,
 * chosen by eye; they are presentation, not reference data.
 */

export interface Continent {
  readonly name: string;
  /** West, south, east, north. */
  readonly frame: readonly [number, number, number, number];
}

export const CONTINENTS: Readonly<Record<string, Continent>> = {
  AF: { name: 'Africa', frame: [-20, -36, 53, 38] },
  AN: { name: 'Antarctica', frame: [-180, -85, 180, -60] },
  AS: { name: 'Asia', frame: [26, -11, 150, 78] },
  EU: { name: 'Europe', frame: [-25, 34, 45, 72] },
  NA: { name: 'North America', frame: [-168, 7, -52, 73] },
  OC: { name: 'Oceania', frame: [110, -48, 180, 0] },
  SA: { name: 'South America', frame: [-82, -56, -34, 13] },
};

export function continentName(code: string): string {
  return CONTINENTS[code]?.name ?? code;
}

export interface CountryFrame {
  readonly lat: number;
  readonly lon: number;
  /** West, south, east, north; `null` when the country spans the antimeridian. */
  readonly bounds: readonly [number, number, number, number] | null;
}

interface LabelFeature {
  readonly properties: {
    readonly iso2: string | null;
    readonly west: number;
    readonly south: number;
    readonly east: number;
    readonly north: number;
  };
  readonly geometry: { readonly coordinates: readonly [number, number] };
}

/**
 * Indexes the basemap's country label points by ISO code, for framing a country.
 * A box wider than half the globe means the country crosses the antimeridian (Russia, Fiji, the
 * United States); it cannot be framed as a simple box, so only its label point is kept.
 */
export function countryFrames(labels: {
  readonly features: readonly LabelFeature[];
}): Map<string, CountryFrame> {
  const frames = new Map<string, CountryFrame>();
  for (const { properties, geometry } of labels.features) {
    if (!properties.iso2) continue;
    const { west, south, east, north } = properties;
    frames.set(properties.iso2, {
      lon: geometry.coordinates[0],
      lat: geometry.coordinates[1],
      bounds: east - west > 180 ? null : [west, south, east, north],
    });
  }
  return frames;
}

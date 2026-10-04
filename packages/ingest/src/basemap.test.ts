import { describe, expect, it } from 'vitest';
import { prepareCountries, prepareCountryLabels, prepareShapes } from './basemap';

const square = (west: number, south: number, size: number) => [
  [west, south],
  [west + size, south],
  [west + size, south + size],
  [west, south + size],
  [west, south],
];

const COUNTRIES = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        NAME: 'France',
        ISO_A2: '-99',
        ISO_A2_EH: 'FR',
        LABEL_X: 2.5,
        LABEL_Y: 46.2,
        LABELRANK: 2,
        POP_EST: 67000000,
        SOVEREIGNT: 'France',
      },
      geometry: {
        type: 'MultiPolygon',
        coordinates: [[square(-1.123456, 43.987654, 5)], [square(9.00001, 42.00001, 0.00002)]],
      },
    },
    {
      type: 'Feature',
      properties: {
        NAME: 'Somaliland',
        ISO_A2: '-99',
        ISO_A2_EH: '-99',
        LABEL_X: 46,
        LABEL_Y: 9.7,
      },
      geometry: { type: 'Polygon', coordinates: [square(43, 8, 4)] },
    },
    { type: 'Feature', properties: { NAME: 'No Shape' }, geometry: null },
  ],
});

describe('prepareCountries', () => {
  const result = prepareCountries(COUNTRIES, 2);

  it('keeps only the properties the map uses', () => {
    expect(result.features.map((feature) => feature.properties)).toEqual([
      { iso2: 'FR', name: 'France' },
      { iso2: null, name: 'Somaliland' },
    ]);
  });

  it('prefers the corrected ISO code and nulls placeholder codes', () => {
    expect(result.features[0]?.properties.iso2).toBe('FR');
    expect(result.features[1]?.properties.iso2).toBeNull();
  });

  it('rounds coordinates and drops parts that collapse at that precision', () => {
    const france = result.features[0]?.geometry;
    expect(france).toEqual({
      type: 'MultiPolygon',
      coordinates: [
        [
          [
            [-1.12, 43.99],
            [3.88, 43.99],
            [3.88, 48.99],
            [-1.12, 48.99],
            [-1.12, 43.99],
          ],
        ],
      ],
    });
  });

  it('skips features without geometry', () => {
    expect(result.features).toHaveLength(2);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(prepareCountries(COUNTRIES, 2))).toBe(JSON.stringify(result));
  });
});

describe('prepareShapes', () => {
  it('keeps geometry and no properties', () => {
    const lines = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { NAME: 'ignored', scalerank: 1 },
          geometry: {
            type: 'LineString',
            coordinates: [
              [0.0004, 0.0004],
              [0.0003, 0.0002],
              [1.5, 1.5],
            ],
          },
        },
        {
          type: 'Feature',
          properties: null,
          geometry: {
            type: 'LineString',
            coordinates: [
              [5, 5],
              [5.0001, 5.0001],
            ],
          },
        },
      ],
    });
    expect(prepareShapes(lines, 3).features).toEqual([
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [0, 0],
            [1.5, 1.5],
          ],
        },
      },
    ]);
  });
});

describe('prepareCountryLabels', () => {
  const result = prepareCountryLabels(COUNTRIES);

  it('places one label per named country with its bounding box and rank', () => {
    expect(result.features).toEqual([
      {
        type: 'Feature',
        properties: {
          iso2: 'FR',
          name: 'France',
          labelRank: 2,
          west: -1.12,
          south: 42,
          east: 9,
          north: 48.99,
        },
        geometry: { type: 'Point', coordinates: [2.5, 46.2] },
      },
      {
        type: 'Feature',
        properties: {
          iso2: null,
          name: 'Somaliland',
          labelRank: 6,
          west: 43,
          south: 8,
          east: 47,
          north: 12,
        },
        geometry: { type: 'Point', coordinates: [46, 9.7] },
      },
    ]);
  });
});

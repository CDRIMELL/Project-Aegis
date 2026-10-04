import { describe, expect, it } from 'vitest';
import { labelMinZoom, labelPriority, markerMinZoom, type DensityInput } from './density';
import {
  formatCoordinates,
  graticule,
  locationFeatures,
  runwayFeatures,
  runwayName,
  scaleBar,
  type MapLocationRow,
  type MapRunwayRow,
} from './features';
import {
  COUNTRY_HIT_LAYERS,
  HIT_LAYERS,
  LAYER_GROUPS,
  TIER_END_SLOT,
  buildMapStyle,
  highDetailBasemap,
  tierOfLayer,
  type MapPalette,
} from './style';

const PALETTE: MapPalette = {
  water: '#010101',
  land: '#020202',
  coast: '#030303',
  border: '#040404',
  graticule: '#050505',
  label: '#060606',
  labelHalo: '#070707',
  place: '#080808',
  reference: '#090909',
  referenceDim: '#0a0a0a',
  simulated: '#0b0b0b',
  selection: '#0c0c0c',
};
const FONTS = {
  sans: [{ url: '/fonts/sans.woff2', unicodeRange: ['U+0000-00FF'] }],
  mono: [{ url: '/fonts/mono.woff2', unicodeRange: ['U+0000-00FF'] }],
};
const style = buildMapStyle(PALETTE, FONTS, '/basemap');
const layerIds = style.layers.map((layer) => layer.id);

const location = (overrides: Partial<MapLocationRow>): MapLocationRow => ({
  id: 'ourairports:1',
  kind: 'airport_large',
  name: 'Example',
  lat: 51.5,
  lon: -1.25,
  ident: 'EGXX',
  icao: 'EGXX',
  iata: 'EXX',
  population: null,
  scheduledService: true,
  ...overrides,
});

describe('density rules', () => {
  const city = (population: number | null): DensityInput => ({
    kind: 'city',
    population,
    scheduledService: null,
  });
  const airport = (kind: DensityInput['kind'], scheduledService = false): DensityInput => ({
    kind,
    population: null,
    scheduledService,
  });

  it('shows larger aerodromes before smaller ones', () => {
    const large = markerMinZoom(airport('airport_large'));
    const medium = markerMinZoom(airport('airport_medium'));
    const small = markerMinZoom(airport('airport_small'));
    expect(large).toBeLessThan(medium);
    expect(medium).toBeLessThan(small);
  });

  it('shows aerodromes with scheduled service earlier than those without', () => {
    expect(markerMinZoom(airport('airport_medium', true))).toBeLessThan(
      markerMinZoom(airport('airport_medium', false)),
    );
    expect(markerMinZoom(airport('airport_small', true))).toBeLessThan(
      markerMinZoom(airport('airport_small', false)),
    );
  });

  it('shows cities in order of population, treating unknown as smallest', () => {
    const zooms = [9_000_000, 2_000_000, 400_000, 60_000, 5_000, null].map((population) =>
      markerMinZoom(city(population)),
    );
    expect(zooms).toEqual([2, 3.5, 5, 6.5, 8, 8]);
  });

  it('keeps small aerodromes out of the world and continental views', () => {
    expect(markerMinZoom(airport('airport_small', true))).toBeGreaterThanOrEqual(6);
  });

  it('never labels a place before its marker is visible', () => {
    const cases: DensityInput[] = [
      airport('airport_large'),
      airport('airport_medium'),
      airport('airport_medium', true),
      airport('airport_small'),
      airport('airport_small', true),
      city(9_000_000),
      city(100),
      city(null),
    ];
    for (const input of cases) {
      expect(labelMinZoom(input)).toBeGreaterThanOrEqual(markerMinZoom(input));
    }
  });

  it('gives label priority to bigger places', () => {
    expect(labelPriority(city(10_000_000))).toBeLessThan(labelPriority(city(100_000)));
    expect(labelPriority(airport('airport_large'))).toBeLessThan(
      labelPriority(airport('airport_small')),
    );
    expect(labelPriority(city(null))).toBe(600);
  });
});

describe('locationFeatures', () => {
  it('builds a point feature carrying identity and level-of-detail properties', () => {
    const { features } = locationFeatures([location({})]);
    expect(features[0]).toEqual({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-1.25, 51.5] },
      properties: {
        id: 'ourairports:1',
        group: 'aerodrome',
        kind: 'airport_large',
        name: 'Example',
        code: 'EGXX',
        minZoom: 2.5,
        labelMinZoom: 5,
        priority: 100,
      },
    });
  });

  it('chooses the best available aerodrome code and none for cities', () => {
    const codes = locationFeatures([
      location({ icao: null }),
      location({ icao: null, iata: null }),
      location({ icao: null, iata: null, ident: null }),
      location({ kind: 'city', population: 1000 }),
    ]).features.map((feature) => feature.properties.code);
    expect(codes).toEqual(['EXX', 'EGXX', '', '']);
  });

  it('groups cities separately from aerodromes', () => {
    const [feature] = locationFeatures([
      location({ kind: 'city', population: 8_000_000 }),
    ]).features;
    expect(feature?.properties).toMatchObject({ group: 'city', minZoom: 2, labelMinZoom: 2.5 });
  });
});

describe('runwayFeatures', () => {
  const runway = (overrides: Partial<MapRunwayRow>): MapRunwayRow => ({
    id: 'ourairports:10',
    locationId: 'ourairports:1',
    lowEndIdent: '07',
    highEndIdent: '25',
    lowEndLat: 51.7,
    lowEndLon: -1.6,
    highEndLat: 51.8,
    highEndLon: -1.5,
    closed: false,
    ...overrides,
  });

  it('draws a line between the two thresholds', () => {
    expect(runwayFeatures([runway({})]).features).toEqual([
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-1.6, 51.7],
            [-1.5, 51.8],
          ],
        },
        properties: {
          id: 'ourairports:10',
          locationId: 'ourairports:1',
          name: '07/25',
          closed: false,
        },
      },
    ]);
  });

  it('draws nothing for a runway without both thresholds', () => {
    expect(
      runwayFeatures([runway({ highEndLat: null }), runway({ lowEndLon: null })]).features,
    ).toEqual([]);
  });

  it('names a runway from whichever ends are known', () => {
    expect(runwayName('09L', '27R')).toBe('09L/27R');
    expect(runwayName('H1', null)).toBe('H1');
    expect(runwayName(null, '')).toBe('');
  });
});

describe('graticule', () => {
  it('draws every meridian and every parallel inside the projection', () => {
    const { features } = graticule(30);
    // 13 meridians (-180..180) and 5 parallels (-60..60).
    expect(features).toHaveLength(18);
    expect(features[0]?.geometry.coordinates).toEqual([
      [-180, -85],
      [-180, 85],
    ]);
  });

  it('rejects a step that does not divide the globe evenly', () => {
    expect(() => graticule(7)).toThrow(RangeError);
    expect(() => graticule(0)).toThrow(RangeError);
  });
});

describe('scaleBar', () => {
  it('picks the longest round distance that fits', () => {
    expect(scaleBar(1000, 120)).toEqual({ widthPx: 100, label: '100 km' });
    expect(scaleBar(10, 120)).toEqual({ widthPx: 100, label: '1 km' });
    expect(scaleBar(1.5, 120)).toEqual({ widthPx: 67, label: '100 m' });
  });

  it('never exceeds the available width', () => {
    for (const resolution of [0.6, 3, 42, 777, 9_000, 40_000]) {
      expect(scaleBar(resolution, 120).widthPx).toBeLessThanOrEqual(120);
    }
  });
});

describe('formatCoordinates', () => {
  it('uses fixed-width hemisphere notation', () => {
    expect(formatCoordinates(51.75, -1.58362)).toBe('51.7500° N  001.5836° W');
    expect(formatCoordinates(-33.9461, 151.1772)).toBe('33.9461° S  151.1772° E');
    expect(formatCoordinates(0, 0)).toBe('00.0000° N  000.0000° E');
  });
});

describe('map style', () => {
  it('orders the tiers: basemap, reference, simulation, interaction', () => {
    const slots = [
      TIER_END_SLOT.basemap,
      TIER_END_SLOT.reference,
      TIER_END_SLOT.simulation,
      TIER_END_SLOT.interaction,
    ].map((id) => layerIds.indexOf(id));
    expect(slots.every((index) => index >= 0)).toBe(true);
    expect([...slots].sort((a, b) => a - b)).toEqual(slots);
  });

  it('keeps every layer inside the tier that owns its source', () => {
    const sourceTier: Record<string, string> = {
      'land-110m': 'basemap',
      'land-50m': 'basemap',
      'lakes-50m': 'basemap',
      'borders-50m': 'basemap',
      'country-labels': 'basemap',
      graticule: 'basemap',
      locations: 'reference',
      runways: 'reference',
      selection: 'interaction',
      'sim-routes': 'simulation',
      'sim-aircraft': 'simulation',
      'draft-route': 'interaction',
      'draft-handles': 'interaction',
    };
    for (const layer of style.layers) {
      // Selection outlines reuse the source of the thing they outline.
      const outline = layer.id.startsWith('selection-country') || layer.id === 'aircraft-selected';
      if (!('source' in layer) || outline) continue;
      expect(tierOfLayer(style, layer.id), layer.id).toBe(sourceTier[layer.source]);
    }
  });

  it('keeps simulated aircraft and routes in the simulation tier, in the simulated colour', () => {
    const simulationLayers = style.layers.filter(
      (layer) => tierOfLayer(style, layer.id) === 'simulation' && !layer.id.startsWith('slot:'),
    );
    expect(simulationLayers.map((layer) => layer.id)).toEqual(['flight-route', 'aircraft-marker']);
    for (const layer of simulationLayers) {
      expect('source' in layer && layer.source.startsWith('sim-')).toBe(true);
      const text = JSON.stringify(layer);
      expect(text).toContain(PALETTE.simulated);
      expect(text).not.toContain(PALETTE.reference);
    }
  });

  it('draws the draft flight plan in the interaction tier, above every aircraft', () => {
    const order = (id: string) => layerIds.indexOf(id);
    for (const id of ['draft-route-line', 'draft-midpoint', 'draft-waypoint', 'draft-endpoint']) {
      expect(tierOfLayer(style, id), id).toBe('interaction');
      expect(order(id)).toBeGreaterThan(order('aircraft-marker'));
    }
    // Waypoints are drawn over midpoints so a waypoint is what gets picked where they overlap.
    expect(order('draft-waypoint')).toBeGreaterThan(order('draft-midpoint'));
  });

  it('starts with every data source empty', () => {
    for (const source of [
      'locations',
      'runways',
      'selection',
      'sim-routes',
      'sim-aircraft',
      'draft-route',
      'draft-handles',
    ]) {
      expect(style.sources[source]).toMatchObject({
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
    }
  });

  it('draws reference data above all geography', () => {
    const lastBasemap = layerIds.indexOf(TIER_END_SLOT.basemap);
    for (const id of ['aerodrome-marker', 'city-marker', 'runway-line', 'aerodrome-label']) {
      expect(layerIds.indexOf(id)).toBeGreaterThan(lastBasemap);
    }
  });

  it('gates markers and labels on the per-feature zoom thresholds', () => {
    const layer = (id: string) => style.layers.find((candidate) => candidate.id === id);
    expect(JSON.stringify(layer('aerodrome-marker'))).toContain(
      '["<=",["get","minZoom"],["zoom"]]',
    );
    expect(JSON.stringify(layer('city-label'))).toContain('["<=",["get","labelMinZoom"],["zoom"]]');
    expect(layer('runway-line')).toMatchObject({ minzoom: 9 });
  });

  it('only refers to layers and sources that exist', () => {
    const known = new Set(layerIds);
    const detail = highDetailBasemap(PALETTE, '/basemap');
    const withDetail = new Set([...known, ...detail.layers.map((entry) => entry.layer.id)]);

    for (const ids of Object.values(LAYER_GROUPS)) {
      for (const id of ids) expect(withDetail.has(id), id).toBe(true);
    }
    for (const id of [...HIT_LAYERS, ...COUNTRY_HIT_LAYERS])
      expect(withDetail.has(id), id).toBe(true);
    for (const layer of style.layers) {
      if ('source' in layer) expect(Object.keys(style.sources)).toContain(layer.source);
    }
    for (const { layer, before } of detail.layers) {
      expect(known.has(before), `${layer.id} before ${before}`).toBe(true);
      if ('source' in layer) expect(Object.keys(detail.sources)).toContain(layer.source);
    }
  });

  it('inserts high-detail geography inside the basemap tier', () => {
    const detail = highDetailBasemap(PALETTE, '/basemap');
    for (const { layer, before } of detail.layers) {
      const expected = layer.id.startsWith('selection-country') ? 'interaction' : 'basemap';
      expect(tierOfLayer(style, before), layer.id).toBe(expected);
    }
  });

  it('takes every colour from the palette and loads fonts and data from local paths only', () => {
    const text = JSON.stringify(style) + JSON.stringify(highDetailBasemap(PALETTE, '/basemap'));
    const colours = text.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(colours.every((colour) => Object.values(PALETTE).includes(colour))).toBe(true);
    expect(text).not.toMatch(/https?:\/\//);
    expect(style.glyphs).toBeUndefined();
    expect(style.sprite).toBeUndefined();
    expect(style['font-faces']).toEqual({
      'AEGIS Sans': [{ url: '/fonts/sans.woff2', 'unicode-range': ['U+0000-00FF'] }],
      'AEGIS Mono': [{ url: '/fonts/mono.woff2', 'unicode-range': ['U+0000-00FF'] }],
    });
  });

  it('uses the reference colour for reference data and reserves the simulated colour', () => {
    const referenceLayers = style.layers.filter(
      (layer) => tierOfLayer(style, layer.id) === 'reference',
    );
    const text = JSON.stringify(referenceLayers);
    expect(text).toContain(PALETTE.reference);
    expect(text).not.toContain(PALETTE.simulated);
  });
});

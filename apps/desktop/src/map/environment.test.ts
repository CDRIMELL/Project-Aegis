import {
  conditionsAt,
  greatCircleDistance,
  weatherModel,
  type RoutePoint,
  type WorldEvent,
} from '@aegis/domain';
import { describe, expect, it } from 'vitest';
import { formatCloud, formatPrecipitation, formatWind } from '../features/shared/weather-display';
import {
  WIND_LAYER_ALTITUDE_M,
  eventBounds,
  eventFeatures,
  eventFeaturesKey,
  gridPoints,
  gridSpacing,
  weatherFeatures,
  type Bounds,
} from './environment-features';

const WEATHER = weatherModel('map-weather', Date.UTC(2026, 9, 4, 12));
const EUROPE: Bounds = [-20, 35, 25, 62];
const WORLD: Bounds = [-180, -85, 180, 85];
const EXETER: RoutePoint = {
  kind: 'aerodrome',
  refId: 'test:egte',
  code: 'EGTE',
  name: 'Exeter',
  lat: 50.7344,
  lon: -3.4139,
  elevationM: 31,
};
const event = (overrides: Partial<WorldEvent>): WorldEvent => ({
  id: 'EVT-000001',
  type: 'aerodrome_closure',
  status: 'active',
  source: 'generated',
  severity: 0.6,
  createdTick: 0,
  startTick: 100,
  endTick: 500,
  place: EXETER,
  centre: null,
  radiusM: null,
  aircraftId: null,
  missionId: null,
  title: 'Aerodrome closure: Exeter (EGTE)',
  description: 'Simulated event.',
  ...overrides,
});

describe('the weather grid', () => {
  it('is coarse when zoomed out and finer when zoomed in', () => {
    expect([1, 3, 5, 6, 8].map(gridSpacing)).toEqual([10, 5, 2.5, 1, 0.5]);
  });

  it('covers the view with points aligned to the spacing, so they do not swim as the map moves', () => {
    const points = gridPoints(EUROPE, 3);
    expect(points.length).toBeGreaterThan(20);
    for (const point of points) {
      expect(point.lat % 5).toBe(0);
      expect(Math.abs(point.lon % 5)).toBe(0);
      expect(point.lat).toBeGreaterThanOrEqual(35);
      expect(point.lat).toBeLessThanOrEqual(62);
      expect(point.lon).toBeGreaterThanOrEqual(-20);
      expect(point.lon).toBeLessThanOrEqual(25);
    }
    // A view moved by a degree shares the grid points it still contains.
    const shifted = gridPoints([-19, 36, 26, 63], 3);
    const key = (p: { lat: number; lon: number }) => `${p.lat},${p.lon}`;
    const before = new Set(points.map(key));
    expect(shifted.filter((p) => before.has(key(p))).length).toBeGreaterThan(points.length * 0.7);
  });

  it('never samples more than a few hundred points, however wide the view', () => {
    for (const zoom of [0, 2, 4, 6, 9]) {
      expect(gridPoints(WORLD, zoom).length).toBeLessThanOrEqual(700);
      // Even a view that has wrapped several times round the world.
      expect(gridPoints([-540, -85, 540, 85], zoom).length).toBeLessThanOrEqual(700);
    }
    expect(gridPoints(WORLD, 8).length).toBeGreaterThan(100);
  });

  it('stays clear of the poles', () => {
    for (const point of gridPoints(WORLD, 1)) expect(Math.abs(point.lat)).toBeLessThanOrEqual(85);
  });
});

describe('weather on the map', () => {
  const both = { wind: true, precipitation: true };

  it('samples nothing when both layers are off', () => {
    const features = weatherFeatures(WEATHER, 0, EUROPE, 4, { wind: false, precipitation: false });
    expect(features.wind.features).toEqual([]);
    expect(features.precipitation.features).toEqual([]);
  });

  it('draws only the layers that are switched on', () => {
    const windOnly = weatherFeatures(WEATHER, 0, WORLD, 2, { wind: true, precipitation: false });
    expect(windOnly.wind.features.length).toBeGreaterThan(0);
    expect(windOnly.precipitation.features).toEqual([]);
    const rainOnly = weatherFeatures(WEATHER, 0, WORLD, 2, { wind: false, precipitation: true });
    expect(rainOnly.wind.features).toEqual([]);
    expect(rainOnly.precipitation.features.length).toBeGreaterThan(0);
  });

  it('shades a cell only where the field has precipitation, by its intensity', () => {
    const features = weatherFeatures(WEATHER, 0, WORLD, 2, both).precipitation.features;
    const points = gridPoints(WORLD, 2);
    const wet = points.filter((p) => conditionsAt(WEATHER, 0, p, 0).precipitation > 0.02);
    expect(features).toHaveLength(wet.length);
    // Most of the world is dry: the layer is sparse.
    expect(features.length).toBeLessThan(points.length * 0.4);
    for (const feature of features) {
      // Rounded to two places for the map.
      expect(feature.properties.intensity).toBeGreaterThanOrEqual(0.02);
      expect(feature.properties.intensity).toBeLessThanOrEqual(1);
      expect(feature.geometry.coordinates[0]).toHaveLength(5);
    }
  });

  it('draws the wind aloft as an arrow pointing the way it blows', () => {
    const features = weatherFeatures(WEATHER, 0, EUROPE, 4, both).wind.features;
    expect(features.length).toBeGreaterThan(0);
    for (const feature of features) {
      const [tail, head] = feature.geometry.coordinates as [number, number][];
      const centre = {
        lat: ((tail?.[1] ?? 0) + (head?.[1] ?? 0)) / 2,
        lon: ((tail?.[0] ?? 0) + (head?.[0] ?? 0)) / 2,
      };
      const aloft = conditionsAt(
        WEATHER,
        0,
        { lat: Math.round(centre.lat / 2.5) * 2.5, lon: Math.round(centre.lon / 2.5) * 2.5 },
        WIND_LAYER_ALTITUDE_M,
      );
      expect(feature.properties.speed).toBe(Math.round(aloft.windSpeedKmh));
      // The arrow runs the way the wind's east and north parts point.
      expect(Math.sign((head?.[0] ?? 0) - (tail?.[0] ?? 0))).toBe(Math.sign(aloft.windEastKmh));
      expect(feature.geometry.coordinates).toHaveLength(5);
    }
  });

  it('is deterministic, and changes with time', () => {
    const now = weatherFeatures(WEATHER, 0, EUROPE, 4, both);
    expect(weatherFeatures(WEATHER, 0, EUROPE, 4, both)).toEqual(now);
    expect(weatherFeatures(WEATHER, 12 * 3600, EUROPE, 4, both)).not.toEqual(now);
  });
});

describe('events on the map', () => {
  const disruption = event({
    id: 'EVT-000002',
    type: 'navigation_disruption',
    status: 'scheduled',
    place: null,
    centre: { name: 'Area near Exeter', lat: 50.6, lon: -4.2 },
    radiusM: 90_000,
  });

  it('marks a closed aerodrome and says it is closed', () => {
    const features = eventFeatures([event({})]);
    expect(features.areas.features).toEqual([]);
    expect(features.points.features).toHaveLength(1);
    expect(features.points.features[0]).toMatchObject({
      geometry: { coordinates: [EXETER.lon, EXETER.lat] },
      properties: { eventId: 'EVT-000001', active: true, label: 'CLOSED · EVT-000001' },
    });
  });

  it('draws an area as a ring of its radius, and says when it is only announced', () => {
    const features = eventFeatures([disruption]);
    const ring = features.areas.features[0]?.geometry.coordinates[0] ?? [];
    expect(ring).toHaveLength(49);
    for (const [lon, lat] of ring as [number, number][]) {
      expect(greatCircleDistance({ lat, lon }, { lat: 50.6, lon: -4.2 })).toBeCloseTo(90_000, -1);
    }
    expect(features.points.features[0]?.properties).toMatchObject({
      active: false,
      label: 'NAV DISRUPTED (announced) · EVT-000002',
    });
  });

  it('draws nothing for a finished event, or one with nowhere to be', () => {
    const features = eventFeatures([
      event({ status: 'resolved' }),
      { ...disruption, status: 'cancelled' },
      event({ type: 'maintenance_finding', place: null, aircraftId: 'AEGIS-TR-001' }),
    ]);
    expect(features.areas.features).toEqual([]);
    expect(features.points.features).toEqual([]);
  });

  it('redraws only when an event is announced, starts or ends', () => {
    const key = eventFeaturesKey([event({}), disruption]);
    // An advisory being extended does not change what is drawn.
    expect(eventFeaturesKey([event({ endTick: 9000, severity: 0.9 }), disruption])).toBe(key);
    expect(eventFeaturesKey([event({}), { ...disruption, status: 'active' }])).not.toBe(key);
    expect(eventFeaturesKey([event({ status: 'resolved' }), disruption])).not.toBe(key);
    expect(eventFeaturesKey([])).toBe('');
  });

  it('frames an event with room around it', () => {
    const [west, south, east, north] = eventBounds(disruption) ?? [0, 0, 0, 0];
    expect(west).toBeLessThan(-4.2);
    expect(east).toBeGreaterThan(-4.2);
    expect(north - south).toBeGreaterThan(1.6);
    const closure = eventBounds(event({})) ?? [0, 0, 0, 0];
    expect(closure[0]).toBeLessThan(EXETER.lon);
    expect(closure[2]).toBeGreaterThan(EXETER.lon);
    expect(
      eventBounds(event({ type: 'maintenance_finding', place: null, aircraftId: 'X' })),
    ).toBeNull();
  });
});

describe('describing conditions', () => {
  it('gives wind as where it blows from, and how hard', () => {
    expect(formatWind({ windFromDeg: 270, windSpeedKmh: 35.4 })).toBe('270° W at 35 km/h');
    expect(formatWind({ windFromDeg: 4, windSpeedKmh: 12 })).toBe('004° N at 12 km/h');
    expect(formatWind({ windFromDeg: 359.7, windSpeedKmh: 12 })).toBe('000° N at 12 km/h');
    expect(formatWind({ windFromDeg: 135, windSpeedKmh: 1 })).toBe('Calm');
  });

  it('describes cloud by how much of the sky it covers, with its base where there is one', () => {
    expect(formatCloud({ cloudCover: 0, ceilingM: null })).toBe('Clear');
    expect(formatCloud({ cloudCover: 0.2, ceilingM: null })).toBe('Few');
    expect(formatCloud({ cloudCover: 0.45, ceilingM: null })).toBe('Scattered');
    expect(formatCloud({ cloudCover: 0.8, ceilingM: 1500 })).toBe('Broken, base 1,500 m');
    expect(formatCloud({ cloudCover: 1, ceilingM: 300 })).toBe('Overcast, base 300 m');
  });

  it('names precipitation by intensity', () => {
    expect([0, 0.1, 0.4, 0.9].map(formatPrecipitation)).toEqual([
      'None',
      'Light',
      'Moderate',
      'Heavy',
    ]);
  });
});

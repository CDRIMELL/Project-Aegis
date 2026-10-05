import {
  derivePerformance,
  greatCircleDistance,
  type PerformanceModel,
  type RoutePoint,
} from '@aegis/domain';
import type { FlightView } from '@aegis/sim';
import { describe, expect, it } from 'vitest';
import {
  activeRouteFeatures,
  aircraftFeatures,
  draftFeatures,
  interpolateAircraft,
  legCoordinates,
} from '../map/flight-features';
import {
  STARTER_FLEET,
  aerodromePoint,
  buildCatalogue,
  chooseSourced,
  orderFor,
  starterOrders,
  type AttributeRow,
  type TypeRow,
} from './catalogue';
import {
  evaluateDraft,
  generateDraft,
  insertWaypoint,
  isEditablePoint,
  moveWaypoint,
  refuelForRoute,
  removeWaypoint,
  setCruiseAltitude,
  setCruiseSpeed,
  setLoad,
  shiftWaypoint,
} from './plan-edit';

const type = (slug: string, category = 'transport', engineType = 'turbofan'): TypeRow => ({
  id: `aegis-curated:${slug}`,
  slug,
  name: slug.toUpperCase(),
  manufacturer: 'M',
  category,
  engineType,
  engineCount: 2,
  ukServiceName: null,
});
const attribute = (
  slug: string,
  key: string,
  value: number,
  overrides: Partial<AttributeRow> = {},
): AttributeRow => ({
  typeId: `aegis-curated:${slug}`,
  key,
  value,
  sourceId: 'wikipedia',
  sourceUrl: 'https://example.org',
  sourceText: `${key}=${value}`,
  confidence: 'medium',
  verification: 'source_asserted',
  note: null,
  ...overrides,
});
const C17_ATTRIBUTES = [
  attribute('c-17', 'empty_mass_kg', 128140),
  attribute('c-17', 'max_takeoff_mass_kg', 265352),
  attribute('c-17', 'cruise_speed_kmh', 833),
  attribute('c-17', 'range_km', 4482),
  attribute('c-17', 'service_ceiling_m', 13716),
];

const aerodrome = (code: string, lat: number, lon: number, elevationM = 0): RoutePoint => ({
  kind: 'aerodrome',
  name: code,
  code,
  lat,
  lon,
  elevationM,
  refId: `ourairports:${code}`,
});
const NEWQUAY = aerodrome('EGHQ', 50.4406, -4.9954, 119);
const AKROTIRI = aerodrome('LCRA', 34.5904, 32.9879, 23);
const TOKYO = aerodrome('RJTT', 35.5523, 139.7797, 6);
const SEATTLE = aerodrome('KSEA', 47.449, -122.3093, 132);

function c17Model(): PerformanceModel {
  const entry = buildCatalogue([type('c-17')], C17_ATTRIBUTES)[0];
  if (!entry?.performance.available) throw new Error('unavailable');
  return entry.performance.model;
}

describe('catalogue', () => {
  it('builds a performance model from sourced characteristics', () => {
    const [entry] = buildCatalogue([type('c-17')], C17_ATTRIBUTES);
    expect(entry?.characteristics).toMatchObject({
      emptyMassKg: 128140,
      maxSpeedKmh: null,
      ferryRangeKm: null,
    });
    expect(entry?.performance).toEqual(
      derivePerformance({
        category: 'transport',
        engineType: 'turbofan',
        emptyMassKg: 128140,
        maxTakeoffMassKg: 265352,
        cruiseSpeedKmh: 833,
        maxSpeedKmh: null,
        rangeKm: 4482,
        ferryRangeKm: null,
        serviceCeilingM: 13716,
      }),
    );
    expect(entry?.sourced.range_km).toMatchObject({
      value: 4482,
      sourceId: 'wikipedia',
      verification: 'source_asserted',
    });
  });

  it('reports a type as unavailable, with what is missing, instead of inventing values', () => {
    const [entry] = buildCatalogue(
      [type('voyager', 'tanker')],
      [attribute('voyager', 'max_takeoff_mass_kg', 233000)],
    );
    expect(entry?.performance).toEqual({
      available: false,
      missing: ['empty mass', 'range', 'cruise or maximum speed'],
    });
    expect(orderFor(entry as NonNullable<typeof entry>, NEWQUAY)).toMatchObject({
      performance: null,
      performanceMissing: ['empty mass', 'range', 'cruise or maximum speed'],
    });
  });

  it('prefers the more confident source, and breaks ties the same way every time', () => {
    const wiki = attribute('x', 'length_m', 10, { confidence: 'low' });
    const official = attribute('x', 'length_m', 11, {
      sourceId: 'aegis-curated',
      confidence: 'high',
      verification: 'unverified',
    });
    expect(chooseSourced([wiki, official]).length_m?.value).toBe(11);
    expect(chooseSourced([official, wiki]).length_m?.value).toBe(11);

    const a = attribute('x', 'height_m', 1, { sourceId: 'b-source' });
    const b = attribute('x', 'height_m', 2, { sourceId: 'a-source' });
    expect(chooseSourced([a, b]).height_m?.value).toBe(2);
    expect(chooseSourced([b, a]).height_m?.value).toBe(2);
  });

  it('copies an aerodrome for the simulation, keeping the reference id', () => {
    expect(
      aerodromePoint({
        id: 'ourairports:2448',
        name: 'Cornwall Airport Newquay',
        lat: 50.44,
        lon: -4.99,
        elevationM: 118.9,
        icao: 'EGHQ',
        iata: 'NQY',
      }),
    ).toEqual({
      kind: 'aerodrome',
      name: 'Cornwall Airport Newquay',
      code: 'EGHQ',
      lat: 50.44,
      lon: -4.99,
      elevationM: 118.9,
      refId: 'ourairports:2448',
    });
    const bare = aerodromePoint({
      id: 'x:1',
      name: 'Strip',
      lat: 1,
      lon: 2,
      elevationM: null,
      icao: null,
      iata: null,
    });
    expect(bare.elevationM).toBe(0);
    expect('code' in bare).toBe(false);
  });

  it('orders the starter fleet from real types and reports anything the reference data lacks', () => {
    const catalogue = buildCatalogue([type('c-17'), type('typhoon', 'fast_jet')], C17_ATTRIBUTES);
    const homes = [
      {
        id: 'ourairports:2448',
        name: 'Newquay',
        lat: 50.44,
        lon: -4.99,
        elevationM: 118.9,
        icao: 'EGHQ',
        iata: 'NQY',
      },
    ];
    const { orders, missing } = starterOrders(catalogue, homes);
    expect(orders.map((order) => order.typeName)).toEqual(['C-17']);
    expect(missing).toEqual(['aerodrome EGPK', 'aircraft type "a400m"']);
    expect(STARTER_FLEET.length).toBeLessThanOrEqual(6);
  });
});

describe('plan editing', () => {
  const model = c17Model();
  const draft = generateDraft('AEGIS-TR-001', model, NEWQUAY, AKROTIRI, 10_000);

  it('generates a direct, fuelled, flyable plan', () => {
    expect(draft.plan.points[0]).toBe(NEWQUAY);
    expect(draft.plan.points.at(-1)).toBe(AKROTIRI);
    expect(draft.load.payloadKg).toBe(10_000);
    const evaluation = evaluateDraft(draft, model);
    expect(evaluation.flyable).toBe(true);
    expect(evaluation.estimate?.fuelAtDestinationKg).toBeGreaterThanOrEqual(model.reserveFuelKg);
  });

  it('offers full tanks when no load can make the trip with reserve', () => {
    const tooFar = generateDraft(
      'AEGIS-TR-001',
      model,
      NEWQUAY,
      TOKYO,
      model.maxPayloadKg - model.fuelCapacityKg,
    );
    expect(tooFar.load.fuelKg).toBe(model.fuelCapacityKg);
    expect(evaluateDraft(tooFar, model).flyable).toBe(false);
  });

  it('inserts a waypoint midway along a leg by default, or where asked', () => {
    const middle = insertWaypoint(draft, 0);
    const first = draft.plan.points[0] as RoutePoint;
    const second = draft.plan.points[1] as RoutePoint;
    const inserted = middle.plan.points[1] as RoutePoint;
    expect(inserted.kind).toBe('waypoint');
    expect(greatCircleDistance(first, inserted)).toBeCloseTo(
      greatCircleDistance(inserted, second),
      3,
    );
    // On the leg, so the route is no longer.
    expect(evaluateDraft(middle, model).estimate?.distanceM).toBeCloseTo(
      evaluateDraft(draft, model).estimate?.distanceM ?? 0,
      0,
    );

    const placed = insertWaypoint(draft, 0, { lat: 40, lon: 10 });
    expect(placed.plan.points[1]).toMatchObject({ lat: 40, lon: 10 });
  });

  it('keeps waypoint names in route order through every edit', () => {
    const names = (d: typeof draft) =>
      d.plan.points.filter((p) => p.kind === 'waypoint').map((p) => p.name);
    const base = generateDraft('A', model, NEWQUAY, AKROTIRI, 0);
    let edited = insertWaypoint(insertWaypoint(base, 0, { lat: 45, lon: 5 }), 1, {
      lat: 40,
      lon: 15,
    });
    const expected = names(edited).map((_, i) => `WP${i + 1}`);
    expect(names(edited)).toEqual(expected);
    edited = shiftWaypoint(edited, 1, 1);
    expect(names(edited)).toEqual(expected);
    expect(edited.plan.points[1]).toMatchObject({ lat: 40, lon: 15 });
    edited = removeWaypoint(edited, 1);
    expect(names(edited)).toEqual(expected.slice(0, -1));
  });

  it('moves a waypoint, clamping to valid coordinates', () => {
    const withWaypoint = insertWaypoint(draft, 0);
    expect(moveWaypoint(withWaypoint, 1, 37.5, 14).plan.points[1]).toMatchObject({
      lat: 37.5,
      lon: 14,
    });
    expect(moveWaypoint(withWaypoint, 1, 95, 190).plan.points[1]).toMatchObject({
      lat: 85,
      lon: -170,
    });
    expect(moveWaypoint(withWaypoint, 1, Number.NaN, 0)).toBe(withWaypoint);
  });

  it('never moves, removes or reorders the origin or destination', () => {
    const last = draft.plan.points.length - 1;
    expect(isEditablePoint(draft, 0)).toBe(false);
    expect(isEditablePoint(draft, last)).toBe(false);
    expect(moveWaypoint(draft, 0, 1, 1)).toBe(draft);
    expect(removeWaypoint(draft, last)).toBe(draft);
    const one = insertWaypoint(
      generateDraft('A', model, NEWQUAY, aerodrome('EGPK', 55.5, -4.59), 0),
      0,
    );
    expect(shiftWaypoint(one, 1, -1)).toBe(one);
    expect(shiftWaypoint(one, 1, 1)).toBe(one);
  });

  it('recalculates distance, time and fuel after a waypoint is dragged off the direct route', () => {
    const before = evaluateDraft(draft, model).estimate;
    const dragged = moveWaypoint(insertWaypoint(draft, 0), 1, 60, 20);
    const after = evaluateDraft(dragged, model).estimate;
    expect(after?.distanceM).toBeGreaterThan((before?.distanceM ?? 0) * 1.2);
    expect(after?.durationS).toBeGreaterThan(before?.durationS ?? 0);
    expect(after?.fuelUsedKg).toBeGreaterThan(before?.fuelUsedKg ?? 0);
    // Removing it again restores the original estimate exactly.
    expect(evaluateDraft(removeWaypoint(dragged, 1), model).estimate).toEqual(before);
  });

  it('re-evaluates constraints when altitude, speed or load change', () => {
    const codes = (d: typeof draft) =>
      evaluateDraft(d, model).constraints.map((c) => `${c.severity}:${c.code}`);
    expect(codes(setCruiseAltitude(draft, 14_000))).toContain('block:above_service_ceiling');
    expect(codes(setCruiseAltitude(draft, 4000))).toContain('note:low_cruise_altitude');
    expect(codes(setCruiseSpeed(draft, 1000))).toContain('warning:speed_unchecked');
    expect(codes(setLoad(draft, { payloadKg: model.maxPayloadKg }))).toContain(
      'block:over_maximum_mass',
    );
    expect(codes(setLoad(draft, { fuelKg: 5000 }))).toContain('block:insufficient_fuel');
    expect(
      evaluateDraft(refuelForRoute(setLoad(draft, { fuelKg: 5000 }), model), model).flyable,
    ).toBe(true);
  });
});

describe('flight map features', () => {
  const flight = (overrides: Partial<FlightView> = {}): FlightView => ({
    id: 'FLT-000001',
    aircraftId: 'AEGIS-TR-001',
    lat: 48,
    lon: 2,
    headingDeg: 120,
    phase: 'cruise',
    altitudeM: 10_000,
    speedKmh: 800,
    fuelKg: 40_000,
    burnRateKgH: 6000,
    distanceM: 500_000,
    totalM: greatCircleDistance(NEWQUAY, AKROTIRI),
    elapsedS: 2400,
    etaTick: 16_000,
    estimatedFuelAtDestinationKg: 9000,
    points: [NEWQUAY, AKROTIRI],
    hold: null,
    heldS: 0,
    closureLanding: false,
    intent: null,
    revisions: [],
    plannedDestination: AKROTIRI,
    caution: null,
    missionId: null,
    departedTick: 13_600,
    payloadKg: 0,
    progress: {
      phase: 'cruise',
      distanceM: 500_000,
      altitudeM: 10_000,
      speedKmh: 800,
      fuelKg: 40_000,
      elapsedS: 2400,
      burnRateKgH: 6000,
      topAltitudeM: 10_000,
      fuelExhausted: false,
      environment: { tailwindKmh: 0, crosswindKmh: 0, temperatureDeviationC: 0, precipitation: 0 },
      exposure: {
        tailwindKmhS: 0,
        worstSeverity: 0,
        lowestVisibilityKm: null,
        heaviestPrecipitation: 0,
      },
      hold: null,
      heldS: 0,
      closureLanding: false,
    },
    cruiseAltitudeM: 10_000,
    cruiseSpeedKmh: 800,
    groundSpeedKmh: 833,
    tailwindKmh: 0,
    windFromDeg: 0,
    windSpeedKmh: 0,
    outsideTemperatureC: -50,
    visibilityKm: 40,
    precipitation: 0,
    severity: 0,
    ...overrides,
  });

  it('marks aircraft with heading and selection', () => {
    const { features } = aircraftFeatures(
      [{ aircraftId: 'AEGIS-TR-001', lat: 48, lon: 2, headingDeg: 120 }],
      'AEGIS-TR-001',
    );
    expect(features[0]).toEqual({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [2, 48] },
      properties: { id: 'AEGIS-TR-001', heading: 120, selected: true },
    });
    expect(aircraftFeatures([], null).features).toEqual([]);
  });

  it('draws a route as a great circle that begins and ends at its aerodromes', () => {
    const [route] = activeRouteFeatures([flight()], null).features;
    const coordinates = route?.geometry.coordinates ?? [];
    expect(coordinates.length).toBeGreaterThan(20);
    expect(coordinates[0]).toEqual([NEWQUAY.lon, NEWQUAY.lat]);
    expect(coordinates.at(-1)).toEqual([AKROTIRI.lon, AKROTIRI.lat]);
    expect(route?.properties).toEqual({ id: 'AEGIS-TR-001', selected: false });
  });

  it('draws a route across the antimeridian as one continuous line', () => {
    const coordinates = legCoordinates(TOKYO, SEATTLE, greatCircleDistance(TOKYO, SEATTLE));
    for (let i = 1; i < coordinates.length; i++) {
      const step = Math.abs((coordinates[i]?.[0] ?? 0) - (coordinates[i - 1]?.[0] ?? 0));
      expect(step).toBeLessThan(30);
    }
    // Continues east past 180 instead of jumping to negative longitudes.
    expect(coordinates.at(-1)?.[0]).toBeCloseTo(SEATTLE.lon + 360, 6);
  });

  it('gives the draft a handle per point and a midpoint handle per leg', () => {
    const wp: RoutePoint = { kind: 'waypoint', name: 'WP1', lat: 42, lon: 12, elevationM: 0 };
    const { route, handles } = draftFeatures([NEWQUAY, wp, AKROTIRI]);
    expect(route.features).toHaveLength(1);
    expect(
      handles.features.map((f) => [f.properties.role, f.properties.index, f.properties.label]),
    ).toEqual([
      ['origin', 0, 'EGHQ'],
      ['waypoint', 1, 'WP1'],
      ['destination', 2, 'LCRA'],
      ['midpoint', 0, ''],
      ['midpoint', 1, ''],
    ]);
    expect(draftFeatures([NEWQUAY]).handles.features).toEqual([]);
  });

  it('smooths an aircraft between simulation updates without leaving its route', () => {
    const previous = flight({ distanceM: 500_000 });
    const latest = flight({ distanceM: 502_500, lat: 47.99, lon: 2.03 });
    const pair = { previous, latest, previousAtMs: 1000, latestAtMs: 1100 };

    const start = interpolateAircraft(pair, 1100);
    const half = interpolateAircraft(pair, 1150);
    const end = interpolateAircraft(pair, 1200);
    const late = interpolateAircraft(pair, 5000);

    expect(greatCircleDistance(start, NEWQUAY)).toBeCloseTo(500_000, 0);
    expect(greatCircleDistance(half, NEWQUAY)).toBeCloseTo(501_250, 0);
    // At and after the end of the interval it shows exactly what the simulation reported.
    expect(end).toEqual({ aircraftId: 'AEGIS-TR-001', lat: 47.99, lon: 2.03, headingDeg: 120 });
    expect(late).toEqual(end);
  });

  it('does not interpolate across different flights of the same aircraft', () => {
    const pair = {
      previous: flight({ id: 'FLT-000001', distanceM: 900_000 }),
      latest: flight({ id: 'FLT-000002', distanceM: 0, lat: 50.44, lon: -4.99 }),
      previousAtMs: 0,
      latestAtMs: 100,
    };
    expect(interpolateAircraft(pair, 120)).toMatchObject({ lat: 50.44, lon: -4.99 });
  });
});

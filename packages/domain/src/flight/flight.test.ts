import { describe, expect, it } from 'vitest';
import { greatCircleDistance } from '../geo';
import {
  FLIGHT_ASSUMPTIONS,
  FLIGHT_MODEL_VERSION,
  derivePerformance,
  type PerformanceModel,
  type TypeCharacteristics,
} from './performance';
import {
  evaluatePlan,
  flightProfile,
  generatePlan,
  suggestedFuelKg,
  type FlightPlan,
} from './plan';
import {
  NO_EXPOSURE,
  STILL_AIR,
  advanceFlight,
  altitudeFuelFactor,
  flyToCompletion,
  initialProgress,
  speedFuelFactor,
  type FlightPhase,
  type FlightProgress,
} from './profile';
import { directRoute, positionAlong, routeGeometry, routeProblems, type RoutePoint } from './route';

// Characteristics as held in the reference data (sourced values only).
const TYPHOON: TypeCharacteristics = {
  category: 'fast_jet',
  engineType: 'turbofan',
  emptyMassKg: 11000,
  maxTakeoffMassKg: 23500,
  cruiseSpeedKmh: null,
  maxSpeedKmh: 2495,
  rangeKm: 2900,
  ferryRangeKm: 3790,
  serviceCeilingM: 16764,
};
const C17: TypeCharacteristics = {
  category: 'transport',
  engineType: 'turbofan',
  emptyMassKg: 128140,
  maxTakeoffMassKg: 265352,
  cruiseSpeedKmh: 833,
  maxSpeedKmh: null,
  rangeKm: 4482,
  ferryRangeKm: 11538,
  serviceCeilingM: 13716,
};
const MERLIN: TypeCharacteristics = {
  category: 'rotary',
  engineType: 'turboshaft',
  emptyMassKg: 10500,
  maxTakeoffMassKg: 15600,
  cruiseSpeedKmh: 278,
  maxSpeedKmh: null,
  rangeKm: 1389,
  ferryRangeKm: null,
  serviceCeilingM: 4575,
};

function model(type: TypeCharacteristics): PerformanceModel {
  const result = derivePerformance(type);
  if (!result.available) throw new Error(`unavailable: ${result.missing.join(', ')}`);
  return result.model;
}

const aerodrome = (name: string, lat: number, lon: number, elevationM = 0): RoutePoint => ({
  kind: 'aerodrome',
  name,
  lat,
  lon,
  elevationM,
});
const PRESTWICK = aerodrome('Glasgow Prestwick', 55.5094, -4.5867, 20);
const NEWQUAY = aerodrome('Newquay', 50.4406, -4.9954, 119);
const AKROTIRI = aerodrome('Akrotiri', 34.5904, 32.9879, 23);
const JFK = aerodrome('JFK', 40.6394, -73.7793, 4);
const NEARBY = aerodrome('Nearby', 55.6, -4.4, 20);

const plan = (m: PerformanceModel, ...points: RoutePoint[]): FlightPlan => ({
  points,
  cruiseAltitudeM: m.cruiseAltitudeM,
  cruiseSpeedKmh: m.cruiseSpeedKmh,
});

describe('derivePerformance', () => {
  it('derives a model from sourced characteristics and named assumptions', () => {
    const typhoon = model(TYPHOON);
    expect(typhoon).toMatchObject({
      modelVersion: FLIGHT_MODEL_VERSION,
      emptyMassKg: 11000,
      maxTakeoffMassKg: 23500,
      serviceCeilingM: 16764,
      maxSpeedKmh: 2495,
      referenceRangeKm: 2900,
      referenceRangeKind: 'range',
      fuelCapacityKg: 6250,
      reserveFuelKg: 625,
      maxPayloadKg: 12500,
      cruiseSpeedKmh: 900,
      cruiseAltitudeM: 11500,
      climbRateMs: 60,
      accelerationMs2: 4,
      hovers: false,
    });
    // K = range / ln(m0 / (m0 - usable fuel)), usable = capacity - reserve.
    expect(typhoon.rangeFactorKm).toBeCloseTo(2900 / Math.log(23500 / (23500 - 5625)), 6);
  });

  it('records which assumptions a model relies on', () => {
    expect(model(TYPHOON).assumptions).toContain('cruiseSpeed');
    expect(model(C17).assumptions).not.toContain('cruiseSpeed');
    expect(model(C17).assumptions).toEqual(
      expect.arrayContaining(['fuelCapacity', 'reserve', 'climbRate']),
    );
  });

  it('uses a sourced cruise speed when there is one', () => {
    expect(model(C17).cruiseSpeedKmh).toBe(833);
    expect(model(C17).maxSpeedKmh).toBeNull();
  });

  it('treats rotorcraft as hovering, with a low cruise altitude', () => {
    expect(model(MERLIN)).toMatchObject({ hovers: true, cruiseAltitudeM: 900, climbRateMs: 7 });
  });

  it('falls back to ferry range, calibrated with no payload', () => {
    const ferryOnly = model({ ...C17, rangeKm: null });
    expect(ferryOnly.referenceRangeKind).toBe('ferry_range');
    const fuel = ferryOnly.fuelCapacityKg;
    const takeoff = 128140 + fuel;
    expect(ferryOnly.rangeFactorKm).toBeCloseTo(
      11538 / Math.log(takeoff / (takeoff - (fuel - ferryOnly.reserveFuelKg))),
      3,
    );
  });

  it('refuses to produce a model when a required characteristic is missing, and says which', () => {
    expect(derivePerformance({ ...TYPHOON, emptyMassKg: null })).toEqual({
      available: false,
      missing: ['empty mass'],
    });
    expect(
      derivePerformance({
        ...TYPHOON,
        maxTakeoffMassKg: null,
        rangeKm: null,
        ferryRangeKm: null,
        maxSpeedKmh: null,
      }),
    ).toEqual({
      available: false,
      missing: ['maximum take-off mass', 'range', 'cruise or maximum speed'],
    });
    expect(derivePerformance({ ...TYPHOON, maxTakeoffMassKg: 9000 })).toMatchObject({
      available: false,
    });
  });

  it('does not make every type equally capable', () => {
    const typhoon = model(TYPHOON);
    const c17 = model(C17);
    expect(c17.fuelCapacityKg).toBeGreaterThan(typhoon.fuelCapacityKg * 5);
    expect(typhoon.climbRateMs).toBeGreaterThan(c17.climbRateMs);
    expect(c17.rangeFactorKm).not.toBeCloseTo(typhoon.rangeFactorKm, 0);
  });
});

describe('route', () => {
  it('measures legs and total distance on the great circle', () => {
    const route = routeGeometry([PRESTWICK, NEWQUAY, AKROTIRI]);
    expect(route.legs).toHaveLength(2);
    expect(route.legs[0]?.distanceM).toBeCloseTo(greatCircleDistance(PRESTWICK, NEWQUAY), 6);
    expect(route.legs[1]?.startM).toBeCloseTo(route.legs[0]?.distanceM ?? 0, 6);
    expect(route.totalM).toBeCloseTo(
      greatCircleDistance(PRESTWICK, NEWQUAY) + greatCircleDistance(NEWQUAY, AKROTIRI),
      6,
    );
  });

  it('finds position and heading along a multi-leg route', () => {
    const route = routeGeometry([PRESTWICK, NEWQUAY, AKROTIRI]);
    const start = positionAlong(route, 0);
    expect(start.lat).toBeCloseTo(PRESTWICK.lat, 9);
    expect(start.headingDeg).toBeCloseTo(route.legs[0]?.bearingDeg ?? 0, 6);

    const onSecondLeg = positionAlong(route, (route.legs[0]?.distanceM ?? 0) + 1000);
    expect(onSecondLeg.legIndex).toBe(1);
    expect(greatCircleDistance(onSecondLeg, NEWQUAY)).toBeCloseTo(1000, 0);

    const end = positionAlong(route, route.totalM + 5000);
    expect(end.lat).toBeCloseTo(AKROTIRI.lat, 9);
    expect(end.lon).toBeCloseTo(AKROTIRI.lon, 9);
    expect(positionAlong(route, -10).lat).toBeCloseTo(PRESTWICK.lat, 9);
  });

  it('reports why a list of points is not a route', () => {
    expect(routeProblems([PRESTWICK])).toEqual(['A route needs an origin and a destination.']);
    expect(routeProblems([PRESTWICK, { ...NEWQUAY, kind: 'waypoint' }])[0]).toMatch(
      /start and end at an aerodrome/,
    );
    expect(routeProblems([PRESTWICK, { ...NEWQUAY, lat: 95 }])[0]).toMatch(/not a valid position/);
    expect(routeProblems([PRESTWICK, { ...PRESTWICK, name: 'Twin' }])[0]).toMatch(/same position/);
    expect(routeProblems([PRESTWICK, NEWQUAY, AKROTIRI])).toEqual([]);
  });

  it('adds evenly spaced waypoints to a long direct route without lengthening it', () => {
    const points = directRoute(PRESTWICK, JFK);
    expect(points.length).toBeGreaterThan(2);
    expect(points[0]).toBe(PRESTWICK);
    expect(points.at(-1)).toBe(JFK);
    expect(points.slice(1, -1).every((point) => point.kind === 'waypoint')).toBe(true);
    expect(routeGeometry(points).totalM).toBeCloseTo(greatCircleDistance(PRESTWICK, JFK), 0);
    expect(directRoute(PRESTWICK, NEARBY)).toHaveLength(2);
  });
});

describe('fuel model', () => {
  /** Flies level at cruise for a distance and returns the fuel burned. */
  function cruiseBurn(
    m: PerformanceModel,
    startFuelKg: number,
    payloadKg: number,
    distanceKm: number,
    altitudeM = m.cruiseAltitudeM,
    speedKmh = m.cruiseSpeedKmh,
  ): number {
    const profile = {
      model: m,
      totalDistanceM: 1e12,
      originElevationM: 0,
      destinationElevationM: 0,
      cruiseAltitudeM: altitudeM,
      cruiseSpeedKmh: speedKmh,
      payloadKg,
    };
    let progress: FlightProgress = {
      phase: 'cruise',
      distanceM: 0,
      altitudeM,
      speedKmh,
      fuelKg: startFuelKg,
      elapsedS: 0,
      burnRateKgH: 0,
      topAltitudeM: altitudeM,
      fuelExhausted: false,
      environment: STILL_AIR,
      exposure: NO_EXPOSURE,
      hold: null,
      heldS: 0,
      closureLanding: false,
    };
    while (progress.distanceM < distanceKm * 1000 && !progress.fuelExhausted) {
      progress = advanceFlight(profile, progress, 1);
    }
    return startFuelKg - progress.fuelKg;
  }

  it('is calibrated: cruising the published range uses the usable fuel', () => {
    for (const type of [TYPHOON, C17, MERLIN]) {
      const m = model(type);
      const payload = m.maxTakeoffMassKg - m.emptyMassKg - m.fuelCapacityKg;
      const burned = cruiseBurn(m, m.fuelCapacityKg, payload, m.referenceRangeKm);
      const usable = m.fuelCapacityKg - m.reserveFuelKg;
      expect(Math.abs(burned - usable) / usable).toBeLessThan(0.005);
    }
  });

  it('burns more when heavier, and less as fuel is used', () => {
    const m = model(C17);
    const light = cruiseBurn(m, 30000, 0, 500);
    const heavy = cruiseBurn(m, 30000, 60000, 500);
    expect(heavy).toBeGreaterThan(light * 1.25);

    const firstHalf = cruiseBurn(m, 60000, 0, 1000);
    const secondHalf = cruiseBurn(m, 60000 - firstHalf, 0, 1000);
    expect(secondHalf).toBeLessThan(firstHalf);
  });

  it('burns more away from the cruise altitude and cruise speed', () => {
    const m = model(C17);
    const optimum = cruiseBurn(m, 40000, 20000, 500);
    expect(cruiseBurn(m, 40000, 20000, 500, 3000)).toBeGreaterThan(optimum * 1.2);
    expect(
      cruiseBurn(m, 40000, 20000, 500, m.cruiseAltitudeM, m.cruiseSpeedKmh * 0.7),
    ).toBeGreaterThan(optimum * 1.1);
    expect(altitudeFuelFactor(m, m.cruiseAltitudeM)).toBe(1);
    expect(altitudeFuelFactor(m, 0)).toBeCloseTo(
      1 + FLIGHT_ASSUMPTIONS.offOptimum.altitudePenaltyAtSeaLevel,
      9,
    );
    expect(speedFuelFactor(m, m.cruiseSpeedKmh)).toBe(1);
  });

  it('differs between aircraft types', () => {
    const typhoon = cruiseBurn(model(TYPHOON), 5000, 0, 500);
    const c17 = cruiseBurn(model(C17), 50000, 0, 500);
    expect(c17).toBeGreaterThan(typhoon * 4);
  });

  it('charges the energy of a climb', () => {
    const m = model(C17);
    const profile = flightProfile(m, plan(m, PRESTWICK, AKROTIRI), 20000);
    let progress = initialProgress(profile, 60000);
    let cruiseReachedAt: FlightProgress | null = null;
    while (!cruiseReachedAt) {
      progress = advanceFlight(profile, progress, 1);
      if (progress.phase === 'cruise') cruiseReachedAt = progress;
    }
    const climbFuel = 60000 - cruiseReachedAt.fuelKg;
    const potentialEnergyFuel =
      ((m.emptyMassKg + 20000 + 60000) * 9.80665 * (m.cruiseAltitudeM - PRESTWICK.elevationM)) /
      FLIGHT_ASSUMPTIONS.propulsion.joulesPerKgFuel;
    // At least the potential energy; the rest is speed gained and distance covered while climbing.
    expect(climbFuel).toBeGreaterThan(potentialEnergyFuel * 0.95);
    expect(climbFuel).toBeLessThan(potentialEnergyFuel * 4);
  });
});

describe('flight profile', () => {
  function fly(type: TypeCharacteristics, ...points: RoutePoint[]) {
    const m = model(type);
    const profile = flightProfile(m, plan(m, ...points), 0);
    const samples: FlightProgress[] = [];
    let progress = initialProgress(profile, m.fuelCapacityKg);
    for (let i = 0; i < 200_000 && progress.phase !== 'landed'; i++) {
      progress = advanceFlight(profile, progress, 1);
      samples.push(progress);
    }
    return { m, profile, samples, end: progress };
  }

  it('goes through take-off, climb, cruise, descent and landing in order', () => {
    const { samples, profile, end } = fly(C17, PRESTWICK, AKROTIRI);
    const order: FlightPhase[] = [];
    for (const sample of samples) {
      if (order.at(-1) !== sample.phase) order.push(sample.phase);
    }
    expect(order).toEqual(['takeoff', 'climb', 'cruise', 'descent', 'landed']);
    expect(end.distanceM).toBeCloseTo(profile.totalDistanceM, 3);
    expect(end.altitudeM).toBe(AKROTIRI.elevationM);
    expect(end.speedKmh).toBe(0);
    expect(end.burnRateKgH).toBe(0);
  });

  it('never moves backwards, never gains fuel, and stays within its limits', () => {
    const { samples, m } = fly(TYPHOON, PRESTWICK, NEWQUAY);
    let previous = samples[0] as FlightProgress;
    for (const sample of samples.slice(1)) {
      expect(sample.distanceM).toBeGreaterThanOrEqual(previous.distanceM);
      expect(sample.fuelKg).toBeLessThanOrEqual(previous.fuelKg);
      expect(sample.altitudeM).toBeLessThanOrEqual(m.cruiseAltitudeM + 1e-6);
      expect(sample.speedKmh).toBeLessThanOrEqual(m.cruiseSpeedKmh + 1e-6);
      expect(sample.elapsedS).toBe(previous.elapsedS + 1);
      previous = sample;
    }
  });

  it('limits speed changes to the assumed acceleration', () => {
    const { samples, m } = fly(C17, PRESTWICK, AKROTIRI);
    let previousSpeed = 0;
    for (const sample of samples.slice(0, -1)) {
      expect(Math.abs(sample.speedKmh - previousSpeed)).toBeLessThanOrEqual(
        m.accelerationMs2 * 3.6 + 1e-9,
      );
      previousSpeed = sample.speedKmh;
    }
  });

  it('starts its descent on a 3 degree path to the destination', () => {
    const { samples, profile, m } = fly(C17, PRESTWICK, AKROTIRI);
    const top = samples.find((sample) => sample.phase === 'descent') as FlightProgress;
    const remaining = profile.totalDistanceM - top.distanceM;
    const expected = (m.cruiseAltitudeM - AKROTIRI.elevationM) / Math.tan((3 * Math.PI) / 180);
    expect(Math.abs(remaining - expected)).toBeLessThan(500);
  });

  it('turns to descend before reaching cruise altitude on a route too short to get there', () => {
    const { samples, m, end } = fly(C17, PRESTWICK, NEARBY);
    expect(end.phase).toBe('landed');
    expect(end.topAltitudeM).toBeLessThan(m.cruiseAltitudeM);
    expect(samples.some((sample) => sample.phase === 'cruise')).toBe(false);
  });

  it('lets a rotorcraft climb from a standstill', () => {
    const m = model(MERLIN);
    const profile = flightProfile(m, plan(m, PRESTWICK, NEWQUAY), 0);
    const first = advanceFlight(profile, initialProgress(profile, m.fuelCapacityKg), 1);
    expect(first.phase).toBe('climb');
    expect(first.altitudeM).toBeGreaterThan(PRESTWICK.elevationM);
  });

  it('climbs more slowly near the ceiling', () => {
    const { samples } = fly(C17, PRESTWICK, AKROTIRI);
    const climb = samples.filter((sample) => sample.phase === 'climb');
    const early = (climb[20]?.altitudeM ?? 0) - (climb[19]?.altitudeM ?? 0);
    const late = (climb.at(-2)?.altitudeM ?? 0) - (climb.at(-3)?.altitudeM ?? 0);
    expect(late).toBeLessThan(early);
  });

  it('stops in flight when the fuel runs out', () => {
    const m = model(TYPHOON);
    const profile = flightProfile(m, plan(m, PRESTWICK, AKROTIRI), 0);
    const end = flyToCompletion(profile, 1500, 1);
    expect(end.fuelExhausted).toBe(true);
    expect(end.fuelKg).toBe(0);
    expect(end.distanceM).toBeLessThan(profile.totalDistanceM);
    expect(advanceFlight(profile, end, 1).distanceM).toBe(end.distanceM);
  });

  it('is helped by a tailwind and hindered by a headwind', () => {
    const m = model(C17);
    const profile = flightProfile(m, plan(m, PRESTWICK, AKROTIRI), 0);
    const still = flyToCompletion(profile, 60000, 1);
    const inWind = (tailwindKmh: number) =>
      flyToCompletion(profile, 60000, 1, (progress) =>
        advanceFlight(profile, progress, 1, { ...STILL_AIR, tailwindKmh }),
      );
    const tailwind = inWind(80);
    const headwind = inWind(-80);
    expect(tailwind.elapsedS).toBeLessThan(still.elapsedS);
    expect(headwind.elapsedS).toBeGreaterThan(still.elapsedS);
  });

  it('is deterministic', () => {
    const m = model(C17);
    const profile = flightProfile(m, plan(m, PRESTWICK, AKROTIRI), 10000);
    expect(flyToCompletion(profile, 60000, 1)).toEqual(flyToCompletion(profile, 60000, 1));
  });
});

describe('evaluatePlan', () => {
  const codes = (evaluation: ReturnType<typeof evaluatePlan>, severity: string) =>
    evaluation.constraints.filter((c) => c.severity === severity).map((c) => c.code);

  it('estimates a flyable plan', () => {
    const m = model(C17);
    const evaluation = evaluatePlan(m, plan(m, PRESTWICK, AKROTIRI), {
      fuelKg: 60000,
      payloadKg: 20000,
    });
    expect(evaluation.flyable).toBe(true);
    expect(codes(evaluation, 'block')).toEqual([]);
    const estimate = evaluation.estimate;
    expect(estimate?.completes).toBe(true);
    expect(estimate?.distanceM).toBeCloseTo(greatCircleDistance(PRESTWICK, AKROTIRI), 3);
    expect(estimate?.takeoffMassKg).toBe(128140 + 60000 + 20000);
    expect((estimate?.fuelUsedKg ?? 0) + (estimate?.fuelAtDestinationKg ?? 0)).toBeCloseTo(
      60000,
      6,
    );
    // About 3,700 km at 833 km/h cruise: between four and six hours.
    expect(estimate?.durationS).toBeGreaterThan(4 * 3600);
    expect(estimate?.durationS).toBeLessThan(6 * 3600);
  });

  it('matches the stepwise flight exactly', () => {
    const m = model(TYPHOON);
    const p = plan(m, PRESTWICK, NEWQUAY);
    const end = flyToCompletion(flightProfile(m, p, 500), 4000, 1);
    const estimate = evaluatePlan(m, p, { fuelKg: 4000, payloadKg: 500 }).estimate;
    expect(estimate?.durationS).toBe(end.elapsedS);
    expect(estimate?.fuelAtDestinationKg).toBe(end.fuelKg);
  });

  it('blocks what cannot be flown', () => {
    const m = model(TYPHOON);
    const base = plan(m, PRESTWICK, NEWQUAY);
    const load = { fuelKg: 4000, payloadKg: 0 };

    expect(codes(evaluatePlan(m, { ...base, cruiseAltitudeM: 17000 }, load), 'block')).toEqual([
      'above_service_ceiling',
    ]);
    expect(codes(evaluatePlan(m, { ...base, cruiseSpeedKmh: 2600 }, load), 'block')).toEqual([
      'above_maximum_speed',
    ]);
    expect(codes(evaluatePlan(m, { ...base, cruiseAltitudeM: 150 }, load), 'block')).toEqual([
      'altitude_below_terrain',
    ]);
    expect(codes(evaluatePlan(m, base, { fuelKg: 6250, payloadKg: 7000 }), 'block')).toEqual([
      'over_maximum_mass',
    ]);
    expect(codes(evaluatePlan(m, base, { fuelKg: 7000, payloadKg: 0 }), 'block')).toEqual([
      'fuel_over_capacity',
    ]);
    expect(codes(evaluatePlan(m, { ...base, points: [PRESTWICK] }, load), 'block')).toEqual([
      'invalid_route',
    ]);
    expect(codes(evaluatePlan(m, base, { fuelKg: Number.NaN, payloadKg: 0 }), 'block')).toContain(
      'invalid_number',
    );
    expect(evaluatePlan(m, { ...base, cruiseAltitudeM: 17000 }, load)).toMatchObject({
      estimate: null,
      flyable: false,
    });
  });

  it('blocks a route the fuel on board cannot complete, and says how far it gets', () => {
    const m = model(TYPHOON);
    const evaluation = evaluatePlan(m, plan(m, PRESTWICK, JFK), { fuelKg: 6250, payloadKg: 0 });
    expect(codes(evaluation, 'block')).toEqual(['insufficient_fuel']);
    expect(evaluation.estimate?.completes).toBe(false);
    expect(evaluation.estimate?.reachedM).toBeLessThan(evaluation.estimate?.distanceM ?? 0);
    expect(evaluation.flyable).toBe(false);
  });

  it('allows a flight that arrives below reserve, with a warning', () => {
    const m = model(TYPHOON);
    const p = plan(m, PRESTWICK, NEWQUAY);
    const needed = (suggestedFuelKg(m, p, 0) ?? 0) - m.reserveFuelKg + 60;
    const evaluation = evaluatePlan(m, p, { fuelKg: needed, payloadKg: 0 });
    expect(evaluation.flyable).toBe(true);
    expect(codes(evaluation, 'warning')).toEqual(['below_reserve']);
  });

  it('allows poor choices and notes their cost', () => {
    const m = model(C17);
    const base = plan(m, PRESTWICK, AKROTIRI);
    const load = { fuelKg: 68000, payloadKg: 0 };
    const good = evaluatePlan(m, base, load);
    const low = evaluatePlan(m, { ...base, cruiseAltitudeM: 3000 }, load);
    const fast = evaluatePlan(m, { ...base, cruiseSpeedKmh: 1000 }, load);

    expect(low.flyable).toBe(true);
    expect(codes(low, 'note')).toContain('low_cruise_altitude');
    expect(low.estimate?.fuelUsedKg).toBeGreaterThan((good.estimate?.fuelUsedKg ?? 0) * 1.15);
    // No sourced maximum speed for this type: it cannot be blocked, only warned about.
    expect(codes(fast, 'warning')).toEqual(['speed_unchecked']);
    expect(fast.estimate?.durationS).toBeLessThan(good.estimate?.durationS ?? 0);
  });

  it('notes a route too short to reach the cruise altitude', () => {
    const m = model(C17);
    const evaluation = evaluatePlan(m, plan(m, PRESTWICK, NEARBY), { fuelKg: 20000, payloadKg: 0 });
    expect(codes(evaluation, 'note')).toContain('cruise_altitude_not_reached');
    expect(evaluation.flyable).toBe(true);
  });

  it('says when a limit cannot be checked because no source gives it', () => {
    const m = model({ ...MERLIN, serviceCeilingM: null });
    const evaluation = evaluatePlan(m, plan(m, PRESTWICK, NEARBY), { fuelKg: 1000, payloadKg: 0 });
    expect(codes(evaluation, 'note')).toContain('ceiling_unknown');
  });

  it('recalculates when a waypoint is added', () => {
    const m = model(C17);
    const direct = evaluatePlan(m, plan(m, PRESTWICK, AKROTIRI), { fuelKg: 68000, payloadKg: 0 });
    const viaNewquay = evaluatePlan(
      m,
      plan(m, PRESTWICK, { ...NEWQUAY, kind: 'waypoint' }, AKROTIRI),
      {
        fuelKg: 68000,
        payloadKg: 0,
      },
    );
    expect(viaNewquay.estimate?.distanceM).toBeGreaterThan(direct.estimate?.distanceM ?? 0);
    expect(viaNewquay.estimate?.durationS).toBeGreaterThan(direct.estimate?.durationS ?? 0);
    expect(viaNewquay.estimate?.fuelUsedKg).toBeGreaterThan(direct.estimate?.fuelUsedKg ?? 0);
    expect(viaNewquay.estimate?.legs).toHaveLength(2);
  });
});

describe('plan helpers', () => {
  it('suggests fuel that arrives with the reserve and no more than needed', () => {
    const m = model(C17);
    const p = plan(m, PRESTWICK, AKROTIRI);
    const fuel = suggestedFuelKg(m, p, 20000) as number;
    const evaluation = evaluatePlan(m, p, { fuelKg: fuel, payloadKg: 20000 });
    expect(evaluation.flyable).toBe(true);
    expect(evaluation.constraints.some((c) => c.code === 'below_reserve')).toBe(false);
    expect((evaluation.estimate?.fuelAtDestinationKg ?? 0) - m.reserveFuelKg).toBeLessThan(40);
    expect(fuel).toBeLessThan(m.fuelCapacityKg);
  });

  it('suggests nothing for a route that cannot be completed on full fuel', () => {
    const m = model(TYPHOON);
    expect(suggestedFuelKg(m, plan(m, PRESTWICK, JFK), 0)).toBeNull();
  });

  it('respects maximum mass when payload leaves no room for full fuel', () => {
    const m = model(C17);
    const fuel = suggestedFuelKg(m, plan(m, PRESTWICK, NEARBY), m.maxPayloadKg - 10000) as number;
    expect(fuel).toBeLessThanOrEqual(10000);
  });

  it('generates a direct plan at the model cruise altitude and speed', () => {
    const m = model(C17);
    const generated = generatePlan(m, PRESTWICK, JFK);
    expect(generated.cruiseAltitudeM).toBe(m.cruiseAltitudeM);
    expect(generated.cruiseSpeedKmh).toBe(833);
    expect(generated.points[0]).toBe(PRESTWICK);
    expect(generated.points.at(-1)).toBe(JFK);
    expect(generated.points.length).toBe(5);
  });
});

import { describe, expect, it } from 'vitest';
import {
  advanceInWeather,
  holdDecision,
  type ClosureWindow,
  type WeatherContext,
} from '../environment/flight-weather';
import { weatherModel } from '../environment/weather';
import { NO_HAZARDS, type Hazards } from '../event/events';
import { greatCircleDistance } from '../geo';
import { evaluateObjective, newObjectives, type ObjectiveContext } from '../mission/objectives';
import type { ObjectiveSpec } from '../mission/types';
import { FLIGHT_ASSUMPTIONS, derivePerformance, type PerformanceModel } from './performance';
import { flightProfile, generatePlan, type FlightPlan } from './plan';
import { advanceFlight, descentDue, flyOn, initialProgress, type FlightProgress } from './profile';
import {
  closuresOf,
  evaluateRevision,
  progressAfterRevision,
  projectFlight,
  remainingPoints,
  reviseRoute,
  sameRemainder,
  type FlightSituation,
} from './revision';
import { positionAlong, routeGeometry, type RoutePoint } from './route';

const EPOCH = Date.UTC(2026, 9, 4, 12, 0, 0);
const WEATHER = weatherModel('revision-test', EPOCH);
const DEPARTED = 5000;

function performance(): PerformanceModel {
  const result = derivePerformance({
    category: 'transport',
    engineType: 'turbofan',
    emptyMassKg: 78600,
    maxTakeoffMassKg: 141000,
    cruiseSpeedKmh: 781,
    maxSpeedKmh: null,
    rangeKm: 3300,
    ferryRangeKm: null,
    serviceCeilingM: 12200,
  });
  if (!result.available) throw new Error('unavailable');
  return result.model;
}
const MODEL = performance();
const aerodrome = (code: string, lat: number, lon: number, elevationM = 30): RoutePoint => ({
  kind: 'aerodrome',
  name: code,
  code,
  refId: `test:${code}`,
  lat,
  lon,
  elevationM,
});
const NEWQUAY = aerodrome('EGHQ', 50.4406, -4.9954);
const AKROTIRI = aerodrome('LCRA', 34.5904, 32.9879);
const ROME = aerodrome('LIRF', 41.8003, 12.2389);
const MALTA = aerodrome('LMML', 35.8575, 14.4775);
const waypoint = (name: string, lat: number, lon: number): RoutePoint => ({
  kind: 'waypoint',
  name,
  lat,
  lon,
  elevationM: 0,
});

/** Newquay to Akrotiri, about 3,500 km, with the planner's waypoints along it. */
const PLAN = generatePlan(MODEL, NEWQUAY, AKROTIRI);
const FUEL = 40_000;
const PAYLOAD = 5000;

function world(plan: FlightPlan, closures: readonly ClosureWindow[] = []): WeatherContext {
  return { weather: WEATHER, route: routeGeometry(plan.points), departureTick: DEPARTED, closures };
}

/** Flies a plan step by step, as the simulation does, until `until` says stop or it lands. */
function fly(
  plan: FlightPlan,
  start: FlightProgress,
  until: (progress: FlightProgress) => boolean = () => false,
  closures: readonly ClosureWindow[] = [],
): FlightProgress {
  const profile = flightProfile(MODEL, plan, PAYLOAD);
  const context = world(plan, closures);
  let progress = start;
  for (let i = 0; i < 200_000; i++) {
    if (progress.phase === 'landed' || progress.fuelExhausted || until(progress)) break;
    progress = advanceInWeather(profile, progress, 1, context);
  }
  return progress;
}
const launch = (plan = PLAN, fuelKg = FUEL) =>
  initialProgress(flightProfile(MODEL, plan, PAYLOAD), fuelKg);
/** The flight an hour and a half out, in the cruise. */
const cruising = () => fly(PLAN, launch(), (progress) => progress.elapsedS >= 5400);
const situation = (progress: FlightProgress, plan = PLAN): FlightSituation => ({
  plan,
  progress,
  payloadKg: PAYLOAD,
  departedTick: DEPARTED,
});
const CONTEXT = { weather: WEATHER, hazards: NO_HAZARDS };

describe('revising a route', () => {
  const progress = cruising();
  const before = positionAlong(routeGeometry(PLAN.points), progress.distanceM);

  it('keeps what has been flown, marks where the route changed, and appends the new remainder', () => {
    const passed = PLAN.points.slice(0, before.legIndex + 1);
    expect(passed.length).toBeGreaterThanOrEqual(1);
    const revised = reviseRoute(PLAN, progress.distanceM, [ROME], 'Diverted here');

    expect(revised.plan.points.slice(0, passed.length)).toEqual(passed);
    expect(revised.plan.points[passed.length]).toEqual({
      kind: 'waypoint',
      name: 'Diverted here',
      lat: before.lat,
      lon: before.lon,
      elevationM: 0,
    });
    expect(revised.plan.points.slice(passed.length + 1)).toEqual([ROME]);
    expect(revised.replaced).toEqual(PLAN.points.slice(before.legIndex + 1));
    expect(revised.position).toEqual(revised.plan.points[passed.length]);
    // Altitude and speed are the flight's own; a revision changes the route only.
    expect(revised.plan.cruiseAltitudeM).toBe(PLAN.cruiseAltitudeM);
    expect(revised.plan.cruiseSpeedKmh).toBe(PLAN.cruiseSpeedKmh);
  });

  it('leaves the aircraft exactly where it was, on the new route', () => {
    const revised = reviseRoute(PLAN, progress.distanceM, [ROME], 'here');
    const route = routeGeometry(revised.plan.points);
    const after = positionAlong(route, revised.distanceM);
    expect(greatCircleDistance(after, before)).toBeLessThan(0.001);
    // Distance flown is the length of the flown prefix, measured on the route as it now is.
    expect(revised.distanceM).toBeCloseTo(progress.distanceM, 3);
    const marker = revised.plan.points.findIndex((point) => point.name === 'here');
    expect(route.legs[marker]?.startM).toBe(revised.distanceM);
  });

  it('never rewrites the flown prefix, however many times the route changes', () => {
    const first = reviseRoute(PLAN, progress.distanceM, [ROME], 'first');
    const later = fly(
      first.plan,
      progressAfterRevision(progress, first.distanceM),
      (p) => p.elapsedS >= progress.elapsedS + 1200,
    );
    const second = reviseRoute(first.plan, later.distanceM, [MALTA], 'second');
    const names = second.plan.points.map((point) => point.name);
    expect(names.slice(-3)).toEqual(['first', 'second', 'LMML']);
    const flown = first.plan.points.slice(0, first.plan.points.length - 1);
    expect(second.plan.points.slice(0, flown.length)).toEqual(flown);
    expect(second.replaced).toEqual([ROME]);
    expect(second.distanceM).toBeGreaterThan(first.distanceM);
  });

  it('adds no marker when the aircraft is exactly at a point it has passed', () => {
    const route = routeGeometry(PLAN.points);
    const atWaypoint = route.legs[1]?.startM ?? 0;
    const revised = reviseRoute(PLAN, atWaypoint, [ROME], 'here');
    expect(revised.plan.points.map((point) => point.name)).not.toContain('here');
    expect(revised.plan.points.at(-2)).toEqual(PLAN.points[1]);
    expect(revised.distanceM).toBe(atWaypoint);
  });

  it('knows which points are still to come', () => {
    const remaining = remainingPoints(PLAN, progress.distanceM);
    expect(remaining.at(-1)).toEqual(AKROTIRI);
    expect(remaining).toEqual(PLAN.points.slice(before.legIndex + 1));
    expect(remainingPoints(PLAN, 0)).toEqual(PLAN.points.slice(1));
    expect(sameRemainder(PLAN, progress.distanceM, remaining)).toBe(true);
    expect(sameRemainder(PLAN, progress.distanceM, [ROME])).toBe(false);
    expect(sameRemainder(PLAN, progress.distanceM, remaining.slice(1))).toBe(false);
  });
});

describe('the planner and the simulation after a revision', () => {
  const progress = cruising();

  it('projects the flight as it stands to exactly what it then does', () => {
    const projection = projectFlight(MODEL, situation(progress), CONTEXT);
    const end = fly(PLAN, progress);
    expect(end.phase).toBe('landed');
    expect(projection.arrivalTick).toBe(DEPARTED + end.elapsedS);
    expect(projection.landingFuelKg).toBe(end.fuelKg);
    expect(projection.remainingS).toBe(end.elapsedS - progress.elapsedS);
    expect(projection.fuelToGoKg).toBe(progress.fuelKg - end.fuelKg);
    expect(projection.destination).toEqual(AKROTIRI);
    expect(projection).toMatchObject({ completes: true, shortM: 0, holdS: 0 });
    // And the same as a flight that was never interrupted to be asked.
    expect(end).toEqual(fly(PLAN, launch()));
  });

  it('estimates a diversion to exactly what the diverted flight then does', () => {
    const evaluation = evaluateRevision(MODEL, situation(progress), [ROME], CONTEXT);
    expect(evaluation.flyable).toBe(true);
    expect(evaluation.unchanged).toBe(false);
    if (!evaluation.revised || !evaluation.progress || !evaluation.projection) {
      throw new Error('no estimate');
    }
    // The simulation applies the same revision and flies on with its ordinary step.
    const end = fly(evaluation.revised.plan, evaluation.progress);
    expect(end.phase).toBe('landed');
    expect(evaluation.projection.arrivalTick).toBe(DEPARTED + end.elapsedS);
    expect(evaluation.projection.landingFuelKg).toBe(end.fuelKg);
    expect(evaluation.projection.destination).toEqual(ROME);
    expect(end.distanceM).toBeCloseTo(routeGeometry(evaluation.revised.plan.points).totalM, 6);
    // Rome is nearer than Akrotiri: it lands sooner, with more fuel.
    const asPlanned = fly(PLAN, progress);
    expect(end.elapsedS).toBeLessThan(asPlanned.elapsedS);
    expect(end.fuelKg).toBeGreaterThan(asPlanned.fuelKg);
  });

  it('estimates a reroute through added waypoints, and a return to base, the same way', () => {
    const around = [waypoint('North of track', 47, 12), waypoint('East', 40, 24), AKROTIRI];
    const back = [NEWQUAY];
    for (const remainder of [around, back]) {
      const evaluation = evaluateRevision(MODEL, situation(progress), remainder, CONTEXT);
      if (!evaluation.revised || !evaluation.progress || !evaluation.projection) {
        throw new Error('no estimate');
      }
      const end = fly(evaluation.revised.plan, evaluation.progress);
      expect(end.phase).toBe('landed');
      expect(evaluation.projection.arrivalTick).toBe(DEPARTED + end.elapsedS);
      expect(evaluation.projection.landingFuelKg).toBe(end.fuelKg);
      expect(evaluation.projection.destination).toEqual(remainder.at(-1));
    }
    // The longer way round costs more than the way planned.
    const longer = evaluateRevision(MODEL, situation(progress), around, CONTEXT).projection;
    const planned = projectFlight(MODEL, situation(progress), CONTEXT);
    expect(longer?.remainingM).toBeGreaterThan(planned.remainingM);
    expect(longer?.landingFuelKg).toBeLessThan(planned.landingFuelKg);
    expect(longer?.arrivalTick).toBeGreaterThan(planned.arrivalTick);
  });

  it('recognises a revision to the route already being flown, which changes nothing', () => {
    const remainder = remainingPoints(PLAN, progress.distanceM);
    const evaluation = evaluateRevision(MODEL, situation(progress), remainder, CONTEXT);
    expect(evaluation.unchanged).toBe(true);
    expect(evaluation.flyable).toBe(true);
    expect(evaluation.constraints.map((constraint) => constraint.code)).toContain('unchanged');
    // The simulation makes no change for it, so the outcome is the planned one, bit for bit.
    // Were it applied all the same, marking the present position on the same great circle moves
    // the outcome by less than a second and a kilogram: the route is the same route.
    if (!evaluation.revised || !evaluation.progress) throw new Error('no estimate');
    const marked = fly(evaluation.revised.plan, evaluation.progress);
    const planned = fly(PLAN, progress);
    expect(Math.abs(marked.elapsedS - planned.elapsedS)).toBeLessThanOrEqual(1);
    expect(Math.abs(marked.fuelKg - planned.fuelKg)).toBeLessThan(1);
    expect(
      Math.abs(
        routeGeometry(evaluation.revised.plan.points).totalM - routeGeometry(PLAN.points).totalM,
      ),
    ).toBeLessThan(0.01);
  });

  it('is deterministic', () => {
    const once = evaluateRevision(MODEL, situation(progress), [ROME], CONTEXT);
    expect(evaluateRevision(MODEL, situation(cruising()), [ROME], CONTEXT)).toEqual(once);
  });
});

describe('what a revision may not do', () => {
  const progress = cruising();
  const codes = (evaluation: ReturnType<typeof evaluateRevision>) =>
    evaluation.constraints
      .filter((constraint) => constraint.severity === 'block')
      .map((constraint) => constraint.code);

  it('refuses a change during the take-off roll, and once the flight is over', () => {
    const rolling = fly(PLAN, launch(), (p) => p.elapsedS >= 5);
    expect(rolling.phase).toBe('takeoff');
    const early = evaluateRevision(MODEL, situation(rolling), [ROME], CONTEXT);
    expect(codes(early)).toEqual(['on_takeoff_roll']);
    expect(early.flyable).toBe(false);
    expect(early.revised).toBeNull();

    const landed = fly(PLAN, launch());
    expect(codes(evaluateRevision(MODEL, situation(landed), [ROME], CONTEXT))).toEqual([
      'flight_over',
    ]);
  });

  it('refuses a route with no destination, or one that does not end at an aerodrome', () => {
    expect(codes(evaluateRevision(MODEL, situation(progress), [], CONTEXT))).toEqual([
      'invalid_route',
    ]);
    const nowhere = evaluateRevision(
      MODEL,
      situation(progress),
      [waypoint('Open sea', 40, 10)],
      CONTEXT,
    );
    expect(codes(nowhere)).toEqual(['invalid_route']);
    expect(nowhere.constraints[0]?.message).toMatch(/end at an aerodrome/);
  });

  it('refuses somewhere too close to descend to, and says how to make it possible', () => {
    const here = positionAlong(routeGeometry(PLAN.points), progress.distanceM);
    const near = aerodrome('NEAR', here.lat + 0.3, here.lon);
    const evaluation = evaluateRevision(MODEL, situation(progress), [near], CONTEXT);
    expect(codes(evaluation)).toEqual(['too_close_to_descend']);
    expect(evaluation.constraints[0]?.message).toMatch(/Add a waypoint to lengthen the route/);
    // Doing as it says: out and back makes room for the descent.
    const lengthened = evaluateRevision(
      MODEL,
      situation(progress),
      [waypoint('Out', here.lat + 2.5, here.lon), near],
      CONTEXT,
    );
    expect(lengthened.flyable).toBe(true);
    expect(lengthened.projection?.completes).toBe(true);
  });

  it('refuses a destination the fuel will not reach, and warns of one reached below reserve', () => {
    const short = { ...progress, fuelKg: 4000 };
    const far = evaluateRevision(MODEL, situation(short), [MALTA], CONTEXT);
    expect(codes(far)).toEqual(['insufficient_fuel']);
    expect(far.projection).toMatchObject({ completes: false });
    expect(far.projection?.shortM).toBeGreaterThan(100_000);
    expect(far.constraints[0]?.message).toMatch(/Fuel runs out .* km short of LMML/);

    // Enough to arrive, not enough to arrive with the reserve.
    let fuelKg = 4000;
    let evaluation = evaluateRevision(MODEL, situation({ ...progress, fuelKg }), [ROME], CONTEXT);
    while (!evaluation.flyable) {
      fuelKg += 500;
      evaluation = evaluateRevision(MODEL, situation({ ...progress, fuelKg }), [ROME], CONTEXT);
    }
    expect(evaluation.projection?.landingFuelKg).toBeLessThan(MODEL.reserveFuelKg);
    expect(evaluation.constraints).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'below_reserve' }),
    );
  });

  it('refuses a destination higher than the aircraft is cruising', () => {
    const high = aerodrome('HIGH', 41.8, 12.2, PLAN.cruiseAltitudeM);
    expect(codes(evaluateRevision(MODEL, situation(progress), [high], CONTEXT))).toContain(
      'altitude_below_terrain',
    );
  });

  it('warns of a disrupted area on the new route, and does not forbid it', () => {
    const hazards: Hazards = {
      closures: [],
      disruptions: [
        {
          eventId: 'EVT-000009',
          type: 'navigation_disruption',
          centre: { name: 'Area near Rome', lat: ROME.lat + 0.5, lon: ROME.lon - 1 },
          radiusM: 150_000,
          severity: 0.8,
          startTick: 0,
          endTick: 10_000_000,
        },
      ],
    };
    const evaluation = evaluateRevision(MODEL, situation(progress), [ROME], {
      weather: WEATHER,
      hazards,
    });
    expect(evaluation.flyable).toBe(true);
    expect(evaluation.constraints).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'navigation_disruption' }),
    );
    expect(evaluation.projection?.disruptions).toHaveLength(1);
  });
});

describe('a revision made while descending', () => {
  it('ends the descent: the aircraft climbs again, and pays for it', () => {
    const descending = fly(PLAN, launch(), (p) => p.phase === 'descent' && p.altitudeM < 6000);
    expect(descending.phase).toBe('descent');
    const evaluation = evaluateRevision(MODEL, situation(descending), [MALTA], CONTEXT);
    expect(evaluation.flyable).toBe(true);
    if (!evaluation.revised || !evaluation.progress || !evaluation.projection) {
      throw new Error('no estimate');
    }
    expect(evaluation.progress.phase).toBe('cruise');

    const profile = flightProfile(MODEL, evaluation.revised.plan, PAYLOAD);
    const context = world(evaluation.revised.plan);
    let progress = evaluation.progress;
    const phases = new Set<string>();
    let climbFuelKg = 0;
    for (let i = 0; i < 100_000 && progress.phase !== 'landed'; i++) {
      const next = advanceInWeather(profile, progress, 1, context);
      phases.add(next.phase);
      if (next.phase === 'climb') climbFuelKg += progress.fuelKg - next.fuelKg;
      progress = next;
    }
    // Back up to the cruise, across, and down again: the ordinary phases, from the ordinary step.
    expect([...phases]).toEqual(['climb', 'cruise', 'descent', 'landed']);
    expect(progress.topAltitudeM).toBeCloseTo(PLAN.cruiseAltitudeM, 0);
    expect(climbFuelKg).toBeGreaterThan(100);
    expect(evaluation.projection.landingFuelKg).toBe(progress.fuelKg);
    expect(evaluation.projection.arrivalTick).toBe(DEPARTED + progress.elapsedS);
  });
});

describe('holding', () => {
  const profile = flightProfile(MODEL, PLAN, PAYLOAD);
  const progress = cruising();
  const holding: FlightProgress = {
    ...progress,
    hold: { reason: 'operator', sinceS: progress.elapsedS },
  };

  it('covers no ground, keeps its altitude, and burns fuel for the air it flies through', () => {
    let held = holding;
    for (let i = 0; i < 1800; i++) held = advanceFlight(profile, held, 1, held.environment);
    expect(held.distanceM).toBe(progress.distanceM);
    expect(held.altitudeM).toBe(progress.altitudeM);
    expect(held.phase).toBe(progress.phase);
    expect(held.elapsedS).toBe(progress.elapsedS + 1800);
    expect(held.heldS).toBe(1800);
    expect(held.speedKmh).toBeCloseTo(
      PLAN.cruiseSpeedKmh * FLIGHT_ASSUMPTIONS.hold.speedFraction,
      6,
    );
    const burned = progress.fuelKg - held.fuelKg;
    expect(burned).toBeGreaterThan(0);
    expect(held.burnRateKgH).toBeGreaterThan(0);

    // Against half an hour of cruise from the same state: the same order of fuel, from the same
    // model. Slower through the air, so less distance; off the best speed, so more per kilometre.
    let cruised = progress;
    for (let i = 0; i < 1800; i++)
      cruised = advanceFlight(profile, cruised, 1, cruised.environment);
    const cruiseBurn = progress.fuelKg - cruised.fuelKg;
    expect(burned / cruiseBurn).toBeGreaterThan(0.6);
    expect(burned / cruiseBurn).toBeLessThan(1.3);
  });

  it('is the same however it is stepped through and restored', () => {
    const straight = flyOn(holding, 1, (p) =>
      p.heldS >= 600 ? { ...p, phase: 'landed' } : advanceFlight(profile, p, 1, p.environment),
    );
    let resumed = holding;
    for (let i = 0; i < 600; i++) {
      resumed = JSON.parse(
        JSON.stringify(advanceFlight(profile, resumed, 1, resumed.environment)),
      ) as FlightProgress;
    }
    expect(straight.fuelKg).toBe(resumed.fuelKg);
  });

  it('goes on from where it stopped when the hold ends, having lost only time and fuel', () => {
    const held = fly(PLAN, holding, (p) => p.heldS >= 1200);
    const end = fly(PLAN, { ...held, hold: null });
    const direct = fly(PLAN, progress);
    expect(end.phase).toBe('landed');
    expect(end.heldS).toBe(1200);
    expect(end.elapsedS).toBeGreaterThan(direct.elapsedS + 1100);
    expect(end.fuelKg).toBeLessThan(direct.fuelKg);
    // The projection of a flight that is holding by order assumes the hold goes on to reserve.
    const projection = projectFlight(MODEL, situation(holding), CONTEXT);
    expect(projection.holdS).toBeGreaterThan(0);
  });

  it('ends by itself when fuel is down to reserve', () => {
    const low: FlightProgress = { ...holding, fuelKg: MODEL.reserveFuelKg + 50 };
    const released = fly(PLAN, low, (p) => p.hold === null);
    expect(released.hold).toBeNull();
    expect(released.fuelKg).toBeLessThanOrEqual(MODEL.reserveFuelKg);
    expect(released.fuelKg).toBeGreaterThan(MODEL.reserveFuelKg - 5);
    expect(released.closureLanding).toBe(false);
  });
});

describe('a destination closed on arrival', () => {
  const start = launch();
  const open = fly(PLAN, start);
  const atTopOfDescent = fly(PLAN, start, (p) => p.phase === 'descent');
  const topOfDescentTick = DEPARTED + atTopOfDescent.elapsedS;
  const landingTick = DEPARTED + open.elapsedS;
  const profile = flightProfile(MODEL, PLAN, PAYLOAD);

  it('makes no difference to a flight when there is no closure', () => {
    expect(fly(PLAN, start, undefined, [])).toEqual(open);
    const before = { startTick: 0, endTick: topOfDescentTick - 5000 };
    const after = { startTick: landingTick + 5000, endTick: landingTick + 9000 };
    expect(fly(PLAN, start, undefined, [before, after])).toEqual(open);
  });

  it('holds at the top of descent, and lands when the aerodrome reopens', () => {
    const closure = { startTick: topOfDescentTick - 600, endTick: topOfDescentTick + 1500 };
    const held = fly(PLAN, start, (p) => p.hold !== null, [closure]);
    expect(held.hold).toEqual({ reason: 'closure', sinceS: held.elapsedS - 1 });
    expect(held.phase).toBe('cruise');
    expect(held.altitudeM).toBeCloseTo(PLAN.cruiseAltitudeM, 0);
    // It has stopped where its descent would have begun, short of the destination.
    expect(descentDue(profile, held)).toBe(true);
    const remainingKm = (profile.totalDistanceM - held.distanceM) / 1000;
    expect(remainingKm).toBeGreaterThan(100);
    expect(remainingKm).toBeLessThan(300);

    const end = fly(PLAN, start, undefined, [closure]);
    expect(end.phase).toBe('landed');
    expect(end.closureLanding).toBe(false);
    expect(end.heldS).toBeGreaterThan(1400);
    expect(end.heldS).toBeLessThan(1600);
    expect(DEPARTED + end.elapsedS).toBeGreaterThan(closure.endTick);
    expect(end.fuelKg).toBeLessThan(open.fuelKg);
    expect(end.fuelKg).toBeGreaterThan(MODEL.reserveFuelKg);
  });

  it('is projected exactly: how long it will hold, and what it lands with', () => {
    const closure = { startTick: topOfDescentTick - 600, endTick: topOfDescentTick + 1500 };
    const hazards: Hazards = {
      closures: [{ eventId: 'EVT-000001', place: AKROTIRI, ...closure }],
      disruptions: [],
    };
    expect(closuresOf(hazards, AKROTIRI)).toEqual([closure]);
    expect(closuresOf(hazards, ROME)).toEqual([]);

    const midway = cruising();
    const projection = projectFlight(MODEL, situation(midway), { weather: WEATHER, hazards });
    const end = fly(PLAN, midway, undefined, [closure]);
    expect(projection.holdS).toBe(end.heldS);
    expect(projection.landingFuelKg).toBe(end.fuelKg);
    expect(projection.arrivalTick).toBe(DEPARTED + end.elapsedS);
    expect(projection.landsDuringClosure).toBe(false);

    // Diverting instead: no hold, and the estimate says so.
    const diverted = evaluateRevision(MODEL, situation(midway), [ROME], {
      weather: WEATHER,
      hazards,
    });
    expect(diverted.projection?.holdS).toBe(0);
    // Staying with the closed destination is allowed, with a warning that says what will happen.
    const stay = evaluateRevision(
      MODEL,
      situation(midway),
      [waypoint('Dog-leg', 38, 20), AKROTIRI],
      { weather: WEATHER, hazards },
    );
    expect(stay.flyable).toBe(true);
    expect(stay.constraints).toContainEqual(
      expect.objectContaining({ severity: 'warning', code: 'holds_for_closure' }),
    );
  });

  it('lands despite the closure once fuel is down to reserve, and the landing is marked', () => {
    const closure = { startTick: topOfDescentTick - 600, endTick: topOfDescentTick + 400_000 };
    const released = fly(PLAN, start, (p) => p.closureLanding, [closure]);
    expect(released.hold).toBeNull();
    expect(released.closureLanding).toBe(true);
    expect(released.fuelKg).toBeLessThanOrEqual(MODEL.reserveFuelKg);
    expect(released.fuelKg).toBeGreaterThan(MODEL.reserveFuelKg - 5);

    const end = fly(PLAN, start, undefined, [closure]);
    expect(end.phase).toBe('landed');
    expect(end.closureLanding).toBe(true);
    expect(end.fuelExhausted).toBe(false);
    expect(end.fuelKg).toBeGreaterThan(0);
    expect(end.fuelKg).toBeLessThan(MODEL.reserveFuelKg);
    expect(DEPARTED + end.elapsedS).toBeLessThan(closure.endTick);

    const projection = projectFlight(MODEL, situation(cruising()), {
      weather: WEATHER,
      hazards: { closures: [{ eventId: 'E', place: AKROTIRI, ...closure }], disruptions: [] },
    });
    expect(projection.landsDuringClosure).toBe(true);
    expect(projection.landingFuelKg).toBe(end.fuelKg);
  });

  it('does not hold an aircraft already at reserve: it descends, and the landing is marked', () => {
    const closure = { startTick: 0, endTick: landingTick + 100_000 };
    const low = { ...atTopOfDescent, phase: 'cruise' as const, fuelKg: MODEL.reserveFuelKg - 1 };
    const decided = holdDecision(profile, low, topOfDescentTick, [closure]);
    expect(decided.hold).toBeNull();
    expect(decided.closureLanding).toBe(true);
  });

  it('commits an aircraft that is already descending when the closure begins', () => {
    // Announced, and beginning, only after the descent has started.
    const late = { startTick: topOfDescentTick + 120, endTick: landingTick + 50_000 };
    const descending = fly(PLAN, start, (p) => p.phase === 'descent' && p.altitudeM < 8000);
    expect(holdDecision(profile, descending, DEPARTED + descending.elapsedS, [late])).toBe(
      descending,
    );
    const end = fly(PLAN, descending, undefined, [late]);
    expect(end.phase).toBe('landed');
    expect(end.heldS).toBe(0);
    expect(end.closureLanding).toBe(false);
  });

  it('holds for a closure that will begin before the descent could end', () => {
    const soon = { startTick: topOfDescentTick + 300, endTick: topOfDescentTick + 2400 };
    const end = fly(PLAN, start, undefined, [soon]);
    expect(end.heldS).toBeGreaterThan(2000);
    expect(DEPARTED + end.elapsedS).toBeGreaterThan(soon.endTick);
  });
});

describe('objectives and where the aircraft landed', () => {
  const objective = (spec: ObjectiveSpec) =>
    newObjectives([{ label: 'Objective', spec, required: true }])[0] as ReturnType<
      typeof newObjectives
    >[number];
  const context = (overrides: Partial<ObjectiveContext>): ObjectiveContext => ({
    tick: 9000,
    stepS: 1,
    position: AKROTIRI,
    distanceM: 3_500_000,
    totalM: 3_500_000,
    ended: true,
    landed: true,
    landedAt: AKROTIRI,
    fuelKg: 9000,
    reserveFuelKg: 5000,
    payloadKg: 5000,
    origin: NEWQUAY,
    destination: AKROTIRI,
    conditionPct: 95,
    ...overrides,
  });
  const atRome = context({ landedAt: ROME, position: ROME });
  const elsewhere = 'Landed at LIRF, not at LCRA.';

  it('meets a destination objective only by landing at the destination', () => {
    for (const spec of [
      { kind: 'complete_flight' },
      { kind: 'deliver_payload', massKg: 5000 },
      { kind: 'arrive_by', byTick: 10_000 },
    ] as ObjectiveSpec[]) {
      expect(evaluateObjective(objective(spec), context({}))).toMatchObject({ status: 'complete' });
      expect(evaluateObjective(objective(spec), atRome)).toMatchObject({
        status: 'failed',
        remark: elsewhere,
      });
    }
  });

  it('still fails a delivery that arrived light, and a late arrival, for their own reasons', () => {
    expect(
      evaluateObjective(objective({ kind: 'deliver_payload', massKg: 8000 }), context({})).remark,
    ).toMatch(/Carried 5,000 kg of the 8,000 kg required/);
    expect(evaluateObjective(objective({ kind: 'arrive_by', byTick: 8000 }), atRome).remark).toBe(
      'Did not land before the deadline.',
    );
  });

  it('judges a return to base by where the aircraft landed', () => {
    const back = context({ landedAt: NEWQUAY, position: NEWQUAY });
    expect(evaluateObjective(objective({ kind: 'return_to_base' }), back).status).toBe('complete');
    expect(evaluateObjective(objective({ kind: 'return_to_base' }), atRome)).toMatchObject({
      status: 'failed',
      remark: 'Landed at LIRF, not at EGHQ.',
    });
    // An out-and-back mission that came back: planned to its origin, landed at its origin.
    const outAndBack = context({ destination: NEWQUAY, landedAt: NEWQUAY });
    expect(evaluateObjective(objective({ kind: 'return_to_base' }), outAndBack).status).toBe(
      'complete',
    );
    expect(evaluateObjective(objective({ kind: 'complete_flight' }), outAndBack).status).toBe(
      'complete',
    );
  });

  it('leaves objectives that are not about the destination alone', () => {
    expect(evaluateObjective(objective({ kind: 'land_with_reserve' }), atRome).status).toBe(
      'complete',
    );
    expect(
      evaluateObjective(objective({ kind: 'maintain_condition', minPct: 60 }), atRome).status,
    ).toBe('complete');
    // A point passed on the way stays passed wherever the flight ends.
    const visited = evaluateObjective(
      objective({ kind: 'visit_point', point: MALTA, radiusM: 10_000, byTick: null }),
      context({ ended: false, landed: false, landedAt: null, position: MALTA }),
    );
    expect(visited.status).toBe('complete');
    expect(evaluateObjective(visited, atRome)).toBe(visited);
  });

  it('says a flight that has not landed has not reached its destination', () => {
    const down = context({ landed: false, landedAt: null });
    expect(evaluateObjective(objective({ kind: 'complete_flight' }), down).remark).toBe(
      'The flight did not reach its destination.',
    );
  });
});

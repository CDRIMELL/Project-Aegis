import {
  MISSION_TEMPLATES,
  defaultBrief,
  generatePlan,
  greatCircleDistance,
  positionAlong,
  remainingPoints,
  routeGeometry,
  type Mission,
  type MissionBrief,
  type MissionType,
  type RoutePoint,
  type WorldEvent,
} from '@aegis/domain';
import { describe, expect, it } from 'vitest';
import { SimulationEngine, type WorldCommand } from './engine';
import { CommandRejected, MAINTENANCE, type AircraftState, type FlightState } from './fleet';
import type { LogEntry } from './log';
import { ABORTED_REMARK, defaultConfiguration } from './missions';
import { replayComparable, replayWorld } from './replay';
import { FIXTURES, fixtureOrder, fuelled, untilServiced } from './testing';
import { SIM_MODEL_VERSION } from './world';

/*
 * In-flight operational control (ADR 0026): changing a route in the air, holding, a destination
 * closed on arrival, aborting a mission, and the technical caution.
 */

const { places, models } = FIXTURES;
const TRANSPORT = 'AEGIS-TR-001';
const JET = 'AEGIS-FT-001';
const HOUR = 3600;
const ROME: RoutePoint = {
  kind: 'aerodrome',
  refId: 'fixture:lirf',
  name: 'Rome',
  code: 'LIRF',
  lat: 41.8003,
  lon: 12.2389,
  elevationM: 5,
};
const waypoint = (name: string, lat: number, lon: number): RoutePoint => ({
  kind: 'waypoint',
  name,
  lat,
  lon,
  elevationM: 0,
});
const copyOf = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function world(seed = 'inflight'): SimulationEngine {
  const engine = SimulationEngine.create({ seed, epoch: FIXTURES.epoch });
  engine.applyCommand({
    type: 'seedStarterFleet',
    aircraft: [
      fixtureOrder('fastJet', places.prestwick),
      fixtureOrder('transport', places.newquay),
    ],
  });
  return engine;
}
const aircraftOf = (engine: SimulationEngine, id = TRANSPORT): AircraftState => {
  const found = engine.snapshot().fleet.aircraft.find((aircraft) => aircraft.id === id);
  if (!found) throw new Error(`no aircraft ${id}`);
  return found;
};
const flightOf = (engine: SimulationEngine, id = 'FLT-000001'): FlightState => {
  const found = engine.snapshot().fleet.flights.find((flight) => flight.id === id);
  if (!found) throw new Error(`no flight ${id}`);
  return found;
};
const missionOf = (engine: SimulationEngine, id = 'MSN-000001'): Mission => {
  const found = engine.snapshot().missions.missions.find((mission) => mission.id === id);
  if (!found) throw new Error(`no mission ${id}`);
  return found;
};
const log = (engine: SimulationEngine): readonly LogEntry[] => engine.snapshot().log.entries;
const events = (engine: SimulationEngine, type: string) =>
  log(engine).filter((entry) => entry.type === type);

/** Newquay to Akrotiri with fuel to spare: about four and a half hours, 3,500 km. */
function launchLong(engine: SimulationEngine, fuelKg = 60_000): void {
  fuelled(engine, TRANSPORT, fuelKg);
  engine.applyCommand({
    type: 'launchFlight',
    aircraftId: TRANSPORT,
    plan: generatePlan(models.transport, places.newquay, places.akrotiri),
    load: { fuelKg, payloadKg: 0 },
  });
}
/** A world with the transport an hour and a half into its flight to Akrotiri. */
function cruising(seed?: string, fuelKg?: number): SimulationEngine {
  const engine = world(seed);
  engine.runSteps(100);
  launchLong(engine, fuelKg);
  engine.runSteps(5400);
  return engine;
}
function runUntil(
  engine: SimulationEngine,
  done: (engine: SimulationEngine) => boolean,
  limit = 400_000,
): void {
  for (let i = 0; i < limit && !done(engine); i += 20) engine.runSteps(20);
  if (!done(engine)) throw new Error('the condition was never met');
}
const landed = (engine: SimulationEngine) => flightOf(engine).status !== 'active';
const revise = (
  engine: SimulationEngine,
  intent: 'reroute' | 'divert' | 'return',
  points: readonly RoutePoint[],
) => engine.applyCommand({ type: 'reviseFlight', aircraftId: TRANSPORT, intent, points });

/** The world with a closure of an aerodrome added to its events, as if the world had drawn it. */
function withClosure(
  engine: SimulationEngine,
  place: RoutePoint,
  startTick: number,
  endTick: number,
): SimulationEngine {
  const snapshot = engine.snapshot();
  const closure: WorldEvent = {
    id: `EVT-${String(snapshot.events.nextNumber).padStart(6, '0')}`,
    type: 'aerodrome_closure',
    status: startTick <= snapshot.clock.tick ? 'active' : 'scheduled',
    source: 'generated',
    severity: 0.6,
    createdTick: snapshot.clock.tick,
    startTick,
    endTick,
    place,
    centre: null,
    radiusM: null,
    aircraftId: null,
    missionId: null,
    title: `Aerodrome closure: ${place.name}`,
    description: 'Simulated event.',
  };
  return SimulationEngine.restore({
    ...snapshot,
    events: {
      events: [...snapshot.events.events, closure],
      nextNumber: snapshot.events.nextNumber + 1,
    },
  });
}

describe('changing a route in flight', { timeout: 60_000 }, () => {
  it('diverts: the flown prefix stays, the route changes from where the aircraft is, and it lands there', () => {
    const engine = cruising();
    const before = flightOf(engine);
    const tick = engine.clock.tick;
    const here = positionAlong(routeGeometry(before.plan.points), before.progress.distanceM);

    expect(revise(engine, 'divert', [ROME])).toBe(true);
    const flight = flightOf(engine);
    expect(flight.plannedPlan).toEqual(before.plan);
    expect(flight.plan.points.at(-1)).toEqual(ROME);
    expect(flight.plan.points.at(-2)).toMatchObject({
      kind: 'waypoint',
      name: 'Diverted here',
      lat: here.lat,
      lon: here.lon,
    });
    expect(flight.plan.points.slice(0, here.legIndex + 1)).toEqual(
      before.plan.points.slice(0, here.legIndex + 1),
    );
    expect(flight.revisions).toEqual([
      {
        tick,
        intent: 'divert',
        position: flight.plan.points.at(-2),
        atDistanceM: before.progress.distanceM,
        fuelKg: before.progress.fuelKg,
        replaced: remainingPoints(before.plan, before.progress.distanceM),
      },
    ]);
    // Nothing about the aircraft itself jumped.
    expect(flight.progress).toMatchObject({
      altitudeM: before.progress.altitudeM,
      speedKmh: before.progress.speedKmh,
      fuelKg: before.progress.fuelKg,
      elapsedS: before.progress.elapsedS,
    });
    expect(flight.progress.distanceM).toBeCloseTo(before.progress.distanceM, 3);
    // The command is logged whole: what the operator chose, and nothing the engine derives.
    expect(log(engine).at(-1)).toMatchObject({
      tick,
      kind: 'command',
      type: 'reviseFlight',
      actor: 'player',
      aircraftId: TRANSPORT,
      flightId: 'FLT-000001',
      payload: { type: 'reviseFlight', aircraftId: TRANSPORT, intent: 'divert', points: [ROME] },
    });

    runUntil(engine, landed);
    expect(flightOf(engine).status).toBe('completed');
    expect(aircraftOf(engine)).toMatchObject({ location: ROME, status: 'servicing' });
    expect(events(engine, 'flightCompleted')[0]?.payload).toMatchObject({
      destination: 'LIRF',
      plannedDestination: 'LCRA',
      revisions: 1,
    });
  });

  it('lands exactly when and with what the revision projected', () => {
    const engine = cruising();
    revise(engine, 'divert', [ROME]);
    const projected = flightOf(engine);
    const view = engine.fleetView().activeFlights[0];
    runUntil(engine, landed);
    const flight = flightOf(engine);
    expect(flight.progress.elapsedS).toBe(projected.projectedDurationS);
    expect(flight.fuelAtDepartureKg - flight.progress.fuelKg).toBe(projected.projectedFuelUsedKg);
    expect(flight.arrivedTick).toBe(view?.etaTick);
    expect(flight.progress.fuelKg).toBe(view?.estimatedFuelAtDestinationKg);
    // The estimate made at launch is kept as it was, for the record.
    expect(flight.estimatedDurationS).toBeGreaterThan(flight.progress.elapsedS);
  });

  it('returns to base by the same mechanism', () => {
    const engine = cruising();
    expect(revise(engine, 'return', [places.newquay])).toBe(true);
    expect(flightOf(engine).revisions[0]?.intent).toBe('return');
    expect(flightOf(engine).plan.points.at(-2)?.name).toBe('Turned back here');
    expect(engine.fleetView().activeFlights[0]).toMatchObject({
      intent: 'return',
      plannedDestination: places.akrotiri,
    });
    runUntil(engine, landed);
    expect(aircraftOf(engine).location).toEqual(places.newquay);
  });

  it('reroutes through waypoints, and keeps every revision in order', () => {
    const engine = cruising();
    const around = [waypoint('North', 47, 12), waypoint('East', 40, 24), places.akrotiri];
    expect(revise(engine, 'reroute', around)).toBe(true);
    engine.runSteps(1800);
    const rerouted = flightOf(engine);
    const stillToCome = remainingPoints(rerouted.plan, rerouted.progress.distanceM);
    expect(revise(engine, 'divert', [ROME])).toBe(true);
    const flight = flightOf(engine);
    expect(flight.revisions.map((revision) => revision.intent)).toEqual(['reroute', 'divert']);
    // What a revision replaced is what was still to come when it was made.
    expect(flight.revisions[1]?.replaced).toEqual(stillToCome);
    expect(stillToCome.at(-1)).toEqual(places.akrotiri);
    // Each change left its mark where it was made, in the order they were made.
    const names = flight.plan.points.map((point) => point.name);
    expect(names.slice(-2)).toEqual(['Diverted here', 'Rome']);
    expect(names.indexOf('Rerouted here')).toBeGreaterThan(0);
    expect(names.indexOf('Rerouted here')).toBeLessThan(names.indexOf('Diverted here'));
    expect(flight.plannedPlan.points.at(-1)).toEqual(places.akrotiri);
    runUntil(engine, landed);
    expect(aircraftOf(engine).location).toEqual(ROME);
    // The flight's own distance is the route it flew, both changes included.
    expect(flightOf(engine).progress.distanceM).toBeCloseTo(
      routeGeometry(flightOf(engine).plan.points).totalM,
      3,
    );
  });

  it('makes no change, and records none, when asked for the route already being flown', () => {
    const engine = cruising();
    const twin = cruising();
    const flight = flightOf(engine);
    const same = remainingPoints(flight.plan, flight.progress.distanceM);
    const entries = log(engine).length;
    expect(revise(engine, 'reroute', same)).toBe(false);
    expect(log(engine)).toHaveLength(entries);
    expect(flightOf(engine)).toEqual(flight);
    // And so the flight ends exactly as one that was never asked.
    runUntil(engine, landed);
    runUntil(twin, landed);
    expect(engine.snapshot()).toEqual(twin.snapshot());
  });

  it('refuses what cannot be flown, says why, and changes nothing', () => {
    const engine = cruising();
    const before = copyOf(engine.snapshot());
    const here = engine.fleetView().activeFlights[0];
    if (!here) throw new Error('no flight');
    const near: RoutePoint = {
      ...ROME,
      name: 'Near',
      refId: 'fixture:near',
      lat: here.lat + 0.3,
      lon: here.lon,
    };
    const refused: [readonly RoutePoint[], RegExp][] = [
      [[], /needs a destination/],
      [[waypoint('Sea', 40, 10)], /must start and end at an aerodrome/],
      [[near], /descent from the present altitude needs/],
      [[{ ...ROME, lat: 95 }], /not a valid location/],
    ];
    for (const [points, reason] of refused) {
      expect(() => revise(engine, 'divert', points)).toThrow(CommandRejected);
      expect(() => revise(engine, 'divert', points)).toThrow(reason);
    }
    expect(() =>
      engine.applyCommand({
        type: 'reviseFlight',
        aircraftId: TRANSPORT,
        intent: 'teleport' as never,
        points: [ROME],
      }),
    ).toThrow(/reroute, a diversion or a return/);
    expect(() =>
      engine.applyCommand({
        type: 'reviseFlight',
        aircraftId: JET,
        intent: 'divert',
        points: [ROME],
      }),
    ).toThrow(/AEGIS-FT-001 is not airborne/);
    expect(() =>
      engine.applyCommand({
        type: 'reviseFlight',
        aircraftId: 'AEGIS-XX-999',
        intent: 'divert',
        points: [ROME],
      }),
    ).toThrow(/There is no aircraft/);
    expect(engine.snapshot()).toEqual(before);
  });

  it('refuses a change during the take-off roll', () => {
    const engine = world();
    launchLong(engine);
    engine.runSteps(3);
    const before = copyOf(engine.snapshot());
    expect(() => revise(engine, 'return', [places.newquay])).toThrow(/still on its take-off roll/);
    expect(engine.snapshot()).toEqual(before);
  });

  it('refuses a destination the fuel will not reach', () => {
    // Loaded to arrive at Akrotiri on reserve: there is none to spare for anywhere farther.
    const engine = cruising('short', 31_000);
    const far: RoutePoint = { ...ROME, name: 'Far', refId: 'fixture:far', lat: 25, lon: 55 };
    const before = copyOf(engine.snapshot());
    expect(() => revise(engine, 'divert', [far])).toThrow(/Fuel runs out .* km short of Far/);
    expect(engine.snapshot()).toEqual(before);
  });

  it('climbs again when the route is changed in the descent', () => {
    const engine = cruising();
    runUntil(engine, (e) => flightOf(e).progress.phase === 'descent');
    engine.runSteps(300);
    const low = flightOf(engine).progress.altitudeM;
    expect(revise(engine, 'divert', [ROME])).toBe(true);
    expect(flightOf(engine).progress.phase).toBe('cruise');
    engine.runSteps(600);
    expect(flightOf(engine).progress.altitudeM).toBeGreaterThan(low + 500);
    runUntil(engine, landed);
    expect(aircraftOf(engine).location).toEqual(ROME);
  });
});

describe('holding', { timeout: 60_000 }, () => {
  it('holds where it is on the operator’s order, and goes on when resumed', () => {
    const engine = cruising();
    const twin = cruising();
    const at = flightOf(engine).progress;
    expect(engine.applyCommand({ type: 'holdFlight', aircraftId: TRANSPORT })).toBe(true);
    expect(log(engine).at(-1)).toMatchObject({ type: 'holdFlight', actor: 'player' });
    expect(engine.fleetView().activeFlights[0]?.hold).toBe('operator');

    engine.runSteps(1800);
    const held = flightOf(engine).progress;
    expect(held.distanceM).toBe(at.distanceM);
    expect(held.altitudeM).toBe(at.altitudeM);
    expect(held.heldS).toBe(1800);
    expect(held.fuelKg).toBeLessThan(at.fuelKg - 1000);
    expect(aircraftOf(engine).fuelKg).toBe(held.fuelKg);

    expect(engine.applyCommand({ type: 'resumeFlight', aircraftId: TRANSPORT })).toBe(true);
    expect(flightOf(engine).progress.hold).toBeNull();
    const resumed = flightOf(engine);
    runUntil(engine, landed);
    runUntil(twin, landed);
    const flight = flightOf(engine);
    const direct = flightOf(twin);
    expect(aircraftOf(engine).location).toEqual(places.akrotiri);
    expect(flight.progress.elapsedS).toBeGreaterThan(direct.progress.elapsedS + 1700);
    expect(flight.progress.fuelKg).toBeLessThan(direct.progress.fuelKg);
    // The projection made when the hold ended is what then happened.
    expect(flight.progress.elapsedS).toBe(resumed.projectedDurationS);
    expect(events(engine, 'flightCompleted')[0]?.payload).toMatchObject({ heldS: 1800 });
    // A flight that held has no "same plan in still air" to be compared with.
    expect(flight.stillAirDurationS).toBeNull();
    expect(events(engine, 'flightCompleted')[0]?.payload).not.toHaveProperty('weatherDelayS');
  });

  it('does nothing when told to hold while holding, or to resume when not', () => {
    const engine = cruising();
    expect(engine.applyCommand({ type: 'resumeFlight', aircraftId: TRANSPORT })).toBe(false);
    engine.applyCommand({ type: 'holdFlight', aircraftId: TRANSPORT });
    const entries = log(engine).length;
    expect(engine.applyCommand({ type: 'holdFlight', aircraftId: TRANSPORT })).toBe(false);
    expect(log(engine)).toHaveLength(entries);
  });

  it('refuses a hold on the ground, on the take-off roll, in the descent, and without fuel for it', () => {
    const grounded = world();
    expect(() => grounded.applyCommand({ type: 'holdFlight', aircraftId: TRANSPORT })).toThrow(
      /is not airborne; there is no flight to hold/,
    );
    const rolling = world();
    launchLong(rolling);
    rolling.runSteps(3);
    expect(() => rolling.applyCommand({ type: 'holdFlight', aircraftId: TRANSPORT })).toThrow(
      /still on its take-off roll/,
    );
    const descending = cruising();
    runUntil(descending, (e) => flightOf(e).progress.phase === 'descent');
    const before = copyOf(descending.snapshot());
    expect(() => descending.applyCommand({ type: 'holdFlight', aircraftId: TRANSPORT })).toThrow(
      /descending to land. Divert it/,
    );
    expect(descending.snapshot()).toEqual(before);

    const low = cruising('low', 31_000);
    runUntil(low, (e) => flightOf(e).progress.fuelKg <= models.transport.reserveFuelKg);
    if (flightOf(low).progress.phase !== 'descent') {
      expect(() => low.applyCommand({ type: 'holdFlight', aircraftId: TRANSPORT })).toThrow(
        /already down to its reserve/,
      );
    }
  });

  it('ends by itself when fuel is down to reserve, and says so', () => {
    const engine = cruising('reserve', 38_000);
    engine.applyCommand({ type: 'holdFlight', aircraftId: TRANSPORT });
    runUntil(engine, (e) => flightOf(e).progress.hold === null);
    const flight = flightOf(engine);
    expect(flight.progress.fuelKg).toBeLessThanOrEqual(models.transport.reserveFuelKg);
    expect(events(engine, 'flightHoldEnded').at(-1)).toMatchObject({
      kind: 'event',
      actor: 'world',
      aircraftId: TRANSPORT,
      payload: { reason: 'fuel_at_reserve' },
    });
  });

  it('ends a hold when the route is changed', () => {
    const engine = cruising();
    engine.applyCommand({ type: 'holdFlight', aircraftId: TRANSPORT });
    engine.runSteps(600);
    revise(engine, 'divert', [ROME]);
    expect(flightOf(engine).progress.hold).toBeNull();
    runUntil(engine, landed);
    expect(aircraftOf(engine).location).toEqual(ROME);
    expect(flightOf(engine).progress.heldS).toBe(600);
  });
});

describe('a destination closed on arrival', { timeout: 60_000 }, () => {
  /** When the undisturbed flight would begin its descent, and land. */
  function timings() {
    const engine = cruising();
    runUntil(engine, (e) => flightOf(e).progress.phase === 'descent');
    const topOfDescent = engine.clock.tick;
    runUntil(engine, landed);
    return { topOfDescent, landing: engine.clock.tick, fuelKg: flightOf(engine).progress.fuelKg };
  }
  const T = timings();

  it('holds short of it, tells the operator, and lands when it reopens', () => {
    const engine = withClosure(
      cruising(),
      places.akrotiri,
      T.topOfDescent - 900,
      T.topOfDescent + 1800,
    );
    runUntil(engine, (e) => flightOf(e).progress.hold !== null);
    expect(flightOf(engine).progress.hold?.reason).toBe('closure');
    expect(engine.clock.tick).toBeGreaterThanOrEqual(T.topOfDescent - 5);
    expect(events(engine, 'flightHolding')).toHaveLength(1);
    expect(events(engine, 'flightHolding')[0]).toMatchObject({
      kind: 'event',
      actor: 'world',
      aircraftId: TRANSPORT,
      flightId: 'FLT-000001',
      payload: { reason: 'closure', at: 'Akrotiri' },
    });
    const view = engine.fleetView().activeFlights[0];
    expect(view?.hold).toBe('closure');
    // It is not the operator's hold to end: the choice is to wait, or to divert.
    expect(() => engine.applyCommand({ type: 'resumeFlight', aircraftId: TRANSPORT })).toThrow(
      /holding because Akrotiri is closed.*divert it to land elsewhere/,
    );

    runUntil(engine, landed);
    expect(aircraftOf(engine)).toMatchObject({ location: places.akrotiri, status: 'servicing' });
    expect(events(engine, 'flightHoldEnded')[0]?.payload).toMatchObject({ reason: 'reopened' });
    expect(flightOf(engine).arrivedTick).toBeGreaterThan(T.topOfDescent + 1800);
    expect(flightOf(engine).progress.fuelKg).toBeLessThan(T.fuelKg);
    expect(flightOf(engine).progress.closureLanding).toBe(false);
    // The projection made when it was released is what then happened.
    expect(flightOf(engine).progress.elapsedS).toBe(flightOf(engine).projectedDurationS);
    expect(events(engine, 'maintenanceDue')).toHaveLength(0);
  });

  it('shows the arrival the closure makes, from the step after it is known', () => {
    const plain = cruising();
    const undisturbed = plain.fleetView().activeFlights[0]?.etaTick;
    const engine = withClosure(
      cruising(),
      places.akrotiri,
      T.topOfDescent - 900,
      T.topOfDescent + 1800,
    );
    engine.runSteps(1);
    const eta = engine.fleetView().activeFlights[0]?.etaTick as number;
    expect(eta).toBeGreaterThan(undisturbed as number);
    expect(eta).toBeGreaterThan(T.topOfDescent + 1800);

    // A world saved and loaded on the way works the same figures out again, and flies the same.
    engine.runSteps(600);
    const loaded = SimulationEngine.restore(copyOf(engine.snapshot()));
    engine.runSteps(600);
    loaded.runSteps(600);
    expect(loaded.snapshot().fleet).toEqual(engine.snapshot().fleet);

    runUntil(engine, landed);
    expect(flightOf(engine).arrivedTick).toBe(eta);
    expect(flightOf(engine).projectedDurationS).toBe(flightOf(engine).progress.elapsedS);
  });

  it('can be diverted out of the hold', () => {
    const engine = withClosure(
      cruising(),
      places.akrotiri,
      T.topOfDescent - 900,
      T.landing + 40_000,
    );
    runUntil(engine, (e) => flightOf(e).progress.hold !== null);
    engine.runSteps(600);
    const cyprus: RoutePoint = {
      ...ROME,
      name: 'Larnaca',
      code: 'LCLK',
      refId: 'fixture:lclk',
      lat: 34.875,
      lon: 33.6249,
    };
    expect(revise(engine, 'divert', [cyprus])).toBe(true);
    expect(flightOf(engine).progress.hold).toBeNull();
    runUntil(engine, landed);
    expect(aircraftOf(engine)).toMatchObject({ location: cyprus, status: 'servicing' });
    expect(flightOf(engine).progress.heldS).toBeGreaterThanOrEqual(600);
    expect(events(engine, 'flightHoldEnded')).toHaveLength(0);
  });

  it('lands despite the closure when fuel is down to reserve, and is inspected for it', () => {
    const engine = withClosure(
      cruising('long-closure', 40_000),
      places.akrotiri,
      T.topOfDescent - 900,
      T.landing + 400_000,
    );
    runUntil(engine, landed);
    const flight = flightOf(engine);
    expect(flight.status).toBe('completed');
    expect(flight.progress.closureLanding).toBe(true);
    expect(flight.progress.fuelKg).toBeLessThan(models.transport.reserveFuelKg);
    expect(flight.progress.fuelKg).toBeGreaterThan(0);
    expect(events(engine, 'flightHoldEnded').at(-1)?.payload).toMatchObject({
      reason: 'landing_during_closure',
    });
    expect(events(engine, 'flightCompleted')[0]?.payload).toMatchObject({
      landedDuringClosure: true,
    });
    expect(aircraftOf(engine)).toMatchObject({
      location: places.akrotiri,
      status: 'maintenance_due',
    });
    expect(events(engine, 'maintenanceDue')[0]?.payload).toEqual({
      reason: 'Landed during a closure with fuel at reserve.',
    });
    // Nothing was lost but time and fuel: no forced landing, no failure decided for the operator.
    expect(events(engine, 'flightFuelExhausted')).toHaveLength(0);
  });

  it('does not touch a flight to somewhere else, or one that arrives outside the closure', () => {
    const elsewhere = withClosure(cruising(), ROME, 0, T.landing + 50_000);
    const early = withClosure(cruising(), places.akrotiri, 0, T.topOfDescent - 3000);
    const twin = cruising();
    for (const engine of [elsewhere, early, twin]) runUntil(engine, landed);
    expect(flightOf(elsewhere)).toEqual(flightOf(twin));
    expect(flightOf(early)).toEqual(flightOf(twin));
  });
});

describe('aborting a mission in flight', { timeout: 60_000 }, () => {
  const AREA = { name: 'Area 1', lat: 49.4, lon: -7.2 };
  const brief = (type: MissionType, overrides: Partial<MissionBrief>): MissionBrief => ({
    ...defaultBrief(MISSION_TEMPLATES[type]),
    ...overrides,
  });
  function mission(engine: SimulationEngine, type: MissionType, overrides: Partial<MissionBrief>) {
    engine.applyCommand({
      type: 'createMission',
      missionType: type,
      ...defaultConfiguration(type, brief(type, overrides), aircraftOf(engine), {
        context: engine.planContext(),
      }),
    });
    const id = `MSN-${String(engine.snapshot().missions.nextNumber - 1).padStart(6, '0')}`;
    // Accepting begins loading the mission's fuel; it launches when that is done (ADR 0027).
    engine.applyCommand({ type: 'acceptMission', missionId: id });
    untilServiced(engine, TRANSPORT);
    engine.applyCommand({ type: 'launchMission', missionId: id });
    return id;
  }
  /** A delivery to Akrotiri with fuel enough to be sent somewhere else on the way. */
  function delivery(engine: SimulationEngine): string {
    const config = defaultConfiguration(
      'logistics',
      brief('logistics', { destination: places.akrotiri, payloadKg: 5000 }),
      aircraftOf(engine),
      { context: engine.planContext() },
    );
    engine.applyCommand({
      type: 'createMission',
      missionType: 'logistics',
      ...config,
      load: { fuelKg: 60_000, payloadKg: config.load?.payloadKg ?? 5000 },
    });
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    untilServiced(engine, TRANSPORT);
    engine.applyCommand({ type: 'launchMission', missionId: 'MSN-000001' });
    return 'MSN-000001';
  }

  it('ends the mission at once, keeps what was done, fails the rest, and flies on to land', () => {
    const engine = world();
    const id = mission(engine, 'training', { target: AREA });
    // Fly until the turning point has been passed: the first objective is complete.
    runUntil(engine, (e) => missionOf(e, id).objectives[0]?.status === 'complete');
    engine.runSteps(120);
    const tick = engine.clock.tick;
    const flightBefore = flightOf(engine);

    expect(
      engine.applyCommand({ type: 'abortMission', missionId: id, landing: { intent: 'continue' } }),
    ).toBe(true);
    const aborted = missionOf(engine, id);
    expect(aborted).toMatchObject({ status: 'aborted', completedTick: tick });
    expect(aborted.objectives[0]).toMatchObject({ status: 'complete', remark: null });
    for (const objective of aborted.objectives.slice(1)) {
      expect(objective).toMatchObject({ status: 'failed', remark: ABORTED_REMARK });
    }
    expect(aborted.outcome).toMatchObject({
      result: 'aborted',
      decidedTick: tick,
      objectivesComplete: 1,
      objectivesRequired: 2,
    });
    expect(aborted.outcome?.summary).toMatch(
      /Aborted in flight with 1 of 2 required objectives met/,
    );
    expect(log(engine).at(-1)).toMatchObject({
      type: 'abortMission',
      actor: 'player',
      missionId: id,
      aircraftId: TRANSPORT,
      flightId: 'FLT-000001',
      payload: { landing: { intent: 'continue' } },
    });

    // The aircraft did not move: it is the same flight, on the same route, a tick later.
    expect(flightOf(engine)).toEqual(flightBefore);
    expect(flightOf(engine).status).toBe('active');
    runUntil(engine, landed);
    expect(aircraftOf(engine)).toMatchObject({ location: places.newquay, status: 'servicing' });
    // Landing changes nothing about a mission that was already over.
    expect(missionOf(engine, id)).toEqual(aborted);
    expect(events(engine, 'missionCompleted')).toHaveLength(0);
    expect(events(engine, 'missionFailed')).toHaveLength(0);
    // And the aircraft is free for the next one.
    const next = mission(engine, 'training', { target: AREA });
    expect(missionOf(engine, next).status).toBe('active');
  });

  it('takes the landing the operator chose: back to base, or somewhere else', () => {
    const back = world();
    delivery(back);
    back.runSteps(5400);
    back.applyCommand({
      type: 'abortMission',
      missionId: 'MSN-000001',
      landing: { intent: 'return', points: [places.newquay] },
    });
    expect(flightOf(back).revisions.map((r) => r.intent)).toEqual(['return']);
    expect(missionOf(back).outcome?.summary).toMatch(/goes on to land at Newquay/);
    // One command, one log entry: the route change is part of the abort, not a second order.
    expect(
      log(back)
        .filter((entry) => entry.kind === 'command')
        .at(-1)?.type,
    ).toBe('abortMission');
    expect(events(back, 'reviseFlight')).toHaveLength(0);
    runUntil(back, landed);
    expect(aircraftOf(back).location).toEqual(places.newquay);
    // The payload was not delivered, so it is still aboard.
    expect(aircraftOf(back).payloadKg).toBe(5000);

    const away = world();
    delivery(away);
    away.runSteps(5400);
    away.applyCommand({
      type: 'abortMission',
      missionId: 'MSN-000001',
      landing: { intent: 'divert', points: [ROME] },
    });
    runUntil(away, landed);
    expect(aircraftOf(away).location).toEqual(ROME);
    expect(missionOf(away).status).toBe('aborted');
  });

  it('is refused whole when the landing cannot be flown: the mission is still active', () => {
    const engine = world();
    delivery(engine);
    engine.runSteps(5400);
    const before = copyOf(engine.snapshot());
    expect(() =>
      engine.applyCommand({
        type: 'abortMission',
        missionId: 'MSN-000001',
        landing: { intent: 'divert', points: [waypoint('Sea', 40, 10)] },
      }),
    ).toThrow(/must start and end at an aerodrome/);
    expect(engine.snapshot()).toEqual(before);
    expect(missionOf(engine).status).toBe('active');
  });

  it('is not the way to withdraw a mission that has not launched, or one that is over', () => {
    const engine = world();
    engine.applyCommand({
      type: 'createMission',
      missionType: 'training',
      ...defaultConfiguration('training', brief('training', { target: AREA }), aircraftOf(engine), {
        context: engine.planContext(),
      }),
    });
    const abort: WorldCommand = {
      type: 'abortMission',
      missionId: 'MSN-000001',
      landing: { intent: 'continue' },
    };
    expect(() => engine.applyCommand(abort)).toThrow(/has not launched. Cancel it instead/);
    engine.applyCommand({ type: 'cancelMission', missionId: 'MSN-000001' });
    expect(missionOf(engine).status).toBe('cancelled');
    expect(() => engine.applyCommand(abort)).toThrow(/is cancelled; there is nothing to abort/);
    // And cancelling is still not possible once a mission is in flight.
    const flying = world();
    const id = mission(flying, 'training', { target: AREA });
    expect(() => flying.applyCommand({ type: 'cancelMission', missionId: id })).toThrow(
      CommandRejected,
    );
  });

  it('fails a diverted delivery by where it landed, without aborting it', () => {
    const engine = world();
    delivery(engine);
    engine.runSteps(5400);
    revise(engine, 'divert', [ROME]);
    // Diverting is not aborting: the mission goes on, and is judged when the flight ends.
    expect(missionOf(engine).status).toBe('active');
    expect(missionOf(engine).plan?.points.at(-1)).toEqual(places.akrotiri);
    runUntil(engine, landed);
    engine.runSteps(1);
    const mission1 = missionOf(engine);
    expect(mission1.status).toBe('failed');
    const failed = mission1.objectives.filter((objective) => objective.status === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    for (const objective of failed.filter((o) => o.spec.kind !== 'land_with_reserve')) {
      expect(objective.remark).toBe('Landed at Rome, not at Akrotiri.');
    }
    expect(mission1.outcome?.summary).toMatch(/Landed at Rome, not at Akrotiri\./);
    expect(aircraftOf(engine).payloadKg).toBe(5000);
    expect(aircraftOf(engine).location).toEqual(ROME);
  });
});

describe('the technical caution', { timeout: 60_000 }, () => {
  /** The world with a caution showing on the transport's flight, as the event stream sets one. */
  function withCaution(engine: SimulationEngine): SimulationEngine {
    const snapshot = engine.snapshot();
    const id = `EVT-${String(snapshot.events.nextNumber).padStart(6, '0')}`;
    const tick = snapshot.clock.tick;
    const caution: WorldEvent = {
      id,
      type: 'technical_caution',
      status: 'active',
      source: 'generated',
      severity: 0.5,
      createdTick: tick,
      startTick: tick,
      endTick: tick,
      place: null,
      centre: null,
      radiusM: null,
      aircraftId: TRANSPORT,
      missionId: null,
      title: `Technical caution: ${TRANSPORT}`,
      description: 'Simulated event.',
    };
    return SimulationEngine.restore({
      ...snapshot,
      fleet: {
        ...snapshot.fleet,
        flights: snapshot.fleet.flights.map((flight) =>
          flight.status === 'active'
            ? { ...flight, caution: { eventId: id, sinceTick: tick } }
            : flight,
        ),
      },
      events: {
        events: [...snapshot.events.events, caution],
        nextNumber: snapshot.events.nextNumber + 1,
      },
    });
  }

  it('lets the flight go on, wears the aircraft for as long as it does, and has it inspected', () => {
    const cautioned = withCaution(cruising());
    const twin = cruising();
    const since = cautioned.clock.tick;
    runUntil(cautioned, landed);
    runUntil(twin, landed);
    // The flight itself is untouched: same route, same time, same fuel.
    expect(flightOf(cautioned).progress).toEqual(flightOf(twin).progress);
    expect(aircraftOf(cautioned).location).toEqual(places.akrotiri);

    const hours = ((flightOf(cautioned).arrivedTick ?? 0) - since) / HOUR;
    const extra = aircraftOf(twin).conditionPct - aircraftOf(cautioned).conditionPct;
    expect(extra).toBeCloseTo(MAINTENANCE.cautionWearPctPerFlightHour * hours, 9);
    // The one without a caution is turned round; the one with it waits for maintenance instead.
    expect(aircraftOf(twin).status).toBe('servicing');
    expect(aircraftOf(cautioned)).toMatchObject({ status: 'maintenance_due', service: null });
    expect(events(cautioned, 'maintenanceDue')[0]?.payload).toEqual({
      reason: 'A technical caution showed in flight.',
    });
    expect(events(cautioned, 'flightCompleted')[0]?.payload).toHaveProperty('cautionEventId');
  });

  it('costs less the sooner the aircraft is landed: that is the decision', () => {
    const on = withCaution(cruising());
    const short = withCaution(cruising());
    revise(short, 'divert', [ROME]);
    runUntil(on, landed);
    runUntil(short, landed);
    expect(aircraftOf(short).conditionPct).toBeGreaterThan(aircraftOf(on).conditionPct + 2);
    // Either way it is due maintenance when it lands, and nothing was decided for the operator.
    expect(aircraftOf(short).status).toBe('maintenance_due');
    expect(aircraftOf(on).status).toBe('maintenance_due');
  });

  it('lasts until the aircraft has been maintained, and records when that was', () => {
    const engine = withCaution(cruising());
    const caution = () =>
      engine.snapshot().events.events.find((e) => e.type === 'technical_caution');
    runUntil(engine, landed);
    engine.runSteps(HOUR);
    expect(caution()?.status).toBe('active');
    engine.applyCommand({ type: 'startMaintenance', aircraftId: TRANSPORT });
    engine.runSteps(MAINTENANCE.durationSeconds + 2);
    const resolved = caution();
    expect(resolved?.status).toBe('resolved');
    expect(aircraftOf(engine).status).toBe('available');
    const entry = events(engine, 'eventResolved').at(-1);
    // The event itself records when it actually ended.
    expect(resolved?.endTick).toBe(entry?.tick);
    expect(resolved?.endTick).toBeGreaterThan(
      (resolved?.startTick ?? 0) + MAINTENANCE.durationSeconds,
    );
  });

  it('comes from the world’s seeded event stream, to an aircraft that is flying', () => {
    // Deterministic: the same seeds give the same result every time, so this finds the same
    // caution every time. Each world flies the transport back and forth while events are drawn.
    const search = (): { engine: SimulationEngine; seed: string } | null => {
      for (let n = 1; n <= 12; n++) {
        const seed = `caution-${n}`;
        const engine = world(seed);
        engine.applyCommand({
          type: 'setOperatingArea',
          places: [places.prestwick, places.newquay, places.exeter, places.akrotiri],
        });
        for (let leg = 0; leg < 12; leg++) {
          untilServiced(engine, TRANSPORT);
          const at = aircraftOf(engine);
          if (at.status !== 'available' || !at.location) break;
          fuelled(engine, TRANSPORT, 60_000);
          const to = at.location.code === 'EGHQ' ? places.akrotiri : places.newquay;
          try {
            engine.applyCommand({
              type: 'launchFlight',
              aircraftId: TRANSPORT,
              plan: generatePlan(models.transport, at.location, to),
              load: { fuelKg: 60_000, payloadKg: 0 },
            });
          } catch {
            // An aerodrome is closed: wait it out, and try again.
            engine.runSteps(3 * HOUR);
            continue;
          }
          const flightId = aircraftOf(engine).activeFlightId ?? '';
          for (let i = 0; i < 3000 && flightOf(engine, flightId).status === 'active'; i++) {
            engine.runSteps(20);
            if (flightOf(engine, flightId).caution) return { engine, seed };
          }
          engine.runSteps(2 * HOUR);
        }
      }
      return null;
    };
    const found = search();
    if (!found) throw new Error('no seed produced a technical caution');
    const { engine } = found;
    const flight = engine.snapshot().fleet.flights.find((f) => f.caution);
    const event = engine.snapshot().events.events.find((e) => e.type === 'technical_caution');
    expect(event).toMatchObject({ status: 'active', aircraftId: TRANSPORT, source: 'generated' });
    expect(flight?.caution).toEqual({ eventId: event?.id, sinceTick: event?.startTick });
    expect(flight?.progress.phase).not.toBe('takeoff');
    expect(events(engine, 'eventStarted').at(-1)).toMatchObject({
      aircraftId: TRANSPORT,
      payload: { eventId: event?.id, eventType: 'technical_caution' },
    });
    // And the whole world, caution included, is what its seed and its log produce.
    const snapshot = engine.snapshot();
    const replayed = replayWorld(
      { seed: found.seed, epoch: FIXTURES.epoch },
      snapshot.log.entries,
      snapshot.clock.tick,
    );
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(snapshot));
  }, 120_000);
});

describe('determinism, replay and upgrade', { timeout: 60_000 }, () => {
  /** A flight with a hold, a reroute, a diversion and an aborted mission, at fixed ticks. */
  function operations(
    advance: (engine: SimulationEngine, ticks: number) => SimulationEngine,
  ): SimulationEngine {
    let engine = world('operations');
    const step = (_: SimulationEngine, ticks: number) => {
      engine = advance(engine, ticks);
    };
    step(engine, 100);
    engine.applyCommand({
      type: 'createMission',
      missionType: 'logistics',
      ...defaultConfiguration(
        'logistics',
        {
          ...defaultBrief(MISSION_TEMPLATES.logistics),
          destination: places.akrotiri,
          payloadKg: 3000,
        },
        aircraftOf(engine),
        { context: engine.planContext() },
      ),
      load: { fuelKg: 60_000, payloadKg: 3000 },
    });
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    while (aircraftOf(engine).status === 'servicing') step(engine, 1);
    engine.applyCommand({ type: 'launchMission', missionId: 'MSN-000001' });
    step(engine, 3000);
    engine.applyCommand({ type: 'holdFlight', aircraftId: TRANSPORT });
    step(engine, 900);
    engine.applyCommand({ type: 'resumeFlight', aircraftId: TRANSPORT });
    step(engine, 1500);
    revise(engine, 'reroute', [waypoint('North', 47, 12), places.akrotiri]);
    step(engine, 2000);
    engine.applyCommand({
      type: 'abortMission',
      missionId: 'MSN-000001',
      landing: { intent: 'divert', points: [ROME] },
    });
    step(engine, 9000);
    return engine;
  }

  it('gives the same world whether it is stepped one tick at a time or a thousand', () => {
    const coarse = operations((engine, ticks) => {
      engine.runSteps(ticks);
      return engine;
    });
    const fine = operations((engine, ticks) => {
      for (let i = 0; i < ticks; i++) engine.runSteps(1);
      return engine;
    });
    // Nothing is lost by going through a checkpoint before every command.
    const restored = operations((engine, ticks) => {
      engine.runSteps(ticks);
      return SimulationEngine.restore(copyOf(engine.snapshot()));
    });
    expect(fine.snapshot()).toEqual(coarse.snapshot());
    expect(restored.snapshot()).toEqual(coarse.snapshot());
    expect(aircraftOf(coarse).location).toEqual(ROME);
    expect(missionOf(coarse).status).toBe('aborted');
    expect(flightOf(coarse).revisions.map((r) => r.intent)).toEqual(['reroute', 'divert']);
    expect(flightOf(coarse).progress.heldS).toBe(900);
  });

  it('re-derives a world with a hold, revisions, a diversion and an abort from its log', () => {
    const engine = operations((e, ticks) => {
      e.runSteps(ticks);
      return e;
    });
    const snapshot = engine.snapshot();
    expect(snapshot.log.entries.filter((e) => e.kind === 'command').map((e) => e.type)).toEqual([
      'seedStarterFleet',
      'createMission',
      'acceptMission',
      'launchMission',
      'holdFlight',
      'resumeFlight',
      'reviseFlight',
      'abortMission',
    ]);
    const replayed = replayWorld(
      { seed: 'operations', epoch: FIXTURES.epoch },
      snapshot.log.entries,
      snapshot.clock.tick,
    );
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(snapshot));
  });

  it('re-derives a world in which the world itself closed a destination and held a flight', () => {
    // Deterministic search: the same seeds, the same flights, the same closure every time.
    let found = null as { engine: SimulationEngine; seed: string } | null;
    for (let n = 1; n <= 30 && !found; n++) {
      const seed = `closure-${n}`;
      const engine = world(seed);
      // A small operating area, so that when the world closes an aerodrome it is often this one.
      engine.applyCommand({ type: 'setOperatingArea', places: [places.akrotiri, places.exeter] });
      for (let leg = 0; leg < 6 && !found; leg++) {
        untilServiced(engine, TRANSPORT);
        const at = aircraftOf(engine);
        if (at.status !== 'available' || !at.location) break;
        fuelled(engine, TRANSPORT, 60_000);
        const to = at.location.code === 'EGHQ' ? places.akrotiri : places.newquay;
        try {
          engine.applyCommand({
            type: 'launchFlight',
            aircraftId: TRANSPORT,
            plan: generatePlan(models.transport, at.location, to),
            load: { fuelKg: 60_000, payloadKg: 0 },
          });
        } catch {
          // The destination is already known to be closed on arrival: wait, and try again.
          engine.runSteps(3 * HOUR);
          continue;
        }
        const flightId = aircraftOf(engine).activeFlightId ?? '';
        for (let i = 0; i < 3000 && flightOf(engine, flightId).status === 'active'; i++) {
          engine.runSteps(20);
        }
        if (events(engine, 'flightHolding').length > 0) found = { engine, seed };
        else engine.runSteps(HOUR);
      }
    }
    if (!found) throw new Error('no seed closed the destination on a flight');
    const { engine, seed } = found;
    expect(events(engine, 'flightHolding')[0]?.payload).toMatchObject({ reason: 'closure' });
    expect(events(engine, 'flightHoldEnded').length).toBeGreaterThan(0);
    const snapshot = engine.snapshot();
    const replayed = replayWorld(
      { seed, epoch: FIXTURES.epoch },
      snapshot.log.entries,
      snapshot.clock.tick,
    );
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(snapshot));
  }, 180_000);

  it('upgrades a world saved in flight: the flight is as launched, and the new closure rule applies', () => {
    const T = (() => {
      const probe = cruising();
      runUntil(probe, (e) => flightOf(e).progress.phase === 'descent');
      return probe.clock.tick;
    })();
    const engine = withClosure(cruising(), places.akrotiri, T - 900, T + 1800);
    const current = copyOf(engine.snapshot());
    // As model 5 saved it: no revisions, no projection, no hold state.
    const without = (value: object, keys: readonly string[]) =>
      Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
    const snapshot = {
      ...current,
      modelVersion: 5,
      fleet: {
        ...current.fleet,
        flights: current.fleet.flights.map((flight) => ({
          ...without(flight, [
            'plannedPlan',
            'revisions',
            'caution',
            'projectedDurationS',
            'projectedFuelUsedKg',
          ]),
          progress: without(flight.progress, ['hold', 'heldS', 'closureLanding']),
        })),
      },
    };
    const savedAt = engine.clock.tick;
    const upgraded = SimulationEngine.restore(snapshot as never);
    expect(upgraded.snapshot().modelVersion).toBe(SIM_MODEL_VERSION);
    expect(SIM_MODEL_VERSION).toBe(10);
    // What was logged under the old rules is kept; replay starts at the upgrade.
    expect(upgraded.snapshot().log.completeFromTick).toBe(savedAt);
    const flight = flightOf(upgraded);
    expect(flight.plannedPlan).toEqual(flight.plan);
    expect(flight.revisions).toEqual([]);
    expect(flight.caution).toBeNull();
    expect(flight.projectedDurationS).toBe(flight.estimatedDurationS);
    expect(flight.progress).toMatchObject({ hold: null, heldS: 0, closureLanding: false });

    // The aircraft was airborne when the world was upgraded. Under model 5 it would have landed
    // at the closed aerodrome; from the upgrade it holds, and can be diverted like any other.
    runUntil(upgraded, (e) => flightOf(e).progress.hold !== null);
    expect(flightOf(upgraded).progress.hold?.reason).toBe('closure');
    expect(upgraded.clock.tick).toBeGreaterThan(savedAt);
    expect(revise(upgraded, 'divert', [ROME])).toBe(true);
    runUntil(upgraded, landed);
    expect(aircraftOf(upgraded).location).toEqual(ROME);
    // It distance-checks as a real diversion: Rome is a long way back from Cyprus.
    expect(greatCircleDistance(ROME, places.akrotiri)).toBeGreaterThan(1_500_000);
  });
});

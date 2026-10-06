import {
  derivePerformance,
  evaluatePlan,
  generatePlan,
  greatCircleDistance,
  simInstant,
  suggestedFuelKg,
  type FlightPlan,
  type PerformanceModel,
  type RoutePoint,
  type TypeCharacteristics,
} from '@aegis/domain';
import { describe, expect, it } from 'vitest';
import { SimulationEngine, WorldRestoreError } from './engine';
import { CommandRejected, MAINTENANCE, type AircraftOrder, type FleetCommand } from './fleet';
import { SimulationRunner } from './runner';
import { ManualHostClock, MemoryWorldStore, fuelled } from './testing';
import { SIM_MODEL_VERSION, type WorldSnapshot } from './world';

const EPOCH = simInstant(Date.UTC(2026, 9, 4, 12, 0, 0));

function performance(type: TypeCharacteristics): PerformanceModel {
  const result = derivePerformance(type);
  if (!result.available) throw new Error('unavailable');
  return result.model;
}

const TYPHOON = performance({
  category: 'fast_jet',
  engineType: 'turbofan',
  emptyMassKg: 11000,
  maxTakeoffMassKg: 23500,
  cruiseSpeedKmh: null,
  maxSpeedKmh: 2495,
  rangeKm: 2900,
  ferryRangeKm: 3790,
  serviceCeilingM: 16764,
});
const C17 = performance({
  category: 'transport',
  engineType: 'turbofan',
  emptyMassKg: 128140,
  maxTakeoffMassKg: 265352,
  cruiseSpeedKmh: 833,
  maxSpeedKmh: null,
  rangeKm: 4482,
  ferryRangeKm: 11538,
  serviceCeilingM: 13716,
});

const aerodrome = (
  refId: string,
  name: string,
  lat: number,
  lon: number,
  elevationM: number,
): RoutePoint => ({
  kind: 'aerodrome',
  refId,
  name,
  code: refId.toUpperCase(),
  lat,
  lon,
  elevationM,
});
const PRESTWICK = aerodrome('egpk', 'Glasgow Prestwick', 55.5094, -4.5867, 20);
const NEWQUAY = aerodrome('eghq', 'Newquay', 50.4406, -4.9954, 119);
const AKROTIRI = aerodrome('lcra', 'Akrotiri', 34.5904, 32.9879, 23);
const JFK = aerodrome('kjfk', 'JFK', 40.6394, -73.7793, 4);

const typhoonOrder = (home = PRESTWICK): AircraftOrder => ({
  typeId: 'aegis-curated:typhoon',
  typeName: 'Eurofighter Typhoon',
  category: 'fast_jet',
  performance: TYPHOON,
  performanceMissing: [],
  home,
});
const c17Order = (home = NEWQUAY): AircraftOrder => ({
  typeId: 'aegis-curated:c-17',
  typeName: 'Boeing C-17 Globemaster III',
  category: 'transport',
  performance: C17,
  performanceMissing: [],
  home,
});

const world = (seed = 'fleet-world') => SimulationEngine.create({ seed, epoch: EPOCH });
const aircraftOf = (engine: SimulationEngine, id: string) => {
  const found = engine.snapshot().fleet.aircraft.find((aircraft) => aircraft.id === id);
  if (!found) throw new Error(`no aircraft ${id}`);
  return found;
};

function launch(
  engine: SimulationEngine,
  aircraftId: string,
  model: PerformanceModel,
  from: RoutePoint,
  to: RoutePoint,
  payloadKg = 0,
) {
  const plan = generatePlan(model, from, to);
  const fuelKg = suggestedFuelKg(model, plan, payloadKg, engine.planContext());
  if (fuelKg === null) throw new Error('route not flyable');
  const load = { fuelKg, payloadKg };
  // The fuel is loaded first, which takes time (ADR 0027).
  fuelled(engine, aircraftId, fuelKg, payloadKg);
  // Estimated in the world it will be flown in: the same weather, departing at the same tick.
  const context = engine.planContext();
  const estimate = evaluatePlan(model, plan, load, context).estimate;
  engine.applyCommand({ type: 'launchFlight', aircraftId, plan, load });
  return { plan, load, estimate };
}

/** Runs until the aircraft has no active flight. Returns the number of steps taken. */
function flyOut(engine: SimulationEngine, aircraftId: string, limit = 100_000): number {
  let steps = 0;
  while (aircraftOf(engine, aircraftId).activeFlightId !== null) {
    engine.runSteps(1);
    if (++steps > limit) throw new Error('flight did not finish');
  }
  return steps;
}

describe('acquiring aircraft', () => {
  it('creates a fuelled, serviceable instance of a reference type at its home aerodrome', () => {
    const engine = world();
    expect(engine.applyCommand({ type: 'acquireAircraft', ...typhoonOrder() })).toBe(true);
    expect(aircraftOf(engine, 'AEGIS-FT-001')).toMatchObject({
      typeId: 'aegis-curated:typhoon',
      typeName: 'Eurofighter Typhoon',
      status: 'available',
      home: PRESTWICK,
      location: PRESTWICK,
      fuelKg: TYPHOON.fuelCapacityKg,
      payloadKg: 0,
      conditionPct: 100,
      flights: 0,
      activeFlightId: null,
      acquiredTick: 0,
    });
  });

  it('numbers instances per category', () => {
    const engine = world();
    for (const order of [typhoonOrder(), c17Order(), typhoonOrder(), c17Order()]) {
      engine.applyCommand({ type: 'acquireAircraft', ...order });
    }
    expect(engine.snapshot().fleet.aircraft.map((aircraft) => aircraft.id)).toEqual([
      'AEGIS-FT-001',
      'AEGIS-FT-002',
      'AEGIS-TR-001',
      'AEGIS-TR-002',
    ]);
  });

  it('accepts a type with no performance model, which then cannot fly and says why', () => {
    const engine = world();
    engine.applyCommand({
      type: 'acquireAircraft',
      ...typhoonOrder(),
      typeName: 'Airbus A330 MRTT',
      category: 'tanker',
      performance: null,
      performanceMissing: ['empty mass', 'range'],
    });
    const voyager = aircraftOf(engine, 'AEGIS-TK-001');
    expect(voyager).toMatchObject({ performance: null, fuelKg: 0, status: 'available' });
    expect(() =>
      engine.applyCommand({
        type: 'launchFlight',
        aircraftId: 'AEGIS-TK-001',
        plan: generatePlan(TYPHOON, PRESTWICK, NEWQUAY),
        load: { fuelKg: 0, payloadKg: 0 },
      }),
    ).toThrow(/reference data lacks empty mass, range/);
  });

  it('seeds the starter fleet exactly once', () => {
    const engine = world();
    const seed: FleetCommand = { type: 'seedStarterFleet', aircraft: [typhoonOrder(), c17Order()] };
    expect(engine.applyCommand(seed)).toBe(true);
    expect(engine.applyCommand(seed)).toBe(false);
    expect(engine.snapshot().fleet.aircraft).toHaveLength(2);
    expect(engine.snapshot().fleet.starterFleetSeeded).toBe(true);
  });

  it('rejects an invalid home', () => {
    const engine = world();
    expect(() =>
      engine.applyCommand({ type: 'acquireAircraft', ...typhoonOrder({ ...PRESTWICK, lat: 123 }) }),
    ).toThrow(CommandRejected);
    expect(() =>
      engine.applyCommand({
        type: 'acquireAircraft',
        ...typhoonOrder({ ...PRESTWICK, kind: 'waypoint' }),
      }),
    ).toThrow(/based at an aerodrome/);
    expect(engine.snapshot().fleet.aircraft).toEqual([]);
  });
});

describe('configuring aircraft', () => {
  it('changes home, and refuses fuel the aircraft cannot hold', () => {
    const engine = world();
    engine.applyCommand({ type: 'acquireAircraft', ...c17Order() });
    engine.applyCommand({ type: 'setHome', aircraftId: 'AEGIS-TR-001', home: PRESTWICK });
    expect(aircraftOf(engine, 'AEGIS-TR-001')).toMatchObject({
      home: PRESTWICK,
      location: NEWQUAY,
      fuelKg: C17.fuelCapacityKg,
    });

    const fuel = (fuelKg: number) => () =>
      engine.applyCommand({ type: 'serviceAircraft', aircraftId: 'AEGIS-TR-001', fuelKg });
    expect(fuel(C17.fuelCapacityKg + 1000)).toThrow(/more fuel than AEGIS-TR-001 can hold/);
    expect(fuel(-1)).toThrow(CommandRejected);
    expect(fuel(Number.NaN)).toThrow(CommandRejected);
    expect(() =>
      engine.applyCommand({ type: 'setHome', aircraftId: 'AEGIS-XX-999', home: PRESTWICK }),
    ).toThrow(/no aircraft/);
  });
});

describe('launching', () => {
  it('turns an approved plan into an active flight', () => {
    const engine = world();
    engine.applyCommand({ type: 'acquireAircraft', ...typhoonOrder() });
    engine.runSteps(10);
    const { plan, load, estimate } = launch(engine, 'AEGIS-FT-001', TYPHOON, PRESTWICK, NEWQUAY);

    expect(aircraftOf(engine, 'AEGIS-FT-001')).toMatchObject({
      status: 'in_flight',
      location: null,
      fuelKg: load.fuelKg,
      activeFlightId: 'FLT-000001',
    });
    expect(engine.snapshot().fleet.flights[0]).toMatchObject({
      id: 'FLT-000001',
      aircraftId: 'AEGIS-FT-001',
      status: 'active',
      plan,
      departedTick: engine.clock.tick,
      estimatedDurationS: estimate?.durationS,
      progress: { phase: 'takeoff', distanceM: 0, fuelKg: load.fuelKg },
    });
  });

  it('refuses a flight that does not start where the aircraft is', () => {
    const engine = world();
    engine.applyCommand({ type: 'acquireAircraft', ...typhoonOrder() });
    const plan = generatePlan(TYPHOON, NEWQUAY, PRESTWICK);
    expect(() =>
      engine.applyCommand({
        type: 'launchFlight',
        aircraftId: 'AEGIS-FT-001',
        plan,
        load: { fuelKg: 5000, payloadKg: 0 },
      }),
    ).toThrow(/is at Glasgow Prestwick; the flight must start there/);
  });

  it('refuses a plan with a blocking constraint and leaves the world unchanged', () => {
    const engine = world();
    engine.applyCommand({ type: 'acquireAircraft', ...typhoonOrder() });
    const before = engine.snapshot();
    const tooFar = generatePlan(TYPHOON, PRESTWICK, JFK);
    expect(() =>
      engine.applyCommand({
        type: 'launchFlight',
        aircraftId: 'AEGIS-FT-001',
        plan: tooFar,
        load: { fuelKg: 6250, payloadKg: 0 },
      }),
    ).toThrow(/Fuel runs out/);
    const tooHigh: FlightPlan = {
      ...generatePlan(TYPHOON, PRESTWICK, NEWQUAY),
      cruiseAltitudeM: 20000,
    };
    expect(() =>
      engine.applyCommand({
        type: 'launchFlight',
        aircraftId: 'AEGIS-FT-001',
        plan: tooHigh,
        load: { fuelKg: 6250, payloadKg: 0 },
      }),
    ).toThrow(/above the service ceiling/);
    expect(engine.snapshot()).toEqual(before);
  });

  it('refuses a second launch and changes while airborne', () => {
    const engine = world();
    engine.applyCommand({ type: 'acquireAircraft', ...typhoonOrder() });
    launch(engine, 'AEGIS-FT-001', TYPHOON, PRESTWICK, NEWQUAY);
    expect(() => launch(engine, 'AEGIS-FT-001', TYPHOON, PRESTWICK, NEWQUAY)).toThrow(/airborne/);
    expect(() =>
      engine.applyCommand({ type: 'serviceAircraft', aircraftId: 'AEGIS-FT-001', fuelKg: 1 }),
    ).toThrow(/airborne/);
    expect(() =>
      engine.applyCommand({ type: 'startMaintenance', aircraftId: 'AEGIS-FT-001' }),
    ).toThrow(/airborne/);
  });
});

describe('flying', () => {
  it('flies the plan and matches the estimate exactly', () => {
    const engine = world();
    engine.applyCommand({ type: 'acquireAircraft', ...c17Order() });
    const { load, estimate } = launch(engine, 'AEGIS-TR-001', C17, NEWQUAY, AKROTIRI, 20000);
    const steps = flyOut(engine, 'AEGIS-TR-001');

    expect(steps).toBe(estimate?.durationS);
    const landed = aircraftOf(engine, 'AEGIS-TR-001');
    expect(landed.location).toEqual(AKROTIRI);
    // It is turned round before it is available again (ADR 0027).
    expect(landed.status).toBe('servicing');
    expect(landed.service).toMatchObject({ reason: 'turnaround', stage: 'checks' });
    expect(landed.fuelKg).toBe(estimate?.fuelAtDestinationKg);
    expect(landed.fuelKg).toBeLessThan(load.fuelKg);
    expect(landed.flights).toBe(1);
    expect(landed.flightSecondsTotal).toBe(steps);
    expect(landed.payloadKg).toBe(20000);

    const flight = engine.snapshot().fleet.flights[0];
    expect(flight).toMatchObject({
      status: 'completed',
      arrivedTick: engine.clock.tick,
      progress: { phase: 'landed' },
    });
  });

  it('reports a moving, descending-fuel flight in its view', () => {
    const engine = world();
    engine.applyCommand({ type: 'acquireAircraft', ...c17Order() });
    const { estimate } = launch(engine, 'AEGIS-TR-001', C17, NEWQUAY, AKROTIRI);
    engine.runSteps(600);
    const early = engine.fleetView().activeFlights[0];
    engine.runSteps(3000);
    const later = engine.fleetView().activeFlights[0];
    if (!early || !later) throw new Error('flight should be active');

    expect(later.distanceM).toBeGreaterThan(early.distanceM);
    expect(later.fuelKg).toBeLessThan(early.fuelKg);
    expect(greatCircleDistance(later, AKROTIRI)).toBeLessThan(greatCircleDistance(early, AKROTIRI));
    expect(greatCircleDistance(later, NEWQUAY)).toBeCloseTo(later.distanceM, -2);
    expect(later.phase).toBe('cruise');
    expect(later.altitudeM).toBe(C17.cruiseAltitudeM);
    expect(later.speedKmh).toBe(833);
    expect(later.burnRateKgH).toBeGreaterThan(0);
    // Heading is roughly south-east from Cornwall to Cyprus.
    expect(later.headingDeg).toBeGreaterThan(90);
    expect(later.headingDeg).toBeLessThan(150);
    expect(later.etaTick).toBe(later.departedTick + (estimate?.durationS ?? 0));
    expect(later.totalM).toBeCloseTo(greatCircleDistance(NEWQUAY, AKROTIRI), 3);
  });

  it('wears the aircraft and accumulates its record', () => {
    const engine = world();
    engine.applyCommand({ type: 'acquireAircraft', ...c17Order() });
    launch(engine, 'AEGIS-TR-001', C17, NEWQUAY, AKROTIRI);
    const steps = flyOut(engine, 'AEGIS-TR-001');
    const hours = steps / 3600;
    const expected = MAINTENANCE.wearPctPerFlightHour * hours + MAINTENANCE.wearPctPerFlight;
    const wear = 100 - aircraftOf(engine, 'AEGIS-TR-001').conditionPct;
    expect(wear).toBeGreaterThanOrEqual(expected * 0.9 - 1e-9);
    expect(wear).toBeLessThanOrEqual(expected * 1.1 + 1e-9);
  });

  it('draws wear from the seeded stream: same seed same wear, other seed other wear', () => {
    const run = (seed: string) => {
      const engine = world(seed);
      engine.applyCommand({ type: 'acquireAircraft', ...typhoonOrder() });
      launch(engine, 'AEGIS-FT-001', TYPHOON, PRESTWICK, NEWQUAY);
      flyOut(engine, 'AEGIS-FT-001');
      return aircraftOf(engine, 'AEGIS-FT-001').conditionPct;
    };
    expect(run('a')).toBe(run('a'));
    expect(run('a')).not.toBe(run('b'));
  });

  it('can fly on from where it landed', () => {
    const engine = world();
    engine.applyCommand({ type: 'acquireAircraft', ...typhoonOrder() });
    launch(engine, 'AEGIS-FT-001', TYPHOON, PRESTWICK, NEWQUAY);
    flyOut(engine, 'AEGIS-FT-001');
    launch(engine, 'AEGIS-FT-001', TYPHOON, NEWQUAY, PRESTWICK);
    flyOut(engine, 'AEGIS-FT-001');
    expect(aircraftOf(engine, 'AEGIS-FT-001')).toMatchObject({ location: PRESTWICK, flights: 2 });
    expect(engine.fleetView().recentFlights.map((flight) => flight.id)).toEqual([
      'FLT-000002',
      'FLT-000001',
    ]);
  });
});

describe('determinism and continuity', () => {
  function scenario(engine: SimulationEngine, run: (steps: number) => void): void {
    engine.applyCommand({ type: 'seedStarterFleet', aircraft: [typhoonOrder(), c17Order()] });
    run(120);
    launch(engine, 'AEGIS-TR-001', C17, NEWQUAY, AKROTIRI, 15000);
    run(900);
    launch(engine, 'AEGIS-FT-001', TYPHOON, PRESTWICK, NEWQUAY);
    run(30_000);
  }

  it('gives an identical world for the same commands at the same ticks', () => {
    const a = world();
    const b = world();
    scenario(a, (steps) => {
      a.runSteps(steps);
    });
    scenario(b, (steps) => {
      b.runSteps(steps);
    });
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(aircraftOf(a, 'AEGIS-TR-001').location).toEqual(AKROTIRI);
  });

  it('does not depend on how steps are batched', () => {
    const single = world();
    scenario(single, (steps) => {
      single.runSteps(steps);
    });
    const chunked = world();
    scenario(chunked, (steps) => {
      for (let done = 0; done < steps;) {
        const chunk = Math.min(97, steps - done);
        chunked.runSteps(chunk);
        done += chunk;
      }
    });
    expect(chunked.snapshot()).toEqual(single.snapshot());
  });

  it('continues a flight after save and restore exactly as if never interrupted', () => {
    const uninterrupted = world();
    uninterrupted.applyCommand({ type: 'acquireAircraft', ...c17Order() });
    launch(uninterrupted, 'AEGIS-TR-001', C17, NEWQUAY, AKROTIRI, 10000);
    uninterrupted.runSteps(20_000);

    const first = world();
    first.applyCommand({ type: 'acquireAircraft', ...c17Order() });
    launch(first, 'AEGIS-TR-001', C17, NEWQUAY, AKROTIRI, 10000);
    first.runSteps(7000);
    const saved = JSON.parse(JSON.stringify(first.snapshot())) as WorldSnapshot;
    expect(saved.fleet.flights[0]?.status).toBe('active');

    const resumed = SimulationEngine.restore(saved);
    expect(resumed.snapshot()).toEqual(first.snapshot());
    expect(resumed.fleetView().activeFlights[0]).toEqual(first.fleetView().activeFlights[0]);
    resumed.runSteps(13_000);
    expect(resumed.snapshot()).toEqual(uninterrupted.snapshot());
  });

  it('reaches the same outcome at 1x and at 100x', async () => {
    const outcome = async (speed: 1 | 100, sliceMs: number) => {
      const host = new ManualHostClock();
      const runner = await SimulationRunner.open({
        store: new MemoryWorldStore(),
        host,
        newWorld: () => ({ seed: 'speed-world', epoch: EPOCH }),
      });
      runner.execute({ type: 'setSpeed', speed });
      runner.execute({ type: 'acquireAircraft', ...typhoonOrder() });
      const plan = generatePlan(TYPHOON, PRESTWICK, NEWQUAY);
      // The fuel is loaded first, in simulated time, at whatever speed the world runs.
      runner.execute({ type: 'serviceAircraft', aircraftId: 'AEGIS-FT-001', fuelKg: 5000 });
      while (runner.view().fleet.aircraft[0]?.status === 'servicing') {
        host.elapse(sliceMs);
        runner.advance();
      }
      runner.execute({
        type: 'launchFlight',
        aircraftId: 'AEGIS-FT-001',
        plan,
        load: { fuelKg: 5000, payloadKg: 0 },
      });
      let guard = 0;
      while (runner.view().fleet.aircraft[0]?.activeFlightId !== null) {
        host.elapse(sliceMs);
        runner.advance();
        if (++guard > 2_000_000) throw new Error('did not land');
      }
      const view = runner.view();
      return {
        aircraft: view.fleet.aircraft[0],
        flight: view.fleet.recentFlights[0],
        realMs: guard * sliceMs,
      };
    };
    const slow = await outcome(1, 1000);
    const fast = await outcome(100, 100);
    expect(fast.aircraft).toEqual(slow.aircraft);
    expect(fast.flight).toEqual(slow.flight);
    // The same flight takes about a hundredth of the real time at 100x.
    expect(fast.realMs).toBeLessThan(slow.realMs / 90);
  });

  it('upgrades a model-1 world to an empty fleet', () => {
    // A world saved by model 1 has no fleet at all.
    const modelOne = { ...world().snapshot(), modelVersion: 1, fleet: undefined };
    const upgraded = SimulationEngine.restore(modelOne as unknown as WorldSnapshot);
    expect(upgraded.snapshot().modelVersion).toBe(SIM_MODEL_VERSION);
    expect(upgraded.snapshot().fleet).toEqual({
      aircraft: [],
      flights: [],
      counters: {},
      starterFleetSeeded: false,
    });
  });

  it('refuses a saved fleet that is internally inconsistent', () => {
    const engine = world();
    engine.applyCommand({ type: 'acquireAircraft', ...c17Order() });
    launch(engine, 'AEGIS-TR-001', C17, NEWQUAY, AKROTIRI);
    const snapshot = engine.snapshot();
    const orphaned: WorldSnapshot = { ...snapshot, fleet: { ...snapshot.fleet, flights: [] } };
    const negative: WorldSnapshot = {
      ...snapshot,
      fleet: {
        ...snapshot.fleet,
        aircraft: snapshot.fleet.aircraft.map((a) => ({ ...a, fuelKg: -5 })),
      },
    };
    expect(() => SimulationEngine.restore(orphaned)).toThrow(WorldRestoreError);
    expect(() => SimulationEngine.restore(negative)).toThrow(WorldRestoreError);
  });
});

describe('maintenance', () => {
  /** A world whose only aircraft has nearly reached its maintenance interval. */
  function nearlyDue(): SimulationEngine {
    const engine = world();
    engine.applyCommand({ type: 'acquireAircraft', ...typhoonOrder() });
    const snapshot = engine.snapshot();
    return SimulationEngine.restore({
      ...snapshot,
      fleet: {
        ...snapshot.fleet,
        aircraft: snapshot.fleet.aircraft.map((aircraft) => ({
          ...aircraft,
          flightSecondsSinceMaintenance: MAINTENANCE.dueAfterFlightSeconds - 60,
        })),
      },
    });
  }

  it('becomes due after enough flying, blocks launching, and is cleared by maintenance', () => {
    const engine = nearlyDue();
    launch(engine, 'AEGIS-FT-001', TYPHOON, PRESTWICK, NEWQUAY);
    flyOut(engine, 'AEGIS-FT-001');
    expect(aircraftOf(engine, 'AEGIS-FT-001').status).toBe('maintenance_due');
    expect(() => launch(engine, 'AEGIS-FT-001', TYPHOON, NEWQUAY, PRESTWICK)).toThrow(
      /due maintenance and cannot launch/,
    );

    const startTick = engine.clock.tick;
    expect(engine.applyCommand({ type: 'startMaintenance', aircraftId: 'AEGIS-FT-001' })).toBe(
      true,
    );
    expect(engine.applyCommand({ type: 'startMaintenance', aircraftId: 'AEGIS-FT-001' })).toBe(
      false,
    );
    expect(aircraftOf(engine, 'AEGIS-FT-001')).toMatchObject({
      status: 'in_maintenance',
      maintenanceCompleteTick: startTick + MAINTENANCE.durationSeconds,
    });

    engine.runSteps(MAINTENANCE.durationSeconds - 1);
    expect(aircraftOf(engine, 'AEGIS-FT-001').status).toBe('in_maintenance');
    engine.runSteps(1);
    expect(aircraftOf(engine, 'AEGIS-FT-001')).toMatchObject({
      status: 'available',
      conditionPct: 100,
      flightSecondsSinceMaintenance: 0,
      maintenanceCompleteTick: null,
    });
    launch(engine, 'AEGIS-FT-001', TYPHOON, NEWQUAY, PRESTWICK);
  });

  it('becomes due when condition falls below the threshold', () => {
    const engine = world();
    engine.applyCommand({ type: 'acquireAircraft', ...typhoonOrder() });
    const snapshot = engine.snapshot();
    const worn = SimulationEngine.restore({
      ...snapshot,
      fleet: {
        ...snapshot.fleet,
        aircraft: snapshot.fleet.aircraft.map((aircraft) => ({ ...aircraft, conditionPct: 60.2 })),
      },
    });
    launch(worn, 'AEGIS-FT-001', TYPHOON, PRESTWICK, NEWQUAY);
    flyOut(worn, 'AEGIS-FT-001');
    expect(aircraftOf(worn, 'AEGIS-FT-001').status).toBe('maintenance_due');
  });

  it('handles fuel exhaustion as a forced landing that maintenance recovers', () => {
    const engine = world();
    engine.applyCommand({ type: 'acquireAircraft', ...c17Order() });
    launch(engine, 'AEGIS-TR-001', C17, NEWQUAY, AKROTIRI);
    engine.runSteps(3000);
    // Not reachable through planning, which blocks it; set up directly to prove the engine copes.
    const snapshot = engine.snapshot();
    const starved = SimulationEngine.restore({
      ...snapshot,
      fleet: {
        ...snapshot.fleet,
        flights: snapshot.fleet.flights.map((flight) => ({
          ...flight,
          progress: { ...flight.progress, fuelKg: 50 },
        })),
      },
    });
    flyOut(starved, 'AEGIS-TR-001');
    const down = aircraftOf(starved, 'AEGIS-TR-001');
    expect(down).toMatchObject({ status: 'unserviceable', fuelKg: 0, conditionPct: 0 });
    expect(down.location).toMatchObject({ kind: 'waypoint', name: 'Forced landing site' });
    expect(starved.snapshot().fleet.flights[0]?.status).toBe('fuel_exhausted');

    starved.applyCommand({ type: 'startMaintenance', aircraftId: 'AEGIS-TR-001' });
    starved.runSteps(MAINTENANCE.durationSeconds);
    expect(aircraftOf(starved, 'AEGIS-TR-001')).toMatchObject({
      status: 'available',
      location: NEWQUAY,
      conditionPct: 100,
    });
  });
});

describe('runner integration', () => {
  it('checkpoints on a fleet command and not on a rejected or ineffective one', async () => {
    const store = new MemoryWorldStore();
    const runner = await SimulationRunner.open({
      store,
      host: new ManualHostClock(),
      newWorld: () => ({ seed: 'runner-fleet', epoch: EPOCH }),
    });
    runner.execute({ type: 'seedStarterFleet', aircraft: [typhoonOrder()] });
    await runner.flush();
    expect(store.latest?.snapshot.fleet.aircraft).toHaveLength(1);

    const saves = store.saves.length;
    runner.execute({ type: 'seedStarterFleet', aircraft: [typhoonOrder()] });
    expect(() => {
      runner.execute({ type: 'startMaintenance', aircraftId: 'AEGIS-XX-404' });
    }).toThrow(CommandRejected);
    await runner.flush();
    expect(store.saves).toHaveLength(saves);
    expect(runner.view().fleet.aircraft).toHaveLength(1);
  });
});

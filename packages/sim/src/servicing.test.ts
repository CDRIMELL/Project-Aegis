import {
  GROUND_SERVICE,
  MISSION_TEMPLATES,
  defaultBrief,
  evaluatePlan,
  generatePlan,
  postFlightChecksS,
  transferDurationS,
  type Mission,
  type MissionBrief,
  type MissionType,
} from '@aegis/domain';
import { describe, expect, it } from 'vitest';
import { SimulationEngine, WorldRestoreError } from './engine';
import { CommandRejected, MAINTENANCE, type AircraftState, type FlightState } from './fleet';
import type { LogEntry } from './log';
import { defaultConfiguration } from './missions';
import { replayComparable, replayWorld } from './replay';
import { SimulationRunner } from './runner';
import {
  FIXTURES,
  ManualHostClock,
  MemoryWorldStore,
  fixtureLaunchFull,
  fixtureOrder,
  fuelled,
  untilServiced,
} from './testing';
import { SIM_MODEL_VERSION, type WorldSnapshot } from './world';

/*
 * Turnaround, refuelling and readiness (ADR 0027): an aircraft that lands is serviced before it
 * is available, fuel takes simulated time to load, and nothing launches before it is ready.
 */

const { places, models } = FIXTURES;
const TRANSPORT = 'AEGIS-TR-001';
const JET = 'AEGIS-FT-001';
const CAPACITY = models.transport.fuelCapacityKg;
const AREA = { name: 'Area 1', lat: 49.4, lon: -7.2 };
const copyOf = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const newWorld = (seed = 'servicing') => ({ seed, epoch: FIXTURES.epoch });

function world(seed?: string): SimulationEngine {
  const engine = SimulationEngine.create(newWorld(seed));
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
const types = (engine: SimulationEngine) => log(engine).map((entry) => entry.type);
const events = (engine: SimulationEngine, type: string) =>
  log(engine).filter((entry) => entry.type === type);
const service = (engine: SimulationEngine, fuelKg: number, aircraftId = TRANSPORT) =>
  engine.applyCommand({ type: 'serviceAircraft', aircraftId, fuelKg });
const stop = (engine: SimulationEngine, aircraftId = TRANSPORT) =>
  engine.applyCommand({ type: 'stopServicing', aircraftId });
const toExeter = () =>
  fixtureLaunchFull(TRANSPORT, models.transport, places.newquay, places.exeter);

/** A world in which the transport has flown to Exeter and has just landed. */
function justLanded(seed?: string): SimulationEngine {
  const engine = world(seed);
  engine.applyCommand(toExeter());
  while (aircraftOf(engine).activeFlightId !== null) engine.runSteps(1);
  return engine;
}

/** A world edited as if it had been saved with the transport in a given state. */
function withTransport(engine: SimulationEngine, change: Partial<AircraftState>) {
  const snapshot = engine.snapshot();
  return SimulationEngine.restore({
    ...snapshot,
    fleet: {
      ...snapshot.fleet,
      aircraft: snapshot.fleet.aircraft.map((aircraft) =>
        aircraft.id === TRANSPORT ? { ...aircraft, ...change } : aircraft,
      ),
    },
  });
}

function training(engine: SimulationEngine, overrides: Partial<MissionBrief> = {}): string {
  const type: MissionType = 'training';
  engine.applyCommand({
    type: 'createMission',
    missionType: type,
    ...defaultConfiguration(
      type,
      { ...defaultBrief(MISSION_TEMPLATES[type]), target: AREA, ...overrides },
      aircraftOf(engine),
      { context: engine.planContext() },
    ),
  });
  return `MSN-${String(engine.snapshot().missions.nextNumber - 1).padStart(6, '0')}`;
}
const launchMission = (engine: SimulationEngine, missionId: string) =>
  engine.applyCommand({ type: 'launchMission', missionId });

describe('refuelling takes simulated time', () => {
  it('loads fuel second by second, and ends exactly on the target at the tick it said', () => {
    const engine = world();
    fuelled(engine, TRANSPORT, 20_000);
    const start = engine.clock.tick;
    const duration = transferDurationS(CAPACITY, 20_000, 30_000);

    expect(service(engine, 30_000)).toBe(true);
    const begun = aircraftOf(engine);
    expect(begun).toMatchObject({
      status: 'servicing',
      // Nothing has been loaded yet: ordering fuel does not put it aboard.
      fuelKg: 20_000,
      service: {
        reason: 'preparation',
        stage: 'refuelling',
        startedTick: start,
        fuelAtStartKg: 20_000,
        targetFuelKg: 30_000,
        transfer: { fromKg: 20_000, toKg: 30_000, completeTick: start + duration },
        missionId: null,
      },
    });

    let last = begun.fuelKg;
    const connected = start + GROUND_SERVICE.refuel.connectS;
    for (let tick = start + 1; tick < start + duration; tick++) {
      engine.runSteps(1);
      const now = aircraftOf(engine);
      expect(now.status).toBe('servicing');
      // Still while it connects, then rising every second.
      if (tick <= connected) expect(now.fuelKg).toBe(20_000);
      else expect(now.fuelKg).toBeGreaterThan(last);
      expect(now.fuelKg).toBeLessThan(30_000);
      last = now.fuelKg;
    }
    engine.runSteps(1);
    expect(engine.clock.tick).toBe(start + duration);
    expect(aircraftOf(engine)).toMatchObject({
      status: 'available',
      fuelKg: 30_000,
      service: null,
    });
  });

  it('takes longer for more fuel, and as long to take it off', () => {
    const timeTo = (fromKg: number, toKg: number) => {
      const engine = world();
      fuelled(engine, TRANSPORT, fromKg);
      const start = engine.clock.tick;
      fuelled(engine, TRANSPORT, toKg);
      expect(aircraftOf(engine).fuelKg).toBe(toKg);
      return engine.clock.tick - start;
    };
    const little = timeTo(20_000, 24_000);
    const much = timeTo(20_000, 44_000);
    expect(little).toBe(transferDurationS(CAPACITY, 20_000, 24_000));
    expect(much).toBe(transferDurationS(CAPACITY, 20_000, 44_000));
    expect(much).toBeGreaterThan(little);
    expect(timeTo(44_000, 20_000)).toBe(much);
  });

  it('records what the command caused, after the command, and the completion when it happens', () => {
    const engine = world();
    fuelled(engine, TRANSPORT, 20_000);
    const before = log(engine).length;
    const start = engine.clock.tick;
    service(engine, 30_000);
    const duration = transferDurationS(CAPACITY, 20_000, 30_000);
    expect(log(engine).slice(before)).toMatchObject([
      {
        kind: 'command',
        type: 'serviceAircraft',
        actor: 'player',
        tick: start,
        aircraftId: TRANSPORT,
        payload: { type: 'serviceAircraft', aircraftId: TRANSPORT, fuelKg: 30_000 },
      },
      {
        kind: 'event',
        type: 'servicingStarted',
        actor: 'world',
        tick: start,
        aircraftId: TRANSPORT,
        payload: { reason: 'preparation', targetFuelKg: 30_000, completeTick: start + duration },
      },
      {
        kind: 'event',
        type: 'refuellingStarted',
        tick: start,
        payload: { fromKg: 20_000, toKg: 30_000, durationS: duration },
      },
    ]);
    // Nothing is logged while it loads: progress is derived, not recorded.
    engine.runSteps(duration - 1);
    expect(log(engine)).toHaveLength(before + 3);
    engine.runSteps(1);
    expect(log(engine).slice(before + 3)).toMatchObject([
      {
        type: 'refuellingCompleted',
        tick: start + duration,
        payload: { fuelKg: 30_000, loadedKg: 10_000, durationS: duration },
      },
      {
        type: 'servicingCompleted',
        tick: start + duration,
        aircraftId: TRANSPORT,
        payload: {
          reason: 'preparation',
          durationS: duration,
          checksS: 0,
          refuelS: duration,
          loadedKg: 10_000,
          fuelKg: 30_000,
        },
      },
    ]);
    expect(log(engine).map((entry) => entry.seq)).toEqual(log(engine).map((_, i) => i + 1));
  });

  it('refuses what cannot be done, with the reason, and changes nothing', () => {
    const engine = world();
    const before = engine.snapshot();
    expect(() => service(engine, CAPACITY + 1000)).toThrow(/more fuel than AEGIS-TR-001 can hold/);
    expect(() => service(engine, -1)).toThrow(/zero or more/);
    expect(() => service(engine, Number.NaN)).toThrow(CommandRejected);
    expect(() => service(engine, 1000, 'AEGIS-XX-999')).toThrow(/no aircraft/);
    expect(engine.snapshot()).toEqual(before);

    const due = withTransport(engine, { status: 'maintenance_due' });
    expect(() => service(due, 20_000)).toThrow(/due maintenance; it is fuelled for a flight once/);
    const broken = withTransport(engine, { status: 'unserviceable' });
    expect(() => service(broken, 20_000)).toThrow(/unserviceable and cannot be serviced/);
    engine.applyCommand({ type: 'startMaintenance', aircraftId: TRANSPORT });
    expect(() => service(engine, 20_000)).toThrow(/in maintenance/);

    const airborne = world();
    airborne.applyCommand(toExeter());
    expect(() => service(airborne, 20_000)).toThrow(/airborne; it cannot be serviced/);
    expect(() => stop(airborne)).not.toThrow();

    const unmodelled = SimulationEngine.create(newWorld());
    unmodelled.applyCommand({
      type: 'acquireAircraft',
      ...fixtureOrder('transport', places.newquay),
      performance: null,
      performanceMissing: ['empty mass'],
    });
    expect(() => service(unmodelled, 100)).toThrow(/no performance model/);
  });

  it('does nothing, and logs nothing, when there is nothing to do', () => {
    const engine = world();
    const before = engine.snapshot();
    // Already holds it; not being serviced.
    expect(service(engine, CAPACITY)).toBe(false);
    expect(stop(engine)).toBe(false);
    expect(engine.snapshot()).toEqual(before);
    // Asked twice for the same thing.
    expect(service(engine, 30_000)).toBe(true);
    const once = engine.snapshot();
    expect(service(engine, 30_000)).toBe(false);
    expect(engine.snapshot()).toEqual(once);
  });

  it('takes a new target without connecting again, and stops when asked', () => {
    const engine = world();
    fuelled(engine, TRANSPORT, 20_000);
    service(engine, 40_000);
    engine.runSteps(GROUND_SERVICE.refuel.connectS + 100);
    const held = aircraftOf(engine).fuelKg;
    expect(held).toBeGreaterThan(20_000);
    const rate = aircraftOf(engine).service?.transfer?.rateKgS as number;

    // More is wanted: it goes on from what it holds, at once.
    const at = engine.clock.tick;
    expect(service(engine, 44_000)).toBe(true);
    expect(aircraftOf(engine).service?.transfer).toMatchObject({
      startTick: at,
      flowStartTick: at,
      fromKg: held,
      toKg: 44_000,
      completeTick: at + Math.ceil((44_000 - held) / rate),
    });
    engine.runSteps(1);
    expect(aircraftOf(engine).fuelKg).toBe(held + rate);

    // Stopped: available at once, with the fuel it then holds.
    const stoppedWith = aircraftOf(engine).fuelKg;
    expect(stop(engine)).toBe(true);
    expect(aircraftOf(engine)).toMatchObject({
      status: 'available',
      fuelKg: stoppedWith,
      service: null,
    });
    expect(events(engine, 'refuellingCompleted').at(-1)?.payload).toMatchObject({
      stopped: true,
      fuelKg: stoppedWith,
      loadedKg: stoppedWith - 20_000,
    });
    expect(types(engine).slice(-3)).toEqual([
      'stopServicing',
      'refuellingCompleted',
      'servicingCompleted',
    ]);
    engine.runSteps(600);
    expect(aircraftOf(engine).fuelKg).toBe(stoppedWith);
  });

  it('ends at once when asked for what it already holds', () => {
    const engine = world();
    fuelled(engine, TRANSPORT, 20_000);
    service(engine, 40_000);
    // Still connecting: nothing has moved.
    engine.runSteps(60);
    expect(service(engine, 20_000)).toBe(true);
    expect(aircraftOf(engine)).toMatchObject({
      status: 'available',
      fuelKg: 20_000,
      service: null,
    });
    expect(events(engine, 'refuellingCompleted').at(-1)?.payload).not.toHaveProperty('stopped');
  });
});

describe('turnaround after landing', () => {
  it('is not available on landing: it is checked first, for a time set by the flight', () => {
    const engine = justLanded();
    const flight = flightOf(engine);
    const arrived = flight.arrivedTick as number;
    const checksS = postFlightChecksS(flight.progress.elapsedS);
    expect(engine.clock.tick).toBe(arrived);
    expect(aircraftOf(engine)).toMatchObject({
      status: 'servicing',
      location: places.exeter,
      fuelKg: flight.progress.fuelKg,
      service: {
        reason: 'turnaround',
        stage: 'checks',
        startedTick: arrived,
        checksCompleteTick: arrived + checksS,
        targetFuelKg: null,
        transfer: null,
      },
    });
    expect(types(engine).slice(-2)).toEqual(['flightCompleted', 'servicingStarted']);
    expect(events(engine, 'flightCompleted')[0]?.payload).toMatchObject({ turnaroundS: checksS });
    expect(events(engine, 'servicingStarted')[0]).toMatchObject({
      actor: 'world',
      tick: arrived,
      aircraftId: TRANSPORT,
      payload: { reason: 'turnaround', checksS, completeTick: arrived + checksS },
    });

    // Until the very tick the checks end, it cannot launch, and says when it can.
    const back = {
      type: 'launchFlight' as const,
      aircraftId: TRANSPORT,
      plan: generatePlan(models.transport, places.exeter, places.newquay),
      load: { fuelKg: flight.progress.fuelKg, payloadKg: 0 },
    };
    expect(() => engine.applyCommand(back)).toThrow(
      /AEGIS-TR-001 is in its post-flight checks\. It will be available in \d+ min\./,
    );
    engine.runSteps(checksS - 1);
    expect(aircraftOf(engine).status).toBe('servicing');
    expect(() => engine.applyCommand(back)).toThrow(/post-flight checks/);
    engine.runSteps(1);
    expect(aircraftOf(engine)).toMatchObject({
      status: 'available',
      service: null,
      // A turnaround does not refuel by itself.
      fuelKg: flight.progress.fuelKg,
    });
    expect(events(engine, 'servicingCompleted')[0]).toMatchObject({
      tick: arrived + checksS,
      payload: { reason: 'turnaround', durationS: checksS, checksS, refuelS: 0, loadedKg: 0 },
    });
    expect(events(engine, 'refuellingStarted')).toHaveLength(0);
    expect(engine.applyCommand(back)).toBe(true);
  });

  it('checks cannot be skipped, and fuel asked for during them follows them', () => {
    const engine = justLanded();
    const landedWith = aircraftOf(engine).fuelKg;
    const checksEnd = aircraftOf(engine).service?.checksCompleteTick as number;
    const started = aircraftOf(engine).service?.startedTick as number;
    expect(() => stop(engine)).toThrow(/post-flight checks, which cannot be skipped/);

    engine.runSteps(120);
    expect(service(engine, 50_000)).toBe(true);
    expect(aircraftOf(engine)).toMatchObject({
      status: 'servicing',
      fuelKg: landedWith,
      service: { reason: 'turnaround', stage: 'checks', targetFuelKg: 50_000, transfer: null },
    });
    // The request can be withdrawn; the checks go on.
    expect(stop(engine)).toBe(true);
    expect(aircraftOf(engine).service).toMatchObject({ stage: 'checks', targetFuelKg: null });
    service(engine, 50_000);

    engine.runSteps(checksEnd - engine.clock.tick);
    const duration = transferDurationS(CAPACITY, landedWith, 50_000);
    expect(aircraftOf(engine).service).toMatchObject({
      stage: 'refuelling',
      refuellingSinceTick: checksEnd,
      transfer: { startTick: checksEnd, fromKg: landedWith, completeTick: checksEnd + duration },
    });
    expect(events(engine, 'refuellingStarted')[0]).toMatchObject({
      tick: checksEnd,
      payload: { fromKg: landedWith, toKg: 50_000, durationS: duration },
    });
    engine.runSteps(duration - 1);
    expect(aircraftOf(engine).status).toBe('servicing');
    engine.runSteps(1);
    expect(aircraftOf(engine)).toMatchObject({
      status: 'available',
      fuelKg: 50_000,
      service: null,
    });
    // One service, from landing to ready.
    expect(events(engine, 'servicingCompleted')).toHaveLength(1);
    expect(events(engine, 'servicingCompleted')[0]?.payload).toMatchObject({
      reason: 'turnaround',
      durationS: checksEnd + duration - started,
      checksS: checksEnd - started,
      refuelS: duration,
      loadedKg: 50_000 - landedWith,
    });
  });

  it('is not turned round when maintenance is due: maintenance is what it waits for', () => {
    // Hours enough that this flight takes it over the limit.
    const engine = withTransport(world(), {
      flightSecondsSinceMaintenance: MAINTENANCE.dueAfterFlightSeconds - 60,
    });
    engine.applyCommand(toExeter());
    while (aircraftOf(engine).activeFlightId !== null) engine.runSteps(1);
    const landedWith = aircraftOf(engine).fuelKg;
    expect(aircraftOf(engine)).toMatchObject({ status: 'maintenance_due', service: null });
    expect(types(engine).slice(-2)).toEqual(['flightCompleted', 'maintenanceDue']);
    expect(events(engine, 'flightCompleted')[0]?.payload).not.toHaveProperty('turnaroundS');
    expect(events(engine, 'servicingStarted')).toHaveLength(0);

    // Time does not make it available, and it cannot be fuelled or launched.
    engine.runSteps(3 * 3600);
    expect(aircraftOf(engine).status).toBe('maintenance_due');
    expect(() => service(engine, 50_000)).toThrow(/due maintenance/);
    const back = {
      type: 'launchFlight' as const,
      aircraftId: TRANSPORT,
      plan: generatePlan(models.transport, places.exeter, places.newquay),
      load: { fuelKg: landedWith, payloadKg: 0 },
    };
    expect(() => engine.applyCommand(back)).toThrow(/due maintenance and cannot launch/);

    // Maintenance is unchanged: it returns the aircraft available, with the fuel it had.
    engine.applyCommand({ type: 'startMaintenance', aircraftId: TRANSPORT });
    engine.runSteps(MAINTENANCE.durationSeconds);
    expect(aircraftOf(engine)).toMatchObject({
      status: 'available',
      service: null,
      fuelKg: landedWith,
      conditionPct: 100,
      flightSecondsSinceMaintenance: 0,
    });
    expect(engine.applyCommand(back)).toBe(true);
  });

  it('is not interrupted by maintenance or a change of model', () => {
    const engine = justLanded();
    expect(() => engine.applyCommand({ type: 'startMaintenance', aircraftId: TRANSPORT })).toThrow(
      /being serviced\. Maintenance can start when it is available, in \d+ min\./,
    );
    expect(() =>
      engine.applyCommand({
        type: 'updatePerformance',
        aircraftId: TRANSPORT,
        performance: { ...models.transport, fuelCapacityKg: 50_000 },
        performanceMissing: [],
      }),
    ).toThrow(/being serviced/);
    untilServiced(engine, TRANSPORT);
    expect(engine.applyCommand({ type: 'startMaintenance', aircraftId: TRANSPORT })).toBe(true);
  });
});

describe('launch fuel', () => {
  it('is loaded before launch: the flight departs with what is aboard, which is what was planned', () => {
    const engine = world();
    const plan = generatePlan(models.transport, places.newquay, places.akrotiri);
    const launch = {
      type: 'launchFlight' as const,
      aircraftId: TRANSPORT,
      plan,
      load: { fuelKg: 60_000, payloadKg: 8000 },
    };
    const before = engine.snapshot();
    expect(() => engine.applyCommand(launch)).toThrow(
      /AEGIS-TR-001 holds [\d,]+ kg; the flight departs with 60,000 kg\. Taking [\d,]+ kg off takes \d+ min\./,
    );
    // A refused launch changes nothing: in particular, not the fuel.
    expect(engine.snapshot()).toEqual(before);

    service(engine, 60_000);
    engine.runSteps(1);
    expect(() => engine.applyCommand(launch)).toThrow(/having fuel taken off/);
    untilServiced(engine, TRANSPORT);
    const estimate = evaluatePlan(
      models.transport,
      plan,
      launch.load,
      engine.planContext(),
    ).estimate;
    expect(engine.applyCommand(launch)).toBe(true);
    expect(flightOf(engine)).toMatchObject({ fuelAtDepartureKg: 60_000, payloadKg: 8000 });
    expect(aircraftOf(engine)).toMatchObject({ status: 'in_flight', fuelKg: 60_000 });

    // An estimate still equals the outcome.
    while (aircraftOf(engine).activeFlightId !== null) engine.runSteps(20);
    expect(flightOf(engine).progress.elapsedS).toBe(estimate?.durationS);
    expect(flightOf(engine).progress.fuelKg).toBe(estimate?.fuelAtDestinationKg);
  });
});

describe('missions and readiness', () => {
  it('accepting prepares the aircraft; the mission launches at the tick it is ready, not before', () => {
    const engine = world();
    engine.runSteps(50);
    const id = training(engine);
    const fuelKg = missionOf(engine, id).load?.fuelKg as number;
    engine.applyCommand({ type: 'acceptMission', missionId: id });
    const readyTick = 50 + transferDurationS(CAPACITY, CAPACITY, fuelKg);
    expect(aircraftOf(engine)).toMatchObject({
      status: 'servicing',
      service: {
        reason: 'preparation',
        missionId: id,
        targetFuelKg: fuelKg,
        transfer: { completeTick: readyTick },
      },
    });

    // Every minute of the preparation: still accepted, and the launch is refused whole.
    while (engine.clock.tick < readyTick - 1) {
      const before = engine.snapshot();
      expect(() => launchMission(engine, id)).toThrow(/It will be available in \d+ min/);
      expect(engine.snapshot()).toEqual(before);
      expect(missionOf(engine, id).status).toBe('accepted');
      engine.runSteps(Math.min(60, readyTick - 1 - engine.clock.tick));
    }
    expect(() => launchMission(engine, id)).toThrow(CommandRejected);
    engine.runSteps(1);
    expect(engine.clock.tick).toBe(readyTick);
    expect(aircraftOf(engine)).toMatchObject({ status: 'available', fuelKg });
    expect(launchMission(engine, id)).toBe(true);
    expect(missionOf(engine, id)).toMatchObject({ status: 'active', actualStartTick: readyTick });
    expect(flightOf(engine).fuelAtDepartureKg).toBe(fuelKg);
    // The preparation is part of the mission's history.
    expect(events(engine, 'servicingCompleted')[0]).toMatchObject({
      tick: readyTick,
      missionId: id,
      aircraftId: TRANSPORT,
      payload: { reason: 'preparation', durationS: readyTick - 50 },
    });
  });

  it('prepares an aircraft still in its post-flight checks: the fuel follows them', () => {
    const engine = justLanded();
    const checksEnd = aircraftOf(engine).service?.checksCompleteTick as number;
    const landedWith = aircraftOf(engine).fuelKg;
    engine.runSteps(200);
    const id = training(engine, { target: { name: 'Area 2', lat: 50.2, lon: -2.2 } });
    engine.applyCommand({ type: 'acceptMission', missionId: id });
    const fuelKg = missionOf(engine, id).load?.fuelKg as number;
    expect(aircraftOf(engine).service).toMatchObject({
      reason: 'turnaround',
      stage: 'checks',
      targetFuelKg: fuelKg,
      missionId: id,
    });
    // Accepting during the checks starts nothing new: there is one service, and it goes on.
    expect(events(engine, 'servicingStarted')).toHaveLength(1);

    const readyTick = checksEnd + transferDurationS(CAPACITY, landedWith, fuelKg);
    engine.runSteps(readyTick - 1 - engine.clock.tick);
    expect(() => launchMission(engine, id)).toThrow(/It will be available in 1 min/);
    engine.runSteps(1);
    expect(launchMission(engine, id)).toBe(true);
    expect(flightOf(engine, 'FLT-000002').fuelAtDepartureKg).toBe(fuelKg);
  });

  it('is blocked by maintenance, which fuelling does not clear and a turnaround does not replace', () => {
    const engine = withTransport(world(), { status: 'maintenance_due' });
    const id = training(engine);
    engine.applyCommand({ type: 'acceptMission', missionId: id });
    // Committed, but not prepared: maintenance comes first.
    expect(aircraftOf(engine)).toMatchObject({ status: 'maintenance_due', service: null });
    expect(events(engine, 'servicingStarted')).toHaveLength(0);
    expect(() => launchMission(engine, id)).toThrow(/due maintenance and cannot launch/);
    engine.runSteps(2 * 3600);
    expect(() => launchMission(engine, id)).toThrow(/due maintenance and cannot launch/);

    engine.applyCommand({ type: 'startMaintenance', aircraftId: TRANSPORT });
    expect(() => launchMission(engine, id)).toThrow(/is in maintenance/);
    engine.runSteps(MAINTENANCE.durationSeconds);
    // Maintained, and still not ready: it does not hold the mission's fuel.
    expect(aircraftOf(engine).status).toBe('available');
    expect(() => launchMission(engine, id)).toThrow(/the flight departs with/);
    fuelled(engine, TRANSPORT, missionOf(engine, id).load?.fuelKg as number);
    expect(launchMission(engine, id)).toBe(true);
  });

  it('goes on preparing an aircraft whose mission is released, and leaves it available', () => {
    const engine = world();
    const id = training(engine);
    engine.applyCommand({ type: 'acceptMission', missionId: id });
    engine.runSteps(120);
    engine.applyCommand({ type: 'releaseMission', missionId: id });
    expect(missionOf(engine, id).status).toBe('planned');
    expect(aircraftOf(engine).status).toBe('servicing');
    untilServiced(engine, TRANSPORT);
    expect(aircraftOf(engine)).toMatchObject({
      status: 'available',
      fuelKg: missionOf(engine, id).load?.fuelKg,
    });
  });

  it('leaves the other aircraft alone', () => {
    const engine = justLanded();
    expect(aircraftOf(engine, JET)).toMatchObject({ status: 'available', service: null });
    expect(aircraftOf(engine, JET).fuelKg).toBe(models.fastJet.fuelCapacityKg);
  });
});

/** A day on the ground and in the air: a flight, a turnaround with fuel, a mission, a stop. */
function scripted(step: (engine: SimulationEngine, steps: number) => void): SimulationEngine {
  const engine = world('scripted');
  step(engine, 40);
  engine.applyCommand(toExeter());
  while (aircraftOf(engine).activeFlightId !== null) step(engine, 1);
  step(engine, 300);
  service(engine, 30_000);
  while (aircraftOf(engine).status === 'servicing') step(engine, 1);
  const id = training(engine, { target: { name: 'Area 2', lat: 50.2, lon: -2.2 } });
  engine.applyCommand({ type: 'acceptMission', missionId: id });
  while (aircraftOf(engine).status === 'servicing') step(engine, 1);
  launchMission(engine, id);
  service(engine, 3000, JET);
  step(engine, 400);
  stop(engine, JET);
  while (missionOf(engine, id).status === 'active') step(engine, 1);
  step(engine, 3000);
  return engine;
}
const oneAtATime = (engine: SimulationEngine, steps: number) => {
  for (let i = 0; i < steps; i++) engine.runSteps(1);
};

describe('determinism, continuity and upgrade', { timeout: 60_000 }, () => {
  const reference = scripted(oneAtATime);

  it('gives the same world however the steps are batched', () => {
    const batched = scripted((engine, steps) => {
      engine.runSteps(steps);
    });
    expect(batched.snapshot()).toEqual(reference.snapshot());
    expect(scripted(oneAtATime).snapshot()).toEqual(reference.snapshot());
    // Every stage happened in it.
    expect(new Set(types(reference))).toEqual(
      new Set([
        'seedStarterFleet',
        'launchFlight',
        'flightCompleted',
        'servicingStarted',
        'serviceAircraft',
        'refuellingStarted',
        'refuellingCompleted',
        'servicingCompleted',
        'createMission',
        'acceptMission',
        'launchMission',
        'stopServicing',
        'objectiveCompleted',
        'missionCompleted',
      ]),
    );
  });

  it('is re-derived from its seed and its logged commands, events and all', () => {
    const replayed = replayWorld(newWorld('scripted'), log(reference), reference.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(reference.snapshot()));
    // The events a command caused are reproduced with it, in the same place.
    expect(log(replayed)).toEqual(log(reference));
  });

  it('continues exactly from a save made at any moment of a turnaround or a refuelling', () => {
    // Saved every 97 ticks through the whole day, each save restored and run to the end.
    const final = reference.clock.tick;
    const live = world('scripted');
    const commands = log(reference).filter((entry) => entry.kind === 'command');
    let next = 1;
    let servicingSaves = 0;
    let refuellingSaves = 0;
    const applyDue = (engine: SimulationEngine, from: number) => {
      let index = from;
      for (; index < commands.length && commands[index]?.tick === engine.clock.tick; index++) {
        engine.applyCommand(commands[index]?.payload as never);
      }
      return index;
    };
    while (live.clock.tick < final) {
      next = applyDue(live, next);
      if (live.clock.tick % 97 === 0) {
        const saved = aircraftOf(live);
        if (saved.status === 'servicing') servicingSaves += 1;
        if (saved.service?.stage === 'refuelling') refuellingSaves += 1;
        const resumed = SimulationEngine.restore(copyOf(live.snapshot()));
        // The fuel aboard, and when it will be ready, are as saved: nothing starts again.
        expect(aircraftOf(resumed)).toEqual(saved);
        let index = next;
        while (resumed.clock.tick < final) {
          resumed.runSteps(1);
          index = applyDue(resumed, index);
        }
        expect(resumed.snapshot()).toEqual(reference.snapshot());
      }
      live.runSteps(1);
    }
    expect(live.snapshot()).toEqual(reference.snapshot());
    expect(servicingSaves).toBeGreaterThan(10);
    expect(refuellingSaves).toBeGreaterThan(5);
  });

  it('reaches the same world at 1x and at 100x, in a hundredth of the real time', async () => {
    const outcome = async (speed: 1 | 100, sliceMs: number) => {
      const host = new ManualHostClock();
      const runner = await SimulationRunner.open({
        store: new MemoryWorldStore(),
        host,
        newWorld: () => newWorld('speed'),
      });
      runner.execute({ type: 'setSpeed', speed });
      runner.execute({
        type: 'seedStarterFleet',
        aircraft: [fixtureOrder('transport', places.newquay)],
      });
      runner.execute({ type: 'serviceAircraft', aircraftId: TRANSPORT, fuelKg: 30_000 });
      let slices = 0;
      while (runner.view().fleet.aircraft[0]?.status === 'servicing') {
        host.elapse(sliceMs);
        runner.advance();
        slices += 1;
      }
      const view = runner.view();
      return { aircraft: view.fleet.aircraft[0], tick: view.clock.tick, realMs: slices * sliceMs };
    };
    const slow = await outcome(1, 1000);
    const fast = await outcome(100, 100);
    const duration = transferDurationS(CAPACITY, CAPACITY, 30_000);
    expect(slow.aircraft).toMatchObject({ status: 'available', fuelKg: 30_000 });
    expect(fast.aircraft).toEqual(slow.aircraft);
    expect(slow.tick).toBe(duration);
    // At 100x a slice is ten ticks: it is noticed at the first slice boundary after it ended.
    expect(fast.tick).toBe(Math.ceil(duration / 10) * 10);
    expect(fast.realMs).toBeLessThan(slow.realMs / 90);
  });

  it('refuses a saved aircraft that is serviced and not serviced at once', () => {
    const engine = justLanded();
    const snapshot = engine.snapshot();
    const broken = (change: Partial<AircraftState>): WorldSnapshot => ({
      ...snapshot,
      fleet: {
        ...snapshot.fleet,
        aircraft: snapshot.fleet.aircraft.map((aircraft) =>
          aircraft.id === TRANSPORT ? { ...aircraft, ...change } : aircraft,
        ),
      },
    });
    const turnaround = aircraftOf(engine).service;
    if (!turnaround) throw new Error('setup');
    expect(() => SimulationEngine.restore(broken({ service: null }))).toThrow(WorldRestoreError);
    expect(() => SimulationEngine.restore(broken({ status: 'available' }))).toThrow(
      WorldRestoreError,
    );
    expect(() =>
      SimulationEngine.restore(broken({ service: { ...turnaround, stage: 'refuelling' } })),
    ).toThrow(WorldRestoreError);
    expect(() => SimulationEngine.restore(snapshot)).not.toThrow();
  });

  it('upgrades a model-6 world: nothing is being serviced, and the new rules apply from then on', () => {
    // A world as model 6 left it: a flight in the air, a mission accepted for another aircraft
    // whose tanks are full, and no aircraft with a service record.
    const engine = world('model-6');
    engine.applyCommand(toExeter());
    engine.runSteps(600);
    const current = copyOf(engine.snapshot());
    const without = (value: object, key: string) =>
      Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
    const jet = aircraftOf(engine, JET);
    const config = defaultConfiguration(
      'training',
      {
        ...defaultBrief(MISSION_TEMPLATES.training),
        target: { name: 'North', lat: 56.4, lon: -5.6 },
      },
      jet,
      { context: engine.planContext() },
    );
    const accepted = {
      id: 'MSN-000001',
      type: 'training',
      source: 'manual',
      status: 'accepted',
      createdTick: 500,
      acceptedTick: 500,
      actualStartTick: null,
      completedTick: null,
      expiresTick: null,
      flightId: null,
      acceptance: null,
      assessment: null,
      outcome: null,
      ...config,
      objectives: config.objectives.map((objective, index) => ({
        id: `O${index + 1}`,
        status: 'pending',
        progress: 0,
        remark: null,
        ...objective,
      })),
    };
    const snapshot = {
      ...current,
      modelVersion: 6,
      fleet: {
        ...current.fleet,
        aircraft: current.fleet.aircraft.map((aircraft) => without(aircraft, 'service')),
      },
      missions: { ...current.missions, missions: [accepted], nextNumber: 2 },
    };
    const savedAt = engine.clock.tick;
    const upgraded = SimulationEngine.restore(snapshot as never);
    expect(upgraded.snapshot().modelVersion).toBe(SIM_MODEL_VERSION);
    expect(SIM_MODEL_VERSION).toBe(7);
    // What was logged under the old rules is kept; replay starts at the upgrade.
    expect(upgraded.snapshot().log.completeFromTick).toBe(savedAt);
    for (const aircraft of upgraded.snapshot().fleet.aircraft) {
      expect(aircraft.service).toBeNull();
    }
    expect(aircraftOf(upgraded, JET).status).toBe('available');

    // The accepted mission's aircraft holds full tanks, not the mission's fuel. Under model 6 the
    // launch would have set the fuel; from the upgrade it must be loaded, and the launch says so.
    expect(config.load?.fuelKg).toBeLessThan(jet.fuelKg);
    expect(() => launchMission(upgraded, 'MSN-000001')).toThrow(/the flight departs with/);
    fuelled(upgraded, JET, config.load?.fuelKg as number);
    expect(launchMission(upgraded, 'MSN-000001')).toBe(true);

    // The flight that was airborne at the upgrade lands into a turnaround.
    while (aircraftOf(upgraded).activeFlightId !== null) upgraded.runSteps(1);
    const landing = events(upgraded, 'flightCompleted').find(
      (entry) => entry.aircraftId === TRANSPORT,
    );
    expect(landing?.payload).toHaveProperty('turnaroundS');
    expect(
      events(upgraded, 'servicingStarted').find((entry) => entry.aircraftId === TRANSPORT),
    ).toMatchObject({ tick: landing?.tick, payload: { reason: 'turnaround' } });
  });
});

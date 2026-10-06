import { GROUND_SERVICE, payloadDurationS, transferDurationS } from '@aegis/domain';
import { SimulationEngine, type AircraftState } from '@aegis/sim';
import {
  FIXTURES,
  fixtureLaunchFull,
  fixtureOrder,
  fuelled,
  untilServiced,
} from '@aegis/sim/testing';
import { describe, expect, it } from 'vitest';
import {
  aerodromeView,
  groundActivity,
  groundForecasts,
  groundServiceView,
  launchState,
  serviceRequest,
} from './ground-logic';

/*
 * What the screens say about ground servicing (ADR 0027, ADR 0028). Everything is read from
 * worlds the simulation produced, so what is shown is checked against what then happens.
 */

const { places, models } = FIXTURES;
const A = 'AEGIS-TR-001';
const B = 'AEGIS-TR-002';
const CAPACITY = models.transport.fuelCapacityKg;

/** Two transports at Newquay, which has no size class recorded: one fuel point, one for payload. */
function world(): SimulationEngine {
  const engine = SimulationEngine.create({ seed: 'ground-logic', epoch: FIXTURES.epoch });
  engine.applyCommand({
    type: 'seedStarterFleet',
    aircraft: [
      fixtureOrder('transport', places.newquay),
      fixtureOrder('transport', places.newquay),
    ],
  });
  return engine;
}
const fleetOf = (engine: SimulationEngine) => engine.snapshot().fleet.aircraft;
const aircraftOf = (engine: SimulationEngine, id = A): AircraftState => {
  const found = fleetOf(engine).find((each) => each.id === id);
  if (!found) throw new Error(`no aircraft ${id}`);
  return found;
};
const service = (engine: SimulationEngine, fuelKg: number, id = A, payloadKg?: number) =>
  engine.applyCommand({
    type: 'serviceAircraft',
    aircraftId: id,
    fuelKg,
    ...(payloadKg !== undefined && { payloadKg }),
  });
const shown = (engine: SimulationEngine, id = A) =>
  groundServiceView(aircraftOf(engine, id), fleetOf(engine), engine.clock.tick);

describe('describing a ground service', () => {
  it('says nothing of an aircraft that is not being serviced', () => {
    const engine = world();
    expect(groundActivity(aircraftOf(engine), null)).toBeNull();
    expect(shown(engine)).toBeNull();
  });

  it('names each stage, says what follows, and offers only what can be stopped', () => {
    const engine = world();
    engine.applyCommand(fixtureLaunchFull(A, models.transport, places.newquay, places.exeter));
    while (aircraftOf(engine).activeFlightId !== null) engine.runSteps(1);
    const checks = shown(engine);
    expect(checks).toMatchObject({ activity: 'Post-flight checks', stop: null, tasks: [] });
    expect(checks?.detail).toMatch(
      /^Checked after its flight\. Available in \d+ min, with the fuel/,
    );

    // Fuel asked for during the checks: it follows them, and the request can be withdrawn.
    service(engine, 30_000);
    const queued = shown(engine);
    expect(queued?.detail).toMatch(/then prepared: fuel\. Available in \d+ min\./);
    expect(queued?.tasks).toMatchObject([{ label: 'Fuel', state: 'After the checks' }]);
    expect(queued?.stop?.label).toBe('Withdraw the request');
    const completeTick = queued?.progress.completeTick as number;

    engine.runSteps((aircraftOf(engine).service?.checksCompleteTick as number) - engine.clock.tick);
    expect(shown(engine)).toMatchObject({
      activity: 'Taking fuel off',
      tasks: [{ label: 'Fuel', state: 'Connecting' }],
    });
    engine.runSteps(GROUND_SERVICE.refuel.connectS + 60);
    const flowing = shown(engine);
    expect(flowing?.tasks[0]).toMatchObject({ state: 'Coming off', done: false });
    expect(flowing?.tasks[0]?.detail).toMatch(/^[\d,]+ kg to take off; done in \d+ min$/);
    expect(flowing?.stop?.label).toBe('Stop servicing');
    expect(flowing?.progress.fraction).toBeGreaterThan(checks?.progress.fraction ?? 1);

    // What was shown as the end is when it ends.
    engine.runSteps(completeTick - engine.clock.tick - 1);
    expect(aircraftOf(engine).status).toBe('servicing');
    engine.runSteps(1);
    expect(aircraftOf(engine)).toMatchObject({ status: 'available', fuelKg: 30_000 });
  });

  it('tells a waiting aircraft what it waits for, behind whom, and when its turn comes', () => {
    const engine = world();
    service(engine, 30_000, A);
    engine.runSteps(120);
    service(engine, 40_000, B);
    const waiting = shown(engine, B);
    const turn = (aircraftOf(engine, A).service?.fuel?.transfer?.completeTick as number) - 120;
    expect(waiting?.activity).toBe(`Waiting for a fuel point, behind ${A}`);
    expect(waiting?.detail).toMatch(
      new RegExp(
        `^Nothing is being done about the fuel: the aerodrome's fuel point is in use by ${A}\\.`,
      ),
    );
    expect(waiting?.tasks[0]).toMatchObject({ state: 'Waiting, next in the queue', done: false });
    expect(waiting?.tasks[0]?.detail).toContain(`The fuel point is in use by ${A}.`);
    // No progress is shown that is not being made: B's fuel has not moved.
    expect(waiting?.progress.fuelKg).toBe(CAPACITY);
    expect(waiting?.progress.fuel).toMatchObject({ startTick: 120 + turn, position: 1, behind: A });

    // What it was told is what happens: it gets the point at that tick, and not before.
    const forecast = groundForecasts(fleetOf(engine), engine.clock.tick).get(B);
    engine.runSteps(turn - 1);
    expect(aircraftOf(engine, B).service?.fuel?.transfer).toBeNull();
    engine.runSteps(1);
    expect(aircraftOf(engine, B).service?.fuel?.transfer?.startTick).toBe(120 + turn);
    expect(shown(engine, B)?.activity).toBe('Taking fuel off');
    untilServiced(engine, B);
    expect(engine.clock.tick).toBe(forecast?.completeTick);
  });
});

describe('asking for fuel and payload', () => {
  it('quotes the time the simulation then takes, the two side by side', () => {
    const engine = world();
    fuelled(engine, A, 20_000);
    const request = serviceRequest(aircraftOf(engine), 44_000, 9000);
    const fuelS = transferDurationS(CAPACITY, 20_000, 44_000);
    const payloadS = payloadDurationS(30, 0, 9000);
    expect(request).toEqual({
      allowed: true,
      durationS: Math.max(fuelS, payloadS),
      message:
        'Loads 24,000 kg of fuel in about 15 min and loads 9,000 kg of payload in about 10 min, once the aerodrome has a point free.',
    });
    const from = engine.clock.tick;
    fuelled(engine, A, 44_000, 9000);
    expect(engine.clock.tick - from).toBe(request.durationS);
    expect(aircraftOf(engine)).toMatchObject({ fuelKg: 44_000, payloadKg: 9000 });
  });

  it('is refused for the reasons the simulation would refuse it', () => {
    const engine = world();
    const aircraft = aircraftOf(engine);
    const refused = (subject: AircraftState, fuelKg: number, payloadKg = 0) => {
      const request = serviceRequest(subject, fuelKg, payloadKg);
      expect(request.allowed).toBe(false);
      expect(request.durationS).toBeNull();
      return request.message;
    };
    expect(refused(aircraft, aircraft.fuelKg)).toMatch(/already holds/);
    expect(refused(aircraft, CAPACITY + 500)).toMatch(/The tanks hold/);
    expect(refused(aircraft, 1000, models.transport.maxPayloadKg + 500)).toMatch(/carries at most/);
    expect(refused(aircraft, -5)).toMatch(/zero or more/);
    expect(refused({ ...aircraft, status: 'maintenance_due' }, 100)).toMatch(
      /Maintenance comes first/,
    );
    expect(refused({ ...aircraft, status: 'unserviceable' }, 100)).toMatch(/Unserviceable/);
    expect(refused({ ...aircraft, status: 'in_flight', location: null }, 100)).toMatch(/Airborne/);
    expect(refused({ ...aircraft, performance: null }, 100)).toMatch(/No performance model/);
    expect(
      refused({ ...aircraft, location: { ...places.newquay, kind: 'waypoint' } }, 100),
    ).toMatch(/Not at an aerodrome/);
    // Every one of them is a command the simulation rejects, or one that does nothing.
    expect(() => service(engine, CAPACITY + 500)).toThrow();
    expect(() => service(engine, 1000, A, models.transport.maxPayloadKg + 500)).toThrow(
      /more payload than/,
    );
    expect(service(engine, aircraft.fuelKg)).toBe(false);

    service(engine, 30_000);
    expect(refused(aircraftOf(engine), 30_000)).toMatch(/already being brought to/);
    expect(serviceRequest(aircraftOf(engine), 35_000, 0).allowed).toBe(true);
  });
});

describe('whether a load can be launched', () => {
  const need = { fuelKg: 30_000, payloadKg: 6000, origin: places.newquay };

  it('sets out what is missing, offers it, and then says when it will be ready', () => {
    const engine = world();
    const short = launchState(aircraftOf(engine), need, engine.clock.tick, fleetOf(engine));
    expect(short).toMatchObject({
      prepare: { fuelKg: 30_000, payloadKg: 6000 },
      prepareS: transferDurationS(CAPACITY, CAPACITY, 30_000),
      readyTick: null,
    });
    expect(short?.issues).toHaveLength(2);
    expect(short?.lines.map((line) => [line.label, line.ok])).toEqual([
      ['Aircraft', true],
      ['Fuel', false],
      ['Payload', false],
      ['Ground resource', true],
    ]);

    service(engine, need.fuelKg, A, need.payloadKg);
    const preparing = launchState(aircraftOf(engine), need, engine.clock.tick, fleetOf(engine));
    expect(preparing).toMatchObject({
      prepare: null,
      readyTick: engine.clock.tick + (short?.prepareS ?? 0),
    });
    expect(preparing?.lines[1]?.value).toMatch(/^Connecting: /);
    expect(preparing?.lines[2]?.value).toMatch(/^Positioning: /);
    untilServiced(engine, A);
    expect(engine.clock.tick).toBe(preparing?.readyTick);
    const ready = launchState(aircraftOf(engine), need, engine.clock.tick, fleetOf(engine));
    expect(ready).toMatchObject({ readiness: { ready: true }, issues: [], prepare: null });
    expect(ready?.lines.every((line) => line.ok)).toBe(true);
  });

  it('names the resource in use and who is using it', () => {
    const engine = world();
    service(engine, 30_000, A);
    service(engine, need.fuelKg, B, need.payloadKg);
    const waiting = launchState(aircraftOf(engine, B), need, engine.clock.tick, fleetOf(engine));
    expect(waiting?.lines[3]).toEqual({
      label: 'Ground resource',
      value: `Fuel point in use by ${A}`,
      ok: false,
    });
    // Its payload does not wait for the fuel point: that is another resource.
    expect(waiting?.lines[2]?.value).toMatch(/^Positioning: /);
    expect(waiting?.readyTick).toBe(
      groundForecasts(fleetOf(engine), engine.clock.tick).get(B)?.completeTick,
    );
  });

  it('offers nothing when servicing could not help, and knows nothing of no aircraft', () => {
    const engine = world();
    const due = { ...aircraftOf(engine), status: 'maintenance_due' as const };
    const state = launchState(due, need, 0);
    expect(state?.prepare).toBeNull();
    expect(state?.issues[0]).toMatch(/due maintenance/);
    expect(state?.lines[0]).toMatchObject({ label: 'Aircraft', ok: false });
    expect(launchState(undefined, need, 0)).toBeNull();
  });
});

describe('an aerodrome as a place where aircraft are serviced', () => {
  it('shows what it is assumed to be able to do, what is in use, and who waits', () => {
    const engine = world();
    const idle = aerodromeView(places.newquay, fleetOf(engine), 0);
    expect(idle.sizeLabel).toBe('Size class not recorded');
    expect(idle.aircraft.map((each) => each.id)).toEqual([A, B]);
    expect(idle.resources).toMatchObject([
      { kind: 'fuel', points: 1, inUseBy: [], waiting: [] },
      { kind: 'handling', points: 1, inUseBy: [], waiting: [] },
    ]);
    expect(idle.statement).toContain('assumed from its size class alone');

    service(engine, 30_000, A);
    service(engine, 40_000, B, 5000);
    const busy = aerodromeView(places.newquay, fleetOf(engine), engine.clock.tick);
    expect(busy.resources).toMatchObject([
      { kind: 'fuel', inUseBy: [A], waiting: [B] },
      { kind: 'handling', inUseBy: [B], waiting: [] },
    ]);
    // Somewhere else, nothing of this.
    expect(aerodromeView(places.exeter, fleetOf(engine), engine.clock.tick)).toMatchObject({
      aircraft: [],
      resources: [{ inUseBy: [] }, { inUseBy: [] }],
    });
    expect(aerodromeView({ ...places.exeter, size: 'large' }, fleetOf(engine), 0)).toMatchObject({
      sizeLabel: 'Large airport',
      resources: [{ points: 2 }, { points: 2 }],
    });
    expect(
      aerodromeView({ ...places.exeter, kind: 'waypoint' }, fleetOf(engine), 0).resources,
    ).toEqual([]);
  });
});

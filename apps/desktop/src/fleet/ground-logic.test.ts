import { GROUND_SERVICE, transferDurationS } from '@aegis/domain';
import { SimulationEngine, type AircraftState } from '@aegis/sim';
import {
  FIXTURES,
  fixtureLaunchFull,
  fixtureOrder,
  fuelled,
  untilServiced,
} from '@aegis/sim/testing';
import { describe, expect, it } from 'vitest';
import { fuelRequest, groundActivity, groundServiceView, launchState } from './ground-logic';

/*
 * What the screens say about ground servicing (ADR 0027). Everything is read from worlds the
 * simulation produced, so what is shown is checked against what then happens.
 */

const { places, models } = FIXTURES;
const TRANSPORT = 'AEGIS-TR-001';
const CAPACITY = models.transport.fuelCapacityKg;

function world(): SimulationEngine {
  const engine = SimulationEngine.create({ seed: 'ground-logic', epoch: FIXTURES.epoch });
  engine.applyCommand({
    type: 'seedStarterFleet',
    aircraft: [fixtureOrder('transport', places.newquay)],
  });
  return engine;
}
const transport = (engine: SimulationEngine): AircraftState => {
  const found = engine.snapshot().fleet.aircraft[0];
  if (!found) throw new Error('no aircraft');
  return found;
};
function landed(): SimulationEngine {
  const engine = world();
  engine.applyCommand(
    fixtureLaunchFull(TRANSPORT, models.transport, places.newquay, places.exeter),
  );
  while (transport(engine).activeFlightId !== null) engine.runSteps(1);
  return engine;
}
const service = (engine: SimulationEngine, fuelKg: number) =>
  engine.applyCommand({ type: 'serviceAircraft', aircraftId: TRANSPORT, fuelKg });

describe('describing a ground service', () => {
  it('says nothing of an aircraft that is not being serviced', () => {
    const engine = world();
    expect(groundActivity(transport(engine))).toBeNull();
    expect(groundServiceView(transport(engine), engine.clock.tick)).toBeNull();
  });

  it('names each stage, says what follows, and offers only what can be stopped', () => {
    const engine = landed();
    const checks = groundServiceView(transport(engine), engine.clock.tick);
    expect(checks).toMatchObject({ activity: 'Post-flight checks', stop: null });
    expect(checks?.detail).toMatch(
      /^Checked after its flight\. Available in \d+ min, with the fuel/,
    );

    // Fuel asked for during the checks: it follows them, and the request can be withdrawn.
    service(engine, 30_000);
    const queued = groundServiceView(transport(engine), engine.clock.tick);
    expect(queued?.detail).toMatch(/then fuel is taken off to 30,000 kg\. Available in \d+ min\./);
    expect(queued?.stop?.label).toBe('Withdraw the fuel request');
    // What is shown as the end is when it ends.
    const completeTick = queued?.progress.completeTick as number;

    engine.runSteps((transport(engine).service?.checksCompleteTick as number) - engine.clock.tick);
    const connecting = groundServiceView(transport(engine), engine.clock.tick);
    expect(connecting).toMatchObject({
      activity: 'Taking fuel off',
      progress: { connecting: true },
    });
    expect(connecting?.detail).toMatch(
      /^Connecting\. [\d,]+ kg to take off; available in \d+ min\.$/,
    );

    engine.runSteps(GROUND_SERVICE.refuel.connectS + 60);
    const flowing = groundServiceView(transport(engine), engine.clock.tick);
    expect(flowing?.detail).toMatch(/^[\d,]+ kg still to take off\. Available in \d+ min\.$/);
    expect(flowing?.stop?.label).toBe('Stop taking fuel off');
    expect(flowing?.progress.fraction).toBeGreaterThan(checks?.progress.fraction ?? 1);

    engine.runSteps(completeTick - engine.clock.tick - 1);
    expect(transport(engine).status).toBe('servicing');
    engine.runSteps(1);
    expect(transport(engine)).toMatchObject({ status: 'available', fuelKg: 30_000 });
  });

  it('calls loading fuel refuelling', () => {
    const engine = world();
    fuelled(engine, TRANSPORT, 20_000);
    service(engine, 40_000);
    expect(groundActivity(transport(engine))).toBe('Refuelling');
    engine.runSteps(GROUND_SERVICE.refuel.connectS + 10);
    const view = groundServiceView(transport(engine), engine.clock.tick);
    expect(view?.detail).toMatch(/kg still to load/);
    expect(view?.stop?.label).toBe('Stop refuelling');
  });
});

describe('asking for fuel', () => {
  it('quotes the time the simulation then takes', () => {
    const engine = world();
    fuelled(engine, TRANSPORT, 20_000);
    const request = fuelRequest(transport(engine), 44_000);
    expect(request).toEqual({
      allowed: true,
      durationS: transferDurationS(CAPACITY, 20_000, 44_000),
      message: 'Loads 24,000 kg in about 15 min.',
    });
    const from = engine.clock.tick;
    fuelled(engine, TRANSPORT, 44_000);
    expect(engine.clock.tick - from).toBe(request.durationS);
    expect(fuelRequest(transport(engine), 40_000).message).toMatch(/^Takes 4,000 kg off in about/);
  });

  it('is refused for the reasons the simulation would refuse it', () => {
    const engine = world();
    const aircraft = transport(engine);
    const refused = (subject: AircraftState, fuelKg: number) => {
      const request = fuelRequest(subject, fuelKg);
      expect(request.allowed).toBe(false);
      expect(request.durationS).toBeNull();
      return request.message;
    };
    expect(refused(aircraft, aircraft.fuelKg)).toMatch(/already holds/);
    expect(refused(aircraft, CAPACITY + 500)).toMatch(/The tanks hold/);
    expect(refused(aircraft, -5)).toMatch(/zero or more/);
    expect(refused({ ...aircraft, status: 'maintenance_due' }, 100)).toMatch(
      /Maintenance comes first/,
    );
    expect(refused({ ...aircraft, status: 'unserviceable' }, 100)).toMatch(/Unserviceable/);
    expect(refused({ ...aircraft, status: 'in_flight', location: null }, 100)).toMatch(/Airborne/);
    expect(refused({ ...aircraft, performance: null }, 100)).toMatch(/No performance model/);
    // Every one of them is a command the simulation rejects, or one that does nothing.
    expect(() => service(engine, CAPACITY + 500)).toThrow();
    expect(() => service(engine, -5)).toThrow();
    expect(service(engine, aircraft.fuelKg)).toBe(false);

    service(engine, 30_000);
    expect(refused(transport(engine), 30_000)).toMatch(/already being brought to 30,000 kg/);
    expect(fuelRequest(transport(engine), 35_000).allowed).toBe(true);
  });
});

describe('whether a load can be launched', () => {
  it('offers the fuel to ask for when fuel is all that is missing', () => {
    const engine = world();
    const need = { fuelKg: 30_000, origin: places.newquay };
    const short = launchState(transport(engine), need, engine.clock.tick);
    expect(short).toMatchObject({
      prepareFuelKg: 30_000,
      prepareS: transferDurationS(CAPACITY, CAPACITY, 30_000),
      readyTick: null,
    });
    expect(short?.readiness.ready).toBe(false);
    expect(short?.issues).toHaveLength(1);

    // Asked for: nothing more to do, and it says when it will be ready.
    service(engine, 30_000);
    const preparing = launchState(transport(engine), need, engine.clock.tick);
    expect(preparing).toMatchObject({
      prepareFuelKg: null,
      readyTick: engine.clock.tick + (short?.prepareS ?? 0),
    });
    untilServiced(engine, TRANSPORT);
    expect(engine.clock.tick).toBe(preparing?.readyTick);
    expect(launchState(transport(engine), need, engine.clock.tick)).toMatchObject({
      readiness: { ready: true },
      issues: [],
      prepareFuelKg: null,
    });
  });

  it('offers nothing when fuelling could not help, and knows nothing of no aircraft', () => {
    const engine = world();
    const due = { ...transport(engine), status: 'maintenance_due' as const };
    const state = launchState(due, { fuelKg: 30_000, origin: places.newquay }, 0);
    expect(state?.prepareFuelKg).toBeNull();
    expect(state?.issues[0]).toMatch(/due maintenance/);
    expect(launchState(undefined, { fuelKg: 1, origin: null }, 0)).toBeNull();
  });
});

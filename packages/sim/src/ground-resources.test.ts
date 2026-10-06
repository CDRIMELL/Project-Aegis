import {
  GROUND_SERVICE,
  MISSION_TEMPLATES,
  defaultBrief,
  forecastGroundServices,
  generatePlan,
  payloadDurationS,
  transferDurationS,
  type Mission,
  type RoutePoint,
} from '@aegis/domain';
import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine';
import { CommandRejected, type AircraftState } from './fleet';
import type { LogEntry } from './log';
import { defaultConfiguration } from './missions';
import { replayComparable, replayWorld } from './replay';
import { FIXTURES, fixtureLaunchFull, fixtureOrder, fuelled, untilServiced } from './testing';
import { SIM_MODEL_VERSION } from './world';

/*
 * Aerodrome capability, finite ground resources and timed payload (ADR 0028): two aircraft do not
 * use one point at once, the queue is real and is served in order, payload takes time like fuel,
 * and all of it survives a save and replays from the log.
 */

const { places, models } = FIXTURES;
const A = 'AEGIS-TR-001';
const B = 'AEGIS-TR-002';
const C = 'AEGIS-TR-003';
const CAPACITY = models.transport.fuelCapacityKg;
/** The payload rate assumed for an aerodrome with no size class recorded, or a medium one. */
const PAYLOAD_RATE = 30;
const copyOf = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const newWorld = (seed = 'ground-resources') => ({ seed, epoch: FIXTURES.epoch });

/** Three transports at one aerodrome. With no size class it has one fuel point and one for payload. */
function world(home: RoutePoint = places.newquay, seed?: string): SimulationEngine {
  const engine = SimulationEngine.create(newWorld(seed));
  engine.applyCommand({
    type: 'seedStarterFleet',
    aircraft: [
      fixtureOrder('transport', home),
      fixtureOrder('transport', home),
      fixtureOrder('transport', home),
    ],
  });
  return engine;
}
const aircraftOf = (engine: SimulationEngine, id = A): AircraftState => {
  const found = engine.snapshot().fleet.aircraft.find((aircraft) => aircraft.id === id);
  if (!found) throw new Error(`no aircraft ${id}`);
  return found;
};
const missionOf = (engine: SimulationEngine, id = 'MSN-000001'): Mission => {
  const found = engine.snapshot().missions.missions.find((mission) => mission.id === id);
  if (!found) throw new Error(`no mission ${id}`);
  return found;
};
const log = (engine: SimulationEngine): readonly LogEntry[] => engine.snapshot().log.entries;
const events = (engine: SimulationEngine, type: string, aircraftId?: string) =>
  log(engine).filter(
    (entry) => entry.type === type && (aircraftId === undefined || entry.aircraftId === aircraftId),
  );
const service = (engine: SimulationEngine, id: string, fuelKg: number, payloadKg?: number) =>
  engine.applyCommand({
    type: 'serviceAircraft',
    aircraftId: id,
    fuelKg,
    ...(payloadKg !== undefined && { payloadKg }),
  });
const stop = (engine: SimulationEngine, id: string) =>
  engine.applyCommand({ type: 'stopServicing', aircraftId: id });
const forecasts = (engine: SimulationEngine) =>
  forecastGroundServices(engine.snapshot().fleet.aircraft, engine.clock.tick);
const fuelTime = (toKg: number, fromKg = CAPACITY) => transferDurationS(CAPACITY, fromKg, toKg);

describe('one fuel point', () => {
  it('fuels one aircraft and makes the next wait: a real queue, with no progress for the one waiting', () => {
    const engine = world();
    service(engine, A, 30_000);
    engine.runSteps(100);
    expect(service(engine, B, 40_000)).toBe(true);
    const aDone = fuelTime(30_000);

    expect(aircraftOf(engine, A).service?.fuel?.transfer).toMatchObject({ completeTick: aDone });
    expect(aircraftOf(engine, B)).toMatchObject({
      status: 'servicing',
      fuelKg: CAPACITY,
      service: {
        stage: 'preparation',
        fuel: { targetKg: 40_000, queuedTick: 100, transfer: null },
      },
    });
    // The log says it is queued, for what, and behind whom.
    expect(events(engine, 'serviceQueued')).toMatchObject([
      {
        tick: 100,
        aircraftId: B,
        payload: { kind: 'fuel', position: 1, behind: A, startTick: aDone, at: 'EGHQ' },
      },
    ]);
    expect(events(engine, 'refuellingStarted', B)).toHaveLength(0);
    // And it cannot launch, for that reason.
    expect(() =>
      engine.applyCommand({
        type: 'launchFlight',
        aircraftId: B,
        plan: generatePlan(models.transport, places.newquay, places.exeter),
        load: { fuelKg: 40_000, payloadKg: 0 },
      }),
    ).toThrow(
      new RegExp(
        `${B} is waiting for a fuel point, behind ${A}\\. It will be available in \\d+ min`,
      ),
    );

    // Every tick until A is done: B holds what it held, and has no transfer.
    for (let tick = 101; tick < aDone; tick += 37) {
      engine.runSteps(tick - engine.clock.tick);
      expect(aircraftOf(engine, B).fuelKg).toBe(CAPACITY);
      expect(aircraftOf(engine, B).service?.fuel?.transfer).toBeNull();
    }
    engine.runSteps(aDone - 1 - engine.clock.tick);
    expect(aircraftOf(engine, B).service?.fuel?.transfer).toBeNull();

    // A finishes and gives the point up; B takes it in the same step.
    engine.runSteps(1);
    expect(aircraftOf(engine, A)).toMatchObject({ status: 'available', fuelKg: 30_000 });
    const bDone = aDone + fuelTime(40_000);
    expect(aircraftOf(engine, B).service?.fuel).toMatchObject({
      startedTick: aDone,
      transfer: { startTick: aDone, completeTick: bDone },
    });
    expect(events(engine, 'refuellingStarted', B)[0]).toMatchObject({
      tick: aDone,
      payload: { fromKg: CAPACITY, toKg: 40_000, waitedS: aDone - 100 },
    });
    engine.runSteps(bDone - engine.clock.tick - 1);
    expect(aircraftOf(engine, B).status).toBe('servicing');
    engine.runSteps(1);
    expect(aircraftOf(engine, B)).toMatchObject({ status: 'available', fuelKg: 40_000 });
    expect(events(engine, 'servicingCompleted', B)[0]?.payload).toMatchObject({
      durationS: bDone - 100,
      waitS: aDone - 100,
      refuelS: bDone - aDone,
      at: 'EGHQ',
    });
    expect(events(engine, 'servicingCompleted', A)[0]?.payload).toMatchObject({ waitS: 0 });
  });

  it('serves the queue in the order the aircraft began to wait, then by identifier', () => {
    const engine = world();
    service(engine, B, 30_000);
    engine.runSteps(50);
    // C asks before A: C is served before A, though A sorts first.
    service(engine, C, 44_000);
    engine.runSteps(10);
    service(engine, A, 50_000);
    const starts = () => events(engine, 'refuellingStarted').map((entry) => entry.aircraftId);
    expect(starts()).toEqual([B]);
    expect(events(engine, 'serviceQueued').map((entry) => entry.payload.position)).toEqual([1, 2]);
    expect(events(engine, 'serviceQueued')[1]?.payload).toMatchObject({ behind: C });
    untilServiced(engine, A);
    expect(starts()).toEqual([B, C, A]);

    // Asked in the same tick: by identifier.
    const tie = world();
    service(tie, C, 30_000);
    service(tie, B, 30_000);
    service(tie, A, 30_000);
    untilServiced(tie, A);
    untilServiced(tie, B);
    expect(events(tie, 'refuellingStarted').map((entry) => entry.aircraftId)).toEqual([C, A, B]);
  });

  it('gives the point to the next in the queue the moment it is stopped or given up', () => {
    const engine = world();
    service(engine, A, 30_000);
    service(engine, B, 40_000);
    service(engine, C, 44_000);
    engine.runSteps(400);
    // The one waiting gives up its place: it is available at once, and nothing was loaded.
    expect(stop(engine, B)).toBe(true);
    expect(aircraftOf(engine, B)).toMatchObject({
      status: 'available',
      fuelKg: CAPACITY,
      service: null,
    });
    expect(events(engine, 'refuellingStarted', B)).toHaveLength(0);
    expect(events(engine, 'servicingCompleted', B)[0]?.payload).toMatchObject({ loadedKg: 0 });
    expect(forecasts(engine).get(C)?.fuel).toMatchObject({ position: 1, behind: A });

    // The one fuelling stops: the point goes to C in the same tick, with no step between.
    expect(stop(engine, A)).toBe(true);
    expect(aircraftOf(engine, A).status).toBe('available');
    expect(aircraftOf(engine, C).service?.fuel?.transfer).toMatchObject({ startTick: 400 });
    expect(
      log(engine)
        .slice(-4)
        .map((entry) => entry.type),
    ).toEqual(['stopServicing', 'refuellingCompleted', 'servicingCompleted', 'refuellingStarted']);
  });
});

describe('more than one point', () => {
  it('fuels as many at once as the aerodrome has points, and no more', () => {
    const engine = world({ ...places.newquay, size: 'large' });
    service(engine, A, 30_000);
    service(engine, B, 40_000);
    service(engine, C, 44_000);
    expect(events(engine, 'refuellingStarted').map((entry) => entry.aircraftId)).toEqual([A, B]);
    // C waits for whichever point is free first: B's, which has less to take off.
    const bDone = fuelTime(40_000);
    expect(bDone).toBeLessThan(fuelTime(30_000));
    expect(events(engine, 'serviceQueued')[0]).toMatchObject({
      aircraftId: C,
      payload: { position: 1, behind: B, startTick: bDone },
    });
    engine.runSteps(bDone);
    expect(aircraftOf(engine, C).service?.fuel?.transfer?.startTick).toBe(bDone);
    expect(aircraftOf(engine, A).status).toBe('servicing');
  });

  it('is slower at a small aerodrome, and impossible where there is none', () => {
    const small = world({ ...places.newquay, size: 'small' });
    service(small, A, 30_000);
    expect(aircraftOf(small, A).service?.fuel?.transfer?.completeTick).toBe(
      transferDurationS(CAPACITY, CAPACITY, 30_000, 0.5),
    );
    expect(transferDurationS(CAPACITY, CAPACITY, 30_000, 0.5)).toBeGreaterThan(fuelTime(30_000));

    const field = world();
    const snapshot = field.snapshot();
    const stranded = SimulationEngine.restore({
      ...snapshot,
      fleet: {
        ...snapshot.fleet,
        aircraft: snapshot.fleet.aircraft.map((aircraft) =>
          aircraft.id === A
            ? { ...aircraft, location: { ...places.newquay, kind: 'waypoint', name: 'A field' } }
            : aircraft,
        ),
      },
    });
    expect(() => service(stranded, A, 30_000)).toThrow(
      /is at A field, which is not an aerodrome: nothing can be serviced there/,
    );
  });
});

describe('payload', () => {
  it('is loaded over simulated time, and the aircraft cannot launch until it is aboard', () => {
    const engine = world();
    const launch = {
      type: 'launchFlight' as const,
      aircraftId: A,
      plan: generatePlan(models.transport, places.newquay, places.exeter),
      load: { fuelKg: CAPACITY, payloadKg: 9000 },
    };
    const before = engine.snapshot();
    expect(() => engine.applyCommand(launch)).toThrow(
      /holds 0 kg of payload; the flight carries 9,000 kg\. Loading 9,000 kg takes 10 min\./,
    );
    expect(engine.snapshot()).toEqual(before);

    expect(service(engine, A, CAPACITY, 9000)).toBe(true);
    const duration = payloadDurationS(PAYLOAD_RATE, 0, 9000);
    expect(duration).toBe(GROUND_SERVICE.payload.positionS + 300);
    expect(aircraftOf(engine)).toMatchObject({
      status: 'servicing',
      payloadKg: 0,
      service: {
        fuel: null,
        payload: { targetKg: 9000, transfer: { fromKg: 0, toKg: 9000, completeTick: duration } },
      },
    });
    expect(
      log(engine)
        .slice(-2)
        .map((entry) => entry.type),
    ).toEqual(['servicingStarted', 'loadingStarted']);

    let last = 0;
    for (let tick = 1; tick < duration; tick++) {
      engine.runSteps(1);
      const now = aircraftOf(engine).payloadKg;
      if (tick <= GROUND_SERVICE.payload.positionS) expect(now).toBe(0);
      else expect(now).toBe(last + PAYLOAD_RATE);
      last = now;
      if (tick % 97 === 0) expect(() => engine.applyCommand(launch)).toThrow(/being loaded/);
    }
    engine.runSteps(1);
    expect(aircraftOf(engine)).toMatchObject({ status: 'available', payloadKg: 9000 });
    expect(events(engine, 'loadingCompleted')[0]).toMatchObject({
      tick: duration,
      payload: { payloadKg: 9000, loadedKg: 9000, durationS: duration },
    });
    expect(events(engine, 'servicingCompleted')[0]?.payload).toMatchObject({
      loadS: duration,
      refuelS: 0,
      payloadLoadedKg: 9000,
      payloadKg: 9000,
    });
    expect(engine.applyCommand(launch)).toBe(true);
    expect(engine.snapshot().fleet.flights[0]).toMatchObject({ payloadKg: 9000 });
  });

  it('is handled beside the fuel, on its own resource: neither waits for the other', () => {
    const engine = world();
    service(engine, A, 30_000, 9000);
    const fuelS = fuelTime(30_000);
    const payloadS = payloadDurationS(PAYLOAD_RATE, 0, 9000);
    expect(aircraftOf(engine).service).toMatchObject({
      fuel: { transfer: { startTick: 0, completeTick: fuelS } },
      payload: { transfer: { startTick: 0, completeTick: payloadS } },
    });
    engine.runSteps(payloadS);
    // The payload is done and its point given up; the aircraft is still being fuelled.
    expect(aircraftOf(engine)).toMatchObject({
      status: 'servicing',
      payloadKg: 9000,
      service: { payload: { completedTick: payloadS } },
    });
    // Another aircraft's payload starts at once, while its fuel waits behind A's.
    service(engine, B, 40_000, 3000);
    expect(aircraftOf(engine, B).service).toMatchObject({
      fuel: { transfer: null, queuedTick: payloadS },
      payload: { transfer: { startTick: payloadS } },
    });
    untilServiced(engine, A);
    expect(engine.clock.tick).toBe(Math.max(fuelS, payloadS));
  });

  it('waits for payload handling when another aircraft is using it', () => {
    const engine = world();
    service(engine, A, CAPACITY, 9000);
    service(engine, B, CAPACITY, 6000);
    const aDone = payloadDurationS(PAYLOAD_RATE, 0, 9000);
    expect(events(engine, 'serviceQueued')[0]).toMatchObject({
      aircraftId: B,
      payload: { kind: 'handling', position: 1, behind: A, startTick: aDone },
    });
    engine.runSteps(aDone);
    expect(aircraftOf(engine, B).payloadKg).toBe(0);
    expect(aircraftOf(engine, B).service?.payload?.transfer?.startTick).toBe(aDone);
    untilServiced(engine, B);
    expect(engine.clock.tick).toBe(aDone + payloadDurationS(PAYLOAD_RATE, 0, 6000));
  });

  it('stays aboard after a flight that did not deliver it, and takes time to take off', () => {
    const engine = world();
    fuelled(engine, A, CAPACITY, 6000);
    engine.applyCommand({
      ...fixtureLaunchFull(A, models.transport, places.newquay, places.exeter),
      load: { fuelKg: CAPACITY, payloadKg: 6000 },
    });
    while (aircraftOf(engine).activeFlightId !== null) engine.runSteps(1);
    untilServiced(engine, A);
    expect(aircraftOf(engine)).toMatchObject({ status: 'available', payloadKg: 6000 });
    const empty = {
      type: 'launchFlight' as const,
      aircraftId: A,
      plan: generatePlan(models.transport, places.exeter, places.newquay),
      load: { fuelKg: aircraftOf(engine).fuelKg, payloadKg: 0 },
    };
    expect(() => engine.applyCommand(empty)).toThrow(/Taking 6,000 kg off takes \d+ min/);
    const from = engine.clock.tick;
    fuelled(engine, A, empty.load.fuelKg, 0);
    expect(engine.clock.tick - from).toBe(payloadDurationS(PAYLOAD_RATE, 6000, 0));
    expect(engine.applyCommand(empty)).toBe(true);
  });

  it('refuses a payload the aircraft cannot carry', () => {
    const engine = world();
    expect(() => service(engine, A, CAPACITY, models.transport.maxPayloadKg + 1000)).toThrow(
      /more payload than AEGIS-TR-001 can carry/,
    );
    expect(() => service(engine, A, CAPACITY, -1)).toThrow(CommandRejected);
    // Nothing to do: it holds that fuel and that payload.
    expect(service(engine, A, CAPACITY, 0)).toBe(false);
  });
});

describe('what the forecast says is what happens', () => {
  it('for every aircraft at a busy aerodrome, fuel and payload both', () => {
    const engine = world();
    service(engine, A, 30_000, 9000);
    engine.runSteps(60);
    service(engine, B, 40_000, 6000);
    engine.runSteps(60);
    service(engine, C, 20_000, 3000);
    const said = forecasts(engine);
    expect(said.get(C)?.fuel).toMatchObject({ state: 'waiting', position: 2, behind: B });
    expect(said.get(C)?.payload).toMatchObject({ state: 'waiting', position: 2, behind: B });
    for (const id of [A, B, C]) untilServiced(engine, id);
    for (const id of [A, B, C]) {
      const forecast = said.get(id);
      expect(events(engine, 'servicingCompleted', id)[0]?.tick).toBe(forecast?.completeTick);
      expect(events(engine, 'refuellingStarted', id)[0]?.tick).toBe(forecast?.fuel?.startTick);
      expect(events(engine, 'loadingStarted', id)[0]?.tick).toBe(forecast?.payload?.startTick);
      expect(events(engine, 'refuellingCompleted', id)[0]?.tick).toBe(forecast?.fuel?.completeTick);
    }
    // Never more than one on a point of either kind at any tick: the transfers do not overlap.
    for (const type of ['refuelling', 'loading']) {
      const spans = [A, B, C]
        .map((id) => [
          events(engine, `${type}Started`, id)[0]?.tick as number,
          events(engine, `${type}Completed`, id)[0]?.tick as number,
        ])
        .sort((x, y) => (x[0] as number) - (y[0] as number));
      for (let i = 1; i < spans.length; i++) {
        expect(spans[i]?.[0]).toBeGreaterThanOrEqual(spans[i - 1]?.[1] as number);
      }
    }
  });

  it('counts an aircraft still in its checks in the order it will join the queue', () => {
    const engine = world();
    engine.applyCommand(fixtureLaunchFull(A, models.transport, places.newquay, places.exeter));
    engine.applyCommand(fixtureLaunchFull(B, models.transport, places.newquay, places.exeter));
    while (aircraftOf(engine, B).activeFlightId !== null) engine.runSteps(1);
    // Both have landed at Exeter and are in their checks. Fuel is asked for both.
    service(engine, A, 50_000);
    service(engine, B, 50_000);
    const said = forecasts(engine);
    expect(said.get(A)?.fuel?.state).toBe('behind_checks');
    expect(said.get(B)?.fuel).toMatchObject({ state: 'behind_checks', position: 1, behind: A });
    untilServiced(engine, A);
    untilServiced(engine, B);
    expect(events(engine, 'servicingCompleted', A)[0]?.tick).toBe(said.get(A)?.completeTick);
    expect(events(engine, 'servicingCompleted', B)[0]?.tick).toBe(said.get(B)?.completeTick);
    expect(events(engine, 'serviceQueued', B)).toHaveLength(1);
  });
});

function training(engine: SimulationEngine, id: string, plannedStartTick: number | null = null) {
  const before = new Set(engine.snapshot().missions.missions.map((each) => each.id));
  engine.applyCommand({
    type: 'createMission',
    missionType: 'training',
    ...defaultConfiguration(
      'training',
      {
        ...defaultBrief(MISSION_TEMPLATES.training),
        target: { name: 'Area', lat: 49.4, lon: -7.2 },
      },
      aircraftOf(engine, id),
      { context: engine.planContext(), plannedStartTick },
    ),
  });
  const made = engine.snapshot().missions.missions.find((each) => !before.has(each.id));
  if (!made) throw new Error('no mission');
  return made.id;
}

describe('missions, release and scheduled launches', () => {
  it('prepares two missions through one fuel point, one after the other', () => {
    const engine = world();
    const first = training(engine, A);
    const second = training(engine, B);
    engine.applyCommand({ type: 'acceptMission', missionId: first });
    engine.applyCommand({ type: 'acceptMission', missionId: second });
    expect(aircraftOf(engine, B).service).toMatchObject({
      missionId: second,
      fuel: { transfer: null, queuedTick: 0 },
    });
    expect(events(engine, 'serviceQueued')[0]).toMatchObject({ missionId: second, aircraftId: B });
    const said = forecasts(engine);
    const launch = (id: string) => () =>
      engine.applyCommand({ type: 'launchMission', missionId: id });
    expect(launch(second)).toThrow(/waiting for a fuel point, behind AEGIS-TR-001/);

    untilServiced(engine, A);
    expect(launch(first)()).toBe(true);
    // The first has gone; the second is still being fuelled and still cannot go.
    expect(launch(second)).toThrow(/having fuel taken off/);
    untilServiced(engine, B);
    expect(engine.clock.tick).toBe(said.get(B)?.completeTick);
    expect(launch(second)()).toBe(true);
    expect(missionOf(engine, second).actualStartTick).toBe(said.get(B)?.completeTick);
  });

  it('withdraws what has not begun when a mission is released, and frees the queue', () => {
    const engine = world();
    const first = training(engine, A);
    const second = training(engine, B);
    const third = training(engine, C);
    for (const id of [first, second, third]) {
      engine.applyCommand({ type: 'acceptMission', missionId: id });
    }
    engine.runSteps(200);
    expect(forecasts(engine).get(C)?.fuel).toMatchObject({ position: 2, behind: B });

    // B's mission is released while B is still waiting: nothing had begun, so nothing remains.
    engine.applyCommand({ type: 'releaseMission', missionId: second });
    expect(aircraftOf(engine, B)).toMatchObject({
      status: 'available',
      fuelKg: CAPACITY,
      service: null,
    });
    expect(log(engine).slice(-3)).toMatchObject([
      { type: 'releaseMission', kind: 'command' },
      { type: 'serviceWithdrawn', aircraftId: B, missionId: second, payload: { kinds: ['fuel'] } },
      { type: 'servicingCompleted', aircraftId: B },
    ]);
    // C moves up.
    expect(forecasts(engine).get(C)?.fuel).toMatchObject({ position: 1, behind: A });

    // A's mission is cancelled while A is being fuelled: what is under way goes on to its end,
    // and no longer for that mission.
    engine.applyCommand({ type: 'cancelMission', missionId: first });
    expect(aircraftOf(engine, A)).toMatchObject({
      status: 'servicing',
      service: {
        missionId: null,
        fuel: { transfer: { toKg: missionOf(engine, first).load?.fuelKg } },
      },
    });
    expect(events(engine, 'serviceWithdrawn', A)).toHaveLength(0);
    untilServiced(engine, A);
    expect(aircraftOf(engine, A).fuelKg).toBe(missionOf(engine, first).load?.fuelKg);
    // No point is left held by anything that is not being fuelled.
    untilServiced(engine, C);
    for (const aircraft of engine.snapshot().fleet.aircraft) {
      expect(aircraft).toMatchObject({ status: 'available', service: null });
    }
  });

  it('records a scheduled launch time that passes on the ground, once, with the reason', () => {
    const engine = world();
    // Scheduled before its aircraft can be ready: the preparation takes longer than that.
    const late = training(engine, A, 600);
    engine.applyCommand({ type: 'acceptMission', missionId: late });
    const readyTick = forecasts(engine).get(A)?.completeTick as number;
    expect(readyTick).toBeGreaterThan(600);
    engine.runSteps(599);
    expect(events(engine, 'launchDelayed')).toHaveLength(0);
    engine.runSteps(1);
    expect(events(engine, 'launchDelayed')).toMatchObject([
      {
        tick: 600,
        actor: 'world',
        missionId: late,
        aircraftId: A,
        payload: { scheduledTick: 600 },
      },
    ]);
    expect(events(engine, 'launchDelayed')[0]?.payload.reason).toMatch(
      /AEGIS-TR-001 is having fuel taken off\. It will be available in \d+ min\./,
    );
    // Nothing launched by itself, then or when it became ready.
    untilServiced(engine, A);
    engine.runSteps(600);
    expect(missionOf(engine, late)).toMatchObject({ status: 'accepted', actualStartTick: null });
    expect(events(engine, 'launchDelayed')).toHaveLength(1);
    engine.applyCommand({ type: 'launchMission', missionId: late });
    expect(missionOf(engine, late)).toMatchObject({
      plannedStartTick: 600,
      actualStartTick: readyTick + 600,
    });
  });

  it('says so when it was ready and simply not launched, and nothing when it left in time', () => {
    const engine = world();
    const ready = training(engine, A, 6000);
    const early = training(engine, B, 20_000);
    engine.applyCommand({ type: 'acceptMission', missionId: ready });
    engine.applyCommand({ type: 'acceptMission', missionId: early });
    untilServiced(engine, A);
    untilServiced(engine, B);
    expect(engine.clock.tick).toBeLessThan(6000);
    engine.applyCommand({ type: 'launchMission', missionId: early });
    engine.runSteps(21_000 - engine.clock.tick);
    expect(events(engine, 'launchDelayed')).toMatchObject([
      { tick: 6000, missionId: ready, payload: { reason: 'Ready, and not yet launched.' } },
    ]);
  });
});

/** A busy stretch on the ground: three aircraft, both resources, a stop and a retarget. */
function scripted(step: (engine: SimulationEngine, steps: number) => void): SimulationEngine {
  const engine = world(places.newquay, 'scripted-ground');
  step(engine, 30);
  service(engine, A, 30_000, 9000);
  step(engine, 45);
  service(engine, B, 40_000, 6000);
  step(engine, 45);
  service(engine, C, 20_000, 3000);
  step(engine, 700);
  service(engine, B, 45_000);
  step(engine, 400);
  stop(engine, A);
  while (aircraftOf(engine, C).status === 'servicing') step(engine, 1);
  step(engine, 500);
  return engine;
}
const oneAtATime = (engine: SimulationEngine, steps: number) => {
  for (let i = 0; i < steps; i++) engine.runSteps(1);
};

describe('determinism, continuity and upgrade', { timeout: 60_000 }, () => {
  const reference = scripted(oneAtATime);

  it('gives the same world however the steps are batched, and replays from its log', () => {
    const batched = scripted((engine, steps) => {
      engine.runSteps(steps);
    });
    expect(batched.snapshot()).toEqual(reference.snapshot());
    const replayed = replayWorld(newWorld('scripted-ground'), log(reference), reference.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(reference.snapshot()));
    expect(log(replayed)).toEqual(log(reference));
    expect(new Set(log(reference).map((entry) => entry.type))).toEqual(
      new Set([
        'seedStarterFleet',
        'serviceAircraft',
        'servicingStarted',
        'serviceQueued',
        'refuellingStarted',
        'refuellingCompleted',
        'loadingStarted',
        'loadingCompleted',
        'stopServicing',
        'servicingCompleted',
      ]),
    );
  });

  it('continues exactly from a save made while aircraft wait, fuel and load', () => {
    const final = reference.clock.tick;
    const commands = log(reference).filter((entry) => entry.kind === 'command');
    const live = world(places.newquay, 'scripted-ground');
    let next = 1;
    const applyDue = (engine: SimulationEngine, from: number) => {
      let index = from;
      for (; index < commands.length && commands[index]?.tick === engine.clock.tick; index++) {
        engine.applyCommand(commands[index]?.payload as never);
      }
      return index;
    };
    const seen = { waiting: 0, fuelling: 0, loading: 0 };
    while (live.clock.tick < final) {
      next = applyDue(live, next);
      if (live.clock.tick % 61 === 0) {
        const fleet = live.snapshot().fleet.aircraft;
        if (fleet.some((each) => each.service?.fuel && !each.service.fuel.transfer))
          seen.waiting += 1;
        if (fleet.some((each) => each.service?.fuel?.transfer)) seen.fuelling += 1;
        if (fleet.some((each) => each.service?.payload?.transfer)) seen.loading += 1;
        const resumed = SimulationEngine.restore(copyOf(live.snapshot()));
        // Occupancy and queue are as saved: they are the aircraft's own records.
        expect(resumed.snapshot().fleet).toEqual(live.snapshot().fleet);
        expect(
          forecastGroundServices(resumed.snapshot().fleet.aircraft, resumed.clock.tick),
        ).toEqual(forecasts(live));
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
    expect(seen.waiting).toBeGreaterThan(5);
    expect(seen.fuelling).toBeGreaterThan(5);
    expect(seen.loading).toBeGreaterThan(5);
  });

  it('upgrades a model-7 world: a service under way goes on to the same tick and the same fuel', () => {
    // Two worlds as model 7 saved them: one part-way through a fuel transfer, and one in its
    // post-flight checks with fuel asked for after.
    const fuelling = world();
    service(fuelling, A, 30_000);
    fuelling.runSteps(700);
    const checking = world();
    checking.applyCommand(fixtureLaunchFull(A, models.transport, places.newquay, places.exeter));
    while (aircraftOf(checking).activeFlightId !== null) checking.runSteps(1);
    service(checking, A, 50_000);

    for (const current of [fuelling, checking]) {
      const snapshot = copyOf(current.snapshot());
      const asModel7 = {
        ...snapshot,
        modelVersion: 7,
        fleet: {
          ...snapshot.fleet,
          aircraft: snapshot.fleet.aircraft.map((aircraft) => {
            const now = aircraft.service;
            if (!now) return aircraft;
            return {
              ...aircraft,
              service: {
                reason: now.reason,
                startedTick: now.startedTick,
                stage: now.stage === 'preparation' ? 'refuelling' : 'checks',
                checksCompleteTick: now.checksCompleteTick,
                fuelAtStartKg: now.fuelAtStartKg,
                targetFuelKg: now.fuel?.targetKg ?? null,
                transfer: now.fuel?.transfer ?? null,
                refuellingSinceTick: now.fuel?.startedTick ?? null,
                missionId: now.missionId,
              },
            };
          }),
        },
      };
      const upgraded = SimulationEngine.restore(asModel7 as never);
      expect(upgraded.snapshot().modelVersion).toBe(SIM_MODEL_VERSION);
      expect(SIM_MODEL_VERSION).toBe(9);
      expect(upgraded.snapshot().log.completeFromTick).toBe(current.clock.tick);
      // Carried over as it stood: the record this build would have written.
      expect(aircraftOf(upgraded)).toEqual(aircraftOf(current));
      const said = forecasts(current).get(A)?.completeTick as number;
      untilServiced(upgraded, A);
      untilServiced(current, A);
      expect(upgraded.clock.tick).toBe(said);
      expect(aircraftOf(upgraded)).toEqual(aircraftOf(current));
    }
  });
});

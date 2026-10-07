import {
  GROUND_SERVICE,
  MISSION_TEMPLATES,
  aerodromeCapability,
  defaultBrief,
  forecastGroundServices,
  generatePlan,
  payloadDurationS,
  type AerodromeSize,
  type Mission,
  type MissionBrief,
  type MissionType,
  type RoutePoint,
} from '@aegis/domain';
import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine';
import { CommandRejected, MAINTENANCE, type AircraftState } from './fleet';
import type { LogEntry } from './log';
import { defaultConfiguration } from './missions';
import { replayComparable, replayWorld } from './replay';
import { FIXTURES, fixtureLaunchFull, fixtureOrder, untilServiced } from './testing';
import { SIM_MODEL_VERSION } from './world';

/*
 * Phase 8D (ADR 0029): a delivered payload is taken off by the turnaround, in its turn at the
 * aerodrome's payload handling, and the aircraft is available when that is done; and aerodromes
 * a world holds without a size class are given the one the reference data has, and no other.
 */

const { places, models } = FIXTURES;
const A = 'AEGIS-TR-001';
const B = 'AEGIS-TR-002';
/** The payload rate assumed where no size class is recorded, or for a medium aerodrome. */
const PAYLOAD_RATE = 30;
const copyOf = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const newWorld = (seed = 'delivery') => ({ seed, epoch: FIXTURES.epoch });

function world(seed?: string): SimulationEngine {
  const engine = SimulationEngine.create(newWorld(seed));
  engine.applyCommand({
    type: 'seedStarterFleet',
    aircraft: [
      fixtureOrder('transport', places.newquay),
      fixtureOrder('transport', places.newquay),
    ],
  });
  return engine;
}
const aircraftOf = (engine: SimulationEngine, id = A): AircraftState => {
  const found = engine.snapshot().fleet.aircraft.find((aircraft) => aircraft.id === id);
  if (!found) throw new Error(`no aircraft ${id}`);
  return found;
};
const missionOf = (engine: SimulationEngine, id: string): Mission => {
  const found = engine.snapshot().missions.missions.find((mission) => mission.id === id);
  if (!found) throw new Error(`no mission ${id}`);
  return found;
};
const log = (engine: SimulationEngine): readonly LogEntry[] => engine.snapshot().log.entries;
const events = (engine: SimulationEngine, type: string, aircraftId?: string) =>
  log(engine).filter(
    (entry) => entry.type === type && (aircraftId === undefined || entry.aircraftId === aircraftId),
  );
const forecasts = (engine: SimulationEngine) =>
  forecastGroundServices(engine.snapshot().fleet.aircraft, engine.clock.tick);

function mission(
  engine: SimulationEngine,
  type: MissionType,
  aircraftId: string,
  brief: Partial<MissionBrief>,
): string {
  const before = new Set(engine.snapshot().missions.missions.map((each) => each.id));
  engine.applyCommand({
    type: 'createMission',
    missionType: type,
    ...defaultConfiguration(
      type,
      { ...defaultBrief(MISSION_TEMPLATES[type]), ...brief },
      aircraftOf(engine, aircraftId),
      { context: engine.planContext() },
    ),
  });
  const made = engine.snapshot().missions.missions.find((each) => !before.has(each.id));
  if (!made) throw new Error('no mission');
  return made.id;
}
/** A delivery to Exeter, accepted and with its aircraft prepared: ready to launch. */
function delivery(engine: SimulationEngine, aircraftId: string, payloadKg: number): string {
  const id = mission(engine, 'logistics', aircraftId, { destination: places.exeter, payloadKg });
  engine.applyCommand({ type: 'acceptMission', missionId: id });
  return id;
}
const launch = (engine: SimulationEngine, missionId: string) =>
  engine.applyCommand({ type: 'launchMission', missionId });
function untilLanded(engine: SimulationEngine, aircraftId: string): number {
  while (aircraftOf(engine, aircraftId).activeFlightId !== null) engine.runSteps(1);
  return engine.clock.tick;
}

describe('a delivered payload', () => {
  it('is delivered when the aircraft lands, and taken off by its turnaround over time', () => {
    const engine = world();
    const id = delivery(engine, A, 9000);
    untilServiced(engine, A);
    launch(engine, id);
    const landed = untilLanded(engine, A);

    // The mission is complete: the payload reached its destination. It is not yet off the aircraft.
    expect(missionOf(engine, id)).toMatchObject({ status: 'completed', completedTick: landed });
    const checksEnd = aircraftOf(engine).service?.checksCompleteTick as number;
    expect(aircraftOf(engine)).toMatchObject({
      status: 'servicing',
      payloadKg: 9000,
      service: {
        reason: 'turnaround',
        stage: 'checks',
        payloadAtStartKg: 9000,
        fuel: null,
        payload: { targetKg: 0, queuedTick: null, transfer: null },
      },
    });
    expect(events(engine, 'payloadUnloading')).toMatchObject([
      { tick: landed, missionId: id, aircraftId: A, payload: { payloadKg: 9000, at: 'EGTE' } },
    ]);
    // It is not available, and says for how long: the checks, and then the unloading.
    const duration = payloadDurationS(PAYLOAD_RATE, 9000, 0);
    const readyTick = checksEnd + duration;
    expect(forecasts(engine).get(A)).toMatchObject({
      completeTick: readyTick,
      payload: { state: 'behind_checks', removing: true, startTick: checksEnd },
    });
    const next = {
      type: 'launchFlight' as const,
      aircraftId: A,
      plan: generatePlan(models.transport, places.exeter, places.newquay),
      load: { fuelKg: aircraftOf(engine).fuelKg, payloadKg: 0 },
    };
    expect(() => engine.applyCommand(next)).toThrow(/in its post-flight checks/);

    // The checks end, and the unloading takes its turn at the payload handling.
    engine.runSteps(checksEnd - engine.clock.tick);
    expect(aircraftOf(engine).service?.payload?.transfer).toMatchObject({
      startTick: checksEnd,
      fromKg: 9000,
      toKg: 0,
      completeTick: readyTick,
    });
    expect(() => engine.applyCommand(next)).toThrow(/having payload taken off/);
    let last = 9000;
    for (let tick = checksEnd + 1; tick < readyTick; tick++) {
      engine.runSteps(1);
      const now = aircraftOf(engine).payloadKg;
      if (tick <= checksEnd + GROUND_SERVICE.payload.positionS) expect(now).toBe(9000);
      else expect(now).toBe(last - PAYLOAD_RATE);
      expect(aircraftOf(engine).status).toBe('servicing');
      last = now;
    }
    engine.runSteps(1);
    expect(engine.clock.tick).toBe(readyTick);
    expect(aircraftOf(engine)).toMatchObject({ status: 'available', payloadKg: 0, service: null });
    expect(events(engine, 'loadingCompleted', A).at(-1)).toMatchObject({
      tick: readyTick,
      payload: { payloadKg: 0, loadedKg: -9000, durationS: duration },
    });
    expect(events(engine, 'servicingCompleted', A).at(-1)?.payload).toMatchObject({
      reason: 'turnaround',
      durationS: readyTick - landed,
      checksS: checksEnd - landed,
      loadS: duration,
      payloadLoadedKg: -9000,
      payloadTargetKg: 0,
      payloadKg: 0,
      at: 'EGTE',
    });
    expect(events(engine, 'servicingCompleted', A).at(-1)?.payload).not.toHaveProperty('stopped');
    // The mission's own record is as it was when it completed.
    expect(missionOf(engine, id)).toMatchObject({ status: 'completed', completedTick: landed });
    expect(engine.applyCommand(next)).toBe(true);
  });

  it('waits its turn when another delivery is being unloaded, in the order they were ready', () => {
    const engine = world();
    const first = delivery(engine, A, 12_000);
    const second = delivery(engine, B, 6000);
    untilServiced(engine, A);
    untilServiced(engine, B);
    // Two minutes apart, so that the second lands while the first is still being unloaded.
    launch(engine, first);
    engine.runSteps(120);
    launch(engine, second);
    untilLanded(engine, B);
    const said = forecasts(engine);
    const aChecks = aircraftOf(engine, A).service?.checksCompleteTick as number;
    const bChecks = aircraftOf(engine, B).service?.checksCompleteTick as number;
    const aDone = aChecks + payloadDurationS(PAYLOAD_RATE, 12_000, 0);
    expect(bChecks).toBeGreaterThan(aChecks);
    expect(bChecks).toBeLessThan(aDone);
    expect(said.get(B)?.payload).toMatchObject({
      state: 'behind_checks',
      position: 1,
      behind: A,
      startTick: aDone,
      completeTick: aDone + payloadDurationS(PAYLOAD_RATE, 6000, 0),
    });

    // B's checks end while A holds the payload handling: B waits, with all of it still aboard.
    engine.runSteps(bChecks - engine.clock.tick);
    // (It had queued before, at its home aerodrome, for the fuel point and to be loaded.)
    expect(events(engine, 'serviceQueued', B).at(-1)).toMatchObject({
      tick: bChecks,
      payload: { kind: 'handling', position: 1, behind: A, startTick: aDone, at: 'EGTE' },
    });
    engine.runSteps(aDone - 1 - engine.clock.tick);
    expect(aircraftOf(engine, B)).toMatchObject({
      status: 'servicing',
      payloadKg: 6000,
      service: { payload: { transfer: null, queuedTick: bChecks } },
    });
    engine.runSteps(1);
    expect(aircraftOf(engine, A)).toMatchObject({ status: 'available', payloadKg: 0 });
    expect(aircraftOf(engine, B).service?.payload?.transfer?.startTick).toBe(aDone);
    untilServiced(engine, B);
    expect(engine.clock.tick).toBe(said.get(B)?.completeTick);
    expect(aircraftOf(engine, B)).toMatchObject({ status: 'available', payloadKg: 0 });
    expect(events(engine, 'servicingCompleted', B).at(-1)?.payload).toMatchObject({
      waitS: aDone - bChecks,
      payloadLoadedKg: -6000,
    });
    expect(missionOf(engine, second).status).toBe('completed');
  });

  it('stays aboard an aircraft that lands due maintenance, and comes off when it is next prepared', () => {
    const snapshot = world().snapshot();
    const engine = SimulationEngine.restore({
      ...snapshot,
      fleet: {
        ...snapshot.fleet,
        aircraft: snapshot.fleet.aircraft.map((aircraft) =>
          aircraft.id === A
            ? {
                ...aircraft,
                flightSecondsSinceMaintenance: MAINTENANCE.dueAfterFlightSeconds - 60,
              }
            : aircraft,
        ),
      },
    });
    const id = delivery(engine, A, 9000);
    untilServiced(engine, A);
    launch(engine, id);
    untilLanded(engine, A);
    // Delivered, and the mission says so; there is no turnaround to take it off.
    expect(missionOf(engine, id).status).toBe('completed');
    expect(aircraftOf(engine)).toMatchObject({
      status: 'maintenance_due',
      service: null,
      payloadKg: 9000,
    });
    expect(events(engine, 'payloadUnloading')).toHaveLength(0);
    engine.applyCommand({ type: 'startMaintenance', aircraftId: A });
    engine.runSteps(MAINTENANCE.durationSeconds);
    expect(aircraftOf(engine)).toMatchObject({ status: 'available', payloadKg: 9000 });
    // Nothing left it by itself. It is taken off like any other payload, in time.
    const from = engine.clock.tick;
    engine.applyCommand({
      type: 'serviceAircraft',
      aircraftId: A,
      fuelKg: aircraftOf(engine).fuelKg,
      payloadKg: 0,
    });
    untilServiced(engine, A);
    expect(engine.clock.tick - from).toBe(payloadDurationS(PAYLOAD_RATE, 9000, 0));
    expect(aircraftOf(engine).payloadKg).toBe(0);
  });

  it('gives way to the next mission: its payload is what the turnaround then brings aboard', () => {
    const engine = world();
    const id = delivery(engine, A, 9000);
    untilServiced(engine, A);
    launch(engine, id);
    untilLanded(engine, A);
    engine.runSteps(60);
    // From Exeter, a mission that carries less: accepted while the delivery is still aboard.
    const back = mission(engine, 'logistics', A, { destination: places.newquay, payloadKg: 4000 });
    engine.applyCommand({ type: 'acceptMission', missionId: back });
    expect(aircraftOf(engine).service).toMatchObject({
      stage: 'checks',
      missionId: back,
      payload: { targetKg: 4000 },
    });
    untilServiced(engine, A);
    expect(aircraftOf(engine)).toMatchObject({
      payloadKg: 4000,
      fuelKg: missionOf(engine, back).load?.fuelKg,
    });
    expect(launch(engine, back)).toBe(true);
  });

  it('leaves alone a payload that was carried and not delivered', () => {
    const engine = world();
    // A transport mission carries a payload and delivers nothing: it is not unloaded.
    const id = mission(engine, 'transport', A, { destination: places.exeter, payloadKg: 5000 });
    engine.applyCommand({ type: 'acceptMission', missionId: id });
    untilServiced(engine, A);
    launch(engine, id);
    untilLanded(engine, A);
    const delivers = missionOf(engine, id).objectives.some(
      (objective) => objective.spec.kind === 'deliver_payload',
    );
    expect(aircraftOf(engine).service?.payload ?? null).toEqual(
      delivers ? expect.objectContaining({ targetKg: 0 }) : null,
    );
    expect(events(engine, 'payloadUnloading')).toHaveLength(delivers ? 1 : 0);
  });
});

/** A delivery flown and unloaded, with the unloading of a second waiting behind it. */
function scripted(step: (engine: SimulationEngine, steps: number) => void): SimulationEngine {
  const engine = world('scripted-delivery');
  const first = delivery(engine, A, 12_000);
  const second = delivery(engine, B, 6000);
  while (aircraftOf(engine, B).status === 'servicing') step(engine, 1);
  launch(engine, first);
  step(engine, 120);
  launch(engine, second);
  while (aircraftOf(engine, B).activeFlightId !== null) step(engine, 1);
  while (aircraftOf(engine, B).status === 'servicing') step(engine, 1);
  step(engine, 300);
  return engine;
}

describe('unloading: determinism, continuity and upgrade', { timeout: 60_000 }, () => {
  const reference = scripted((engine, steps) => {
    for (let i = 0; i < steps; i++) engine.runSteps(1);
  });

  it('is the same however the steps are batched, and replays from its log', () => {
    const batched = scripted((engine, steps) => {
      engine.runSteps(steps);
    });
    expect(batched.snapshot()).toEqual(reference.snapshot());
    const replayed = replayWorld(
      newWorld('scripted-delivery'),
      log(reference),
      reference.clock.tick,
    );
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(reference.snapshot()));
    expect(log(replayed)).toEqual(log(reference));
    expect(events(reference, 'payloadUnloading')).toHaveLength(2);
  });

  it('continues exactly from a save made before, during and after an unloading', () => {
    const final = reference.clock.tick;
    const commands = log(reference).filter((entry) => entry.kind === 'command');
    const live = world('scripted-delivery');
    let next = 1;
    const applyDue = (engine: SimulationEngine, from: number) => {
      let index = from;
      for (; index < commands.length && commands[index]?.tick === engine.clock.tick; index++) {
        engine.applyCommand(commands[index]?.payload as never);
      }
      return index;
    };
    const seen = { before: 0, during: 0, waiting: 0, after: 0 };
    const landed = events(reference, 'payloadUnloading')[0]?.tick as number;
    while (live.clock.tick < final) {
      next = applyDue(live, next);
      if (live.clock.tick >= landed && live.clock.tick % 53 === 0) {
        const fleet = live.snapshot().fleet.aircraft;
        const unloading = (each: AircraftState) => each.service?.payload ?? null;
        if (fleet.some((each) => each.service?.stage === 'checks' && unloading(each)))
          seen.before += 1;
        if (fleet.some((each) => unloading(each)?.transfer && !unloading(each)?.completedTick)) {
          seen.during += 1;
        }
        if (
          fleet.some((each) => unloading(each)?.queuedTick != null && !unloading(each)?.transfer)
        ) {
          seen.waiting += 1;
        }
        if (fleet.every((each) => each.service === null)) seen.after += 1;
        const resumed = SimulationEngine.restore(copyOf(live.snapshot()));
        expect(resumed.snapshot().fleet).toEqual(live.snapshot().fleet);
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
    expect(seen.before).toBeGreaterThan(2);
    expect(seen.during).toBeGreaterThan(2);
    expect(seen.waiting).toBeGreaterThan(0);
    expect(seen.after).toBeGreaterThan(0);
  });

  it('upgrades a model-8 world: a delivery in the air is unloaded in time when it lands', () => {
    const engine = world('model-8');
    const id = delivery(engine, A, 9000);
    untilServiced(engine, A);
    launch(engine, id);
    engine.runSteps(300);
    const savedAt = engine.clock.tick;
    const upgraded = SimulationEngine.restore({ ...copyOf(engine.snapshot()), modelVersion: 8 });
    expect(upgraded.snapshot().modelVersion).toBe(SIM_MODEL_VERSION);
    expect(SIM_MODEL_VERSION).toBe(10);
    // What was logged under the old rule is kept; replay starts at the upgrade.
    expect(upgraded.snapshot().log.completeFromTick).toBe(savedAt);
    expect(upgraded.snapshot().fleet).toEqual(engine.snapshot().fleet);
    untilLanded(upgraded, A);
    // Under model 8 the payload would have gone at this instant.
    expect(aircraftOf(upgraded)).toMatchObject({
      status: 'servicing',
      payloadKg: 9000,
      service: { payload: { targetKg: 0 } },
    });
    untilServiced(upgraded, A);
    expect(aircraftOf(upgraded)).toMatchObject({ status: 'available', payloadKg: 0 });
  });
});

describe('giving aerodromes their size class', () => {
  const EGHQ = places.newquay.refId as string;
  const EGTE = places.exeter.refId as string;
  const classify = (engine: SimulationEngine, sizes: Record<string, AerodromeSize>) =>
    engine.applyCommand({ type: 'classifyAerodromes', sizes });

  /** A world as one upgraded from before the class was kept: nothing in it carries one. */
  function unclassified(): { engine: SimulationEngine; planned: string; over: string } {
    const engine = world('classify');
    engine.applyCommand({ type: 'setOperatingArea', places: [places.newquay, places.exeter] });
    // A mission that is over, one that is planned, and a flight in the air.
    const over = mission(engine, 'logistics', A, { destination: places.exeter, payloadKg: 0 });
    engine.applyCommand({ type: 'cancelMission', missionId: over });
    const planned = mission(engine, 'logistics', A, { destination: places.exeter, payloadKg: 0 });
    engine.applyCommand(fixtureLaunchFull(B, models.transport, places.newquay, places.exeter));
    engine.runSteps(200);
    return { engine, planned, over };
  }

  it('fills in every aerodrome that lacks one, from what it is told, and records it', () => {
    const { engine, planned, over } = unclassified();
    expect(aerodromeCapability(aircraftOf(engine).location)).toMatchObject({ size: null });
    const before = log(engine).length;
    expect(classify(engine, { [EGHQ]: 'medium', [EGTE]: 'large' })).toBe(true);

    const newquay: RoutePoint = { ...places.newquay, size: 'medium' };
    const exeter: RoutePoint = { ...places.exeter, size: 'large' };
    expect(aircraftOf(engine)).toMatchObject({ home: newquay, location: newquay });
    expect(aircraftOf(engine, B).home).toEqual(newquay);
    expect(engine.snapshot().missions.places).toEqual([newquay, exeter]);
    expect(missionOf(engine, planned).plan?.points.at(0)).toEqual(newquay);
    expect(missionOf(engine, planned).plan?.points.at(-1)).toEqual(exeter);
    expect(missionOf(engine, planned).brief.destination).toEqual(exeter);
    const flight = engine.snapshot().fleet.flights.find((each) => each.status === 'active');
    expect(flight?.plan.points.at(-1)).toEqual(exeter);
    expect(flight?.plannedPlan.points.at(0)).toEqual(newquay);
    // A mission that is over keeps the record of what it was.
    expect(missionOf(engine, over).brief.destination).toEqual(places.exeter);

    // Provenance: the log says what was applied, as a command the application issued.
    expect(log(engine).slice(before)).toMatchObject([
      {
        kind: 'command',
        type: 'classifyAerodromes',
        actor: 'system',
        payload: { sizes: { [EGHQ]: 'medium', [EGTE]: 'large' } },
      },
    ]);

    // The flight lands at an aerodrome now known to be large: two can be fuelled at once there.
    untilLanded(engine, B);
    expect(aircraftOf(engine, B).location).toEqual(exeter);
    expect(aerodromeCapability(aircraftOf(engine, B).location)).toMatchObject({
      size: 'large',
      fuelPoints: 2,
      handlingPoints: 2,
    });
  });

  it('leaves unknown aerodromes on the medium fallback, and never replaces a class', () => {
    const { engine } = unclassified();
    // Only Exeter is known to the reference data.
    expect(classify(engine, { [EGTE]: 'small', 'ourairports:999999': 'large' })).toBe(true);
    expect(aircraftOf(engine).location).toEqual(places.newquay);
    expect(aerodromeCapability(aircraftOf(engine).location)).toMatchObject({
      size: null,
      fuelPoints: 1,
      fuelRateFactor: 1,
    });
    expect(engine.snapshot().missions.places[1]).toEqual({ ...places.exeter, size: 'small' });
    // Told otherwise later: what it has is kept. A class is filled in, never changed.
    expect(classify(engine, { [EGTE]: 'large' })).toBe(false);
    expect(engine.snapshot().missions.places[1]?.size).toBe('small');
  });

  it('does nothing, and logs nothing, when there is nothing to fill in', () => {
    const { engine } = unclassified();
    const before = engine.snapshot();
    expect(classify(engine, {})).toBe(false);
    expect(classify(engine, { 'ourairports:999999': 'large' })).toBe(false);
    expect(engine.snapshot()).toEqual(before);
    classify(engine, { [EGHQ]: 'medium', [EGTE]: 'large' });
    const once = engine.snapshot();
    expect(classify(engine, { [EGHQ]: 'medium', [EGTE]: 'large' })).toBe(false);
    expect(engine.snapshot()).toEqual(once);
    expect(() => classify(engine, { [EGHQ]: 'enormous' as AerodromeSize })).toThrow(
      CommandRejected,
    );
    expect(engine.snapshot()).toEqual(once);
  });

  it('is deterministic: the same world from the same log, classes included', () => {
    const { engine } = unclassified();
    classify(engine, { [EGHQ]: 'medium', [EGTE]: 'large' });
    untilLanded(engine, B);
    untilServiced(engine, B);
    const replayed = replayWorld(newWorld('classify'), log(engine), engine.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(engine.snapshot()));
    expect(replayed.snapshot().missions.places).toEqual(engine.snapshot().missions.places);
    // Saved and loaded, every class is as it was.
    const reloaded = SimulationEngine.restore(copyOf(engine.snapshot()));
    expect(reloaded.snapshot()).toEqual(engine.snapshot());
  });
});

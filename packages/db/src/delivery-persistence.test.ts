import {
  MISSION_TEMPLATES,
  defaultBrief,
  forecastGroundServices,
  fuelDuringTransfer,
  type RoutePoint,
} from '@aegis/domain';
import {
  SIM_MODEL_VERSION,
  SimulationEngine,
  defaultConfiguration,
  type AircraftState,
  type Checkpoint,
} from '@aegis/sim';
import { FIXTURES, fixtureOrder, untilServiced } from '@aegis/sim/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNodeDatabase, type NodeDatabase } from './node';
import { SqliteWorldStore } from './world-store';

/*
 * Phase 8D on disk (ADR 0029): a delivered payload being taken off survives a save and a load at
 * every point of its turnaround, and goes on to the same tick; a size class given to an aerodrome
 * is kept wherever the world holds that aerodrome; and a world as model 8 saved it loads, and is
 * carried over with nothing in it changed.
 */

const { places } = FIXTURES;
const A = 'AEGIS-TR-001';
const B = 'AEGIS-TR-002';
const newWorld = () => ({ seed: 'delivery-persisted', epoch: FIXTURES.epoch });
const aircraftOf = (engine: SimulationEngine, id = A): AircraftState => {
  const found = engine.snapshot().fleet.aircraft.find((aircraft) => aircraft.id === id);
  if (!found) throw new Error(`no aircraft ${id}`);
  return found;
};
const checkpoint = (engine: SimulationEngine, seq = 1): Checkpoint => ({
  seq,
  wallTimeMs: 1_800_000_000_000 + seq,
  snapshot: engine.snapshot(),
});

/** Two deliveries to Exeter landing together: one handling point there, so one waits. */
function delivered(): { engine: SimulationEngine; landed: number } {
  const engine = SimulationEngine.create(newWorld());
  engine.applyCommand({
    type: 'seedStarterFleet',
    aircraft: [
      fixtureOrder('transport', places.newquay),
      fixtureOrder('transport', places.newquay),
    ],
  });
  const ids: string[] = [];
  for (const [aircraftId, payloadKg] of [
    [A, 9000],
    [B, 6000],
  ] as const) {
    const before = new Set(engine.snapshot().missions.missions.map((each) => each.id));
    engine.applyCommand({
      type: 'createMission',
      missionType: 'logistics',
      ...defaultConfiguration(
        'logistics',
        { ...defaultBrief(MISSION_TEMPLATES.logistics), destination: places.exeter, payloadKg },
        aircraftOf(engine, aircraftId),
        { context: engine.planContext() },
      ),
    });
    const id = engine.snapshot().missions.missions.find((each) => !before.has(each.id))?.id;
    if (!id) throw new Error('setup');
    engine.applyCommand({ type: 'acceptMission', missionId: id });
    ids.push(id);
  }
  untilServiced(engine, A);
  untilServiced(engine, B);
  for (const missionId of ids) engine.applyCommand({ type: 'launchMission', missionId });
  while (
    aircraftOf(engine, A).activeFlightId !== null ||
    aircraftOf(engine, B).activeFlightId !== null
  ) {
    engine.runSteps(1);
  }
  return { engine, landed: engine.clock.tick };
}

describe('a delivery being unloaded, on disk', () => {
  let database: NodeDatabase;
  let store: SqliteWorldStore;
  beforeEach(() => {
    database = openNodeDatabase(':memory:');
    store = new SqliteWorldStore(database.db);
  });
  afterEach(() => {
    database.close();
  });

  async function reloaded(engine: SimulationEngine, seq: number): Promise<SimulationEngine> {
    const saved = checkpoint(engine, seq);
    await store.save(saved);
    const loaded = await store.load();
    expect(loaded).toEqual(saved);
    return SimulationEngine.restore((loaded as Checkpoint).snapshot);
  }

  it('saved before, during, queued behind and after the unloading, it goes on to the same ticks', async () => {
    const { engine: reference } = delivered();
    const said = forecastGroundServices(reference.snapshot().fleet.aircraft, reference.clock.tick);
    const first = said.get(A);
    const second = said.get(B);
    if (!first?.payload || !second?.payload) throw new Error('setup');
    // One is unloaded and the other waits its turn.
    expect(second.payload.startTick).toBe(first.payload.completeTick);
    const checksEnd = aircraftOf(reference, A).service?.checksCompleteTick as number;

    let engine = delivered().engine;
    const stops: [string, number, (engine: SimulationEngine) => void][] = [
      [
        'before unloading',
        checksEnd - 60,
        (at) => {
          expect(aircraftOf(at, A).service).toMatchObject({
            stage: 'checks',
            payload: { targetKg: 0, transfer: null, queuedTick: null },
          });
          expect(aircraftOf(at, A).payloadKg).toBe(9000);
        },
      ],
      [
        'during unloading, and queued behind it',
        // Past the time it takes to position the handling equipment.
        checksEnd + 400,
        (at) => {
          const transfer = aircraftOf(at, A).service?.payload?.transfer;
          if (!transfer) throw new Error('not unloading');
          expect(aircraftOf(at, A).payloadKg).toBe(fuelDuringTransfer(transfer, at.clock.tick));
          expect(aircraftOf(at, A).payloadKg).toBeLessThan(9000);
          expect(aircraftOf(at, B).service?.payload).toMatchObject({
            transfer: null,
            queuedTick: checksEnd,
          });
          expect(aircraftOf(at, B).payloadKg).toBe(6000);
        },
      ],
      [
        'after the first, during the second',
        first.completeTick + 50,
        (at) => {
          expect(aircraftOf(at, A)).toMatchObject({
            status: 'available',
            payloadKg: 0,
            service: null,
          });
          expect(aircraftOf(at, B).service?.payload?.transfer?.startTick).toBe(first.completeTick);
        },
      ],
      [
        'after every service has completed',
        second.completeTick + 100,
        (at) => {
          expect(aircraftOf(at, B)).toMatchObject({
            status: 'available',
            payloadKg: 0,
            service: null,
          });
        },
      ],
    ];
    let seq = 1;
    for (const [, tick, check] of stops) {
      engine.runSteps(tick - engine.clock.tick);
      reference.runSteps(tick - reference.clock.tick);
      engine = await reloaded(engine, seq++);
      check(engine);
      expect(engine.snapshot()).toEqual(reference.snapshot());
      expect(forecastGroundServices(engine.snapshot().fleet.aircraft, tick)).toEqual(
        forecastGroundServices(reference.snapshot().fleet.aircraft, tick),
      );
    }
    expect(engine.snapshot().integrityDigest).toBe(reference.snapshot().integrityDigest);
  });

  it('loads a world as model 8 saved it, and carries it over unchanged', async () => {
    const { engine } = delivered();
    engine.runSteps(5000);
    await store.save(checkpoint(engine));
    database.transport.connection.exec(`UPDATE sim_world SET model_version = 8`);
    const loaded = await store.load();
    expect(loaded?.snapshot.modelVersion).toBe(8);
    const upgraded = SimulationEngine.restore((loaded as Checkpoint).snapshot);
    expect(upgraded.snapshot().modelVersion).toBe(SIM_MODEL_VERSION);
    expect(upgraded.snapshot().fleet).toEqual(engine.snapshot().fleet);
    expect(upgraded.snapshot().missions).toEqual(engine.snapshot().missions);
    const again = checkpoint(upgraded, 2);
    await store.save(again);
    expect(await store.load()).toEqual(again);
  });

  it('keeps a size class wherever the world holds the aerodrome', async () => {
    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand({
      type: 'seedStarterFleet',
      aircraft: [fixtureOrder('transport', places.newquay)],
    });
    engine.applyCommand({ type: 'setOperatingArea', places: [places.newquay, places.exeter] });
    const before = new Set<string>();
    engine.applyCommand({
      type: 'createMission',
      missionType: 'logistics',
      ...defaultConfiguration(
        'logistics',
        {
          ...defaultBrief(MISSION_TEMPLATES.logistics),
          destination: places.exeter,
          payloadKg: 1000,
        },
        aircraftOf(engine),
        { context: engine.planContext() },
      ),
    });
    const missionId = engine.snapshot().missions.missions.find((each) => !before.has(each.id))?.id;
    engine.applyCommand({
      type: 'classifyAerodromes',
      sizes: {
        [places.newquay.refId as string]: 'large',
        [places.exeter.refId as string]: 'small',
      },
    });
    const large: RoutePoint = { ...places.newquay, size: 'large' };
    const small: RoutePoint = { ...places.exeter, size: 'small' };

    const restored = await reloaded(engine, 1);
    const world = restored.snapshot();
    expect(world.fleet.aircraft[0]).toMatchObject({ home: large, location: large });
    expect(world.missions.places).toEqual([large, small]);
    const mission = world.missions.missions.find((each) => each.id === missionId);
    expect(mission?.brief.destination).toEqual(small);
    expect(mission?.plan?.points.at(0)).toMatchObject({ size: 'large' });
    expect(mission?.plan?.points.at(-1)).toMatchObject({ size: 'small' });
    expect(
      database.transport.connection
        .prepare(`SELECT code, size FROM sim_place ORDER BY ordinal`)
        .all(),
    ).toEqual([
      { code: 'EGHQ', size: 'large' },
      { code: 'EGTE', size: 'small' },
    ]);
  });
});

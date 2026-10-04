import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GENERATION,
  MISSION_TEMPLATES,
  defaultBrief,
  type MissionBrief,
  type MissionType,
  type PlanContext,
} from '@aegis/domain';
import {
  RECENT_MISSIONS,
  SimulationEngine,
  SimulationRunner,
  defaultConfiguration,
  planContextOf,
  replayComparable,
  replayWorld,
  type AircraftState,
  type Checkpoint,
  type LogEntry,
  type SimView,
  type WorldCommand,
} from '@aegis/sim';
import { FIXTURES, ManualHostClock, fixtureOrder } from '@aegis/sim/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNodeDatabase, type NodeDatabase } from './node';
import { SqliteWorldStore, WorldStorageError } from './world-store';

const { places } = FIXTURES;
const newWorld = () => ({ seed: 'persisted-missions', epoch: FIXTURES.epoch });
const AREA = { name: 'Area 1', lat: 49.4, lon: -7.2 };
const TRANSPORT = 'AEGIS-TR-001';
const OPERATING_AREA = [places.prestwick, places.newquay, places.exeter, places.akrotiri];

const SEED_FLEET: WorldCommand = {
  type: 'seedStarterFleet',
  aircraft: [fixtureOrder('fastJet', places.prestwick), fixtureOrder('transport', places.newquay)],
};
const briefFor = (type: MissionType, overrides: Partial<MissionBrief>): MissionBrief => ({
  ...defaultBrief(MISSION_TEMPLATES[type]),
  ...overrides,
});
const transportOf = (aircraft: readonly AircraftState[]): AircraftState => {
  const found = aircraft.find((candidate) => candidate.id === TRANSPORT);
  if (!found) throw new Error('no transport');
  return found;
};
/** A training mission planned in the world it will be flown in. */
const createTraining = (
  aircraft: readonly AircraftState[],
  context: PlanContext,
): WorldCommand => ({
  type: 'createMission',
  missionType: 'training',
  ...defaultConfiguration(
    'training',
    briefFor('training', { target: AREA }),
    transportOf(aircraft),
    {
      context,
    },
  ),
});

/** A world with one mission in each of several states, and one in flight. */
function busyWorld(): SimulationEngine {
  const engine = SimulationEngine.create(newWorld());
  const apply = (command: WorldCommand) => engine.applyCommand(command);
  const fleet = () => engine.snapshot().fleet.aircraft;
  apply(SEED_FLEET);
  apply({ type: 'setOperatingArea', places: OPERATING_AREA });
  // 1: completed. 2: cancelled. 3: draft. 4: active. The world generates 5 at the first hour.
  apply(createTraining(fleet(), engine.planContext()));
  apply({ type: 'acceptMission', missionId: 'MSN-000001' });
  apply({ type: 'launchMission', missionId: 'MSN-000001' });
  engine.runSteps(3400);
  apply(createTraining(fleet(), engine.planContext()));
  apply({ type: 'cancelMission', missionId: 'MSN-000002' });
  apply({
    type: 'createMission',
    missionType: 'logistics',
    ...defaultConfiguration('logistics', briefFor('logistics', {}), null),
  });
  apply(createTraining(fleet(), engine.planContext()));
  apply({ type: 'acceptMission', missionId: 'MSN-000004' });
  apply({ type: 'launchMission', missionId: 'MSN-000004' });
  engine.runSteps(700);
  return engine;
}

const checkpoint = (engine: SimulationEngine, seq = 1): Checkpoint => ({
  seq,
  wallTimeMs: 1_800_000_000_000 + seq,
  snapshot: engine.snapshot(),
});

describe('mission persistence', () => {
  let database: NodeDatabase;
  let store: SqliteWorldStore;
  const all = (sql: string) => database.transport.connection.prepare(sql).all();
  const exec = (sql: string) => () => {
    database.transport.connection.exec(sql);
  };

  beforeEach(() => {
    database = openNodeDatabase(':memory:');
    store = new SqliteWorldStore(database.db);
  });
  afterEach(() => {
    database.close();
  });

  it('round-trips missions in every state, the operating area and the counters exactly', async () => {
    const engine = busyWorld();
    const saved = checkpoint(engine);
    await store.save(saved);
    const loaded = await store.load();

    expect(loaded).toEqual(saved);
    const missions = loaded?.snapshot.missions.missions ?? [];
    expect(
      missions
        .filter((mission) => mission.source === 'manual')
        .map((mission) => [mission.id, mission.status]),
    ).toEqual([
      ['MSN-000001', 'completed'],
      ['MSN-000002', 'cancelled'],
      ['MSN-000003', 'draft'],
      ['MSN-000004', 'active'],
    ]);
    // The world generated an opportunity along the way; it round-trips like any other mission.
    expect(missions.find((mission) => mission.source === 'generated')).toMatchObject({
      id: 'MSN-000005',
      status: 'offered',
      createdTick: GENERATION.intervalTicks,
    });
    expect(loaded?.snapshot.missions.places).toEqual(OPERATING_AREA);
    expect(loaded?.snapshot.missions.nextNumber).toBe(6);
    expect(loaded?.snapshot.missions.generated).toBe(1);
  });

  it('stores what is queried as columns and the rest as JSON', async () => {
    await store.save(checkpoint(busyWorld()));
    expect(
      all(
        `SELECT id, type, source, status, priority, aircraft_id, flight_id
         FROM sim_mission WHERE source = 'manual' ORDER BY id`,
      ),
    ).toEqual([
      {
        id: 'MSN-000001',
        type: 'training',
        source: 'manual',
        status: 'completed',
        priority: 'routine',
        aircraft_id: TRANSPORT,
        flight_id: 'FLT-000001',
      },
      {
        id: 'MSN-000002',
        type: 'training',
        source: 'manual',
        status: 'cancelled',
        priority: 'routine',
        aircraft_id: TRANSPORT,
        flight_id: null,
      },
      {
        id: 'MSN-000003',
        type: 'logistics',
        source: 'manual',
        status: 'draft',
        priority: 'routine',
        aircraft_id: null,
        flight_id: null,
      },
      {
        id: 'MSN-000004',
        type: 'training',
        source: 'manual',
        status: 'active',
        priority: 'routine',
        aircraft_id: TRANSPORT,
        flight_id: 'FLT-000002',
      },
    ]);
    expect(all('SELECT id, mission_id FROM sim_flight ORDER BY id')).toEqual([
      { id: 'FLT-000001', mission_id: 'MSN-000001' },
      { id: 'FLT-000002', mission_id: 'MSN-000004' },
    ]);
    expect(all('SELECT ordinal, code, name FROM sim_place ORDER BY ordinal')).toEqual(
      OPERATING_AREA.map((place, ordinal) => ({ ordinal, code: place.code, name: place.name })),
    );
  });

  it('restores an engine from the loaded world that carries on identically', async () => {
    const engine = busyWorld();
    await store.save(checkpoint(engine));
    const loaded = (await store.load()) as Checkpoint;
    const restored = SimulationEngine.restore(loaded.snapshot);
    engine.runSteps(6000);
    restored.runSteps(6000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(restored.snapshot().missions.missions[3]?.status).toBe('completed');
  });

  it('enforces mission rules in the database', async () => {
    await store.save(checkpoint(busyWorld()));
    expect(exec(`UPDATE sim_mission SET status = 'underway' WHERE id = 'MSN-000003'`)).toThrow(
      /sim_mission_status_known/,
    );
    expect(exec(`UPDATE sim_mission SET type = 'strike' WHERE id = 'MSN-000003'`)).toThrow(
      /sim_mission_type_known/,
    );
    expect(exec(`UPDATE sim_mission SET flight_id = NULL WHERE id = 'MSN-000004'`)).toThrow(
      /sim_mission_active_has_flight/,
    );
    expect(exec(`UPDATE sim_mission SET status = 'planned' WHERE id = 'MSN-000003'`)).toThrow(
      /sim_mission_committed_is_planned/,
    );
    expect(exec(`UPDATE sim_mission SET status = 'offered' WHERE id = 'MSN-000003'`)).toThrow(
      /sim_mission_offer_is_generated/,
    );
    expect(
      exec(`UPDATE sim_mission SET aircraft_id = 'AEGIS-XX-404' WHERE id = 'MSN-000003'`),
    ).toThrow(/FOREIGN KEY/);
    expect(exec(`UPDATE sim_flight SET mission_id = 'MSN-000404' WHERE id = 'FLT-000001'`)).toThrow(
      /FOREIGN KEY/,
    );
  });

  it('refuses to load a mission whose stored JSON is not a mission', async () => {
    await store.save(checkpoint(busyWorld()));
    const corrupt = async (sql: string) => {
      const scratch = openNodeDatabase(':memory:');
      try {
        await new SqliteWorldStore(scratch.db).save(checkpoint(busyWorld()));
        scratch.transport.connection.exec(sql);
        await new SqliteWorldStore(scratch.db).load();
      } finally {
        scratch.close();
      }
    };
    await expect(
      corrupt(`UPDATE sim_mission SET objectives = '[{"id":"O1"}]' WHERE id = 'MSN-000004'`),
    ).rejects.toThrow(WorldStorageError);
    await expect(
      corrupt(`UPDATE sim_mission SET brief = '{"shape":"spiral"}' WHERE id = 'MSN-000003'`),
    ).rejects.toThrow(WorldStorageError);
    await expect(
      corrupt(`UPDATE sim_mission SET outcome = 'not json' WHERE id = 'MSN-000001'`),
    ).rejects.toThrow(WorldStorageError);
  });

  it('keeps every finished mission on disk and loads only recent history', async () => {
    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand(SEED_FLEET);
    const total = RECENT_MISSIONS + 15;
    const draft: WorldCommand = {
      type: 'createMission',
      missionType: 'logistics',
      ...defaultConfiguration('logistics', briefFor('logistics', {}), null),
    };
    for (let i = 1; i <= total; i++) {
      engine.applyCommand(draft);
      engine.applyCommand({
        type: 'cancelMission',
        missionId: `MSN-${String(i).padStart(6, '0')}`,
      });
      // Checkpoint as the application would, before the engine forgets old history.
      if (i % 20 === 0) await store.save(checkpoint(engine, i));
    }
    engine.applyCommand(draft);
    await store.save(checkpoint(engine, total + 1));

    expect(all('SELECT count(*) AS n FROM sim_mission')).toEqual([{ n: total + 1 }]);
    const loaded = await store.load();
    const missions = loaded?.snapshot.missions.missions ?? [];
    expect(missions.filter((mission) => mission.status === 'cancelled')).toHaveLength(
      RECENT_MISSIONS,
    );
    expect(missions.filter((mission) => mission.status === 'draft')).toHaveLength(1);
    expect(missions[0]?.id).toBe('MSN-000016');
    expect(loaded?.snapshot.missions.nextNumber).toBe(total + 2);
  });
});

describe('mission continuity across application restarts', () => {
  let directory: string;
  let path: string;
  const open: NodeDatabase[] = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-mission-'));
    path = join(directory, 'aegis.db');
  });
  afterEach(() => {
    for (const database of open.splice(0)) {
      if (database.transport.connection.isOpen) database.close();
    }
    rmSync(directory, { recursive: true, force: true });
  });

  async function launchApp() {
    const database = openNodeDatabase(path);
    open.push(database);
    const host = new ManualHostClock();
    const runner = await SimulationRunner.open({
      store: new SqliteWorldStore(database.db),
      host,
      newWorld,
    });
    return { database, host, runner };
  }
  type Session = Awaited<ReturnType<typeof launchApp>>;
  function run(session: Session, realMs: number): void {
    for (let elapsed = 0; elapsed < realMs; elapsed += 100) {
      session.host.elapse(100);
      session.runner.advance();
    }
  }
  const mission = (view: SimView, id: string) => {
    const found = view.missions.missions.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`no mission ${id}`);
    return found;
  };
  function wholeLog(session: Session): LogEntry[] {
    return session.database.transport.connection
      .prepare('SELECT * FROM sim_log ORDER BY seq')
      .all()
      .map((row) => ({
        seq: row.seq as number,
        tick: row.tick as number,
        kind: row.kind as LogEntry['kind'],
        type: row.type as string,
        actor: row.actor as LogEntry['actor'],
        missionId: row.mission_id as string | null,
        aircraftId: row.aircraft_id as string | null,
        flightId: row.flight_id as string | null,
        payload: JSON.parse(row.payload as string) as LogEntry['payload'],
      }));
  }
  /** Starts a training mission at 100x and returns the session mid-flight. */
  async function midMission(): Promise<Session> {
    const session = await launchApp();
    session.runner.execute({ type: 'setSpeed', speed: 100 });
    session.runner.execute(SEED_FLEET);
    session.runner.execute(
      createTraining(session.runner.view().fleet.aircraft, planContextOf(session.runner.view())),
    );
    session.runner.execute({ type: 'acceptMission', missionId: 'MSN-000001' });
    session.runner.execute({ type: 'launchMission', missionId: 'MSN-000001' });
    run(session, 12_000);
    return session;
  }

  it('closes during an active mission and reopens to the same mission, objectives included', async () => {
    const first = await midMission();
    await first.runner.flush();
    const atClose = first.runner.view();
    expect(mission(atClose, 'MSN-000001').status).toBe('active');
    first.database.close();

    const second = await launchApp();
    const reopened = second.runner.view();
    expect(reopened.clock).toEqual(atClose.clock);
    expect(reopened.missions).toEqual(atClose.missions);
    expect(reopened.fleet).toEqual(atClose.fleet);

    run(second, 100_000);
    await second.runner.flush();
    const finished = mission(second.runner.view(), 'MSN-000001');
    expect(finished).toMatchObject({ status: 'completed', outcome: { result: 'completed' } });

    // The whole run, close and reopen included, is what the seed and the log produce.
    const saved = (await new SqliteWorldStore(second.database.db).load()) as Checkpoint;
    const replayed = replayWorld(newWorld(), wholeLog(second), saved.snapshot.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(saved.snapshot));
    expect(wholeLog(second).map((entry) => entry.type)).toEqual([
      'seedStarterFleet',
      'createMission',
      'acceptMission',
      'launchMission',
      'objectiveCompleted',
      'flightCompleted',
      'objectiveCompleted',
      'objectiveCompleted',
      'objectiveCompleted',
      'missionCompleted',
    ]);
  });

  it('recovers a consistent active mission when the process dies without a final checkpoint', async () => {
    const first = await midMission();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const lostTick = first.runner.view().clock.tick;
    first.database.close();

    const second = await launchApp();
    const recovered = second.runner.view();
    expect(recovered.clock.tick).toBeLessThanOrEqual(lostTick);
    expect(lostTick - recovered.clock.tick).toBeLessThanOrEqual(200);
    expect(mission(recovered, 'MSN-000001').status).toBe('active');

    // The recovered world is exactly the world at that tick: mission, flight and log agree.
    const saved = (await new SqliteWorldStore(second.database.db).load()) as Checkpoint;
    const replayed = replayWorld(newWorld(), wholeLog(second), recovered.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(saved.snapshot));
  });

  it('keeps generated opportunities across a restart and goes on generating the same ones', async () => {
    const hours = (count: number) => (count * GENERATION.intervalTicks * 1000) / 100;
    const first = await launchApp();
    first.runner.execute({ type: 'setSpeed', speed: 100 });
    first.runner.execute(SEED_FLEET);
    first.runner.execute({ type: 'setOperatingArea', places: OPERATING_AREA });
    run(first, hours(30));
    await first.runner.flush();
    const atClose = first.runner.view();
    const generatedAtClose = atClose.missions.missions.filter((m) => m.source === 'generated');
    expect(generatedAtClose.length).toBeGreaterThan(0);
    first.database.close();

    const second = await launchApp();
    expect(second.runner.view().missions).toEqual(atClose.missions);
    run(second, hours(30));
    await second.runner.flush();

    // An uninterrupted world with the same seed and commands generates exactly the same.
    const reference = SimulationEngine.create(newWorld());
    reference.applyCommand(SEED_FLEET);
    reference.applyCommand({ type: 'setOperatingArea', places: OPERATING_AREA });
    reference.runSteps(second.runner.view().clock.tick);
    expect(second.runner.view().missions).toEqual(reference.missionsView());
    expect(second.runner.view().missions.missions.length).toBeGreaterThan(generatedAtClose.length);
    expect(
      second.database.transport.connection
        .prepare('SELECT opportunities_generated AS n FROM sim_world')
        .get(),
    ).toEqual({ n: reference.snapshot().missions.generated });
  }, 30_000);
});

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MISSION_TEMPLATES,
  defaultBrief,
  fuelDuringTransfer,
  transferDurationS,
} from '@aegis/domain';
import {
  SIM_MODEL_VERSION,
  SimulationEngine,
  SimulationRunner,
  WorldRestoreError,
  defaultConfiguration,
  type AircraftState,
  type Checkpoint,
} from '@aegis/sim';
import {
  FIXTURES,
  ManualHostClock,
  fixtureLaunchFull,
  fixtureOrder,
  fuelled,
  untilServiced,
} from '@aegis/sim/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_FOLDER,
  NodeSqliteTransport,
  migrate,
  openNodeDatabase,
  type NodeDatabase,
} from './node';
import { SqliteWorldStore, WorldStorageError } from './world-store';

/*
 * Ground servicing on disk (ADR 0027): a turnaround or a refuelling survives a restart exactly,
 * and migration 0009 carries an existing world across without loss.
 */

const { places, models } = FIXTURES;
const TRANSPORT = 'AEGIS-TR-001';
const JET = 'AEGIS-FT-001';
const CAPACITY = models.transport.fuelCapacityKg;
const newWorld = () => ({ seed: 'servicing-persisted', epoch: FIXTURES.epoch });
const SEED_FLEET = {
  type: 'seedStarterFleet' as const,
  aircraft: [fixtureOrder('fastJet', places.prestwick), fixtureOrder('transport', places.newquay)],
};
const toExeter = () =>
  fixtureLaunchFull(TRANSPORT, models.transport, places.newquay, places.exeter);

function world(): SimulationEngine {
  const engine = SimulationEngine.create(newWorld());
  engine.applyCommand(SEED_FLEET);
  return engine;
}
const aircraftOf = (engine: SimulationEngine, id = TRANSPORT): AircraftState => {
  const found = engine.snapshot().fleet.aircraft.find((aircraft) => aircraft.id === id);
  if (!found) throw new Error(`no aircraft ${id}`);
  return found;
};
/** The transport just landed at Exeter, in its post-flight checks, with fuel asked for after. */
function turningRound(): SimulationEngine {
  const engine = world();
  engine.applyCommand(toExeter());
  while (aircraftOf(engine).activeFlightId !== null) engine.runSteps(1);
  engine.runSteps(200);
  engine.applyCommand({ type: 'serviceAircraft', aircraftId: TRANSPORT, fuelKg: 50_000 });
  return engine;
}
/** The same world later: the checks are over and fuel is flowing. */
function refuelling(): SimulationEngine {
  const engine = turningRound();
  const checksEnd = aircraftOf(engine).service?.checksCompleteTick as number;
  engine.runSteps(checksEnd - engine.clock.tick + 400);
  return engine;
}
const checkpoint = (engine: SimulationEngine, seq = 1): Checkpoint => ({
  seq,
  wallTimeMs: 1_800_000_000_000 + seq,
  snapshot: engine.snapshot(),
});

describe('ground servicing on disk', () => {
  let database: NodeDatabase;
  let store: SqliteWorldStore;
  const rows = (sql: string) => database.transport.connection.prepare(sql).all();

  beforeEach(() => {
    database = openNodeDatabase(':memory:');
    store = new SqliteWorldStore(database.db);
  });
  afterEach(() => {
    database.close();
  });

  it('round-trips a turnaround and a refuelling exactly', async () => {
    for (const [seq, engine] of [turningRound(), refuelling()].entries()) {
      const saved = checkpoint(engine, seq + 1);
      await store.save(saved);
      expect(await store.load()).toEqual(saved);
    }
    const stored = rows(`SELECT id, status, service, fuel_kg FROM sim_aircraft ORDER BY id`);
    // The aircraft that is not being serviced has no record at all.
    expect(stored[0]).toMatchObject({ id: JET, status: 'available', service: null });
    expect(stored[1]).toMatchObject({ id: TRANSPORT, status: 'servicing' });
    const service = JSON.parse(String(stored[1]?.service)) as AircraftState['service'];
    expect(service).toMatchObject({
      reason: 'turnaround',
      stage: 'preparation',
      fuel: { targetKg: 50_000, transfer: { toKg: 50_000 } },
      payload: null,
    });
    // Part-way: the exact fuel aboard is on disk, between where it began and where it is going.
    // It landed with more than was asked for, so fuel is coming off.
    const fuelKg = Number(stored[1]?.fuel_kg);
    expect(service?.fuel?.transfer?.fromKg).toBeGreaterThan(50_000);
    expect(fuelKg).toBeLessThan(service?.fuel?.transfer?.fromKg as number);
    expect(fuelKg).toBeGreaterThan(50_000);
  });

  it('clears the record when the service ends', async () => {
    const engine = refuelling();
    await store.save(checkpoint(engine, 1));
    expect(rows(`SELECT service FROM sim_aircraft WHERE id = '${TRANSPORT}'`)[0]?.service).not.toBe(
      null,
    );
    untilServiced(engine, TRANSPORT);
    await store.save(checkpoint(engine, 2));
    expect(
      rows(`SELECT status, service, fuel_kg FROM sim_aircraft WHERE id = '${TRANSPORT}'`),
    ).toEqual([{ status: 'available', service: null, fuel_kg: 50_000 }]);
  });

  it('restores an engine that reaches the same tick and the same fuel as one never saved', async () => {
    for (const build of [turningRound, refuelling]) {
      const uninterrupted = build();
      await store.save(checkpoint(build()));
      const loaded = await store.load();
      if (!loaded) throw new Error('expected a saved world');
      const restored = SimulationEngine.restore(loaded.snapshot);
      // As it was saved: the fuel aboard, the stage and the completion tick. Nothing starts again.
      expect(aircraftOf(restored)).toEqual(aircraftOf(uninterrupted));

      const before = aircraftOf(restored);
      const checksEnd = before.service?.checksCompleteTick as number;
      const landedWith = before.service?.fuelAtStartKg as number;
      const readyTick = checksEnd + transferDurationS(CAPACITY, landedWith, 50_000);
      for (const engine of [restored, uninterrupted]) {
        engine.runSteps(readyTick - 1 - engine.clock.tick);
        expect(aircraftOf(engine).status).toBe('servicing');
        engine.runSteps(1);
        expect(aircraftOf(engine)).toMatchObject({
          status: 'available',
          fuelKg: 50_000,
          service: null,
        });
        engine.runSteps(500);
      }
      expect(restored.snapshot()).toEqual(uninterrupted.snapshot());
    }
  });

  it('refuses to load a service record that is not one, or one out of step with its aircraft', async () => {
    await store.save(checkpoint(refuelling()));
    const set = (sql: string) => {
      database.transport.connection.exec(sql);
    };
    const original = String(
      rows(`SELECT service FROM sim_aircraft WHERE id = '${TRANSPORT}'`)[0]?.service,
    );

    set(`UPDATE sim_aircraft SET service = '{"reason":"holiday"}' WHERE id = '${TRANSPORT}'`);
    await expect(store.load()).rejects.toThrow(WorldStorageError);
    set(`UPDATE sim_aircraft SET service = 'not json' WHERE id = '${TRANSPORT}'`);
    await expect(store.load()).rejects.toThrow(WorldStorageError);

    // Well-formed, on an aircraft that is not being serviced: the simulation refuses the world.
    database.transport.connection
      .prepare(`UPDATE sim_aircraft SET service = ? WHERE id = ?`)
      .run(original, JET);
    database.transport.connection
      .prepare(`UPDATE sim_aircraft SET service = ? WHERE id = ?`)
      .run(original, TRANSPORT);
    const loaded = await store.load();
    if (!loaded) throw new Error('expected a saved world');
    expect(() => SimulationEngine.restore(loaded.snapshot)).toThrow(WorldRestoreError);
  });
});

describe('servicing across application restarts', () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-servicing-'));
    path = join(directory, 'aegis.db');
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  async function launchApp() {
    const database = openNodeDatabase(path);
    const host = new ManualHostClock();
    const runner = await SimulationRunner.open({
      store: new SqliteWorldStore(database.db),
      host,
      newWorld,
    });
    return { database, host, runner };
  }
  type Session = Awaited<ReturnType<typeof launchApp>>;
  /** Simulated seconds, at whatever speed the world is set to. */
  function run(session: Session, realMs: number): void {
    for (let elapsed = 0; elapsed < realMs; elapsed += 100) {
      session.host.elapse(100);
      session.runner.advance();
    }
  }
  const transport = (session: Session) => {
    const found = session.runner.view().fleet.aircraft.find((each) => each.id === TRANSPORT);
    if (!found) throw new Error('no transport');
    return found;
  };

  it('closes part-way through a refuelling and reopens to the same fuel and the same time to go', async () => {
    const duration = transferDurationS(CAPACITY, CAPACITY, 30_000);
    const first = await launchApp();
    first.runner.execute({ type: 'setSpeed', speed: 100 });
    first.runner.execute(SEED_FLEET);
    first.runner.execute({ type: 'serviceAircraft', aircraftId: TRANSPORT, fuelKg: 30_000 });
    // Ten simulated minutes at 100x: six seconds of real time.
    run(first, 6000);
    await first.runner.flush();
    const atClose = first.runner.view();
    const closed = transport(first);
    expect(atClose.clock.tick).toBe(600);
    expect(closed.status).toBe('servicing');
    expect(closed.fuelKg).toBeLessThan(CAPACITY);
    expect(closed.fuelKg).toBeGreaterThan(30_000);
    first.database.close();

    // A day passes with the application closed. Nothing is loaded and nothing completes.
    const second = await launchApp();
    const reopened = second.runner.view();
    expect(reopened.clock).toEqual(atClose.clock);
    expect(reopened.fleet).toEqual(atClose.fleet);
    const resumed = transport(second);
    expect(resumed.fuelKg).toBe(closed.fuelKg);
    expect(resumed.service).toEqual(closed.service);
    // Not started again: it began at tick 0 and still ends when it always would have.
    expect(resumed.service).toMatchObject({
      startedTick: 0,
      fuel: { queuedTick: 0, startedTick: 0, transfer: { completeTick: duration } },
    });
    expect(resumed.fuelKg).toBe(
      fuelDuringTransfer(resumed.service?.fuel?.transfer as never, reopened.clock.tick),
    );

    // It goes on, and is ready at exactly the tick an uninterrupted world is.
    const reference = SimulationEngine.create(newWorld());
    reference.applyCommand(SEED_FLEET);
    reference.applyCommand({ type: 'serviceAircraft', aircraftId: TRANSPORT, fuelKg: 30_000 });
    while (second.runner.view().clock.tick < duration - 10) run(second, 100);
    expect(transport(second).status).toBe('servicing');
    run(second, 100);
    expect(second.runner.view().clock.tick).toBe(Math.ceil(duration / 10) * 10);
    expect(transport(second)).toMatchObject({ status: 'available', fuelKg: 30_000, service: null });
    reference.runSteps(second.runner.view().clock.tick);
    expect(transport(second)).toEqual(aircraftOf(reference));
    expect(second.runner.view().integrityDigest).toBe(reference.snapshot().integrityDigest);
    await second.runner.flush();
    second.database.close();
  });

  it('recovers a consistent part-loaded aircraft when the process dies without a final checkpoint', async () => {
    const first = await launchApp();
    first.runner.execute({ type: 'setSpeed', speed: 100 });
    first.runner.execute(SEED_FLEET);
    first.runner.execute({ type: 'serviceAircraft', aircraftId: TRANSPORT, fuelKg: 30_000 });
    run(first, 6500);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const lostTick = first.runner.view().clock.tick;
    first.database.close();

    const second = await launchApp();
    const recovered = second.runner.view();
    expect(recovered.clock.tick).toBeLessThanOrEqual(lostTick);
    const aircraft = transport(second);
    // Whatever tick was last saved, the fuel on disk is the fuel for that tick.
    expect(aircraft.status).toBe('servicing');
    expect(aircraft.fuelKg).toBe(
      fuelDuringTransfer(aircraft.service?.fuel?.transfer as never, recovered.clock.tick),
    );
    const reference = SimulationEngine.create(newWorld());
    reference.applyCommand(SEED_FLEET);
    reference.applyCommand({ type: 'serviceAircraft', aircraftId: TRANSPORT, fuelKg: 30_000 });
    reference.runSteps(recovered.clock.tick);
    expect(aircraft).toEqual(aircraftOf(reference));
    second.database.close();
  });
});

describe('migration 0009 on an existing world', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-migration-0009-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** The migrations up to and including 0008, as a database before this phase had them. */
  function migrationsBefore0009(): string {
    const folder = join(directory, 'migrations-0008');
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 8);
    writeFileSync(journalPath, JSON.stringify(journal));
    return folder;
  }

  /**
   * A world as model 6 left it on disk: the transport in the air, and a mission accepted for the
   * jet, whose tanks are full. Under model 6 nothing was ever serviced.
   */
  async function oldWorld(path: string) {
    // Built by today's engine without anything being serviced, written by today's store into a
    // scratch database, then copied column by column into a database with only the old schema.
    const engine = world();
    engine.applyCommand(toExeter());
    engine.runSteps(600);
    const jet = aircraftOf(engine, JET);
    engine.applyCommand({
      type: 'createMission',
      missionType: 'training',
      ...defaultConfiguration(
        'training',
        {
          ...defaultBrief(MISSION_TEMPLATES.training),
          target: { name: 'North', lat: 56.4, lon: -5.6 },
        },
        jet,
        { context: engine.planContext() },
      ),
    });
    const snapshot = engine.snapshot();
    expect(snapshot.fleet.aircraft.every((aircraft) => aircraft.service === null)).toBe(true);
    const scratch = openNodeDatabase(join(directory, 'scratch.db'));
    const old = new NodeSqliteTransport(path);
    try {
      await new SqliteWorldStore(scratch.db).save({
        seq: 1,
        wallTimeMs: 1_800_000_000_001,
        snapshot,
      });
      migrate(old.connection, migrationsBefore0009());
      const tables = [
        'sim_world',
        'sim_clock',
        'sim_checkpoint',
        'sim_rng_stream',
        'sim_counter',
        'sim_place',
        'sim_aircraft',
        'sim_mission',
        'sim_flight',
        'sim_event',
        'sim_log',
      ];
      for (const table of tables) {
        const columns = (
          old.connection.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as {
            name: string;
          }[]
        ).map((column) => column.name);
        const copied = scratch.transport.connection
          .prepare(`SELECT ${columns.join(', ')} FROM ${table}`)
          .all() as Record<string, string | number | null>[];
        const insert = old.connection.prepare(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        );
        for (const row of copied) insert.run(...columns.map((column) => row[column] ?? null));
      }
      old.connection.exec(`UPDATE sim_world SET model_version = 6`);
      // Accepted under model 6: the aircraft was committed, and nothing was loaded.
      old.connection
        .prepare(`UPDATE sim_mission SET status = 'accepted', accepted_tick = ? WHERE id = ?`)
        .run(snapshot.clock.tick, 'MSN-000001');
    } finally {
      scratch.close();
      old.close();
    }
    return snapshot;
  }
  const hasServiceColumn = (connection: NodeSqliteTransport['connection']) =>
    (
      connection
        .prepare(
          `SELECT count(*) AS n FROM pragma_table_info('sim_aircraft') WHERE name = 'service'`,
        )
        .get() as { n: number }
    ).n === 1;

  it('adds the column, leaves every aircraft as it was, and the world loads and goes on', async () => {
    const path = join(directory, 'aegis.db');
    const before = await oldWorld(path);
    const peek = new NodeSqliteTransport(path);
    expect(hasServiceColumn(peek.connection)).toBe(false);
    const aircraftBefore = peek.connection.prepare(`SELECT * FROM sim_aircraft ORDER BY id`).all();
    const flightsBefore = peek.connection.prepare(`SELECT * FROM sim_flight ORDER BY id`).all();
    const missionsBefore = peek.connection.prepare(`SELECT * FROM sim_mission ORDER BY id`).all();
    const logBefore = peek.connection.prepare(`SELECT * FROM sim_log ORDER BY seq`).all();
    peek.close();

    // Opened by this build: foreign keys on, each migration in its own transaction.
    const database = openNodeDatabase(path);
    const connection = database.transport.connection;
    expect(hasServiceColumn(connection)).toBe(true);
    expect(connection.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    expect(connection.prepare(`PRAGMA integrity_check`).all()).toEqual([{ integrity_check: 'ok' }]);
    expect(
      connection.prepare(`SELECT count(*) AS n FROM __aegis_migrations WHERE idx = 9`).get(),
    ).toEqual({ n: 1 });
    // Every row as it was, with the new column empty.
    expect(connection.prepare(`SELECT * FROM sim_aircraft ORDER BY id`).all()).toEqual(
      aircraftBefore.map((row) => ({ ...row, service: null })),
    );
    expect(connection.prepare(`SELECT * FROM sim_flight ORDER BY id`).all()).toEqual(flightsBefore);
    expect(connection.prepare(`SELECT * FROM sim_mission ORDER BY id`).all()).toEqual(
      missionsBefore,
    );
    expect(connection.prepare(`SELECT * FROM sim_log ORDER BY seq`).all()).toEqual(logBefore);

    const store = new SqliteWorldStore(database.db);
    const loaded = await store.load();
    if (!loaded) throw new Error('expected a saved world');
    expect(loaded.snapshot.modelVersion).toBe(6);
    expect(loaded.snapshot.fleet.aircraft).toEqual(before.fleet.aircraft);

    const engine = SimulationEngine.restore(loaded.snapshot);
    expect(engine.snapshot().modelVersion).toBe(SIM_MODEL_VERSION);
    expect(engine.snapshot().log.completeFromTick).toBe(before.clock.tick);
    // The mission accepted under model 6 waits for its fuel, which now takes time to load.
    const launch = () => engine.applyCommand({ type: 'launchMission', missionId: 'MSN-000001' });
    expect(launch).toThrow(/the flight departs with/);
    const mission = engine.snapshot().missions.missions[0];
    fuelled(engine, JET, mission?.load?.fuelKg as number);
    expect(launch()).toBe(true);
    // The flight that was in the air lands into a turnaround, and the world saves and reloads.
    while (aircraftOf(engine).activeFlightId !== null) engine.runSteps(1);
    const entries = engine.snapshot().log.entries.filter((entry) => entry.aircraftId === TRANSPORT);
    const landing = entries.find((entry) => entry.type === 'flightCompleted');
    expect(entries.find((entry) => entry.type === 'servicingStarted')).toMatchObject({
      tick: landing?.tick,
      payload: { reason: 'turnaround' },
    });
    const saved = checkpoint(engine, 2);
    await store.save(saved);
    expect(await store.load()).toEqual(saved);
    expect(connection.prepare(`SELECT model_version FROM sim_world`).get()).toEqual({
      model_version: SIM_MODEL_VERSION,
    });
    database.close();
  });

  it('is applied whole or not at all: a failure leaves the database as it was', async () => {
    const path = join(directory, 'aegis.db');
    await oldWorld(path);
    const old = new NodeSqliteTransport(path);
    // Something this migration cannot be applied over: the column is already there.
    old.connection.exec(`ALTER TABLE sim_aircraft ADD service text`);
    const aircraftBefore = old.connection.prepare(`SELECT * FROM sim_aircraft ORDER BY id`).all();
    expect(() => migrate(old.connection)).toThrow(/0009_ground_servicing/);
    expect(old.connection.prepare(`SELECT max(idx) AS idx FROM __aegis_migrations`).get()).toEqual({
      idx: 8,
    });
    expect(old.connection.prepare(`SELECT * FROM sim_aircraft ORDER BY id`).all()).toEqual(
      aircraftBefore,
    );
    expect(old.connection.prepare(`PRAGMA integrity_check`).all()).toEqual([
      { integrity_check: 'ok' },
    ]);
    old.close();
  });
});

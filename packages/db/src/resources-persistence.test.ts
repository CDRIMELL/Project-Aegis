import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forecastGroundServices, fuelDuringTransfer, type RoutePoint } from '@aegis/domain';
import {
  SIM_MODEL_VERSION,
  SimulationEngine,
  SimulationRunner,
  type AircraftState,
  type Checkpoint,
} from '@aegis/sim';
import { FIXTURES, ManualHostClock, fixtureOrder, untilServiced } from '@aegis/sim/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MIGRATIONS_FOLDER,
  NodeSqliteTransport,
  migrate,
  openNodeDatabase,
  type NodeDatabase,
} from './node';
import { SqliteWorldStore } from './world-store';

/*
 * Ground resources on disk (ADR 0028): a queue, a transfer and a payload being loaded survive a
 * restart exactly; an aerodrome keeps its size class; a service saved by model 7 is carried over;
 * and migration 0010 leaves an existing world as it was.
 */

const { places, models } = FIXTURES;
const A = 'AEGIS-TR-001';
const B = 'AEGIS-TR-002';
const CAPACITY = models.transport.fuelCapacityKg;
const LARGE: RoutePoint = { ...places.exeter, size: 'large' };
const newWorld = () => ({ seed: 'resources-persisted', epoch: FIXTURES.epoch });
const SEED_FLEET = {
  type: 'seedStarterFleet' as const,
  aircraft: [fixtureOrder('transport', places.newquay), fixtureOrder('transport', places.newquay)],
};
const prepare = (aircraftId: string, fuelKg: number, payloadKg: number) => ({
  type: 'serviceAircraft' as const,
  aircraftId,
  fuelKg,
  payloadKg,
});

/** A is being fuelled and loaded; B is being loaded behind nothing and waits for the fuel point. */
function contended(): SimulationEngine {
  const engine = SimulationEngine.create(newWorld());
  engine.applyCommand(SEED_FLEET);
  engine.applyCommand({ type: 'setOperatingArea', places: [places.newquay, LARGE] });
  engine.applyCommand(prepare(A, 30_000, 3000));
  engine.runSteps(450);
  engine.applyCommand(prepare(B, 40_000, 6000));
  engine.runSteps(150);
  return engine;
}
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
const forecasts = (engine: SimulationEngine) =>
  forecastGroundServices(engine.snapshot().fleet.aircraft, engine.clock.tick);

describe('ground resources on disk', () => {
  let database: NodeDatabase;
  let store: SqliteWorldStore;
  beforeEach(() => {
    database = openNodeDatabase(':memory:');
    store = new SqliteWorldStore(database.db);
  });
  afterEach(() => {
    database.close();
  });

  it('round-trips a queue, a transfer and a payload being loaded, and the size of an aerodrome', async () => {
    const engine = contended();
    // What is being saved: every kind of state at once.
    expect(aircraftOf(engine, A).service).toMatchObject({
      fuel: { transfer: { toKg: 30_000 }, completedTick: null },
      payload: { completedTick: 400 },
    });
    expect(aircraftOf(engine, B).service).toMatchObject({
      fuel: { transfer: null, queuedTick: 450 },
      payload: { transfer: { startTick: 450 }, completedTick: null },
    });
    const saved = checkpoint(engine);
    await store.save(saved);
    const loaded = await store.load();
    expect(loaded).toEqual(saved);
    expect(loaded?.snapshot.missions.places).toEqual([places.newquay, LARGE]);
    expect(
      database.transport.connection
        .prepare(`SELECT code, size FROM sim_place ORDER BY ordinal`)
        .all(),
    ).toEqual([
      { code: 'EGHQ', size: null },
      { code: 'EGTE', size: 'large' },
    ]);
  });

  it('restores occupancy, queue order and progress, and goes on to the same ticks', async () => {
    const uninterrupted = contended();
    await store.save(checkpoint(contended()));
    const loaded = await store.load();
    if (!loaded) throw new Error('expected a saved world');
    const restored = SimulationEngine.restore(loaded.snapshot);
    // Who holds the point and who waits is in the aircraft's own records: nothing to rebuild.
    expect(restored.snapshot().fleet).toEqual(uninterrupted.snapshot().fleet);
    const said = forecasts(restored);
    expect(said).toEqual(forecasts(uninterrupted));
    expect(said.get(B)?.fuel).toMatchObject({ state: 'waiting', position: 1, behind: A });

    for (const engine of [restored, uninterrupted]) {
      const turn = said.get(B)?.fuel?.startTick as number;
      engine.runSteps(turn - 1 - engine.clock.tick);
      expect(aircraftOf(engine, B).fuelKg).toBe(CAPACITY);
      engine.runSteps(1);
      expect(aircraftOf(engine, A).status).toBe('available');
      expect(aircraftOf(engine, B).service?.fuel?.transfer?.startTick).toBe(turn);
      untilServiced(engine, B);
      expect(engine.clock.tick).toBe(said.get(B)?.completeTick);
      expect(aircraftOf(engine, B)).toMatchObject({ fuelKg: 40_000, payloadKg: 6000 });
    }
    expect(restored.snapshot()).toEqual(uninterrupted.snapshot());
  });

  it('loads a service as model 7 wrote it, and the engine carries it over', async () => {
    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand(SEED_FLEET);
    engine.applyCommand({ type: 'serviceAircraft', aircraftId: A, fuelKg: 30_000 });
    engine.runSteps(700);
    await store.save(checkpoint(engine));
    const now = aircraftOf(engine).service;
    if (!now?.fuel?.transfer) throw new Error('setup');
    const connection = database.transport.connection;
    // The row as the previous build left it: fuel only, and no queue.
    connection.prepare(`UPDATE sim_aircraft SET service = ? WHERE id = ?`).run(
      JSON.stringify({
        reason: now.reason,
        startedTick: now.startedTick,
        stage: 'refuelling',
        checksCompleteTick: now.checksCompleteTick,
        fuelAtStartKg: now.fuelAtStartKg,
        targetFuelKg: now.fuel.targetKg,
        transfer: now.fuel.transfer,
        refuellingSinceTick: now.fuel.startedTick,
        missionId: null,
      }),
      A,
    );
    connection.exec(`UPDATE sim_world SET model_version = 7`);

    const loaded = await store.load();
    if (!loaded) throw new Error('expected a saved world');
    expect(loaded.snapshot.modelVersion).toBe(7);
    const upgraded = SimulationEngine.restore(loaded.snapshot);
    expect(upgraded.snapshot().modelVersion).toBe(SIM_MODEL_VERSION);
    expect(aircraftOf(upgraded)).toEqual(aircraftOf(engine));
    untilServiced(upgraded, A);
    expect(upgraded.clock.tick).toBe(now.fuel.transfer.completeTick);
    expect(aircraftOf(upgraded).fuelKg).toBe(30_000);
    // Saved again, it is in this build's shape, and reloads as itself.
    const again = checkpoint(upgraded, 2);
    await store.save(again);
    expect(await store.load()).toEqual(again);
  });
});

describe('a queue across application restarts', () => {
  let directory: string;
  let path: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-resources-'));
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
  function run(session: Session, realMs: number): void {
    for (let elapsed = 0; elapsed < realMs; elapsed += 100) {
      session.host.elapse(100);
      session.runner.advance();
    }
  }
  const fleetOf = (session: Session) => session.runner.view().fleet.aircraft;
  const one = (session: Session, id: string) => {
    const found = fleetOf(session).find((each) => each.id === id);
    if (!found) throw new Error(`no aircraft ${id}`);
    return found;
  };

  it('closes with one aircraft fuelling and another waiting, and reopens to the same queue', async () => {
    const first = await launchApp();
    first.runner.execute({ type: 'setSpeed', speed: 100 });
    first.runner.execute(SEED_FLEET);
    first.runner.execute(prepare(A, 30_000, 3000));
    first.runner.execute(prepare(B, 40_000, 6000));
    // Ten simulated minutes at 100x.
    run(first, 6000);
    await first.runner.flush();
    const atClose = first.runner.view();
    const said = forecastGroundServices(atClose.fleet.aircraft, atClose.clock.tick);
    expect(one(first, A).service?.fuel?.transfer).not.toBeNull();
    expect(one(first, B).service?.fuel).toMatchObject({ transfer: null, queuedTick: 0 });
    expect(said.get(B)?.fuel).toMatchObject({ position: 1, behind: A });
    first.database.close();

    const second = await launchApp();
    const reopened = second.runner.view();
    expect(reopened.clock).toEqual(atClose.clock);
    expect(reopened.fleet).toEqual(atClose.fleet);
    // The queue, the occupancy and every time to go are as they were.
    expect(forecastGroundServices(reopened.fleet.aircraft, reopened.clock.tick)).toEqual(said);
    const fuelling = one(second, A);
    expect(fuelling.fuelKg).toBe(
      fuelDuringTransfer(fuelling.service?.fuel?.transfer as never, reopened.clock.tick),
    );
    expect(one(second, B).fuelKg).toBe(CAPACITY);

    // It goes on: B gets the point when A gives it up, and both end when they were going to.
    const reference = SimulationEngine.create(newWorld());
    reference.applyCommand(SEED_FLEET);
    reference.applyCommand(prepare(A, 30_000, 3000));
    reference.applyCommand(prepare(B, 40_000, 6000));
    while (one(second, B).status === 'servicing') run(second, 100);
    reference.runSteps(second.runner.view().clock.tick);
    expect(fleetOf(second)).toEqual(reference.snapshot().fleet.aircraft);
    expect(second.runner.view().integrityDigest).toBe(reference.snapshot().integrityDigest);
    const done = said.get(B)?.completeTick as number;
    expect(second.runner.view().clock.tick).toBe(Math.ceil(done / 10) * 10);
    await second.runner.flush();
    second.database.close();
  });
});

describe('migration 0010 on an existing world', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-migration-0010-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('adds the column, leaves every place as it was, and the world loads', async () => {
    // A database with the schema before this phase, holding a world written column by column.
    const folder = join(directory, 'migrations-0009');
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 9);
    writeFileSync(journalPath, JSON.stringify(journal));

    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand(SEED_FLEET);
    engine.applyCommand({ type: 'setOperatingArea', places: [places.newquay, places.exeter] });
    engine.runSteps(300);
    const snapshot = engine.snapshot();
    const path = join(directory, 'aegis.db');
    const scratch = openNodeDatabase(join(directory, 'scratch.db'));
    const old = new NodeSqliteTransport(path);
    await new SqliteWorldStore(scratch.db).save({ seq: 1, wallTimeMs: 1, snapshot });
    migrate(old.connection, folder);
    for (const table of [
      'sim_world',
      'sim_clock',
      'sim_checkpoint',
      'sim_rng_stream',
      'sim_counter',
      'sim_place',
      'sim_aircraft',
      'sim_log',
    ]) {
      const columns = (
        old.connection.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as {
          name: string;
        }[]
      ).map((column) => column.name);
      const rows = scratch.transport.connection
        .prepare(`SELECT ${columns.join(', ')} FROM ${table}`)
        .all() as Record<string, string | number | null>[];
      const insert = old.connection.prepare(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      );
      for (const row of rows) insert.run(...columns.map((column) => row[column] ?? null));
    }
    old.connection.exec(`UPDATE sim_world SET model_version = 7`);
    const placesBefore = old.connection.prepare(`SELECT * FROM sim_place ORDER BY ordinal`).all();
    expect(placesBefore[0]).not.toHaveProperty('size');
    scratch.close();
    old.close();

    const database = openNodeDatabase(path);
    const connection = database.transport.connection;
    expect(
      connection.prepare(`SELECT count(*) AS n FROM __aegis_migrations WHERE idx = 10`).get(),
    ).toEqual({ n: 1 });
    expect(connection.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    expect(connection.prepare(`PRAGMA integrity_check`).all()).toEqual([{ integrity_check: 'ok' }]);
    expect(connection.prepare(`SELECT * FROM sim_place ORDER BY ordinal`).all()).toEqual(
      placesBefore.map((row) => ({ ...row, size: null })),
    );
    const loaded = await new SqliteWorldStore(database.db).load();
    expect(loaded?.snapshot.missions.places).toEqual([places.newquay, places.exeter]);
    expect(loaded?.snapshot.fleet.aircraft).toEqual(snapshot.fleet.aircraft);
    const upgraded = SimulationEngine.restore(loaded?.snapshot as never);
    expect(upgraded.snapshot().modelVersion).toBe(SIM_MODEL_VERSION);
    // With no size class recorded, an aerodrome is treated as medium: one fuel point.
    upgraded.applyCommand(prepare(A, 30_000, 0));
    upgraded.applyCommand(prepare(B, 30_000, 0));
    expect(
      forecastGroundServices(upgraded.snapshot().fleet.aircraft, upgraded.clock.tick).get(B)?.fuel,
    ).toMatchObject({ state: 'waiting', behind: A });
    database.close();
  });
});

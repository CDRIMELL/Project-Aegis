import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { careerTotals, type RoutePoint } from '@aegis/domain';
import {
  SIM_MODEL_VERSION,
  SimulationEngine,
  SimulationRunner,
  replayComparable,
  replayWorld,
  type Checkpoint,
  type LogEntry,
} from '@aegis/sim';
import { FIXTURES, ManualHostClock, fixtureOrder } from '@aegis/sim/testing';
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
 * The career on disk (ADR 0030, ADR 0031): command days, the record and the world's own missions
 * survive a restart exactly; a closed day is written once and never changed; totals read back
 * are the sums they were; a world is created only when asked for, and replaced only whole; and
 * migration 0011 leaves an existing world as it was.
 */

const { places } = FIXTURES;
const HOUR = 3600;
const CARDIFF: RoutePoint = {
  kind: 'aerodrome',
  refId: 'fixture:egff',
  name: 'Cardiff',
  code: 'EGFF',
  lat: 51.3967,
  lon: -3.3433,
  elevationM: 67,
};
const newWorld = () => ({ seed: 'career-persisted', epoch: FIXTURES.epoch });
const SEED_FLEET = {
  type: 'seedStarterFleet' as const,
  aircraft: [
    fixtureOrder('transport', places.newquay),
    fixtureOrder('transport', places.newquay),
    fixtureOrder('transport', places.newquay),
    fixtureOrder('fastJet', places.prestwick),
    fixtureOrder('fastJet', places.prestwick),
  ],
};
const AREA = {
  type: 'setOperatingArea' as const,
  places: [places.newquay, places.exeter, places.prestwick, CARDIFF],
};

function career(): SimulationEngine {
  const engine = SimulationEngine.create(newWorld());
  engine.applyCommand(SEED_FLEET);
  engine.applyCommand(AREA);
  engine.applyCommand({ type: 'beginCareer' });
  engine.runSteps(6 * HOUR);
  engine.applyCommand({ type: 'takeCommand' });
  return engine;
}
const checkpoint = (engine: SimulationEngine, seq = 1): Checkpoint => ({
  seq,
  wallTimeMs: 1_800_000_000_000 + seq,
  snapshot: engine.snapshot(),
});

describe('a career on disk', { timeout: 120_000 }, () => {
  let database: NodeDatabase;
  let store: SqliteWorldStore;
  beforeEach(() => {
    database = openNodeDatabase(':memory:');
    store = new SqliteWorldStore(database.db);
  });
  afterEach(() => {
    database.close();
  });
  const days = () =>
    database.transport.connection
      .prepare(
        `SELECT number, started_tick, ended_tick, counters FROM sim_career_day ORDER BY number`,
      )
      .all() as {
      number: number;
      started_tick: number;
      ended_tick: number | null;
      counters: string;
    }[];

  it('round-trips the open day, the closed days, routine operations and the world’s own missions', async () => {
    const engine = career();
    engine.runSteps(5 * HOUR);
    engine.applyCommand({ type: 'endCommandDay' });
    engine.runSteps(2 * HOUR);
    const saved = checkpoint(engine);
    expect(saved.snapshot.career).toMatchObject({
      establishedTick: 0,
      day: { number: 2, endedTick: null },
      days: [{ number: 1, startedTick: 6 * HOUR, endedTick: 11 * HOUR }],
    });
    expect(saved.snapshot.missions.missions.some((mission) => mission.routine)).toBe(true);
    await store.save(saved);
    const loaded = await store.load();
    // The log in memory is a tail; everything else is exactly what was saved.
    expect(replayComparable((loaded as Checkpoint).snapshot)).toEqual(
      replayComparable(saved.snapshot),
    );
    expect(loaded?.snapshot.career).toEqual(saved.snapshot.career);
    expect(loaded?.snapshot.missions.routine).toEqual(saved.snapshot.missions.routine);
    expect(
      database.transport.connection
        .prepare(`SELECT career_established_tick, routine_enabled, routine_tasked FROM sim_world`)
        .get(),
    ).toEqual({
      career_established_tick: 0,
      routine_enabled: 1,
      routine_tasked: saved.snapshot.missions.routine.tasked,
    });
    const routine = database.transport.connection
      .prepare(`SELECT count(*) AS n FROM sim_mission WHERE routine = 1`)
      .get() as { n: number };
    expect(routine.n).toBe(saved.snapshot.missions.routine.tasked);
  });

  it('writes a closed day once and never changes it, while the open day follows the world', async () => {
    const engine = career();
    engine.runSteps(3 * HOUR);
    await store.save(checkpoint(engine, 1));
    expect(days().map((day) => [day.number, day.ended_tick])).toEqual([[1, null]]);
    engine.runSteps(2 * HOUR);
    engine.applyCommand({ type: 'endCommandDay' });
    await store.save(checkpoint(engine, 2));
    const [first, second] = days();
    expect(first).toMatchObject({ number: 1, started_tick: 6 * HOUR, ended_tick: 11 * HOUR });
    expect(second).toMatchObject({ number: 2, started_tick: 11 * HOUR, ended_tick: null });
    // Tampering with a closed day on disk is not overwritten by a later checkpoint: it is not
    // written again at all.
    database.transport.connection
      .prepare(`UPDATE sim_career_day SET counters = ? WHERE number = 1`)
      .run('{"marker":1}');
    engine.runSteps(4 * HOUR);
    await store.save(checkpoint(engine, 3));
    expect(days()[0]?.counters).toBe('{"marker":1}');
    expect(JSON.parse(days()[1]?.counters ?? '{}')).toEqual(engine.snapshot().career.day?.counters);
  });

  it('reads back totals that are the sums they were, day after day', async () => {
    const uninterrupted = career();
    let engine = career();
    let seq = 1;
    for (const hours of [4, 6, 3, 5]) {
      for (const each of [engine, uninterrupted]) {
        each.runSteps(hours * HOUR);
        each.applyCommand({ type: 'endCommandDay' });
      }
      await store.save(checkpoint(engine, seq++));
      const loaded = await store.load();
      engine = SimulationEngine.restore((loaded as Checkpoint).snapshot);
      expect(engine.careerView()).toEqual(uninterrupted.careerView());
    }
    const view = engine.careerView();
    expect(view.closedDays).toBe(4);
    expect(view.totals.commandSeconds).toBe(18 * HOUR);
    expect(view.closedTotals).toEqual(
      careerTotals(engine.snapshot().career.days, engine.clock.tick),
    );
    // And what is on disk adds up to the same.
    const onDisk = days()
      .filter((day) => day.ended_tick !== null)
      .reduce(
        (sum, day) =>
          sum + ((JSON.parse(day.counters) as Record<string, number>)['flights.completed'] ?? 0),
        0,
      );
    expect(onDisk).toBe(view.closedTotals.counters['flights.completed']);
    expect(onDisk).toBeGreaterThan(0);
  });

  it('refuses a saved career with two open days', async () => {
    const engine = career();
    await store.save(checkpoint(engine));
    database.transport.connection
      .prepare(
        `INSERT INTO sim_career_day (number, started_tick, ended_tick, counters, aircraft_seconds, ready_seconds) VALUES (2, ?, NULL, '{}', 0, 0)`,
      )
      .run(7 * HOUR);
    await expect(store.load()).rejects.toThrow(/more than one open day/);
  });

  it('removes the world whole, and only the world', async () => {
    const engine = career();
    engine.runSteps(2 * HOUR);
    await store.save(checkpoint(engine));
    const connection = database.transport.connection;
    const kept = () =>
      connection.prepare(`SELECT count(*) AS n FROM __aegis_migrations`).get() as { n: number };
    const migrations = kept().n;
    await store.clear();
    expect(await store.load()).toBeNull();
    for (const table of [
      'sim_world',
      'sim_clock',
      'sim_checkpoint',
      'sim_rng_stream',
      'sim_aircraft',
      'sim_flight',
      'sim_mission',
      'sim_event',
      'sim_place',
      'sim_counter',
      'sim_log',
      'sim_career_day',
    ]) {
      expect(connection.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({
        n: 0,
      });
    }
    expect(kept().n).toBe(migrations);
    expect(connection.prepare(`SELECT count(*) AS n FROM ref_location`).get()).toEqual({ n: 0 });
    expect(connection.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    // A new world saves into the same store from sequence 1, log and all.
    const fresh = SimulationEngine.create({ seed: 'second-career', epoch: FIXTURES.epoch });
    fresh.applyCommand(SEED_FLEET);
    await store.save(checkpoint(fresh));
    const loaded = await store.load();
    expect(loaded?.snapshot.seed).toBe('second-career');
    expect(loaded?.snapshot.log.entries.map((entry) => entry.seq)).toEqual([1]);
  });
});

describe('a career across application restarts', { timeout: 180_000 }, () => {
  let directory: string;
  let path: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-career-'));
    path = join(directory, 'aegis.db');
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function session(database: NodeDatabase) {
    const host = new ManualHostClock();
    const store = new SqliteWorldStore(database.db);
    const run = (runner: SimulationRunner, simSeconds: number) => {
      // At 100x, a tenth of a second of real time is ten simulated seconds.
      for (let done = 0; done < simSeconds; done += 10) {
        host.elapse(100);
        runner.advance();
      }
    };
    return { host, store, run };
  }

  it('opens nothing until a world is asked for, then continues the same career each time', async () => {
    let database = openNodeDatabase(path);
    let { host, store, run } = session(database);
    // A database with no world: nothing is created by looking.
    expect(await SimulationRunner.load({ store, host })).toBeNull();
    expect(
      database.transport.connection.prepare(`SELECT count(*) AS n FROM sim_world`).get(),
    ).toEqual({ n: 0 });

    let runner = await SimulationRunner.create({ store, host, newWorld });
    runner.execute(SEED_FLEET);
    runner.execute(AREA);
    runner.execute({ type: 'beginCareer' });
    // The hours before command: ordinary steps, whatever the clock's run state.
    runner.execute({ type: 'pause' });
    runner.fastForward(6 * HOUR + 12 * 60);
    expect(runner.view().clock).toMatchObject({ tick: 6 * HOUR + 720, running: false });
    expect(
      runner.view().fleet.recentFlights.length + runner.view().fleet.activeFlights.length,
    ).toBeGreaterThan(0);
    runner.execute({ type: 'takeCommand' });
    runner.execute({ type: 'setSpeed', speed: 100 });
    runner.execute({ type: 'resume' });
    run(runner, 5 * HOUR);
    runner.execute({ type: 'endCommandDay' });
    run(runner, 90 * 60);
    await runner.flush();
    const atClose = runner.view();
    expect(atClose.career).toMatchObject({ closedDays: 1, day: { number: 2 } });
    database.close();

    // Reopened: the same world, the same day, the same record. Real time away is not paid back.
    database = openNodeDatabase(path);
    ({ host, store, run } = session(database));
    const reopened = await SimulationRunner.load({ store, host });
    if (!reopened) throw new Error('the career was not found');
    runner = reopened;
    host.elapse(3_600_000);
    runner.resync();
    runner.advance();
    expect(runner.view().clock.tick).toBe(atClose.clock.tick);
    expect(runner.view().career).toEqual(atClose.career);
    expect(runner.view().fleet).toEqual(atClose.fleet);
    expect(runner.view().missions).toEqual(atClose.missions);

    // It goes on exactly as a world that was never closed.
    run(runner, 4 * HOUR);
    runner.execute({ type: 'endCommandDay' });
    run(runner, HOUR);
    await runner.flush();
    const reference = SimulationEngine.create(newWorld());
    reference.applyCommand(SEED_FLEET);
    reference.applyCommand(AREA);
    reference.applyCommand({ type: 'beginCareer' });
    reference.runSteps(6 * HOUR + 720);
    reference.applyCommand({ type: 'takeCommand' });
    reference.runSteps(5 * HOUR);
    reference.applyCommand({ type: 'endCommandDay' });
    reference.runSteps(90 * 60 + 4 * HOUR);
    reference.applyCommand({ type: 'endCommandDay' });
    reference.runSteps(HOUR);
    expect(runner.view().clock.tick).toBe(reference.clock.tick);
    expect(runner.view().integrityDigest).toBe(reference.snapshot().integrityDigest);
    expect(runner.view().career).toEqual(reference.careerView());
    expect(runner.view().career.totals).toMatchObject({ days: 3, commandSeconds: 11.5 * HOUR });

    // And the whole of it is what its seed and its log produce.
    const saved = (await store.load()) as Checkpoint;
    const log = database.transport.connection
      .prepare('SELECT * FROM sim_log ORDER BY seq')
      .all()
      .map((row): LogEntry => ({
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
    expect(log.map((entry) => entry.seq)).toEqual(log.map((_, index) => index + 1));
    const replayed = replayWorld(newWorld(), log, saved.snapshot.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(saved.snapshot));
    database.close();
  });

  it('replaces a career with a new one only whole', async () => {
    const database = openNodeDatabase(path);
    const { host, store } = session(database);
    const first = await SimulationRunner.create({ store, host, newWorld });
    first.execute(SEED_FLEET);
    first.execute({ type: 'beginCareer' });
    first.execute({ type: 'takeCommand' });
    await first.flush();
    const second = await SimulationRunner.create({
      store,
      host,
      newWorld: () => ({ seed: 'the-next-career', epoch: FIXTURES.epoch }),
    });
    expect(second.view()).toMatchObject({
      seed: 'the-next-career',
      clock: { tick: 0 },
      logLength: 0,
      career: { establishedTick: null, day: null, closedDays: 0 },
    });
    expect(second.view().fleet.aircraft).toEqual([]);
    const loaded = await SimulationRunner.load({ store: new SqliteWorldStore(database.db), host });
    expect(loaded?.view().seed).toBe('the-next-career');
    database.close();
  });
});

describe('migration 0011 on an existing world', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-migration-0011-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('adds the table and columns, leaves the world as it was, and it is not a career', async () => {
    const folder = join(directory, 'migrations-0010');
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 10);
    writeFileSync(journalPath, JSON.stringify(journal));

    // A world with a mission in it, written column by column into the schema before this one.
    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand(SEED_FLEET);
    engine.applyCommand(AREA);
    engine.runSteps(5 * HOUR);
    const snapshot = engine.snapshot();
    expect(snapshot.missions.missions.length).toBeGreaterThan(0);
    const path = join(directory, 'aegis.db');
    const scratch = openNodeDatabase(join(directory, 'scratch.db'));
    const old = new NodeSqliteTransport(path);
    await new SqliteWorldStore(scratch.db).save({ seq: 1, wallTimeMs: 1, snapshot });
    migrate(old.connection, folder);
    const tables = [
      'sim_world',
      'sim_clock',
      'sim_checkpoint',
      'sim_rng_stream',
      'sim_counter',
      'sim_place',
      'sim_aircraft',
      'sim_mission',
      'sim_log',
    ];
    for (const table of tables) {
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
    old.connection.exec(`UPDATE sim_world SET model_version = 9`);
    const before = Object.fromEntries(
      tables.map((table) => [table, old.connection.prepare(`SELECT * FROM ${table}`).all()]),
    );
    expect(before.sim_world?.[0]).not.toHaveProperty('routine_enabled');
    scratch.close();
    old.close();

    const database = openNodeDatabase(path);
    const connection = database.transport.connection;
    expect(
      connection.prepare(`SELECT count(*) AS n FROM __aegis_migrations WHERE idx = 11`).get(),
    ).toEqual({ n: 1 });
    expect(connection.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    expect(connection.prepare(`PRAGMA integrity_check`).all()).toEqual([{ integrity_check: 'ok' }]);
    expect(connection.prepare(`SELECT * FROM sim_world`).all()).toEqual(
      (before.sim_world ?? []).map((row) => ({
        ...(row as object),
        career_established_tick: null,
        routine_enabled: 0,
        routine_tasked: 0,
      })),
    );
    expect(connection.prepare(`SELECT * FROM sim_mission`).all()).toEqual(
      (before.sim_mission ?? []).map((row) => ({ ...(row as object), routine: 0 })),
    );
    expect(connection.prepare(`SELECT count(*) AS n FROM sim_career_day`).get()).toEqual({ n: 0 });

    const loaded = await new SqliteWorldStore(database.db).load();
    expect(loaded?.snapshot.modelVersion).toBe(9);
    expect(loaded?.snapshot.career).toEqual({ establishedTick: null, day: null, days: [] });
    expect(loaded?.snapshot.missions.missions).toEqual(snapshot.missions.missions);
    const upgraded = SimulationEngine.restore((loaded as Checkpoint).snapshot);
    expect(upgraded.snapshot().modelVersion).toBe(SIM_MODEL_VERSION);
    upgraded.runSteps(6 * HOUR);
    expect(upgraded.snapshot().missions.routine).toEqual({ enabled: false, tasked: 0 });
    expect(upgraded.snapshot().fleet.flights).toEqual([]);
    database.close();
  });
});

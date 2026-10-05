import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECENT_LOG,
  SimulationEngine,
  SimulationRunner,
  replayComparable,
  replayWorld,
  type Checkpoint,
  type LogEntry,
} from '@aegis/sim';
import { FIXTURES, ManualHostClock, fixtureLaunchFull, fixtureOrder } from '@aegis/sim/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNodeDatabase, type NodeDatabase } from './node';
import { SqliteWorldStore, WorldStorageError } from './world-store';

const { places, models } = FIXTURES;
const newWorld = () => ({ seed: 'persisted-log', epoch: FIXTURES.epoch });

const SEED_FLEET = {
  type: 'seedStarterFleet',
  aircraft: [fixtureOrder('fastJet', places.prestwick), fixtureOrder('transport', places.newquay)],
} as const;
// With the fuel it was acquired with, so that nothing has to be loaded first (ADR 0027).
const LAUNCH = fixtureLaunchFull('AEGIS-FT-001', models.fastJet, places.prestwick, places.newquay);

const checkpoint = (engine: SimulationEngine, seq = 1): Checkpoint => ({
  seq,
  wallTimeMs: 1_800_000_000_000 + seq,
  snapshot: engine.snapshot(),
});

describe('log persistence', () => {
  let database: NodeDatabase;
  let store: SqliteWorldStore;
  const all = (sql: string) => database.transport.connection.prepare(sql).all();
  const exec = (sql: string) => {
    database.transport.connection.exec(sql);
  };

  beforeEach(() => {
    database = openNodeDatabase(':memory:');
    store = new SqliteWorldStore(database.db);
  });
  afterEach(() => {
    database.close();
  });

  it('round-trips log entries exactly, payload included', async () => {
    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand(SEED_FLEET);
    engine.applyCommand(LAUNCH);
    engine.runSteps(4000);
    const saved = checkpoint(engine);
    await store.save(saved);

    const loaded = await store.load();
    expect(loaded).toEqual(saved);
    expect(loaded?.snapshot.log.entries.map((entry) => entry.type)).toEqual([
      'seedStarterFleet',
      'launchFlight',
      'flightCompleted',
      // The turnaround after landing (ADR 0027).
      'servicingStarted',
      'servicingCompleted',
    ]);
  });

  it('appends only new entries and never rewrites an existing one', async () => {
    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand(SEED_FLEET);
    await store.save(checkpoint(engine, 1));
    // If a later checkpoint rewrote this row, the marker would be lost.
    exec(`UPDATE sim_log SET type = 'marker' WHERE seq = 1`);

    engine.applyCommand(LAUNCH);
    await store.save(checkpoint(engine, 2));
    await store.save(checkpoint(engine, 3));

    expect(all('SELECT seq, type FROM sim_log ORDER BY seq')).toEqual([
      { seq: 1, type: 'marker' },
      { seq: 2, type: 'launchFlight' },
    ]);
  });

  it('is idempotent when a different store instance saves the same checkpoint again', async () => {
    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand(SEED_FLEET);
    engine.applyCommand(LAUNCH);
    await store.save(checkpoint(engine, 1));
    await new SqliteWorldStore(database.db).save(checkpoint(engine, 2));
    expect(all('SELECT count(*) AS n FROM sim_log')).toEqual([{ n: 2 }]);
  });

  it('keeps the whole log on disk and loads only the recent tail', async () => {
    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand(SEED_FLEET);
    const total = RECENT_LOG + 40;
    for (let i = 1; i < total; i++) {
      engine.runSteps(1);
      engine.applyCommand({
        type: 'setHome',
        aircraftId: 'AEGIS-TR-001',
        home: i % 2 === 0 ? places.newquay : places.exeter,
      });
    }
    await store.save(checkpoint(engine));

    expect(all('SELECT count(*) AS n, min(seq) AS first, max(seq) AS last FROM sim_log')).toEqual([
      { n: total, first: 1, last: total },
    ]);
    const loaded = await store.load();
    expect(loaded?.snapshot.log.nextSeq).toBe(total + 1);
    expect(loaded?.snapshot.log.entries).toHaveLength(RECENT_LOG);
    expect(loaded?.snapshot.log.entries[0]?.seq).toBe(total - RECENT_LOG + 1);
    // The loaded tail restores and the sequence carries on.
    const restored = SimulationEngine.restore((loaded as Checkpoint).snapshot);
    restored.applyCommand({ type: 'setHome', aircraftId: 'AEGIS-FT-001', home: places.exeter });
    expect(restored.snapshot().log.entries.at(-1)?.seq).toBe(total + 1);
  });

  it('enforces the shape of a log row in the database', async () => {
    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand(SEED_FLEET);
    await store.save(checkpoint(engine));
    const insert = (kind: string, actor: string) => () => {
      exec(
        `INSERT INTO sim_log (seq, tick, kind, type, actor, payload) VALUES (99, 0, '${kind}', 'x', '${actor}', '{}')`,
      );
    };
    expect(insert('rumour', 'player')).toThrow(/sim_log_kind_known/);
    expect(insert('event', 'player')).toThrow(/sim_log_actor_matches_kind/);
    expect(insert('command', 'world')).toThrow(/sim_log_actor_matches_kind/);
  });

  it('refuses a log row whose payload is not a JSON object', async () => {
    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand(SEED_FLEET);
    await store.save(checkpoint(engine));
    exec(`UPDATE sim_log SET payload = '[1,2' WHERE seq = 1`);
    await expect(store.load()).rejects.toThrow(WorldStorageError);
  });
});

describe('log continuity across application restarts', () => {
  let directory: string;
  let path: string;
  const open: NodeDatabase[] = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-log-'));
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

  it('keeps one gapless log across a close and reopen, and the saved world replays from it', async () => {
    const first = await launchApp();
    first.runner.execute({ type: 'setSpeed', speed: 100 });
    first.runner.execute(SEED_FLEET);
    run(first, 3000);
    first.runner.execute(LAUNCH);
    run(first, 20_000);
    await first.runner.flush();
    first.database.close();

    const second = await launchApp();
    run(second, 30_000);
    second.runner.execute({ type: 'startMaintenance', aircraftId: 'AEGIS-FT-001' });
    run(second, 5000);
    await second.runner.flush();

    const log = wholeLog(second);
    expect(log.map((entry) => entry.seq)).toEqual(log.map((_, index) => index + 1));
    expect(log.map((entry) => entry.type)).toEqual([
      'seedStarterFleet',
      'launchFlight',
      'flightCompleted',
      'servicingStarted',
      'servicingCompleted',
      'startMaintenance',
    ]);
    // Pacing commands are not part of the log.
    expect(log.some((entry) => entry.type === 'setSpeed')).toBe(false);

    const saved = await new SqliteWorldStore(second.database.db).load();
    const snapshot = (saved as Checkpoint).snapshot;
    const replayed = replayWorld(newWorld(), log, snapshot.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(snapshot));
  });

  it('never saves state without the log entries that explain it', async () => {
    const first = await launchApp();
    first.runner.execute({ type: 'setSpeed', speed: 100 });
    first.runner.execute(SEED_FLEET);
    first.runner.execute(LAUNCH);
    // The process dies mid-flight with no final checkpoint.
    run(first, 9500);
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.database.close();

    const second = await launchApp();
    const saved = await new SqliteWorldStore(second.database.db).load();
    const snapshot = (saved as Checkpoint).snapshot;
    const replayed = replayWorld(newWorld(), wholeLog(second), snapshot.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(snapshot));
  });
});

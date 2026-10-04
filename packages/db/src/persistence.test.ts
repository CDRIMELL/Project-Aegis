import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simInstant } from '@aegis/domain';
import { SimulationEngine, SimulationRunner, type Checkpoint } from '@aegis/sim';
import { ManualHostClock } from '@aegis/sim/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNodeDatabase, type NodeDatabase } from './node';
import type { SqlStatement } from './transport';
import { SqliteWorldStore, WorldStorageError } from './world-store';

const EPOCH = simInstant(Date.UTC(2026, 9, 4, 12, 0, 0));
const newWorld = () => ({ seed: 'persisted-world', epoch: EPOCH });

function checkpointAt(tick: number, seq: number, speed: 1 | 50 = 1): Checkpoint {
  const engine = SimulationEngine.create(newWorld());
  engine.setSpeed(speed);
  engine.runSteps(tick);
  return { seq, wallTimeMs: 1_800_000_000_000 + seq, snapshot: engine.snapshot() };
}

function run(runner: SimulationRunner, host: ManualHostClock, totalMs: number): void {
  for (let elapsed = 0; elapsed < totalMs; elapsed += 100) {
    host.elapse(100);
    runner.advance();
  }
}

describe('SqliteWorldStore', () => {
  let database: NodeDatabase;
  let store: SqliteWorldStore;

  beforeEach(() => {
    database = openNodeDatabase(':memory:');
    store = new SqliteWorldStore(database.db);
  });
  afterEach(() => {
    database.close();
  });

  it('returns null for a database that has never held a world', async () => {
    expect(await store.load()).toBeNull();
  });

  it('round-trips a checkpoint exactly', async () => {
    const checkpoint = checkpointAt(12_345, 7, 50);
    await store.save(checkpoint);
    expect(await store.load()).toEqual(checkpoint);
  });

  it('replaces the previous checkpoint instead of accumulating rows', async () => {
    await store.save(checkpointAt(10, 1));
    await store.save(checkpointAt(500, 2));
    expect(await store.load()).toEqual(checkpointAt(500, 2));

    const counts = database.transport.connection
      .prepare(
        `SELECT (SELECT count(*) FROM sim_world) AS worlds,
                (SELECT count(*) FROM sim_clock) AS clocks,
                (SELECT count(*) FROM sim_checkpoint) AS checkpoints`,
      )
      .get();
    expect(counts).toMatchObject({ worlds: 1, clocks: 1, checkpoints: 1 });
  });

  it('removes RNG streams that are no longer part of the world', async () => {
    const withExtra = checkpointAt(10, 1);
    await store.save({
      ...withExtra,
      snapshot: {
        ...withExtra.snapshot,
        rngStreams: { ...withExtra.snapshot.rngStreams, 'test.extra': [1, 2, 3, 4] },
      },
    });
    await store.save(checkpointAt(20, 2));
    expect(Object.keys((await store.load())?.snapshot.rngStreams ?? {})).toEqual([
      'core.integrity',
    ]);
  });

  it('writes a checkpoint atomically: a failure part-way leaves the previous one intact', async () => {
    const original = checkpointAt(100, 1);
    await store.save(original);

    // Fail on the last statement of the batch, after the clock and checkpoint rows were written.
    const transport = database.transport;
    const realBatch = transport.batch.bind(transport);
    transport.batch = (statements: readonly SqlStatement[]) =>
      realBatch([
        ...statements,
        {
          sql: 'INSERT INTO sim_rng_stream (name, state) VALUES (?, ?)',
          params: ['bad', 'short'],
          method: 'run',
        },
      ]);

    await expect(store.save(checkpointAt(900, 2, 50))).rejects.toThrow(/CHECK constraint/i);

    transport.batch = realBatch;
    expect(await store.load()).toEqual(original);
  });

  it('enforces schema constraints in the database itself', () => {
    const connection = database.transport.connection;
    expect(() => {
      connection.exec(
        'INSERT INTO sim_clock (id, sim_time_ms, tick, speed, running) VALUES (1, 0, 0, 3, 1)',
      );
    }).toThrow(/CHECK constraint/i);
    expect(() => {
      connection.exec(
        'INSERT INTO sim_clock (id, sim_time_ms, tick, speed, running) VALUES (2, 0, 0, 1, 1)',
      );
    }).toThrow(/CHECK constraint/i);
  });

  it('refuses to load a world with a missing singleton row', async () => {
    await store.save(checkpointAt(10, 1));
    database.transport.connection.exec('DELETE FROM sim_clock');
    await expect(store.load()).rejects.toThrow(WorldStorageError);
  });

  it('refuses to load corrupt RNG state', async () => {
    await store.save(checkpointAt(10, 1));
    database.transport.connection.exec(
      "UPDATE sim_rng_stream SET state = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'",
    );
    await expect(store.load()).rejects.toThrow(WorldStorageError);
  });

  it('lets the engine reject a world whose clock was tampered with', async () => {
    await store.save(checkpointAt(10, 1));
    database.transport.connection.exec('UPDATE sim_clock SET tick = 11');
    const loaded = await store.load();
    if (!loaded) throw new Error('expected a saved world');
    expect(() => SimulationEngine.restore(loaded.snapshot)).toThrow(/does not match/);
  });
});

describe('world continuity across application restarts', () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-test-'));
    path = join(directory, 'aegis.db');
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** One "application session": open the file, restore or create the world, hand back a runner. */
  async function launch() {
    const database = openNodeDatabase(path);
    const host = new ManualHostClock();
    const runner = await SimulationRunner.open({
      store: new SqliteWorldStore(database.db),
      host,
      newWorld,
    });
    return { database, host, runner };
  }

  it('restores the exact clock, RNG state and digest after a clean close', async () => {
    const first = await launch();
    first.runner.execute({ type: 'setSpeed', speed: 100 });
    run(first.runner, first.host, 12_000);
    first.runner.execute({ type: 'pause' });
    await first.runner.flush();
    const atClose = first.runner.view();
    first.database.close();

    const second = await launch();
    const reopened = second.runner.view();
    expect(reopened.clock).toEqual(atClose.clock);
    expect(reopened.clock).toMatchObject({ tick: 1200, speed: 100, running: false });
    expect(reopened.integrityDigest).toBe(atClose.integrityDigest);
    expect(reopened.seed).toBe(atClose.seed);
    expect(reopened.checkpoint.persistedSeq).toBe(atClose.checkpoint.persistedSeq);
    second.database.close();
  });

  it('produces the same world over three sessions as one uninterrupted run', async () => {
    for (const sessionMs of [3000, 5000, 2000]) {
      const session = await launch();
      session.runner.execute({ type: 'setSpeed', speed: 50 });
      run(session.runner, session.host, sessionMs);
      await session.runner.flush();
      session.database.close();
    }

    const final = await launch();
    const uninterrupted = SimulationEngine.create(newWorld());
    uninterrupted.runSteps(500);

    expect(final.runner.view().clock.tick).toBe(500);
    expect(final.runner.view().integrityDigest).toBe(uninterrupted.snapshot().integrityDigest);
    final.database.close();
  });

  it('recovers a consistent world when the process dies without a final checkpoint', async () => {
    const first = await launch();
    run(first.runner, first.host, 5500);
    // Let queued periodic writes land, then drop the connection with unsaved progress.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.runner.view().clock.tick).toBe(5);
    first.database.close();

    const second = await launch();
    const recovered = second.runner.view();
    const reference = SimulationEngine.create(newWorld());
    reference.runSteps(recovered.clock.tick);

    expect(recovered.clock.tick).toBe(4);
    expect(recovered.integrityDigest).toBe(reference.snapshot().integrityDigest);
    second.database.close();
  });

  it('applies migrations once and is a no-op on later opens', () => {
    const first = openNodeDatabase(path);
    first.close();
    const second = openNodeDatabase(path);
    const applied = second.transport.connection
      .prepare('SELECT tag FROM __aegis_migrations ORDER BY idx')
      .all();
    // Every migration is recorded exactly once, however many times the database is opened.
    const tags = applied.map((row) => row.tag);
    expect(tags[0]).toBe('0000_init');
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags.length).toBeGreaterThanOrEqual(3);
    second.close();
  });
});

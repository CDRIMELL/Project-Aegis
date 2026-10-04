import {
  decodeRngState,
  encodeRngState,
  isSpeedMultiplier,
  simInstant,
  type RngState,
} from '@aegis/domain';
import type { Checkpoint, WorldStore } from '@aegis/sim';
import { notInArray } from 'drizzle-orm';
import { z } from 'zod';
import type { AegisDb } from './client';
import { simCheckpoint, simClock, simRngStream, simWorld } from './schema';

const SINGLETON_ID = 1;

/** Raised when the database holds a world that cannot be trusted as a checkpoint. */
export class WorldStorageError extends Error {
  override readonly name = 'WorldStorageError';
}

const count = z.int().nonnegative();

// Everything read back from disk is validated before the simulation sees it (ADR 0010).
const worldRow = z.object({
  seed: z.string().min(1),
  modelVersion: count,
  epochMs: count,
});
const clockRow = z.object({
  simTimeMs: count,
  tick: count,
  speed: z.number().refine(isSpeedMultiplier, 'unsupported speed multiplier'),
  running: z.boolean(),
});
const checkpointRow = z.object({
  seq: z.int().positive(),
  wallMs: count,
  integrityDigest: count,
});
const rngRow = z.object({
  name: z.string().min(1),
  state: z.string(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown, table: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new WorldStorageError(`Invalid ${table} row: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** {@link WorldStore} over SQLite. Reads and writes a whole checkpoint in one transaction. */
export class SqliteWorldStore implements WorldStore {
  constructor(private readonly db: AegisDb) {}

  async load(): Promise<Checkpoint | null> {
    const [worlds, clocks, checkpoints, streams] = await this.db.batch([
      this.db.select().from(simWorld),
      this.db.select().from(simClock),
      this.db.select().from(simCheckpoint),
      this.db.select().from(simRngStream),
    ]);

    if (worlds.length + clocks.length + checkpoints.length + streams.length === 0) {
      return null;
    }
    if (worlds.length !== 1 || clocks.length !== 1 || checkpoints.length !== 1) {
      throw new WorldStorageError('Saved world is incomplete: a singleton row is missing');
    }

    const world = parse(worldRow, worlds[0], 'sim_world');
    const clock = parse(clockRow, clocks[0], 'sim_clock');
    const checkpoint = parse(checkpointRow, checkpoints[0], 'sim_checkpoint');

    const rngStreams: Record<string, RngState> = {};
    for (const row of streams) {
      const { name, state } = parse(rngRow, row, 'sim_rng_stream');
      try {
        rngStreams[name] = decodeRngState(state);
      } catch (cause) {
        throw new WorldStorageError(`Invalid state for RNG stream "${name}"`, { cause });
      }
    }

    return {
      seq: checkpoint.seq,
      wallTimeMs: checkpoint.wallMs,
      snapshot: {
        modelVersion: world.modelVersion,
        seed: world.seed,
        epoch: simInstant(world.epochMs),
        clock: {
          simTime: simInstant(clock.simTimeMs),
          tick: clock.tick,
          speed: clock.speed,
          running: clock.running,
        },
        rngStreams,
        integrityDigest: checkpoint.integrityDigest,
      },
    };
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    const { snapshot } = checkpoint;
    const world = {
      seed: snapshot.seed,
      modelVersion: snapshot.modelVersion,
      epochMs: snapshot.epoch,
    };
    const clock = {
      simTimeMs: snapshot.clock.simTime,
      tick: snapshot.clock.tick,
      speed: snapshot.clock.speed,
      running: snapshot.clock.running,
    };
    const meta = {
      seq: checkpoint.seq,
      wallMs: checkpoint.wallTimeMs,
      integrityDigest: snapshot.integrityDigest,
    };
    const streams = Object.entries(snapshot.rngStreams).map(([name, state]) => ({
      name,
      state: encodeRngState(state),
    }));
    const streamNames = streams.map((stream) => stream.name);

    await this.db.batch([
      this.db
        .insert(simWorld)
        .values({ id: SINGLETON_ID, ...world, createdWallMs: checkpoint.wallTimeMs })
        .onConflictDoUpdate({ target: simWorld.id, set: world }),
      this.db
        .insert(simClock)
        .values({ id: SINGLETON_ID, ...clock })
        .onConflictDoUpdate({ target: simClock.id, set: clock }),
      this.db
        .insert(simCheckpoint)
        .values({ id: SINGLETON_ID, ...meta })
        .onConflictDoUpdate({ target: simCheckpoint.id, set: meta }),
      streamNames.length > 0
        ? this.db.delete(simRngStream).where(notInArray(simRngStream.name, streamNames))
        : this.db.delete(simRngStream),
      ...streams.map((stream) =>
        this.db
          .insert(simRngStream)
          .values(stream)
          .onConflictDoUpdate({ target: simRngStream.name, set: { state: stream.state } }),
      ),
    ]);
  }
}

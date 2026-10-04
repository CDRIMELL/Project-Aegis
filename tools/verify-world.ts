/**
 * Independently verifies a saved world.
 *
 * Reads the checkpoint from an AEGIS database, replays the same number of steps from the world's
 * seed in a fresh engine, and checks that the replay arrives at the same integrity digest and the
 * same RNG state. If it does, the saved world is exactly what an uninterrupted run would have
 * produced, however many times the application was closed, reopened or re-timed along the way.
 *
 * Usage:  npx tsx tools/verify-world.ts [path-to-aegis.db]
 */
import { join } from 'node:path';
import { createDb, SqliteWorldStore } from '@aegis/db';
import { NodeSqliteTransport } from '@aegis/db/node';
import { formatUtc, hex32 } from '@aegis/domain';
import { SimulationEngine } from '@aegis/sim';

const defaultPath = join(process.env.APPDATA ?? '.', 'dev.aegis.desktop', 'aegis.db');
const path = process.argv[2] ?? defaultPath;

const transport = new NodeSqliteTransport(path);
try {
  const checkpoint = await new SqliteWorldStore(createDb(transport)).load();
  if (!checkpoint) {
    throw new Error(`No world found in ${path}`);
  }
  const { snapshot } = checkpoint;

  // Throws if the saved world is internally inconsistent.
  SimulationEngine.restore(snapshot);

  const replay = SimulationEngine.create({ seed: snapshot.seed, epoch: snapshot.epoch });
  replay.runSteps(snapshot.clock.tick);
  const expected = replay.snapshot();

  const digestMatches = expected.integrityDigest === snapshot.integrityDigest;
  const rngMatches = JSON.stringify(expected.rngStreams) === JSON.stringify(snapshot.rngStreams);

  console.log(
    JSON.stringify(
      {
        database: path,
        seed: snapshot.seed,
        checkpointSeq: checkpoint.seq,
        checkpointWallUtc: new Date(checkpoint.wallTimeMs).toISOString(),
        tick: snapshot.clock.tick,
        simTimeUtc: formatUtc(snapshot.clock.simTime),
        speed: snapshot.clock.speed,
        running: snapshot.clock.running,
        integrityDigest: hex32(snapshot.integrityDigest),
        replayDigest: hex32(expected.integrityDigest),
        digestMatches,
        rngMatches,
        verdict: digestMatches && rngMatches ? 'PASS' : 'FAIL',
      },
      null,
      2,
    ),
  );
  process.exitCode = digestMatches && rngMatches ? 0 : 1;
} finally {
  transport.close();
}

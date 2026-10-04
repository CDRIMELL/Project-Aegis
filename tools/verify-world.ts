/**
 * Independently verifies the continuity of a saved world.
 *
 * Reads the checkpoint from an AEGIS database, replays the same number of steps from the world's
 * seed in a fresh engine, and checks that the replay arrives at the same integrity digest and the
 * same state of the core random stream. If it does, no step was skipped or repeated and the
 * random sequence was restored exactly, however many times the application was closed, reopened
 * or re-timed along the way.
 *
 * What this does not check: the fleet. Aircraft and flights depend on the commands the player
 * issued, which are not recorded, so they cannot be re-derived from the seed. The random streams
 * those commands consume are listed, not compared.
 *
 * Usage:  npx tsx tools/verify-world.ts [path-to-aegis.db]
 */
import { join } from 'node:path';
import { createDb, SqliteWorldStore } from '@aegis/db';
import { NodeSqliteTransport } from '@aegis/db/node';
import { formatUtc, hex32 } from '@aegis/domain';
import { SimulationEngine } from '@aegis/sim';

const CORE_STREAM = 'core.integrity';

const defaultPath = join(process.env.APPDATA ?? '.', 'dev.aegis.desktop', 'aegis.db');
const path = process.argv[2] ?? defaultPath;

const transport = new NodeSqliteTransport(path);
try {
  const checkpoint = await new SqliteWorldStore(createDb(transport)).load();
  if (!checkpoint) {
    throw new Error(`No world found in ${path}`);
  }
  const { snapshot } = checkpoint;

  // Throws if the saved world, including its fleet, is internally inconsistent.
  SimulationEngine.restore(snapshot);

  const replay = SimulationEngine.create({ seed: snapshot.seed, epoch: snapshot.epoch });
  replay.runSteps(snapshot.clock.tick);
  const expected = replay.snapshot();

  const digestMatches = expected.integrityDigest === snapshot.integrityDigest;
  const coreStreamMatches =
    JSON.stringify(expected.rngStreams[CORE_STREAM]) ===
    JSON.stringify(snapshot.rngStreams[CORE_STREAM]);
  const pass = digestMatches && coreStreamMatches;

  console.log(
    JSON.stringify(
      {
        database: path,
        seed: snapshot.seed,
        modelVersion: snapshot.modelVersion,
        checkpointSeq: checkpoint.seq,
        checkpointWallUtc: new Date(checkpoint.wallTimeMs).toISOString(),
        tick: snapshot.clock.tick,
        simTimeUtc: formatUtc(snapshot.clock.simTime),
        speed: snapshot.clock.speed,
        running: snapshot.clock.running,
        integrityDigest: hex32(snapshot.integrityDigest),
        replayDigest: hex32(expected.integrityDigest),
        digestMatches,
        coreStreamMatches,
        commandDrivenStreams: Object.keys(snapshot.rngStreams).filter(
          (name) => name !== CORE_STREAM,
        ),
        aircraft: snapshot.fleet.aircraft.length,
        activeFlights: snapshot.fleet.flights.filter((flight) => flight.status === 'active').length,
        fleetInternallyConsistent: true,
        verdict: pass ? 'PASS' : 'FAIL',
      },
      null,
      2,
    ),
  );
  process.exitCode = pass ? 0 : 1;
} finally {
  transport.close();
}

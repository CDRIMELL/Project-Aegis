/**
 * Independently verifies a saved world.
 *
 * Two checks:
 *
 * 1. Continuity. Replays the same number of steps from the world's seed in a fresh engine and
 *    checks that it arrives at the same integrity digest and the same state of the core random
 *    stream. If it does, no step was skipped or repeated and the random sequence was restored
 *    exactly, however many times the application was closed, reopened or re-timed along the way.
 *
 * 2. Replay (ADR 0018). Re-derives the whole world, fleet and flights included, from the seed and
 *    the logged commands, and compares it with what is saved. This is possible only when the log
 *    is complete from tick 0. A world created before the log existed is reported as not
 *    replayable, which is not a failure. Nor is a world saved by an earlier simulation model and
 *    not yet opened by this build: its log records what the earlier rules did, and this build's
 *    rules would not re-derive it. The engine marks such a log complete only from the upgrade.
 *
 * Usage:  npx tsx tools/verify-world.ts [path-to-aegis.db]
 */
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createDb, SqliteWorldStore } from '@aegis/db';
import { NodeSqliteTransport } from '@aegis/db/node';
import { formatUtc, hex32 } from '@aegis/domain';
import { replayComparable, replayWorld, SimulationEngine, type LogEntry } from '@aegis/sim';

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

  // Throws if the saved world, including its fleet and log, is internally inconsistent. A world
  // saved by an earlier model is carried over here exactly as the application carries it over.
  const restored = SimulationEngine.restore(snapshot).snapshot();
  const replayableFromTick = restored.log.completeFromTick;

  const world = { seed: snapshot.seed, epoch: snapshot.epoch };
  const continuity = SimulationEngine.create(world);
  continuity.runSteps(snapshot.clock.tick);
  const expected = continuity.snapshot();

  const digestMatches = expected.integrityDigest === snapshot.integrityDigest;
  const coreStreamMatches = isDeepStrictEqual(
    expected.rngStreams[CORE_STREAM],
    snapshot.rngStreams[CORE_STREAM],
  );

  const log: LogEntry[] = transport.connection
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
  const logGapless = log.every((entry, index) => entry.seq === index + 1);

  let replay:
    | 'match'
    | 'mismatch'
    | 'not replayable: log starts after tick 0'
    | 'not replayable: saved by an earlier simulation model';
  if (snapshot.log.completeFromTick > 0) {
    replay = 'not replayable: log starts after tick 0';
  } else if (replayableFromTick > 0) {
    replay = 'not replayable: saved by an earlier simulation model';
  } else {
    // JSON round trip: the saved snapshot came through JSON columns, so compare like with like.
    const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
    const replayed = replayWorld(world, log, snapshot.clock.tick).snapshot();
    replay = isDeepStrictEqual(plain(replayComparable(replayed)), plain(replayComparable(snapshot)))
      ? 'match'
      : 'mismatch';
  }

  const pass = digestMatches && coreStreamMatches && logGapless && replay !== 'mismatch';

  console.log(
    JSON.stringify(
      {
        database: path,
        seed: snapshot.seed,
        modelVersion: snapshot.modelVersion,
        buildModelVersion: restored.modelVersion,
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
        aircraft: snapshot.fleet.aircraft.length,
        activeFlights: snapshot.fleet.flights.filter((flight) => flight.status === 'active').length,
        logEntries: log.length,
        logGapless,
        logCompleteFromTick: snapshot.log.completeFromTick,
        replay,
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

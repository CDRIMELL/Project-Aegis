import { SimulationEngine, type WorldCommand } from './engine';
import type { LogEntry } from './log';
import type { NewWorldOptions, WorldSnapshot } from './world';

/*
 * Re-derives a world from its seed and its logged commands (ADR 0018).
 *
 * This is verification, not a feature: it proves that a saved world is exactly what its seed and
 * its recorded commands produce. Events in the log are not applied; the replay must regenerate
 * them, and comparing them is part of the check.
 */

/**
 * Builds a fresh world, applies each logged command at the tick it was issued, and runs to
 * `finalTick`. `entries` must be the complete log from sequence 1, in order.
 */
export function replayWorld(
  world: NewWorldOptions,
  entries: readonly LogEntry[],
  finalTick: number,
): SimulationEngine {
  const engine = SimulationEngine.create(world);
  for (const entry of entries) {
    if (entry.kind !== 'command') continue;
    if (entry.tick < engine.clock.tick || entry.tick > finalTick) {
      throw new Error(`Log entry ${entry.seq} is out of order or beyond the final tick`);
    }
    engine.runSteps(entry.tick - engine.clock.tick);
    // A logged payload is the command exactly as it was applied.
    if (!engine.applyCommand(entry.payload as unknown as WorldCommand)) {
      throw new Error(`Logged command ${entry.seq} (${entry.type}) had no effect on replay`);
    }
  }
  engine.runSteps(finalTick - engine.clock.tick);
  return engine;
}

/**
 * The parts of a snapshot that seed and commands determine. Speed and run state are pacing, not
 * outcome (ADR 0018), and the in-memory log tail depends on what has been saved, so the log is
 * compared by its length.
 */
export function replayComparable(snapshot: WorldSnapshot): unknown {
  const { clock, log, ...rest } = snapshot;
  return { ...rest, tick: clock.tick, simTime: clock.simTime, logLength: log.nextSeq - 1 };
}

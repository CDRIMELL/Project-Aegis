import {
  DIGEST_SEED,
  RngStreams,
  addMs,
  foldUint32,
  isSpeedMultiplier,
  type SimInstant,
  type SpeedMultiplier,
} from '@aegis/domain';
import { EMPTY_FLEET, Fleet, type FleetCommand, type FleetView } from './fleet';
import { EMPTY_LOG, SimLog, type EmitEvent, type LogSnapshot } from './log';
import {
  OLDEST_LOADABLE_MODEL_VERSION,
  SIM_MODEL_VERSION,
  SIM_STEP_MS,
  type ClockState,
  type NewWorldOptions,
  type WorldSnapshot,
} from './world';

/** Commands the application issues itself, not the player (ADR 0018). */
const SYSTEM_COMMANDS: ReadonlySet<string> = new Set(['seedStarterFleet']);

/** The first simulation model that kept a log. */
const FIRST_LOGGED_MODEL_VERSION = 3;

/** RNG stream consumed by the integrity probe. Persisted name: do not rename (ADR 0006). */
const INTEGRITY_STREAM = 'core.integrity';

export class WorldRestoreError extends Error {
  override readonly name = 'WorldRestoreError';
}

/**
 * The simulation itself: world state plus the rules that advance it one fixed step at a time.
 *
 * It never reads a clock, a timer or a global random source. Time moves only through
 * {@link runSteps}, so the same seed and the same calls always produce the same world.
 */
export class SimulationEngine {
  private tick: number;
  private speed: SpeedMultiplier;
  private running: boolean;
  private integrityDigest: number;

  private constructor(
    private readonly seed: string,
    private readonly epoch: SimInstant,
    private readonly rng: RngStreams,
    clock: Pick<ClockState, 'tick' | 'speed' | 'running'>,
    integrityDigest: number,
    private readonly fleet: Fleet,
    private readonly log: SimLog,
  ) {
    this.tick = clock.tick;
    this.speed = clock.speed;
    this.running = clock.running;
    this.integrityDigest = integrityDigest;
  }

  static create(options: NewWorldOptions): SimulationEngine {
    if (options.seed.length === 0) {
      throw new RangeError('World seed must not be empty');
    }
    return new SimulationEngine(
      options.seed,
      options.epoch,
      new RngStreams(options.seed),
      { tick: 0, speed: 1, running: true },
      DIGEST_SEED,
      new Fleet(),
      new SimLog(),
    );
  }

  /** Rebuilds an engine from a snapshot, refusing anything internally inconsistent. */
  static restore(snapshot: WorldSnapshot): SimulationEngine {
    const { clock } = snapshot;
    if (
      snapshot.modelVersion > SIM_MODEL_VERSION ||
      snapshot.modelVersion < OLDEST_LOADABLE_MODEL_VERSION
    ) {
      throw new WorldRestoreError(
        `World was saved by simulation model ${snapshot.modelVersion}; this build runs model ${SIM_MODEL_VERSION}`,
      );
    }
    if (snapshot.seed.length === 0) {
      throw new WorldRestoreError('Saved world has an empty seed');
    }
    if (!Number.isSafeInteger(clock.tick) || clock.tick < 0) {
      throw new WorldRestoreError(`Saved tick is invalid: ${clock.tick}`);
    }
    if (!isSpeedMultiplier(clock.speed)) {
      throw new WorldRestoreError(
        `Saved speed is not a supported multiplier: ${String(clock.speed)}`,
      );
    }
    if (clock.simTime !== snapshot.epoch + clock.tick * SIM_STEP_MS) {
      throw new WorldRestoreError('Saved simulation time does not match epoch and tick');
    }
    if (!Number.isInteger(snapshot.integrityDigest) || snapshot.integrityDigest < 0) {
      throw new WorldRestoreError('Saved integrity digest is invalid');
    }
    let rng: RngStreams;
    try {
      rng = new RngStreams(snapshot.seed, snapshot.rngStreams);
    } catch (cause) {
      throw new WorldRestoreError('Saved RNG state is invalid', { cause });
    }
    let fleet: Fleet;
    try {
      // A model-1 world has no fleet; it is upgraded to an empty one.
      fleet = new Fleet((snapshot as Partial<WorldSnapshot>).fleet ?? EMPTY_FLEET);
    } catch (cause) {
      throw new WorldRestoreError('Saved fleet state is invalid', { cause });
    }
    let log: SimLog;
    try {
      log = new SimLog(restoredLog(snapshot));
    } catch (cause) {
      throw new WorldRestoreError('Saved log is invalid', { cause });
    }
    return new SimulationEngine(
      snapshot.seed,
      snapshot.epoch,
      rng,
      clock,
      snapshot.integrityDigest,
      fleet,
      log,
    );
  }

  get clock(): ClockState {
    return {
      simTime: addMs(this.epoch, this.tick * SIM_STEP_MS),
      tick: this.tick,
      speed: this.speed,
      running: this.running,
    };
  }

  /** Advances the world by exactly `count` steps, regardless of run state or speed. */
  runSteps(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError(`Step count must be a non-negative integer, got ${count}`);
    }
    for (let i = 0; i < count; i++) {
      this.step();
    }
  }

  setSpeed(speed: SpeedMultiplier): void {
    if (!isSpeedMultiplier(speed)) {
      throw new RangeError(`Unsupported speed multiplier: ${String(speed)}`);
    }
    this.speed = speed;
  }

  setRunning(running: boolean): void {
    this.running = running;
  }

  snapshot(): WorldSnapshot {
    return {
      modelVersion: SIM_MODEL_VERSION,
      seed: this.seed,
      epoch: this.epoch,
      clock: this.clock,
      rngStreams: this.rng.states(),
      integrityDigest: this.integrityDigest,
      fleet: this.fleet.snapshot(),
      log: this.log.snapshot(),
    };
  }

  /** Tells the engine that every log entry up to `seq` is on disk. */
  acknowledgeLogSaved(seq: number): void {
    this.log.acknowledgeSaved(seq);
  }

  /**
   * Applies a command at the current step boundary and records it in the log. Returns false if it
   * changed nothing; throws `CommandRejected` if it cannot be carried out, leaving the world
   * untouched and the log without an entry.
   */
  applyCommand(command: FleetCommand): boolean {
    const effect = this.fleet.apply(command, this.tick);
    if (effect === null) return false;
    this.log.append(
      this.tick,
      'command',
      command.type,
      SYSTEM_COMMANDS.has(command.type) ? 'system' : 'player',
      effect,
      { ...command },
    );
    return true;
  }

  fleetView(): FleetView {
    return this.fleet.view();
  }

  /**
   * One fixed step. Subsystems are called here in a fixed, documented order as they are added
   * (flight, environment, events, ...).
   */
  private step(): void {
    this.tick += 1;
    const emit: EmitEvent = (type, subject, payload) => {
      this.log.append(this.tick, 'event', type, 'world', subject, payload);
    };
    this.fleet.step(this.tick, (stream) => this.rng.stream(stream), emit);
    this.updateIntegrityDigest();
  }

  /**
   * Folds the tick number and one random draw into a rolling digest.
   *
   * Two worlds with the same digest have executed the same number of steps with the same random
   * sequence. A skipped or repeated step, or an RNG state that was not restored exactly, changes it.
   * This is what lets tests and the diagnostics screen prove continuity across a restart.
   */
  private updateIntegrityDigest(): void {
    const draw = this.rng.stream(INTEGRITY_STREAM).nextUint32();
    this.integrityDigest = foldUint32(foldUint32(this.integrityDigest, this.tick >>> 0), draw);
  }
}

/**
 * The log of a saved world. A world saved before the log existed (model 2 or earlier) gets an
 * empty one that is complete only from the moment of the upgrade.
 */
function restoredLog(snapshot: WorldSnapshot): LogSnapshot {
  const saved = (snapshot as Partial<WorldSnapshot>).log;
  if (saved && snapshot.modelVersion >= FIRST_LOGGED_MODEL_VERSION) return saved;
  return { ...EMPTY_LOG, completeFromTick: snapshot.clock.tick };
}

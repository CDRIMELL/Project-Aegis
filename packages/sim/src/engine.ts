import {
  DIGEST_SEED,
  RngStreams,
  addMs,
  foldUint32,
  isSpeedMultiplier,
  type SimInstant,
  type SpeedMultiplier,
} from '@aegis/domain';
import {
  SIM_MODEL_VERSION,
  SIM_STEP_MS,
  type ClockState,
  type NewWorldOptions,
  type WorldSnapshot,
} from './world';

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
    );
  }

  /** Rebuilds an engine from a snapshot, refusing anything internally inconsistent. */
  static restore(snapshot: WorldSnapshot): SimulationEngine {
    const { clock } = snapshot;
    if (snapshot.modelVersion !== SIM_MODEL_VERSION) {
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
    return new SimulationEngine(
      snapshot.seed,
      snapshot.epoch,
      rng,
      clock,
      snapshot.integrityDigest,
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
    };
  }

  /**
   * One fixed step. Subsystems are called here in a fixed, documented order as they are added
   * (flight, environment, events, ...).
   */
  private step(): void {
    this.tick += 1;
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

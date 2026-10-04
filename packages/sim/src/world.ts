import type { RngState, SimInstant, SpeedMultiplier } from '@aegis/domain';

/**
 * Version of the simulation rules. A saved world records the version that produced it;
 * bump this whenever a change would make an existing world behave differently.
 */
export const SIM_MODEL_VERSION = 1;

/** Length of one simulation step in simulated milliseconds (ADR 0005). */
export const SIM_STEP_MS = 1000;

export interface ClockState {
  /** Always `epoch + tick * SIM_STEP_MS`. */
  readonly simTime: SimInstant;
  /** Number of steps executed since the world was created. */
  readonly tick: number;
  readonly speed: SpeedMultiplier;
  readonly running: boolean;
}

/** Complete, serialisable state of a world at a step boundary. */
export interface WorldSnapshot {
  readonly modelVersion: number;
  readonly seed: string;
  /** Simulation instant at tick 0. */
  readonly epoch: SimInstant;
  readonly clock: ClockState;
  readonly rngStreams: Readonly<Record<string, RngState>>;
  /** Rolling digest over every step taken; see `SimulationEngine`. */
  readonly integrityDigest: number;
}

export interface NewWorldOptions {
  readonly seed: string;
  readonly epoch: SimInstant;
}

/** A snapshot plus the bookkeeping that identifies when it was persisted (ADR 0004). */
export interface Checkpoint {
  /** Strictly increasing over the life of a world; a later checkpoint always has a higher number. */
  readonly seq: number;
  /** Wall-clock time the snapshot was taken, in Unix milliseconds. */
  readonly wallTimeMs: number;
  readonly snapshot: WorldSnapshot;
}

/**
 * Persistence port. The simulation declares it; a storage package implements it.
 * `save` must be atomic: after it resolves or rejects, storage holds exactly one whole checkpoint.
 */
export interface WorldStore {
  load(): Promise<Checkpoint | null>;
  save(checkpoint: Checkpoint): Promise<void>;
}

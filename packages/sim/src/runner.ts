import {
  hazardsFrom,
  isSpeedMultiplier,
  type PlanContext,
  type SimInstant,
  type SpeedMultiplier,
  type WeatherModel,
} from '@aegis/domain';
import type { CareerView } from './career';
import type { EventsView } from './events';
import { SimulationEngine, type WorldCommand } from './engine';
import type { FleetView } from './fleet';
import type { MissionsView } from './missions';
import {
  SIM_STEP_MS,
  type Checkpoint,
  type ClockState,
  type NewWorldOptions,
  type WorldStore,
} from './world';

/** Time sources supplied by whatever hosts the simulation (a worker, a test, a CLI). */
export interface HostClock {
  /** Monotonic milliseconds; only differences are used. */
  monotonicMs(): number;
  /** Wall-clock Unix milliseconds; recorded on checkpoints, never used to move the world. */
  wallMs(): number;
}

export type SimCommand =
  | { readonly type: 'resume' }
  | { readonly type: 'pause' }
  | { readonly type: 'setSpeed'; readonly speed: SpeedMultiplier }
  | WorldCommand;

/** What a user interface needs to present the simulation. Plain data, safe to post across threads. */
export interface SimView {
  readonly seed: string;
  readonly modelVersion: number;
  readonly epoch: SimInstant;
  readonly clock: ClockState;
  readonly integrityDigest: number;
  readonly fleet: FleetView;
  readonly missions: MissionsView;
  readonly events: EventsView;
  /** The career played in this world, if it is one (ADR 0031). */
  readonly career: CareerView;
  /** Identifies the world's weather, so the interface computes the same weather the engine does. */
  readonly weather: WeatherModel;
  /** Number of entries in the command and event log. The entries are read from the database. */
  readonly logLength: number;
  readonly checkpoint: {
    /** Sequence number of the last checkpoint known to be on disk; 0 if none yet. */
    readonly persistedSeq: number;
    readonly persistedWallMs: number | null;
    readonly persistedTick: number | null;
    /** Message of the most recent failed write, cleared by the next successful one. */
    readonly lastError: string | null;
  };
}

/**
 * The world a plan would be flown in if it departed now, as the interface sees it. It is the same
 * context the engine checks a launch against, built from the same published state.
 */
export function planContextOf(view: SimView): PlanContext {
  return {
    weather: view.weather,
    departureTick: view.clock.tick,
    hazards: hazardsFrom(view.events.events),
  };
}

export interface RunnerTuning {
  /** Real milliseconds between periodic checkpoints while the world is changing. */
  readonly checkpointIntervalMs?: number;
  /** Largest real interval a single `advance` will honour (ADR 0005). */
  readonly maxAdvanceMs?: number;
}

export interface OpenOptions extends RunnerTuning {
  readonly store: WorldStore;
  readonly host: HostClock;
  /** Called only when the store holds no world. */
  readonly newWorld: () => NewWorldOptions;
  readonly onView?: (view: SimView) => void;
}

const DEFAULT_CHECKPOINT_INTERVAL_MS = 2000;
const DEFAULT_MAX_ADVANCE_MS = 1000;

/**
 * Drives a {@link SimulationEngine} from real elapsed time and keeps it persisted.
 *
 * The host calls {@link advance} on any cadence it likes. The runner turns elapsed real time into
 * whole simulation steps and decides when to checkpoint (ADR 0004).
 */
export class SimulationRunner {
  private readonly checkpointIntervalMs: number;
  private readonly maxAdvanceMs: number;

  private lastMonotonicMs: number;
  /** Simulated milliseconds earned from real time but not yet spent on a whole step. */
  private owedSimMs = 0;

  private dirty = false;
  private nextSeq: number;
  private lastCheckpointMonotonicMs: number;
  private persisted: { seq: number; wallMs: number; tick: number } | null;
  private lastError: string | null = null;

  private waiting: Checkpoint | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(
    private readonly engine: SimulationEngine,
    private readonly store: WorldStore,
    private readonly host: HostClock,
    private readonly onView: ((view: SimView) => void) | undefined,
    loaded: Checkpoint | null,
    tuning: RunnerTuning,
  ) {
    this.checkpointIntervalMs = tuning.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
    this.maxAdvanceMs = tuning.maxAdvanceMs ?? DEFAULT_MAX_ADVANCE_MS;
    this.lastMonotonicMs = host.monotonicMs();
    this.lastCheckpointMonotonicMs = this.lastMonotonicMs;
    this.nextSeq = (loaded?.seq ?? 0) + 1;
    this.persisted = loaded
      ? { seq: loaded.seq, wallMs: loaded.wallTimeMs, tick: loaded.snapshot.clock.tick }
      : null;
  }

  /**
   * Restores the saved world, or creates and immediately persists a new one.
   * Rejects if the saved world cannot be restored or the first write fails.
   */
  static async open(options: OpenOptions): Promise<SimulationRunner> {
    const loaded = await options.store.load();
    const engine = loaded
      ? SimulationEngine.restore(loaded.snapshot)
      : SimulationEngine.create(options.newWorld());
    const runner = new SimulationRunner(
      engine,
      options.store,
      options.host,
      options.onView,
      loaded,
      options,
    );
    if (!loaded) {
      await runner.checkpoint();
      if (runner.lastError !== null) {
        throw new Error(`Could not persist the new world: ${runner.lastError}`);
      }
    }
    return runner;
  }

  /**
   * Restores the saved world, or resolves to `null` when there is none. Nothing is created
   * (ADR 0031): a world begins only when it is asked for.
   */
  static async load(options: Omit<OpenOptions, 'newWorld'>): Promise<SimulationRunner | null> {
    const loaded = await options.store.load();
    if (!loaded) return null;
    return new SimulationRunner(
      SimulationEngine.restore(loaded.snapshot),
      options.store,
      options.host,
      options.onView,
      loaded,
      options,
    );
  }

  /**
   * Creates a new world in place of whatever the store holds, and persists it. The saved world
   * is removed first; the caller is responsible for having kept a copy if one is wanted.
   */
  static async create(options: OpenOptions): Promise<SimulationRunner> {
    await options.store.clear();
    return SimulationRunner.open(options);
  }

  /**
   * Forgets real time that passed while the world was not being advanced, so that it is not
   * paid back as simulation steps when advancing begins again.
   */
  resync(): void {
    this.lastMonotonicMs = this.host.monotonicMs();
    this.owedSimMs = 0;
  }

  /**
   * Runs the world forward by exactly `steps`, whatever its run state or speed. These are
   * ordinary steps: a new career is given its first hours this way (ADR 0031).
   */
  fastForward(steps: number): void {
    if (steps <= 0) return;
    this.engine.runSteps(steps);
    this.dirty = true;
    this.publish();
  }

  /** Converts real time elapsed since the previous call into simulation steps. */
  advance(): void {
    const now = this.host.monotonicMs();
    const elapsed = Math.min(Math.max(now - this.lastMonotonicMs, 0), this.maxAdvanceMs);
    this.lastMonotonicMs = now;

    const clock = this.engine.clock;
    let stepped = false;
    if (clock.running) {
      this.owedSimMs += elapsed * clock.speed;
      const steps = Math.floor(this.owedSimMs / SIM_STEP_MS);
      if (steps > 0) {
        this.owedSimMs -= steps * SIM_STEP_MS;
        this.engine.runSteps(steps);
        this.dirty = true;
        stepped = true;
      }
    }

    if (this.dirty && now - this.lastCheckpointMonotonicMs >= this.checkpointIntervalMs) {
      void this.checkpoint();
    }
    if (stepped) {
      this.publish();
    }
  }

  /** Applies a user command. Every effective command is a critical transition and checkpoints. */
  execute(command: SimCommand): void {
    const clock = this.engine.clock;
    switch (command.type) {
      case 'resume':
        if (clock.running) return;
        this.engine.setRunning(true);
        // Time spent paused must not be paid back as simulation steps.
        this.lastMonotonicMs = this.host.monotonicMs();
        break;
      case 'pause':
        if (!clock.running) return;
        this.engine.setRunning(false);
        this.owedSimMs = 0;
        break;
      case 'setSpeed':
        if (!isSpeedMultiplier(command.speed)) {
          throw new RangeError(`Unsupported speed multiplier: ${String(command.speed)}`);
        }
        if (clock.speed === command.speed) return;
        this.engine.setSpeed(command.speed);
        break;
      default:
        // World commands. A rejected command throws and leaves nothing to save.
        if (!this.engine.applyCommand(command)) return;
        break;
    }
    this.dirty = true;
    void this.checkpoint();
    this.publish();
  }

  /** Persists any unsaved change and resolves once every queued write has settled. */
  async flush(): Promise<void> {
    if (this.dirty) {
      void this.checkpoint();
    }
    await this.writeChain;
  }

  view(): SimView {
    const snapshot = this.engine.snapshot();
    return {
      seed: snapshot.seed,
      modelVersion: snapshot.modelVersion,
      epoch: snapshot.epoch,
      clock: snapshot.clock,
      integrityDigest: snapshot.integrityDigest,
      fleet: this.engine.fleetView(),
      missions: this.engine.missionsView(),
      events: this.engine.eventsView(),
      career: this.engine.careerView(),
      weather: this.engine.weather,
      logLength: snapshot.log.nextSeq - 1,
      checkpoint: {
        persistedSeq: this.persisted?.seq ?? 0,
        persistedWallMs: this.persisted?.wallMs ?? null,
        persistedTick: this.persisted?.tick ?? null,
        lastError: this.lastError,
      },
    };
  }

  /**
   * Captures the world now and queues it for writing. Writes never overlap: if one is in flight,
   * the newest capture waits and replaces any older capture still waiting.
   */
  private checkpoint(): Promise<void> {
    this.waiting = {
      seq: this.nextSeq++,
      wallTimeMs: this.host.wallMs(),
      snapshot: this.engine.snapshot(),
    };
    this.dirty = false;
    this.lastCheckpointMonotonicMs = this.host.monotonicMs();

    this.writeChain = this.writeChain.then(() => this.writeWaiting());
    return this.writeChain;
  }

  private async writeWaiting(): Promise<void> {
    const checkpoint = this.waiting;
    if (!checkpoint) return;
    this.waiting = null;
    try {
      await this.store.save(checkpoint);
      this.engine.acknowledgeLogSaved(checkpoint.snapshot.log.nextSeq - 1);
      this.persisted = {
        seq: checkpoint.seq,
        wallMs: checkpoint.wallTimeMs,
        tick: checkpoint.snapshot.clock.tick,
      };
      this.lastError = null;
    } catch (error) {
      // Keep the world running and try again at the next interval; the UI shows the failure.
      this.dirty = true;
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    this.publish();
  }

  private publish(): void {
    this.onView?.(this.view());
  }
}

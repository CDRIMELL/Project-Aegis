import type { HostClock } from './runner';
import type { Checkpoint, WorldStore } from './world';

/** Host clock moved by hand, for tests of anything driven by a {@link HostClock}. */
export class ManualHostClock implements HostClock {
  private monotonic = 0;
  private wall: number;

  constructor(wallStartMs = 1_800_000_000_000) {
    this.wall = wallStartMs;
  }

  elapse(ms: number): void {
    this.monotonic += ms;
    this.wall += ms;
  }

  monotonicMs(): number {
    return this.monotonic;
  }

  wallMs(): number {
    return this.wall;
  }
}

/** Checkpoints are plain data, so a JSON round trip is a faithful deep copy. */
function copyOf(checkpoint: Checkpoint): Checkpoint {
  return JSON.parse(JSON.stringify(checkpoint)) as Checkpoint;
}

/** In-memory {@link WorldStore} that records every save and can be made slow or failing. */
export class MemoryWorldStore implements WorldStore {
  readonly saves: Checkpoint[] = [];
  /** Number of `save` calls currently awaiting completion. */
  inFlight = 0;
  maxInFlight = 0;
  failNext: Error | null = null;
  /** When set, each save waits for this gate before completing. */
  gate: Promise<void> | null = null;

  constructor(private current: Checkpoint | null = null) {}

  load(): Promise<Checkpoint | null> {
    return Promise.resolve(this.current ? copyOf(this.current) : null);
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.gate) {
        await this.gate;
      }
      if (this.failNext) {
        const error = this.failNext;
        this.failNext = null;
        throw error;
      }
      const copy = copyOf(checkpoint);
      this.current = copy;
      this.saves.push(copy);
    } finally {
      this.inFlight -= 1;
    }
  }

  get latest(): Checkpoint | null {
    return this.current;
  }
}

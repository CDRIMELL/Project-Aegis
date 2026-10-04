import { SPEED_MULTIPLIERS, simInstant } from '@aegis/domain';
import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine';
import { SimulationRunner, type SimView } from './runner';
import { ManualHostClock, MemoryWorldStore } from './testing';

const EPOCH = simInstant(Date.UTC(2026, 9, 4, 12, 0, 0));
const newWorld = () => ({ seed: 'runner-world', epoch: EPOCH });

async function open(
  store = new MemoryWorldStore(),
  host = new ManualHostClock(),
  views: SimView[] = [],
) {
  const runner = await SimulationRunner.open({
    store,
    host,
    newWorld,
    onView: (view) => views.push(view),
  });
  return { runner, store, host, views };
}

/** Lets real time pass in host-sized slices, advancing the runner after each. */
function run(
  runner: SimulationRunner,
  host: ManualHostClock,
  totalMs: number,
  sliceMs = 100,
): void {
  for (let elapsed = 0; elapsed < totalMs; elapsed += sliceMs) {
    host.elapse(sliceMs);
    runner.advance();
  }
}

/** Lets already-queued checkpoint writes finish without requesting a new one. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

describe('SimulationRunner', () => {
  it('creates and immediately persists a new world when the store is empty', async () => {
    const { runner, store } = await open();
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]?.seq).toBe(1);
    expect(runner.view().checkpoint.persistedSeq).toBe(1);
    expect(runner.view().clock.tick).toBe(0);
  });

  it.each(SPEED_MULTIPLIERS)(
    'runs %ix: that many simulated seconds per real second',
    async (speed) => {
      const { runner, host } = await open();
      runner.execute({ type: 'setSpeed', speed });
      const before = runner.view().clock;
      run(runner, host, 10_000);
      const after = runner.view().clock;
      expect(after.tick - before.tick).toBe(10 * speed);
      expect(after.simTime - before.simTime).toBe(10_000 * speed);
    },
  );

  it('reaches the same world at any speed and any host cadence', async () => {
    const digests = new Set<number>();
    for (const [speed, sliceMs] of [
      [1, 250],
      [10, 16],
      [100, 100],
      [100, 500],
    ] as const) {
      const { runner, host } = await open();
      runner.execute({ type: 'setSpeed', speed });
      while (runner.view().clock.tick < 1000) {
        host.elapse(sliceMs);
        runner.advance();
      }
      // Faster runs overshoot by at most one slice; compare at a common tick instead.
      const reference = SimulationEngine.create(newWorld());
      reference.runSteps(runner.view().clock.tick);
      expect(runner.view().integrityDigest).toBe(reference.snapshot().integrityDigest);
      if (runner.view().clock.tick === 1000) {
        digests.add(runner.view().integrityDigest);
      }
    }
    expect(digests.size).toBe(1);
  });

  it('stops the world while paused and resumes without paying back paused time', async () => {
    const { runner, host } = await open();
    run(runner, host, 5000);
    expect(runner.view().clock.tick).toBe(5);

    runner.execute({ type: 'pause' });
    run(runner, host, 60_000);
    expect(runner.view().clock).toMatchObject({ tick: 5, running: false });

    runner.execute({ type: 'resume' });
    run(runner, host, 3000);
    expect(runner.view().clock).toMatchObject({ tick: 8, running: true });
  });

  it('discards a partial step when pausing', async () => {
    const { runner, host } = await open();
    run(runner, host, 900);
    runner.execute({ type: 'pause' });
    runner.execute({ type: 'resume' });
    run(runner, host, 900);
    expect(runner.view().clock.tick).toBe(0);
    run(runner, host, 100);
    expect(runner.view().clock.tick).toBe(1);
  });

  it('caps the catch-up after a stalled host', async () => {
    const { runner, host } = await open();
    runner.execute({ type: 'setSpeed', speed: 100 });
    host.elapse(60_000);
    runner.advance();
    expect(runner.view().clock.tick).toBe(100);
  });

  it('rejects an unsupported speed without changing anything', async () => {
    const { runner, store } = await open();
    expect(() => {
      runner.execute({ type: 'setSpeed', speed: 3 as never });
    }).toThrow(RangeError);
    expect(runner.view().clock.speed).toBe(1);
    expect(store.saves).toHaveLength(1);
  });

  describe('checkpointing', () => {
    it('checkpoints on the interval while the world changes, and not while idle', async () => {
      const { runner, store, host } = await open();
      // 2.1 s of real time crosses the 2 s interval exactly once.
      run(runner, host, 2100);
      await runner.flush();
      expect(store.saves).toHaveLength(2);
      expect(store.saves[1]?.snapshot.clock.tick).toBe(2);

      runner.execute({ type: 'pause' });
      await runner.flush();
      const afterPause = store.saves.length;
      run(runner, host, 30_000);
      await runner.flush();
      expect(store.saves).toHaveLength(afterPause);
    });

    it('checkpoints immediately on every effective command and ignores no-ops', async () => {
      const { runner, store } = await open();
      runner.execute({ type: 'setSpeed', speed: 50 });
      await runner.flush();
      expect(store.latest?.snapshot.clock.speed).toBe(50);

      runner.execute({ type: 'pause' });
      await runner.flush();
      expect(store.latest?.snapshot.clock.running).toBe(false);

      const count = store.saves.length;
      runner.execute({ type: 'pause' });
      runner.execute({ type: 'setSpeed', speed: 50 });
      await runner.flush();
      expect(store.saves).toHaveLength(count);
    });

    it('numbers checkpoints in increasing order and stamps wall time', async () => {
      const { runner, store, host } = await open();
      run(runner, host, 2000);
      await runner.flush();
      runner.execute({ type: 'setSpeed', speed: 2 });
      await runner.flush();
      expect(store.saves.map((c) => c.seq)).toEqual([1, 2, 3]);
      expect(store.latest?.wallTimeMs).toBe(host.wallMs());
    });

    it('never overlaps writes and keeps only the newest waiting capture', async () => {
      const { runner, store } = await open();
      let release: () => void = () => undefined;
      store.gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      runner.execute({ type: 'setSpeed', speed: 2 });
      await Promise.resolve();
      runner.execute({ type: 'setSpeed', speed: 5 });
      runner.execute({ type: 'setSpeed', speed: 10 });
      runner.execute({ type: 'setSpeed', speed: 50 });
      expect(store.inFlight).toBe(1);

      release();
      await runner.flush();

      expect(store.maxInFlight).toBe(1);
      expect(store.saves.map((c) => c.snapshot.clock.speed)).toEqual([1, 2, 50]);
      expect(runner.view().checkpoint.persistedSeq).toBe(store.latest?.seq);
    });

    it('surfaces a failed write, keeps running, and retries on the next interval', async () => {
      const { runner, store, host, views } = await open();
      store.failNext = new Error('disk full');
      runner.execute({ type: 'setSpeed', speed: 10 });
      await runner.flush();

      expect(runner.view().checkpoint.lastError).toBe('disk full');
      expect(runner.view().checkpoint.persistedSeq).toBe(1);
      expect(views.at(-1)?.checkpoint.lastError).toBe('disk full');

      run(runner, host, 2000);
      await runner.flush();
      expect(runner.view().checkpoint.lastError).toBeNull();
      expect(store.latest?.snapshot.clock).toMatchObject({ speed: 10, tick: 20 });
    });

    it('fails to open when a new world cannot be persisted', async () => {
      const store = new MemoryWorldStore();
      store.failNext = new Error('read-only volume');
      await expect(open(store)).rejects.toThrow(/read-only volume/);
    });
  });

  describe('restart', () => {
    it('resumes from the last checkpoint and matches an uninterrupted run', async () => {
      const store = new MemoryWorldStore();
      const first = await open(store);
      first.runner.execute({ type: 'setSpeed', speed: 100 });
      run(first.runner, first.host, 7000);
      await first.runner.flush();
      const atClose = first.runner.view();

      const second = await open(store);
      expect(second.runner.view().clock).toEqual(atClose.clock);
      expect(second.runner.view().integrityDigest).toBe(atClose.integrityDigest);
      expect(second.runner.view().checkpoint.persistedSeq).toBe(atClose.checkpoint.persistedSeq);

      run(second.runner, second.host, 3000);
      const reference = SimulationEngine.create(newWorld());
      reference.runSteps(1000);
      expect(second.runner.view().clock.tick).toBe(1000);
      expect(second.runner.view().integrityDigest).toBe(reference.snapshot().integrityDigest);
    });

    it('loses at most the unsaved interval after an abrupt stop, and stays consistent', async () => {
      const store = new MemoryWorldStore();
      const first = await open(store);
      run(first.runner, first.host, 5500);
      await settle();
      // No flush: the process "dies" here with 1.5 s of unsaved progress.
      expect(first.runner.view().clock.tick).toBe(5);

      const second = await open(store);
      const resumed = second.runner.view();
      expect(resumed.clock.tick).toBe(4);

      const reference = SimulationEngine.create(newWorld());
      reference.runSteps(4);
      expect(resumed.integrityDigest).toBe(reference.snapshot().integrityDigest);
    });

    it('continues the checkpoint sequence after a restart', async () => {
      const store = new MemoryWorldStore();
      const first = await open(store);
      first.runner.execute({ type: 'pause' });
      await first.runner.flush();

      const second = await open(store);
      second.runner.execute({ type: 'resume' });
      await second.runner.flush();
      expect(store.saves.map((c) => c.seq)).toEqual([1, 2, 3]);
    });

    it('does not let time pass while the application is closed', async () => {
      const store = new MemoryWorldStore();
      const first = await open(store);
      run(first.runner, first.host, 4000);
      await first.runner.flush();

      const laterHost = new ManualHostClock(first.host.wallMs() + 86_400_000);
      const second = await open(store, laterHost);
      expect(second.runner.view().clock.tick).toBe(4);
    });
  });
});

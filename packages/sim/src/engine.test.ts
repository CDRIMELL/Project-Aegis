import { SPEED_MULTIPLIERS, formatUtc, simInstant } from '@aegis/domain';
import { describe, expect, it } from 'vitest';
import { SimulationEngine, WorldRestoreError } from './engine';
import { SIM_MODEL_VERSION, SIM_STEP_MS, type WorldSnapshot } from './world';

const EPOCH = simInstant(Date.UTC(2026, 9, 4, 12, 0, 0));
const world = (seed = 'test-world') => SimulationEngine.create({ seed, epoch: EPOCH });

describe('SimulationEngine', () => {
  it('starts a new world at tick 0, running at 1x', () => {
    const snapshot = world().snapshot();
    expect(snapshot.clock).toEqual({ simTime: EPOCH, tick: 0, speed: 1, running: true });
    expect(snapshot.modelVersion).toBe(SIM_MODEL_VERSION);
  });

  it('advances simulation time by exactly one step per tick', () => {
    const engine = world();
    engine.runSteps(3661);
    expect(engine.clock.tick).toBe(3661);
    expect(engine.clock.simTime).toBe(EPOCH + 3661 * SIM_STEP_MS);
    expect(formatUtc(engine.clock.simTime)).toBe('2026-10-04T13:01:01Z');
  });

  it('is deterministic: same seed and steps give an identical snapshot', () => {
    const a = world();
    const b = world();
    a.runSteps(5000);
    b.runSteps(5000);
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  it('does not depend on how steps are batched', () => {
    const oneByOne = world();
    for (let i = 0; i < 1000; i++) oneByOne.runSteps(1);

    const uneven = world();
    for (const chunk of [1, 99, 400, 0, 500]) uneven.runSteps(chunk);

    const single = world();
    single.runSteps(1000);

    expect(oneByOne.snapshot()).toEqual(single.snapshot());
    expect(uneven.snapshot()).toEqual(single.snapshot());
  });

  it('does not let speed or run state influence the rules', () => {
    const reference = world();
    reference.runSteps(600);

    for (const speed of SPEED_MULTIPLIERS) {
      const engine = world();
      engine.setSpeed(speed);
      engine.runSteps(300);
      engine.setRunning(false);
      engine.runSteps(300);
      const snapshot = engine.snapshot();
      expect(snapshot.integrityDigest).toBe(reference.snapshot().integrityDigest);
      expect(snapshot.rngStreams).toEqual(reference.snapshot().rngStreams);
      expect(snapshot.clock.tick).toBe(600);
    }
  });

  it('diverges for a different seed and for a different number of steps', () => {
    const base = world();
    base.runSteps(100);

    const otherSeed = world('another-world');
    otherSeed.runSteps(100);
    expect(otherSeed.snapshot().integrityDigest).not.toBe(base.snapshot().integrityDigest);

    const oneMore = world();
    oneMore.runSteps(101);
    expect(oneMore.snapshot().integrityDigest).not.toBe(base.snapshot().integrityDigest);
  });

  it('continues after restore exactly as an uninterrupted run would', () => {
    const uninterrupted = world();
    uninterrupted.runSteps(2000);

    const first = world();
    first.setSpeed(50);
    first.runSteps(750);
    // A snapshot must survive serialisation, as it does on its way to storage.
    const saved = JSON.parse(JSON.stringify(first.snapshot())) as WorldSnapshot;

    const resumed = SimulationEngine.restore(saved);
    expect(resumed.snapshot()).toEqual(first.snapshot());
    resumed.runSteps(1250);

    expect(resumed.snapshot().integrityDigest).toBe(uninterrupted.snapshot().integrityDigest);
    expect(resumed.snapshot().rngStreams).toEqual(uninterrupted.snapshot().rngStreams);
    expect(resumed.clock.simTime).toBe(uninterrupted.clock.simTime);
    expect(resumed.clock.speed).toBe(50);
  });

  it('rejects invalid step counts, speeds and seeds', () => {
    const engine = world();
    expect(() => {
      engine.runSteps(-1);
    }).toThrow(RangeError);
    expect(() => {
      engine.runSteps(1.5);
    }).toThrow(RangeError);
    expect(() => {
      engine.setSpeed(3 as never);
    }).toThrow(RangeError);
    expect(() => SimulationEngine.create({ seed: '', epoch: EPOCH })).toThrow(RangeError);
  });

  describe('restore validation', () => {
    const good = (): WorldSnapshot => {
      const engine = world();
      engine.runSteps(10);
      return engine.snapshot();
    };

    it.each<[string, (s: WorldSnapshot) => WorldSnapshot]>([
      ['unknown model version', (s) => ({ ...s, modelVersion: SIM_MODEL_VERSION + 1 })],
      ['empty seed', (s) => ({ ...s, seed: '' })],
      ['negative tick', (s) => ({ ...s, clock: { ...s.clock, tick: -1 } })],
      ['fractional tick', (s) => ({ ...s, clock: { ...s.clock, tick: 1.5 } })],
      ['unsupported speed', (s) => ({ ...s, clock: { ...s.clock, speed: 7 as never } })],
      [
        'time that disagrees with tick',
        (s) => ({ ...s, clock: { ...s.clock, simTime: simInstant(s.clock.simTime + 1) } }),
      ],
      ['invalid digest', (s) => ({ ...s, integrityDigest: -5 })],
      ['corrupt RNG state', (s) => ({ ...s, rngStreams: { 'core.integrity': [0, 0, 0, 0] } })],
    ])('refuses a snapshot with %s', (_label, corrupt) => {
      expect(() => SimulationEngine.restore(corrupt(good()))).toThrow(WorldRestoreError);
    });
  });
});

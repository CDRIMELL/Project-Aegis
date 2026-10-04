import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Rng, RngStreams, decodeRngState, encodeRngState } from './rng';

function take(rng: Rng, count: number): number[] {
  return Array.from({ length: count }, () => rng.nextUint32());
}

describe('Rng', () => {
  it('matches the xoshiro128** reference sequence for state [1, 2, 3, 4]', () => {
    const rng = Rng.fromState([1, 2, 3, 4]);
    expect(take(rng, 3)).toEqual([11520, 0, 5927040]);
  });

  it('produces the same sequence for the same seed and stream', () => {
    expect(take(Rng.fromSeed('world-a', 'events'), 50)).toEqual(
      take(Rng.fromSeed('world-a', 'events'), 50),
    );
  });

  it('produces different sequences for different seeds and for different streams', () => {
    const base = take(Rng.fromSeed('world-a', 'events'), 8);
    expect(take(Rng.fromSeed('world-b', 'events'), 8)).not.toEqual(base);
    expect(take(Rng.fromSeed('world-a', 'weather'), 8)).not.toEqual(base);
  });

  it('continues identically after its state is saved and restored', () => {
    const original = Rng.fromSeed('world-a', 'events');
    take(original, 1000);
    const restored = Rng.fromState(decodeRngState(encodeRngState(original.state())));
    expect(take(restored, 100)).toEqual(take(original, 100));
  });

  it('rejects invalid state', () => {
    expect(() => Rng.fromState([0, 0, 0, 0])).toThrow(RangeError);
    expect(() => Rng.fromState([1, 2, 3])).toThrow(RangeError);
    expect(() => Rng.fromState([1, 2, 3, 2 ** 32])).toThrow(RangeError);
    expect(() => Rng.fromState([1, 2, 3, -1])).toThrow(RangeError);
    expect(() => decodeRngState('xyz')).toThrow(RangeError);
  });

  it('keeps nextFloat within [0, 1)', () => {
    const rng = Rng.fromSeed('floats', 'test');
    for (let i = 0; i < 10_000; i++) {
      const value = rng.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('keeps nextInt within its bounds for any range', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (seed, min, span) => {
          const rng = Rng.fromSeed(seed, 'ints');
          for (let i = 0; i < 20; i++) {
            const value = rng.nextInt(min, min + span);
            if (!Number.isInteger(value) || value < min || value >= min + span) {
              return false;
            }
          }
          return true;
        },
      ),
    );
  });

  it('draws every value of a small range roughly evenly', () => {
    const rng = Rng.fromSeed('uniformity', 'test');
    const counts = [0, 0, 0, 0, 0, 0];
    const draws = 60_000;
    for (let i = 0; i < draws; i++) {
      const face = rng.nextInt(0, 6);
      counts[face] = (counts[face] ?? 0) + 1;
    }
    for (const count of counts) {
      expect(Math.abs(count - draws / 6)).toBeLessThan(draws * 0.01);
    }
  });

  it('rejects invalid ranges and probabilities', () => {
    const rng = Rng.fromSeed('errors', 'test');
    expect(() => rng.nextInt(5, 5)).toThrow(RangeError);
    expect(() => rng.nextInt(0.5, 3)).toThrow(RangeError);
    expect(() => rng.chance(1.5)).toThrow(RangeError);
    expect(() => rng.chance(Number.NaN)).toThrow(RangeError);
  });

  it('round-trips any valid state through its encoded form', () => {
    const word = fc.integer({ min: 0, max: 0xffffffff });
    fc.assert(
      fc.property(fc.tuple(word, word, word, word), (state) => {
        fc.pre(state.some((w) => w !== 0));
        expect(decodeRngState(encodeRngState(state))).toEqual(state);
      }),
    );
  });
});

describe('RngStreams', () => {
  it('isolates streams: drawing from one does not move another', () => {
    const quiet = new RngStreams('seed');
    const busy = new RngStreams('seed');
    take(busy.stream('weather'), 500);
    expect(take(busy.stream('events'), 10)).toEqual(take(quiet.stream('events'), 10));
  });

  it('restores saved streams and derives unseen ones from the seed', () => {
    const first = new RngStreams('seed');
    take(first.stream('events'), 123);
    const restored = new RngStreams('seed', first.states());

    expect(take(restored.stream('events'), 10)).toEqual(take(first.stream('events'), 10));
    expect(take(restored.stream('new'), 10)).toEqual(
      take(new RngStreams('seed').stream('new'), 10),
    );
  });

  it('reports states in stable name order', () => {
    const streams = new RngStreams('seed');
    streams.stream('zulu');
    streams.stream('alpha');
    expect(Object.keys(streams.states())).toEqual(['alpha', 'zulu']);
  });
});

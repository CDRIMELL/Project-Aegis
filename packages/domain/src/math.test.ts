import { describe, expect, it } from 'vitest';
import { destinationPoint, greatCircleDistance, initialBearing, intermediatePoint } from './geo';
import {
  HALF_PI,
  PI,
  TWO_PI,
  acos,
  asin,
  atan,
  atan2,
  cos,
  groupThousands,
  hypot,
  ln,
  sin,
  tan,
} from './math';
import { degrees, metres } from './units';

/** A small generator of test inputs. Integer arithmetic only, so it is the same everywhere. */
function inputs(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Folds the exact bits of a number into a running 32-bit hash. */
const view = new DataView(new ArrayBuffer(8));
function fold(hash: number, value: number): number {
  view.setFloat64(0, value);
  return (Math.imul(hash ^ view.getUint32(0), 16777619) ^ view.getUint32(4)) >>> 0;
}

/**
 * The exact bits of 100,000 results of each function, hashed. These values were recorded once and
 * confirmed identical under Node and under the WebView2 engine the application runs in, whose
 * `Math.sin`, `Math.cos`, `Math.atan2` and `Math.log` do differ from Node's. If any value here
 * changes, the simulation no longer computes the same world everywhere.
 */
const GOLDEN: Readonly<Record<string, string>> = {
  sin: 'fa0befbb',
  cos: 'c0565669',
  tan: '27912280',
  atan: '815de8e6',
  atan2: 'c8ddc773',
  asin: '22e3e3cd',
  acos: 'e6d8b27a',
  ln: '2c450382',
  hypot: '35664431',
};

const SAMPLED: Readonly<Record<string, (a: number, b: number) => number>> = {
  sin: (a) => sin(a * 40 - 20),
  cos: (a) => cos(a * 40 - 20),
  tan: (a) => tan(a * 3 - 1.5),
  atan: (a) => atan(a * 2000 - 1000),
  atan2: (a, b) => atan2(a - 0.5, b - 0.5),
  asin: (a) => asin(a * 2 - 1),
  acos: (a) => acos(a * 2 - 1),
  ln: (a) => ln(a * 1e6 + 1e-9),
  hypot: (a, b) => hypot(a * 1e3, b * 1e3),
};

function digest(name: string): string {
  const next = inputs(123456789);
  const sample = SAMPLED[name] as (a: number, b: number) => number;
  let hash = 2166136261;
  for (let i = 0; i < 100_000; i++) hash = fold(hash, sample(next(), next()));
  return hash.toString(16).padStart(8, '0');
}

describe('deterministic mathematics', () => {
  it('produces exactly the recorded bits', () => {
    const actual = Object.fromEntries(Object.keys(GOLDEN).map((name) => [name, digest(name)]));
    expect(actual).toEqual(GOLDEN);
  });

  it('gives geodesy that is exact to the bit as well', () => {
    // Distances, bearings and points between 20,000 pairs of places. Recorded and confirmed in
    // both engines, like the values above.
    const next = inputs(555);
    let hash = 2166136261;
    for (let i = 0; i < 20_000; i++) {
      const from = { lat: next() * 170 - 85, lon: next() * 360 - 180 };
      const to = { lat: next() * 170 - 85, lon: next() * 360 - 180 };
      hash = fold(hash, greatCircleDistance(from, to));
      hash = fold(hash, initialBearing(from, to));
      const mid = intermediatePoint(from, to, next());
      hash = fold(fold(hash, mid.lat), mid.lon);
      const end = destinationPoint(from, degrees(next() * 360), metres(next() * 5e6));
      hash = fold(fold(hash, end.lat), end.lon);
    }
    expect(hash.toString(16).padStart(8, '0')).toBe('a6707121');
  });

  it('agrees with the engine’s own functions to within a few parts in 10^16', () => {
    const next = inputs(987654321);
    const worst: Record<string, number> = {};
    const compare = (name: string, got: number, want: number) => {
      const error = Math.abs(got - want) / Math.max(Math.abs(want), 1e-12);
      worst[name] = Math.max(worst[name] ?? 0, error);
    };
    for (let i = 0; i < 50_000; i++) {
      const a = next();
      const b = next();
      const angle = a * 40 - 20;
      compare('sin', sin(angle), Math.sin(angle));
      compare('cos', cos(angle), Math.cos(angle));
      compare('tan', tan(a * 3 - 1.5), Math.tan(a * 3 - 1.5));
      compare('atan', atan(a * 2000 - 1000), Math.atan(a * 2000 - 1000));
      compare('atan2', atan2(a - 0.5, b - 0.5), Math.atan2(a - 0.5, b - 0.5));
      compare('asin', asin(a * 2 - 1), Math.asin(a * 2 - 1));
      compare('acos', acos(a * 2 - 1), Math.acos(a * 2 - 1));
      compare('ln', ln(a * 1e6 + 1e-9), Math.log(a * 1e6 + 1e-9));
      compare('ln near 1', ln(1 + (a - 0.5) * 1e-3), Math.log(1 + (a - 0.5) * 1e-3));
      compare('hypot', hypot(a, b), Math.hypot(a, b));
    }
    for (const [name, error] of Object.entries(worst)) {
      expect(error, name).toBeLessThan(2e-15);
    }
  });

  it('is exact where the answer is exact', () => {
    expect(sin(0)).toBe(0);
    expect(cos(0)).toBe(1);
    expect(sin(HALF_PI)).toBe(1);
    expect(cos(PI)).toBe(-1);
    expect(atan(0)).toBe(0);
    expect(atan2(0, 1)).toBe(0);
    expect(atan2(0, -1)).toBe(PI);
    expect(atan2(1, 0)).toBe(HALF_PI);
    expect(atan2(-1, 0)).toBe(-HALF_PI);
    expect(atan2(0, 0)).toBe(0);
    expect(asin(0)).toBe(0);
    expect(asin(1)).toBe(HALF_PI);
    expect(acos(1)).toBe(0);
    expect(ln(1)).toBe(0);
    expect(ln(2)).toBe(Math.LN2);
    expect(hypot(3, 4)).toBe(5);
    expect(TWO_PI).toBe(2 * PI);
    expect(HALF_PI).toBe(PI / 2);
    expect(PI).toBe(Math.PI);
  });

  it('is odd, even and periodic as the functions are', () => {
    const next = inputs(42);
    for (let i = 0; i < 2000; i++) {
      const x = next() * 12 - 6;
      expect(sin(-x)).toBe(-sin(x));
      expect(cos(-x)).toBe(cos(x));
      expect(atan(-x)).toBe(-atan(x));
      expect(sin(x) * sin(x) + cos(x) * cos(x)).toBeCloseTo(1, 14);
    }
  });

  it('answers the edges of each domain as the standard functions do', () => {
    expect(sin(Number.NaN)).toBeNaN();
    expect(cos(Number.POSITIVE_INFINITY)).toBeNaN();
    expect(asin(1.0000001)).toBeNaN();
    expect(acos(-1.0000001)).toBeNaN();
    expect(atan2(Number.NaN, 1)).toBeNaN();
    expect(ln(-1)).toBeNaN();
    expect(ln(0)).toBe(Number.NEGATIVE_INFINITY);
    expect(ln(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(atan(Number.POSITIVE_INFINITY)).toBe(HALF_PI);
    expect(atan(Number.NEGATIVE_INFINITY)).toBe(-HALF_PI);
    expect(ln(Number.MIN_VALUE)).toBeCloseTo(Math.log(Number.MIN_VALUE), 10);
    expect(ln(Number.MAX_VALUE)).toBeCloseTo(Math.log(Number.MAX_VALUE), 10);
  });

  it('groups thousands without the engine’s locale data', () => {
    expect(groupThousands(0)).toBe('0');
    expect(groupThousands(999)).toBe('999');
    expect(groupThousands(1000)).toBe('1,000');
    expect(groupThousands(1234567.6)).toBe('1,234,568');
    expect(groupThousands(-45_000)).toBe('-45,000');
    expect(groupThousands(107_645)).toBe((107_645).toLocaleString('en-GB'));
  });
});

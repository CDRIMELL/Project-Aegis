import { describe, expect, it } from 'vitest';
import { foldUint32, DIGEST_SEED, hex32 } from './hash';
import { isSpeedMultiplier, SPEED_MULTIPLIERS } from './speed';
import { addMs, formatUtc, MS_PER_DAY, simInstant } from './time';

describe('SimInstant', () => {
  it('accepts whole non-negative milliseconds only', () => {
    expect(simInstant(0)).toBe(0);
    expect(() => simInstant(-1)).toThrow(RangeError);
    expect(() => simInstant(1.5)).toThrow(RangeError);
    expect(() => simInstant(Number.NaN)).toThrow(RangeError);
  });

  it('adds durations and formats as UTC', () => {
    const start = simInstant(Date.UTC(2026, 9, 4, 12, 0, 0));
    expect(formatUtc(start)).toBe('2026-10-04T12:00:00Z');
    expect(formatUtc(addMs(start, MS_PER_DAY + 5000))).toBe('2026-10-05T12:00:05Z');
  });
});

describe('speed multipliers', () => {
  it('are exactly the supported set', () => {
    expect(SPEED_MULTIPLIERS).toEqual([1, 2, 5, 10, 50, 100]);
    expect(isSpeedMultiplier(50)).toBe(true);
    expect(isSpeedMultiplier(3)).toBe(false);
    expect(isSpeedMultiplier('10')).toBe(false);
  });
});

describe('digest', () => {
  it('depends on both value and order', () => {
    const ab = foldUint32(foldUint32(DIGEST_SEED, 1), 2);
    const ba = foldUint32(foldUint32(DIGEST_SEED, 2), 1);
    expect(ab).not.toBe(ba);
    expect(foldUint32(foldUint32(DIGEST_SEED, 1), 2)).toBe(ab);
    expect(hex32(ab)).toMatch(/^[0-9a-f]{8}$/);
  });
});

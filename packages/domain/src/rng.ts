import { hex32 } from './hash';

/** Four unsigned 32-bit words: the complete state of one generator. */
export type RngState = readonly [number, number, number, number];

const UINT32_RANGE = 0x1_0000_0000;

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * String hash (xmur3) used only to turn a seed and a stream name into generator state.
 * Returns a function that yields successive well-mixed 32-bit values.
 */
function seedHasher(text: string): () => number {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function assertState(state: readonly number[]): asserts state is RngState {
  if (state.length !== 4) {
    throw new RangeError(`RNG state must have 4 words, got ${state.length}`);
  }
  for (const word of state) {
    if (!Number.isInteger(word) || word < 0 || word >= UINT32_RANGE) {
      throw new RangeError(`RNG state word out of uint32 range: ${word}`);
    }
  }
  if (state.every((word) => word === 0)) {
    throw new RangeError('RNG state must not be all zero');
  }
}

/**
 * Deterministic pseudo-random generator (xoshiro128**).
 *
 * Not cryptographically secure. Use only for simulation behaviour, never for secrets.
 * See ADR 0006.
 */
export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  private constructor(state: RngState) {
    [this.s0, this.s1, this.s2, this.s3] = state;
  }

  /** Derives the generator for one named stream of a world. */
  static fromSeed(seed: string, stream: string): Rng {
    const next = seedHasher(`${seed}\u0000${stream}`);
    const state: [number, number, number, number] = [next(), next(), next(), next()];
    if (state.every((word) => word === 0)) {
      state[0] = 1;
    }
    return new Rng(state);
  }

  static fromState(state: readonly number[]): Rng {
    assertState(state);
    return new Rng(state);
  }

  state(): RngState {
    return [this.s0, this.s1, this.s2, this.s3];
  }

  /** Uniform integer in [0, 2^32). */
  nextUint32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;

    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);

    return result;
  }

  /** Uniform float in [0, 1) with 32 bits of resolution. */
  nextFloat(): number {
    return this.nextUint32() / UINT32_RANGE;
  }

  /** Uniform integer in [minInclusive, maxExclusive), free of modulo bias. */
  nextInt(minInclusive: number, maxExclusive: number): number {
    const span = maxExclusive - minInclusive;
    if (
      !Number.isSafeInteger(minInclusive) ||
      !Number.isSafeInteger(maxExclusive) ||
      span <= 0 ||
      span > UINT32_RANGE
    ) {
      throw new RangeError(`Invalid integer range [${minInclusive}, ${maxExclusive})`);
    }
    // Reject the tail of the 32-bit range that would favour low results.
    const limit = UINT32_RANGE - (UINT32_RANGE % span);
    let value = this.nextUint32();
    while (value >= limit) {
      value = this.nextUint32();
    }
    return minInclusive + (value % span);
  }

  /** True with the given probability. Values outside [0, 1] are rejected. */
  chance(probability: number): boolean {
    if (!(probability >= 0 && probability <= 1)) {
      throw new RangeError(`Probability must be within [0, 1], got ${probability}`);
    }
    return this.nextFloat() < probability;
  }
}

/** 32 hexadecimal characters; the persisted form of a generator state. */
export function encodeRngState(state: RngState): string {
  return state.map(hex32).join('');
}

export function decodeRngState(text: string): RngState {
  if (!/^[0-9a-f]{32}$/.test(text)) {
    throw new RangeError('Encoded RNG state must be 32 lowercase hexadecimal characters');
  }
  const words = [0, 8, 16, 24].map((offset) => Number.parseInt(text.slice(offset, offset + 8), 16));
  assertState(words);
  return words;
}

/**
 * The set of named generators belonging to one world.
 *
 * Each subsystem draws from its own stream, so one subsystem drawing more or fewer numbers
 * never shifts the sequence another subsystem sees.
 */
export class RngStreams {
  private readonly streams = new Map<string, Rng>();

  constructor(
    private readonly seed: string,
    saved: Readonly<Record<string, RngState>> = {},
  ) {
    for (const [name, state] of Object.entries(saved)) {
      this.streams.set(name, Rng.fromState(state));
    }
  }

  stream(name: string): Rng {
    let rng = this.streams.get(name);
    if (!rng) {
      rng = Rng.fromSeed(this.seed, name);
      this.streams.set(name, rng);
    }
    return rng;
  }

  /** States of every stream used so far, keyed by name in sorted order. */
  states(): Record<string, RngState> {
    const out: Record<string, RngState> = {};
    for (const name of [...this.streams.keys()].sort()) {
      const rng = this.streams.get(name);
      if (rng) {
        out[name] = rng.state();
      }
    }
    return out;
  }
}

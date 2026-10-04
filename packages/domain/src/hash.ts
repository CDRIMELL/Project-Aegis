const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/** Initial value for a digest built with {@link foldUint32}. */
export const DIGEST_SEED = FNV_OFFSET_BASIS;

/**
 * Folds one unsigned 32-bit value into a running FNV-1a digest, byte by byte.
 * Not cryptographic: it detects divergence between two simulation runs, nothing more.
 */
export function foldUint32(digest: number, value: number): number {
  let h = digest >>> 0;
  for (let shift = 0; shift < 32; shift += 8) {
    h ^= (value >>> shift) & 0xff;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h;
}

/** Fixed-width hexadecimal rendering of an unsigned 32-bit value. */
export function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

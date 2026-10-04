/**
 * Deterministic 53-bit hash (cyrb53) of a string, as 14 hexadecimal characters.
 * Used only to detect that a record changed between imports; it is not a security measure.
 */
function cyrb53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const high = (h2 >>> 0) & 0x1fffff;
  const low = h1 >>> 0;
  return high.toString(16).padStart(6, '0') + low.toString(16).padStart(8, '0');
}

/** Hash of a flat record's content. Independent of key order; `undefined` equals `null`. */
export function contentHash(record: Readonly<Record<string, unknown>>): string {
  const canonical = Object.keys(record)
    .sort()
    .map((key) => [key, record[key] ?? null]);
  return cyrb53(JSON.stringify(canonical));
}

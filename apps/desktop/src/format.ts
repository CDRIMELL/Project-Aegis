const integer = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

export function formatInteger(value: number): string {
  return integer.format(value);
}

/** Wall-clock timestamp as `YYYY-MM-DD HH:MM:SS` in UTC. */
export function formatWallUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
}

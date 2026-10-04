const integer = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

export function formatInteger(value: number): string {
  return integer.format(value);
}

/** Wall-clock timestamp as `YYYY-MM-DD HH:MM:SS` in UTC. */
export function formatWallUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ');
}

export function formatKg(value: number): string {
  return `${formatInteger(value)} kg`;
}

export function formatKm(metres: number): string {
  return `${formatInteger(metres / 1000)} km`;
}

/** `2 h 05 min`, or `45 min` under an hour. */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const rest = String(minutes % 60).padStart(2, '0');
  return hours > 0 ? `${hours} h ${rest} min` : `${minutes % 60} min`;
}

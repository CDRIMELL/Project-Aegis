/** Simulated seconds that pass per real second. Pausing is a separate run state, not a speed. */
export const SPEED_MULTIPLIERS = [1, 2, 5, 10, 50, 100] as const;

export type SpeedMultiplier = (typeof SPEED_MULTIPLIERS)[number];

export function isSpeedMultiplier(value: unknown): value is SpeedMultiplier {
  return (SPEED_MULTIPLIERS as readonly unknown[]).includes(value);
}

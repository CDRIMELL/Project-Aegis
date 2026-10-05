import { MS_PER_DAY, MS_PER_SECOND } from '../time';

/*
 * Reporting periods (ADR 0024). A period is a half-open range of simulation ticks, `[from, to)`.
 * It is simulation time: nothing here reads a clock.
 */

export const TICKS_PER_HOUR = 3600;
export const TICKS_PER_DAY = 24 * TICKS_PER_HOUR;

export interface ReportPeriod {
  readonly fromTick: number;
  /** Exclusive. */
  readonly toTick: number;
}

export const PERIOD_PRESETS = ['today', 'last24h', 'last7d', 'last30d'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const PERIOD_LABEL: Readonly<Record<PeriodPreset | 'custom', string>> = {
  today: 'Today',
  last24h: 'Last 24 h',
  last7d: 'Last 7 days',
  last30d: 'Last 30 days',
  custom: 'Custom',
};

const PRESET_TICKS: Readonly<Record<Exclude<PeriodPreset, 'today'>, number>> = {
  last24h: TICKS_PER_DAY,
  last7d: 7 * TICKS_PER_DAY,
  last30d: 30 * TICKS_PER_DAY,
};

/** The tick at which the simulated UTC day containing `tick` began. Never before the world did. */
export function dayStartTick(tick: number, epochMs: number): number {
  const instantMs = epochMs + tick * MS_PER_SECOND;
  const dayStartMs = Math.floor(instantMs / MS_PER_DAY) * MS_PER_DAY;
  return Math.max(0, Math.ceil((dayStartMs - epochMs) / MS_PER_SECOND));
}

/**
 * A named period ending at the report's moment. It includes the moment itself, so something that
 * finished on the very tick the report is as of is in it.
 */
export function presetPeriod(
  preset: PeriodPreset,
  asOfTick: number,
  epochMs: number,
): ReportPeriod {
  const toTick = asOfTick + 1;
  if (preset === 'today') return { fromTick: dayStartTick(asOfTick, epochMs), toTick };
  return { fromTick: Math.max(0, toTick - PRESET_TICKS[preset]), toTick };
}

/** A period between two simulation instants. `null` when they do not make a period. */
export function periodBetween(fromMs: number, toMs: number, epochMs: number): ReportPeriod | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  const fromTick = Math.max(0, Math.ceil((fromMs - epochMs) / MS_PER_SECOND));
  const toTick = Math.ceil((toMs - epochMs) / MS_PER_SECOND);
  return toTick > fromTick ? { fromTick, toTick } : null;
}

/** The period of the same length immediately before. `null` when the world is not that old. */
export function previousPeriod(period: ReportPeriod): ReportPeriod | null {
  const length = period.toTick - period.fromTick;
  if (length <= 0 || period.fromTick <= 0) return null;
  return { fromTick: Math.max(0, period.fromTick - length), toTick: period.fromTick };
}

export function inPeriod(tick: number | null, period: ReportPeriod): boolean {
  return tick !== null && tick >= period.fromTick && tick < period.toTick;
}

/** Ticks two ranges have in common. */
export function overlapTicks(aFrom: number, aTo: number, bFrom: number, bTo: number): number {
  return Math.max(0, Math.min(aTo, bTo) - Math.max(aFrom, bFrom));
}

/** Simulation time of a tick as ISO 8601 UTC, to the second. */
export function tickToIso(tick: number, epochMs: number): string {
  return new Date(epochMs + tick * MS_PER_SECOND).toISOString().replace('.000Z', 'Z');
}

export interface TimeBucket {
  readonly fromTick: number;
  readonly toTick: number;
}

/** The most buckets a period is divided into for a chart. */
const MAX_BUCKETS = 62;

/**
 * Divides a period into buckets for a series: hours for a period of up to two days, simulated UTC
 * days beyond that, and whole multiples of a day when that would be too many to read.
 */
export function periodBuckets(period: ReportPeriod, epochMs: number): TimeBucket[] {
  const length = period.toTick - period.fromTick;
  if (length <= 0) return [];
  let size = length <= 2 * TICKS_PER_DAY ? TICKS_PER_HOUR : TICKS_PER_DAY;
  while (length / size > MAX_BUCKETS) size += TICKS_PER_DAY;
  // Buckets start on the hour or the day of simulation time, not at the period's first tick.
  const epochTicks = Math.floor(epochMs / MS_PER_SECOND);
  const align = size >= TICKS_PER_DAY ? TICKS_PER_DAY : TICKS_PER_HOUR;
  const offset = (((epochTicks + period.fromTick) % align) + align) % align;
  const buckets: TimeBucket[] = [];
  for (let from = period.fromTick - offset; from < period.toTick; from += size) {
    buckets.push({
      fromTick: Math.max(from, period.fromTick),
      toTick: Math.min(from + size, period.toTick),
    });
  }
  return buckets;
}

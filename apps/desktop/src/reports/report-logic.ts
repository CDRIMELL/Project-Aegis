import {
  PERIOD_PRESETS,
  TICKS_PER_DAY,
  isOpenEvent,
  periodBetween,
  presetPeriod,
  tickToIso,
  type PeriodPreset,
  type Report,
  type ReportPeriod,
  type ReportTableName,
  type TimeBucket,
} from '@aegis/domain';
import type { SimView } from '@aegis/sim';
import type { ChartSeries, TableSort } from '@aegis/ui';

/*
 * What the Reports screens decide, kept apart from how they look: which period is meant, what the
 * fleet is doing at this moment, how a series is labelled, how a table is ordered. Pure.
 */

export const SECTION_LABEL: Readonly<Record<ReportTableName, string>> = {
  summary: 'Summary',
  missions: 'Missions',
  fleet: 'Fleet utilisation',
  fuel: 'Fuel',
  maintenance: 'Maintenance',
  events: 'Events and environment',
  services: 'Aerodromes and services',
};

export const SECTION_QUESTION: Readonly<Record<ReportTableName, string>> = {
  summary: 'What is happening now, and what happened in the period',
  missions: 'What was flown, how it ended, and what it cost',
  fleet: 'How each aircraft was used, and how much of the time it could be',
  fuel: 'What was burned, by whom and on what',
  maintenance: 'What needs attention, and what has been done',
  events: 'What the world did, and what it affected',
  services: 'What each aerodrome can do, is doing, and has done',
};

export type PeriodKind = PeriodPreset | 'custom';
export const PERIOD_KINDS: readonly PeriodKind[] = [...PERIOD_PRESETS, 'custom'];

export interface PeriodChoice {
  readonly kind: PeriodKind;
  /** Simulation time, UTC, as `YYYY-MM-DD HH:MM`. Used only when the kind is `custom`. */
  readonly from: string;
  readonly to: string;
}

const SIM_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;

/** `2026-10-04 13:30` as Unix milliseconds, UTC. `null` when it is not a real date and time. */
export function parseSimTime(text: string): number | null {
  const match = SIM_TIME.exec(text.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = Date.UTC(year, month - 1, day, hour, minute);
  // Date.UTC rolls an impossible date over (31 February becomes 3 March); refuse those.
  return formatSimTime(ms) === `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`
    ? ms
    : null;
}

export function formatSimTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export function tickTime(tick: number, epochMs: number): string {
  return formatSimTime(epochMs + tick * 1000);
}

export interface ResolvedPeriod {
  readonly period: ReportPeriod | null;
  /** Why there is no period, in words for the person who typed it. */
  readonly problem: string | null;
}

/** The period a choice means at the report's moment. */
export function resolvePeriod(
  choice: PeriodChoice,
  asOfTick: number,
  epochMs: number,
): ResolvedPeriod {
  if (choice.kind !== 'custom') {
    return { period: presetPeriod(choice.kind, asOfTick, epochMs), problem: null };
  }
  const from = parseSimTime(choice.from);
  const to = parseSimTime(choice.to);
  if (from === null || to === null) {
    return { period: null, problem: 'Enter both times as YYYY-MM-DD HH:MM, in simulation UTC.' };
  }
  const period = periodBetween(from, to, epochMs);
  if (!period) return { period: null, problem: 'The period must end after it begins.' };
  if (period.fromTick > asOfTick) {
    return { period: null, problem: 'The period begins after the present simulation time.' };
  }
  return { period, problem: null };
}

/** A custom period to start from: the last 24 hours, to the minute. */
export function defaultCustom(
  asOfTick: number,
  epochMs: number,
): Pick<PeriodChoice, 'from' | 'to'> {
  const day = presetPeriod('last24h', asOfTick, epochMs);
  const minute = (tick: number, up: boolean) => {
    const ms = epochMs + tick * 1000;
    return formatSimTime(up ? Math.ceil(ms / 60_000) * 60_000 : Math.floor(ms / 60_000) * 60_000);
  };
  return { from: minute(day.fromTick, false), to: minute(day.toTick, true) };
}

function span(ticks: number): string {
  const hours = ticks / 3600;
  if (hours < 1) return `${Math.max(1, Math.round(ticks / 60))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}

/** `2026-10-04 12:00 to 2026-10-05 11:39 UTC · 24 h of simulation time`. */
export function describePeriod(period: ReportPeriod, asOfTick: number, epochMs: number): string {
  const until = Math.min(period.toTick, asOfTick + 1);
  const end = Math.max(until - 1, period.fromTick);
  return `${tickTime(period.fromTick, epochMs)} to ${tickTime(end, epochMs)} UTC · ${span(until - period.fromTick)} of simulation time`;
}

export interface CurrentPicture {
  readonly aircraft: number;
  readonly available: number;
  readonly airborne: number;
  /** Due maintenance, in maintenance or unserviceable. */
  readonly unavailable: number;
  /** Due maintenance and waiting for it to be started. */
  readonly awaitingMaintenance: number;
  readonly inMaintenance: number;
  /** On the ground being turned round or fuelled: not available, and not down. */
  readonly servicing: number;
  readonly activeMissions: number;
  /** Planned or accepted, and not yet launched. */
  readonly pendingMissions: number;
  readonly openOffers: number;
  readonly activeEvents: number;
  readonly announcedEvents: number;
}

/** The world as it is at this instant, from the live view. */
export function currentPicture(view: SimView): CurrentPicture {
  const aircraft = view.fleet.aircraft;
  const count = (status: string) => aircraft.filter((each) => each.status === status).length;
  const missions = view.missions.missions;
  const events = view.events.events.filter((event) => isOpenEvent(event.status));
  return {
    aircraft: aircraft.length,
    available: count('available'),
    airborne: count('in_flight'),
    unavailable: count('maintenance_due') + count('in_maintenance') + count('unserviceable'),
    awaitingMaintenance: count('maintenance_due') + count('unserviceable'),
    inMaintenance: count('in_maintenance'),
    servicing: count('servicing'),
    activeMissions: missions.filter((mission) => mission.status === 'active').length,
    pendingMissions: missions.filter(
      (mission) => mission.status === 'planned' || mission.status === 'accepted',
    ).length,
    openOffers: missions.filter((mission) => mission.status === 'offered').length,
    activeEvents: events.filter((event) => event.status === 'active').length,
    announcedEvents: events.filter((event) => event.status === 'scheduled').length,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A bucket's label on a chart axis: the hour for hourly buckets, the simulated day otherwise. */
export function bucketLabel(bucket: TimeBucket, epochMs: number, hourly: boolean): string {
  const iso = tickToIso(bucket.fromTick, epochMs);
  if (hourly) return `${iso.slice(11, 13)}:00`;
  return `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ''}`;
}

export interface ReportSeries {
  readonly categories: string[];
  readonly hourly: boolean;
  readonly flightHours: ChartSeries[];
  readonly fuel: ChartSeries[];
  readonly outcomes: ChartSeries[];
  readonly availability: ChartSeries[];
  readonly events: ChartSeries[];
}

const round = (value: number, places = 1) => {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};

/** The report's series, as the charts take them. */
export function reportSeries(report: Report): ReportSeries {
  const points = report.series;
  const hourly = points.every((point) => point.toTick - point.fromTick < TICKS_PER_DAY / 2);
  return {
    categories: points.map((point) => bucketLabel(point, report.epochMs, hourly)),
    hourly,
    flightHours: [
      {
        name: 'Flight time',
        tone: 'accent',
        values: points.map((point) => round(point.flightSeconds / 3600, 2)),
      },
    ],
    fuel: [
      {
        name: 'Fuel used',
        tone: 'info',
        values: points.map((point) => round(point.fuelUsedKg, 0)),
      },
    ],
    outcomes: [
      { name: 'Completed', tone: 'accent', values: points.map((point) => point.missionsCompleted) },
      { name: 'Failed', tone: 'critical', values: points.map((point) => point.missionsFailed) },
    ],
    availability: [
      {
        name: 'Fleet availability',
        tone: 'accent',
        values: points.map((point) =>
          point.availability === null ? null : round(point.availability * 100),
        ),
      },
    ],
    events: [
      { name: 'Events started', tone: 'warn', values: points.map((point) => point.eventsStarted) },
    ],
  };
}

/** A share as a percentage figure, `46.2`, to show with a % unit. `null` when there is no share. */
export function percentText(fraction: number | null, places = 1): string | null {
  return fraction === null ? null : (fraction * 100).toFixed(places);
}

/**
 * How a figure compares with the period before: `+2 on the period before`. Says so plainly when
 * there is no earlier period to compare with.
 */
export function changeText(
  current: number,
  previous: number | null,
  format: (value: number) => string = (value) => String(Math.round(value)),
): string {
  if (previous === null) return 'No earlier period to compare';
  const difference = current - previous;
  if (format(Math.abs(difference)) === format(0)) return 'Same as the period before';
  return `${difference > 0 ? '+' : '−'}${format(Math.abs(difference))} on the period before`;
}

/** The share by which `actual` differs from `estimate`, as `+1.2 %`. `null` with no estimate. */
export function againstEstimate(actual: number, estimate: number | null): string | null {
  if (estimate === null || estimate <= 0) return null;
  const percent = ((actual - estimate) / estimate) * 100;
  return `${percent >= 0 ? '+' : '−'}${Math.abs(percent).toFixed(1)} %`;
}

export type SortValue = number | string | null;

/**
 * Rows in the order a table asks for. Stable: rows that compare equal keep the order they came
 * in, which is the report's own. A missing value sorts last whichever way the column runs.
 */
export function sortRows<Row>(
  rows: readonly Row[],
  values: Readonly<Record<string, (row: Row) => SortValue>>,
  sort: TableSort | null,
): Row[] {
  const value = sort ? values[sort.key] : undefined;
  if (!sort || !value) return [...rows];
  const direction = sort.descending ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index, key: value(row) }))
    .sort((a, b) => {
      if (a.key === null || b.key === null) {
        return a.key === b.key ? a.index - b.index : a.key === null ? 1 : -1;
      }
      const order = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
      return order * direction || a.index - b.index;
    })
    .map((entry) => entry.row);
}

/** The sort after a header is clicked: a new column starts descending, the same one flips. */
export function nextSort(current: TableSort | null, key: string): TableSort {
  return current?.key === key
    ? { key, descending: !current.descending }
    : { key, descending: true };
}

/**
 * What a ground service was asked to bring a quantity to, beside what it moved. A service logged
 * before the request was recorded (simulation model 8 or earlier) moved something and names no
 * request: that is said, and is not shown as nothing having been asked for.
 */
export function askedLabel(targetKg: number | null, movedKg: number): string {
  if (targetKg !== null) return `asked ${Math.round(targetKg).toLocaleString('en-GB')} kg`;
  return movedKg === 0 ? 'none asked for' : 'request not recorded';
}

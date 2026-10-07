import {
  EVENT_LABEL,
  EVENT_TYPES,
  counter,
  meanReadiness,
  type CareerCounters,
  type CareerReadiness,
  type CareerTotals,
} from '@aegis/domain';
import type { LogEntry } from '@aegis/sim';

/*
 * How the career record is set out (ADR 0031). The record itself is the simulation's: named
 * counters, each moved only by a logged occurrence. This module gives them their words and their
 * order, and adds nothing: a figure the simulation cannot support has no row here.
 */

export interface RecordRow {
  readonly label: string;
  readonly value: number;
  /** What unit the figure is in, when it is not a count. */
  readonly unit?: string;
}

export interface RecordGroup {
  readonly title: string;
  readonly rows: readonly RecordRow[];
  /** What the group does not hold, and why. */
  readonly note?: string;
}

type RowSpec = readonly [label: string, value: (counters: CareerCounters) => number, unit?: string];

const of =
  (...names: string[]) =>
  (counters: CareerCounters) =>
    names.reduce((sum, name) => sum + counter(counters, name), 0);

const GROUPS: readonly { title: string; rows: readonly RowSpec[]; note?: string }[] = [
  {
    title: 'Missions',
    rows: [
      ['Completed', of('missions.completed')],
      ['Failed', of('missions.failed')],
      ['Aborted in flight', of('missions.aborted')],
      ['Launched', of('missions.launched')],
      ['Not away at their scheduled time', of('missions.delayed')],
      ['Completed on your orders', of('missions.completed.commander')],
      ['Completed by routine tasking', of('missions.completed.routine')],
    ],
  },
  {
    title: 'Commitments met',
    rows: [
      ['Ending in the United Kingdom', of('commitments.uk')],
      ['Ending overseas', of('commitments.overseas')],
      ['Training and exercises', of('commitments.training')],
      ['Logistics and transport', of('commitments.logistics')],
      ['Emergency response and rescue', of('commitments.emergency')],
      ['Patrol, reconnaissance and intercept', of('commitments.airspace')],
    ],
  },
  {
    title: 'Aircraft',
    rows: [
      ['Flights completed', of('flights.completed')],
      ['Hours flown', (counters) => counter(counters, 'flights.seconds') / 3600, 'h'],
      ['Held at a closed destination', of('flights.held')],
      ['Out of fuel in flight', of('aircraft.fuelExhausted')],
      ['Fallen due maintenance', of('aircraft.maintenanceDue')],
      ['Maintenance completed', of('aircraft.maintained')],
      ['Ground services completed', of('services.completed')],
      ['Waits for a ground resource', of('services.queued')],
    ],
  },
  {
    title: 'Events faced',
    rows: [
      ['Events in the operating area', of('events.total')],
      ...EVENT_TYPES.map((type): RowSpec => [EVENT_LABEL[type], of(`events.${type}`)]),
    ],
  },
  {
    title: 'Orders given',
    rows: [
      ['Orders in all', of('orders.total')],
      ['Requirements taken up', of('orders.offersTakenUp')],
      ['Requirements declined', of('orders.offersRejected')],
      ['Requirements lapsed unanswered', of('offers.expired')],
      ['Missions accepted', of('orders.missionsAccepted')],
      ['Launches ordered', of('orders.launches')],
      ['Diversions ordered', of('orders.diversions')],
      ['Returns to base ordered', of('orders.returns')],
      ['Reroutes and holds ordered', of('orders.reroutes', 'orders.holds')],
      ['Missions aborted', of('orders.aborts')],
      ['Missions cancelled or released', of('orders.missionsCancelled', 'orders.missionsReleased')],
      ['Maintenance ordered', of('orders.maintenance')],
    ],
    note: 'Orders are counted by kind. How each turned out is not recorded yet: the simulation does not judge decisions.',
  },
  {
    title: 'Routine operations',
    rows: [
      ['Sorties tasked by the world', of('routine.tasked')],
      ['Stood down before launch', of('routine.stoodDown')],
    ],
  },
];

/** The record, grouped and worded. Every row is shown, at zero where nothing has happened. */
export function careerRecord(counters: CareerCounters): RecordGroup[] {
  return GROUPS.map((group) => ({
    title: group.title,
    rows: group.rows.map(([label, value, unit]) => ({
      label,
      value: value(counters),
      ...(unit ? { unit } : {}),
    })),
    ...(group.note ? { note: group.note } : {}),
  }));
}

export interface RecordChange {
  readonly group: string;
  readonly label: string;
  readonly before: number;
  readonly after: number;
  readonly unit?: string;
}

/** The rows of the record a day moved, with the career total before it and after it. */
export function recordChanges(before: CareerCounters, after: CareerCounters): RecordChange[] {
  const was = careerRecord(before);
  return careerRecord(after).flatMap((group, groupIndex) =>
    group.rows.flatMap((row, rowIndex) => {
      const previous = was[groupIndex]?.rows[rowIndex]?.value ?? 0;
      return row.value === previous
        ? []
        : [
            {
              group: group.title,
              label: row.label,
              before: previous,
              after: row.value,
              ...(row.unit ? { unit: row.unit } : {}),
            },
          ];
    }),
  );
}

/** A figure of the record as text: a whole count, or one decimal place where it has a unit. */
export function recordValue(value: number, unit?: string): string {
  return unit ? `${value.toFixed(1)} ${unit}` : Math.round(value).toLocaleString('en-GB');
}

/** Simulated time in command, as hours and minutes. */
export function commandTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60).toLocaleString('en-GB')} h ${String(minutes % 60).padStart(2, '0')} min`;
}

const percent = (share: number | null) => (share === null ? null : `${Math.round(share * 100)} %`);

/** Readiness as text: the mean, and the lowest and highest it reached. `null` where not recorded. */
export function readinessText(readiness: CareerReadiness): {
  readonly mean: string | null;
  readonly low: string | null;
  readonly high: string | null;
} {
  return {
    mean: percent(meanReadiness(readiness)),
    low: percent(readiness.low),
    high: percent(readiness.high),
  };
}

/** The totals of a career before one of its days: every other day summed. */
export function totalsBefore(totals: CareerTotals, day: CareerCounters): CareerCounters {
  const before: Record<string, number> = { ...totals.counters };
  for (const [name, amount] of Object.entries(day)) {
    before[name] = (before[name] ?? 0) - amount;
  }
  return before;
}

export interface NotableEntry {
  readonly seq: number;
  readonly tick: number;
  readonly kind: 'event' | 'order';
  readonly tone: 'critical' | 'warn' | 'info' | 'ok';
  readonly text: string;
}

/** Log entry types read for a day's summary. The database is asked for these and no others. */
export const NOTABLE_TYPES = [
  'eventStarted',
  'flightFuelExhausted',
  'flightHolding',
  'maintenanceDue',
  'missionFailed',
  'missionCompleted',
  'routineStoodDown',
  'launchDelayed',
  'acceptOffer',
  'rejectOffer',
  'acceptMission',
  'releaseMission',
  'cancelMission',
  'launchMission',
  'launchFlight',
  'abortMission',
  'reviseFlight',
  'startMaintenance',
] as const;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const about = (entry: LogEntry) =>
  [entry.missionId, entry.aircraftId].filter((id): id is string => id !== null).join(' · ');

const ORDER_WORDS: Readonly<Record<string, string>> = {
  acceptOffer: 'Requirement taken up',
  rejectOffer: 'Requirement declined',
  acceptMission: 'Mission accepted',
  releaseMission: 'Mission released',
  cancelMission: 'Mission cancelled',
  launchMission: 'Mission launched',
  launchFlight: 'Flight launched',
  abortMission: 'Mission aborted in flight',
  startMaintenance: 'Maintenance ordered',
};
const REVISION_WORDS: Readonly<Record<string, string>> = {
  divert: 'Diversion ordered',
  return: 'Return to base ordered',
  reroute: 'Reroute ordered',
  hold: 'Hold ordered',
};

/**
 * What stood out in a stretch of the log: what the world did that mattered, and what the
 * commander ordered. Routine sorties that simply completed are left to the counters.
 */
export function notableEntries(entries: readonly LogEntry[]): NotableEntry[] {
  const out: NotableEntry[] = [];
  for (const entry of entries) {
    const base = { seq: entry.seq, tick: entry.tick };
    const subject = about(entry);
    const tail = subject ? ` · ${subject}` : '';
    if (entry.kind === 'command') {
      if (entry.actor !== 'player') continue;
      const words =
        entry.type === 'reviseFlight'
          ? REVISION_WORDS[text(entry.payload.intent)]
          : ORDER_WORDS[entry.type];
      if (words) out.push({ ...base, kind: 'order', tone: 'info', text: `${words}${tail}` });
      continue;
    }
    switch (entry.type) {
      case 'eventStarted': {
        const label = (EVENT_LABEL as Readonly<Record<string, string | undefined>>)[
          text(entry.payload.eventType)
        ];
        const title = text(entry.payload.title);
        out.push({
          ...base,
          kind: 'event',
          tone: 'warn',
          text: title || `${label ?? 'Event'} began${tail}`,
        });
        break;
      }
      case 'flightFuelExhausted':
        out.push({
          ...base,
          kind: 'event',
          tone: 'critical',
          text: `Out of fuel in flight${tail}`,
        });
        break;
      case 'flightHolding':
        out.push({
          ...base,
          kind: 'event',
          tone: 'warn',
          text: `Holding${text(entry.payload.at) ? ` short of ${text(entry.payload.at)}` : ''}${tail}`,
        });
        break;
      case 'maintenanceDue':
        out.push({ ...base, kind: 'event', tone: 'warn', text: `Fell due maintenance${tail}` });
        break;
      case 'missionFailed':
        out.push({
          ...base,
          kind: 'event',
          tone: 'critical',
          text: `Mission failed${tail}. ${text(entry.payload.summary)}`.trim(),
        });
        break;
      case 'missionCompleted':
        // The world's own sorties are in the counters; the commander's are named.
        if (entry.payload.routine !== true) {
          out.push({ ...base, kind: 'event', tone: 'ok', text: `Mission completed${tail}` });
        }
        break;
      case 'routineStoodDown':
        out.push({
          ...base,
          kind: 'event',
          tone: 'info',
          text: `Routine sortie stood down${tail}. ${text(entry.payload.reason)}`.trim(),
        });
        break;
      case 'launchDelayed':
        out.push({
          ...base,
          kind: 'event',
          tone: 'info',
          text: `Not away at its scheduled time${tail}. ${text(entry.payload.reason)}`.trim(),
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/** The commands that open and close a command day. */
const DAY_BOUNDARIES: ReadonlySet<string> = new Set(['takeCommand', 'endCommandDay']);

/** What is read from the log for a day's summary: what stands out, and the day's own bounds. */
export const DAY_LOG_TYPES: readonly string[] = [...NOTABLE_TYPES, ...DAY_BOUNDARIES];

/**
 * Of entries read between a day's first and last ticks, those that belong to the day: after the
 * command that opened it and before the one that closed it. Two days share the tick at which
 * one closes and the next opens, and the order of the log is what tells them apart.
 */
export function dayEntries(
  entries: readonly LogEntry[],
  day: { readonly startedTick: number; readonly endedTick: number | null },
): LogEntry[] {
  const opened = entries.find(
    (entry) => entry.tick === day.startedTick && DAY_BOUNDARIES.has(entry.type),
  );
  const closed =
    day.endedTick === null
      ? undefined
      : entries.find(
          (entry) =>
            entry.tick === day.endedTick &&
            entry.type === 'endCommandDay' &&
            entry.seq > (opened?.seq ?? 0),
        );
  return entries.filter(
    (entry) =>
      !DAY_BOUNDARIES.has(entry.type) &&
      entry.seq > (opened?.seq ?? 0) &&
      (closed === undefined || entry.seq < closed.seq),
  );
}

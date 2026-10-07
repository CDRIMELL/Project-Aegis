import type { MissionType } from '../mission/types';

/*
 * The career record (ADR 0031).
 *
 * A career is a run of command days. Each day holds named counters, and every counter is moved
 * by one thing only: an entry the simulation wrote to its log. Nothing here is an estimate, a
 * score or a reward. A total is the sum of a counter over the days.
 *
 * Counters are an open map, so a later system adds to the record by logging what it does and
 * adding rows to `contributions`; nothing else changes shape.
 */

/** Simulation rules for command days. Not reference data. */
export const CAREER = {
  /** A command day cannot be ended before it has run this long, in simulated seconds. */
  minDayS: 3600,
  /** How many closed days the interface is given at once. Every day is kept. */
  recentDays: 60,
} as const;

/** Counter name to count. A counter that has never moved is absent, and reads as 0. */
export type CareerCounters = Readonly<Record<string, number>>;

/** Fleet readiness over a stretch of time: the share of aircraft available or flying. */
export interface CareerReadiness {
  /** Aircraft owned, summed over every step. */
  readonly aircraftSeconds: number;
  /** Aircraft available or flying, summed over every step. */
  readonly readySeconds: number;
  /** Lowest and highest share at any step, 0 to 1; `null` before any step with a fleet. */
  readonly low: number | null;
  readonly high: number | null;
}

export const NO_READINESS: CareerReadiness = {
  aircraftSeconds: 0,
  readySeconds: 0,
  low: null,
  high: null,
};

export interface CareerDay {
  /** 1, 2, 3, ... with no gaps. */
  readonly number: number;
  readonly startedTick: number;
  /** `null` while the day is open. */
  readonly endedTick: number | null;
  readonly counters: CareerCounters;
  readonly readiness: CareerReadiness;
}

/** What the record needs to know of a mission an entry concerns. */
export interface CareerMission {
  readonly type: MissionType;
  /** Tasked and flown by the world (ADR 0030), not the commander. */
  readonly routine: boolean;
  /**
   * Public code of the aerodrome the mission was planned to end at. For a sortie flown out and
   * back that is its own base.
   */
  readonly destinationCode: string | null;
}

/** A log entry as the record reads it. */
export interface CareerEntry {
  readonly kind: 'command' | 'event';
  readonly type: string;
  readonly actor: 'player' | 'system' | 'world';
  readonly payload: Readonly<Record<string, unknown>>;
  /** The mission the entry concerns, where it concerns one the world still holds. */
  readonly mission: CareerMission | null;
}

/** UK aerodromes carry the public ICAO prefix `EG`. */
export function isUkAerodrome(code: string | null | undefined): boolean {
  return typeof code === 'string' && code.toUpperCase().startsWith('EG');
}

/** The kind of requirement a mission type answers, for the record of commitments. */
const COMMITMENT: Readonly<Record<MissionType, string>> = {
  training: 'training',
  exercise: 'training',
  logistics: 'logistics',
  transport: 'logistics',
  ferry: 'logistics',
  emergency_response: 'emergency',
  search_and_rescue: 'emergency',
  patrol: 'airspace',
  reconnaissance: 'airspace',
  intercept: 'airspace',
};

/** Player commands that commit or withdraw something: the orders the record counts. */
const ORDERS: Readonly<Record<string, string>> = {
  acceptOffer: 'orders.offersTakenUp',
  rejectOffer: 'orders.offersRejected',
  acceptMission: 'orders.missionsAccepted',
  releaseMission: 'orders.missionsReleased',
  cancelMission: 'orders.missionsCancelled',
  launchMission: 'orders.launches',
  launchFlight: 'orders.launches',
  abortMission: 'orders.aborts',
  startMaintenance: 'orders.maintenance',
  serviceAircraft: 'orders.servicing',
  stopServicing: 'orders.servicingStopped',
  acquireAircraft: 'orders.acquisitions',
  setHome: 'orders.rebasings',
};

/** Intents of a change to a flight in the air, as the record names them. */
const REVISIONS: Readonly<Record<string, string>> = {
  reroute: 'orders.reroutes',
  divert: 'orders.diversions',
  return: 'orders.returns',
  hold: 'orders.holds',
};

type Contribution = readonly [counter: string, amount: number];

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** How a mission that ended moves the record. */
function ended(outcome: 'completed' | 'failed', mission: CareerMission | null): Contribution[] {
  const out: Contribution[] = [[`missions.${outcome}`, 1]];
  if (!mission) return out;
  out.push([`missions.${outcome}.${mission.routine ? 'routine' : 'commander'}`, 1]);
  if (outcome === 'completed') {
    out.push([`commitments.${COMMITMENT[mission.type]}`, 1]);
    if (mission.destinationCode !== null) {
      out.push([
        isUkAerodrome(mission.destinationCode) ? 'commitments.uk' : 'commitments.overseas',
        1,
      ]);
    }
  }
  return out;
}

/**
 * The counters an entry moves, and by how much. An entry the record does not read moves none.
 * This table is the only place a counter is given a meaning.
 */
export function contributions(entry: CareerEntry): readonly Contribution[] {
  const { payload } = entry;
  if (entry.kind === 'command') {
    if (entry.actor !== 'player') return [];
    if (entry.type === 'reviseFlight') {
      const counter = REVISIONS[text(payload.intent) ?? ''];
      return counter
        ? [
            ['orders.total', 1],
            [counter, 1],
          ]
        : [['orders.total', 1]];
    }
    const counter = ORDERS[entry.type];
    if (!counter) return [];
    const out: Contribution[] = [
      ['orders.total', 1],
      [counter, 1],
    ];
    // A launch the commander orders starts a mission, as one the world launches does.
    if (entry.type === 'launchMission') out.push(['missions.launched', 1]);
    if (entry.type === 'abortMission') out.push(['missions.aborted', 1]);
    return out;
  }
  switch (entry.type) {
    case 'missionCompleted':
      return ended('completed', entry.mission);
    case 'missionFailed':
      return ended('failed', entry.mission);
    case 'missionLaunched':
      return [['missions.launched', 1]];
    case 'launchDelayed':
      return [['missions.delayed', 1]];
    case 'routineTasked':
      return [['routine.tasked', 1]];
    case 'routineStoodDown':
      return [['routine.stoodDown', 1]];
    case 'opportunityGenerated':
      return [['offers.received', 1]];
    case 'opportunityExpired':
      return [['offers.expired', 1]];
    case 'flightCompleted':
      return [
        ['flights.completed', 1],
        ['flights.seconds', number(payload.durationS)],
      ];
    case 'flightFuelExhausted':
      return [['aircraft.fuelExhausted', 1]];
    case 'flightHolding':
      return [['flights.held', 1]];
    case 'maintenanceDue':
      return [['aircraft.maintenanceDue', 1]];
    case 'maintenanceCompleted':
      return [['aircraft.maintained', 1]];
    case 'servicingCompleted':
      return [['services.completed', 1]];
    case 'serviceQueued':
      return [['services.queued', 1]];
    case 'eventStarted': {
      const type = text(payload.eventType);
      return type
        ? [
            ['events.total', 1],
            [`events.${type}`, 1],
          ]
        : [['events.total', 1]];
    }
    default:
      return [];
  }
}

/** Adds contributions to a set of counters. Returns the same object when nothing moves. */
export function withContributions(
  counters: CareerCounters,
  added: readonly Contribution[],
): CareerCounters {
  if (added.length === 0) return counters;
  const next: Record<string, number> = { ...counters };
  for (const [counter, amount] of added) {
    if (amount !== 0) next[counter] = (next[counter] ?? 0) + amount;
  }
  return next;
}

/** Readiness with one more step in it. `total` aircraft owned, `ready` of them available or flying. */
export function withReadinessStep(
  readiness: CareerReadiness,
  ready: number,
  total: number,
): CareerReadiness {
  if (total <= 0) return readiness;
  const share = ready / total;
  return {
    aircraftSeconds: readiness.aircraftSeconds + total,
    readySeconds: readiness.readySeconds + ready,
    low: readiness.low === null ? share : Math.min(readiness.low, share),
    high: readiness.high === null ? share : Math.max(readiness.high, share),
  };
}

/** Mean readiness over the stretch, 0 to 1; `null` when nothing is recorded. */
export function meanReadiness(readiness: CareerReadiness): number | null {
  return readiness.aircraftSeconds > 0 ? readiness.readySeconds / readiness.aircraftSeconds : null;
}

export interface CareerTotals {
  /** Command days counted. */
  readonly days: number;
  /** Simulated seconds in command. */
  readonly commandSeconds: number;
  readonly counters: CareerCounters;
  readonly readiness: CareerReadiness;
}

export const NO_TOTALS: CareerTotals = {
  days: 0,
  commandSeconds: 0,
  counters: {},
  readiness: NO_READINESS,
};

const least = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.min(a, b);
const most = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.max(a, b);

/** Totals with one more day in them. An open day counts up to `tick`. */
export function withDay(totals: CareerTotals, day: CareerDay, tick: number): CareerTotals {
  const counters: Record<string, number> = { ...totals.counters };
  for (const [counter, amount] of Object.entries(day.counters)) {
    counters[counter] = (counters[counter] ?? 0) + amount;
  }
  return {
    days: totals.days + 1,
    commandSeconds: totals.commandSeconds + ((day.endedTick ?? tick) - day.startedTick),
    counters,
    readiness: {
      aircraftSeconds: totals.readiness.aircraftSeconds + day.readiness.aircraftSeconds,
      readySeconds: totals.readiness.readySeconds + day.readiness.readySeconds,
      low: least(totals.readiness.low, day.readiness.low),
      high: most(totals.readiness.high, day.readiness.high),
    },
  };
}

/** The sum of a run of days. Open days count up to `tick`. */
export function careerTotals(days: readonly CareerDay[], tick: number): CareerTotals {
  return days.reduce((totals, day) => withDay(totals, day, tick), NO_TOTALS);
}

/** A counter's value, 0 when it has never moved. */
export function counter(counters: CareerCounters, name: string): number {
  return counters[name] ?? 0;
}

/**
 * One line on what a day was, for the career history. It is read off the day's own counters, in
 * order of what mattered most; it says nothing the counters do not.
 */
export function dayHeadline(day: CareerDay): string {
  const of = (name: string) => counter(day.counters, name);
  const completed = of('missions.completed');
  const failed = of('missions.failed');
  if (of('aircraft.fuelExhausted') > 0) return 'An aircraft ran out of fuel in flight.';
  if (of('events.severe_weather') > 0 && of('orders.diversions') >= 2) {
    return 'Severe weather. Several diversions ordered.';
  }
  if (of('events.aerodrome_closure') > 0) {
    return of('orders.diversions') + of('flights.held') > 0
      ? 'Aerodrome closure. Flights held or diverted.'
      : 'Aerodrome closure in the operating area.';
  }
  if (of('commitments.emergency') > 0) return 'Emergency requirement met.';
  if (of('aircraft.maintenanceDue') >= 3) return 'Aircraft availability under pressure.';
  if (failed >= 2 && failed >= completed) return 'A hard day: more missions failed than completed.';
  if (of('events.severe_weather') > 0) return 'Severe weather in the operating area.';
  if (failed > 0) {
    return `${completed} mission${completed === 1 ? '' : 's'} completed, ${failed} failed.`;
  }
  if (completed === 0) {
    return day.number === 1 ? 'Took command. Nothing yet completed.' : 'A quiet day.';
  }
  const stable = `${completed} mission${completed === 1 ? '' : 's'} completed.`;
  return day.number === 1 ? `Took command during stable operations. ${stable}` : stable;
}

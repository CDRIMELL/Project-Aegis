import {
  EVENT_LABEL,
  conditionsAt,
  isOpenEvent,
  isUkAerodrome,
  routineReserve,
  severityWord,
  type RoutePoint,
} from '@aegis/domain';
import { MAINTENANCE, type AircraftState, type SimView } from '@aegis/sim';
import { formatDuration } from '../format';
import { groundForecasts } from '../fleet/ground-logic';

/*
 * The Daily Operational Brief (ADR 0031): the world as it stands at one tick, read from what the
 * simulation publishes. Nothing here is decided, estimated or invented; every line is a fact of
 * the state it is given, and a world with nothing to report gets a brief that says so.
 */

export type BriefTone = 'critical' | 'warn' | 'info' | 'neutral';

export interface BriefItem {
  readonly tone: BriefTone;
  readonly title: string;
  readonly detail: string;
  /** Where in the application the thing itself is, as a route. */
  readonly route: string | null;
}

export interface DailyBrief {
  /** The command day the brief opens; `null` before command has been taken. */
  readonly day: number | null;
  /** Whether the day is already under way: the brief of a commander coming back to it. */
  readonly resuming: boolean;
  /** Simulation time, as `HH:MM`, the weekday and the date. */
  readonly time: string;
  readonly weekday: string;
  readonly date: string;
  readonly air: {
    /** Aircraft available or flying, of those owned. */
    readonly ready: number;
    readonly owned: number;
    readonly available: number;
    readonly airborne: number;
    readonly servicing: number;
    /** Due maintenance, in maintenance or unserviceable. */
    readonly unavailable: number;
    readonly activeMissions: number;
    /** Of the active missions, how many the world is flying itself. */
    readonly routineMissions: number;
    /** Missions accepted or flying to an aerodrome outside the United Kingdom. */
    readonly overseas: number;
    /** The worst weather at the aerodromes the fleet is at, in a word, and where. */
    readonly weather: string;
    readonly weatherAt: string | null;
    /** Events open in the operating area: in effect now, and announced. */
    readonly eventsActive: number;
    readonly eventsAnnounced: number;
  };
  readonly priorities: readonly BriefItem[];
  readonly watch: readonly BriefItem[];
  readonly note: string;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const place = (point: RoutePoint | null | undefined) =>
  point ? (point.code ? `${point.name} (${point.code})` : point.name) : 'an unknown place';
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
const clock = (epochMs: number, tick: number) =>
  new Date(epochMs + tick * 1000).toISOString().slice(11, 16);
const TONE_ORDER: Readonly<Record<BriefTone, number>> = {
  critical: 0,
  warn: 1,
  info: 2,
  neutral: 3,
};
const byTone = (a: BriefItem, b: BriefItem) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone];

/** Share of the hours before maintenance at which an aircraft is worth watching. */
const APPROACHING_MAINTENANCE = 0.85;
/** Condition this close above the maintenance threshold is worth watching. */
const CONDITION_MARGIN_PCT = 5;

function approachingMaintenance(aircraft: AircraftState): boolean {
  return (
    aircraft.flightSecondsSinceMaintenance >=
      MAINTENANCE.dueAfterFlightSeconds * APPROACHING_MAINTENANCE ||
    aircraft.conditionPct < MAINTENANCE.dueBelowConditionPct + CONDITION_MARGIN_PCT
  );
}

const CATEGORY_WORD: Readonly<Record<string, string>> = {
  fast_jet: 'fast jets',
  transport: 'transports',
  tanker: 'tankers',
  isr: 'ISR aircraft',
  maritime_patrol: 'maritime patrol aircraft',
  trainer: 'trainers',
  rotary: 'helicopters',
  uncrewed: 'uncrewed aircraft',
};

/** The brief for the world as `view` shows it. */
export function dailyBrief(view: SimView): DailyBrief {
  const tick = view.clock.tick;
  const instant = new Date(view.clock.simTime);
  const aircraft = view.fleet.aircraft;
  const missions = view.missions.missions;
  const committed = new Set(
    missions
      .filter((mission) => mission.status === 'accepted' || mission.status === 'active')
      .map((mission) => mission.aircraftId),
  );
  const count = (status: AircraftState['status']) =>
    aircraft.filter((each) => each.status === status).length;
  const available = count('available');
  const airborne = count('in_flight');
  const down = aircraft.filter(
    (each) =>
      each.status === 'maintenance_due' ||
      each.status === 'in_maintenance' ||
      each.status === 'unserviceable',
  );
  const active = missions.filter((mission) => mission.status === 'active');
  const underWay = missions.filter(
    (mission) => mission.status === 'active' || mission.status === 'accepted',
  );

  // Weather: the worst at any aerodrome an aircraft is at now.
  const bases = new Map<string, RoutePoint>();
  for (const each of aircraft) {
    const at = each.location ?? each.home;
    bases.set(at.refId ?? `${at.lat},${at.lon}`, at);
  }
  let worst: { point: RoutePoint; severity: number } | null = null;
  for (const point of bases.values()) {
    const { severity } = conditionsAt(view.weather, tick, point);
    if (worst === null || severity > worst.severity) worst = { point, severity };
  }

  const open = view.events.events.filter((event) => isOpenEvent(event.status));
  const activeEvents = open.filter((event) => event.status === 'active');

  const priorities: BriefItem[] = [];
  const watch: BriefItem[] = [];

  // What is waiting for the commander's answer.
  for (const mission of missions) {
    if (mission.status !== 'offered') continue;
    priorities.push({
      tone:
        mission.priority === 'urgent'
          ? 'critical'
          : mission.priority === 'priority'
            ? 'warn'
            : 'info',
      title: `${mission.priority === 'routine' ? 'Requirement' : mission.priority === 'urgent' ? 'Urgent requirement' : 'Priority requirement'}: ${mission.title}`,
      detail:
        mission.expiresTick === null
          ? 'Awaiting your answer.'
          : `Awaiting your answer. It lapses at ${clock(view.epoch, mission.expiresTick)}, in ${formatDuration(Math.max(0, mission.expiresTick - tick))}.`,
      route: `/missions/${mission.id}`,
    });
  }
  // Aircraft that will not fly until the commander acts.
  for (const each of aircraft) {
    if (each.status === 'maintenance_due' || each.status === 'unserviceable') {
      priorities.push({
        tone: each.status === 'unserviceable' ? 'critical' : 'warn',
        title: `${each.id} ${each.status === 'unserviceable' ? 'is unserviceable' : 'is due maintenance'}`,
        detail: `${each.typeName}, at ${place(each.location ?? each.home)}. It does not fly until you order maintenance.`,
        route: `/fleet/${each.id}`,
      });
    }
  }
  // The commander's own missions that have a time to keep.
  for (const mission of missions) {
    if (mission.routine || mission.status !== 'accepted') continue;
    const due = mission.completeByTick;
    priorities.push({
      tone: due !== null && due - tick < 2 * 3600 ? 'warn' : 'info',
      title: `${mission.id} accepted and not yet launched: ${mission.title}`,
      detail:
        due === null
          ? 'It launches when you order it.'
          : `It launches when you order it, and is to be complete by ${clock(view.epoch, due)}.`,
      route: `/missions/${mission.id}`,
    });
  }
  // Flights that are not going to plan.
  for (const flight of view.fleet.activeFlights) {
    if (flight.hold === 'closure' || flight.closureLanding) {
      priorities.push({
        tone: 'critical',
        title: `${flight.aircraftId} is holding: its destination is closed`,
        detail: `Bound for ${place(flight.points.at(-1))}. It holds until the aerodrome reopens, you divert it, or its fuel is down to reserve.`,
        route: `/fleet/${flight.aircraftId}`,
      });
    } else if (flight.caution) {
      priorities.push({
        tone: 'warn',
        title: `${flight.aircraftId} has a technical caution in flight`,
        detail: `Bound for ${place(flight.points.at(-1))}. It will be due maintenance when it lands.`,
        route: `/fleet/${flight.aircraftId}`,
      });
    }
  }

  // Events open or announced.
  for (const event of open) {
    const where = event.place ? place(event.place) : (event.centre?.name ?? 'the operating area');
    watch.push({
      tone: event.status === 'active' ? 'warn' : 'info',
      title: `${EVENT_LABEL[event.type]}: ${where}`,
      detail:
        event.status === 'active'
          ? `In effect until ${clock(view.epoch, event.endTick)}.`
          : `Announced. From ${clock(view.epoch, event.startTick)} to ${clock(view.epoch, event.endTick)}.`,
      route: `/overview/${event.id}`,
    });
  }
  // Weather at the fleet's aerodromes.
  if (worst && worst.severity >= 0.45) {
    watch.push({
      tone: worst.severity >= 0.75 ? 'warn' : 'info',
      title: `${severityWord(worst.severity)} weather at ${place(worst.point)}`,
      detail: 'Departures and arrivals there take longer and carry more risk while it lasts.',
      route: '/overview',
    });
  }
  // Aircraft approaching maintenance.
  const approaching = aircraft.filter(
    (each) =>
      (each.status === 'available' || each.status === 'in_flight' || each.status === 'servicing') &&
      approachingMaintenance(each),
  );
  if (approaching.length > 0) {
    watch.push({
      tone: 'info',
      title: `${plural(approaching.length, 'aircraft', 'aircraft')} approaching maintenance`,
      detail: `${approaching.map((each) => each.id).join(', ')}. Each falls due after a few more hours of flying.`,
      route: '/reports/maintenance',
    });
  }
  // Reserve: categories with fewer uncommitted, available aircraft than the world keeps back.
  const byCategory = new Map<string, AircraftState[]>();
  for (const each of aircraft) {
    byCategory.set(each.category, [...(byCategory.get(each.category) ?? []), each]);
  }
  for (const [category, owned] of [...byCategory].sort(([a], [b]) => a.localeCompare(b))) {
    const reserve = routineReserve(owned.length);
    const free = owned.filter((each) => each.status === 'available' && !committed.has(each.id));
    if (reserve > 0 && free.length < reserve) {
      watch.push({
        tone: free.length === 0 ? 'warn' : 'info',
        title: `Reduced reserve: ${CATEGORY_WORD[category] ?? category}`,
        detail: `${free.length} of ${owned.length} available and uncommitted. A new requirement for this kind of aircraft would have to wait, or take one from its task.`,
        route: '/fleet',
      });
    }
  }
  // Queues for ground resources.
  const forecasts = groundForecasts(aircraft, tick);
  const waiting = aircraft.filter((each) => {
    const forecast = forecasts.get(each.id);
    return forecast?.fuel?.state === 'waiting' || forecast?.payload?.state === 'waiting';
  });
  if (waiting.length > 0) {
    const where = [...new Set(waiting.map((each) => place(each.location)))].join(', ');
    watch.push({
      tone: 'info',
      title: `${plural(waiting.length, 'aircraft', 'aircraft')} waiting for a ground resource`,
      detail: `At ${where}. Each is served in its turn; those behind are delayed.`,
      route: '/fleet',
    });
  }

  priorities.sort(byTone);
  watch.sort(byTone);
  const urgent = priorities.filter((item) => item.tone === 'critical').length;
  const moving = airborne > 0 || underWay.length > 0;
  const note =
    urgent > 0
      ? `${plural(urgent, 'matter')} ${urgent === 1 ? 'needs' : 'need'} your decision now.${moving ? ' Routine operations continue around them.' : ''}`
      : priorities.length > 0
        ? `Nothing requires immediate intervention. ${plural(priorities.length, 'matter')} ${priorities.length === 1 ? 'is' : 'are'} waiting for you.${moving ? ' Routine operations are already underway.' : ''}`
        : moving
          ? 'Nothing currently requires immediate intervention. Routine operations are already underway.'
          : 'Nothing currently requires intervention, and nothing is flying. The operation is quiet.';

  const day = view.career.day;
  return {
    day: day?.number ?? null,
    resuming: day !== null && tick > day.startedTick,
    time: instant.toISOString().slice(11, 16),
    weekday: WEEKDAYS[instant.getUTCDay()] as string,
    date: instant.toISOString().slice(0, 10),
    air: {
      ready: available + airborne,
      owned: aircraft.length,
      available,
      airborne,
      servicing: count('servicing'),
      unavailable: down.length,
      activeMissions: active.length,
      routineMissions: active.filter((mission) => mission.routine).length,
      overseas: underWay.filter((mission) => {
        const code = mission.plan?.points.at(-1)?.code ?? mission.brief.destination?.code;
        return code !== undefined && !isUkAerodrome(code);
      }).length,
      weather: worst ? severityWord(worst.severity) : 'Not known',
      weatherAt: worst && worst.severity >= 0.2 ? place(worst.point) : null,
      eventsActive: activeEvents.length,
      eventsAnnounced: open.length - activeEvents.length,
    },
    priorities,
    watch,
    note,
  };
}

/** Simulated hours a new career has already run when command is offered (ADR 0031). */
const PRELUDE_HOURS = 6;

/**
 * How many steps a new career is run forward before command is offered: from midnight to a
 * minute between 06:00 and 06:44 that the world's seed picks. Ordinary steps, like any others.
 */
export function preludeSteps(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return PRELUDE_HOURS * 3600 + (hash % 45) * 60;
}

/** Midnight UTC of the day `wallMs` falls in: where a new career's clock begins. */
export function careerEpochMs(wallMs: number): number {
  return Math.floor(wallMs / 86_400_000) * 86_400_000;
}

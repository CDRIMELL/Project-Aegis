import type { EventType } from '../event';
import type { MissionType } from '../mission';
import {
  inPeriod,
  overlapTicks,
  periodBuckets,
  type ReportPeriod,
  type TimeBucket,
} from './period';
import type {
  AircraftCondition,
  AircraftRecord,
  EventRecord,
  FlightRecord,
  InProgressFlight,
  InProgressMission,
  MaintenanceThresholds,
  MissionRecord,
  ReportData,
} from './records';
import {
  availability,
  maintenanceVisits,
  serviceRecords,
  statusChanges,
  statusTime,
  utilisation,
  type MaintenanceVisit,
  type ServiceRecord,
  type StatusChange,
  type StatusTime,
} from './timeline';

/*
 * Reports (ADR 0024): pure functions of recorded history and a period.
 *
 * One rule decides what belongs to a period: a flight, a mission or a maintenance visit belongs to
 * the period in which it finished. An event belongs to every period it was open in.
 */

export interface ActivityTotals {
  readonly flights: number;
  readonly flightSeconds: number;
  readonly distanceM: number;
  readonly fuelUsedKg: number;
  /**
   * Flights flown exactly as they were launched: no change of route and no hold. Only these can
   * be compared with the estimate made at launch, which was for the route as launched.
   */
  readonly flightsAsLaunched: number;
  /** Fuel those flights used, and what the planner estimated for them at launch. */
  readonly fuelUsedAsLaunchedKg: number;
  readonly estimatedFuelUsedKg: number;
  readonly estimatedFlightSeconds: number;
  /**
   * What the weather cost against the same plans in still air, over the flights that recorded it.
   * `null` when none did.
   */
  readonly weatherFuelKg: number | null;
  readonly weatherDelayS: number | null;
  readonly missionsCompleted: number;
  readonly missionsFailed: number;
  readonly missionsCancelled: number;
  /** Given up by the operator after launch. */
  readonly missionsAborted: number;
  /** Flights that landed somewhere other than where they were launched to. */
  readonly flightsDiverted: number;
  /** Changes of route made in flight, over the flights that finished. */
  readonly routeRevisions: number;
  readonly heldSeconds: number;
  /** Offers that ran out of time or were turned down. */
  readonly offersLapsed: number;
  readonly maintenanceVisits: number;
  readonly maintenanceSeconds: number;
  /** Ground services finished in the period: turnarounds and preparations (ADR 0027). */
  readonly services: number;
  readonly serviceSeconds: number;
  readonly turnarounds: number;
  readonly turnaroundSeconds: number;
  /** Services that moved fuel, and the time they spent doing it, connecting included. */
  readonly refuellings: number;
  readonly refuellingSeconds: number;
  /** Fuel put aboard on the ground, and fuel taken off. */
  readonly fuelLoadedKg: number;
  readonly fuelRemovedKg: number;
  /**
   * Services that loaded a mission's fuel: launches that had to wait for their aircraft, and
   * the time that fuel took in all.
   */
  readonly missionPreparations: number;
  readonly missionPreparationSeconds: number;
  /** Time services spent handling payload, and what they put aboard and took off. */
  readonly payloadSeconds: number;
  readonly payloadLoadedKg: number;
  readonly payloadRemovedKg: number;
  /** Services that had to wait for a point at their aerodrome, and for how long in all. */
  readonly servicesQueued: number;
  readonly resourceWaitSeconds: number;
  /**
   * Missions that had a scheduled launch time and launched: how many left after it, and by how
   * much in all. A scheduled time is an intention; nothing launches by itself.
   */
  readonly launchesScheduled: number;
  readonly launchesLate: number;
  readonly launchDelaySeconds: number;
  /** Events that began in the period. */
  readonly eventsStarted: number;
}

export interface AircraftUtilisation {
  readonly aircraft: AircraftRecord;
  readonly flights: number;
  readonly flightSeconds: number;
  readonly distanceM: number;
  readonly fuelUsedKg: number;
  readonly missionsCompleted: number;
  readonly missionsFailed: number;
  /** Mean duration of the flights in the period; `null` when there were none. */
  readonly meanFlightSeconds: number | null;
  readonly maintenanceVisits: number;
  /** Ground services finished in the period, and the fuel they put aboard. */
  readonly services: number;
  readonly fuelLoadedKg: number;
  readonly time: StatusTime;
  /** 0 to 1; `null` when the period holds no recorded time for the aircraft. */
  readonly availability: number | null;
  readonly utilisation: number | null;
}

/** Ground services finished in the period at one aerodrome. */
export interface AerodromeActivity {
  /** The aerodrome's code as the log recorded it. */
  readonly at: string;
  readonly services: number;
  readonly serviceSeconds: number;
  /** Services that waited for a point there, and the time they waited. */
  readonly servicesQueued: number;
  readonly waitSeconds: number;
  readonly fuelLoadedKg: number;
  readonly payloadLoadedKg: number;
}

export interface FleetIndicators {
  readonly aircraft: number;
  /** Over all aircraft, weighted by the time each was owned in the period. */
  readonly availability: number | null;
  readonly utilisation: number | null;
  /** Aircraft that flew at least once in the period. */
  readonly aircraftFlown: number;
  readonly recordedS: number;
  readonly notRecordedS: number;
}

export const OUTLOOK_GROUPS = ['healthy', 'approaching', 'due', 'unavailable'] as const;
export type OutlookGroup = (typeof OUTLOOK_GROUPS)[number];

export interface MaintenanceOutlookRow {
  readonly aircraft: AircraftRecord;
  readonly group: OutlookGroup;
  /** Flying time left before maintenance falls due on hours; never below zero. */
  readonly secondsRemaining: number;
  /** Condition above the threshold at which maintenance falls due; never below zero. */
  readonly conditionMarginPct: number;
  readonly reason: string;
}

/** An aircraft is approaching maintenance within this share of the hours limit... */
export const APPROACHING_HOURS_FRACTION = 0.8;
/** ...or within this many points of the condition threshold. */
export const APPROACHING_CONDITION_MARGIN_PCT = 10;

export interface MissionTypeCount {
  readonly type: MissionType;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly aborted: number;
  readonly lapsed: number;
  readonly fuelUsedKg: number;
  readonly flightSeconds: number;
}

export interface EventTypeCount {
  readonly type: EventType;
  readonly events: number;
  /** Seconds the events of this type were under way within the period. */
  readonly activeSeconds: number;
  readonly meanSeverity: number;
  readonly missionsAffected: number;
}

export interface SeriesPoint extends TimeBucket {
  readonly flights: number;
  readonly flightSeconds: number;
  readonly distanceM: number;
  readonly fuelUsedKg: number;
  readonly missionsCompleted: number;
  readonly missionsFailed: number;
  readonly eventsStarted: number;
  /** Fleet availability over the bucket, 0 to 1; `null` where nothing is recorded. */
  readonly availability: number | null;
}

export interface Report {
  readonly period: ReportPeriod;
  readonly asOfTick: number;
  readonly epochMs: number;
  readonly modelVersion: number;
  readonly totals: ActivityTotals;
  readonly fleet: FleetIndicators;
  readonly aircraft: readonly AircraftUtilisation[];
  readonly outlook: readonly MaintenanceOutlookRow[];
  /** Finished in the period, by arrival then identifier. */
  readonly flights: readonly FlightRecord[];
  /** Ended in the period, by end then identifier. */
  readonly missions: readonly MissionRecord[];
  /** Completed in the period, by completion then aircraft. */
  readonly maintenance: readonly MaintenanceVisit[];
  /** Still under way at the report's moment. */
  readonly maintenanceUnderWay: readonly MaintenanceVisit[];
  /** Ground services finished in the period, by completion then aircraft. */
  readonly services: readonly ServiceRecord[];
  /** Those services by the aerodrome they were done at, by code. */
  readonly aerodromes: readonly AerodromeActivity[];
  /** Open at some moment in the period, by start then identifier. */
  readonly events: readonly EventRecord[];
  /**
   * What is under way at the report's moment, when the period reaches it. Elapsed time and fuel
   * are so far; none of it is in any total, which hold only what has finished.
   */
  readonly inProgress: {
    readonly flights: readonly InProgressFlight[];
    readonly missions: readonly InProgressMission[];
  };
  readonly missionTypes: readonly MissionTypeCount[];
  readonly eventTypes: readonly EventTypeCount[];
  readonly series: readonly SeriesPoint[];
}

const byTickThenId =
  <T extends { readonly id: string }>(tick: (item: T) => number) =>
  (a: T, b: T) =>
    tick(a) - tick(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const sum = <T>(items: readonly T[], value: (item: T) => number) =>
  items.reduce((total, item) => total + value(item), 0);

const LAPSED = new Set(['expired', 'rejected']);

/** When an event stopped being under way, for measuring it: its end, or now if it is still open. */
function eventEnd(event: EventRecord, asOfTick: number): number {
  if (event.status === 'resolved' || event.status === 'cancelled') return event.endTick;
  // A maintenance finding has no end of its own: it lasts until the aircraft is maintained.
  return Math.max(event.endTick, asOfTick + 1);
}

function eventInPeriod(event: EventRecord, period: ReportPeriod, asOfTick: number): boolean {
  if (event.status === 'cancelled') return false;
  return event.startTick < period.toTick && eventEnd(event, asOfTick) > period.fromTick;
}

/** True for a flight flown exactly as it was launched: its launch estimate still describes it. */
export function flownAsLaunched(flight: FlightRecord): boolean {
  return flight.revisions.length === 0 && flight.heldS === 0;
}

export function activityTotals(
  flights: readonly FlightRecord[],
  missions: readonly MissionRecord[],
  visits: readonly MaintenanceVisit[],
  eventsStarted: number,
  services: readonly ServiceRecord[] = [],
): ActivityTotals {
  const turnarounds = services.filter((service) => service.reason === 'turnaround');
  const refuellings = services.filter((service) => service.refuelS > 0);
  // A mission's fuel is loaded by a preparation, or follows the checks of a turnaround already
  // under way. Either way the service names the mission.
  const forMissions = services.filter((service) => service.missionId !== null);
  const queued = services.filter((service) => service.waitS > 0);
  const scheduled = missions.filter(
    (mission) => mission.plannedStartTick !== null && mission.actualStartTick !== null,
  );
  const lateness = (mission: MissionRecord) =>
    Math.max((mission.actualStartTick ?? 0) - (mission.plannedStartTick ?? 0), 0);
  const withWeather = flights.filter(
    (flight) => flight.stillAirFuelUsedKg !== null && flight.stillAirDurationS !== null,
  );
  const asLaunched = flights.filter(flownAsLaunched);
  const count = (status: string) => missions.filter((mission) => mission.status === status).length;
  return {
    flights: flights.length,
    flightSeconds: sum(flights, (flight) => flight.durationS),
    distanceM: sum(flights, (flight) => flight.distanceM),
    fuelUsedKg: sum(flights, (flight) => flight.fuelUsedKg),
    flightsAsLaunched: asLaunched.length,
    fuelUsedAsLaunchedKg: sum(asLaunched, (flight) => flight.fuelUsedKg),
    estimatedFuelUsedKg: sum(asLaunched, (flight) => flight.estimatedFuelUsedKg),
    estimatedFlightSeconds: sum(asLaunched, (flight) => flight.estimatedDurationS),
    weatherFuelKg:
      withWeather.length === 0
        ? null
        : sum(withWeather, (flight) => flight.fuelUsedKg - (flight.stillAirFuelUsedKg ?? 0)),
    weatherDelayS:
      withWeather.length === 0
        ? null
        : sum(withWeather, (flight) => flight.durationS - (flight.stillAirDurationS ?? 0)),
    missionsCompleted: count('completed'),
    missionsFailed: count('failed'),
    missionsCancelled: count('cancelled'),
    missionsAborted: count('aborted'),
    flightsDiverted: flights.filter((flight) => flight.destination !== flight.plannedDestination)
      .length,
    routeRevisions: sum(flights, (flight) => flight.revisions.length),
    heldSeconds: sum(flights, (flight) => flight.heldS),
    offersLapsed: missions.filter((mission) => LAPSED.has(mission.status)).length,
    maintenanceVisits: visits.length,
    maintenanceSeconds: sum(visits, (visit) => (visit.completedTick ?? 0) - visit.startedTick),
    services: services.length,
    serviceSeconds: sum(services, (service) => service.durationS),
    turnarounds: turnarounds.length,
    turnaroundSeconds: sum(turnarounds, (service) => service.durationS),
    refuellings: refuellings.length,
    refuellingSeconds: sum(refuellings, (service) => service.refuelS),
    fuelLoadedKg: sum(services, (service) => Math.max(service.loadedKg, 0)),
    fuelRemovedKg: sum(services, (service) => Math.max(-service.loadedKg, 0)),
    missionPreparations: forMissions.length,
    // The time the mission's fuel and payload took: all of a preparation; of a turnaround, what
    // followed its checks.
    missionPreparationSeconds: sum(forMissions, (service) =>
      service.reason === 'preparation' ? service.durationS : service.durationS - service.checksS,
    ),
    payloadSeconds: sum(services, (service) => service.loadS),
    payloadLoadedKg: sum(services, (service) => Math.max(service.payloadLoadedKg, 0)),
    payloadRemovedKg: sum(services, (service) => Math.max(-service.payloadLoadedKg, 0)),
    servicesQueued: queued.length,
    resourceWaitSeconds: sum(queued, (service) => service.waitS),
    launchesScheduled: scheduled.length,
    launchesLate: scheduled.filter((mission) => lateness(mission) > 0).length,
    launchDelaySeconds: sum(scheduled, lateness),
    eventsStarted,
  };
}

function outlookOf(
  aircraft: AircraftRecord,
  thresholds: MaintenanceThresholds,
): MaintenanceOutlookRow {
  const secondsRemaining = Math.max(
    0,
    thresholds.dueAfterFlightSeconds - aircraft.flightSecondsSinceMaintenance,
  );
  const conditionMarginPct = Math.max(0, aircraft.conditionPct - thresholds.dueBelowConditionPct);
  const base = { aircraft, secondsRemaining, conditionMarginPct };
  const status: AircraftCondition = aircraft.status;
  if (status === 'in_maintenance') {
    return { ...base, group: 'unavailable', reason: 'In maintenance.' };
  }
  if (status === 'unserviceable') {
    return { ...base, group: 'unavailable', reason: 'Unserviceable: it must be maintained.' };
  }
  if (status === 'maintenance_due') {
    return { ...base, group: 'due', reason: 'Maintenance is due: it cannot launch until done.' };
  }
  const hoursUsed = aircraft.flightSecondsSinceMaintenance / thresholds.dueAfterFlightSeconds;
  if (hoursUsed >= APPROACHING_HOURS_FRACTION) {
    return {
      ...base,
      group: 'approaching',
      reason: `Has flown ${Math.round(hoursUsed * 100)} % of the hours allowed between maintenance.`,
    };
  }
  if (conditionMarginPct < APPROACHING_CONDITION_MARGIN_PCT) {
    return {
      ...base,
      group: 'approaching',
      reason: `Condition is within ${APPROACHING_CONDITION_MARGIN_PCT} points of the maintenance threshold.`,
    };
  }
  return { ...base, group: 'healthy', reason: 'Within both maintenance limits.' };
}

/** Every aircraft in a maintenance group, most pressing first, then by identifier. */
export function maintenanceOutlook(
  aircraft: readonly AircraftRecord[],
  thresholds: MaintenanceThresholds,
): MaintenanceOutlookRow[] {
  const order: Readonly<Record<OutlookGroup, number>> = {
    unavailable: 0,
    due: 1,
    approaching: 2,
    healthy: 3,
  };
  return aircraft
    .map((each) => outlookOf(each, thresholds))
    .sort(
      (a, b) =>
        order[a.group] - order[b.group] ||
        a.secondsRemaining - b.secondsRemaining ||
        (a.aircraft.id < b.aircraft.id ? -1 : a.aircraft.id > b.aircraft.id ? 1 : 0),
    );
}

function fleetOver(
  aircraft: readonly AircraftRecord[],
  changes: ReadonlyMap<string, readonly StatusChange[]>,
  logCompleteFromTick: number,
  fromTick: number,
  toTick: number,
): StatusTime[] {
  return aircraft.map((each) =>
    statusTime(each, changes.get(each.id) ?? [], logCompleteFromTick, fromTick, toTick),
  );
}

function pooled(times: readonly StatusTime[]): {
  availability: number | null;
  utilisation: number | null;
} {
  const recordedS = sum(times, (time) => time.recordedS);
  if (recordedS <= 0) return { availability: null, utilisation: null };
  const down = sum(
    times,
    (time) =>
      time.byStatus.maintenance_due + time.byStatus.in_maintenance + time.byStatus.unserviceable,
  );
  return {
    availability: (recordedS - down) / recordedS,
    utilisation: sum(times, (time) => time.byStatus.in_flight) / recordedS,
  };
}

/**
 * The report for one period.
 *
 * `data` may hold more history than the period (for instance the period before it as well, so
 * both can be reported from one read); only what belongs to `period` is counted.
 */
export function buildReport(
  data: ReportData,
  period: ReportPeriod,
  thresholds: MaintenanceThresholds,
): Report {
  // Nothing has happened after the report's moment, whatever the period's end says.
  const untilTick = Math.min(period.toTick, data.asOfTick + 1);

  const flights = data.flights
    .filter((flight) => inPeriod(flight.arrivedTick, period))
    .sort(byTickThenId((flight) => flight.arrivedTick));
  const missions = data.missions
    .filter((mission) => inPeriod(mission.completedTick, period))
    .sort(byTickThenId((mission) => mission.completedTick));
  // An event that has been announced but has not started is not yet part of any period.
  const elapsed: ReportPeriod = { fromTick: period.fromTick, toTick: untilTick };
  const events = data.events
    .filter((event) => eventInPeriod(event, elapsed, data.asOfTick))
    .sort(byTickThenId((event) => event.startTick));

  const visits = maintenanceVisits(data.statusLog);
  const maintenance = visits.filter((visit) => inPeriod(visit.completedTick, period));
  const maintenanceUnderWay = visits.filter((visit) => visit.completedTick === null);
  const services = serviceRecords(data.statusLog).filter((service) =>
    inPeriod(service.completedTick, period),
  );

  const aerodromes: AerodromeActivity[] = [...new Set(services.map((service) => service.at))]
    .filter((at) => at !== '')
    .sort()
    .map((at) => {
      const there = services.filter((service) => service.at === at);
      const waited = there.filter((service) => service.waitS > 0);
      return {
        at,
        services: there.length,
        serviceSeconds: sum(there, (service) => service.durationS),
        servicesQueued: waited.length,
        waitSeconds: sum(waited, (service) => service.waitS),
        fuelLoadedKg: sum(there, (service) => Math.max(service.loadedKg, 0)),
        payloadLoadedKg: sum(there, (service) => Math.max(service.payloadLoadedKg, 0)),
      };
    });

  const changes = new Map<string, StatusChange[]>();
  for (const change of statusChanges(data.statusLog)) {
    const list = changes.get(change.aircraftId) ?? [];
    list.push(change);
    changes.set(change.aircraftId, list);
  }

  const flightById = new Map(flights.map((flight) => [flight.id, flight]));
  const aircraft: AircraftUtilisation[] = [...data.aircraft]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((each) => {
      const own = flights.filter((flight) => flight.aircraftId === each.id);
      const ownMissions = missions.filter((mission) => mission.aircraftId === each.id);
      const time = statusTime(
        each,
        changes.get(each.id) ?? [],
        data.logCompleteFromTick,
        period.fromTick,
        untilTick,
      );
      const flightSeconds = sum(own, (flight) => flight.durationS);
      return {
        aircraft: each,
        flights: own.length,
        flightSeconds,
        distanceM: sum(own, (flight) => flight.distanceM),
        fuelUsedKg: sum(own, (flight) => flight.fuelUsedKg),
        missionsCompleted: ownMissions.filter((mission) => mission.status === 'completed').length,
        missionsFailed: ownMissions.filter((mission) => mission.status === 'failed').length,
        meanFlightSeconds: own.length === 0 ? null : flightSeconds / own.length,
        maintenanceVisits: maintenance.filter((visit) => visit.aircraftId === each.id).length,
        services: services.filter((service) => service.aircraftId === each.id).length,
        fuelLoadedKg: sum(
          services.filter((service) => service.aircraftId === each.id),
          (service) => Math.max(service.loadedKg, 0),
        ),
        time,
        availability: availability(time),
        utilisation: utilisation(time),
      };
    });

  const times = aircraft.map((row) => row.time);
  const fleet: FleetIndicators = {
    aircraft: aircraft.length,
    ...pooled(times),
    aircraftFlown: aircraft.filter((row) => row.flights > 0).length,
    recordedS: sum(times, (time) => time.recordedS),
    notRecordedS: sum(times, (time) => time.notRecordedS),
  };

  const missionTypes: MissionTypeCount[] = [...new Set(missions.map((mission) => mission.type))]
    .sort()
    .map((type) => {
      const ofType = missions.filter((mission) => mission.type === type);
      const flown = ofType
        .map((mission) => (mission.flightId ? flightById.get(mission.flightId) : undefined))
        .filter((flight): flight is FlightRecord => flight !== undefined);
      return {
        type,
        completed: ofType.filter((mission) => mission.status === 'completed').length,
        failed: ofType.filter((mission) => mission.status === 'failed').length,
        cancelled: ofType.filter((mission) => mission.status === 'cancelled').length,
        aborted: ofType.filter((mission) => mission.status === 'aborted').length,
        lapsed: ofType.filter((mission) => LAPSED.has(mission.status)).length,
        fuelUsedKg: sum(flown, (flight) => flight.fuelUsedKg),
        flightSeconds: sum(flown, (flight) => flight.durationS),
      };
    });

  const eventTypes: EventTypeCount[] = [...new Set(events.map((event) => event.type))]
    .sort()
    .map((type) => {
      const ofType = events.filter((event) => event.type === type);
      return {
        type,
        events: ofType.length,
        activeSeconds: sum(ofType, (event) =>
          overlapTicks(
            event.startTick,
            Math.min(eventEnd(event, data.asOfTick), data.asOfTick + 1),
            period.fromTick,
            untilTick,
          ),
        ),
        meanSeverity: sum(ofType, (event) => event.severity) / ofType.length,
        missionsAffected: new Set(ofType.flatMap((event) => event.affectedMissionIds)).size,
      };
    });

  const started = (range: ReportPeriod) =>
    events.filter((event) => inPeriod(event.startTick, range)).length;

  const series: SeriesPoint[] = periodBuckets(
    { fromTick: period.fromTick, toTick: untilTick },
    data.epochMs,
  ).map((bucket) => {
    const inBucket = flights.filter((flight) => inPeriod(flight.arrivedTick, bucket));
    const ended = missions.filter((mission) => inPeriod(mission.completedTick, bucket));
    return {
      ...bucket,
      flights: inBucket.length,
      flightSeconds: sum(inBucket, (flight) => flight.durationS),
      distanceM: sum(inBucket, (flight) => flight.distanceM),
      fuelUsedKg: sum(inBucket, (flight) => flight.fuelUsedKg),
      missionsCompleted: ended.filter((mission) => mission.status === 'completed').length,
      missionsFailed: ended.filter((mission) => mission.status === 'failed').length,
      eventsStarted: started(bucket),
      availability: pooled(
        fleetOver(data.aircraft, changes, data.logCompleteFromTick, bucket.fromTick, bucket.toTick),
      ).availability,
    };
  });

  return {
    period,
    asOfTick: data.asOfTick,
    epochMs: data.epochMs,
    modelVersion: data.modelVersion,
    totals: activityTotals(flights, missions, maintenance, started(elapsed), services),
    fleet,
    aircraft,
    outlook: maintenanceOutlook(data.aircraft, thresholds),
    flights,
    missions,
    maintenance,
    maintenanceUnderWay,
    services,
    aerodromes,
    events,
    // A period that ended before the report's moment has nothing in progress: it is over.
    inProgress:
      period.toTick > data.asOfTick
        ? {
            flights: [...data.inProgressFlights].sort(
              byTickThenId((flight) => flight.departedTick),
            ),
            missions: [...data.inProgressMissions].sort(
              byTickThenId((mission) => mission.launchedTick ?? 0),
            ),
          }
        : { flights: [], missions: [] },
    missionTypes,
    eventTypes,
    series,
  };
}

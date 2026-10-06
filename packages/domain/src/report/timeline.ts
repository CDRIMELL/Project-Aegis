import { overlapTicks } from './period';
import {
  AIRCRAFT_CONDITIONS,
  type AircraftCondition,
  type AircraftRecord,
  type LogRecord,
} from './records';

/*
 * Each aircraft's status over time, rebuilt from the log (ADR 0024). The world does not store a
 * status history; the log already holds every transition, so the history is read from it.
 */

/** The log entry types this module reads. A report loads these and no others. */
export const STATUS_LOG_TYPES = [
  'launchFlight',
  'launchMission',
  'flightCompleted',
  'flightFuelExhausted',
  'maintenanceDue',
  'startMaintenance',
  'maintenanceCompleted',
  'servicingStarted',
  'servicingCompleted',
  'eventStarted',
] as const;

export interface StatusChange {
  readonly tick: number;
  readonly aircraftId: string;
  readonly status: AircraftCondition;
  /**
   * What the aircraft must have been immediately before, where the transition settles it. `null`
   * where it does not: maintenance can be started on an aircraft in more than one state.
   */
  readonly before: AircraftCondition | null;
}

function changeOf(entry: LogRecord): Pick<StatusChange, 'status' | 'before'> | null {
  switch (entry.type) {
    case 'launchFlight':
    case 'launchMission':
      return entry.kind === 'command' ? { status: 'in_flight', before: 'available' } : null;
    case 'flightCompleted':
      // What follows in the same step says what the aircraft then is: a turnaround beginning,
      // or maintenance falling due.
      return { status: 'available', before: 'in_flight' };
    case 'servicingStarted':
      // A turnaround after landing, or a preparation for a flight (ADR 0027).
      return { status: 'servicing', before: 'available' };
    case 'servicingCompleted':
      return { status: 'available', before: 'servicing' };
    case 'flightFuelExhausted':
      return { status: 'unserviceable', before: 'in_flight' };
    case 'maintenanceDue':
      return { status: 'maintenance_due', before: 'available' };
    case 'startMaintenance':
      return entry.kind === 'command' ? { status: 'in_maintenance', before: null } : null;
    case 'maintenanceCompleted':
      return { status: 'available', before: 'in_maintenance' };
    case 'eventStarted':
      // An inspection finding makes an available aircraft due maintenance (ADR 0022).
      return entry.payload.eventType === 'maintenance_finding'
        ? { status: 'maintenance_due', before: 'available' }
        : null;
    default:
      return null;
  }
}

/** The status transitions in a log, in the order they happened. */
export function statusChanges(log: readonly LogRecord[]): StatusChange[] {
  const changes: StatusChange[] = [];
  for (const entry of log) {
    if (entry.aircraftId === null) continue;
    const change = changeOf(entry);
    if (change) changes.push({ tick: entry.tick, aircraftId: entry.aircraftId, ...change });
  }
  return changes;
}

export interface MaintenanceVisit {
  readonly aircraftId: string;
  readonly startedTick: number;
  /** `null` while the aircraft is still in maintenance. */
  readonly completedTick: number | null;
}

/** Maintenance visits, each a start paired with the completion that followed it. */
export function maintenanceVisits(log: readonly LogRecord[]): MaintenanceVisit[] {
  const visits: { aircraftId: string; startedTick: number; completedTick: number | null }[] = [];
  const open = new Map<string, number>();
  for (const entry of log) {
    if (entry.aircraftId === null) continue;
    if (entry.type === 'startMaintenance' && entry.kind === 'command') {
      open.set(entry.aircraftId, visits.length);
      visits.push({ aircraftId: entry.aircraftId, startedTick: entry.tick, completedTick: null });
    } else if (entry.type === 'maintenanceCompleted') {
      const index = open.get(entry.aircraftId);
      const visit = index === undefined ? undefined : visits[index];
      if (visit) visit.completedTick = entry.tick;
      open.delete(entry.aircraftId);
    }
  }
  return visits;
}

/** One finished ground service: a turnaround after landing, or a preparation for a flight. */
export interface ServiceRecord {
  readonly aircraftId: string;
  /** The mission the aircraft was being prepared for, when a mission asked for it. */
  readonly missionId: string | null;
  readonly reason: 'turnaround' | 'preparation';
  readonly startedTick: number;
  readonly completedTick: number;
  readonly durationS: number;
  readonly checksS: number;
  /** Time in the refuelling stage, connecting included. */
  readonly refuelS: number;
  /** Fuel put aboard; negative when fuel was taken off. */
  readonly loadedKg: number;
  /** Fuel aboard when the service ended. */
  readonly fuelKg: number;
  /** Time handling payload, positioning included. */
  readonly loadS: number;
  /** Payload put aboard; negative when it was taken off. */
  readonly payloadLoadedKg: number;
  /** Time spent waiting for a fuel point or for payload handling (ADR 0028). */
  readonly waitS: number;
  /** The aerodrome it was done at, by its code; empty where the log does not say. */
  readonly at: string;
}

const numberOf = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** The ground services a log records as finished, in the order they finished (ADR 0027). */
export function serviceRecords(log: readonly LogRecord[]): ServiceRecord[] {
  const records: ServiceRecord[] = [];
  for (const entry of log) {
    if (entry.type !== 'servicingCompleted' || entry.aircraftId === null) continue;
    const durationS = numberOf(entry.payload.durationS);
    records.push({
      aircraftId: entry.aircraftId,
      missionId: entry.missionId,
      reason: entry.payload.reason === 'preparation' ? 'preparation' : 'turnaround',
      startedTick: entry.tick - durationS,
      completedTick: entry.tick,
      durationS,
      checksS: numberOf(entry.payload.checksS),
      refuelS: numberOf(entry.payload.refuelS),
      loadedKg: numberOf(entry.payload.loadedKg),
      fuelKg: numberOf(entry.payload.fuelKg),
      loadS: numberOf(entry.payload.loadS),
      payloadLoadedKg: numberOf(entry.payload.payloadLoadedKg),
      waitS: numberOf(entry.payload.waitS),
      at: typeof entry.payload.at === 'string' ? entry.payload.at : '',
    });
  }
  return records;
}

export interface StatusTime {
  /** Seconds in the window for which the status is known, by status. */
  readonly byStatus: Readonly<Record<AircraftCondition, number>>;
  readonly recordedS: number;
  /** Seconds in the window the aircraft was owned but its status is not in the log. */
  readonly notRecordedS: number;
}

const NO_TIME: Readonly<Record<AircraftCondition, number>> = {
  available: 0,
  in_flight: 0,
  servicing: 0,
  maintenance_due: 0,
  in_maintenance: 0,
  unserviceable: 0,
};

/**
 * How long one aircraft spent in each status within `[fromTick, toTick)`.
 *
 * `changes` are that aircraft's transitions in order. Before the first of them the status is
 * whatever that transition requires it to have been; with no transitions at all, the aircraft has
 * been as it is now since the log began. Nothing is assumed where the log does not settle it.
 */
export function statusTime(
  aircraft: Pick<AircraftRecord, 'acquiredTick' | 'status'>,
  changes: readonly StatusChange[],
  logCompleteFromTick: number,
  fromTick: number,
  toTick: number,
): StatusTime {
  const ownedFrom = Math.max(fromTick, aircraft.acquiredTick);
  const byStatus: Record<AircraftCondition, number> = { ...NO_TIME };
  if (toTick <= ownedFrom) return { byStatus, recordedS: 0, notRecordedS: 0 };

  const knownFrom = Math.max(aircraft.acquiredTick, logCompleteFromTick);
  const relevant = changes.filter((change) => change.tick >= knownFrom);
  const first = relevant[0];
  let status: AircraftCondition | null = first ? first.before : aircraft.status;
  let since = knownFrom;
  const add = (until: number) => {
    if (status !== null) byStatus[status] += overlapTicks(since, until, ownedFrom, toTick);
  };
  for (const change of relevant) {
    add(change.tick);
    status = change.status;
    since = change.tick;
  }
  add(toTick);

  const recordedS = AIRCRAFT_CONDITIONS.reduce((sum, each) => sum + byStatus[each], 0);
  return { byStatus, recordedS, notRecordedS: toTick - ownedFrom - recordedS };
}

/**
 * Share of recorded time, 0 to 1, the aircraft could have flown or was flying. Time being
 * serviced on the ground counts against it, as time down for maintenance does: in neither could
 * the aircraft have been launched.
 */
export function availability(time: StatusTime): number | null {
  if (time.recordedS <= 0) return null;
  const down =
    time.byStatus.maintenance_due + time.byStatus.in_maintenance + time.byStatus.unserviceable;
  return (time.recordedS - down - time.byStatus.servicing) / time.recordedS;
}

/** Share of recorded time, 0 to 1, the aircraft was airborne. */
export function utilisation(time: StatusTime): number | null {
  return time.recordedS <= 0 ? null : time.byStatus.in_flight / time.recordedS;
}

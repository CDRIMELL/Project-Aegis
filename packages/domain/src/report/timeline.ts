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
      return { status: 'available', before: 'in_flight' };
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

/** Share of recorded time, 0 to 1, the aircraft could have flown or was flying. */
export function availability(time: StatusTime): number | null {
  if (time.recordedS <= 0) return null;
  const down =
    time.byStatus.maintenance_due + time.byStatus.in_maintenance + time.byStatus.unserviceable;
  return (time.recordedS - down) / time.recordedS;
}

/** Share of recorded time, 0 to 1, the aircraft was airborne. */
export function utilisation(time: StatusTime): number | null {
  return time.recordedS <= 0 ? null : time.byStatus.in_flight / time.recordedS;
}

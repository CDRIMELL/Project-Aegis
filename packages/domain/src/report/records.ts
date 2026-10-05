import type { EventStatus, EventType } from '../event';
import type { RevisionIntent } from '../flight/revision';
import type { MissionPriority, MissionSource, MissionStatus, MissionType } from '../mission';

/*
 * What reports are computed from (ADR 0024): flat projections of rows the world already keeps.
 * Each carries the values recorded when the thing happened; nothing here is re-evaluated.
 */

export const AIRCRAFT_CONDITIONS = [
  'available',
  'in_flight',
  'maintenance_due',
  'in_maintenance',
  'unserviceable',
] as const;
export type AircraftCondition = (typeof AIRCRAFT_CONDITIONS)[number];

/** An aircraft as it is at the report's moment. */
export interface AircraftRecord {
  readonly id: string;
  readonly typeName: string;
  readonly category: string;
  readonly status: AircraftCondition;
  readonly conditionPct: number;
  readonly flightSecondsTotal: number;
  readonly flightSecondsSinceMaintenance: number;
  readonly acquiredTick: number;
  readonly home: string;
}

/** A finished flight. */
export interface FlightRecord {
  readonly id: string;
  readonly aircraftId: string;
  readonly missionId: string | null;
  readonly status: 'completed' | 'fuel_exhausted';
  readonly origin: string;
  /** Where the flight ended. */
  readonly destination: string;
  /** Where it was launched to. The same, unless the flight was diverted or turned back. */
  readonly plannedDestination: string;
  /** Each change of route made in flight, in order (ADR 0026). */
  readonly revisions: readonly RevisionIntent[];
  /** Seconds spent holding. */
  readonly heldS: number;
  /** True when it landed at a closed aerodrome with its fuel at reserve. */
  readonly landedDuringClosure: boolean;
  /** True when a technical caution showed during the flight. */
  readonly caution: boolean;
  readonly departedTick: number;
  readonly arrivedTick: number;
  readonly durationS: number;
  readonly distanceM: number;
  readonly fuelUsedKg: number;
  /** The planner's estimate at launch. */
  readonly estimatedDurationS: number;
  readonly estimatedFuelUsedKg: number;
  /** The same plan in still air; `null` for a flight from before the environment existed. */
  readonly stillAirDurationS: number | null;
  readonly stillAirFuelUsedKg: number | null;
  /** The worst weather met, 0 to 1; `null` where it was not recorded. */
  readonly worstSeverity: number | null;
}

/** A flight that is still in the air at the report's moment. Its figures are so far, not final. */
export interface InProgressFlight {
  readonly id: string;
  readonly aircraftId: string;
  readonly missionId: string | null;
  readonly origin: string;
  readonly destination: string;
  readonly plannedDestination: string;
  readonly departedTick: number;
  readonly elapsedS: number;
  readonly distanceM: number;
  readonly fuelUsedKg: number;
  readonly holding: 'operator' | 'closure' | null;
  readonly revisions: readonly RevisionIntent[];
}

/** A mission whose flight is still in the air at the report's moment. */
export interface InProgressMission {
  readonly id: string;
  readonly type: MissionType;
  readonly title: string;
  readonly aircraftId: string | null;
  readonly flightId: string | null;
  readonly launchedTick: number | null;
}

/** A mission that has ended, one way or another. */
export interface MissionRecord {
  readonly id: string;
  readonly type: MissionType;
  readonly source: MissionSource;
  readonly status: MissionStatus;
  readonly priority: MissionPriority;
  readonly title: string;
  readonly aircraftId: string | null;
  readonly flightId: string | null;
  readonly createdTick: number;
  readonly acceptedTick: number | null;
  readonly plannedStartTick: number | null;
  readonly actualStartTick: number | null;
  readonly completedTick: number;
  readonly completeByTick: number | null;
  /** Risk index, 0 to 100, as accepted. `null` when it was not recorded. */
  readonly acceptanceRisk: number | null;
  /** Risk index at launch. `null` for a mission that never launched. */
  readonly launchRisk: number | null;
  readonly objectives: number;
  readonly objectivesComplete: number;
  readonly objectivesFailed: number;
  readonly requiredObjectives: number;
  readonly requiredComplete: number;
  readonly summary: string | null;
}

export interface EventRecord {
  readonly id: string;
  readonly type: EventType;
  readonly status: EventStatus;
  readonly source: 'generated' | 'derived';
  /** 0 to 1. */
  readonly severity: number;
  readonly title: string;
  readonly where: string | null;
  readonly createdTick: number;
  readonly startTick: number;
  readonly endTick: number;
  readonly aircraftId: string | null;
  /** The opportunity the event raised, if it raised one. */
  readonly raisedMissionId: string | null;
  /** Missions the world recorded as affected by the event, in the order it noted them. */
  readonly affectedMissionIds: readonly string[];
}

/** A row of the command and event log, as far as reports read it. */
export interface LogRecord {
  readonly seq: number;
  readonly tick: number;
  readonly kind: 'command' | 'event';
  readonly type: string;
  readonly aircraftId: string | null;
  readonly missionId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Everything a report is computed from, as of one checkpoint. */
export interface ReportData {
  readonly asOfTick: number;
  readonly epochMs: number;
  readonly modelVersion: number;
  /** The log is complete from this tick. Aircraft status before it is not recorded. */
  readonly logCompleteFromTick: number;
  readonly aircraft: readonly AircraftRecord[];
  /** Finished flights, by arrival then identifier. */
  readonly flights: readonly FlightRecord[];
  /** Flights and missions under way at the report's moment. Counted in no total. */
  readonly inProgressFlights: readonly InProgressFlight[];
  readonly inProgressMissions: readonly InProgressMission[];
  /** Ended missions, by end then identifier. */
  readonly missions: readonly MissionRecord[];
  readonly events: readonly EventRecord[];
  /**
   * The log entries that change an aircraft's status, in sequence: every one in the period, and
   * before it at least the last one for each aircraft, which settles how the period began.
   */
  readonly statusLog: readonly LogRecord[];
}

export interface MaintenanceThresholds {
  readonly dueAfterFlightSeconds: number;
  readonly dueBelowConditionPct: number;
}

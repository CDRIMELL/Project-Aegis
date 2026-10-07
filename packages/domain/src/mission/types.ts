import type { FlightLoad, FlightPlan } from '../flight/plan';
import type { RoutePoint } from '../flight/route';

/*
 * Missions (ADR 0017).
 *
 * A mission is operational intent: what a flight is for and how its success is judged. It never
 * moves an aircraft; the flight does that. Everything here is simulated and abstract.
 */

/** Simulation categories. Each is a template over one common mission framework. */
export const MISSION_TYPES = [
  'training',
  'patrol',
  'reconnaissance',
  'logistics',
  'transport',
  'ferry',
  'emergency_response',
  'intercept',
  'search_and_rescue',
  'exercise',
] as const;
export type MissionType = (typeof MISSION_TYPES)[number];

export const MISSION_STATUSES = [
  /** A world-generated opportunity the player has not answered. */
  'offered',
  /** Being configured; may lack an aircraft or a route. */
  'draft',
  /** Has an aircraft, a route and a load. */
  'planned',
  /** Committed: the aircraft is assigned to it. */
  'accepted',
  /** Its flight is airborne. */
  'active',
  'completed',
  'failed',
  /** Withdrawn by the player before launch. */
  'cancelled',
  /** Given up by the player after launch. The flight goes on to land where the player chose. */
  'aborted',
  /** An opportunity the player declined. */
  'rejected',
  /** An opportunity nobody answered in time. */
  'expired',
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

/** The lifecycle. A status may move only to the statuses listed for it. */
export const MISSION_TRANSITIONS: Readonly<Record<MissionStatus, readonly MissionStatus[]>> = {
  offered: ['draft', 'rejected', 'expired'],
  draft: ['planned', 'cancelled', 'failed'],
  planned: ['draft', 'accepted', 'cancelled', 'failed'],
  accepted: ['planned', 'active', 'cancelled', 'failed'],
  active: ['completed', 'failed', 'aborted'],
  completed: [],
  failed: [],
  cancelled: [],
  aborted: [],
  rejected: [],
  expired: [],
};

export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  return MISSION_TRANSITIONS[from].includes(to);
}

/** True once nothing more can happen to a mission. */
export function isFinished(status: MissionStatus): boolean {
  return MISSION_TRANSITIONS[status].length === 0;
}

export const MISSION_PRIORITIES = ['routine', 'priority', 'urgent'] as const;
export type MissionPriority = (typeof MISSION_PRIORITIES)[number];

/** Who created the mission: the player, or the simulated world. */
export const MISSION_SOURCES = ['manual', 'generated'] as const;
export type MissionSource = (typeof MISSION_SOURCES)[number];

/** A named position that is not necessarily an aerodrome. */
export interface NamedPoint {
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
}

export const ROUTE_SHAPES = ['point_to_point', 'out_and_back', 'orbit'] as const;
/**
 * - `point_to_point`: fly to a destination aerodrome and stay.
 * - `out_and_back`: fly to a point and return to the origin, in one flight.
 * - `orbit`: fly to an area, circle it for a time, and return to the origin.
 */
export type RouteShape = (typeof ROUTE_SHAPES)[number];

/**
 * What a mission asks for, before an aircraft and a route are chosen. A template plus a brief is
 * enough to build a default route and objectives for any aircraft.
 */
export interface MissionBrief {
  readonly shape: RouteShape;
  /** `point_to_point`: the destination aerodrome. */
  readonly destination: RoutePoint | null;
  /** `out_and_back` and `orbit`: the point or the centre of the area. */
  readonly target: NamedPoint | null;
  /** `orbit`: radius of the circle flown, and how long to remain in the area. */
  readonly orbitRadiusM: number;
  readonly holdS: number;
  /** Mass to be delivered; 0 when the mission carries nothing. */
  readonly payloadKg: number;
}

export const OBJECTIVE_STATUSES = ['pending', 'complete', 'failed'] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];

/** What an objective requires. New kinds are added here and given an evaluator. */
export type ObjectiveSpec =
  /** Fly the planned route and land at its destination. */
  | { readonly kind: 'complete_flight' }
  /** Pass within `radiusM` of a point; before `byTick` when one is set. */
  | {
      readonly kind: 'visit_point';
      readonly point: NamedPoint;
      readonly radiusM: number;
      readonly byTick: number | null;
    }
  /** Spend `durationS` in total within `radiusM` of a point. */
  | {
      readonly kind: 'remain_in_area';
      readonly centre: NamedPoint;
      readonly radiusM: number;
      readonly durationS: number;
    }
  /** Land at the destination carrying at least `massKg`. */
  | { readonly kind: 'deliver_payload'; readonly massKg: number }
  /** Land back where the flight started. */
  | { readonly kind: 'return_to_base' }
  /** Land no later than `byTick`. */
  | { readonly kind: 'arrive_by'; readonly byTick: number }
  /** Land with at least the reserve fuel. */
  | { readonly kind: 'land_with_reserve' }
  /** Finish with the aircraft's condition at or above `minPct`. */
  | { readonly kind: 'maintain_condition'; readonly minPct: number };

export type ObjectiveKind = ObjectiveSpec['kind'];

export interface Objective {
  /** Unique within its mission, for example `O1`. */
  readonly id: string;
  /** Short statement of the objective as the player reads it. */
  readonly label: string;
  readonly spec: ObjectiveSpec;
  /** A mission succeeds when every required objective is complete. */
  readonly required: boolean;
  readonly status: ObjectiveStatus;
  /** 0 to 1. */
  readonly progress: number;
  /** Seconds accumulated towards a `remain_in_area` objective; 0 for other kinds. */
  readonly accumulatedS: number;
  /** Why it failed, or a remark on how it was met. */
  readonly remark: string | null;
}

export const MISSION_RESULTS = ['completed', 'failed', 'aborted'] as const;
export type MissionResult = (typeof MISSION_RESULTS)[number];

/**
 * How a mission ended. This is the extension point for later systems (reputation, readiness):
 * they read outcomes; nothing here computes them.
 */
export interface MissionOutcome {
  readonly result: MissionResult;
  readonly decidedTick: number;
  readonly summary: string;
  readonly objectivesComplete: number;
  readonly objectivesRequired: number;
  /** `null` when the mission ended without flying. */
  readonly flightDurationS: number | null;
  readonly fuelUsedKg: number | null;
}

export interface RiskContributor {
  readonly id: string;
  readonly label: string;
  /** 0 (no contribution) to 1 (as bad as this factor gets). */
  readonly value: number;
  readonly weight: number;
  /** Points this factor adds to the index. The contributors' points sum to the index. */
  readonly points: number;
  /** Why the factor has this value, in plain words with the numbers behind it. */
  readonly explanation: string;
}

/** A simulation index, not a statement about real-world operational risk. */
export interface RiskAssessment {
  /** 0 to 100. */
  readonly index: number;
  /** Highest contribution first. */
  readonly contributors: readonly RiskContributor[];
}

/**
 * The planner's figures and the risk index at one moment. A mission keeps two: what the operator
 * accepted, and what held when it actually launched. Neither is changed afterwards (ADR 0024).
 */
export interface MissionAssessment {
  readonly assessedTick: number;
  readonly distanceM: number;
  readonly durationS: number;
  readonly fuelUsedKg: number;
  readonly fuelAtDestinationKg: number;
  readonly risk: RiskAssessment;
}

export interface Mission {
  /** For example `MSN-000001`. */
  readonly id: string;
  readonly type: MissionType;
  readonly source: MissionSource;
  /**
   * Tasked and flown by the simulated world itself (ADR 0030), not by the commander, who may
   * still release, cancel or redirect it. Absent on every other mission.
   */
  readonly routine?: true;
  readonly status: MissionStatus;
  readonly priority: MissionPriority;
  readonly title: string;
  readonly description: string;
  readonly brief: MissionBrief;

  readonly aircraftId: string | null;
  /** The flight that carries the mission out; `null` until launch. */
  readonly flightId: string | null;
  readonly plan: FlightPlan | null;
  readonly load: FlightLoad | null;
  readonly objectives: readonly Objective[];
  /**
   * The figures as accepted. Never changed once recorded; cleared only if the mission is released
   * before launch. `null` for a mission accepted before these were kept: not recorded.
   */
  readonly acceptance: MissionAssessment | null;
  /**
   * The figures for the departure. From acceptance until launch they equal `acceptance`; at launch
   * they are evaluated for the actual departure time and never changed again.
   */
  readonly assessment: MissionAssessment | null;
  readonly outcome: MissionOutcome | null;

  readonly createdTick: number;
  readonly acceptedTick: number | null;
  readonly plannedStartTick: number | null;
  readonly actualStartTick: number | null;
  readonly completedTick: number | null;
  /** Generated opportunities: the tick by which the player must answer. */
  readonly expiresTick: number | null;
  /** The tick by which the mission must be finished, when it has a deadline. */
  readonly completeByTick: number | null;
}

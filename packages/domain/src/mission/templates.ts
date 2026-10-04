import type { PerformanceModel } from '../flight/performance';
import { generatePlan, type FlightPlan } from '../flight/plan';
import type { RoutePoint } from '../flight/route';
import { destinationPoint, greatCircleDistance, initialBearing } from '../geo';
import { degrees, metres } from '../units';
import type { ObjectiveInput } from './objectives';
import type { MissionBrief, MissionPriority, MissionType, RouteShape } from './types';

/*
 * Mission templates (ADR 0017).
 *
 * A mission type is data: defaults for one common framework. The player may change the aircraft,
 * route, timing and load of any mission built from one. These are simulation categories; nothing
 * is modelled beyond the flight.
 */

export interface MissionTemplate {
  readonly type: MissionType;
  readonly label: string;
  readonly description: string;
  readonly shape: RouteShape;
  /** Aircraft categories the type suits. Others are allowed, with a warning and added risk. */
  readonly suitableCategories: readonly string[];
  readonly priority: MissionPriority;
  /** The mission delivers a payload. */
  readonly carriesPayload: boolean;
  /** The mission has a deadline by default. */
  readonly timeCritical: boolean;
  /** On success the aircraft's home becomes the destination. */
  readonly rebases: boolean;
  /** Adds an optional objective to finish above the maintenance threshold. */
  readonly watchesCondition: boolean;
  /** How long to remain in the area, for an `orbit` mission. */
  readonly holdS: number;
}

const ALL_CATEGORIES = [
  'fast_jet',
  'transport',
  'tanker',
  'isr',
  'maritime_patrol',
  'trainer',
  'rotary',
  'uncrewed',
  'airliner',
  'regional_airliner',
  'business_jet',
  'freighter',
] as const;

const template = (
  type: MissionType,
  label: string,
  shape: RouteShape,
  description: string,
  suitableCategories: readonly string[],
  options: Partial<
    Pick<
      MissionTemplate,
      'priority' | 'carriesPayload' | 'timeCritical' | 'rebases' | 'watchesCondition' | 'holdS'
    >
  > = {},
): MissionTemplate => ({
  type,
  label,
  description,
  shape,
  suitableCategories,
  priority: 'routine',
  carriesPayload: false,
  timeCritical: false,
  rebases: false,
  watchesCondition: false,
  holdS: 0,
  ...options,
});

export const MISSION_TEMPLATES: Readonly<Record<MissionType, MissionTemplate>> = {
  training: template(
    'training',
    'Training',
    'out_and_back',
    'A training sortie: fly out to a turning point and return to base.',
    ALL_CATEGORIES,
    { watchesCondition: true },
  ),
  patrol: template(
    'patrol',
    'Patrol',
    'orbit',
    'Fly to an area, remain there for a set time, and return to base.',
    ['maritime_patrol', 'isr', 'fast_jet', 'uncrewed', 'rotary'],
    { holdS: 30 * 60 },
  ),
  reconnaissance: template(
    'reconnaissance',
    'Reconnaissance',
    'out_and_back',
    'Overfly a point of interest and return to base.',
    ['isr', 'uncrewed', 'maritime_patrol', 'fast_jet'],
  ),
  logistics: template(
    'logistics',
    'Logistics',
    'point_to_point',
    'Carry freight to a destination aerodrome.',
    ['transport', 'freighter', 'tanker', 'rotary'],
    { carriesPayload: true },
  ),
  transport: template(
    'transport',
    'Transport',
    'point_to_point',
    'Carry passengers or light cargo to a destination aerodrome.',
    ['transport', 'airliner', 'regional_airliner', 'business_jet', 'tanker', 'rotary'],
    { carriesPayload: true },
  ),
  ferry: template(
    'ferry',
    'Ferry / rebase',
    'point_to_point',
    'Move an aircraft to another aerodrome, which becomes its home.',
    ALL_CATEGORIES,
    { rebases: true },
  ),
  emergency_response: template(
    'emergency_response',
    'Emergency response',
    'point_to_point',
    'Deliver relief supplies to a destination aerodrome before a deadline.',
    ['transport', 'freighter', 'rotary', 'business_jet', 'tanker'],
    { carriesPayload: true, timeCritical: true, priority: 'urgent' },
  ),
  intercept: template(
    'intercept',
    'Intercept / scramble',
    'out_and_back',
    'Reach a simulated position within the response window and return to base. Abstract: only the flight is modelled.',
    ['fast_jet'],
    { timeCritical: true, priority: 'urgent' },
  ),
  search_and_rescue: template(
    'search_and_rescue',
    'Search and rescue',
    'orbit',
    'Reach a simulated search area before a deadline, search it for a set time, and return to base.',
    ['rotary', 'maritime_patrol', 'transport', 'isr', 'uncrewed'],
    { timeCritical: true, priority: 'urgent', holdS: 40 * 60 },
  ),
  exercise: template(
    'exercise',
    'Exercise',
    'orbit',
    'Take part in a scheduled exercise: hold in the exercise area for a set time and return to base.',
    ALL_CATEGORIES,
    { priority: 'priority', watchesCondition: true, holdS: 20 * 60 },
  ),
};

/** Simulation defaults for route construction. Not reference data. */
export const MISSION_GEOMETRY = {
  /** A point counts as visited within this distance. */
  visitRadiusM: 10_000,
  /** Radius of the circle flown in an orbit. */
  orbitRadiusM: 25_000,
  /** The area an orbit must stay within, as a multiple of the circle's radius. */
  areaRadiusFactor: 1.6,
  /** Waypoints per lap of an orbit. */
  orbitPointsPerLap: 6,
  maxOrbitLaps: 12,
} as const;

/** The brief a template starts from, before the player chooses where. */
export function defaultBrief(template: MissionTemplate): MissionBrief {
  return {
    shape: template.shape,
    destination: null,
    target: null,
    orbitRadiusM: MISSION_GEOMETRY.orbitRadiusM,
    holdS: template.holdS,
    payloadKg: 0,
  };
}

/** Why a brief cannot be turned into a route, or `null` if it can. */
export function briefProblem(brief: MissionBrief): string | null {
  if (!Number.isFinite(brief.payloadKg) || brief.payloadKg < 0) {
    return 'The payload cannot be negative.';
  }
  if (brief.shape === 'point_to_point') {
    return brief.destination?.kind === 'aerodrome' ? null : 'Choose a destination aerodrome.';
  }
  if (!brief.target) return 'Choose where the mission is to be flown.';
  if (brief.shape === 'orbit') {
    if (!(brief.orbitRadiusM >= 5000)) return 'The orbit radius must be at least 5 km.';
    if (!(brief.holdS > 0)) return 'The time in the area must be greater than zero.';
  }
  return null;
}

/**
 * The default route for a brief, from where the aircraft is. The player may then edit it like any
 * other flight plan. Returns `null` when the brief is incomplete.
 */
export function missionRoute(
  model: PerformanceModel,
  origin: RoutePoint,
  brief: MissionBrief,
): FlightPlan | null {
  if (briefProblem(brief) !== null) return null;
  const cruise = { cruiseAltitudeM: model.cruiseAltitudeM, cruiseSpeedKmh: model.cruiseSpeedKmh };

  if (brief.shape === 'point_to_point') {
    return generatePlan(model, origin, brief.destination as RoutePoint);
  }
  const target = brief.target as NonNullable<MissionBrief['target']>;
  const waypoint = (name: string, at: { lat: number; lon: number }): RoutePoint => ({
    kind: 'waypoint',
    name,
    lat: at.lat,
    lon: at.lon,
    elevationM: 0,
  });

  if (brief.shape === 'out_and_back') {
    return { points: [origin, waypoint(target.name, target), origin], ...cruise };
  }

  // Orbit: join the circle at the point nearest the origin, fly whole laps, and leave from there.
  const G = MISSION_GEOMETRY;
  const lapM = G.orbitPointsPerLap * brief.orbitRadiusM;
  const neededM = (brief.holdS * model.cruiseSpeedKmh) / 3.6;
  const laps = Math.min(Math.max(Math.ceil(neededM / lapM), 1), G.maxOrbitLaps);
  const entryBearing = greatCircleDistance(target, origin) < 1 ? 0 : initialBearing(target, origin);
  const points: RoutePoint[] = [origin];
  for (let i = 0; i <= laps * G.orbitPointsPerLap; i++) {
    const bearing = (entryBearing + (i * 360) / G.orbitPointsPerLap) % 360;
    points.push(
      waypoint(
        `${target.name} orbit ${i + 1}`,
        destinationPoint(target, degrees(bearing), metres(brief.orbitRadiusM)),
      ),
    );
  }
  points.push(origin);
  return { points, ...cruise };
}

const tonnes = (kgValue: number) =>
  `${(kgValue / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })} t`;

/** The objectives a template gives a brief. The player's route decides whether they are met. */
export function defaultObjectives(
  template: MissionTemplate,
  brief: MissionBrief,
  completeByTick: number | null,
  /** Condition below which maintenance falls due; used by types that watch condition. */
  maintenanceThresholdPct: number,
): ObjectiveInput[] {
  const objectives: ObjectiveInput[] = [];
  const add = (label: string, spec: ObjectiveInput['spec'], required = true) =>
    objectives.push({ label, spec, required });
  const G = MISSION_GEOMETRY;

  if (brief.shape === 'point_to_point') {
    const destination = brief.destination;
    add(`Reach ${destination?.code ?? destination?.name ?? 'the destination'}`, {
      kind: 'complete_flight',
    });
    if (brief.payloadKg > 0) {
      add(`Deliver ${tonnes(brief.payloadKg)}`, {
        kind: 'deliver_payload',
        massKg: brief.payloadKg,
      });
    }
    if (completeByTick !== null) {
      add('Land before the deadline', { kind: 'arrive_by', byTick: completeByTick });
    }
  } else if (brief.shape === 'out_and_back' && brief.target) {
    // A time-critical sortie is judged on reaching the point in time, not on when it gets home.
    const deadline = template.timeCritical ? completeByTick : null;
    add(
      deadline === null
        ? `Pass within ${G.visitRadiusM / 1000} km of ${brief.target.name}`
        : `Reach ${brief.target.name} within the response window`,
      { kind: 'visit_point', point: brief.target, radiusM: G.visitRadiusM, byTick: deadline },
    );
    add('Return to base', { kind: 'return_to_base' });
    if (completeByTick !== null && !template.timeCritical) {
      add('Land before the deadline', { kind: 'arrive_by', byTick: completeByTick });
    }
  } else if (brief.shape === 'orbit' && brief.target) {
    const areaRadiusM = brief.orbitRadiusM * G.areaRadiusFactor;
    if (template.timeCritical && completeByTick !== null) {
      add(`Reach ${brief.target.name} within the response window`, {
        kind: 'visit_point',
        point: brief.target,
        radiusM: areaRadiusM,
        byTick: completeByTick,
      });
    }
    add(`Remain in ${brief.target.name} for ${Math.round(brief.holdS / 60)} min`, {
      kind: 'remain_in_area',
      centre: brief.target,
      radiusM: areaRadiusM,
      durationS: brief.holdS,
    });
    add('Return to base', { kind: 'return_to_base' });
    if (completeByTick !== null && !template.timeCritical) {
      add('Land before the deadline', { kind: 'arrive_by', byTick: completeByTick });
    }
  }

  add('Land with reserve fuel', { kind: 'land_with_reserve' }, false);
  if (template.watchesCondition) {
    add(
      `Finish with condition at or above ${maintenanceThresholdPct} %`,
      { kind: 'maintain_condition', minPct: maintenanceThresholdPct },
      false,
    );
  }
  return objectives;
}

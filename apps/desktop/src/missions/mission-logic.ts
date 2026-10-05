import {
  MISSION_TEMPLATES,
  addMs,
  destinationPoint,
  degrees,
  evaluateMission,
  greatCircleDistance,
  metres,
  type Mission,
  type MissionBrief,
  type MissionEvaluation,
  type MissionPriority,
  type MissionStatus,
  type MissionType,
  type NamedPoint,
  type PlanContext,
  type RoutePoint,
  type SimInstant,
} from '@aegis/domain';
import {
  MAINTENANCE_POLICY,
  defaultConfiguration,
  type AircraftState,
  type ConfigurationOptions,
  type MissionConfiguration,
} from '@aegis/sim';

/*
 * Application-side mission logic: how missions are grouped, ordered and described, whether an
 * accepted mission is ready to launch, and how a form becomes a mission configuration. Pure
 * functions over plain data; the screens render what these return.
 */

/** Seconds of simulated time in one tick. */
const TICK_S = 1;

export type MissionGroup = 'offers' | 'planned' | 'active' | 'history';

export const GROUP_LABEL: Readonly<Record<MissionGroup, string>> = {
  offers: 'Offers',
  planned: 'Planned',
  active: 'Active',
  history: 'History',
};

export function groupOf(status: MissionStatus): MissionGroup {
  switch (status) {
    case 'offered':
      return 'offers';
    case 'draft':
    case 'planned':
    case 'accepted':
      return 'planned';
    case 'active':
      return 'active';
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'aborted':
    case 'rejected':
    case 'expired':
      return 'history';
  }
}

export const STATUS_LABEL: Readonly<Record<MissionStatus, string>> = {
  offered: 'Offered',
  draft: 'Draft',
  planned: 'Planned',
  accepted: 'Accepted',
  active: 'Active',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  aborted: 'Aborted',
  rejected: 'Rejected',
  expired: 'Expired',
};

export const PRIORITY_LABEL: Readonly<Record<MissionPriority, string>> = {
  routine: 'Routine',
  priority: 'Priority',
  urgent: 'Urgent',
};

const PRIORITY_RANK: Readonly<Record<MissionPriority, number>> = {
  urgent: 0,
  priority: 1,
  routine: 2,
};

export type MissionSort = 'newest' | 'priority' | 'deadline';

export interface MissionFilter {
  readonly group: MissionGroup | 'all';
  readonly type: MissionType | 'all';
  readonly sort: MissionSort;
}

/** The tick a mission next has to be acted on by: an offer's expiry, otherwise its deadline. */
export function dueTick(mission: Mission): number | null {
  return mission.status === 'offered' ? mission.expiresTick : mission.completeByTick;
}

/** Filters and orders missions for the list. Identifiers break every tie, so the order is stable. */
export function listMissions(missions: readonly Mission[], filter: MissionFilter): Mission[] {
  const newestFirst = (a: Mission, b: Mission) => b.id.localeCompare(a.id);
  const shown = missions.filter(
    (mission) =>
      (filter.group === 'all' || groupOf(mission.status) === filter.group) &&
      (filter.type === 'all' || mission.type === filter.type),
  );
  switch (filter.sort) {
    case 'newest':
      return shown.sort(newestFirst);
    case 'priority':
      return shown.sort(
        (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || newestFirst(a, b),
      );
    case 'deadline':
      // Missions with something due come first, soonest first; the rest follow, newest first.
      return shown.sort((a, b) => {
        const dueA = dueTick(a);
        const dueB = dueTick(b);
        if (dueA === null || dueB === null) {
          return dueA === dueB ? newestFirst(a, b) : dueA === null ? 1 : -1;
        }
        return dueA - dueB || newestFirst(a, b);
      });
  }
}

/** Where a mission goes: its destination, or the point or area it is flown to. */
export function missionPlace(brief: MissionBrief): string | null {
  if (brief.destination) return brief.destination.code ?? brief.destination.name;
  return brief.target?.name ?? null;
}

/** `EGHQ → EGTE`, `EGHQ → Area 3 → EGHQ`, or what is known so far. */
export function routeSummary(mission: Mission): string {
  const origin = mission.plan?.points[0];
  const place = missionPlace(mission.brief);
  const from = origin ? (origin.code ?? origin.name) : null;
  if (!place) return from ?? 'Not yet routed';
  if (!from) return `to ${place}`;
  return mission.brief.shape === 'point_to_point'
    ? `${from} → ${place}`
    : `${from} → ${place} → ${from}`;
}

/** Overall progress: the mean progress of the required objectives. */
export function missionProgress(mission: Mission): number {
  const required = mission.objectives.filter((objective) => objective.required);
  if (required.length === 0) return 0;
  return required.reduce((sum, objective) => sum + objective.progress, 0) / required.length;
}

export interface Readiness {
  readonly ready: boolean;
  /** Why the mission cannot be launched yet. Empty when it is ready. */
  readonly issues: readonly string[];
}

/**
 * Whether an accepted mission can be launched now. Derived, never stored: it depends on the
 * aircraft, which changes as the world runs (ADR 0017). The launch itself is still validated by
 * the simulation; this only tells the player what to expect.
 */
export function readiness(mission: Mission, aircraft: AircraftState | undefined): Readiness {
  const issues: string[] = [];
  if (mission.status !== 'accepted') {
    issues.push('The mission has not been accepted.');
    return { ready: false, issues };
  }
  const origin = mission.plan?.points[0];
  if (!aircraft || !origin) {
    issues.push('The mission has no aircraft or no route.');
    return { ready: false, issues };
  }
  if (aircraft.location === null) {
    issues.push(`${aircraft.id} is airborne.`);
  } else if (greatCircleDistance(aircraft.location, origin) >= 1000) {
    issues.push(
      `${aircraft.id} is at ${aircraft.location.name}; the mission starts at ${origin.name}.`,
    );
  }
  if (aircraft.status === 'maintenance_due') {
    issues.push(`${aircraft.id} is due maintenance and cannot launch until it is done.`);
  } else if (aircraft.status === 'in_maintenance') {
    issues.push(`${aircraft.id} is in maintenance.`);
  } else if (aircraft.status === 'unserviceable') {
    issues.push(`${aircraft.id} is unserviceable.`);
  }
  return { ready: issues.length === 0, issues };
}

/** Evaluates a mission as it stands now: constraints, objective forecast and risk. */
export function evaluationOf(
  mission: Mission,
  aircraft: AircraftState | undefined,
  tick: number,
  /** The world's weather and open events; `null` evaluates in still air with no events. */
  context: PlanContext | null = null,
): MissionEvaluation {
  return evaluateMission({
    type: mission.type,
    aircraft: aircraft ?? null,
    plan: mission.plan,
    load: mission.load,
    objectives: mission.objectives,
    departureTick: tick,
    completeByTick: mission.completeByTick,
    maintenance: MAINTENANCE_POLICY,
    stepS: TICK_S,
    weather: context?.weather ?? null,
    ...(context?.hazards && { hazards: context.hazards }),
  });
}

/** A mission's current configuration, in the form a command takes. */
export function configurationOf(mission: Mission): MissionConfiguration {
  return {
    title: mission.title,
    description: mission.description,
    priority: mission.priority,
    brief: mission.brief,
    aircraftId: mission.aircraftId,
    plan: mission.plan,
    load: mission.load,
    objectives: mission.objectives.map(({ label, spec, required }) => ({ label, spec, required })),
    plannedStartTick: mission.plannedStartTick,
    completeByTick: mission.completeByTick,
  };
}

/** The simulated instant of a tick. */
export function tickInstant(epoch: SimInstant, tick: number): SimInstant {
  return addMs(epoch, tick * TICK_S * 1000);
}

/** What the mission form holds. Times are hours from now; 0 means none. */
export interface MissionFormValues {
  readonly type: MissionType;
  readonly title: string;
  readonly priority: MissionPriority;
  readonly aircraftId: string | null;
  readonly destination: RoutePoint | null;
  readonly target: NamedPoint | null;
  readonly payloadKg: number;
  readonly holdMinutes: number;
  readonly orbitRadiusKm: number;
  readonly startInHours: number;
  readonly deadlineInHours: number;
}

/** How far from the origin a suggested turning point or area is placed. */
const SUGGESTED_DISTANCE_M = 150_000;

/**
 * A place to fly to when the player has not chosen one: due north of the origin, at a modest
 * distance the aircraft can certainly reach. It is a starting point to edit, nothing more.
 */
export function suggestedTarget(
  type: MissionType,
  origin: RoutePoint,
  rangeKm: number,
): NamedPoint {
  const distanceM = Math.min(SUGGESTED_DISTANCE_M, rangeKm * 1000 * 0.15);
  const at = destinationPoint(origin, degrees(0), metres(distanceM));
  const template = MISSION_TEMPLATES[type];
  return {
    name: template.shape === 'orbit' ? `${template.label} area` : `${template.label} point`,
    lat: Math.round(at.lat * 10_000) / 10_000,
    lon: Math.round(at.lon * 10_000) / 10_000,
  };
}

export function briefFromForm(values: MissionFormValues): MissionBrief {
  const template = MISSION_TEMPLATES[values.type];
  return {
    shape: template.shape,
    destination: template.shape === 'point_to_point' ? values.destination : null,
    target: template.shape === 'point_to_point' ? null : values.target,
    orbitRadiusM: values.orbitRadiusKm * 1000,
    holdS: template.shape === 'orbit' ? values.holdMinutes * 60 : 0,
    payloadKg: template.carriesPayload ? values.payloadKg : 0,
  };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Turns the form into a mission configuration. A route the player has already edited is kept as
 * long as the aircraft and the brief are unchanged; otherwise the template routes the mission
 * afresh from where the aircraft is.
 */
export function configurationFromForm(
  values: MissionFormValues,
  aircraft: AircraftState | null,
  tick: number,
  existing: Mission | null,
  context: PlanContext | null = null,
): MissionConfiguration {
  const brief = briefFromForm(values);
  const hoursFromNow = (hours: number) => (hours > 0 ? tick + Math.round(hours * 3600) : null);
  const options: ConfigurationOptions = {
    priority: values.priority,
    plannedStartTick:
      values.startInHours > 0
        ? hoursFromNow(values.startInHours)
        : (existing?.plannedStartTick ?? null),
    completeByTick:
      values.deadlineInHours > 0
        ? hoursFromNow(values.deadlineInHours)
        : (existing?.completeByTick ?? null),
    ...(values.title.trim().length > 0 && { title: values.title.trim() }),
    ...(existing && { description: existing.description }),
    context,
  };
  const configuration = defaultConfiguration(values.type, brief, aircraft, options);
  const routeStillFits =
    existing?.plan != null &&
    existing.aircraftId === (aircraft?.id ?? null) &&
    sameJson(existing.brief, brief) &&
    aircraft?.location != null &&
    greatCircleDistance(aircraft.location, existing.plan.points[0] as RoutePoint) < 1000;
  return routeStillFits
    ? { ...configuration, plan: existing.plan, load: existing.load }
    : configuration;
}

/** The form for an existing mission, or a blank one for a type. */
export function formFromMission(mission: Mission): MissionFormValues {
  return {
    type: mission.type,
    title: mission.title,
    priority: mission.priority,
    aircraftId: mission.aircraftId,
    destination: mission.brief.destination,
    target: mission.brief.target,
    payloadKg: mission.brief.payloadKg,
    holdMinutes: Math.round(mission.brief.holdS / 60),
    orbitRadiusKm: mission.brief.orbitRadiusM / 1000,
    startInHours: 0,
    deadlineInHours: 0,
  };
}

export function blankForm(type: MissionType): MissionFormValues {
  const template = MISSION_TEMPLATES[type];
  return {
    type,
    title: '',
    priority: template.priority,
    aircraftId: null,
    destination: null,
    target: null,
    payloadKg: 0,
    holdMinutes: Math.round(template.holdS / 60),
    orbitRadiusKm: 25,
    startInHours: 0,
    deadlineInHours: 0,
  };
}

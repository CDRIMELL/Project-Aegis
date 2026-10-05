import {
  evaluatePlan,
  generatePlan,
  intermediatePoint,
  offeredFuelKg,
  type FlightLoad,
  type FlightPlan,
  type PerformanceModel,
  type PlanContext,
  type PlanEvaluation,
  type RoutePoint,
} from '@aegis/domain';

/*
 * Editing a draft flight plan. Pure functions over plain data: the map and the planning panel
 * both call these on the same draft, which is what keeps them in step.
 */

export interface PlanDraft {
  readonly aircraftId: string;
  readonly plan: FlightPlan;
  readonly load: FlightLoad;
}

/**
 * Fuel to load by default: enough to arrive with the reserve, with a contingency for leaving
 * later than now, or full tanks if that cannot be met.
 */
function defaultFuel(
  model: PerformanceModel,
  plan: FlightPlan,
  payloadKg: number,
  context: PlanContext | null,
): number {
  const byMass = model.maxTakeoffMassKg - model.emptyMassKg - payloadKg;
  return (
    offeredFuelKg(model, plan, payloadKg, context) ??
    Math.max(Math.min(model.fuelCapacityKg, byMass), 0)
  );
}

/** The first plan offered: direct, at the type's cruise altitude and speed, fuelled for the trip. */
export function generateDraft(
  aircraftId: string,
  model: PerformanceModel,
  origin: RoutePoint,
  destination: RoutePoint,
  payloadKg: number,
  /** The world the flight would leave in; `null` plans in still air. */
  context: PlanContext | null = null,
): PlanDraft {
  const plan = generatePlan(model, origin, destination);
  return {
    aircraftId,
    plan,
    load: { fuelKg: defaultFuel(model, plan, payloadKg, context), payloadKg },
  };
}

const withPoints = (draft: PlanDraft, points: RoutePoint[]): PlanDraft => ({
  ...draft,
  plan: { ...draft.plan, points },
});

/** True for the positions that can be edited: everything except the origin and destination. */
export function isEditablePoint(draft: PlanDraft, index: number): boolean {
  return index > 0 && index < draft.plan.points.length - 1;
}

function clampLat(lat: number): number {
  return Math.min(Math.max(lat, -85), 85);
}

function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** A waypoint the planner named itself, as opposed to one a mission named. */
const GENERIC_WAYPOINT = /^WP\d*$/;

/**
 * Renames the planner's own waypoints WP1, WP2, ... in route order, so their names always match
 * their positions. A waypoint with a name of its own (a mission's turning point, an orbit point)
 * keeps it.
 */
function renumber(points: readonly RoutePoint[]): RoutePoint[] {
  let n = 0;
  return points.map((point) =>
    point.kind === 'waypoint' && GENERIC_WAYPOINT.test(point.name)
      ? { ...point, name: `WP${++n}` }
      : point,
  );
}

/** Moves a waypoint. The origin and destination are aerodromes and cannot be moved. */
export function moveWaypoint(draft: PlanDraft, index: number, lat: number, lon: number): PlanDraft {
  if (!isEditablePoint(draft, index) || !Number.isFinite(lat) || !Number.isFinite(lon))
    return draft;
  const points = draft.plan.points.map((point, i) =>
    i === index ? { ...point, lat: clampLat(lat), lon: wrapLon(lon) } : point,
  );
  return withPoints(draft, points);
}

/** Inserts a waypoint after `afterIndex`, at the given position or else midway along that leg. */
export function insertWaypoint(
  draft: PlanDraft,
  afterIndex: number,
  position?: { readonly lat: number; readonly lon: number },
): PlanDraft {
  const from = draft.plan.points[afterIndex];
  const to = draft.plan.points[afterIndex + 1];
  if (!from || !to) return draft;
  const at = position ?? intermediatePoint(from, to, 0.5);
  const waypoint: RoutePoint = {
    kind: 'waypoint',
    name: 'WP',
    lat: clampLat(at.lat),
    lon: wrapLon(at.lon),
    elevationM: 0,
  };
  const points = [...draft.plan.points];
  points.splice(afterIndex + 1, 0, waypoint);
  return withPoints(draft, renumber(points));
}

export function removeWaypoint(draft: PlanDraft, index: number): PlanDraft {
  if (!isEditablePoint(draft, index)) return draft;
  return withPoints(draft, renumber(draft.plan.points.filter((_, i) => i !== index)));
}

/** Swaps a waypoint with its neighbour. Waypoints cannot pass the origin or destination. */
export function shiftWaypoint(draft: PlanDraft, index: number, direction: -1 | 1): PlanDraft {
  const target = index + direction;
  if (!isEditablePoint(draft, index) || !isEditablePoint(draft, target)) return draft;
  const points = [...draft.plan.points];
  const moved = points[index] as RoutePoint;
  points[index] = points[target] as RoutePoint;
  points[target] = moved;
  return withPoints(draft, renumber(points));
}

export function setCruiseAltitude(draft: PlanDraft, cruiseAltitudeM: number): PlanDraft {
  return { ...draft, plan: { ...draft.plan, cruiseAltitudeM } };
}

export function setCruiseSpeed(draft: PlanDraft, cruiseSpeedKmh: number): PlanDraft {
  return { ...draft, plan: { ...draft.plan, cruiseSpeedKmh } };
}

export function setLoad(draft: PlanDraft, load: Partial<FlightLoad>): PlanDraft {
  return { ...draft, load: { ...draft.load, ...load } };
}

/** Sets the fuel load to what the current route needs, with reserve. */
export function refuelForRoute(
  draft: PlanDraft,
  model: PerformanceModel,
  context: PlanContext | null = null,
): PlanDraft {
  return setLoad(draft, {
    fuelKg: defaultFuel(model, draft.plan, draft.load.payloadKg, context),
  });
}

/**
 * Evaluates a draft in the world it would be flown in: the same weather and events a launch is
 * checked against. With no context the draft is evaluated in still air.
 */
export function evaluateDraft(
  draft: PlanDraft,
  model: PerformanceModel,
  context: PlanContext | null = null,
): PlanEvaluation {
  return evaluatePlan(model, draft.plan, draft.load, context);
}

import {
  advanceInWeather,
  type ClosureWindow,
  type WeatherContext,
} from '../environment/flight-weather';
import { conditionsAt, type Conditions, type WeatherModel } from '../environment/weather';
import {
  NO_HAZARDS,
  disruptionsOnRoute,
  sameAerodrome,
  type Disruption,
  type Hazards,
} from '../event/events';
import { greatCircleDistance } from '../geo';
import { groupThousands } from '../math';
import type { PerformanceModel } from './performance';
import { PLANNING_STEP_S, flightProfile, type Constraint, type FlightPlan } from './plan';
import { descentDistanceM, flyOn, type FlightProgress } from './profile';
import { positionAlong, routeGeometry, routeProblems, type RoutePoint } from './route';

/*
 * Changing the route of a flight that is already airborne (ADR 0026).
 *
 * There is one route system. A revised flight still has one `FlightPlan`: the points it has
 * already passed, a waypoint where it was when the route changed, and the new remainder. The same
 * geometry, the same flight step and the same weather sampling read it as they read any plan.
 * What has been flown is never rewritten.
 */

export const REVISION_INTENTS = ['reroute', 'divert', 'return'] as const;
/** Why the operator changed the route. It is recorded; the mechanics are the same for all. */
export type RevisionIntent = (typeof REVISION_INTENTS)[number];

/** One change of route, as it is kept in the flight's history. */
export interface FlightRevision {
  readonly tick: number;
  readonly intent: RevisionIntent;
  /** Where the aircraft was. */
  readonly position: RoutePoint;
  /** Distance flown along the route, in metres, when it changed. */
  readonly atDistanceM: number;
  readonly fuelKg: number;
  /** The rest of the route as it was: what the revision replaced. */
  readonly replaced: readonly RoutePoint[];
}

/** What is needed of a flight to estimate or change the rest of it. */
export interface FlightSituation {
  readonly plan: FlightPlan;
  readonly progress: FlightProgress;
  readonly payloadKg: number;
  readonly departedTick: number;
}

/** The world the rest of a flight is flown in. */
export interface RevisionContext {
  readonly weather: WeatherModel;
  readonly hazards?: Hazards;
}

/** The points of a plan the aircraft has not yet passed, ending with the destination. */
export function remainingPoints(plan: FlightPlan, distanceM: number): RoutePoint[] {
  const route = routeGeometry(plan.points);
  return plan.points.slice(positionAlong(route, distanceM).legIndex + 1);
}

const samePoint = (a: RoutePoint, b: RoutePoint) =>
  a.kind === b.kind &&
  a.lat === b.lat &&
  a.lon === b.lon &&
  a.elevationM === b.elevationM &&
  a.name === b.name &&
  a.refId === b.refId;

/** True when a proposed remainder is the remainder the flight already has. */
export function sameRemainder(
  plan: FlightPlan,
  distanceM: number,
  remainder: readonly RoutePoint[],
): boolean {
  const current = remainingPoints(plan, distanceM);
  return (
    current.length === remainder.length &&
    current.every((point, index) => samePoint(point, remainder[index] as RoutePoint))
  );
}

export interface RevisedRoute {
  /** The whole route: flown prefix, the revision point, the new remainder. */
  readonly plan: FlightPlan;
  /** Distance flown, measured along the revised route. */
  readonly distanceM: number;
  readonly position: RoutePoint;
  readonly replaced: readonly RoutePoint[];
}

/** Closer than this to the last point passed, no revision point is added: it would be a duplicate. */
const AT_A_POINT_M = 1;

/**
 * Rewrites a plan from the aircraft's present position. `label` names the waypoint that marks
 * where the route changed.
 */
export function reviseRoute(
  plan: FlightPlan,
  distanceM: number,
  remainder: readonly RoutePoint[],
  label: string,
): RevisedRoute {
  const route = routeGeometry(plan.points);
  const at = positionAlong(route, distanceM);
  const passed = plan.points.slice(0, at.legIndex + 1);
  const replaced = plan.points.slice(at.legIndex + 1);
  const position: RoutePoint = {
    kind: 'waypoint',
    name: label,
    lat: at.lat,
    lon: at.lon,
    elevationM: 0,
  };
  const lastPassed = passed.at(-1) as RoutePoint;
  const atLastPassed = greatCircleDistance(lastPassed, position) < AT_A_POINT_M;
  const prefix = atLastPassed ? passed : [...passed, position];
  const points = [...prefix, ...remainder];
  // Distance flown is re-measured along the revised route, so that the aircraft is exactly at
  // the end of its prefix and not a rounding error to one side of it.
  const flown = routeGeometry(prefix).totalM;
  return { plan: { ...plan, points }, distanceM: flown, position, replaced };
}

/** Known closures of one aerodrome, as the flight step takes them. */
export function closuresOf(hazards: Hazards, destination: RoutePoint): ClosureWindow[] {
  return hazards.closures
    .filter((closure) => sameAerodrome(closure.place, destination))
    .map(({ startTick, endTick }) => ({ startTick, endTick }));
}

/** What the rest of a flight comes to if it is flown from here. */
export interface FlightProjection {
  readonly destination: RoutePoint;
  /** Distance still to fly along the route. */
  readonly remainingM: number;
  readonly arrivalTick: number;
  readonly remainingS: number;
  readonly landingFuelKg: number;
  /** Fuel the rest of the flight uses. */
  readonly fuelToGoKg: number;
  /** False when the fuel on board runs out first. */
  readonly completes: boolean;
  /** How far short of the destination the fuel runs out; 0 when the flight completes. */
  readonly shortM: number;
  /** Seconds the aircraft would hold for a closed destination on the way. */
  readonly holdS: number;
  /** True when it would land during a closure, its fuel down to reserve. */
  readonly landsDuringClosure: boolean;
  readonly worstSeverity: number;
  /** Surface conditions at the destination on arrival. */
  readonly arrival: Conditions;
  readonly disruptions: readonly Disruption[];
}

function project(
  model: PerformanceModel,
  plan: FlightPlan,
  progress: FlightProgress,
  payloadKg: number,
  departedTick: number,
  context: RevisionContext,
): FlightProjection {
  const route = routeGeometry(plan.points);
  const profile = flightProfile(model, plan, payloadKg);
  const destination = plan.points.at(-1) as RoutePoint;
  const hazards = context.hazards ?? NO_HAZARDS;
  const world: WeatherContext = {
    weather: context.weather,
    route,
    departureTick: departedTick,
    closures: closuresOf(hazards, destination),
  };
  const end = flyOn(progress, PLANNING_STEP_S, (current) =>
    advanceInWeather(profile, current, PLANNING_STEP_S, world),
  );
  const nowTick = departedTick + progress.elapsedS;
  const arrivalTick = departedTick + end.elapsedS;
  const completes = end.phase === 'landed';
  return {
    destination,
    remainingM: route.totalM - progress.distanceM,
    arrivalTick,
    remainingS: end.elapsedS - progress.elapsedS,
    landingFuelKg: end.fuelKg,
    fuelToGoKg: progress.fuelKg - end.fuelKg,
    completes,
    shortM: completes ? 0 : route.totalM - end.distanceM,
    holdS: end.heldS - progress.heldS,
    landsDuringClosure: end.closureLanding,
    worstSeverity: end.exposure.worstSeverity,
    arrival: conditionsAt(context.weather, arrivalTick, destination, 0),
    disruptions: disruptionsOnRoute(
      hazards,
      [positionAlong(route, progress.distanceM), ...remainingPoints(plan, progress.distanceM)],
      nowTick,
      arrivalTick,
    ),
  };
}

/**
 * The rest of a flight as it stands: where it will land, when, and with how much fuel. Flown with
 * the simulation's own step from the flight's present state, so it is what will happen unless
 * something changes.
 */
export function projectFlight(
  model: PerformanceModel,
  flight: FlightSituation,
  context: RevisionContext,
): FlightProjection {
  return project(
    model,
    flight.plan,
    flight.progress,
    flight.payloadKg,
    flight.departedTick,
    context,
  );
}

export interface RevisionEvaluation {
  /** `null` when the proposed route cannot be made into a route at all. */
  readonly revised: RevisedRoute | null;
  /** The flight's progress as it would be the moment the revision took effect. */
  readonly progress: FlightProgress | null;
  readonly projection: FlightProjection | null;
  readonly constraints: readonly Constraint[];
  readonly flyable: boolean;
  /** True when the proposal is the route the flight already has: there is nothing to change. */
  readonly unchanged: boolean;
}

const km = (metres: number) => `${groupThousands(metres / 1000)} km`;
const kg = (value: number) => `${groupThousands(value)} kg`;
const minutes = (seconds: number) => `${Math.max(1, Math.round(seconds / 60))} min`;

/** A flight's progress as a revision leaves it: on the new route, no longer holding or descending. */
export function progressAfterRevision(progress: FlightProgress, distanceM: number): FlightProgress {
  return {
    ...progress,
    distanceM,
    // The descent was to somewhere the aircraft is no longer going. The step decides afresh
    // whether to climb, cruise or descend, and a climb costs what a climb costs.
    phase: progress.phase === 'descent' ? 'cruise' : progress.phase,
    hold: null,
    closureLanding: false,
  };
}

/**
 * Checks a proposed remainder for an airborne flight and estimates the result by flying it, with
 * the same constraint severities as a plan (`block`, `warning`, `note`).
 */
export function evaluateRevision(
  model: PerformanceModel,
  flight: FlightSituation,
  remainder: readonly RoutePoint[],
  context: RevisionContext,
  label = 'Route changed here',
): RevisionEvaluation {
  const constraints: Constraint[] = [];
  const block = (code: string, message: string) =>
    constraints.push({ severity: 'block', code, message });
  const warn = (code: string, message: string) =>
    constraints.push({ severity: 'warning', code, message });
  const note = (code: string, message: string) =>
    constraints.push({ severity: 'note', code, message });
  const refused = (): RevisionEvaluation => ({
    revised: null,
    progress: null,
    projection: null,
    constraints,
    flyable: false,
    unchanged: false,
  });

  const { progress, plan } = flight;
  if (progress.phase === 'landed' || progress.fuelExhausted) {
    block('flight_over', 'The flight is over; its route can no longer be changed.');
    return refused();
  }
  if (progress.phase === 'takeoff') {
    block(
      'on_takeoff_roll',
      'The aircraft is still on its take-off roll. The route can be changed once it is airborne.',
    );
    return refused();
  }
  if (remainder.length === 0) {
    block('invalid_route', 'The new route needs a destination.');
    return refused();
  }
  const unchanged = sameRemainder(plan, progress.distanceM, remainder);
  const revised = reviseRoute(plan, progress.distanceM, remainder, label);
  for (const problem of routeProblems(revised.plan.points)) block('invalid_route', problem);
  if (constraints.length > 0) return { ...refused(), revised: null };

  const destination = revised.plan.points.at(-1) as RoutePoint;
  if (plan.cruiseAltitudeM <= destination.elevationM + 100) {
    block(
      'altitude_below_terrain',
      `The cruise altitude is not clear of ${destination.name}, which stands at ${groupThousands(destination.elevationM)} m.`,
    );
  }
  const after = progressAfterRevision(progress, revised.distanceM);
  const profile = flightProfile(model, revised.plan, flight.payloadKg);
  // The flight model descends along the route. Somewhere nearer than a descent from the present
  // altitude needs cannot be descended to; a waypoint that lengthens the route makes it possible.
  const needM = descentDistanceM(profile, after);
  const haveM = profile.totalDistanceM - after.distanceM;
  if (!unchanged && haveM < needM) {
    block(
      'too_close_to_descend',
      `${destination.name} is ${km(haveM)} away by this route, and a descent from the present altitude needs ${km(needM)}. Add a waypoint to lengthen the route, or choose somewhere farther.`,
    );
  }
  if (constraints.some((constraint) => constraint.severity === 'block')) {
    return { revised, progress: after, projection: null, constraints, flyable: false, unchanged };
  }

  const projection = project(
    model,
    revised.plan,
    after,
    flight.payloadKg,
    flight.departedTick,
    context,
  );
  if (!projection.completes) {
    block(
      'insufficient_fuel',
      `Fuel runs out ${km(projection.shortM)} short of ${destination.name}. Choose somewhere nearer, or a shorter route.`,
    );
  } else {
    if (projection.landsDuringClosure) {
      warn(
        'lands_during_closure',
        `${destination.name} is closed. The aircraft would hold for ${minutes(projection.holdS)} and then land during the closure with its fuel at reserve.`,
      );
    } else if (projection.holdS > 0) {
      warn(
        'holds_for_closure',
        `${destination.name} will be closed on arrival. The aircraft would hold for ${minutes(projection.holdS)} until it reopens.`,
      );
    }
    if (projection.landingFuelKg < model.reserveFuelKg) {
      warn(
        'below_reserve',
        `Lands with ${kg(projection.landingFuelKg)}, below the assumed reserve of ${kg(model.reserveFuelKg)}.`,
      );
    }
    for (const disruption of projection.disruptions) {
      warn(
        disruption.type === 'severe_weather' ? 'severe_weather_area' : 'navigation_disruption',
        disruption.type === 'severe_weather'
          ? `The route passes through a severe weather area (${disruption.eventId}).`
          : `The route passes through an area of disrupted navigation (${disruption.eventId}).`,
      );
    }
    if (projection.worstSeverity >= 0.75) {
      warn('severe_weather_on_route', 'The route passes through severe weather.');
    }
    if (projection.arrival.visibilityKm < 3) {
      warn(
        'low_visibility_at_destination',
        `Visibility at ${destination.name} is forecast to be ${projection.arrival.visibilityKm.toFixed(1)} km on arrival.`,
      );
    }
    if (unchanged) note('unchanged', 'This is the route the aircraft is already flying.');
  }
  return {
    revised,
    progress: after,
    projection,
    constraints,
    flyable: !constraints.some((constraint) => constraint.severity === 'block'),
    unchanged,
  };
}

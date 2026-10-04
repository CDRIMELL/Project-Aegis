import { groupThousands } from '../math';
import { FLIGHT_ASSUMPTIONS, grossMassKg, type PerformanceModel } from './performance';
import { advanceInWeather, type WeatherContext } from '../environment/flight-weather';
import { conditionsAt, type Conditions, type WeatherModel } from '../environment/weather';
import {
  NO_HAZARDS,
  closureAt,
  disruptionsOnRoute,
  type Disruption,
  type Hazards,
} from '../event/events';
import { flyToCompletion, type FlightProfile, type FlightProgress } from './profile';
import { directRoute, routeGeometry, routeProblems, type RoutePoint } from './route';

/** What the player approves and the simulation then flies. Plain data; persisted with the flight. */
export interface FlightPlan {
  /** Origin aerodrome, any free waypoints, destination aerodrome. */
  readonly points: readonly RoutePoint[];
  readonly cruiseAltitudeM: number;
  readonly cruiseSpeedKmh: number;
}

/** Fuel and payload on board at departure. */
export interface FlightLoad {
  readonly fuelKg: number;
  readonly payloadKg: number;
}

export type ConstraintSeverity = 'block' | 'warning' | 'note';

/**
 * - `block`: the flight cannot be flown as planned.
 * - `warning`: outside the normal envelope; allowed.
 * - `note`: a poor but legitimate choice, or a limit that could not be checked; allowed.
 */
export interface Constraint {
  readonly severity: ConstraintSeverity;
  readonly code: string;
  readonly message: string;
}

export interface PlanEstimate {
  readonly distanceM: number;
  readonly durationS: number;
  readonly fuelUsedKg: number;
  readonly fuelAtDestinationKg: number;
  readonly takeoffMassKg: number;
  /** Highest altitude the flight reaches; lower than planned on a route too short to get there. */
  readonly topAltitudeM: number;
  /** False when the fuel on board runs out before the destination. */
  readonly completes: boolean;
  /** How far the aircraft gets. Equals `distanceM` when the flight completes. */
  readonly reachedM: number;
  readonly legs: readonly { readonly distanceM: number; readonly bearingDeg: number }[];
  /** `null` when the plan was evaluated in still air. */
  readonly weather: WeatherImpact | null;
  /** Disrupted areas the flight would pass through while they are in force. */
  readonly disruptions: readonly Disruption[];
}

/**
 * The world a plan is evaluated in: its weather, and when the flight would depart. With no
 * context a plan is evaluated in still air, as it was before the environment existed.
 */
export interface PlanContext {
  readonly weather: WeatherModel;
  /** The tick the flight would depart. The weather it meets depends on it. */
  readonly departureTick: number;
  /** Closed aerodromes and disrupted areas that are announced or under way. */
  readonly hazards?: Hazards;
}

/** What the weather does to a plan, against the same plan flown in still air. */
export interface WeatherImpact {
  readonly stillAirDurationS: number;
  readonly stillAirFuelUsedKg: number;
  /** Mean wind along the track over the flight, km/h. Positive is a tailwind. */
  readonly meanTailwindKmh: number;
  readonly worstSeverity: number;
  readonly lowestVisibilityKm: number;
  readonly heaviestPrecipitation: number;
  /** Surface conditions at the origin when the flight departs. */
  readonly departure: Conditions;
  /** Surface conditions at the destination when the flight arrives. */
  readonly arrival: Conditions;
}

export interface PlanEvaluation {
  /** `null` when the route itself is invalid and nothing can be estimated. */
  readonly estimate: PlanEstimate | null;
  readonly constraints: readonly Constraint[];
  /** True when no constraint blocks the flight. */
  readonly flyable: boolean;
}

/** The step the planner integrates with. Must equal the simulation step for estimates to match. */
export const PLANNING_STEP_S = 1;

export function flightProfile(
  model: PerformanceModel,
  plan: FlightPlan,
  payloadKg: number,
): FlightProfile {
  const route = routeGeometry(plan.points);
  return {
    model,
    totalDistanceM: route.totalM,
    originElevationM: plan.points[0]?.elevationM ?? 0,
    destinationElevationM: plan.points.at(-1)?.elevationM ?? 0,
    cruiseAltitudeM: plan.cruiseAltitudeM,
    cruiseSpeedKmh: plan.cruiseSpeedKmh,
    payloadKg,
  };
}

/** Flies a profile through the weather of a context, or through still air without one. */
function fly(
  profile: FlightProfile,
  fuelKg: number,
  weather: WeatherContext | null,
): FlightProgress {
  return flyToCompletion(profile, fuelKg, PLANNING_STEP_S, (progress) =>
    advanceInWeather(profile, progress, PLANNING_STEP_S, weather),
  );
}

const kg = (value: number) => `${groupThousands(value)} kg`;
const metresText = (value: number) => `${groupThousands(value)} m`;

/**
 * Checks a plan against the aircraft's model and estimates the flight by flying it.
 * Deterministic: the same inputs always give the same evaluation.
 */
export function evaluatePlan(
  model: PerformanceModel,
  plan: FlightPlan,
  load: FlightLoad,
  context: PlanContext | null = null,
): PlanEvaluation {
  const constraints: Constraint[] = [];
  const block = (code: string, message: string) =>
    constraints.push({ severity: 'block', code, message });
  const warn = (code: string, message: string) =>
    constraints.push({ severity: 'warning', code, message });
  const note = (code: string, message: string) =>
    constraints.push({ severity: 'note', code, message });

  const problems = routeProblems(plan.points);
  for (const problem of problems) block('invalid_route', problem);

  // A closed aerodrome cannot be departed from.
  const hazards = context?.hazards ?? NO_HAZARDS;
  const originPoint = plan.points[0];
  const closedOrigin =
    context && originPoint ? closureAt(hazards, originPoint, context.departureTick) : undefined;
  if (closedOrigin) {
    block(
      'origin_closed',
      `${closedOrigin.place.name} is closed to departures (${closedOrigin.eventId}). The flight can leave once it reopens.`,
    );
  }

  // Load.
  const finite = [plan.cruiseAltitudeM, plan.cruiseSpeedKmh, load.fuelKg, load.payloadKg].every(
    Number.isFinite,
  );
  if (!finite) block('invalid_number', 'Altitude, speed, fuel and payload must all be numbers.');
  if (load.fuelKg < 0 || load.payloadKg < 0)
    block('negative_load', 'Fuel and payload cannot be negative.');
  if (load.fuelKg > model.fuelCapacityKg + 0.5) {
    block(
      'fuel_over_capacity',
      `Fuel load ${kg(load.fuelKg)} exceeds the capacity of ${kg(model.fuelCapacityKg)}.`,
    );
  }
  const takeoffMassKg = grossMassKg(model, load.fuelKg, load.payloadKg);
  if (takeoffMassKg > model.maxTakeoffMassKg + 0.5) {
    block(
      'over_maximum_mass',
      `Take-off mass ${kg(takeoffMassKg)} exceeds the maximum of ${kg(model.maxTakeoffMassKg)}. Reduce fuel or payload.`,
    );
  } else if (takeoffMassKg > model.maxTakeoffMassKg * 0.98) {
    note('near_maximum_mass', 'Take-off mass is within 2 % of the maximum.');
  }

  // Altitude.
  const originElevationM = plan.points[0]?.elevationM ?? 0;
  const destinationElevationM = plan.points.at(-1)?.elevationM ?? 0;
  const highestGroundM = Math.max(originElevationM, destinationElevationM);
  if (plan.cruiseAltitudeM <= highestGroundM + 100) {
    block(
      'altitude_below_terrain',
      `Cruise altitude ${metresText(plan.cruiseAltitudeM)} is not clear of the aerodromes (highest is ${metresText(highestGroundM)}).`,
    );
  }
  if (model.serviceCeilingM === null) {
    note(
      'ceiling_unknown',
      'No source gives a service ceiling for this type, so the altitude cannot be checked against one.',
    );
  } else if (plan.cruiseAltitudeM > model.serviceCeilingM) {
    block(
      'above_service_ceiling',
      `Cruise altitude ${metresText(plan.cruiseAltitudeM)} is above the service ceiling of ${metresText(model.serviceCeilingM)}.`,
    );
  }
  if (plan.cruiseAltitudeM < model.cruiseAltitudeM * 0.5 && !model.hovers) {
    note('low_cruise_altitude', 'Cruising this low costs noticeably more fuel.');
  }

  // Speed.
  if (plan.cruiseSpeedKmh <= 0) {
    block('invalid_speed', 'Cruise speed must be greater than zero.');
  } else if (model.maxSpeedKmh !== null && plan.cruiseSpeedKmh > model.maxSpeedKmh) {
    block(
      'above_maximum_speed',
      `Cruise speed ${Math.round(plan.cruiseSpeedKmh)} km/h is above the maximum of ${Math.round(model.maxSpeedKmh)} km/h.`,
    );
  } else {
    const error = Math.abs(plan.cruiseSpeedKmh - model.cruiseSpeedKmh) / model.cruiseSpeedKmh;
    if (model.maxSpeedKmh === null && plan.cruiseSpeedKmh > model.cruiseSpeedKmh * 1.1) {
      warn(
        'speed_unchecked',
        'No source gives a maximum speed for this type; this is more than 10 % above its cruise speed.',
      );
    } else if (!model.hovers && plan.cruiseSpeedKmh < model.cruiseSpeedKmh * 0.55) {
      warn('speed_very_low', 'This is far below normal cruise speed for a fixed-wing aircraft.');
    } else if (error > 0.15) {
      note('off_optimum_speed', 'Flying this far from cruise speed costs more fuel per kilometre.');
    }
  }

  if (constraints.some((constraint) => constraint.severity === 'block') || problems.length > 0) {
    return { estimate: null, constraints, flyable: false };
  }

  // Fly it.
  const route = routeGeometry(plan.points);
  const profile = flightProfile(model, plan, load.payloadKg);
  const weatherContext: WeatherContext | null = context
    ? { weather: context.weather, route, departureTick: context.departureTick }
    : null;
  const end = fly(profile, load.fuelKg, weatherContext);
  const completes = end.phase === 'landed';
  let weather: WeatherImpact | null = null;
  if (context) {
    // The same plan in still air, with fuel that cannot run out, to show what the weather costs.
    const calm = fly(profile, model.fuelCapacityKg, null);
    const origin = plan.points[0] as RoutePoint;
    const destination = plan.points.at(-1) as RoutePoint;
    weather = {
      stillAirDurationS: calm.elapsedS,
      stillAirFuelUsedKg: model.fuelCapacityKg - calm.fuelKg,
      meanTailwindKmh: end.elapsedS > 0 ? end.exposure.tailwindKmhS / end.elapsedS : 0,
      worstSeverity: end.exposure.worstSeverity,
      lowestVisibilityKm: end.exposure.lowestVisibilityKm ?? 40,
      heaviestPrecipitation: end.exposure.heaviestPrecipitation,
      departure: conditionsAt(context.weather, context.departureTick, origin, 0),
      arrival: conditionsAt(context.weather, context.departureTick + end.elapsedS, destination, 0),
    };
  }
  const estimate: PlanEstimate = {
    distanceM: route.totalM,
    durationS: end.elapsedS,
    fuelUsedKg: load.fuelKg - end.fuelKg,
    fuelAtDestinationKg: end.fuelKg,
    takeoffMassKg,
    topAltitudeM: end.topAltitudeM,
    completes,
    reachedM: end.distanceM,
    legs: route.legs.map((leg) => ({ distanceM: leg.distanceM, bearingDeg: leg.bearingDeg })),
    weather,
    disruptions: context
      ? disruptionsOnRoute(
          hazards,
          plan.points,
          context.departureTick,
          context.departureTick + end.elapsedS,
        )
      : [],
  };

  if (!completes) {
    block(
      'insufficient_fuel',
      `Fuel runs out after ${groupThousands(end.distanceM / 1000)} km of ${groupThousands(route.totalM / 1000)} km. Load more fuel, reduce payload or shorten the route.`,
    );
  } else {
    if (end.fuelKg < model.reserveFuelKg) {
      warn(
        'below_reserve',
        `Arrives with ${kg(end.fuelKg)}, below the assumed reserve of ${kg(model.reserveFuelKg)}.`,
      );
    }
    if (context) {
      // A plan may not arrive at an aerodrome during a closure that is already known.
      const closedDestination = closureAt(
        hazards,
        plan.points.at(-1) as RoutePoint,
        context.departureTick + end.elapsedS,
      );
      if (closedDestination) {
        block(
          'destination_closed_on_arrival',
          `${closedDestination.place.name} will be closed when the flight arrives (${closedDestination.eventId}). Leave later, or choose another destination.`,
        );
      }
      for (const disruption of estimate.disruptions) {
        warn(
          disruption.type === 'severe_weather' ? 'severe_weather_area' : 'navigation_disruption',
          disruption.type === 'severe_weather'
            ? `The route passes through a severe weather area (${disruption.eventId}).`
            : `The route passes through an area of disrupted navigation (${disruption.eventId}).`,
        );
      }
    }
    if (weather) {
      // Weather informs; it does not forbid. These are warnings and notes, never blocks.
      if (weather.worstSeverity >= 0.75) {
        warn('severe_weather_on_route', 'The route passes through severe weather.');
      }
      if (weather.arrival.visibilityKm < 3) {
        warn(
          'low_visibility_at_destination',
          `Visibility at the destination is forecast to be ${weather.arrival.visibilityKm.toFixed(1)} km on arrival.`,
        );
      }
      if (weather.arrival.ceilingM !== null && weather.arrival.ceilingM < 300) {
        note(
          'low_ceiling_at_destination',
          `The cloud base at the destination is forecast to be ${metresText(weather.arrival.ceilingM)} on arrival.`,
        );
      }
      const extraS = end.elapsedS - weather.stillAirDurationS;
      if (extraS > weather.stillAirDurationS * 0.1) {
        note(
          'headwind',
          `Headwinds add ${Math.round(extraS / 60)} min to the flight (${Math.round((extraS / weather.stillAirDurationS) * 100)} %).`,
        );
      }
    }
    if (end.topAltitudeM < plan.cruiseAltitudeM - 50) {
      note(
        'cruise_altitude_not_reached',
        `The route is too short to reach ${metresText(plan.cruiseAltitudeM)}; the flight tops out at ${metresText(end.topAltitudeM)}.`,
      );
    }
  }

  return {
    estimate,
    constraints,
    flyable: !constraints.some((constraint) => constraint.severity === 'block'),
  };
}

/** Fuel that completes the plan and arrives with the assumed reserve, or `null` if none can. */
export function suggestedFuelKg(
  model: PerformanceModel,
  plan: FlightPlan,
  payloadKg: number,
  context: PlanContext | null = null,
): number | null {
  const maxByMass = model.maxTakeoffMassKg - model.emptyMassKg - payloadKg;
  const ceilingKg = Math.min(model.fuelCapacityKg, maxByMass);
  if (ceilingKg <= 0 || routeProblems(plan.points).length > 0) return null;
  const profile = flightProfile(model, plan, payloadKg);
  const weatherContext: WeatherContext | null = context
    ? {
        weather: context.weather,
        route: routeGeometry(plan.points),
        departureTick: context.departureTick,
      }
    : null;
  const arrivesWith = (fuelKg: number) => {
    const end = fly(profile, fuelKg, weatherContext);
    return end.phase === 'landed' ? end.fuelKg : -1;
  };
  if (arrivesWith(ceilingKg) < 0) return null;
  // Smallest load that still arrives with the reserve; more fuel always arrives with more.
  let low = 0;
  let high = ceilingKg;
  if (arrivesWith(high) < model.reserveFuelKg) return Math.floor(high);
  for (let i = 0; i < 18; i++) {
    const middle = (low + high) / 2;
    if (arrivesWith(middle) >= model.reserveFuelKg) high = middle;
    else low = middle;
  }
  return Math.min(Math.ceil(high / 10) * 10, Math.floor(ceilingKg));
}

/** A sensible first plan: the direct route at the model's cruise altitude and speed. */
export function generatePlan(
  model: PerformanceModel,
  origin: RoutePoint,
  destination: RoutePoint,
): FlightPlan {
  return {
    points: directRoute(origin, destination),
    cruiseAltitudeM: model.cruiseAltitudeM,
    cruiseSpeedKmh: model.cruiseSpeedKmh,
  };
}

/** Assumed reserve policy, for display. */
export const RESERVE_STATEMENT = FLIGHT_ASSUMPTIONS.reserve.statement;

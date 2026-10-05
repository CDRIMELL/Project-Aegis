import { groupThousands } from '../math';
import type { PerformanceModel } from '../flight/performance';
import { flightProfile, type FlightLoad, type FlightPlan } from '../flight/plan';
import { advanceInWeather } from '../environment/flight-weather';
import type { WeatherModel } from '../environment/weather';
import { initialProgress } from '../flight/profile';
import { positionAlong, routeGeometry, routeProblems, type RoutePoint } from '../flight/route';
import { greatCircleDistance, type LatLon } from '../geo';
import type { Objective, ObjectiveSpec } from './types';

/*
 * Objectives (ADR 0017).
 *
 * Each objective is judged by a pure function of where the mission's flight is now. The simulation
 * calls it once per step; the planner calls the same function over the planned flight to forecast
 * the result. Adding an objective kind means adding a case here.
 */

/** Two positions closer than this are the same place. */
const SAME_PLACE_M = 1000;

/** What an objective can see of its mission's flight at one step. */
export interface ObjectiveContext {
  readonly tick: number;
  /** Simulated seconds this step covers. */
  readonly stepS: number;
  readonly position: LatLon;
  readonly distanceM: number;
  readonly totalM: number;
  /** The flight is over, one way or another. */
  readonly ended: boolean;
  /** The flight ended by landing. Where it landed is `landedAt`. */
  readonly landed: boolean;
  /**
   * The aerodrome the flight actually landed at, once it has. A flight may be diverted, so this
   * is not always the destination the mission was planned to (ADR 0026).
   */
  readonly landedAt: RoutePoint | null;
  readonly fuelKg: number;
  readonly reserveFuelKg: number;
  /** Payload the flight is carrying. */
  readonly payloadKg: number;
  readonly origin: RoutePoint;
  /** The destination the mission was planned to: where its objectives require it to land. */
  readonly destination: RoutePoint;
  /** The aircraft's condition; after the flight's wear once the flight has ended. */
  readonly conditionPct: number;
}

const km = (metres: number) => `${groupThousands(metres / 1000)} km`;
const kg = (value: number) => `${groupThousands(value)} kg`;

function done(objective: Objective, remark: string | null = null): Objective {
  return { ...objective, status: 'complete', progress: 1, remark };
}
function failed(objective: Objective, remark: string): Objective {
  return { ...objective, status: 'failed', remark };
}
function progressed(objective: Objective, progress: number): Objective {
  const clamped = Math.min(Math.max(progress, 0), 1);
  return clamped === objective.progress ? objective : { ...objective, progress: clamped };
}

/** Judges one objective at one step. A decided objective never changes again. */
export function evaluateObjective(objective: Objective, ctx: ObjectiveContext): Objective {
  if (objective.status !== 'pending') return objective;
  const { spec } = objective;
  const flown = ctx.totalM > 0 ? ctx.distanceM / ctx.totalM : 0;
  const notLanded = 'The flight did not reach its destination.';
  // An objective about the destination is met only by landing there. Landing somewhere else is
  // a landing, and is said to be one, but it is not what was asked.
  const landedAt = ctx.landedAt ?? ctx.destination;
  const elsewhere =
    ctx.landed && greatCircleDistance(landedAt, ctx.destination) >= SAME_PLACE_M
      ? `Landed at ${landedAt.name}, not at ${ctx.destination.name}.`
      : null;

  switch (spec.kind) {
    case 'complete_flight':
      if (ctx.landed) return elsewhere ? failed(objective, elsewhere) : done(objective);
      if (ctx.ended) return failed(objective, notLanded);
      return progressed(objective, flown);

    case 'visit_point': {
      const late = spec.byTick !== null && ctx.tick > spec.byTick;
      if (late) return failed(objective, `${spec.point.name} was not reached in time.`);
      if (greatCircleDistance(ctx.position, spec.point) <= spec.radiusM) return done(objective);
      if (ctx.ended) {
        return failed(
          objective,
          `The flight did not pass within ${km(spec.radiusM)} of ${spec.point.name}.`,
        );
      }
      return objective;
    }

    case 'remain_in_area': {
      const inside = greatCircleDistance(ctx.position, spec.centre) <= spec.radiusM;
      const accumulatedS = objective.accumulatedS + (inside && !ctx.ended ? ctx.stepS : 0);
      if (accumulatedS >= spec.durationS) return done({ ...objective, accumulatedS });
      if (ctx.ended) {
        return failed(
          { ...objective, accumulatedS },
          `Spent ${Math.floor(accumulatedS / 60)} of ${Math.ceil(spec.durationS / 60)} minutes in the area.`,
        );
      }
      return accumulatedS === objective.accumulatedS
        ? objective
        : { ...objective, accumulatedS, progress: accumulatedS / spec.durationS };
    }

    case 'deliver_payload':
      if (ctx.landed) {
        if (elsewhere) return failed(objective, elsewhere);
        return ctx.payloadKg + 0.5 >= spec.massKg
          ? done(objective)
          : failed(objective, `Carried ${kg(ctx.payloadKg)} of the ${kg(spec.massKg)} required.`);
      }
      if (ctx.ended) return failed(objective, notLanded);
      return progressed(objective, flown);

    case 'return_to_base':
      if (ctx.landed) {
        return greatCircleDistance(ctx.origin, landedAt) < SAME_PLACE_M
          ? done(objective)
          : failed(objective, `Landed at ${landedAt.name}, not at ${ctx.origin.name}.`);
      }
      if (ctx.ended) return failed(objective, notLanded);
      return progressed(objective, flown);

    case 'arrive_by':
      if (ctx.tick > spec.byTick) return failed(objective, 'Did not land before the deadline.');
      if (ctx.landed) return elsewhere ? failed(objective, elsewhere) : done(objective);
      if (ctx.ended) return failed(objective, notLanded);
      return progressed(objective, flown);

    case 'land_with_reserve':
      if (ctx.landed) {
        return ctx.fuelKg >= ctx.reserveFuelKg
          ? done(objective)
          : failed(
              objective,
              `Landed with ${kg(ctx.fuelKg)}, below the reserve of ${kg(ctx.reserveFuelKg)}.`,
            );
      }
      if (ctx.ended) return failed(objective, notLanded);
      return objective;

    case 'maintain_condition':
      if (!ctx.ended) return objective;
      return ctx.conditionPct >= spec.minPct
        ? done(objective)
        : failed(
            objective,
            `Condition ended at ${ctx.conditionPct.toFixed(1)} %, below ${spec.minPct} %.`,
          );
  }
}

export interface ObjectiveInput {
  readonly label: string;
  readonly spec: ObjectiveSpec;
  readonly required: boolean;
}

/** Fresh, pending objectives with stable ids. */
export function newObjectives(inputs: readonly ObjectiveInput[]): Objective[] {
  return inputs.map((input, index) => ({
    id: `O${index + 1}`,
    label: input.label,
    spec: input.spec,
    required: input.required,
    status: 'pending',
    progress: 0,
    accumulatedS: 0,
    remark: null,
  }));
}

/** Objectives as they stand before a flight: decided state cleared. */
export function resetObjectives(objectives: readonly Objective[]): Objective[] {
  return objectives.map((objective) => ({
    ...objective,
    status: 'pending',
    progress: 0,
    accumulatedS: 0,
    remark: null,
  }));
}

/** Why an objective specification cannot be used, or `null` if it can. */
export function objectiveProblem(spec: ObjectiveSpec): string | null {
  const validPoint = (point: LatLon) =>
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lon) &&
    Math.abs(point.lat) <= 90 &&
    Math.abs(point.lon) <= 180;
  const positive = (value: number) => Number.isFinite(value) && value > 0;
  const tick = (value: number) => Number.isSafeInteger(value) && value >= 0;
  switch (spec.kind) {
    case 'visit_point':
      if (!validPoint(spec.point)) return 'The point to visit is not a valid position.';
      if (!positive(spec.radiusM)) return 'The visit radius must be greater than zero.';
      if (spec.byTick !== null && !tick(spec.byTick)) return 'The visit deadline is not valid.';
      return null;
    case 'remain_in_area':
      if (!validPoint(spec.centre)) return 'The area centre is not a valid position.';
      if (!positive(spec.radiusM)) return 'The area radius must be greater than zero.';
      if (!positive(spec.durationS)) return 'The time in the area must be greater than zero.';
      return null;
    case 'deliver_payload':
      return positive(spec.massKg) ? null : 'The payload to deliver must be greater than zero.';
    case 'arrive_by':
      return tick(spec.byTick) ? null : 'The arrival deadline is not valid.';
    case 'maintain_condition':
      return spec.minPct >= 0 && spec.minPct <= 100
        ? null
        : 'The condition threshold must be between 0 and 100.';
    case 'complete_flight':
    case 'return_to_base':
    case 'land_with_reserve':
      return null;
  }
}

export interface ObjectiveForecast {
  readonly objectives: readonly Objective[];
  /** True when the planned flight lands at its destination. */
  readonly lands: boolean;
  readonly durationS: number;
  /** The tick at which each decided objective was decided, by objective id. */
  readonly decidedTick: Readonly<Record<string, number>>;
}

export interface ForecastInput {
  readonly model: PerformanceModel;
  readonly plan: FlightPlan;
  readonly load: FlightLoad;
  readonly objectives: readonly Objective[];
  /** The tick the flight would depart. */
  readonly departureTick: number;
  readonly conditionPct: number;
  /** Expected wear of a flight of the given length, in percentage points of condition. */
  readonly expectedWearPct: (durationS: number) => number;
  readonly stepS: number;
  /** The world's weather; `null` forecasts in still air. */
  readonly weather?: WeatherModel | null;
}

/**
 * Flies the plan with the same step function as the simulation and judges every objective along
 * the way. In still air the forecast is what will happen, wear aside: wear varies a little.
 * Returns `null` when the route itself is invalid.
 */
export function forecastObjectives(input: ForecastInput): ObjectiveForecast | null {
  const { model, plan, load, stepS } = input;
  if (routeProblems(plan.points).length > 0) return null;
  const route = routeGeometry(plan.points);
  const profile = flightProfile(model, plan, load.payloadKg);
  const origin = plan.points[0] as RoutePoint;
  const destination = plan.points.at(-1) as RoutePoint;

  const weatherContext = input.weather
    ? { weather: input.weather, route, departureTick: input.departureTick }
    : null;
  let progress = initialProgress(profile, load.fuelKg);
  let objectives = resetObjectives(input.objectives);
  let tick = input.departureTick;
  const decidedTick: Record<string, number> = {};
  // A flight that cannot finish stops when its fuel does; the bound guards a stationary one.
  const maxSteps = Math.ceil((route.totalM / 1000) * 3600) + 86_400;

  for (let step = 0; step < maxSteps; step++) {
    progress = advanceInWeather(profile, progress, stepS, weatherContext);
    tick += 1;
    const landed = progress.phase === 'landed';
    const ended = landed || progress.fuelExhausted;
    const ctx: ObjectiveContext = {
      tick,
      stepS,
      position: positionAlong(route, progress.distanceM),
      distanceM: progress.distanceM,
      totalM: route.totalM,
      ended,
      landed,
      // The forecast flies the plan as planned, so it lands where the plan ends.
      landedAt: landed ? destination : null,
      fuelKg: progress.fuelKg,
      reserveFuelKg: model.reserveFuelKg,
      payloadKg: load.payloadKg,
      origin,
      destination,
      conditionPct: ended
        ? Math.max(input.conditionPct - input.expectedWearPct(progress.elapsedS), 0)
        : input.conditionPct,
    };
    objectives = objectives.map((objective) => {
      const next = evaluateObjective(objective, ctx);
      if (next.status !== 'pending' && objective.status === 'pending') decidedTick[next.id] = tick;
      return next;
    });
    if (ended) return { objectives, lands: landed, durationS: progress.elapsedS, decidedTick };
  }
  return { objectives, lands: false, durationS: progress.elapsedS, decidedTick };
}

/** True when every required objective is complete. */
export function objectivesMet(objectives: readonly Objective[]): boolean {
  return objectives.every((objective) => !objective.required || objective.status === 'complete');
}

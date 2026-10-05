import {
  advanceFlight,
  approachSpeedKmh,
  descentDue,
  type Environment,
  type FlightProfile,
  type FlightProgress,
  type WeatherExposure,
} from '../flight/profile';
import { positionAlong, type RouteGeometry } from '../flight/route';
import { PI, cos, sin } from '../math';
import { conditionsAt, type Conditions, type WeatherModel } from './weather';

/*
 * Flying through the weather (ADR 0021).
 *
 * `advanceInWeather` is the one step both the simulation and the planner use. It samples the
 * weather where the aircraft is, once per simulated minute of flight, holds those conditions
 * until the next sample, and then advances the flight with the ordinary flight step. The held
 * conditions are part of the flight's progress, so a flight restored from disk carries on with
 * exactly the conditions it had.
 */

const NO_CLOSURES: readonly ClosureWindow[] = [];

/** Seconds of flight between samples of the weather. */
export const WEATHER_SAMPLE_S = 60;

/** A period during which the flight's destination is closed. */
export interface ClosureWindow {
  readonly startTick: number;
  /** Exclusive. */
  readonly endTick: number;
}

/**
 * A flight's place in the world: which weather, which route, when it left, and when its
 * destination is known to be closed.
 */
export interface WeatherContext {
  readonly weather: WeatherModel;
  readonly route: RouteGeometry;
  readonly departureTick: number;
  /**
   * Known closures of the destination (ADR 0026). Absent before launch: a plan that would arrive
   * during a known closure is refused outright, so there is nothing to hold for.
   */
  readonly closures?: readonly ClosureWindow[];
}

/** The conditions along a heading: the wind split into along-track and across-track parts. */
export function environmentFor(conditions: Conditions, headingDeg: number): Environment {
  const heading = (headingDeg * PI) / 180;
  const alongEast = sin(heading);
  const alongNorth = cos(heading);
  return {
    tailwindKmh: conditions.windEastKmh * alongEast + conditions.windNorthKmh * alongNorth,
    crosswindKmh: conditions.windEastKmh * alongNorth - conditions.windNorthKmh * alongEast,
    temperatureDeviationC: conditions.temperatureDeviationC,
    precipitation: conditions.precipitation,
  };
}

/** The weather where a flight is now, at its altitude. */
export function conditionsForFlight(context: WeatherContext, progress: FlightProgress): Conditions {
  const position = positionAlong(context.route, progress.distanceM);
  return conditionsAt(
    context.weather,
    context.departureTick + progress.elapsedS,
    position,
    progress.altitudeM,
  );
}

function exposed(
  exposure: WeatherExposure,
  conditions: Conditions,
  environment: Environment,
): WeatherExposure {
  return {
    tailwindKmhS: exposure.tailwindKmhS + environment.tailwindKmh * WEATHER_SAMPLE_S,
    worstSeverity: Math.max(exposure.worstSeverity, conditions.severity),
    lowestVisibilityKm:
      exposure.lowestVisibilityKm === null
        ? conditions.visibilityKm
        : Math.min(exposure.lowestVisibilityKm, conditions.visibilityKm),
    heaviestPrecipitation: Math.max(exposure.heaviestPrecipitation, conditions.precipitation),
  };
}

/**
 * True when the destination is closed now, or will be before a descent begun now could end.
 * The descent is timed at the approach speed, the slowest the aircraft flies on the way down.
 */
export function closedForArrival(
  profile: FlightProfile,
  progress: FlightProgress,
  tick: number,
  closures: readonly ClosureWindow[],
): boolean {
  if (closures.length === 0) return false;
  const remainingM = profile.totalDistanceM - progress.distanceM;
  const descentS = Math.ceil(remainingM / (approachSpeedKmh(profile) / 3.6));
  return closures.some((closure) => closure.startTick <= tick + descentS && closure.endTick > tick);
}

/**
 * Decides whether a flight holds, goes on holding or stops holding, before its next step
 * (ADR 0026). A pure rule of the flight's own state and the known closures:
 *
 * - at the top of descent to a closed destination, the aircraft holds there instead of descending;
 * - a hold for a closure ends when the destination is open again;
 * - any hold ends when fuel is down to reserve. If the destination is still closed the aircraft
 *   lands anyway, and that is recorded;
 * - an aircraft already descending is committed and lands.
 */
export function holdDecision(
  profile: FlightProfile,
  progress: FlightProgress,
  tick: number,
  closures: readonly ClosureWindow[],
): FlightProgress {
  const atReserve = progress.fuelKg <= profile.model.reserveFuelKg;
  if (progress.hold !== null) {
    if (atReserve) {
      const stillClosed =
        progress.hold.reason === 'closure' && closedForArrival(profile, progress, tick, closures);
      return { ...progress, hold: null, closureLanding: stillClosed };
    }
    if (
      progress.hold.reason === 'closure' &&
      !closedForArrival(profile, progress, tick, closures)
    ) {
      return { ...progress, hold: null };
    }
    return progress;
  }
  if (progress.closureLanding || progress.phase === 'takeoff' || progress.phase === 'descent') {
    return progress;
  }
  if (!descentDue(profile, progress) || !closedForArrival(profile, progress, tick, closures)) {
    return progress;
  }
  return atReserve
    ? { ...progress, closureLanding: true }
    : { ...progress, hold: { reason: 'closure', sinceS: progress.elapsedS } };
}

/**
 * Advances a flight by one step through the world's weather. With no context the flight is in
 * still air, exactly as before the environment existed.
 */
export function advanceInWeather(
  profile: FlightProfile,
  progress: FlightProgress,
  dtS: number,
  context: WeatherContext | null,
): FlightProgress {
  if (context === null || progress.phase === 'landed' || progress.fuelExhausted) {
    return advanceFlight(profile, progress, dtS, progress.environment);
  }
  let current = progress;
  if (progress.elapsedS % WEATHER_SAMPLE_S === 0) {
    const position = positionAlong(context.route, progress.distanceM);
    const conditions = conditionsAt(
      context.weather,
      context.departureTick + progress.elapsedS,
      position,
      progress.altitudeM,
    );
    const along = environmentFor(conditions, position.headingDeg);
    // An aircraft circling in a hold has no track for the wind to help or hinder.
    const environment =
      progress.hold === null ? along : { ...along, tailwindKmh: 0, crosswindKmh: 0 };
    current = {
      ...progress,
      environment,
      exposure: exposed(progress.exposure, conditions, environment),
    };
  }
  current = holdDecision(
    profile,
    current,
    context.departureTick + progress.elapsedS,
    context.closures ?? NO_CLOSURES,
  );
  return advanceFlight(profile, current, dtS, current.environment);
}

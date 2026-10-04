import {
  advanceFlight,
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

/** Seconds of flight between samples of the weather. */
export const WEATHER_SAMPLE_S = 60;

/** A flight's place in the world's weather: which weather, which route, and when it left. */
export interface WeatherContext {
  readonly weather: WeatherModel;
  readonly route: RouteGeometry;
  readonly departureTick: number;
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
    const environment = environmentFor(conditions, position.headingDeg);
    current = {
      ...progress,
      environment,
      exposure: exposed(progress.exposure, conditions, environment),
    };
  }
  return advanceFlight(profile, current, dtS, current.environment);
}

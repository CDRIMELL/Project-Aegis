import { PI, tan } from '../math';
import { FLIGHT_ASSUMPTIONS, GRAVITY_MS2, type PerformanceModel } from './performance';

/*
 * The flight step (ADR 0016).
 *
 * `advanceFlight` moves one flight forward by one fixed time step. It is a pure function of its
 * inputs: the engine calls it once per simulation step, and the planner calls it in a loop to
 * estimate a whole flight. Because both use this function, an estimate and its outcome agree.
 */

export type FlightPhase = 'takeoff' | 'climb' | 'cruise' | 'descent' | 'landed';

/**
 * The conditions an aircraft is flying through, as far as they change the physics (ADR 0021).
 * Visibility and cloud do not appear here: they inform warnings and risk, not the flight step.
 */
export interface Environment {
  /** Wind component along the direction of travel, km/h. Positive is a tailwind. */
  readonly tailwindKmh: number;
  /** Wind component across the direction of travel, km/h. Its sign does not matter. */
  readonly crosswindKmh: number;
  /** Surface temperature minus the standard 15 °C. Positive is a warm day. */
  readonly temperatureDeviationC: number;
  /** Intensity of precipitation, 0 to 1. */
  readonly precipitation: number;
}

export const STILL_AIR: Environment = {
  tailwindKmh: 0,
  crosswindKmh: 0,
  temperatureDeviationC: 0,
  precipitation: 0,
};

/**
 * How the environment changes a flight. Wind is physics. Temperature and precipitation are
 * simplified simulation assumptions, stated here and shown as such in the interface.
 */
export const ENVIRONMENT_EFFECTS = {
  wind: {
    statement:
      'Ground speed is airspeed plus the wind along the track. A crosswind makes the aircraft crab, which reduces its speed along the track. Fuel is burned for the air flown through, not the ground covered.',
  },
  temperature: {
    fuelPerDegree: 0.002,
    climbPerDegree: 0.015,
    limitC: 30,
    statement:
      'Assumed: cruise fuel changes by 0.2 % per °C that the day is warmer or colder than standard, and the climb rate falls by 1.5 % per °C on a warm day.',
  },
  precipitation: {
    fuelAtHeaviest: 0.03,
    statement:
      'Assumed: precipitation adds up to 3 % to fuel burn, in proportion to its intensity.',
  },
} as const;

/** What a flight has met so far, for its history. Updated whenever the conditions are sampled. */
export interface WeatherExposure {
  /** Seconds flown, weighted by the tailwind in km/h: divide by elapsed time for the mean. */
  readonly tailwindKmhS: number;
  readonly worstSeverity: number;
  readonly lowestVisibilityKm: number | null;
  readonly heaviestPrecipitation: number;
}

export const NO_EXPOSURE: WeatherExposure = {
  tailwindKmhS: 0,
  worstSeverity: 0,
  lowestVisibilityKm: null,
  heaviestPrecipitation: 0,
};

/** What the step needs to know about the flight being flown. */
export interface FlightProfile {
  readonly model: PerformanceModel;
  readonly totalDistanceM: number;
  readonly originElevationM: number;
  readonly destinationElevationM: number;
  readonly cruiseAltitudeM: number;
  readonly cruiseSpeedKmh: number;
  readonly payloadKg: number;
}

/** The changing state of a flight. Plain data: this is what is persisted. */
export interface FlightProgress {
  readonly phase: FlightPhase;
  readonly distanceM: number;
  readonly altitudeM: number;
  /** True airspeed. */
  readonly speedKmh: number;
  readonly fuelKg: number;
  readonly elapsedS: number;
  /** Fuel flow over the last step, for display. */
  readonly burnRateKgH: number;
  /** Highest altitude reached so far. */
  readonly topAltitudeM: number;
  /** True once the tanks are empty in flight. The flight cannot continue. */
  readonly fuelExhausted: boolean;
  /** The conditions currently applied. Sampled once a minute and held in between. */
  readonly environment: Environment;
  readonly exposure: WeatherExposure;
}

const A = FLIGHT_ASSUMPTIONS;
const DESCENT_GRADIENT = tan((A.descent.pathDegrees * PI) / 180);
const KMH_TO_MS = 1 / 3.6;

export function initialProgress(profile: FlightProfile, fuelKg: number): FlightProgress {
  return {
    phase: 'takeoff',
    distanceM: 0,
    altitudeM: profile.originElevationM,
    speedKmh: 0,
    fuelKg,
    elapsedS: 0,
    burnRateKgH: 0,
    topAltitudeM: profile.originElevationM,
    fuelExhausted: false,
    environment: STILL_AIR,
    exposure: NO_EXPOSURE,
  };
}

/** Climb rate available at an altitude: the sea-level figure, falling towards the ceiling. */
function climbRateAt(model: PerformanceModel, altitudeM: number): number {
  if (model.serviceCeilingM === null) return model.climbRateMs;
  const fraction = Math.min(Math.max(altitudeM / model.serviceCeilingM, 0), 1);
  return model.climbRateMs * (1 - (1 - A.climbRate.fractionAtCeiling) * fraction);
}

const E = ENVIRONMENT_EFFECTS;

/** How far the day is from standard, within the range the assumptions are meant for. */
function boundedDeviation(environment: Environment): number {
  return Math.min(
    Math.max(environment.temperatureDeviationC, -E.temperature.limitC),
    E.temperature.limitC,
  );
}

/** Multiplier on fuel burned for the conditions: temperature and precipitation. */
export function environmentFuelFactor(environment: Environment): number {
  return (
    (1 + E.temperature.fuelPerDegree * boundedDeviation(environment)) *
    (1 + E.precipitation.fuelAtHeaviest * Math.min(Math.max(environment.precipitation, 0), 1))
  );
}

/** Multiplier on climb rate: a warm day climbs more slowly. */
export function environmentClimbFactor(environment: Environment): number {
  return Math.max(
    1 - E.temperature.climbPerDegree * Math.max(boundedDeviation(environment), 0),
    0.5,
  );
}

/**
 * Speed over the ground for a true airspeed in a wind. With a crosswind the aircraft points into
 * it to hold its track, so only part of its airspeed carries it along the track.
 */
export function groundSpeedKmh(airspeedKmh: number, environment: Environment): number {
  const cross = Math.min(Math.abs(environment.crosswindKmh), airspeedKmh);
  // Exactly the airspeed when there is no crosswind, so still air is unchanged to the last bit.
  const alongTrack =
    cross === 0 ? airspeedKmh : Math.sqrt(airspeedKmh * airspeedKmh - cross * cross);
  return Math.max(alongTrack + environment.tailwindKmh, 0);
}

/** Multiplier on cruise fuel for flying below or above the model's cruise altitude. */
export function altitudeFuelFactor(model: PerformanceModel, altitudeM: number): number {
  const reference = model.cruiseAltitudeM;
  if (reference <= 0) return 1;
  const error = Math.min(Math.max((reference - altitudeM) / reference, -1), 1);
  return 1 + A.offOptimum.altitudePenaltyAtSeaLevel * error * error;
}

/** Multiplier on cruise fuel per distance for flying faster or slower than the model's cruise speed. */
export function speedFuelFactor(model: PerformanceModel, speedKmh: number): number {
  const error = (speedKmh - model.cruiseSpeedKmh) / model.cruiseSpeedKmh;
  return 1 + A.offOptimum.speedPenalty * error * error;
}

/**
 * Advances a flight by `dtS` seconds.
 *
 * Order within a step: choose the phase, change speed towards the phase's target, move along the
 * route, change altitude, burn fuel for the distance covered and for any energy gained.
 */
export function advanceFlight(
  profile: FlightProfile,
  progress: FlightProgress,
  dtS: number,
  environment: Environment = STILL_AIR,
): FlightProgress {
  if (progress.phase === 'landed' || progress.fuelExhausted) {
    return progress.burnRateKgH === 0 ? progress : { ...progress, burnRateKgH: 0 };
  }
  const { model } = profile;
  const remainingM = profile.totalDistanceM - progress.distanceM;
  const heightAboveDestinationM = progress.altitudeM - profile.destinationElevationM;
  const liftOffKmh = model.hovers ? 0 : profile.cruiseSpeedKmh * A.speeds.liftOffFraction;

  // Phase. Descent begins where a 3 degree path from the present altitude meets the destination.
  let phase: FlightPhase;
  const airborne =
    progress.altitudeM > profile.originElevationM + 0.5 || progress.phase !== 'takeoff';
  if (!airborne && progress.speedKmh < liftOffKmh) {
    phase = 'takeoff';
  } else if (
    airborne &&
    heightAboveDestinationM > 0 &&
    remainingM <= heightAboveDestinationM / DESCENT_GRADIENT
  ) {
    phase = 'descent';
  } else if (progress.phase === 'descent') {
    phase = 'descent';
  } else if (progress.altitudeM < profile.cruiseAltitudeM - 0.5) {
    phase = 'climb';
  } else {
    phase = 'cruise';
  }

  // Speed moves towards the phase's target at the model's acceleration.
  const approachKmh = profile.cruiseSpeedKmh * A.speeds.approachFraction;
  let targetKmh: number;
  if (phase === 'cruise') {
    targetKmh = profile.cruiseSpeedKmh;
  } else if (phase === 'descent') {
    const span = Math.max(profile.cruiseAltitudeM - profile.destinationElevationM, 1);
    const fraction = Math.min(Math.max(heightAboveDestinationM / span, 0), 1);
    targetKmh = approachKmh + (profile.cruiseSpeedKmh - approachKmh) * fraction;
  } else {
    targetKmh = profile.cruiseSpeedKmh * A.speeds.climbFraction;
  }
  const maxChangeKmh = model.accelerationMs2 * dtS * 3.6;
  const speedKmh =
    progress.speedKmh +
    Math.min(Math.max(targetKmh - progress.speedKmh, -maxChangeKmh), maxChangeKmh);

  // Distance over the ground: true airspeed, less what the crosswind takes, plus the tailwind.
  const groundSpeedMs = groundSpeedKmh(speedKmh, environment) * KMH_TO_MS;
  const stepM = Math.min(groundSpeedMs * dtS, remainingM);
  // Distance through the air, which is what fuel is burned for. Equal to the ground distance in
  // still air; on the last step it is cut short in the same proportion as the ground distance.
  const airStepM =
    groundSpeedMs > 0
      ? stepM * ((speedKmh * KMH_TO_MS) / groundSpeedMs)
      : speedKmh * KMH_TO_MS * dtS;
  const distanceM = progress.distanceM + stepM;
  const stillRemainingM = profile.totalDistanceM - distanceM;

  // Altitude.
  let altitudeM = progress.altitudeM;
  if (phase === 'climb') {
    altitudeM = Math.min(
      progress.altitudeM +
        climbRateAt(model, progress.altitudeM) * environmentClimbFactor(environment) * dtS,
      profile.cruiseAltitudeM,
    );
  } else if (phase === 'descent') {
    altitudeM = Math.min(
      progress.altitudeM,
      profile.destinationElevationM + stillRemainingM * DESCENT_GRADIENT,
    );
  }

  // Fuel: distance flown at the Breguet rate, plus the energy of any height and speed gained.
  const massKg = model.emptyMassKg + profile.payloadKg + progress.fuelKg;
  let burnKg =
    (massKg / (model.rangeFactorKm * 1000)) *
    airStepM *
    altitudeFuelFactor(model, altitudeM) *
    speedFuelFactor(model, speedKmh) *
    environmentFuelFactor(environment);
  if (phase === 'descent') {
    burnKg *= A.descent.fuelFractionOfCruise;
  }
  const heightGainedM = Math.max(altitudeM - progress.altitudeM, 0);
  const v0 = progress.speedKmh * KMH_TO_MS;
  const v1 = speedKmh * KMH_TO_MS;
  const kineticGainedJ = Math.max(0.5 * massKg * (v1 * v1 - v0 * v0), 0);
  burnKg += (massKg * GRAVITY_MS2 * heightGainedM + kineticGainedJ) / A.propulsion.joulesPerKgFuel;

  const landed = stillRemainingM <= 0;
  const fuelKg = Math.max(progress.fuelKg - burnKg, 0);
  const fuelExhausted = fuelKg <= 0 && !landed;

  return {
    phase: landed ? 'landed' : phase,
    distanceM,
    altitudeM: landed ? profile.destinationElevationM : altitudeM,
    speedKmh: landed ? 0 : speedKmh,
    fuelKg,
    elapsedS: progress.elapsedS + dtS,
    burnRateKgH: landed ? 0 : (burnKg / dtS) * 3600,
    topAltitudeM: Math.max(progress.topAltitudeM, altitudeM),
    fuelExhausted,
    environment: progress.environment,
    exposure: progress.exposure,
  };
}

/** Longest flight the planner will integrate: a guard against a route that cannot finish. */
const MAX_FLIGHT_S = 48 * 3600;

/** Flies a profile from start to landing, or until fuel runs out, and returns the final state. */
export function flyToCompletion(
  profile: FlightProfile,
  fuelKg: number,
  dtS: number,
  /** Advances one step. Defaults to the plain flight step in whatever conditions are given. */
  step: (progress: FlightProgress) => FlightProgress = (progress) =>
    advanceFlight(profile, progress, dtS),
): FlightProgress {
  let progress = initialProgress(profile, fuelKg);
  const maxSteps = Math.ceil(MAX_FLIGHT_S / dtS);
  for (let i = 0; i < maxSteps; i++) {
    if (progress.phase === 'landed' || progress.fuelExhausted) break;
    progress = step(progress);
  }
  return progress;
}

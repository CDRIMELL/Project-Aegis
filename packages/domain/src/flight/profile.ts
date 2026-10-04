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

/** Conditions the aircraft flies through. Still air and a standard atmosphere until phase 6. */
export interface Environment {
  /** Wind component along the direction of travel, km/h. Positive is a tailwind. */
  readonly tailwindKmh: number;
}

export const STILL_AIR: Environment = { tailwindKmh: 0 };

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
  };
}

/** Climb rate available at an altitude: the sea-level figure, falling towards the ceiling. */
function climbRateAt(model: PerformanceModel, altitudeM: number): number {
  if (model.serviceCeilingM === null) return model.climbRateMs;
  const fraction = Math.min(Math.max(altitudeM / model.serviceCeilingM, 0), 1);
  return model.climbRateMs * (1 - (1 - A.climbRate.fractionAtCeiling) * fraction);
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

  // Distance over the ground: true airspeed plus the wind component.
  const groundSpeedMs = Math.max((speedKmh + environment.tailwindKmh) * KMH_TO_MS, 0);
  const stepM = Math.min(groundSpeedMs * dtS, remainingM);
  const distanceM = progress.distanceM + stepM;
  const stillRemainingM = profile.totalDistanceM - distanceM;

  // Altitude.
  let altitudeM = progress.altitudeM;
  if (phase === 'climb') {
    altitudeM = Math.min(
      progress.altitudeM + climbRateAt(model, progress.altitudeM) * dtS,
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
    stepM *
    altitudeFuelFactor(model, altitudeM) *
    speedFuelFactor(model, speedKmh);
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
  };
}

/** Longest flight the planner will integrate: a guard against a route that cannot finish. */
const MAX_FLIGHT_S = 48 * 3600;

/** Flies a profile from start to landing, or until fuel runs out, and returns the final state. */
export function flyToCompletion(
  profile: FlightProfile,
  fuelKg: number,
  dtS: number,
  environment: Environment = STILL_AIR,
): FlightProgress {
  let progress = initialProgress(profile, fuelKg);
  const maxSteps = Math.ceil(MAX_FLIGHT_S / dtS);
  for (let step = 0; step < maxSteps; step++) {
    if (progress.phase === 'landed' || progress.fuelExhausted) break;
    progress = advanceFlight(profile, progress, dtS, environment);
  }
  return progress;
}

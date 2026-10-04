/*
 * Performance model (ADR 0016).
 *
 * Turns a type's sourced characteristics into the numbers the flight model needs. Everything the
 * reference data cannot supply is a named simulation assumption from `FLIGHT_ASSUMPTIONS`.
 * If a required characteristic is missing, no model is produced: nothing is substituted.
 */

/** Bumped when any assumption or formula changes in a way that alters outcomes. */
export const FLIGHT_MODEL_VERSION = 1;

export const GRAVITY_MS2 = 9.80665;

/**
 * The simulation's assumptions. These are not reference data and are never presented as such.
 * Each has a plain-language statement for the interface and documentation.
 */
export const FLIGHT_ASSUMPTIONS = {
  fuelCapacity: {
    fractionOfUsefulLoad: 0.5,
    statement:
      'Fuel capacity is assumed to be half of useful load (maximum take-off mass minus empty mass).',
  },
  rangeCondition: {
    statement:
      'Published range is assumed to be flown with full fuel from maximum take-off mass; ferry range with full fuel and no payload.',
  },
  reserve: {
    fractionOfCapacity: 0.1,
    statement: 'Reserve fuel is assumed to be 10 % of fuel capacity.',
  },
  cruiseSpeed: {
    fractionOfMaximum: 0.85,
    capKmh: 900,
    statement:
      'Where no cruise speed is sourced, it is assumed to be the lesser of 85 % of maximum speed and 900 km/h.',
  },
  cruiseAltitude: {
    fractionOfCeiling: 0.8,
    capM: 11_500,
    rotaryM: 900,
    unsourcedM: { turbofan: 9000, turboprop: 6000, turboshaft: 900, piston: 2500 },
    statement:
      'Cruise altitude is assumed to be 80 % of service ceiling, at most 11,500 m; 900 m for rotorcraft.',
  },
  climbRate: {
    seaLevelMs: { turbofan: 15, turboprop: 9, turboshaft: 7, piston: 5 },
    fastJetMs: 60,
    fractionAtCeiling: 0.3,
    statement:
      'Climb rate is assumed by engine type (jet 15 m/s, fast jet 60, turboprop 9, rotorcraft 7, piston 5), falling to 30 % at the service ceiling.',
  },
  descent: {
    pathDegrees: 3,
    fuelFractionOfCruise: 0.5,
    statement: 'Descent follows a 3 degree path and burns half the cruise fuel rate.',
  },
  speeds: {
    liftOffFraction: 0.4,
    climbFraction: 0.75,
    approachFraction: 0.45,
    statement:
      'Lift-off, climb and approach speeds are assumed to be 40 %, 75 % and 45 % of cruise speed.',
  },
  acceleration: {
    ms2: 1.5,
    fastJetMs2: 4,
    statement: 'Acceleration is assumed to be 1.5 m/s² (4 m/s² for fast jets).',
  },
  propulsion: {
    joulesPerKgFuel: 12.9e6,
    statement:
      'Climbing and accelerating cost their physical energy, at an assumed 12.9 MJ of useful work per kg of fuel.',
  },
  offOptimum: {
    altitudePenaltyAtSeaLevel: 0.5,
    speedPenalty: 1.5,
    statement:
      'Cruise below the assumed altitude burns up to 50 % more fuel; fuel per distance rises with the square of the speed error.',
  },
} as const;

export type AssumptionId = keyof typeof FLIGHT_ASSUMPTIONS;

export type EngineType = 'turbofan' | 'turboprop' | 'turboshaft' | 'piston';

/** What the reference data says about a type. `null` means no source states it. */
export interface TypeCharacteristics {
  readonly category: string;
  readonly engineType: EngineType;
  readonly emptyMassKg: number | null;
  readonly maxTakeoffMassKg: number | null;
  readonly cruiseSpeedKmh: number | null;
  readonly maxSpeedKmh: number | null;
  readonly rangeKm: number | null;
  readonly ferryRangeKm: number | null;
  readonly serviceCeilingM: number | null;
}

export interface PerformanceModel {
  readonly modelVersion: number;
  // Sourced.
  readonly emptyMassKg: number;
  readonly maxTakeoffMassKg: number;
  /** `null`: no source gives a ceiling, so altitude cannot be checked against one. */
  readonly serviceCeilingM: number | null;
  /** `null`: no source gives a maximum speed. */
  readonly maxSpeedKmh: number | null;
  /** The published figure the fuel model is calibrated to. */
  readonly referenceRangeKm: number;
  readonly referenceRangeKind: 'range' | 'ferry_range';
  // Sourced or assumed; `assumptions` says which.
  readonly cruiseSpeedKmh: number;
  // Assumed or derived.
  readonly fuelCapacityKg: number;
  readonly maxPayloadKg: number;
  readonly reserveFuelKg: number;
  readonly cruiseAltitudeM: number;
  readonly climbRateMs: number;
  readonly accelerationMs2: number;
  /** Breguet range factor in kilometres: cruise fuel per km is mass divided by this. */
  readonly rangeFactorKm: number;
  /** True for rotorcraft: no lift-off speed, no minimum speed. */
  readonly hovers: boolean;
  /** Assumptions this particular model relies on. */
  readonly assumptions: readonly AssumptionId[];
}

export type PerformanceResult =
  | { readonly available: true; readonly model: PerformanceModel }
  | { readonly available: false; readonly missing: readonly string[] };

const positive = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value > 0;

export function derivePerformance(type: TypeCharacteristics): PerformanceResult {
  const missing: string[] = [];
  if (!positive(type.emptyMassKg)) missing.push('empty mass');
  if (!positive(type.maxTakeoffMassKg)) missing.push('maximum take-off mass');
  if (!positive(type.rangeKm) && !positive(type.ferryRangeKm)) missing.push('range');
  if (!positive(type.cruiseSpeedKmh) && !positive(type.maxSpeedKmh))
    missing.push('cruise or maximum speed');
  if (
    positive(type.emptyMassKg) &&
    positive(type.maxTakeoffMassKg) &&
    type.maxTakeoffMassKg <= type.emptyMassKg
  ) {
    missing.push('a maximum take-off mass greater than empty mass');
  }
  if (missing.length > 0 || !positive(type.emptyMassKg) || !positive(type.maxTakeoffMassKg)) {
    return { available: false, missing };
  }

  const A = FLIGHT_ASSUMPTIONS;
  const assumptions = new Set<AssumptionId>([
    'fuelCapacity',
    'rangeCondition',
    'reserve',
    'cruiseAltitude',
    'climbRate',
    'descent',
    'speeds',
    'acceleration',
    'propulsion',
    'offOptimum',
  ]);

  const usefulLoadKg = type.maxTakeoffMassKg - type.emptyMassKg;
  const fuelCapacityKg = Math.round(usefulLoadKg * A.fuelCapacity.fractionOfUsefulLoad);
  const reserveFuelKg = Math.round(fuelCapacityKg * A.reserve.fractionOfCapacity);

  let cruiseSpeedKmh: number;
  if (positive(type.cruiseSpeedKmh)) {
    cruiseSpeedKmh = type.cruiseSpeedKmh;
  } else {
    assumptions.add('cruiseSpeed');
    cruiseSpeedKmh = Math.round(
      Math.min((type.maxSpeedKmh ?? 0) * A.cruiseSpeed.fractionOfMaximum, A.cruiseSpeed.capKmh),
    );
  }

  const hovers = type.engineType === 'turboshaft';
  const ceiling = positive(type.serviceCeilingM) ? type.serviceCeilingM : null;
  const cruiseAltitudeM = hovers
    ? Math.min(A.cruiseAltitude.rotaryM, ceiling ?? A.cruiseAltitude.rotaryM)
    : ceiling === null
      ? A.cruiseAltitude.unsourcedM[type.engineType]
      : Math.round(Math.min(ceiling * A.cruiseAltitude.fractionOfCeiling, A.cruiseAltitude.capM));

  const fastJet = type.category === 'fast_jet';

  // Calibrate the Breguet range factor to the published range (see ADR 0016).
  const useRange = positive(type.rangeKm);
  const referenceRangeKm = useRange ? type.rangeKm : (type.ferryRangeKm as number);
  const takeoffMassKg = useRange ? type.maxTakeoffMassKg : type.emptyMassKg + fuelCapacityKg;
  const usableFuelKg = fuelCapacityKg - reserveFuelKg;
  const rangeFactorKm = referenceRangeKm / Math.log(takeoffMassKg / (takeoffMassKg - usableFuelKg));

  return {
    available: true,
    model: {
      modelVersion: FLIGHT_MODEL_VERSION,
      emptyMassKg: type.emptyMassKg,
      maxTakeoffMassKg: type.maxTakeoffMassKg,
      serviceCeilingM: ceiling,
      maxSpeedKmh: positive(type.maxSpeedKmh) ? type.maxSpeedKmh : null,
      referenceRangeKm,
      referenceRangeKind: useRange ? 'range' : 'ferry_range',
      cruiseSpeedKmh,
      fuelCapacityKg,
      maxPayloadKg: usefulLoadKg,
      reserveFuelKg,
      cruiseAltitudeM,
      climbRateMs: fastJet ? A.climbRate.fastJetMs : A.climbRate.seaLevelMs[type.engineType],
      accelerationMs2: fastJet ? A.acceleration.fastJetMs2 : A.acceleration.ms2,
      rangeFactorKm,
      hovers,
      assumptions: [...assumptions].sort(),
    },
  };
}

/** Total mass of an aircraft with the given fuel and payload on board. */
export function grossMassKg(model: PerformanceModel, fuelKg: number, payloadKg: number): number {
  return model.emptyMassKg + payloadKg + fuelKg;
}

/**
 * How an aircraft is loaded. One variant today; a transport type can later gain a more detailed
 * one (cargo and passenger items) without the flight model changing, because the model only ever
 * asks for the total.
 */
export type LoadConfiguration = { readonly kind: 'simple'; readonly massKg: number };

export function loadMassKg(load: LoadConfiguration): number {
  return load.massKg;
}

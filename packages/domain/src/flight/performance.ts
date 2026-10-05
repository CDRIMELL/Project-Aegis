import { ln } from '../math';

/*
 * Performance model (ADR 0016).
 *
 * Turns a type's sourced characteristics into the numbers the flight model needs. Everything the
 * reference data cannot supply is a named simulation assumption from `FLIGHT_ASSUMPTIONS`.
 * If a required characteristic is missing, no model is produced: nothing is substituted.
 */

/**
 * Bumped when any assumption or formula changes in a way that alters outcomes.
 *
 * - 1: fuel capacity always assumed; calibrated to published range with full fuel at maximum mass.
 * - 2: a sourced fuel capacity is used where one exists, and such a type is calibrated to its
 *   ferry range (ADR 0019).
 *
 * - 3: the conditions a source states for a range decide which figure the model is calibrated to,
 *   and how (ADR 0023). A ferry range stated to use external fuel is not used; a range stated
 *   with a payload is calibrated at that payload.
 *
 * An aircraft stores the model it was given, so an older aircraft keeps flying exactly as it did
 * until it is deliberately migrated on the ground.
 */
export const FLIGHT_MODEL_VERSION = 3;

export const GRAVITY_MS2 = 9.80665;

/**
 * The simulation's assumptions. These are not reference data and are never presented as such.
 * Each has a plain-language statement for the interface and documentation.
 */
export const FLIGHT_ASSUMPTIONS = {
  fuelCapacity: {
    fractionOfUsefulLoad: 0.5,
    statement:
      'No source gives a fuel capacity for this type; it is assumed to be half of useful load (maximum take-off mass minus empty mass).',
  },
  fuelDensity: {
    kgPerLitre: 0.8,
    statement:
      'The source gives fuel capacity as a volume; its mass assumes 0.80 kg per litre of jet fuel.',
  },
  rangeCondition: {
    statement:
      'The source does not state the loading for the range the model is calibrated to. A range is assumed to be flown from maximum take-off mass with as much fuel as that allows; a ferry range, with full internal fuel and no payload.',
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
  contingency: {
    fractionOfTripFuel: 0.05,
    statement:
      'The fuel offered for a flight is what arrives on the reserve in the weather forecast for leaving now, plus 5 % of the trip fuel: a flight leaves once it has been prepared, and the weather will have moved on.',
  },
  hold: {
    speedFraction: 0.75,
    statement:
      'An aircraft that is holding circles where it is, at its present altitude and 75 % of cruise speed, burning fuel for the air it flies through as in cruise.',
  },
  offOptimum: {
    altitudePenaltyAtSeaLevel: 0.5,
    speedPenalty: 1.5,
    statement:
      'Cruise below the assumed altitude burns up to 50 % more fuel; fuel per distance rises with the square of the speed error.',
  },
} as const;

/**
 * Categories whose published ferry range is taken to be flown on internal fuel alone. For the
 * others a ferry range usually includes drop tanks or auxiliary tanks, which the model does not
 * carry, so calibrating to it would make the aircraft unrealistically economical.
 */
const FERRY_ON_INTERNAL_FUEL: ReadonlySet<string> = new Set([
  'transport',
  'tanker',
  'isr',
  'maritime_patrol',
  'airliner',
  'regional_airliner',
  'business_jet',
  'freighter',
]);

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
  /** Fuel capacity published as a mass. */
  readonly fuelCapacityKg?: number | null;
  /** Fuel capacity published as a volume. */
  readonly fuelCapacityL?: number | null;
  /** The payload the source states for the published range; `null` when it states none. */
  readonly rangePayloadKg?: number | null;
  /** Whether the source says the ferry range uses external fuel; `null` when it does not say. */
  readonly ferryExternalFuel?: boolean | null;
  /** The source's wording of the conditions for each figure, for display. */
  readonly rangeConditionsText?: string | null;
  readonly ferryConditionsText?: string | null;
}

/**
 * Which published figure a model's fuel burn is calibrated to, and on what footing.
 * - `ferry_range`: ferry range, which the source says is flown on internal fuel.
 * - `ferry_range_assumed_internal`: ferry range, assumed to be on internal fuel.
 * - `range_with_payload`: range, at the payload the source states.
 * - `range_at_max_mass`: range, assumed to be flown from maximum take-off mass.
 */
export type Calibration =
  'ferry_range' | 'ferry_range_assumed_internal' | 'range_with_payload' | 'range_at_max_mass';

/** Where a model's fuel capacity came from. */
export type FuelCapacityBasis = 'sourced_mass' | 'sourced_volume' | 'assumed';

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
  /** How the model was calibrated. Absent on models older than version 3. */
  readonly calibration?: Calibration;
  /** The payload the calibration assumed aboard, where the source states one. */
  readonly referencePayloadKg?: number | null;
  /** The source's wording of the conditions for the figure used; `null` when it states none. */
  readonly referenceConditions?: string | null;
  // Sourced or assumed; `assumptions` says which.
  readonly cruiseSpeedKmh: number;
  // Sourced, converted from a sourced volume, or assumed; `fuelCapacityBasis` says which.
  readonly fuelCapacityKg: number;
  /** Absent on a version-1 model, where the capacity was always assumed. */
  readonly fuelCapacityBasis?: FuelCapacityBasis;
  // Assumed or derived.
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

const positive = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value) && value > 0;

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
  // A ferry range flown with external fuel says nothing about the aircraft on its own tanks.
  if (!positive(type.rangeKm) && positive(type.ferryRangeKm) && type.ferryExternalFuel === true) {
    missing.push('a range flown on internal fuel');
  }
  if (missing.length > 0 || !positive(type.emptyMassKg) || !positive(type.maxTakeoffMassKg)) {
    return { available: false, missing };
  }

  const A = FLIGHT_ASSUMPTIONS;
  const assumptions = new Set<AssumptionId>([
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
  let fuelCapacityBasis: FuelCapacityBasis;
  let fuelCapacityKg: number;
  if (positive(type.fuelCapacityKg)) {
    fuelCapacityBasis = 'sourced_mass';
    fuelCapacityKg = Math.round(type.fuelCapacityKg);
  } else if (positive(type.fuelCapacityL)) {
    fuelCapacityBasis = 'sourced_volume';
    assumptions.add('fuelDensity');
    fuelCapacityKg = Math.round(type.fuelCapacityL * A.fuelDensity.kgPerLitre);
  } else {
    fuelCapacityBasis = 'assumed';
    assumptions.add('fuelCapacity');
    fuelCapacityKg = Math.round(usefulLoadKg * A.fuelCapacity.fractionOfUsefulLoad);
  }
  if (fuelCapacityKg >= usefulLoadKg) {
    // The published figures cannot all hold at once; refuse rather than guess which is wrong.
    return {
      available: false,
      missing: ['a fuel capacity smaller than maximum take-off mass minus empty mass'],
    };
  }
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
  // Calibrate the Breguet range factor to a published figure whose loading is known, in this
  // order of preference (ADR 0019, ADR 0023):
  //  1. a ferry range on internal fuel: full fuel, no payload. Used only with a sourced capacity,
  //     and never when the source says the figure includes external fuel. Where the source says
  //     nothing, it is taken to be internal for transport-class types only.
  //  2. a range at the payload the source states.
  //  3. a range, assumed flown from maximum take-off mass.
  //  4. a ferry range, assumed flown on full internal fuel.
  const ferryInternal =
    type.ferryExternalFuel === false ||
    (type.ferryExternalFuel !== true && FERRY_ON_INTERNAL_FUEL.has(type.category));
  const payloadAtRangeKg = positive(type.rangePayloadKg) ? type.rangePayloadKg : null;
  const fuelWithPayloadKg =
    payloadAtRangeKg === null ? 0 : Math.min(fuelCapacityKg, usefulLoadKg - payloadAtRangeKg);

  let calibration: Calibration;
  let referenceRangeKm: number;
  let takeoffMassKg: number;
  let usableFuelKg: number;
  let referencePayloadKg: number | null = null;
  if (positive(type.ferryRangeKm) && fuelCapacityBasis !== 'assumed' && ferryInternal) {
    calibration = type.ferryExternalFuel === false ? 'ferry_range' : 'ferry_range_assumed_internal';
    referenceRangeKm = type.ferryRangeKm;
    takeoffMassKg = type.emptyMassKg + fuelCapacityKg;
    usableFuelKg = fuelCapacityKg - reserveFuelKg;
  } else if (
    positive(type.rangeKm) &&
    payloadAtRangeKg !== null &&
    fuelWithPayloadKg > reserveFuelKg
  ) {
    calibration = 'range_with_payload';
    referenceRangeKm = type.rangeKm;
    referencePayloadKg = payloadAtRangeKg;
    takeoffMassKg = type.emptyMassKg + payloadAtRangeKg + fuelWithPayloadKg;
    usableFuelKg = fuelWithPayloadKg - reserveFuelKg;
  } else if (positive(type.rangeKm)) {
    calibration = 'range_at_max_mass';
    referenceRangeKm = type.rangeKm;
    takeoffMassKg = type.maxTakeoffMassKg;
    usableFuelKg = fuelCapacityKg - reserveFuelKg;
  } else {
    calibration = 'ferry_range_assumed_internal';
    referenceRangeKm = type.ferryRangeKm as number;
    takeoffMassKg = type.emptyMassKg + fuelCapacityKg;
    usableFuelKg = fuelCapacityKg - reserveFuelKg;
  }
  // Only a loading the source does not state is an assumption.
  if (calibration === 'range_at_max_mass' || calibration === 'ferry_range_assumed_internal') {
    assumptions.add('rangeCondition');
  }
  const useRange = calibration === 'range_with_payload' || calibration === 'range_at_max_mass';
  const rangeFactorKm = referenceRangeKm / ln(takeoffMassKg / (takeoffMassKg - usableFuelKg));

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
      calibration,
      referencePayloadKg,
      referenceConditions: (useRange ? type.rangeConditionsText : type.ferryConditionsText) ?? null,
      cruiseSpeedKmh,
      fuelCapacityKg,
      fuelCapacityBasis,
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

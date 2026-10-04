import { describe, expect, it } from 'vitest';
import {
  FLIGHT_ASSUMPTIONS,
  FLIGHT_MODEL_VERSION,
  derivePerformance,
  type PerformanceModel,
  type TypeCharacteristics,
} from './performance';
import { flightProfile } from './plan';
import { flyToCompletion } from './profile';
import type { RoutePoint } from './route';

// Test inputs in the shape of the reference data. Illustrative, not authoritative.
const TRANSPORT: TypeCharacteristics = {
  category: 'transport',
  engineType: 'turbofan',
  emptyMassKg: 128140,
  maxTakeoffMassKg: 265352,
  cruiseSpeedKmh: 833,
  maxSpeedKmh: null,
  rangeKm: 4482,
  ferryRangeKm: 11538,
  serviceCeilingM: 13716,
};

function model(type: TypeCharacteristics): PerformanceModel {
  const result = derivePerformance(type);
  if (!result.available) throw new Error(`unavailable: ${result.missing.join(', ')}`);
  return result.model;
}

describe('fuel capacity in the performance model', () => {
  it('stamps every model with the current version', () => {
    expect(FLIGHT_MODEL_VERSION).toBe(3);
    expect(model(TRANSPORT).modelVersion).toBe(3);
  });

  it('uses a sourced mass as published and does not list it as an assumption', () => {
    const sourced = model({ ...TRANSPORT, fuelCapacityKg: 100_000 });
    expect(sourced.fuelCapacityKg).toBe(100_000);
    expect(sourced.fuelCapacityBasis).toBe('sourced_mass');
    expect(sourced.assumptions).not.toContain('fuelCapacity');
    expect(sourced.assumptions).not.toContain('fuelDensity');
  });

  it('converts a sourced volume with the assumed density, and says so', () => {
    const sourced = model({ ...TRANSPORT, fuelCapacityL: 134_556 });
    expect(sourced.fuelCapacityKg).toBe(
      Math.round(134_556 * FLIGHT_ASSUMPTIONS.fuelDensity.kgPerLitre),
    );
    expect(sourced.fuelCapacityBasis).toBe('sourced_volume');
    expect(sourced.assumptions).toContain('fuelDensity');
    expect(sourced.assumptions).not.toContain('fuelCapacity');
  });

  it('prefers a published mass over a published volume', () => {
    const sourced = model({ ...TRANSPORT, fuelCapacityKg: 100_000, fuelCapacityL: 1 });
    expect(sourced.fuelCapacityBasis).toBe('sourced_mass');
  });

  it('still assumes half of useful load when no source gives a capacity, and says so', () => {
    const assumed = model(TRANSPORT);
    expect(assumed.fuelCapacityKg).toBe(Math.round((265352 - 128140) / 2));
    expect(assumed.fuelCapacityBasis).toBe('assumed');
    expect(assumed.assumptions).toContain('fuelCapacity');
    // Unchanged from model 1: an assumed capacity is calibrated to the published range.
    expect(assumed.referenceRangeKind).toBe('range');
  });

  it('calibrates a sourced capacity to the ferry range, whose loading is defined', () => {
    const sourced = model({ ...TRANSPORT, fuelCapacityKg: 100_000 });
    expect(sourced.referenceRangeKind).toBe('ferry_range');
    expect(sourced.referenceRangeKm).toBe(11538);
    const takeoff = 128140 + 100_000;
    const usable = 100_000 - sourced.reserveFuelKg;
    expect(sourced.rangeFactorKm).toBeCloseTo(11538 / Math.log(takeoff / (takeoff - usable)), 6);
  });

  it('does not calibrate a fast jet or rotorcraft to a ferry range that may include external fuel', () => {
    for (const category of ['fast_jet', 'trainer', 'rotary', 'uncrewed']) {
      const sourced = model({ ...TRANSPORT, category, fuelCapacityKg: 100_000 });
      expect(sourced.referenceRangeKind).toBe('range');
    }
  });

  it('falls back to the published range when a sourced capacity has no ferry range', () => {
    const sourced = model({ ...TRANSPORT, ferryRangeKm: null, fuelCapacityKg: 100_000 });
    expect(sourced.referenceRangeKind).toBe('range');
  });

  it('refuses a model when the published capacity does not fit within the published masses', () => {
    const result = derivePerformance({ ...TRANSPORT, fuelCapacityKg: 140_000 });
    expect(result).toEqual({
      available: false,
      missing: ['a fuel capacity smaller than maximum take-off mass minus empty mass'],
    });
  });

  it('flies its ferry range on full sourced fuel with no payload, arriving near reserve', () => {
    const sourced = model({ ...TRANSPORT, fuelCapacityKg: 100_000 });
    const origin: RoutePoint = { kind: 'aerodrome', name: 'A', lat: 0, lon: 0, elevationM: 0 };
    // Due east along the equator for the ferry range.
    const lon = (11538 / 6371.0088) * (180 / Math.PI);
    const destination: RoutePoint = { ...origin, name: 'B', lon };
    const plan = {
      points: [origin, destination],
      cruiseAltitudeM: sourced.cruiseAltitudeM,
      cruiseSpeedKmh: sourced.cruiseSpeedKmh,
    };
    const end = flyToCompletion(flightProfile(sourced, plan, 0), sourced.fuelCapacityKg, 1);
    // Calibration is to cruise; the climb costs a little more and the descent a little less.
    const error = Math.abs(end.fuelKg - sourced.reserveFuelKg) / sourced.fuelCapacityKg;
    expect(error).toBeLessThan(0.05);
  });
});

describe('calibration from stated range conditions (flight model 3)', () => {
  // A fighter-like type: both a range and a ferry range published, capacity sourced.
  const FIGHTER: TypeCharacteristics = {
    category: 'fast_jet',
    engineType: 'turbofan',
    emptyMassKg: 11000,
    maxTakeoffMassKg: 23500,
    cruiseSpeedKmh: null,
    maxSpeedKmh: 2495,
    rangeKm: 2900,
    ferryRangeKm: 3790,
    serviceCeilingM: 16764,
    fuelCapacityKg: 4500,
  };

  it('never calibrates to a ferry range the source says used external fuel', () => {
    // Even for a transport, where an unstated ferry range would be taken as internal.
    const stated = model({ ...TRANSPORT, fuelCapacityKg: 100_000, ferryExternalFuel: true });
    expect(stated.calibration).toBe('range_at_max_mass');
    expect(stated.referenceRangeKind).toBe('range');
    expect(model({ ...FIGHTER, ferryExternalFuel: true }).calibration).toBe('range_at_max_mass');
  });

  it('calibrates to a ferry range the source says is on internal fuel, for any category', () => {
    const stated = model({ ...FIGHTER, ferryExternalFuel: false });
    expect(stated.calibration).toBe('ferry_range');
    expect(stated.referenceRangeKm).toBe(3790);
    // The loading is stated, so it is not listed as an assumption.
    expect(stated.assumptions).not.toContain('rangeCondition');
  });

  it('says so when it has to assume the loading', () => {
    const unstated = model({ ...TRANSPORT, fuelCapacityKg: 100_000 });
    expect(unstated.calibration).toBe('ferry_range_assumed_internal');
    expect(unstated.assumptions).toContain('rangeCondition');
    const atMaxMass = model(FIGHTER);
    expect(atMaxMass.calibration).toBe('range_at_max_mass');
    expect(atMaxMass.assumptions).toContain('rangeCondition');
  });

  it('calibrates a range at the payload the source states', () => {
    const type = { ...TRANSPORT, ferryRangeKm: null, rangePayloadKg: 71_214 };
    const stated = model(type);
    expect(stated.calibration).toBe('range_with_payload');
    expect(stated.referencePayloadKg).toBe(71_214);
    expect(stated.assumptions).not.toContain('rangeCondition');
    // Take-off with that payload and as much fuel as the maximum mass then allows.
    const fuel = Math.min(stated.fuelCapacityKg, 265352 - 128140 - 71_214);
    const takeoff = 128140 + 71_214 + fuel;
    expect(stated.rangeFactorKm).toBeCloseTo(
      4482 / Math.log(takeoff / (takeoff - (fuel - stated.reserveFuelKg))),
      6,
    );
    // The same type with no stated payload is calibrated differently.
    expect(model({ ...TRANSPORT, ferryRangeKm: null }).rangeFactorKm).not.toBe(
      stated.rangeFactorKm,
    );
  });

  it('flies its published range at the stated payload, arriving near reserve', () => {
    const type = { ...TRANSPORT, ferryRangeKm: null, rangePayloadKg: 71_214 };
    const stated = model(type);
    const origin: RoutePoint = { kind: 'aerodrome', name: 'A', lat: 0, lon: 0, elevationM: 0 };
    const destination: RoutePoint = {
      ...origin,
      name: 'B',
      lon: (4482 / 6371.0088) * (180 / Math.PI),
    };
    const plan = {
      points: [origin, destination],
      cruiseAltitudeM: stated.cruiseAltitudeM,
      cruiseSpeedKmh: stated.cruiseSpeedKmh,
    };
    const fuel = Math.min(stated.fuelCapacityKg, 265352 - 128140 - 71_214);
    const end = flyToCompletion(flightProfile(stated, plan, 71_214), fuel, 1);
    expect(end.phase).toBe('landed');
    expect(Math.abs(end.fuelKg - stated.reserveFuelKg) / fuel).toBeLessThan(0.06);
  });

  it('ignores a stated payload that leaves no room for fuel', () => {
    const impossible = model({ ...TRANSPORT, ferryRangeKm: null, rangePayloadKg: 137_000 });
    expect(impossible.calibration).toBe('range_at_max_mass');
  });

  it('refuses a model when the only range published was flown with external fuel', () => {
    expect(derivePerformance({ ...FIGHTER, rangeKm: null, ferryExternalFuel: true })).toEqual({
      available: false,
      missing: ['a range flown on internal fuel'],
    });
    // With nothing stated about it, a lone ferry range is used, and the assumption is listed.
    const lone = model({ ...FIGHTER, rangeKm: null });
    expect(lone.calibration).toBe('ferry_range_assumed_internal');
  });

  it('carries the source’s wording of the conditions for the figure it used', () => {
    const texts = {
      rangeConditionsText: 'range note = with 157,000 lb payload',
      ferryConditionsText: 'ferry range note = with 3 drop tanks',
    };
    expect(model({ ...FIGHTER, ferryExternalFuel: true, ...texts }).referenceConditions).toBe(
      texts.rangeConditionsText,
    );
    expect(model({ ...FIGHTER, ferryExternalFuel: false, ...texts }).referenceConditions).toBe(
      texts.ferryConditionsText,
    );
    expect(model(FIGHTER).referenceConditions).toBeNull();
  });
});

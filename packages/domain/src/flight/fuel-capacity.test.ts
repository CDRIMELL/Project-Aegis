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

describe('fuel capacity in the performance model (flight model 2)', () => {
  it('is at version 2', () => {
    expect(FLIGHT_MODEL_VERSION).toBe(2);
    expect(model(TRANSPORT).modelVersion).toBe(2);
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

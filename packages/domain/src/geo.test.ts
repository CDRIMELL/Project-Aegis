import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  EARTH_MEAN_RADIUS_M,
  destinationPoint,
  greatCircleDistance,
  initialBearing,
  intermediatePoint,
  isValidLatLon,
  latLon,
  normaliseLongitude,
  type LatLon,
} from './geo';
import {
  degrees,
  feet,
  feetToMetres,
  kilograms,
  kilogramsToPounds,
  kilometresPerHourToKnots,
  knots,
  knotsToKilometresPerHour,
  metres,
  metresToFeet,
  metresToNauticalMiles,
  nauticalMiles,
  nauticalMilesToMetres,
  pounds,
  poundsToKilograms,
} from './units';

const point = fc.record({
  lat: fc.double({ min: -89, max: 89, noNaN: true }),
  lon: fc.double({ min: -180, max: 180, noNaN: true }),
});

const LONDON: LatLon = latLon(51.5, 0);
const EQUATOR_0: LatLon = latLon(0, 0);

describe('units', () => {
  it('converts using the exact international definitions', () => {
    expect(feetToMetres(feet(1000))).toBeCloseTo(304.8, 10);
    expect(nauticalMilesToMetres(nauticalMiles(1))).toBe(1852);
    expect(poundsToKilograms(pounds(1))).toBe(0.45359237);
    expect(knotsToKilometresPerHour(knots(100))).toBeCloseTo(185.2, 10);
  });

  it('round-trips each conversion pair', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e7, noNaN: true }), (value) => {
        expect(metresToFeet(feetToMetres(feet(value)))).toBeCloseTo(value, 6);
        expect(metresToNauticalMiles(nauticalMilesToMetres(nauticalMiles(value)))).toBeCloseTo(
          value,
          6,
        );
        expect(kilogramsToPounds(poundsToKilograms(pounds(value)))).toBeCloseTo(value, 6);
        expect(kilometresPerHourToKnots(knotsToKilometresPerHour(knots(value)))).toBeCloseTo(
          value,
          6,
        );
      }),
    );
  });

  it('rejects non-finite quantities', () => {
    expect(() => metres(Number.NaN)).toThrow(RangeError);
    expect(() => kilograms(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('coordinates', () => {
  it('validates ranges', () => {
    expect(isValidLatLon(90, -180)).toBe(true);
    expect(isValidLatLon(90.01, 0)).toBe(false);
    expect(isValidLatLon(0, 180.5)).toBe(false);
    expect(isValidLatLon(Number.NaN, 0)).toBe(false);
    expect(() => latLon(-91, 0)).toThrow(RangeError);
  });

  it('normalises longitude into [-180, 180)', () => {
    expect(normaliseLongitude(190)).toBe(-170);
    expect(normaliseLongitude(-190)).toBe(170);
    expect(normaliseLongitude(180)).toBe(-180);
    expect(normaliseLongitude(540)).toBe(-180);
    expect(normaliseLongitude(45)).toBe(45);
  });
});

describe('greatCircleDistance', () => {
  it('matches analytic cases on the sphere', () => {
    const quarter = (Math.PI / 2) * EARTH_MEAN_RADIUS_M;
    expect(greatCircleDistance(EQUATOR_0, latLon(0, 90))).toBeCloseTo(quarter, 3);
    expect(greatCircleDistance(EQUATOR_0, latLon(90, 0))).toBeCloseTo(quarter, 3);
    expect(greatCircleDistance(EQUATOR_0, latLon(0, 180))).toBeCloseTo(2 * quarter, 3);
    // One degree of latitude.
    expect(greatCircleDistance(EQUATOR_0, latLon(1, 0))).toBeCloseTo(
      (Math.PI / 180) * EARTH_MEAN_RADIUS_M,
      3,
    );
  });

  it('gives a plausible real-world distance (London Heathrow to New York JFK)', () => {
    const heathrow = latLon(51.4706, -0.461941);
    const jfk = latLon(40.639447, -73.779317);
    const km = greatCircleDistance(heathrow, jfk) / 1000;
    // Published great-circle distance is about 5,540 km; allow for the spherical model.
    expect(km).toBeGreaterThan(5510);
    expect(km).toBeLessThan(5570);
  });

  it('is zero for identical points, symmetric, and never exceeds half the circumference', () => {
    fc.assert(
      fc.property(point, point, (a, b) => {
        const ab = greatCircleDistance(a, b);
        expect(greatCircleDistance(a, a)).toBe(0);
        expect(ab).toBeCloseTo(greatCircleDistance(b, a), 4);
        expect(ab).toBeGreaterThanOrEqual(0);
        expect(ab).toBeLessThanOrEqual(Math.PI * EARTH_MEAN_RADIUS_M + 1e-6);
      }),
    );
  });

  it('obeys the triangle inequality', () => {
    fc.assert(
      fc.property(point, point, point, (a, b, c) => {
        expect(greatCircleDistance(a, c)).toBeLessThanOrEqual(
          greatCircleDistance(a, b) + greatCircleDistance(b, c) + 1e-3,
        );
      }),
    );
  });
});

describe('initialBearing', () => {
  it('gives the cardinal directions', () => {
    expect(initialBearing(EQUATOR_0, latLon(10, 0))).toBeCloseTo(0, 9);
    expect(initialBearing(EQUATOR_0, latLon(0, 10))).toBeCloseTo(90, 9);
    expect(initialBearing(EQUATOR_0, latLon(-10, 0))).toBeCloseTo(180, 9);
    expect(initialBearing(EQUATOR_0, latLon(0, -10))).toBeCloseTo(270, 9);
  });

  it('stays within [0, 360)', () => {
    fc.assert(
      fc.property(point, point, (a, b) => {
        const bearing = initialBearing(a, b);
        expect(bearing).toBeGreaterThanOrEqual(0);
        expect(bearing).toBeLessThan(360);
      }),
    );
  });
});

describe('intermediatePoint', () => {
  it('returns the endpoints at fractions 0 and 1 and the midpoint at 0.5', () => {
    const to = latLon(0, 90);
    expect(intermediatePoint(EQUATOR_0, to, 0)).toEqual({ lat: 0, lon: 0 });
    const end = intermediatePoint(EQUATOR_0, to, 1);
    expect(end.lat).toBeCloseTo(0, 9);
    expect(end.lon).toBeCloseTo(90, 9);
    const mid = intermediatePoint(EQUATOR_0, to, 0.5);
    expect(mid.lat).toBeCloseTo(0, 9);
    expect(mid.lon).toBeCloseTo(45, 9);
  });

  it('lies on the route: the two partial distances add up to the whole', () => {
    fc.assert(
      fc.property(point, point, fc.double({ min: 0, max: 1, noNaN: true }), (a, b, fraction) => {
        const total = greatCircleDistance(a, b);
        // Skip near-antipodal pairs, where the great circle is not unique.
        fc.pre(total < Math.PI * EARTH_MEAN_RADIUS_M * 0.99);
        const p = intermediatePoint(a, b, fraction);
        expect(greatCircleDistance(a, p)).toBeCloseTo(total * fraction, 1);
        expect(greatCircleDistance(p, b)).toBeCloseTo(total * (1 - fraction), 1);
      }),
    );
  });

  it('crosses the antimeridian without leaving the valid longitude range', () => {
    const mid = intermediatePoint(latLon(10, 170), latLon(10, -170), 0.5);
    expect(Math.abs(mid.lon)).toBeCloseTo(180, 6);
    expect(isValidLatLon(mid.lat, mid.lon === 180 ? -180 : mid.lon)).toBe(true);
  });

  it('rejects invalid fractions and antipodal points', () => {
    expect(() => intermediatePoint(LONDON, EQUATOR_0, 1.5)).toThrow(RangeError);
    expect(() => intermediatePoint(LONDON, EQUATOR_0, Number.NaN)).toThrow(RangeError);
    expect(() => intermediatePoint(EQUATOR_0, latLon(0, 180), 0.5)).toThrow(RangeError);
  });
});

describe('destinationPoint', () => {
  it('moves along a meridian and along the equator as expected', () => {
    const oneDegree = metres((Math.PI / 180) * EARTH_MEAN_RADIUS_M);
    const north = destinationPoint(EQUATOR_0, degrees(0), oneDegree);
    expect(north.lat).toBeCloseTo(1, 9);
    expect(north.lon).toBeCloseTo(0, 9);
    const east = destinationPoint(EQUATOR_0, degrees(90), oneDegree);
    expect(east.lat).toBeCloseTo(0, 9);
    expect(east.lon).toBeCloseTo(1, 9);
  });

  it('is the inverse of distance and bearing', () => {
    fc.assert(
      fc.property(
        point,
        fc.double({ min: 0, max: 359.999, noNaN: true }),
        fc.double({ min: 1000, max: 5_000_000, noNaN: true }),
        (from, bearing, distance) => {
          const to = destinationPoint(from, degrees(bearing), metres(distance));
          expect(isValidLatLon(to.lat, to.lon)).toBe(true);
          expect(greatCircleDistance(from, to)).toBeCloseTo(distance, 1);
          // Bearing is ill-conditioned next to a pole; check it away from them.
          if (Math.abs(from.lat) < 80 && Math.abs(to.lat) < 85) {
            const diff = Math.abs(initialBearing(from, to) - bearing);
            expect(Math.min(diff, 360 - diff)).toBeLessThan(1e-4);
          }
        },
      ),
    );
  });
});

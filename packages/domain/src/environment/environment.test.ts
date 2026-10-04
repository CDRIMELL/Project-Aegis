import { describe, expect, it } from 'vitest';
import { derivePerformance, type PerformanceModel } from '../flight/performance';
import { evaluatePlan, flightProfile, generatePlan, suggestedFuelKg } from '../flight/plan';
import {
  STILL_AIR,
  advanceFlight,
  environmentClimbFactor,
  environmentFuelFactor,
  flyToCompletion,
  groundSpeedKmh,
  initialProgress,
  type Environment,
  type FlightProgress,
} from '../flight/profile';
import { routeGeometry, type RoutePoint } from '../flight/route';
import { WEATHER_SAMPLE_S, advanceInWeather, environmentFor } from './flight-weather';
import {
  STANDARD_TEMPERATURE_C,
  WEATHER,
  conditionsAt,
  hashString,
  pressureAt,
  severityWord,
  weatherModel,
  type Conditions,
} from './weather';

const EPOCH = Date.UTC(2026, 9, 4, 12, 0, 0);
const MODEL = weatherModel('weather-test', EPOCH);
const HOUR = 3600;

/** Deterministic test inputs: integer arithmetic only. */
function inputs(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
/** A place somewhere in the North Atlantic and Europe, and a time within two months. */
function sample(next: () => number) {
  return {
    position: { lat: 30 + next() * 35, lon: -30 + next() * 60 },
    tick: Math.floor(next() * 60 * 24 * HOUR),
  };
}
const view = new DataView(new ArrayBuffer(8));
function fold(hash: number, value: number): number {
  view.setFloat64(0, value);
  return (Math.imul(hash ^ view.getUint32(0), 16777619) ^ view.getUint32(4)) >>> 0;
}

function performance(category: string, cruiseSpeedKmh: number): PerformanceModel {
  const result = derivePerformance({
    category,
    engineType: 'turbofan',
    emptyMassKg: 78600,
    maxTakeoffMassKg: 141000,
    cruiseSpeedKmh,
    maxSpeedKmh: null,
    rangeKm: 3300,
    ferryRangeKm: null,
    serviceCeilingM: 12200,
  });
  if (!result.available) throw new Error('unavailable');
  return result.model;
}
const TRANSPORT = performance('transport', 781);
const aerodrome = (code: string, lat: number, lon: number): RoutePoint => ({
  kind: 'aerodrome',
  name: code,
  code,
  lat,
  lon,
  elevationM: 30,
});
const NEWQUAY = aerodrome('EGHQ', 50.4406, -4.9954);
const PRESTWICK = aerodrome('EGPK', 55.5094, -4.5867);
const AKROTIRI = aerodrome('LCRA', 34.5904, 32.9879);

describe('the weather field', () => {
  it('gives the same conditions for the same seed, time and place', () => {
    const next = inputs(1);
    for (let i = 0; i < 200; i++) {
      const { position, tick } = sample(next);
      expect(conditionsAt(MODEL, tick, position, 5000)).toEqual(
        conditionsAt(weatherModel('weather-test', EPOCH), tick, position, 5000),
      );
    }
  });

  it('differs between worlds', () => {
    const other = weatherModel('another-world', EPOCH);
    expect(other.seedHash).not.toBe(MODEL.seedHash);
    const here = { lat: 50, lon: -5 };
    const differences = [0, 6, 12, 18, 24].filter(
      (h) =>
        pressureAt(MODEL, h * HOUR, 50, -5) !== pressureAt(other, h * HOUR, here.lat, here.lon),
    );
    expect(differences.length).toBe(5);
  });

  it('produces exactly the recorded values: the same in every engine', () => {
    // 5,000 samples of every quantity, hashed bit for bit. Built only from operations every
    // engine computes identically (ADR 0020); confirmed in Node and in the application's engine.
    const next = inputs(2026);
    let hash = 2166136261;
    for (let i = 0; i < 5000; i++) {
      const { position, tick } = sample(next);
      const c = conditionsAt(MODEL, tick, position, next() * 11000);
      for (const value of [
        c.pressureHpa,
        c.windEastKmh,
        c.windNorthKmh,
        c.windFromDeg,
        c.temperatureC,
        c.cloudCover,
        c.precipitation,
        c.visibilityKm,
        c.severity,
        c.ceilingM ?? -1,
      ]) {
        hash = fold(hash, value);
      }
    }
    expect(hash.toString(16).padStart(8, '0')).toBe('c6f425ed');
  });

  it('keeps every quantity within its range', () => {
    const next = inputs(3);
    for (let i = 0; i < 5000; i++) {
      const { position, tick } = sample(next);
      const c = conditionsAt(MODEL, tick, position, next() * 12000);
      expect(c.pressureHpa).toBeGreaterThanOrEqual(WEATHER.standardPressureHpa - 30);
      expect(c.pressureHpa).toBeLessThanOrEqual(WEATHER.standardPressureHpa + 30);
      expect(c.windSpeedKmh).toBeGreaterThanOrEqual(0);
      expect(c.windSpeedKmh).toBeLessThan(450);
      expect(c.windFromDeg).toBeGreaterThanOrEqual(0);
      expect(c.windFromDeg).toBeLessThan(360);
      for (const unit of [c.cloudCover, c.precipitation, c.severity]) {
        expect(unit).toBeGreaterThanOrEqual(0);
        expect(unit).toBeLessThanOrEqual(1);
      }
      expect(c.visibilityKm).toBeGreaterThanOrEqual(2);
      expect(c.visibilityKm).toBeLessThanOrEqual(40);
      if (c.ceilingM !== null) {
        expect(c.ceilingM).toBeGreaterThanOrEqual(300);
        expect(c.ceilingM).toBeLessThanOrEqual(3000);
      }
      expect(c.temperatureC).toBeGreaterThan(-90);
      expect(c.temperatureC).toBeLessThan(50);
    }
  });

  it('changes gradually with time: no sudden swings', () => {
    const next = inputs(4);
    let worstHour = 0;
    let worstQuarter = 0;
    for (let i = 0; i < 3000; i++) {
      const { position, tick } = sample(next);
      const now = conditionsAt(MODEL, tick, position);
      const hourOn = conditionsAt(MODEL, tick + HOUR, position);
      const quarterOn = conditionsAt(MODEL, tick + 900, position);
      worstHour = Math.max(worstHour, Math.abs(hourOn.severity - now.severity));
      worstQuarter = Math.max(worstQuarter, Math.abs(quarterOn.severity - now.severity));
      expect(Math.abs(hourOn.pressureHpa - now.pressureHpa)).toBeLessThan(6);
      expect(Math.abs(hourOn.temperatureC - now.temperatureC)).toBeLessThan(3);
    }
    // Nowhere goes from benign to severe, or back, within an hour.
    expect(worstHour).toBeLessThan(0.3);
    expect(worstQuarter).toBeLessThan(0.1);
  });

  it('is continuous in space: neighbouring places have related conditions', () => {
    const next = inputs(5);
    let worst = 0;
    for (let i = 0; i < 3000; i++) {
      const { position, tick } = sample(next);
      const here = conditionsAt(MODEL, tick, position);
      // About 50 km to the north.
      const there = conditionsAt(MODEL, tick, { lat: position.lat + 0.45, lon: position.lon });
      worst = Math.max(worst, Math.abs(there.severity - here.severity));
      expect(Math.abs(there.pressureHpa - here.pressureHpa)).toBeLessThan(5);
    }
    expect(worst).toBeLessThan(0.3);
  });

  it('has no seam at the antimeridian or the poles', () => {
    for (const tick of [0, 5 * HOUR, 40 * HOUR]) {
      expect(pressureAt(MODEL, tick, 20, 180)).toBeCloseTo(pressureAt(MODEL, tick, 20, -180), 9);
      expect(pressureAt(MODEL, tick, 20, 179.999)).toBeCloseTo(
        pressureAt(MODEL, tick, 20, -179.999),
        1,
      );
      // At the pole every longitude is the same place.
      expect(pressureAt(MODEL, tick, 90, 0)).toBeCloseTo(pressureAt(MODEL, tick, 90, 137), 9);
    }
  });

  it('makes severe conditions uncommon and benign ones the norm', () => {
    const next = inputs(6);
    const total = 20_000;
    let severe = 0;
    let poor = 0;
    let wet = 0;
    let benign = 0;
    let wind = 0;
    for (let i = 0; i < total; i++) {
      const { position, tick } = sample(next);
      const c = conditionsAt(MODEL, tick, position);
      if (c.severity >= 0.75) severe++;
      if (c.severity >= 0.45) poor++;
      if (c.precipitation > 0) wet++;
      if (c.severity < 0.2) benign++;
      wind += c.windSpeedKmh;
    }
    expect(severe / total).toBeLessThan(0.02);
    expect(severe).toBeGreaterThan(0);
    expect(poor / total).toBeLessThan(0.1);
    expect(wet / total).toBeGreaterThan(0.03);
    expect(wet / total).toBeLessThan(0.25);
    expect(benign / total).toBeGreaterThan(0.35);
    // A believable mean surface wind.
    expect(wind / total).toBeGreaterThan(8);
    expect(wind / total).toBeLessThan(30);
  });

  it('blows harder aloft, and the temperature falls with height', () => {
    const next = inputs(7);
    let surface = 0;
    let aloft = 0;
    for (let i = 0; i < 2000; i++) {
      const { position, tick } = sample(next);
      const low = conditionsAt(MODEL, tick, position, 0);
      const high = conditionsAt(MODEL, tick, position, 10_000);
      surface += low.windSpeedKmh;
      aloft += high.windSpeedKmh;
      expect(high.temperatureC).toBeCloseTo(low.temperatureC - 65, 6);
      // How warm the day is does not depend on the height it is measured at.
      expect(high.temperatureDeviationC).toBe(low.temperatureDeviationC);
      expect(low.temperatureDeviationC).toBeCloseTo(low.temperatureC - STANDARD_TEMPERATURE_C, 9);
    }
    expect(aloft / surface).toBeGreaterThan(2);
  });

  it('is warmer by day than by night, and in summer than in winter', () => {
    const place = { lat: 50, lon: 0 };
    const meanOver = (from: number, hours: number) => {
      let sum = 0;
      for (let h = 0; h < hours; h++)
        sum += conditionsAt(MODEL, from + h * HOUR, place).temperatureC;
      return sum / hours;
    };
    // The epoch is noon UTC on 4 October. Afternoons against the small hours, over two weeks.
    let afternoon = 0;
    let night = 0;
    for (let day = 0; day < 14; day++) {
      afternoon += conditionsAt(MODEL, (day * 24 + 3) * HOUR, place).temperatureC;
      night += conditionsAt(MODEL, (day * 24 + 15) * HOUR, place).temperatureC;
    }
    expect(afternoon).toBeGreaterThan(night);
    const january = meanOver(100 * 24 * HOUR, 24 * 20);
    const july = meanOver(280 * 24 * HOUR, 24 * 20);
    expect(july).toBeGreaterThan(january + 10);
  });

  it('has the wind circulate around low pressure, opposite ways in each hemisphere', () => {
    // With pressure rising to the east, the northern wind blows from the south, and the southern
    // wind from the north: low pressure is to the left in the north, to the right in the south.
    const next = inputs(8);
    let northAgrees = 0;
    let southAgrees = 0;
    let counted = 0;
    for (let i = 0; i < 4000 && counted < 600; i++) {
      const lat = 35 + next() * 25;
      const lon = -40 + next() * 80;
      const tick = Math.floor(next() * 30 * 24 * HOUR);
      const gradientEast =
        pressureAt(MODEL, tick, lat, lon + 1) - pressureAt(MODEL, tick, lat, lon - 1);
      if (Math.abs(gradientEast) < 1) continue;
      counted++;
      const north = conditionsAt(MODEL, tick, { lat, lon });
      if (Math.sign(north.windNorthKmh) === Math.sign(gradientEast)) northAgrees++;
      const southEast =
        pressureAt(MODEL, tick, -lat, lon + 1) - pressureAt(MODEL, tick, -lat, lon - 1);
      const south = conditionsAt(MODEL, tick, { lat: -lat, lon });
      if (Math.abs(southEast) >= 1 && Math.sign(south.windNorthKmh) === -Math.sign(southEast)) {
        southAgrees++;
      }
    }
    expect(counted).toBeGreaterThan(200);
    expect(northAgrees / counted).toBeGreaterThan(0.95);
    expect(southAgrees).toBeGreaterThan(0);
  });

  it('names severity in plain words', () => {
    expect([0, 0.19, 0.2, 0.44, 0.45, 0.74, 0.75, 1].map(severityWord)).toEqual([
      'Benign',
      'Benign',
      'Unsettled',
      'Unsettled',
      'Poor',
      'Poor',
      'Severe',
      'Severe',
    ]);
  });

  it('hashes a seed with integer arithmetic only', () => {
    expect(hashString('')).toBe(0x811c9dc5);
    expect(hashString('a')).toBe(0xe40c292c);
    expect(hashString('aegis')).not.toBe(hashString('Aegis'));
  });
});

describe('the environment and the flight step', () => {
  const still = (overrides: Partial<Environment>): Environment => ({ ...STILL_AIR, ...overrides });
  const plan = generatePlan(TRANSPORT, PRESTWICK, AKROTIRI);
  const profile = flightProfile(TRANSPORT, plan, 0);
  const fly = (environment: Environment) =>
    flyToCompletion(profile, 40_000, 1, (progress) =>
      advanceFlight(profile, progress, 1, environment),
    );
  const calm = fly(STILL_AIR);

  it('splits the wind into along-track and across-track parts', () => {
    const wind = { windEastKmh: 100, windNorthKmh: 0 } as Conditions;
    // A westerly: a tailwind flying east, a headwind flying west, a crosswind flying north.
    expect(environmentFor(wind, 90).tailwindKmh).toBeCloseTo(100, 9);
    expect(environmentFor(wind, 90).crosswindKmh).toBeCloseTo(0, 9);
    expect(environmentFor(wind, 270).tailwindKmh).toBeCloseTo(-100, 9);
    expect(environmentFor(wind, 0).tailwindKmh).toBeCloseTo(0, 9);
    expect(Math.abs(environmentFor(wind, 0).crosswindKmh)).toBeCloseTo(100, 9);
    const diagonal = environmentFor(wind, 45);
    expect(diagonal.tailwindKmh).toBeCloseTo(70.71, 1);
    expect(Math.abs(diagonal.crosswindKmh)).toBeCloseTo(70.71, 1);
  });

  it('adds a tailwind to ground speed and takes a headwind from it', () => {
    expect(groundSpeedKmh(800, STILL_AIR)).toBe(800);
    expect(groundSpeedKmh(800, still({ tailwindKmh: 100 }))).toBe(900);
    expect(groundSpeedKmh(800, still({ tailwindKmh: -100 }))).toBe(700);
    expect(groundSpeedKmh(100, still({ tailwindKmh: -150 }))).toBe(0);
  });

  it('makes the aircraft crab in a crosswind, which costs speed along the track', () => {
    // 600 across at 1,000 airspeed leaves 800 along the track: a 3-4-5 triangle.
    expect(groundSpeedKmh(1000, still({ crosswindKmh: 600 }))).toBe(800);
    expect(groundSpeedKmh(1000, still({ crosswindKmh: -600 }))).toBe(800);
    // A crosswind stronger than the airspeed stops progress; it cannot blow the aircraft backwards.
    expect(groundSpeedKmh(100, still({ crosswindKmh: 300 }))).toBe(0);
  });

  it('shortens a flight in a tailwind and lengthens it in a headwind', () => {
    const tailwind = fly(still({ tailwindKmh: 80 }));
    const headwind = fly(still({ tailwindKmh: -80 }));
    expect(tailwind.elapsedS).toBeLessThan(calm.elapsedS);
    expect(headwind.elapsedS).toBeGreaterThan(calm.elapsedS);
    // Fuel is burned for the air flown through: a headwind costs fuel, a tailwind saves it.
    expect(40_000 - headwind.fuelKg).toBeGreaterThan(40_000 - calm.fuelKg);
    expect(40_000 - tailwind.fuelKg).toBeLessThan(40_000 - calm.fuelKg);
    // The same distance over the ground either way.
    expect(tailwind.distanceM).toBeCloseTo(calm.distanceM, 6);
    expect(headwind.distanceM).toBeCloseTo(calm.distanceM, 6);
  });

  it('lengthens a flight in a crosswind, whichever side it blows from', () => {
    const fromLeft = fly(still({ crosswindKmh: 120 }));
    const fromRight = fly(still({ crosswindKmh: -120 }));
    expect(fromLeft.elapsedS).toBeGreaterThan(calm.elapsedS);
    expect(fromLeft).toEqual({ ...fromRight, environment: fromLeft.environment });
    // A crosswind costs far less than the same wind on the nose.
    expect(fromLeft.elapsedS).toBeLessThan(fly(still({ tailwindKmh: -120 })).elapsedS);
  });

  it('burns more on a warm day and in precipitation, by the stated assumptions', () => {
    expect(environmentFuelFactor(STILL_AIR)).toBe(1);
    expect(environmentFuelFactor(still({ temperatureDeviationC: 10 }))).toBeCloseTo(1.02, 9);
    expect(environmentFuelFactor(still({ temperatureDeviationC: -10 }))).toBeCloseTo(0.98, 9);
    expect(environmentFuelFactor(still({ precipitation: 1 }))).toBeCloseTo(1.03, 9);
    // Beyond the range the assumption is meant for, the effect stops growing.
    expect(environmentFuelFactor(still({ temperatureDeviationC: 80 }))).toBeCloseTo(1.06, 9);

    const warm = fly(still({ temperatureDeviationC: 20 }));
    const wet = fly(still({ precipitation: 0.8 }));
    expect(40_000 - warm.fuelKg).toBeGreaterThan(40_000 - calm.fuelKg);
    expect(40_000 - wet.fuelKg).toBeGreaterThan(40_000 - calm.fuelKg);
    // Precipitation costs fuel, not time.
    expect(wet.elapsedS).toBe(calm.elapsedS);
  });

  it('climbs more slowly on a warm day, and no faster on a cold one', () => {
    expect(environmentClimbFactor(STILL_AIR)).toBe(1);
    expect(environmentClimbFactor(still({ temperatureDeviationC: 20 }))).toBeCloseTo(0.7, 9);
    expect(environmentClimbFactor(still({ temperatureDeviationC: -20 }))).toBe(1);
    const reachesCruise = (environment: Environment) => {
      let progress: FlightProgress = initialProgress(profile, 40_000);
      while (progress.phase !== 'cruise')
        progress = advanceFlight(profile, progress, 1, environment);
      return progress.elapsedS;
    };
    expect(reachesCruise(still({ temperatureDeviationC: 20 }))).toBeGreaterThan(
      reachesCruise(STILL_AIR),
    );
  });

  it('leaves a still-air flight exactly as it was before the environment existed', () => {
    const explicit = flyToCompletion(profile, 40_000, 1);
    const throughNoWeather = flyToCompletion(profile, 40_000, 1, (progress) =>
      advanceInWeather(profile, progress, 1, null),
    );
    expect(throughNoWeather).toEqual(explicit);
    expect(calm).toEqual(explicit);
    expect(explicit.environment).toEqual(STILL_AIR);
    expect(explicit.exposure.worstSeverity).toBe(0);
  });
});

describe('flying through the world’s weather', () => {
  const plan = generatePlan(TRANSPORT, NEWQUAY, AKROTIRI);
  const route = routeGeometry(plan.points);
  const profile = flightProfile(TRANSPORT, plan, 10_000);
  const context = (departureTick: number) => ({ weather: MODEL, route, departureTick });
  const fly = (departureTick: number, fuelKg = 45_000) =>
    flyToCompletion(profile, fuelKg, 1, (progress) =>
      advanceInWeather(profile, progress, 1, context(departureTick)),
    );

  it('samples the weather once a minute and holds it in between', () => {
    let progress = initialProgress(profile, 45_000);
    const samples = new Set<string>();
    for (let step = 0; step < 600; step++) {
      const before = progress.environment;
      progress = advanceInWeather(profile, progress, 1, context(0));
      if (step % WEATHER_SAMPLE_S !== 0) expect(progress.environment).toBe(before);
      samples.add(JSON.stringify(progress.environment));
    }
    expect(samples.size).toBe(600 / WEATHER_SAMPLE_S);
  });

  it('is deterministic, and depends on when the flight leaves', () => {
    const now = fly(0);
    expect(fly(0)).toEqual(now);
    const tomorrow = fly(30 * HOUR);
    expect(tomorrow.elapsedS).not.toBe(now.elapsedS);
    expect(tomorrow.fuelKg).not.toBe(now.fuelKg);
  });

  it('records what the flight met', () => {
    const end = fly(0);
    expect(end.phase).toBe('landed');
    expect(end.exposure.lowestVisibilityKm).not.toBeNull();
    expect(end.exposure.worstSeverity).toBeGreaterThanOrEqual(0);
    expect(end.exposure.heaviestPrecipitation).toBeLessThanOrEqual(1);
    // The mean wind along the track is a real wind, not noise.
    expect(Math.abs(end.exposure.tailwindKmhS / end.elapsedS)).toBeLessThan(250);
  });

  it('carries on identically when resumed from saved progress', () => {
    let progress = initialProgress(profile, 45_000);
    for (let step = 0; step < 5000; step++)
      progress = advanceInWeather(profile, progress, 1, context(0));
    // As if written to disk mid-minute and read back.
    let restored = JSON.parse(JSON.stringify(progress)) as FlightProgress;
    for (let step = 0; step < 4000; step++) {
      progress = advanceInWeather(profile, progress, 1, context(0));
      restored = advanceInWeather(profile, restored, 1, context(0));
    }
    expect(restored).toEqual(progress);
  });

  it('gives the planner the same result as flying it: estimate equals outcome under weather', () => {
    for (const departureTick of [0, 7 * HOUR, 53 * HOUR]) {
      const world = { weather: MODEL, departureTick };
      const fuelKg = suggestedFuelKg(TRANSPORT, plan, 10_000, world) as number;
      const estimate = evaluatePlan(TRANSPORT, plan, { fuelKg, payloadKg: 10_000 }, world).estimate;
      const flown = fly(departureTick, fuelKg);
      expect(estimate?.durationS).toBe(flown.elapsedS);
      expect(estimate?.fuelAtDestinationKg).toBe(flown.fuelKg);
      expect(estimate?.completes).toBe(true);
    }
  });

  it('states what the weather costs against the same plan in still air', () => {
    const world = { weather: MODEL, departureTick: 0 };
    const load = { fuelKg: TRANSPORT.fuelCapacityKg, payloadKg: 0 };
    const inWeather = evaluatePlan(TRANSPORT, plan, load, world).estimate;
    const inStillAir = evaluatePlan(TRANSPORT, plan, load).estimate;
    expect(inStillAir?.weather).toBeNull();
    expect(inWeather?.weather).toMatchObject({
      stillAirDurationS: inStillAir?.durationS,
    });
    expect(inWeather?.weather?.stillAirFuelUsedKg).toBeCloseTo(inStillAir?.fuelUsedKg ?? 0, 6);
    // The mean wind explains the difference in time, in the right direction.
    const extraS = (inWeather?.durationS ?? 0) - (inStillAir?.durationS ?? 0);
    expect(Math.sign(extraS)).toBe(-Math.sign(inWeather?.weather?.meanTailwindKmh ?? 0));
    expect(inWeather?.weather?.departure).toEqual(conditionsAt(MODEL, 0, NEWQUAY, 0));
    expect(inWeather?.weather?.arrival).toEqual(
      conditionsAt(MODEL, inWeather?.durationS ?? 0, AKROTIRI, 0),
    );
  });

  it('compares against still air with the same fuel aboard, because burn depends on mass', () => {
    const world = { weather: MODEL, departureTick: 0 };
    // Well short of full tanks: a lighter aircraft, which burns less.
    const fuelKg = suggestedFuelKg(TRANSPORT, plan, 0, world) as number;
    expect(fuelKg).toBeLessThan(TRANSPORT.fuelCapacityKg * 0.9);
    const load = { fuelKg, payloadKg: 0 };
    const inWeather = evaluatePlan(TRANSPORT, plan, load, world).estimate;
    const inStillAir = evaluatePlan(TRANSPORT, plan, load).estimate;
    expect(inStillAir?.completes).toBe(true);
    expect(inWeather?.weather?.stillAirFuelUsedKg).toBe(inStillAir?.fuelUsedKg);
    expect(inWeather?.weather?.stillAirDurationS).toBe(inStillAir?.durationS);
  });

  it('loads enough fuel for the weather, where still-air fuel would fall short', () => {
    // Find a departure with a real headwind and check the suggested fuel still arrives on reserve.
    let checked = 0;
    // Westbound across the Mediterranean, into the prevailing wind aloft.
    const westbound = generatePlan(TRANSPORT, AKROTIRI, aerodrome('LIRF', 41.8003, 12.2389));
    const full = { fuelKg: TRANSPORT.fuelCapacityKg, payloadKg: 0 };
    const stillAirFuel = suggestedFuelKg(TRANSPORT, westbound, 0) as number;
    for (let hour = 0; hour < 2000 && checked < 3; hour += 5) {
      const world = { weather: MODEL, departureTick: hour * HOUR };
      const estimate = evaluatePlan(TRANSPORT, westbound, full, world).estimate;
      if ((estimate?.weather?.meanTailwindKmh ?? 0) > -25) continue;
      const weatherFuel = suggestedFuelKg(TRANSPORT, westbound, 0, world);
      // A headwind too strong for full tanks cannot be flown at all; that is a different case.
      if (weatherFuel === null || weatherFuel >= TRANSPORT.fuelCapacityKg) continue;
      checked++;
      expect(weatherFuel).toBeGreaterThan(stillAirFuel);
      const arrives = evaluatePlan(
        TRANSPORT,
        westbound,
        { fuelKg: weatherFuel, payloadKg: 0 },
        world,
      ).estimate;
      expect(arrives?.fuelAtDestinationKg).toBeGreaterThanOrEqual(TRANSPORT.reserveFuelKg);
      // The still-air load, flown in that wind, lands short of the reserve.
      const short = evaluatePlan(
        TRANSPORT,
        westbound,
        { fuelKg: stillAirFuel, payloadKg: 0 },
        world,
      ).estimate;
      expect(short?.fuelAtDestinationKg ?? 0).toBeLessThan(TRANSPORT.reserveFuelKg);
    }
    expect(checked).toBe(3);
  });
});

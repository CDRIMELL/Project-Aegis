import { PI, TWO_PI, atan2, cos, sin } from '../math';
import type { LatLon } from '../geo';

/*
 * The simulated environment (ADR 0021).
 *
 * The weather at a place and time is a pure function of the world seed, the simulation tick and
 * the position. Nothing is stored and nothing is rolled per step: the same inputs always give the
 * same weather, which is what lets the planner fly a plan through the very conditions the
 * simulation will fly it through.
 *
 * It is built from smooth noise sampled on the unit sphere and in time, using only the operations
 * every engine computes identically (ADR 0020). It aims to be plausible, stable and useful to the
 * simulation. It is not meteorology, and every number below is a simulation assumption.
 */

/** Simulation assumptions that shape the weather. Not reference data. */
export const WEATHER = {
  /** Lattice cells per Earth radius. 5 gives systems about 1,300 km across. */
  systemFrequency: 5,
  /** Ticks for a system to change character: about two days. */
  systemPeriodTicks: 48 * 3600,
  detailFrequency: 14,
  detailPeriodTicks: 20 * 3600,
  detailWeight: 0.25,
  /** Systems drift eastwards by this many degrees of longitude per hour. */
  driftDegPerHour: 0.5,
  standardPressureHpa: 1013,
  pressureRangeHpa: 20,
  /** km/h of surface wind per hPa of pressure difference across 100 km. */
  windPerGradient: 7,
  maxSurfaceWindKmh: 110,
  /** Wind at 10 km is this many times the surface wind. */
  windAloftFactor: 3,
  /** Westerly wind added at altitude in the mid-latitudes, at its strongest. */
  jetKmh: 70,
  /** Distance over which the pressure gradient is measured. */
  gradientSpanM: 60_000,
  lapseCPerKm: 6.5,
  tropopauseM: 11_000,
} as const;

/** Standard sea-level temperature, against which the flight model measures warm and cold days. */
export const STANDARD_TEMPERATURE_C = 15;

/** What identifies a world's weather: its seed and the instant of tick 0. */
export interface WeatherModel {
  /** 32-bit hash of the world seed. */
  readonly seedHash: number;
  /** Simulation instant at tick 0, Unix milliseconds. Fixes the season and the time of day. */
  readonly epochMs: number;
}

/** The weather at one place, one altitude and one instant. */
export interface Conditions {
  /** Sea-level pressure, hPa. */
  readonly pressureHpa: number;
  /** Direction the wind blows FROM, degrees true, at the sampled altitude. */
  readonly windFromDeg: number;
  readonly windSpeedKmh: number;
  /** The same wind as a vector: positive east and positive north, km/h. */
  readonly windEastKmh: number;
  readonly windNorthKmh: number;
  /** Air temperature at the sampled altitude, °C. */
  readonly temperatureC: number;
  /** Surface temperature minus the standard 15 °C: how warm or cold the day is. */
  readonly temperatureDeviationC: number;
  /** Fraction of the sky covered, 0 to 1. */
  readonly cloudCover: number;
  /** Height of the cloud base above the surface, metres; `null` when there is no ceiling. */
  readonly ceilingM: number | null;
  /** Intensity of precipitation, 0 (none) to 1 (heaviest). */
  readonly precipitation: number;
  readonly visibilityKm: number;
  /** 0 (benign) to 1 (severe): the worst of surface wind, precipitation and visibility. */
  readonly severity: number;
}

/** FNV-1a over the characters of a string. Integer arithmetic only. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function weatherModel(seed: string, epochMs: number): WeatherModel {
  return { seedHash: hashString(`${seed}\u0000weather`), epochMs };
}

/** A value in [-1, 1) for one lattice point of one field. Integer mixing only. */
function lattice(
  seedHash: number,
  field: number,
  x: number,
  y: number,
  z: number,
  t: number,
): number {
  let h = seedHash ^ Math.imul(field, 0x9e3779b1);
  h = Math.imul(h ^ x, 0x85ebca6b);
  h = (h << 13) | (h >>> 19);
  h = Math.imul(h ^ y, 0xc2b2ae35);
  h = (h << 13) | (h >>> 19);
  h = Math.imul(h ^ z, 0x27d4eb2f);
  h = (h << 13) | (h >>> 19);
  h = Math.imul(h ^ t, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 2147483648 - 1;
}

/** Quintic ease: zero slope and curvature at both ends, so the noise has no creases. */
const ease = (f: number) => f * f * f * (f * (f * 6 - 15) + 10);

/** Smooth noise in four dimensions, in roughly [-1, 1]. */
function noise4(
  seedHash: number,
  field: number,
  x: number,
  y: number,
  z: number,
  t: number,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const t0 = Math.floor(t);
  const fx = ease(x - x0);
  const fy = ease(y - y0);
  const fz = ease(z - z0);
  const ft = ease(t - t0);
  let total = 0;
  for (let corner = 0; corner < 16; corner++) {
    const dx = corner & 1;
    const dy = (corner >> 1) & 1;
    const dz = (corner >> 2) & 1;
    const dt = (corner >> 3) & 1;
    const weight =
      (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz) * (dt ? ft : 1 - ft);
    total += weight * lattice(seedHash, field, x0 + dx, y0 + dy, z0 + dz, t0 + dt);
  }
  return total;
}

const toRadians = (deg: number) => (deg * PI) / 180;
const clamp01 = (value: number) => Math.min(Math.max(value, 0), 1);

/**
 * One field at one place and time: large systems plus finer detail, in roughly [-1.35, 1.35].
 * The place is a point on the unit sphere, so the field has no seam anywhere on the globe.
 */
function fieldAt(
  model: WeatherModel,
  field: number,
  tick: number,
  lat: number,
  lon: number,
): number {
  const W = WEATHER;
  // Systems drift east: sample where the air now here was `drift` degrees of longitude ago.
  const drifted = lon - (W.driftDegPerHour * tick) / 3600;
  const phi = toRadians(lat);
  const lambda = toRadians(drifted);
  const cosPhi = cos(phi);
  const x = cosPhi * cos(lambda);
  const y = cosPhi * sin(lambda);
  const z = sin(phi);
  const large = noise4(
    model.seedHash,
    field,
    x * W.systemFrequency,
    y * W.systemFrequency,
    z * W.systemFrequency,
    tick / W.systemPeriodTicks,
  );
  const detail = noise4(
    model.seedHash,
    field + 100,
    x * W.detailFrequency,
    y * W.detailFrequency,
    z * W.detailFrequency,
    tick / W.detailPeriodTicks,
  );
  return large + W.detailWeight * detail;
}

const PRESSURE_FIELD = 1;
const MOISTURE_FIELD = 2;
const TEMPERATURE_FIELD = 3;

/** Value noise clusters near zero; this stretch spreads it over the range the model wants. */
const SPREAD = 1.5;

const EARTH_RADIUS_M = 6_371_008.8;
const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365.2425;
/** Day of the year on which the northern hemisphere is warmest. */
const WARMEST_DAY = 200;

/** Sea-level pressure at a place and time, hPa. */
export function pressureAt(model: WeatherModel, tick: number, lat: number, lon: number): number {
  const anomaly = Math.max(
    Math.min(fieldAt(model, PRESSURE_FIELD, tick, lat, lon) * SPREAD, 1.5),
    -1.5,
  );
  return WEATHER.standardPressureHpa + WEATHER.pressureRangeHpa * anomaly;
}

/**
 * The weather at a place, an altitude and a tick.
 *
 * Wind follows the pressure field: it blows along the lines of equal pressure, anticlockwise
 * around a low in the northern hemisphere and clockwise in the southern, and strengthens with
 * height. Cloud, precipitation and visibility follow moisture and low pressure.
 */
export function conditionsAt(
  model: WeatherModel,
  tick: number,
  position: LatLon,
  altitudeM = 0,
): Conditions {
  const W = WEATHER;
  const { lat, lon } = position;
  const pressureHpa = pressureAt(model, tick, lat, lon);

  // Pressure gradient by central differences, in hPa per 100 km east and north.
  const spanDegLat = ((W.gradientSpanM / EARTH_RADIUS_M) * 180) / PI;
  const cosLat = Math.max(cos(toRadians(lat)), 0.05);
  const spanDegLon = spanDegLat / cosLat;
  const north = Math.min(lat + spanDegLat, 89.9);
  const south = Math.max(lat - spanDegLat, -89.9);
  const per100Km = 100_000 / (2 * W.gradientSpanM);
  const gradientEast =
    (pressureAt(model, tick, lat, lon + spanDegLon) -
      pressureAt(model, tick, lat, lon - spanDegLon)) *
    per100Km;
  const gradientNorth =
    (pressureAt(model, tick, north, lon) - pressureAt(model, tick, south, lon)) * per100Km;

  // Along the isobars, with low pressure to the left in the north and to the right in the south.
  // The turning fades to nothing at the equator, as it does on the real Earth.
  const turning = Math.max(Math.min(lat / 15, 1), -1);
  let east = -gradientNorth * W.windPerGradient * turning;
  let northward = gradientEast * W.windPerGradient * turning;
  const surfaceSpeed = Math.sqrt(east * east + northward * northward);
  if (surfaceSpeed > W.maxSurfaceWindKmh) {
    east *= W.maxSurfaceWindKmh / surfaceSpeed;
    northward *= W.maxSurfaceWindKmh / surfaceSpeed;
  }
  const surfaceWindKmh = Math.min(surfaceSpeed, W.maxSurfaceWindKmh);

  // Aloft: stronger, plus a westerly stream in the mid-latitudes.
  const height = Math.min(Math.max(altitudeM, 0) / 10_000, 1.3);
  const aloft = 1 + (W.windAloftFactor - 1) * height;
  const offMidLatitude = (Math.abs(lat) - 45) / 25;
  const jet = W.jetKmh * height * Math.max(1 - offMidLatitude * offMidLatitude, 0);
  const windEastKmh = east * aloft + jet;
  const windNorthKmh = northward * aloft;
  const windSpeedKmh = Math.sqrt(windEastKmh * windEastKmh + windNorthKmh * windNorthKmh);
  const windFromDeg = windSpeedKmh < 0.01 ? 0 : bearingFrom(windEastKmh, windNorthKmh);

  // Moisture and low pressure make cloud; a lot of both makes precipitation.
  const moisture = fieldAt(model, MOISTURE_FIELD, tick, lat, lon) * SPREAD;
  const low = (W.standardPressureHpa - pressureHpa) / W.pressureRangeHpa;
  const wetness = 0.45 + 0.55 * moisture + 0.45 * low;
  const cloudCover = clamp01(wetness);
  const precipitation = clamp01((wetness - 0.95) / 0.75);
  const overcast = clamp01((cloudCover - 0.5) / 0.5);
  const ceilingM =
    cloudCover < 0.5 ? null : Math.round(3000 - 2700 * clamp01(overcast * 0.6 + precipitation));
  const visibilityKm = 40 - 38 * clamp01(precipitation * 0.9 + overcast * 0.25);

  // Temperature: latitude, season, time of day, and a little of its own noise.
  const ms = model.epochMs + tick * 1000;
  const days = ms / MS_PER_DAY;
  const yearFraction = days / DAYS_PER_YEAR - Math.floor(days / DAYS_PER_YEAR);
  const season = cos(TWO_PI * (yearFraction - WARMEST_DAY / DAYS_PER_YEAR));
  const hemisphere = Math.max(Math.min(lat / 20, 1), -1);
  const localHour = (days - Math.floor(days)) * 24 + lon / 15;
  const daily = cos((TWO_PI * (localHour - 15)) / 24);
  const surfaceC =
    30 -
    0.0066 * lat * lat +
    12 * Math.min(Math.abs(lat) / 45, 1.3) * season * hemisphere +
    4 * daily +
    5 * fieldAt(model, TEMPERATURE_FIELD, tick, lat, lon) * SPREAD * 0.5;
  const temperatureC =
    surfaceC - (W.lapseCPerKm * Math.min(Math.max(altitudeM, 0), W.tropopauseM)) / 1000;

  const severity = clamp01(Math.max(surfaceWindKmh / 90, precipitation, (8 - visibilityKm) / 8));

  return {
    pressureHpa,
    windFromDeg,
    windSpeedKmh,
    windEastKmh,
    windNorthKmh,
    temperatureC,
    temperatureDeviationC: surfaceC - STANDARD_TEMPERATURE_C,
    cloudCover,
    ceilingM,
    precipitation,
    visibilityKm,
    severity,
  };
}

/**
 * The direction a wind blows from, in degrees true, given its eastward and northward parts.
 */
function bearingFrom(eastKmh: number, northKmh: number): number {
  // The wind blows towards (east, north); it comes from the opposite direction.
  const towards = toDegrees(atan2(eastKmh, northKmh));
  return (towards + 180 + 360) % 360;
}

const toDegrees = (rad: number) => (rad * 180) / PI;

export type ConditionWord = 'Benign' | 'Unsettled' | 'Poor' | 'Severe';

/** A plain word for a severity index. */
export function severityWord(severity: number): ConditionWord {
  if (severity >= 0.75) return 'Severe';
  if (severity >= 0.45) return 'Poor';
  if (severity >= 0.2) return 'Unsettled';
  return 'Benign';
}

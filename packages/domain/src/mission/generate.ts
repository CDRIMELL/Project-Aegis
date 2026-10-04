import type { PerformanceModel } from '../flight/performance';
import type { RoutePoint } from '../flight/route';
import { destinationPoint, greatCircleDistance } from '../geo';
import type { Rng } from '../rng';
import { degrees, metres } from '../units';
import { MISSION_GEOMETRY, MISSION_TEMPLATES, type MissionTemplate } from './templates';
import {
  MISSION_TYPES,
  type MissionBrief,
  type MissionPriority,
  type MissionType,
  type NamedPoint,
} from './types';

/*
 * World-generated opportunities (ADR 0017).
 *
 * The simulated world occasionally asks for something to be flown. Every opportunity is fictional
 * and is built around an aircraft the player actually has, so it can be flown. The only places
 * used are the public aerodromes of the world's operating area and positions derived from them.
 */

/** Simulation assumptions that pace generation. Not reference data. */
export const GENERATION = {
  /** Generation is considered once per this many ticks. */
  intervalTicks: 3600,
  /** No opportunity is generated while this many are waiting for an answer. */
  maxOpenOffers: 3,
  /** Chance that a considered hour produces an opportunity. */
  chancePerInterval: 0.4,
  /** How long the player has to answer, in seconds. */
  answerWindowS: [2 * 3600, 6 * 3600],
  /** Time allowed to finish a mission that is not time-critical, after the answer window. */
  routineWindowS: [18 * 3600, 36 * 3600],
  /** Share of the anchor aircraft's published range a one-way trip may use. */
  oneWayRangeShare: 0.45,
  /** Share of it an out-and-back or orbit may reach out to. */
  radiusRangeShare: 0.25,
  minDistanceM: 80_000,
  maxAreaDistanceM: 500_000,
  /** Payload asked for, as a share of the anchor aircraft's maximum payload. */
  payloadShare: [0.08, 0.3],
} as const;

/** How often each type is offered, relative to the others. */
const TYPE_WEIGHTS: Readonly<Record<MissionType, number>> = {
  training: 3,
  logistics: 3,
  transport: 2,
  patrol: 1,
  reconnaissance: 1,
  ferry: 1,
  emergency_response: 1,
  intercept: 1,
  search_and_rescue: 1,
  exercise: 1,
};

/** What generation needs to know about an aircraft. */
export interface GenerationAircraft {
  readonly category: string;
  readonly performance: PerformanceModel | null;
  /** `null` while airborne. */
  readonly location: RoutePoint | null;
}

export interface GenerationInput {
  readonly rng: Rng;
  readonly tick: number;
  /** The operating area: public aerodromes copied into the world. */
  readonly places: readonly RoutePoint[];
  readonly aircraft: readonly GenerationAircraft[];
  readonly openOffers: number;
  /** Ordinal of the next opportunity, used only to name simulated areas. */
  readonly ordinal: number;
}

export interface Opportunity {
  readonly type: MissionType;
  readonly title: string;
  readonly description: string;
  readonly priority: MissionPriority;
  readonly brief: MissionBrief;
  readonly expiresTick: number;
  readonly completeByTick: number;
}

const COMPASS = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
];

const between = (rng: Rng, [low, high]: readonly [number, number]) =>
  low + rng.nextFloat() * (high - low);
const pick = <T>(rng: Rng, items: readonly T[]): T => items[rng.nextInt(0, items.length)] as T;
const placeName = (place: RoutePoint) =>
  place.code ? `${place.name} (${place.code})` : place.name;

function pickType(rng: Rng, candidates: readonly MissionTemplate[]): MissionTemplate {
  const total = candidates.reduce((sum, candidate) => sum + TYPE_WEIGHTS[candidate.type], 0);
  let roll = rng.nextFloat() * total;
  for (const candidate of candidates) {
    roll -= TYPE_WEIGHTS[candidate.type];
    if (roll < 0) return candidate;
  }
  return candidates.at(-1) as MissionTemplate;
}

/**
 * Considers generating one opportunity. Returns `null` when the hour produces nothing: offers are
 * already waiting, the dice say no, no aircraft could fly one, or nowhere suitable is in reach.
 * Deterministic for a given generator state and input.
 */
export function generateOpportunity(input: GenerationInput): Opportunity | null {
  const { rng, tick } = input;
  if (input.openOffers >= GENERATION.maxOpenOffers || input.places.length === 0) return null;
  if (!rng.chance(GENERATION.chancePerInterval)) return null;

  // Anchor the opportunity on an aircraft that is on the ground and able to fly.
  const anchors = input.aircraft.filter(
    (aircraft) => aircraft.location !== null && aircraft.performance !== null,
  );
  if (anchors.length === 0) return null;
  const anchor = pick(rng, anchors);
  const model = anchor.performance as PerformanceModel;
  const base = anchor.location as RoutePoint;

  const suitable = MISSION_TYPES.map((type) => MISSION_TEMPLATES[type]).filter((candidate) =>
    candidate.suitableCategories.includes(anchor.category),
  );
  if (suitable.length === 0) return null;
  const template = pickType(rng, suitable);

  const rangeM = model.referenceRangeKm * 1000;
  let destination: RoutePoint | null = null;
  let target: NamedPoint | null = null;
  let distanceM: number;
  let where: string;

  if (template.shape === 'point_to_point') {
    const reachM = rangeM * GENERATION.oneWayRangeShare;
    const inReach = input.places.filter((place) => {
      const d = greatCircleDistance(base, place);
      return d >= GENERATION.minDistanceM && d <= reachM;
    });
    if (inReach.length === 0) return null;
    destination = pick(rng, inReach);
    distanceM = greatCircleDistance(base, destination);
    where = placeName(destination);
  } else {
    const reachM = Math.min(rangeM * GENERATION.radiusRangeShare, GENERATION.maxAreaDistanceM);
    if (reachM < GENERATION.minDistanceM) return null;
    distanceM = between(rng, [GENERATION.minDistanceM, reachM]);
    const sector = rng.nextInt(0, COMPASS.length);
    const bearing = sector * 45 + between(rng, [-20, 20]);
    const position = destinationPoint(base, degrees((bearing + 360) % 360), metres(distanceM));
    target = { name: `Area ${input.ordinal}`, lat: position.lat, lon: position.lon };
    where = `${target.name}, ${Math.round(distanceM / 1000)} km ${COMPASS[sector] as string} of ${base.name}`;
  }

  const payloadKg = template.carriesPayload
    ? Math.max(
        Math.round((model.maxPayloadKg * between(rng, GENERATION.payloadShare)) / 100) * 100,
        100,
      )
    : 0;

  const answerS = Math.round(between(rng, GENERATION.answerWindowS) / 60) * 60;
  const expiresTick = tick + answerS;
  const legs = template.shape === 'point_to_point' ? 1 : 2;
  const flyingS = ((distanceM * legs) / 1000 / model.cruiseSpeedKmh) * 3600 + template.holdS;
  // A time-critical mission allows the flight, some margin and time to prepare; others, a day or so.
  const completeByTick = template.timeCritical
    ? expiresTick + Math.round((flyingS * 1.5 + 3600) / 60) * 60
    : expiresTick + Math.round(between(rng, GENERATION.routineWindowS) / 60) * 60;

  const brief: MissionBrief = {
    shape: template.shape,
    destination,
    target,
    orbitRadiusM: MISSION_GEOMETRY.orbitRadiusM,
    holdS: template.holdS,
    payloadKg,
  };
  return {
    type: template.type,
    title: `${template.label}: ${where}`,
    description: `Simulated requirement. ${template.description}`,
    priority: template.priority,
    brief,
    expiresTick,
    completeByTick,
  };
}

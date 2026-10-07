import type { PerformanceModel } from '../flight/performance';
import type { RoutePoint } from '../flight/route';
import { destinationPoint, greatCircleDistance } from '../geo';
import type { Rng } from '../rng';
import { degrees, metres } from '../units';
import { GENERATION } from './generate';
import { MISSION_GEOMETRY, MISSION_TEMPLATES, type MissionTemplate } from './templates';
import type { MissionBrief, MissionType, NamedPoint } from './types';

/*
 * Routine operations (ADR 0030).
 *
 * In a career the simulated world tasks ordinary sorties itself, so that it is operating whether
 * or not the commander is looking. A routine task is a brief for an aircraft the world may use;
 * the mission layer turns it into an ordinary mission and flies it with the ordinary rules.
 * Everything here is fictional, and the only places used are the public aerodromes of the
 * operating area, the aircraft's own base, and positions derived from them.
 */

/** Simulation assumptions that pace routine operations. Not reference data. */
export const ROUTINE = {
  /** Tasking is considered once per this many ticks. */
  intervalTicks: 900,
  /** Chance that a considered interval tasks an aircraft. */
  chancePerInterval: 0.35,
  /** Share of each category the world leaves untasked, for the commander to respond with. */
  reserveShare: 1 / 3,
  /** A routine mission that still cannot leave this long after it was tasked is stood down. */
  standDownAfterS: 4 * 3600,
  /** How often, in ticks, the world tries to launch a routine mission that is not yet away. */
  launchAttemptTicks: 60,
  /** An aircraft further than this from its base is brought home before anything else. */
  awayFromBaseM: 5000,
} as const;

/** How often each routine type is flown from base, relative to the others. */
const ROUTINE_WEIGHTS: Readonly<Partial<Record<MissionType, number>>> = {
  training: 3,
  logistics: 3,
  transport: 2,
  patrol: 2,
};

/** What routine tasking needs to know about an aircraft. */
export interface RoutineAircraft {
  readonly id: string;
  readonly category: string;
  readonly performance: PerformanceModel | null;
  /** `null` while airborne. */
  readonly location: RoutePoint | null;
  readonly home: RoutePoint;
  /** Available, on the ground and committed to nothing: the world may task it. */
  readonly free: boolean;
}

export interface RoutineInput {
  readonly rng: Rng;
  /** The operating area: public aerodromes copied into the world. */
  readonly places: readonly RoutePoint[];
  /** The whole fleet, in identifier order. */
  readonly aircraft: readonly RoutineAircraft[];
  /** Ordinal of the next routine task, used only to name simulated areas. */
  readonly ordinal: number;
}

export interface RoutineTask {
  readonly aircraftId: string;
  readonly type: MissionType;
  readonly title: string;
  readonly description: string;
  readonly brief: MissionBrief;
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
const suits = (template: MissionTemplate, category: string) =>
  template.suitableCategories.includes(category);

/** How many aircraft of a category the world leaves alone, of `owned`. */
export function routineReserve(owned: number): number {
  return owned < 2 ? 0 : Math.max(1, Math.ceil(owned * ROUTINE.reserveShare));
}

/** Whether an aircraft is away from its base. */
export function awayFromBase(aircraft: Pick<RoutineAircraft, 'location' | 'home'>): boolean {
  return (
    aircraft.location !== null &&
    greatCircleDistance(aircraft.location, aircraft.home) > ROUTINE.awayFromBaseM
  );
}

/**
 * The aircraft the world may task now: free and able to fly, while more of their category are
 * free than the reserve asks for. So tasking one never takes the free aircraft of a category
 * below its reserve.
 */
export function routineCandidates(aircraft: readonly RoutineAircraft[]): RoutineAircraft[] {
  const owned = new Map<string, number>();
  const free = new Map<string, number>();
  for (const each of aircraft) {
    owned.set(each.category, (owned.get(each.category) ?? 0) + 1);
    if (each.free) free.set(each.category, (free.get(each.category) ?? 0) + 1);
  }
  return aircraft.filter(
    (each) =>
      each.free &&
      each.performance !== null &&
      each.location !== null &&
      (free.get(each.category) ?? 0) > routineReserve(owned.get(each.category) ?? 0),
  );
}

function payloadFor(rng: Rng, template: MissionTemplate, model: PerformanceModel): number {
  if (!template.carriesPayload) return 0;
  return Math.max(
    Math.round((model.maxPayloadKg * between(rng, GENERATION.payloadShare)) / 100) * 100,
    100,
  );
}

function pickType(rng: Rng, candidates: readonly MissionTemplate[]): MissionTemplate {
  const weight = (candidate: MissionTemplate) => ROUTINE_WEIGHTS[candidate.type] ?? 0;
  const total = candidates.reduce((sum, candidate) => sum + weight(candidate), 0);
  let roll = rng.nextFloat() * total;
  for (const candidate of candidates) {
    roll -= weight(candidate);
    if (roll < 0) return candidate;
  }
  return candidates.at(-1) as MissionTemplate;
}

/**
 * Considers tasking one aircraft. Returns `null` when the interval produces nothing: the dice
 * say no, no aircraft may be tasked, or nowhere suitable is in reach. Deterministic for a given
 * generator state and input.
 */
export function generateRoutineTask(input: RoutineInput): RoutineTask | null {
  const { rng } = input;
  if (!rng.chance(ROUTINE.chancePerInterval)) return null;
  const candidates = routineCandidates(input.aircraft);
  if (candidates.length === 0) return null;
  const aircraft = pick(rng, candidates);
  const model = aircraft.performance as PerformanceModel;
  const base = aircraft.location as RoutePoint;
  const rangeM = model.referenceRangeKm * 1000;
  const describe = (template: MissionTemplate) =>
    `Routine tasking, flown by the simulated world. ${template.description}`;
  const brief = (
    template: MissionTemplate,
    destination: RoutePoint | null,
    target: NamedPoint | null,
  ): MissionBrief => ({
    shape: template.shape,
    destination,
    target,
    orbitRadiusM: MISSION_GEOMETRY.orbitRadiusM,
    holdS: template.holdS,
    payloadKg: payloadFor(rng, template, model),
  });

  // Away from base: come home, carrying something if it is a type that does.
  if (awayFromBase(aircraft)) {
    const template = suits(MISSION_TEMPLATES.logistics, aircraft.category)
      ? MISSION_TEMPLATES.logistics
      : MISSION_TEMPLATES.ferry;
    return {
      aircraftId: aircraft.id,
      type: template.type,
      title: `Return to base: ${placeName(aircraft.home)}`,
      description: describe(template),
      brief: brief(template, aircraft.home, null),
    };
  }

  const suitable = (Object.keys(ROUTINE_WEIGHTS) as MissionType[])
    .map((type) => MISSION_TEMPLATES[type])
    .filter((template) => suits(template, aircraft.category));
  if (suitable.length === 0) return null;
  const template = pickType(rng, suitable);

  if (template.shape === 'point_to_point') {
    const reachM = rangeM * GENERATION.oneWayRangeShare;
    const inReach = input.places.filter((place) => {
      const distanceM = greatCircleDistance(base, place);
      return distanceM >= GENERATION.minDistanceM && distanceM <= reachM;
    });
    if (inReach.length === 0) return null;
    const destination = pick(rng, inReach);
    return {
      aircraftId: aircraft.id,
      type: template.type,
      title: `${template.label}: ${placeName(destination)}`,
      description: describe(template),
      brief: brief(template, destination, null),
    };
  }

  const reachM = Math.min(rangeM * GENERATION.radiusRangeShare, GENERATION.maxAreaDistanceM);
  if (reachM < GENERATION.minDistanceM) return null;
  const distanceM = between(rng, [GENERATION.minDistanceM, reachM]);
  const sector = rng.nextInt(0, COMPASS.length);
  const bearing = sector * 45 + between(rng, [-20, 20]);
  const position = destinationPoint(base, degrees((bearing + 360) % 360), metres(distanceM));
  const target = { name: `Area R${input.ordinal}`, lat: position.lat, lon: position.lon };
  return {
    aircraftId: aircraft.id,
    type: template.type,
    title: `${template.label}: ${target.name}, ${Math.round(distanceM / 1000)} km ${COMPASS[sector] as string} of ${base.name}`,
    description: describe(template),
    brief: brief(template, null, target),
  };
}

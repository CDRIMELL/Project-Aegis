import type { RoutePoint } from '../flight/route';
import { degrees, metres } from '../units';
import { destinationPoint, greatCircleDistance, intermediatePoint, type LatLon } from '../geo';
import type { NamedPoint } from '../mission/types';
import type { Rng } from '../rng';

/*
 * World events (ADR 0022).
 *
 * Discrete things that happen in the simulated world and have consequences: a closed aerodrome, a
 * disrupted area, a logistics problem. Everything here is fictional. Events are generated from a
 * seeded stream at a controlled rate, or derived from the weather field; none is rolled per step.
 */

export const EVENT_TYPES = [
  'aerodrome_closure',
  'navigation_disruption',
  'logistics_disruption',
  'maintenance_finding',
  'severe_weather',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_STATUSES = ['scheduled', 'active', 'resolved', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** The lifecycle. A status may move only to the statuses listed for it. */
export const EVENT_TRANSITIONS: Readonly<Record<EventStatus, readonly EventStatus[]>> = {
  scheduled: ['active', 'cancelled'],
  active: ['resolved'],
  resolved: [],
  cancelled: [],
};

export function canEventTransition(from: EventStatus, to: EventStatus): boolean {
  return EVENT_TRANSITIONS[from].includes(to);
}

/** True while an event is announced or under way. */
export function isOpenEvent(status: EventStatus): boolean {
  return status === 'scheduled' || status === 'active';
}

/** `generated`: from the seeded stream. `derived`: read from the weather field. */
export const EVENT_SOURCES = ['generated', 'derived'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const EVENT_LABEL: Readonly<Record<EventType, string>> = {
  aerodrome_closure: 'Aerodrome closure',
  navigation_disruption: 'Navigation disruption',
  logistics_disruption: 'Logistics disruption',
  maintenance_finding: 'Maintenance finding',
  severe_weather: 'Severe weather',
};

/** What each type of event acts on, in words, for the interface. */
export const EVENT_AFFECTS: Readonly<Record<EventType, readonly string[]>> = {
  aerodrome_closure: ['Departures from the aerodrome', 'Plans arriving during the closure'],
  navigation_disruption: ['Mission risk', 'Routes through the area'],
  logistics_disruption: ['Mission opportunities'],
  maintenance_finding: ['Aircraft availability'],
  severe_weather: ['Flight time and fuel', 'Mission risk'],
};

export interface WorldEvent {
  /** For example `EVT-000001`. */
  readonly id: string;
  readonly type: EventType;
  readonly status: EventStatus;
  readonly source: EventSource;
  /** 0 to 1. */
  readonly severity: number;
  readonly createdTick: number;
  readonly startTick: number;
  readonly endTick: number;
  /** The aerodrome concerned, for a closure or a logistics disruption. */
  readonly place: RoutePoint | null;
  /** The centre of the area concerned, for a disruption or severe weather. */
  readonly centre: NamedPoint | null;
  readonly radiusM: number | null;
  /** The aircraft concerned, for a maintenance finding. */
  readonly aircraftId: string | null;
  /** The opportunity a logistics disruption created, once it has. */
  readonly missionId: string | null;
  readonly title: string;
  readonly description: string;
}

/** Simulation assumptions that pace event generation. Not reference data. */
export const EVENT_GENERATION = {
  /** Generation is considered once per this many ticks. */
  intervalTicks: 2 * 3600,
  /** No event is generated while this many generated events are announced or under way. */
  maxOpen: 3,
  chancePerInterval: 0.35,
  /** Notice given before an event starts, in seconds. */
  leadS: [30 * 60, 3 * 3600],
  durationS: [3600, 6 * 3600],
  areaRadiusM: [80_000, 200_000],
  /** How far from an aerodrome the centre of a disrupted area may lie. */
  areaOffsetM: [0, 200_000],
} as const;

/** How the weather field becomes a severe-weather event. */
export const SEVERE_WEATHER = {
  /** The field is read at the operating area's aerodromes this often. */
  checkIntervalTicks: 30 * 60,
  /** Severity at or above this raises an event. */
  threshold: 0.75,
  radiusM: 250_000,
  /** An advisory lasts this long past the last check that found it still severe. */
  holdS: 2 * 3600,
  maxOpen: 2,
} as const;

const TYPE_WEIGHTS: readonly (readonly [EventType, number])[] = [
  ['aerodrome_closure', 3],
  ['navigation_disruption', 2],
  ['logistics_disruption', 2],
  ['maintenance_finding', 1],
];

/** A generated event before the simulation gives it an identifier and a status. */
export type EventDraft = Omit<WorldEvent, 'id' | 'status' | 'createdTick' | 'missionId'>;

export interface EventGenerationInput {
  readonly rng: Rng;
  readonly tick: number;
  /** The operating area. */
  readonly places: readonly RoutePoint[];
  /** Aircraft on the ground and available, by identifier: candidates for a maintenance finding. */
  readonly availableAircraftIds: readonly string[];
  /** Generated events that are announced or under way. */
  readonly openGenerated: readonly WorldEvent[];
}

const between = (rng: Rng, [low, high]: readonly [number, number]) =>
  low + rng.nextFloat() * (high - low);
const minutes = (seconds: number) => Math.round(seconds / 60) * 60;
const placeName = (place: RoutePoint) =>
  place.code ? `${place.name} (${place.code})` : place.name;

/**
 * Considers generating one event. Returns `null` when the interval produces nothing: enough are
 * already open, the dice say no, or there is nothing for the chosen type to act on.
 * Deterministic for a given generator state and input.
 */
export function generateEvent(input: EventGenerationInput): EventDraft | null {
  const { rng, tick } = input;
  const G = EVENT_GENERATION;
  if (input.openGenerated.length >= G.maxOpen || input.places.length === 0) return null;
  if (!rng.chance(G.chancePerInterval)) return null;

  const total = TYPE_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = rng.nextFloat() * total;
  let type: EventType = 'aerodrome_closure';
  for (const [candidate, weight] of TYPE_WEIGHTS) {
    roll -= weight;
    if (roll < 0) {
      type = candidate;
      break;
    }
  }

  const severity = Math.round(between(rng, [0.3, 1]) * 100) / 100;
  const startTick = tick + minutes(between(rng, G.leadS));
  const endTick = startTick + minutes(between(rng, G.durationS));
  const base = { source: 'generated' as const, severity, aircraftId: null };

  if (type === 'maintenance_finding') {
    if (input.availableAircraftIds.length === 0) return null;
    const aircraftId = input.availableAircraftIds[
      rng.nextInt(0, input.availableAircraftIds.length)
    ] as string;
    return {
      ...base,
      type,
      aircraftId,
      // Found now; it lasts until the aircraft has been maintained.
      startTick: tick,
      endTick: tick,
      place: null,
      centre: null,
      radiusM: null,
      title: `Maintenance finding: ${aircraftId}`,
      description: `Simulated event. An inspection of ${aircraftId} found a fault. The aircraft is due maintenance and cannot launch until it has been done.`,
    };
  }

  const place = input.places[rng.nextInt(0, input.places.length)] as RoutePoint;
  // One closure or disruption per aerodrome at a time.
  if (
    input.openGenerated.some((event) => event.place?.refId === place.refId && event.type === type)
  ) {
    return null;
  }

  if (type === 'aerodrome_closure') {
    return {
      ...base,
      type,
      startTick,
      endTick,
      place,
      centre: null,
      radiusM: null,
      title: `Aerodrome closure: ${placeName(place)}`,
      description: `Simulated event. ${place.name} is closed to departures for the period. Aircraft already airborne and bound for it are accepted.`,
    };
  }

  if (type === 'logistics_disruption') {
    return {
      ...base,
      type,
      startTick,
      endTick,
      place,
      centre: null,
      radiusM: null,
      title: `Logistics disruption: ${placeName(place)}`,
      description: `Simulated event. Supplies have been held up at ${place.name}. An urgent delivery is requested while the disruption lasts.`,
    };
  }

  const offset = destinationPoint(
    place,
    degrees(rng.nextFloat() * 360),
    metres(between(rng, G.areaOffsetM)),
  );
  const radiusM = Math.round(between(rng, G.areaRadiusM) / 1000) * 1000;
  return {
    ...base,
    type,
    startTick,
    endTick,
    place: null,
    centre: { name: `Area near ${place.name}`, lat: offset.lat, lon: offset.lon },
    radiusM,
    title: `Navigation disruption near ${place.name}`,
    description: `Simulated event. Navigation aids are unreliable within ${Math.round(radiusM / 1000)} km of the area for the period. Flights through it carry more risk.`,
  };
}

/** A closed aerodrome and when, as far as planning is concerned. */
export interface Closure {
  readonly eventId: string;
  readonly place: RoutePoint;
  readonly startTick: number;
  readonly endTick: number;
}

/** An area to avoid and when. */
export interface Disruption {
  readonly eventId: string;
  readonly type: EventType;
  readonly centre: NamedPoint;
  readonly radiusM: number;
  readonly startTick: number;
  readonly endTick: number;
  readonly severity: number;
}

/** What planning needs to know about the events that are announced or under way. */
export interface Hazards {
  readonly closures: readonly Closure[];
  readonly disruptions: readonly Disruption[];
}

export const NO_HAZARDS: Hazards = { closures: [], disruptions: [] };

/** The open events, in the form the planner checks a plan against. */
export function hazardsFrom(events: readonly WorldEvent[]): Hazards {
  const closures: Closure[] = [];
  const disruptions: Disruption[] = [];
  for (const event of events) {
    if (!isOpenEvent(event.status)) continue;
    if (event.type === 'aerodrome_closure' && event.place) {
      closures.push({
        eventId: event.id,
        place: event.place,
        startTick: event.startTick,
        endTick: event.endTick,
      });
    } else if (
      (event.type === 'navigation_disruption' || event.type === 'severe_weather') &&
      event.centre &&
      event.radiusM !== null
    ) {
      disruptions.push({
        eventId: event.id,
        type: event.type,
        centre: event.centre,
        radiusM: event.radiusM,
        startTick: event.startTick,
        endTick: event.endTick,
        severity: event.severity,
      });
    }
  }
  return { closures, disruptions };
}

/** Two places are the same aerodrome: the same reference record, or within a kilometre. */
export function sameAerodrome(a: RoutePoint, b: RoutePoint): boolean {
  if (a.refId !== undefined && a.refId === b.refId) return true;
  return greatCircleDistance(a, b) < 1000;
}

/** The closure in force at an aerodrome at a tick, if any. */
export function closureAt(hazards: Hazards, place: RoutePoint, tick: number): Closure | undefined {
  return hazards.closures.find(
    (closure) =>
      tick >= closure.startTick && tick < closure.endTick && sameAerodrome(closure.place, place),
  );
}

/** How closely a route is checked against an area: one point every this many metres. */
const ROUTE_CHECK_SPACING_M = 20_000;

/** True when a route passes within `radiusM` of a point. */
export function routePassesWithin(
  points: readonly LatLon[],
  centre: LatLon,
  radiusM: number,
): boolean {
  for (let i = 0; i + 1 < points.length; i++) {
    const from = points[i] as LatLon;
    const to = points[i + 1] as LatLon;
    const legM = greatCircleDistance(from, to);
    const steps = Math.max(Math.ceil(legM / ROUTE_CHECK_SPACING_M), 1);
    for (let step = 0; step <= steps; step++) {
      const at =
        step === 0 ? from : step === steps ? to : intermediatePoint(from, to, step / steps);
      if (greatCircleDistance(at, centre) <= radiusM) return true;
    }
  }
  return false;
}

/** The disruptions a flight along a route would meet between its departure and its arrival. */
export function disruptionsOnRoute(
  hazards: Hazards,
  points: readonly LatLon[],
  departureTick: number,
  arrivalTick: number,
): Disruption[] {
  return hazards.disruptions.filter(
    (disruption) =>
      disruption.startTick <= arrivalTick &&
      disruption.endTick > departureTick &&
      routePassesWithin(points, disruption.centre, disruption.radiusM),
  );
}

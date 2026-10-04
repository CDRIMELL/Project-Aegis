import {
  EVENT_GENERATION,
  SEVERE_WEATHER,
  canEventTransition,
  conditionsAt,
  generateEvent,
  greatCircleDistance,
  isOpenEvent,
  routePassesWithin,
  sameAerodrome,
  type EventDraft,
  type EventStatus,
  type FlightPlan,
  type Rng,
  type RoutePoint,
  type WeatherModel,
  type WorldEvent,
} from '@aegis/domain';
import type { AircraftState } from './fleet';
import type { EmitEvent } from './log';

/*
 * World events (ADR 0022): the simulation's side of them.
 *
 * This subsystem owns the events, moves them through their lifecycle, generates new ones at a
 * controlled rate, reads severe weather off the weather field, and applies the consequences that
 * are not simply "the planner refuses": a maintenance finding grounds an aircraft, a logistics
 * disruption asks for a delivery. Everything here is fictional simulation state.
 */

/** How many finished events the engine keeps in memory. Older ones remain in the database. */
export const RECENT_EVENTS = 100;

const GENERATION_STREAM = 'events.generation';

export interface EventsSnapshot {
  /** Every open event and the most recent finished ones. */
  readonly events: readonly WorldEvent[];
  /** Number the next event will take. */
  readonly nextNumber: number;
}

export const EMPTY_EVENTS: EventsSnapshot = { events: [], nextNumber: 1 };

/** A mission an event may bear on: one that is committed or flying. */
export interface AffectableMission {
  readonly missionId: string;
  readonly aircraftId: string | null;
  readonly flightId: string | null;
  readonly active: boolean;
  readonly plan: FlightPlan;
}

/** What events need from the rest of the world. */
export interface EventsWorld {
  readonly weather: WeatherModel;
  /** The operating area. */
  places(): readonly RoutePoint[];
  groundedAircraft(): readonly AircraftState[];
  aircraftById(id: string): AircraftState | undefined;
  /** Makes an available aircraft due maintenance. Returns false if it could not be. */
  flagMaintenanceDue(aircraftId: string): boolean;
  /** Asks the mission layer for an urgent delivery to a place. Returns the opportunity's id. */
  offerUrgentDelivery(event: WorldEvent, tick: number): string | null;
  /** Missions that are accepted or flying. */
  affectableMissions(): readonly AffectableMission[];
}

export interface EventsView {
  /** Newest first. */
  readonly events: readonly WorldEvent[];
}

export class Events {
  private readonly events = new Map<string, WorldEvent>();
  private nextNumber: number;
  /** How many events are announced or under way, kept so an idle step can return at once. */
  private openCount = 0;

  constructor(snapshot: EventsSnapshot = EMPTY_EVENTS) {
    if (!Number.isSafeInteger(snapshot.nextNumber) || snapshot.nextNumber < 1) {
      throw new Error('Saved event counter is invalid');
    }
    for (const event of snapshot.events) {
      if (event.endTick < event.startTick || !(event.severity >= 0 && event.severity <= 1)) {
        throw new Error(`Saved event ${event.id} is invalid`);
      }
      this.events.set(event.id, event);
      if (isOpenEvent(event.status)) this.openCount += 1;
    }
    this.nextNumber = snapshot.nextNumber;
  }

  /** Events that are announced or under way, in the order they were created. */
  open(): WorldEvent[] {
    return [...this.events.values()].filter((event) => isOpenEvent(event.status));
  }

  private move(event: WorldEvent, to: EventStatus): WorldEvent {
    if (!canEventTransition(event.status, to)) {
      throw new Error(`Event ${event.id} cannot go from ${event.status} to ${to}`);
    }
    const moved = { ...event, status: to };
    this.events.set(event.id, moved);
    if (!isOpenEvent(to)) {
      this.openCount -= 1;
      this.forgetOldest();
    }
    return moved;
  }

  private create(draft: EventDraft, tick: number, status: EventStatus): WorldEvent {
    const id = `EVT-${String(this.nextNumber).padStart(6, '0')}`;
    this.nextNumber += 1;
    const event: WorldEvent = { ...draft, id, status, createdTick: tick, missionId: null };
    this.events.set(id, event);
    this.openCount += 1;
    return event;
  }

  private forgetOldest(): void {
    const finished = [...this.events.values()].filter((event) => !isOpenEvent(event.status));
    if (finished.length > RECENT_EVENTS) {
      finished
        .slice(0, finished.length - RECENT_EVENTS)
        .forEach((old) => this.events.delete(old.id));
    }
  }

  /** Records, on each mission an event bears on, that it does. */
  private noteAffected(
    event: WorldEvent,
    world: EventsWorld,
    emit: EmitEvent,
    onlyFlying: boolean,
  ): void {
    for (const mission of world.affectableMissions()) {
      if (onlyFlying && !mission.active) continue;
      const points = mission.plan.points;
      const origin = points[0];
      const destination = points.at(-1);
      let how: string | null = null;
      if (event.type === 'aerodrome_closure' && event.place) {
        if (destination && sameAerodrome(destination, event.place)) {
          how = mission.active
            ? `${event.place.name} is closing; the flight is already airborne and will be accepted.`
            : `${event.place.name}, the destination, is closing.`;
        } else if (origin && sameAerodrome(origin, event.place) && !mission.active) {
          how = `${event.place.name}, the origin, is closing to departures.`;
        }
      } else if (event.centre && event.radiusM !== null) {
        if (routePassesWithin(points, event.centre, event.radiusM)) {
          how = `The route passes through the area of ${event.title.toLowerCase()}.`;
        }
      }
      if (how) {
        emit(
          'missionAffected',
          {
            missionId: mission.missionId,
            aircraftId: mission.aircraftId,
            flightId: mission.flightId,
          },
          { eventId: event.id, title: event.title, summary: how },
        );
      }
    }
  }

  private start(event: WorldEvent, tick: number, world: EventsWorld, emit: EmitEvent): void {
    let started = event.status === 'active' ? event : this.move(event, 'active');
    if (started.type === 'logistics_disruption') {
      const missionId = world.offerUrgentDelivery(started, tick);
      if (missionId) {
        started = { ...started, missionId };
        this.events.set(started.id, started);
      }
    }
    emit(
      'eventStarted',
      { aircraftId: started.aircraftId, missionId: started.missionId },
      { eventId: started.id, eventType: started.type, title: started.title },
    );
    this.noteAffected(started, world, emit, true);
  }

  private resolve(event: WorldEvent, emit: EmitEvent): void {
    this.move(event, 'resolved');
    emit(
      'eventResolved',
      { aircraftId: event.aircraftId },
      { eventId: event.id, eventType: event.type, title: event.title },
    );
  }

  /** Moves events through their lifecycle and may create one. */
  step(tick: number, world: EventsWorld, rng: (stream: string) => Rng, emit: EmitEvent): void {
    const generating = tick % EVENT_GENERATION.intervalTicks === 0;
    const readingWeather = tick % SEVERE_WEATHER.checkIntervalTicks === 0;
    // Most steps have nothing to do: no event is open and it is not time to look for one.
    if (!generating && !readingWeather && this.openCount === 0) return;

    for (const event of this.open()) {
      if (event.status === 'scheduled') {
        if (tick >= event.startTick) this.start(event, tick, world, emit);
      } else if (event.type === 'maintenance_finding') {
        // Over once the aircraft has been maintained.
        const status = event.aircraftId ? world.aircraftById(event.aircraftId)?.status : undefined;
        if (status !== 'maintenance_due' && status !== 'in_maintenance') this.resolve(event, emit);
      } else if (tick >= event.endTick) {
        this.resolve(event, emit);
      }
    }

    // A world with no operating area has nowhere for an event to be, and draws nothing.
    if (generating && world.places().length > 0) {
      this.generate(tick, world, rng(GENERATION_STREAM), emit);
    }
    if (readingWeather) this.readSevereWeather(tick, world, emit);
  }

  private generate(tick: number, world: EventsWorld, rng: Rng, emit: EmitEvent): void {
    const draft = generateEvent({
      rng,
      tick,
      places: world.places(),
      availableAircraftIds: world
        .groundedAircraft()
        .filter((aircraft) => aircraft.status === 'available')
        .map((aircraft) => aircraft.id),
      openGenerated: this.open().filter((event) => event.source === 'generated'),
    });
    if (!draft) return;

    if (draft.type === 'maintenance_finding') {
      // Found now: there is nothing to announce in advance.
      if (!draft.aircraftId || !world.flagMaintenanceDue(draft.aircraftId)) return;
      this.start(this.create(draft, tick, 'active'), tick, world, emit);
      return;
    }
    const event = this.create(draft, tick, 'scheduled');
    emit(
      'eventScheduled',
      {},
      {
        eventId: event.id,
        eventType: event.type,
        title: event.title,
        startTick: event.startTick,
        endTick: event.endTick,
      },
    );
    this.noteAffected(event, world, emit, false);
  }

  /**
   * Turns severe weather in the field into an event, and keeps it going while it lasts. Nothing
   * is rolled: the field is read at the operating area's aerodromes.
   */
  private readSevereWeather(tick: number, world: EventsWorld, emit: EmitEvent): void {
    const S = SEVERE_WEATHER;
    const advisories = this.open().filter((event) => event.type === 'severe_weather');

    // Extend an advisory whose area is still severe.
    for (const advisory of advisories) {
      if (!advisory.centre) continue;
      const severity = conditionsAt(world.weather, tick, advisory.centre, 0).severity;
      if (severity >= S.threshold) {
        this.events.set(advisory.id, {
          ...advisory,
          endTick: tick + S.holdS,
          severity: Math.max(advisory.severity, Math.round(severity * 100) / 100),
        });
      }
    }
    if (advisories.length >= S.maxOpen) return;

    // The most severe aerodrome not already covered by an advisory.
    let worst: { place: RoutePoint; severity: number } | null = null;
    for (const place of world.places()) {
      const covered = advisories.some(
        (advisory) =>
          advisory.centre !== null && greatCircleDistance(advisory.centre, place) <= S.radiusM,
      );
      if (covered) continue;
      const severity = conditionsAt(world.weather, tick, place, 0).severity;
      if (severity >= S.threshold && (worst === null || severity > worst.severity)) {
        worst = { place, severity };
      }
    }
    if (!worst) return;

    const { place } = worst;
    const event = this.create(
      {
        type: 'severe_weather',
        source: 'derived',
        severity: Math.round(worst.severity * 100) / 100,
        startTick: tick,
        endTick: tick + S.holdS,
        place: null,
        centre: { name: `Weather near ${place.name}`, lat: place.lat, lon: place.lon },
        radiusM: S.radiusM,
        aircraftId: null,
        title: `Severe weather near ${place.name}`,
        description: `Simulated weather. Conditions within ${Math.round(S.radiusM / 1000)} km of ${place.name} are severe: strong wind, heavy precipitation or very low visibility. Flights through the area take longer, burn more and carry more risk.`,
      },
      tick,
      'active',
    );
    this.start(event, tick, world, emit);
  }

  snapshot(): EventsSnapshot {
    return { events: [...this.events.values()], nextNumber: this.nextNumber };
  }

  view(): EventsView {
    return { events: [...this.events.values()].reverse() };
  }
}

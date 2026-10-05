import {
  NO_HAZARDS,
  REVISION_INTENTS,
  advanceInWeather,
  closedForArrival,
  closuresOf,
  conditionsForFlight,
  evaluatePlan,
  evaluateRevision,
  groundSpeedKmh,
  flightProfile,
  greatCircleDistance,
  grossMassKg,
  initialProgress,
  positionAlong,
  projectFlight,
  routeGeometry,
  type ClosureWindow,
  type FlightLoad,
  type FlightPlan,
  type FlightProfile,
  type FlightProgress,
  type FlightRevision,
  type Hazards,
  type LatLon,
  type PerformanceModel,
  type PlanContext,
  type RevisionIntent,
  type Rng,
  type RouteGeometry,
  type RoutePoint,
  type WeatherModel,
} from '@aegis/domain';
import type { EmitEvent, LogSubject } from './log';

/*
 * The fleet: simulated aircraft and their flights (ADR 0016).
 *
 * Everything here is fictional AEGIS state. Aircraft name a real type and carry a performance
 * model derived from its sourced characteristics, but nothing in this module reads reference data.
 */

/** Seconds of simulated time in one engine step. */
const STEP_S = 1;

/** The name given to the waypoint that marks where a route was changed. */
const REVISION_LABEL: Readonly<Record<RevisionIntent, string>> = {
  reroute: 'Rerouted here',
  divert: 'Diverted here',
  return: 'Turned back here',
};

/** Simulation assumptions for wear and maintenance. Not reference data. */
export const MAINTENANCE = {
  wearPctPerFlightHour: 0.4,
  wearPctPerFlight: 0.5,
  /** Wear varies by this fraction either way, from the world's seeded random stream. */
  wearVariation: 0.1,
  dueAfterFlightSeconds: 50 * 3600,
  dueBelowConditionPct: 60,
  durationSeconds: 6 * 3600,
  /**
   * Extra wear, per hour flown with a technical caution showing (ADR 0026). Five times the
   * ordinary rate: going on is allowed, and costs condition for as long as it lasts.
   */
  cautionWearPctPerFlightHour: 2,
} as const;

/** How many finished flights the engine keeps in memory. Older ones remain in the database. */
export const RECENT_FLIGHTS = 100;

const WEAR_STREAM = 'fleet.wear';

export type AircraftStatus =
  'available' | 'in_flight' | 'maintenance_due' | 'in_maintenance' | 'unserviceable';

/** Identifier prefixes by aircraft category, as in `AEGIS-FT-001`. */
const CATEGORY_CODE: Readonly<Record<string, string>> = {
  fast_jet: 'FT',
  transport: 'TR',
  tanker: 'TK',
  isr: 'IS',
  maritime_patrol: 'MP',
  trainer: 'TN',
  rotary: 'RW',
  uncrewed: 'UA',
  airliner: 'AL',
  regional_airliner: 'RG',
  business_jet: 'BJ',
  freighter: 'FR',
};

export interface AircraftState {
  /** Fictional AEGIS identifier, for example `AEGIS-FT-001`. */
  readonly id: string;
  /** Reference type this aircraft is an instance of. A soft link; see ADR 0016. */
  readonly typeId: string;
  readonly typeName: string;
  readonly category: string;
  /** `null` when the reference data cannot support a model: the aircraft exists but cannot fly. */
  readonly performance: PerformanceModel | null;
  /** Why there is no performance model, when there is none. */
  readonly performanceMissing: readonly string[];
  readonly home: RoutePoint;
  /** Where the aircraft is on the ground; `null` while airborne. */
  readonly location: RoutePoint | null;
  readonly status: AircraftStatus;
  readonly fuelKg: number;
  readonly payloadKg: number;
  readonly conditionPct: number;
  readonly flightSecondsTotal: number;
  readonly flights: number;
  readonly flightSecondsSinceMaintenance: number;
  readonly maintenanceCompleteTick: number | null;
  readonly activeFlightId: string | null;
  readonly acquiredTick: number;
}

export type FlightStatus = 'active' | 'completed' | 'fuel_exhausted';

export interface FlightState {
  readonly id: string;
  readonly aircraftId: string;
  readonly status: FlightStatus;
  /** The mission this flight carries out; `null` for a flight launched on its own. */
  readonly missionId: string | null;
  readonly plan: FlightPlan;
  readonly payloadKg: number;
  readonly fuelAtDepartureKg: number;
  readonly departedTick: number;
  readonly arrivedTick: number | null;
  /**
   * The route as it was launched. `plan` is the route as flown: it begins the same and differs
   * from the point of the first revision, if there was one (ADR 0026).
   */
  readonly plannedPlan: FlightPlan;
  /** Every change of route since launch, in order. Never rewritten. */
  readonly revisions: readonly FlightRevision[];
  /** A technical caution showing on the aircraft in this flight, once one has. */
  readonly caution: FlightCaution | null;
  /** The planner's estimate at launch, kept for comparison with the outcome. */
  readonly estimatedDurationS: number;
  readonly estimatedFuelUsedKg: number;
  /**
   * What the flight is now expected to come to: the estimate at launch until the route changes
   * or a hold ends, and re-flown from the flight's own state when either happens.
   */
  readonly projectedDurationS: number;
  readonly projectedFuelUsedKg: number;
  /**
   * The same plan's estimate in still air, to show what the weather cost. `null` before model 4,
   * and once a flight has changed its route or held: there is then no same plan to compare with.
   */
  readonly stillAirDurationS: number | null;
  readonly stillAirFuelUsedKg: number | null;
  readonly progress: FlightProgress;
}

/** A technical caution on an aircraft in flight (ADR 0026). */
export interface FlightCaution {
  readonly eventId: string;
  readonly sinceTick: number;
}

export interface FleetSnapshot {
  readonly aircraft: readonly AircraftState[];
  /** Active flights and the most recent finished ones. */
  readonly flights: readonly FlightState[];
  /** Next sequence number per identifier prefix. */
  readonly counters: Readonly<Record<string, number>>;
  readonly starterFleetSeeded: boolean;
}

export const EMPTY_FLEET: FleetSnapshot = {
  aircraft: [],
  flights: [],
  counters: {},
  starterFleetSeeded: false,
};

/** What is needed to create an aircraft. The application resolves it from reference data. */
export interface AircraftOrder {
  readonly typeId: string;
  readonly typeName: string;
  readonly category: string;
  readonly performance: PerformanceModel | null;
  readonly performanceMissing: readonly string[];
  readonly home: RoutePoint;
}

export type FleetCommand =
  | ({ readonly type: 'acquireAircraft' } & AircraftOrder)
  /** Creates the starter fleet. Has an effect once per world. */
  | { readonly type: 'seedStarterFleet'; readonly aircraft: readonly AircraftOrder[] }
  | { readonly type: 'setHome'; readonly aircraftId: string; readonly home: RoutePoint }
  | {
      readonly type: 'setLoad';
      readonly aircraftId: string;
      readonly fuelKg: number;
      readonly payloadKg: number;
    }
  | {
      readonly type: 'launchFlight';
      readonly aircraftId: string;
      readonly plan: FlightPlan;
      readonly load: FlightLoad;
    }
  | { readonly type: 'startMaintenance'; readonly aircraftId: string }
  /**
   * Changes the rest of an airborne flight's route (ADR 0026). `points` is the new remainder,
   * ending at the aerodrome to land at; where it starts is the aircraft's position at the tick
   * the command is applied, which the simulation knows and the command therefore does not carry.
   */
  | {
      readonly type: 'reviseFlight';
      readonly aircraftId: string;
      readonly intent: RevisionIntent;
      readonly points: readonly RoutePoint[];
    }
  /** Holds an airborne aircraft where it is, until it is resumed or its fuel is down to reserve. */
  | { readonly type: 'holdFlight'; readonly aircraftId: string }
  /** Ends a hold the operator ordered. */
  | { readonly type: 'resumeFlight'; readonly aircraftId: string }
  /**
   * Replaces a grounded aircraft's performance model, for example after the flight model or the
   * reference data behind it has changed. An airborne aircraft is refused: a flight finishes
   * under the model it departed with.
   */
  | {
      readonly type: 'updatePerformance';
      readonly aircraftId: string;
      readonly performance: PerformanceModel | null;
      readonly performanceMissing: readonly string[];
    };

/** What an effective command touched, for the log. */
export type CommandEffect = LogSubject;

/** A command the simulation refused. The world is unchanged. */
export class CommandRejected extends Error {
  override readonly name = 'CommandRejected';
}

/** Live picture of one flight, for display. */
export interface FlightView {
  readonly id: string;
  readonly aircraftId: string;
  readonly lat: number;
  readonly lon: number;
  readonly headingDeg: number;
  readonly phase: FlightProgress['phase'];
  readonly altitudeM: number;
  readonly speedKmh: number;
  readonly fuelKg: number;
  readonly burnRateKgH: number;
  readonly distanceM: number;
  readonly totalM: number;
  readonly elapsedS: number;
  readonly etaTick: number;
  readonly estimatedFuelAtDestinationKg: number;
  readonly points: readonly RoutePoint[];
  /** Why the aircraft is holding, when it is. */
  readonly hold: 'operator' | 'closure' | null;
  /** Seconds spent holding so far. */
  readonly heldS: number;
  /** True while it descends to a closed destination with its fuel at reserve. */
  readonly closureLanding: boolean;
  /** The intent of the latest change of route; `null` when the flight is as launched. */
  readonly intent: RevisionIntent | null;
  readonly revisions: readonly FlightRevision[];
  /** Where the flight was launched to, which a diversion leaves behind. */
  readonly plannedDestination: RoutePoint;
  readonly caution: FlightCaution | null;
  /** The mission the flight was launched for, if any. */
  readonly missionId: string | null;
  readonly departedTick: number;
  readonly payloadKg: number;
  /** The flight's own state, from which the rest of it can be projected. */
  readonly progress: FlightProgress;
  readonly cruiseAltitudeM: number;
  readonly cruiseSpeedKmh: number;
  /** The weather where the aircraft is now, at its altitude. */
  readonly groundSpeedKmh: number;
  readonly tailwindKmh: number;
  readonly windFromDeg: number;
  readonly windSpeedKmh: number;
  readonly outsideTemperatureC: number;
  readonly visibilityKm: number;
  readonly precipitation: number;
  readonly severity: number;
}

export interface FleetView {
  readonly aircraft: readonly AircraftState[];
  readonly activeFlights: readonly FlightView[];
  /** Finished flights, most recent first. */
  readonly recentFlights: readonly FlightState[];
  readonly starterFleetSeeded: boolean;
}

function maintenanceDue(aircraft: AircraftState): boolean {
  return (
    aircraft.flightSecondsSinceMaintenance >= MAINTENANCE.dueAfterFlightSeconds ||
    aircraft.conditionPct < MAINTENANCE.dueBelowConditionPct
  );
}

function assertPoint(point: RoutePoint, what: string): void {
  if (
    !Number.isFinite(point.lat) ||
    !Number.isFinite(point.lon) ||
    Math.abs(point.lat) > 90 ||
    Math.abs(point.lon) > 180 ||
    !Number.isFinite(point.elevationM) ||
    point.name.length === 0
  ) {
    throw new CommandRejected(`${what} is not a valid location.`);
  }
}

/** True when two points are the same place: the same reference record, or within a kilometre. */
function samePlace(a: RoutePoint, b: RoutePoint): boolean {
  if (a.refId !== undefined && a.refId === b.refId) return true;
  return greatCircleDistance(a, b) < 1000;
}

/** What is derived for a flight while it is active. Never persisted. */
interface ActiveFlight {
  profile: FlightProfile;
  route: RouteGeometry;
  /** The hazards the closures below were read from, to know when to read them again. */
  hazards: Hazards | null;
  closures: readonly ClosureWindow[];
}

const NO_CLOSURES: readonly ClosureWindow[] = [];

/**
 * A flight as it is held in memory. A flight saved before in-flight control existed lacks the
 * newer fields; it is given what they would have been for a flight flown exactly as launched.
 */
function restoredFlight(saved: FlightState): FlightState {
  // Read as possibly absent, which for a flight from an older world they are.
  const partial: Partial<FlightState> = saved;
  const progress: Partial<FlightProgress> = saved.progress;
  return {
    ...saved,
    plannedPlan: partial.plannedPlan ?? saved.plan,
    revisions: partial.revisions ?? [],
    caution: partial.caution ?? null,
    projectedDurationS: partial.projectedDurationS ?? saved.estimatedDurationS,
    projectedFuelUsedKg: partial.projectedFuelUsedKg ?? saved.estimatedFuelUsedKg,
    progress: {
      ...saved.progress,
      hold: progress.hold ?? null,
      heldS: progress.heldS ?? 0,
      closureLanding: progress.closureLanding ?? false,
    },
  };
}

export class Fleet {
  private readonly aircraft = new Map<string, AircraftState>();
  private readonly flights = new Map<string, FlightState>();
  private readonly counters = new Map<string, number>();
  private starterFleetSeeded: boolean;
  /** Route geometry and profile of each active flight. Derived from the plan; never persisted. */
  private readonly active = new Map<string, ActiveFlight>();

  constructor(
    snapshot: FleetSnapshot = EMPTY_FLEET,
    /** The world's weather. `null` flies everything in still air, as tests of other things do. */
    private readonly weather: WeatherModel | null = null,
  ) {
    for (const aircraft of snapshot.aircraft) this.aircraft.set(aircraft.id, aircraft);
    for (const flight of snapshot.flights) this.flights.set(flight.id, restoredFlight(flight));
    for (const [name, value] of Object.entries(snapshot.counters)) this.counters.set(name, value);
    this.starterFleetSeeded = snapshot.starterFleetSeeded;

    for (const flight of this.flights.values()) {
      if (flight.status !== 'active') continue;
      const aircraft = this.aircraft.get(flight.aircraftId);
      if (!aircraft?.performance || aircraft.activeFlightId !== flight.id) {
        throw new Error(`Saved flight ${flight.id} does not match its aircraft`);
      }
      this.activate(flight, aircraft.performance);
    }
    for (const aircraft of this.aircraft.values()) {
      const numbers = [
        aircraft.fuelKg,
        aircraft.payloadKg,
        aircraft.conditionPct,
        aircraft.flightSecondsTotal,
      ];
      if (!numbers.every((value) => Number.isFinite(value) && value >= 0)) {
        throw new Error(`Saved aircraft ${aircraft.id} has an invalid quantity`);
      }
      if (
        aircraft.activeFlightId !== null &&
        this.flights.get(aircraft.activeFlightId)?.status !== 'active'
      ) {
        throw new Error(`Saved aircraft ${aircraft.id} refers to a flight that is not active`);
      }
    }
  }

  private activate(flight: FlightState, model: PerformanceModel): void {
    this.active.set(flight.id, {
      profile: flightProfile(model, flight.plan, flight.payloadKg),
      route: routeGeometry(flight.plan.points),
      hazards: null,
      closures: NO_CLOSURES,
    });
  }

  private nextId(prefix: string, width: number): string {
    const next = this.counters.get(prefix) ?? 1;
    this.counters.set(prefix, next + 1);
    return `${prefix}-${String(next).padStart(width, '0')}`;
  }

  private require(aircraftId: string): AircraftState {
    const aircraft = this.aircraft.get(aircraftId);
    if (!aircraft) throw new CommandRejected(`There is no aircraft ${aircraftId}.`);
    return aircraft;
  }

  private onGround(aircraft: AircraftState, action: string): RoutePoint {
    if (aircraft.location === null) {
      throw new CommandRejected(
        `${aircraft.id} is airborne; it cannot ${action} until it has landed.`,
      );
    }
    return aircraft.location;
  }

  private assertOrder(order: AircraftOrder): void {
    assertPoint(order.home, 'The home aerodrome');
    if (order.home.kind !== 'aerodrome') {
      throw new CommandRejected('An aircraft must be based at an aerodrome.');
    }
    if (order.typeId.length === 0 || order.typeName.length === 0) {
      throw new CommandRejected('An aircraft must be an instance of a reference type.');
    }
  }

  private acquire(order: AircraftOrder, tick: number): string {
    this.assertOrder(order);
    const id = this.nextId(`AEGIS-${CATEGORY_CODE[order.category] ?? 'XX'}`, 3);
    this.aircraft.set(id, {
      id,
      typeId: order.typeId,
      typeName: order.typeName,
      category: order.category,
      performance: order.performance,
      performanceMissing: order.performance ? [] : order.performanceMissing,
      home: order.home,
      location: order.home,
      status: 'available',
      fuelKg: order.performance?.fuelCapacityKg ?? 0,
      payloadKg: 0,
      conditionPct: 100,
      flightSecondsTotal: 0,
      flights: 0,
      flightSecondsSinceMaintenance: 0,
      maintenanceCompleteTick: null,
      activeFlightId: null,
      acquiredTick: tick,
    });
    return id;
  }

  /**
   * Launches a flight, or throws {@link CommandRejected} leaving the fleet as it was. Used by the
   * `launchFlight` command and by a mission launching its flight: both are validated the same way.
   */
  launch(
    aircraftId: string,
    plan: FlightPlan,
    load: FlightLoad,
    tick: number,
    missionId: string | null,
    context: PlanContext | null = null,
  ): string {
    const aircraft = this.require(aircraftId);
    const location = this.onGround(aircraft, 'launch');
    if (aircraft.status !== 'available') {
      throw new CommandRejected(
        `${aircraft.id} is not available (${aircraft.status.replaceAll('_', ' ')}).`,
      );
    }
    const model = aircraft.performance;
    if (!model) {
      throw new CommandRejected(
        `${aircraft.id} cannot fly: the reference data lacks ${aircraft.performanceMissing.join(', ')}.`,
      );
    }
    const origin = plan.points[0];
    if (!origin || !samePlace(origin, location)) {
      throw new CommandRejected(
        `${aircraft.id} is at ${location.name}; the flight must start there.`,
      );
    }
    const evaluation = evaluatePlan(model, plan, load, context);
    const blocked = evaluation.constraints.find((constraint) => constraint.severity === 'block');
    if (blocked || !evaluation.estimate) {
      throw new CommandRejected(blocked?.message ?? 'The flight plan cannot be flown.');
    }
    const profile = flightProfile(model, plan, load.payloadKg);
    const flight: FlightState = {
      id: this.nextId('FLT', 6),
      aircraftId: aircraft.id,
      status: 'active',
      missionId,
      plan,
      plannedPlan: plan,
      revisions: [],
      caution: null,
      payloadKg: load.payloadKg,
      fuelAtDepartureKg: load.fuelKg,
      departedTick: tick,
      arrivedTick: null,
      estimatedDurationS: evaluation.estimate.durationS,
      estimatedFuelUsedKg: evaluation.estimate.fuelUsedKg,
      projectedDurationS: evaluation.estimate.durationS,
      projectedFuelUsedKg: evaluation.estimate.fuelUsedKg,
      stillAirDurationS: evaluation.estimate.weather?.stillAirDurationS ?? null,
      stillAirFuelUsedKg: evaluation.estimate.weather?.stillAirFuelUsedKg ?? null,
      progress: initialProgress(profile, load.fuelKg),
    };
    this.flights.set(flight.id, flight);
    this.activate(flight, model);
    this.aircraft.set(aircraft.id, {
      ...aircraft,
      status: 'in_flight',
      location: null,
      fuelKg: load.fuelKg,
      payloadKg: load.payloadKg,
      activeFlightId: flight.id,
    });
    return flight.id;
  }

  aircraftById(id: string): AircraftState | undefined {
    return this.aircraft.get(id);
  }

  /** Aircraft on the ground, in identifier order. */
  groundedAircraft(): AircraftState[] {
    return [...this.aircraft.values()]
      .filter((aircraft) => aircraft.location !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  flightById(id: string): FlightState | undefined {
    return this.flights.get(id);
  }

  /** Where a flight is now, or where it ended, and the length of its route. */
  flightTrack(flight: FlightState): { position: LatLon; totalM: number } {
    const route = this.active.get(flight.id)?.route ?? routeGeometry(flight.plan.points);
    const position = positionAlong(route, flight.progress.distanceM);
    return { position: { lat: position.lat, lon: position.lon }, totalM: route.totalM };
  }

  /** The active flight of an aircraft, with the aircraft and its model, or a refusal. */
  private airborne(aircraftId: string, action: string) {
    const aircraft = this.require(aircraftId);
    const flight = aircraft.activeFlightId ? this.flights.get(aircraft.activeFlightId) : undefined;
    const model = aircraft.performance;
    if (!flight || flight.status !== 'active' || !model) {
      throw new CommandRejected(`${aircraft.id} is not airborne; there is no flight to ${action}.`);
    }
    return { aircraft, flight, model };
  }

  /** What the rest of a flight comes to from its present state, as two figures to keep. */
  private projection(flight: FlightState, model: PerformanceModel, hazards: Hazards) {
    if (!this.weather) {
      return {
        projectedDurationS: flight.projectedDurationS,
        projectedFuelUsedKg: flight.projectedFuelUsedKg,
      };
    }
    const projected = projectFlight(model, flight, { weather: this.weather, hazards });
    return {
      projectedDurationS: (projected.arrivalTick - flight.departedTick) * STEP_S,
      projectedFuelUsedKg: flight.fuelAtDepartureKg - projected.landingFuelKg,
    };
  }

  /**
   * Changes the rest of an airborne flight's route, exactly as the `reviseFlight` command does.
   * Returns the flight's id, or `null` when the route asked for is the one already being flown.
   * Throws {@link CommandRejected}, changing nothing, when the route cannot be flown.
   */
  revise(
    aircraftId: string,
    intent: RevisionIntent,
    points: readonly RoutePoint[],
    tick: number,
    hazards: Hazards = NO_HAZARDS,
  ): string | null {
    const { aircraft, flight, model } = this.airborne(aircraftId, 'change the route of');
    for (const point of points) assertPoint(point, 'A point on the new route');
    if (!this.weather) {
      throw new CommandRejected('This world has no weather; a route cannot be changed in flight.');
    }
    const evaluation = evaluateRevision(
      model,
      flight,
      points,
      { weather: this.weather, hazards },
      REVISION_LABEL[intent],
    );
    const blocked = evaluation.constraints.find((constraint) => constraint.severity === 'block');
    if (blocked || !evaluation.revised || !evaluation.progress || !evaluation.projection) {
      throw new CommandRejected(blocked?.message ?? 'The new route cannot be flown.');
    }
    // The route already being flown: nothing to change, and nothing to record.
    if (evaluation.unchanged) return null;

    const { revised, projection } = evaluation;
    const revision: FlightRevision = {
      tick,
      intent,
      position: revised.position,
      atDistanceM: flight.progress.distanceM,
      fuelKg: flight.progress.fuelKg,
      replaced: revised.replaced,
    };
    const next: FlightState = {
      ...flight,
      plan: revised.plan,
      revisions: [...flight.revisions, revision],
      progress: evaluation.progress,
      projectedDurationS: (projection.arrivalTick - flight.departedTick) * STEP_S,
      projectedFuelUsedKg: flight.fuelAtDepartureKg - projection.landingFuelKg,
      // There is no longer one plan, flown in still air, to compare the outcome against.
      stillAirDurationS: null,
      stillAirFuelUsedKg: null,
    };
    this.flights.set(flight.id, next);
    this.activate(next, model);
    this.aircraft.set(aircraft.id, { ...aircraft, fuelKg: next.progress.fuelKg });
    return flight.id;
  }

  /**
   * Aircraft in flight on which a technical caution could show: past their take-off, and without
   * one already. In identifier order.
   */
  airborneWithoutCaution(): string[] {
    const ids: string[] = [];
    for (const flight of this.flights.values()) {
      if (flight.status === 'active' && !flight.caution && flight.progress.phase !== 'takeoff') {
        ids.push(flight.aircraftId);
      }
    }
    return ids.sort((a, b) => a.localeCompare(b));
  }

  /**
   * Marks a technical caution on an aircraft in flight (ADR 0026). Returns false, changing
   * nothing, if the aircraft is not in a flight that can have one.
   */
  flagCaution(aircraftId: string, eventId: string, tick: number): string | null {
    const aircraft = this.aircraft.get(aircraftId);
    const flight = aircraft?.activeFlightId ? this.flights.get(aircraft.activeFlightId) : undefined;
    if (!flight || flight.status !== 'active' || flight.caution) return null;
    this.flights.set(flight.id, { ...flight, caution: { eventId, sinceTick: tick } });
    return flight.id;
  }

  /**
   * Makes an available aircraft on the ground due maintenance, as an inspection finding does.
   * Returns false, changing nothing, if the aircraft is not available.
   */
  flagMaintenanceDue(aircraftId: string): boolean {
    const aircraft = this.aircraft.get(aircraftId);
    if (!aircraft || aircraft.status !== 'available' || aircraft.location === null) return false;
    this.aircraft.set(aircraftId, { ...aircraft, status: 'maintenance_due' });
    return true;
  }

  /** Removes the payload from an aircraft on the ground. */
  unload(aircraftId: string): void {
    const aircraft = this.aircraft.get(aircraftId);
    if (aircraft && aircraft.location !== null && aircraft.payloadKg !== 0) {
      this.aircraft.set(aircraftId, { ...aircraft, payloadKg: 0 });
    }
  }

  rebase(aircraftId: string, home: RoutePoint): void {
    const aircraft = this.aircraft.get(aircraftId);
    if (aircraft && home.kind === 'aerodrome') {
      this.aircraft.set(aircraftId, { ...aircraft, home });
    }
  }

  /**
   * Applies a command. Returns what it touched, or `null` if it had no effect (so nothing needs
   * saving or logging); throws {@link CommandRejected} if it cannot be carried out, leaving the
   * fleet exactly as it was.
   */
  apply(
    command: FleetCommand,
    tick: number,
    context: PlanContext | null = null,
  ): CommandEffect | null {
    switch (command.type) {
      case 'acquireAircraft':
        return { aircraftId: this.acquire(command, tick) };

      case 'seedStarterFleet':
        if (this.starterFleetSeeded) return null;
        // Check every order first: a rejected command must change nothing.
        for (const order of command.aircraft) this.assertOrder(order);
        for (const order of command.aircraft) this.acquire(order, tick);
        this.starterFleetSeeded = true;
        return {};

      case 'setHome': {
        const aircraft = this.require(command.aircraftId);
        assertPoint(command.home, 'The home aerodrome');
        if (command.home.kind !== 'aerodrome') {
          throw new CommandRejected('An aircraft must be based at an aerodrome.');
        }
        this.aircraft.set(aircraft.id, { ...aircraft, home: command.home });
        return { aircraftId: aircraft.id };
      }

      case 'setLoad': {
        const aircraft = this.require(command.aircraftId);
        this.onGround(aircraft, 'be loaded');
        const model = aircraft.performance;
        if (!model)
          throw new CommandRejected(
            `${aircraft.id} has no performance model, so it cannot be loaded.`,
          );
        const { fuelKg, payloadKg } = command;
        if (
          !Number.isFinite(fuelKg) ||
          !Number.isFinite(payloadKg) ||
          fuelKg < 0 ||
          payloadKg < 0
        ) {
          throw new CommandRejected('Fuel and payload must be zero or more.');
        }
        if (fuelKg > model.fuelCapacityKg + 0.5) {
          throw new CommandRejected('That is more fuel than the aircraft can hold.');
        }
        if (grossMassKg(model, fuelKg, payloadKg) > model.maxTakeoffMassKg + 0.5) {
          throw new CommandRejected('That load exceeds the maximum take-off mass.');
        }
        this.aircraft.set(aircraft.id, { ...aircraft, fuelKg, payloadKg });
        return { aircraftId: aircraft.id };
      }

      case 'launchFlight': {
        const flightId = this.launch(
          command.aircraftId,
          command.plan,
          command.load,
          tick,
          null,
          context,
        );
        return { aircraftId: command.aircraftId, flightId };
      }

      case 'reviseFlight': {
        if (!REVISION_INTENTS.includes(command.intent)) {
          throw new CommandRejected(
            'A change of route must be a reroute, a diversion or a return.',
          );
        }
        const flightId = this.revise(
          command.aircraftId,
          command.intent,
          command.points,
          tick,
          context?.hazards ?? NO_HAZARDS,
        );
        return flightId === null
          ? null
          : {
              aircraftId: command.aircraftId,
              flightId,
              missionId: this.flights.get(flightId)?.missionId ?? null,
            };
      }

      case 'holdFlight': {
        const { aircraft, flight, model } = this.airborne(command.aircraftId, 'hold');
        const { progress } = flight;
        if (progress.hold !== null) return null;
        if (progress.phase === 'takeoff') {
          throw new CommandRejected(
            `${aircraft.id} is still on its take-off roll. It can hold once it is airborne.`,
          );
        }
        if (progress.phase === 'descent') {
          throw new CommandRejected(
            `${aircraft.id} is descending to land. Divert it if it must not land there.`,
          );
        }
        if (progress.fuelKg <= model.reserveFuelKg) {
          throw new CommandRejected(
            `${aircraft.id} has no fuel to hold with: it is already down to its reserve.`,
          );
        }
        this.flights.set(flight.id, {
          ...flight,
          progress: { ...progress, hold: { reason: 'operator', sinceS: progress.elapsedS } },
          stillAirDurationS: null,
          stillAirFuelUsedKg: null,
        });
        return { aircraftId: aircraft.id, flightId: flight.id, missionId: flight.missionId };
      }

      case 'resumeFlight': {
        const { aircraft, flight, model } = this.airborne(command.aircraftId, 'resume');
        const { hold } = flight.progress;
        if (hold === null) return null;
        if (hold.reason === 'closure') {
          const destination = flight.plan.points.at(-1) as RoutePoint;
          throw new CommandRejected(
            `${aircraft.id} is holding because ${destination.name} is closed. It will go on when the aerodrome reopens; divert it to land elsewhere.`,
          );
        }
        const resumed = { ...flight, progress: { ...flight.progress, hold: null } };
        this.flights.set(flight.id, {
          ...resumed,
          ...this.projection(resumed, model, context?.hazards ?? NO_HAZARDS),
        });
        return { aircraftId: aircraft.id, flightId: flight.id, missionId: flight.missionId };
      }

      case 'updatePerformance': {
        const aircraft = this.require(command.aircraftId);
        this.onGround(aircraft, 'be given a new performance model');
        const { performance } = command;
        if (JSON.stringify(performance) === JSON.stringify(aircraft.performance)) return null;
        // Loads the new model cannot hold are reduced to what it can.
        const fuelKg = Math.min(aircraft.fuelKg, performance?.fuelCapacityKg ?? 0);
        const payloadKg = performance
          ? Math.max(
              Math.min(
                aircraft.payloadKg,
                performance.maxTakeoffMassKg - performance.emptyMassKg - fuelKg,
              ),
              0,
            )
          : 0;
        this.aircraft.set(aircraft.id, {
          ...aircraft,
          performance,
          performanceMissing: performance ? [] : command.performanceMissing,
          fuelKg,
          payloadKg,
        });
        return { aircraftId: aircraft.id };
      }

      case 'startMaintenance': {
        const aircraft = this.require(command.aircraftId);
        this.onGround(aircraft, 'be maintained');
        if (aircraft.status === 'in_maintenance') return null;
        this.aircraft.set(aircraft.id, {
          ...aircraft,
          status: 'in_maintenance',
          maintenanceCompleteTick: tick + MAINTENANCE.durationSeconds / STEP_S,
        });
        return { aircraftId: aircraft.id };
      }
    }
  }

  /** Advances every active flight and any maintenance by one step. Returns true if anything changed. */
  step(
    tick: number,
    rng: (stream: string) => Rng,
    emit: EmitEvent,
    /** Closed aerodromes and disrupted areas, announced or under way. */
    hazards: Hazards = NO_HAZARDS,
  ): boolean {
    let changed = false;

    for (const [flightId, derived] of [...this.active].sort(([a], [b]) => a.localeCompare(b))) {
      const { profile, route } = derived;
      let flight = this.flights.get(flightId) as FlightState;
      const aircraft = this.aircraft.get(flight.aircraftId) as AircraftState;
      const destination = flight.plan.points.at(-1) as RoutePoint;
      // The destination's closures are read again only when the hazards have changed.
      if (derived.hazards !== hazards) {
        derived.hazards = hazards;
        const closures = closuresOf(hazards, destination);
        const windows = (all: readonly ClosureWindow[]) =>
          all.map((closure) => `${closure.startTick}-${closure.endTick}`).join(',');
        const same = windows(closures) === windows(derived.closures);
        derived.closures = closures;
        // A closure announced for the destination changes when the aircraft will be down, so its
        // arrival is worked out again. Projection flies the engine's own step, so doing this again
        // for closures already allowed for (after a world is loaded) gives the figures it has. A
        // hold the operator ordered has no end to project until it is resumed.
        const model = aircraft.performance;
        if (!same && model && flight.progress.hold?.reason !== 'operator') {
          flight = { ...flight, ...this.projection(flight, model, hazards) };
        }
      }
      const before = flight.progress;
      const progress = advanceInWeather(
        profile,
        before,
        STEP_S,
        this.weather
          ? {
              weather: this.weather,
              route,
              departureTick: flight.departedTick,
              closures: derived.closures,
            }
          : null,
      );
      changed = true;
      const subject = { aircraftId: aircraft.id, flightId, missionId: flight.missionId };

      // What the step decided about holding, said once, when it happened (ADR 0026).
      if (before.hold === null && progress.hold !== null) {
        emit('flightHolding', subject, { reason: progress.hold.reason, at: destination.name });
        flight = { ...flight, stillAirDurationS: null, stillAirFuelUsedKg: null };
      } else if (before.hold !== null && progress.hold === null) {
        const reason = progress.closureLanding
          ? 'landing_during_closure'
          : before.hold.reason === 'closure' &&
              !closedForArrival(profile, before, tick - 1, derived.closures)
            ? 'reopened'
            : 'fuel_at_reserve';
        emit('flightHoldEnded', subject, {
          reason,
          heldS: progress.heldS,
          fuelKg: progress.fuelKg,
          at: destination.name,
        });
        const model = aircraft.performance;
        if (model) {
          flight = { ...flight, ...this.projection({ ...flight, progress }, model, hazards) };
        }
      } else if (!before.closureLanding && progress.closureLanding) {
        // At the top of descent with no fuel to hold: it goes straight down to the closed aerodrome.
        emit('flightHoldEnded', subject, {
          reason: 'landing_during_closure',
          heldS: progress.heldS,
          fuelKg: progress.fuelKg,
          at: destination.name,
        });
      }

      if (progress.phase === 'landed') {
        const hours = progress.elapsedS / 3600;
        const variation = 1 + MAINTENANCE.wearVariation * (rng(WEAR_STREAM).nextFloat() * 2 - 1);
        // Time flown with a technical caution showing wears the aircraft further.
        const cautionHours = flight.caution
          ? ((tick - flight.caution.sinceTick) * STEP_S) / 3600
          : 0;
        const wear =
          (MAINTENANCE.wearPctPerFlightHour * hours + MAINTENANCE.wearPctPerFlight) * variation +
          MAINTENANCE.cautionWearPctPerFlightHour * cautionHours;
        const landed: AircraftState = {
          ...aircraft,
          location: destination,
          fuelKg: progress.fuelKg,
          conditionPct: Math.max(aircraft.conditionPct - wear, 0),
          flightSecondsTotal: aircraft.flightSecondsTotal + progress.elapsedS,
          flightSecondsSinceMaintenance: aircraft.flightSecondsSinceMaintenance + progress.elapsedS,
          flights: aircraft.flights + 1,
          activeFlightId: null,
          status: 'available',
        };
        // A caution, or a landing made at a closed aerodrome, is inspected before it flies again.
        const inspection = flight.caution !== null || progress.closureLanding;
        const due = maintenanceDue(landed) || inspection;
        this.aircraft.set(aircraft.id, {
          ...landed,
          status: due ? 'maintenance_due' : 'available',
        });
        this.finish({ ...flight, progress, status: 'completed', arrivedTick: tick });
        emit(
          'flightCompleted',
          { aircraftId: aircraft.id, flightId, missionId: flight.missionId },
          {
            destination: destination.code ?? destination.name,
            durationS: progress.elapsedS,
            fuelRemainingKg: progress.fuelKg,
            wearPct: wear,
            ...(flight.revisions.length > 0 && {
              plannedDestination:
                flight.plannedPlan.points.at(-1)?.code ?? flight.plannedPlan.points.at(-1)?.name,
              revisions: flight.revisions.length,
            }),
            ...(progress.heldS > 0 && { heldS: progress.heldS }),
            ...(progress.closureLanding && { landedDuringClosure: true }),
            ...(flight.caution && { cautionEventId: flight.caution.eventId }),
            // What the weather cost, against the same plan in still air.
            ...(flight.stillAirDurationS !== null &&
              flight.stillAirFuelUsedKg !== null && {
                weatherDelayS: progress.elapsedS - flight.stillAirDurationS,
                weatherFuelKg:
                  flight.fuelAtDepartureKg - progress.fuelKg - flight.stillAirFuelUsedKg,
                worstSeverity: progress.exposure.worstSeverity,
              }),
          },
        );
        if (due) {
          emit(
            'maintenanceDue',
            { aircraftId: aircraft.id },
            progress.closureLanding
              ? { reason: 'Landed during a closure with fuel at reserve.' }
              : flight.caution
                ? { reason: 'A technical caution showed in flight.' }
                : {},
          );
        }
      } else if (progress.fuelExhausted) {
        // Abstract outcome: the aircraft is down where it ran out and must be recovered.
        const position = positionAlong(route, progress.distanceM);
        this.aircraft.set(aircraft.id, {
          ...aircraft,
          location: {
            kind: 'waypoint',
            name: 'Forced landing site',
            lat: position.lat,
            lon: position.lon,
            elevationM: 0,
          },
          fuelKg: 0,
          conditionPct: 0,
          flightSecondsTotal: aircraft.flightSecondsTotal + progress.elapsedS,
          flightSecondsSinceMaintenance: aircraft.flightSecondsSinceMaintenance + progress.elapsedS,
          flights: aircraft.flights + 1,
          activeFlightId: null,
          status: 'unserviceable',
        });
        this.finish({ ...flight, progress, status: 'fuel_exhausted', arrivedTick: tick });
        emit(
          'flightFuelExhausted',
          { aircraftId: aircraft.id, flightId, missionId: flight.missionId },
          { distanceM: progress.distanceM, lat: position.lat, lon: position.lon },
        );
      } else {
        this.flights.set(flightId, { ...flight, progress });
        this.aircraft.set(aircraft.id, { ...aircraft, fuelKg: progress.fuelKg });
      }
    }

    const finishing: AircraftState[] = [];
    for (const aircraft of this.aircraft.values()) {
      if (
        aircraft.status === 'in_maintenance' &&
        aircraft.maintenanceCompleteTick !== null &&
        tick >= aircraft.maintenanceCompleteTick
      ) {
        finishing.push(aircraft);
      }
    }
    // Identifier order, so that the events are logged in the same order every time.
    for (const aircraft of finishing.sort((x, y) => x.id.localeCompare(y.id))) {
      this.aircraft.set(aircraft.id, {
        ...aircraft,
        status: 'available',
        conditionPct: 100,
        flightSecondsSinceMaintenance: 0,
        maintenanceCompleteTick: null,
        // An aircraft recovered from a forced landing is returned to its home aerodrome.
        location: aircraft.location?.kind === 'aerodrome' ? aircraft.location : aircraft.home,
      });
      emit('maintenanceCompleted', { aircraftId: aircraft.id });
      changed = true;
    }
    return changed;
  }

  private finish(flight: FlightState): void {
    this.flights.set(flight.id, flight);
    this.active.delete(flight.id);
    // Forget the oldest finished flights beyond the in-memory limit. They stay in the database.
    const finished = [...this.flights.values()].filter(
      (candidate) => candidate.status !== 'active',
    );
    if (finished.length > RECENT_FLIGHTS) {
      finished
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, finished.length - RECENT_FLIGHTS)
        .forEach((old) => this.flights.delete(old.id));
    }
  }

  snapshot(): FleetSnapshot {
    const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
    return {
      aircraft: [...this.aircraft.values()].sort(byId),
      flights: [...this.flights.values()].sort(byId),
      counters: Object.fromEntries([...this.counters].sort(([a], [b]) => a.localeCompare(b))),
      starterFleetSeeded: this.starterFleetSeeded,
    };
  }

  view(): FleetView {
    const snapshot = this.snapshot();
    const activeFlights: FlightView[] = [];
    for (const flight of snapshot.flights) {
      const derived = this.active.get(flight.id);
      if (!derived) continue;
      const position = positionAlong(derived.route, flight.progress.distanceM);
      const conditions = this.weather
        ? conditionsForFlight(
            { weather: this.weather, route: derived.route, departureTick: flight.departedTick },
            flight.progress,
          )
        : null;
      activeFlights.push({
        id: flight.id,
        aircraftId: flight.aircraftId,
        lat: position.lat,
        lon: position.lon,
        headingDeg: position.headingDeg,
        phase: flight.progress.phase,
        altitudeM: flight.progress.altitudeM,
        speedKmh: flight.progress.speedKmh,
        fuelKg: flight.progress.fuelKg,
        burnRateKgH: flight.progress.burnRateKgH,
        distanceM: flight.progress.distanceM,
        totalM: derived.route.totalM,
        elapsedS: flight.progress.elapsedS,
        etaTick: flight.departedTick + flight.projectedDurationS / STEP_S,
        estimatedFuelAtDestinationKg: flight.fuelAtDepartureKg - flight.projectedFuelUsedKg,
        points: flight.plan.points,
        hold: flight.progress.hold?.reason ?? null,
        heldS: flight.progress.heldS,
        closureLanding: flight.progress.closureLanding,
        intent: flight.revisions.at(-1)?.intent ?? null,
        revisions: flight.revisions,
        plannedDestination: flight.plannedPlan.points.at(-1) as RoutePoint,
        caution: flight.caution,
        missionId: flight.missionId,
        departedTick: flight.departedTick,
        payloadKg: flight.payloadKg,
        progress: flight.progress,
        cruiseAltitudeM: flight.plan.cruiseAltitudeM,
        cruiseSpeedKmh: flight.plan.cruiseSpeedKmh,
        groundSpeedKmh: groundSpeedKmh(flight.progress.speedKmh, flight.progress.environment),
        tailwindKmh: flight.progress.environment.tailwindKmh,
        windFromDeg: conditions?.windFromDeg ?? 0,
        windSpeedKmh: conditions?.windSpeedKmh ?? 0,
        outsideTemperatureC: conditions?.temperatureC ?? 15,
        visibilityKm: conditions?.visibilityKm ?? 40,
        precipitation: conditions?.precipitation ?? 0,
        severity: conditions?.severity ?? 0,
      });
    }
    return {
      aircraft: snapshot.aircraft,
      activeFlights,
      recentFlights: snapshot.flights.filter((flight) => flight.status !== 'active').reverse(),
      starterFleetSeeded: snapshot.starterFleetSeeded,
    };
  }
}

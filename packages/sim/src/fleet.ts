import {
  NO_HAZARDS,
  REVISION_INTENTS,
  advanceInWeather,
  closedForArrival,
  closuresOf,
  conditionsForFlight,
  evaluatePlan,
  evaluateRevision,
  fuelDiffers,
  fuelDuringTransfer,
  groundSpeedKmh,
  flightProfile,
  initialProgress,
  launchReadiness,
  positionAlong,
  postFlightChecksS,
  projectFlight,
  RESOURCE_KINDS,
  aerodromeCapability,
  aerodromeKey,
  awaitsPoint,
  classifiedPoint,
  forecastGroundServices,
  forecastService,
  holdsPoint,
  resourcePoints,
  retargetTransfer,
  routeGeometry,
  taskOf,
  transferFor,
  type AerodromeSize,
  type AircraftStatus,
  type ClosureWindow,
  type FlightLoad,
  type FlightPlan,
  type FlightProfile,
  type FlightProgress,
  type FlightRevision,
  type GroundService,
  type Hazards,
  type ResourceKind,
  type ServiceForecast,
  type ServiceTask,
  type Transfer,
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

export type { AircraftStatus };

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
  /** The ground servicing under way (ADR 0027). Present exactly while `status` is `servicing`. */
  readonly service: GroundService | null;
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
  /**
   * Brings a grounded aircraft's fuel to `fuelKg`, and its payload to `payloadKg` if one is
   * given, over simulated time (ADR 0027, ADR 0028). Given to an aircraft already being
   * serviced, it sets or changes what that servicing ends with.
   */
  | {
      readonly type: 'serviceAircraft';
      readonly aircraftId: string;
      readonly fuelKg: number;
      readonly payloadKg?: number;
    }
  /** Ends a fuel transfer where it is, or withdraws one that has not begun. */
  | { readonly type: 'stopServicing'; readonly aircraftId: string }
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

/** What is derived for a flight while it is active. Never persisted. */
interface ActiveFlight {
  profile: FlightProfile;
  route: RouteGeometry;
  /** The hazards the closures below were read from, to know when to read them again. */
  hazards: Hazards | null;
  closures: readonly ClosureWindow[];
}

const NO_CLOSURES: readonly ClosureWindow[] = [];

/** A service record as model 7 kept it: fuel only, and no queue (ADR 0027). */
interface Model7Service {
  readonly reason: GroundService['reason'];
  readonly startedTick: number;
  readonly stage: 'checks' | 'refuelling';
  readonly checksCompleteTick: number;
  readonly fuelAtStartKg: number;
  readonly targetFuelKg: number | null;
  readonly transfer: Transfer | null;
  readonly refuellingSinceTick: number | null;
  readonly missionId: string | null;
}

/**
 * An aircraft as it is held in memory. One saved before ground servicing existed has no service;
 * one saved by model 7 has a service in the older shape, which is carried over as it stands: the
 * same transfer, ending at the same tick, and no payload task.
 */
function restoredAircraft(saved: AircraftState): AircraftState {
  const partial: Partial<AircraftState> = saved;
  const service = (partial.service ?? null) as GroundService | Model7Service | null;
  if (!service || !('targetFuelKg' in service)) return { ...saved, service: service ?? null };
  const preparing = service.stage === 'refuelling';
  return {
    ...saved,
    service: {
      reason: service.reason,
      startedTick: service.startedTick,
      stage: preparing ? 'preparation' : 'checks',
      checksCompleteTick: service.checksCompleteTick,
      fuelAtStartKg: service.fuelAtStartKg,
      payloadAtStartKg: saved.payloadKg,
      fuel:
        service.targetFuelKg === null
          ? null
          : {
              targetKg: service.targetFuelKg,
              queuedTick: preparing
                ? (service.refuellingSinceTick ?? service.checksCompleteTick)
                : null,
              transfer: service.transfer,
              startedTick: service.refuellingSinceTick,
              completedTick: null,
            },
      payload: null,
      missionId: service.missionId,
    },
  };
}

const NO_ONE: ReadonlySet<string> = new Set();

const NO_EVENTS: EmitEvent = () => undefined;

const minutesOf = (seconds: number) => `${Math.ceil(seconds / 60)} min`;

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
    for (const aircraft of snapshot.aircraft) {
      this.aircraft.set(aircraft.id, restoredAircraft(aircraft));
    }
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
      const { service } = aircraft;
      if ((aircraft.status === 'servicing') !== (service !== null)) {
        throw new Error(`Saved aircraft ${aircraft.id} is serviced and not serviced at once`);
      }
      if (service?.stage === 'checks' && (service.fuel?.transfer || service.payload?.transfer)) {
        throw new Error(`Saved aircraft ${aircraft.id} has a transfer under way during its checks`);
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
      service: null,
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
    const origin = plan.points[0];
    if (!origin) throw new CommandRejected('The flight plan has no origin.');
    // The one readiness rule (ADR 0027): on the ground, serviceable, serviced, there, fuelled
    // and loaded.
    const readiness = launchReadiness(
      aircraft,
      { fuelKg: load.fuelKg, payloadKg: load.payloadKg, origin },
      tick,
      this.forecastOf(aircraft, tick),
    );
    const model = aircraft.performance;
    if (!readiness.ready || !model) {
      throw new CommandRejected(
        readiness.issues[0]?.message ?? `${aircraft.id} is not ready to launch.`,
      );
    }
    // The flight departs with the fuel and payload that are aboard, which are those planned.
    const fuelKg = aircraft.fuelKg;
    const payloadKg = aircraft.payloadKg;
    const evaluation = evaluatePlan(model, plan, { fuelKg, payloadKg }, context);
    const blocked = evaluation.constraints.find((constraint) => constraint.severity === 'block');
    if (blocked || !evaluation.estimate) {
      throw new CommandRejected(blocked?.message ?? 'The flight plan cannot be flown.');
    }
    const profile = flightProfile(model, plan, payloadKg);
    const flight: FlightState = {
      id: this.nextId('FLT', 6),
      aircraftId: aircraft.id,
      status: 'active',
      missionId,
      plan,
      plannedPlan: plan,
      revisions: [],
      caution: null,
      payloadKg,
      fuelAtDepartureKg: fuelKg,
      departedTick: tick,
      arrivedTick: null,
      estimatedDurationS: evaluation.estimate.durationS,
      estimatedFuelUsedKg: evaluation.estimate.fuelUsedKg,
      projectedDurationS: evaluation.estimate.durationS,
      projectedFuelUsedKg: evaluation.estimate.fuelUsedKg,
      stillAirDurationS: evaluation.estimate.weather?.stillAirDurationS ?? null,
      stillAirFuelUsedKg: evaluation.estimate.weather?.stillAirFuelUsedKg ?? null,
      progress: initialProgress(profile, fuelKg),
    };
    this.flights.set(flight.id, flight);
    this.activate(flight, model);
    this.aircraft.set(aircraft.id, {
      ...aircraft,
      status: 'in_flight',
      location: null,
      activeFlightId: flight.id,
    });
    return flight.id;
  }

  /** When an aircraft's service will end, among everything at its aerodrome. */
  private forecastOf(aircraft: AircraftState, tick: number): ServiceForecast | null {
    return forecastService(aircraft, [...this.aircraft.values()], tick);
  }

  /** How long until an aircraft being serviced is available, in words. */
  private availableIn(aircraft: AircraftState, tick: number): string {
    return minutesOf((this.forecastOf(aircraft, tick)?.completeTick ?? tick) - tick);
  }

  /**
   * Ends one task of a service where it is: its point is given up, and the log says what was
   * moved. Returns the aircraft as it then is.
   */
  private finishTask(
    aircraft: AircraftState,
    kind: ResourceKind,
    tick: number,
    emit: EmitEvent,
  ): AircraftState {
    const service = aircraft.service;
    const task = service ? taskOf(service, kind) : null;
    if (!service || !task || task.completedTick !== null) return aircraft;
    const done: ServiceTask = { ...task, completedTick: tick };
    const next: AircraftState = {
      ...aircraft,
      service: kind === 'fuel' ? { ...service, fuel: done } : { ...service, payload: done },
    };
    this.aircraft.set(aircraft.id, next);
    const aboardKg = kind === 'fuel' ? aircraft.fuelKg : aircraft.payloadKg;
    const startKg = kind === 'fuel' ? service.fuelAtStartKg : service.payloadAtStartKg;
    emit(
      kind === 'fuel' ? 'refuellingCompleted' : 'loadingCompleted',
      { aircraftId: aircraft.id, missionId: service.missionId },
      {
        ...(kind === 'fuel' ? { fuelKg: aboardKg } : { payloadKg: aboardKg }),
        loadedKg: aboardKg - startKg,
        durationS: tick - (task.startedTick ?? tick),
        // Ended short of what was asked for, by the operator.
        ...(fuelDiffers(aboardKg, task.targetKg) && { stopped: true }),
      },
    );
    return next;
  }

  /** Ends a service: the aircraft is available, with the fuel and payload it holds. */
  private completeService(aircraftId: string, tick: number, emit: EmitEvent): void {
    let aircraft = this.aircraft.get(aircraftId);
    if (!aircraft?.service) return;
    // Anything still running ends where it is; anything still waiting is given up.
    for (const kind of RESOURCE_KINDS) {
      if (holdsPoint(taskOf(aircraft.service as GroundService, kind))) {
        aircraft = this.finishTask(aircraft, kind, tick, emit);
      }
    }
    const service = aircraft.service as GroundService;
    // Short of what was asked for: stopped by the operator, or given up while still waiting.
    const short =
      (service.fuel !== null && fuelDiffers(aircraft.fuelKg, service.fuel.targetKg)) ||
      (service.payload !== null && fuelDiffers(aircraft.payloadKg, service.payload.targetKg));
    const spent = (task: ServiceTask | null) =>
      task?.startedTick != null && task.completedTick !== null
        ? task.completedTick - task.startedTick
        : 0;
    const waited = (task: ServiceTask | null) =>
      task?.startedTick != null && task.queuedTick !== null
        ? task.startedTick - task.queuedTick
        : 0;
    this.aircraft.set(aircraft.id, { ...aircraft, status: 'available', service: null });
    emit(
      'servicingCompleted',
      { aircraftId: aircraft.id, missionId: service.missionId },
      {
        reason: service.reason,
        durationS: tick - service.startedTick,
        checksS: service.checksCompleteTick - service.startedTick,
        refuelS: spent(service.fuel),
        loadS: spent(service.payload),
        waitS: waited(service.fuel) + waited(service.payload),
        loadedKg: aircraft.fuelKg - service.fuelAtStartKg,
        payloadLoadedKg: aircraft.payloadKg - service.payloadAtStartKg,
        fuelKg: aircraft.fuelKg,
        payloadKg: aircraft.payloadKg,
        // What was asked for, to set beside what was done; absent where nothing was.
        ...(service.fuel && { fuelTargetKg: service.fuel.targetKg }),
        ...(service.payload && { payloadTargetKg: service.payload.targetKg }),
        ...(short && { stopped: true }),
        at: aircraft.location?.code ?? aircraft.location?.name ?? '',
      },
    );
  }

  /**
   * Gives free points to the aircraft at the head of each queue (ADR 0028). A point is held by an
   * aircraft whose transfer is running; the queue is the aircraft waiting, in the order they
   * began to. Those named in `announce` that still have to wait are recorded as queued.
   */
  private grant(tick: number, emit: EmitEvent, announce: ReadonlySet<string> = NO_ONE): void {
    const groups = new Map<string, AircraftState[]>();
    for (const aircraft of this.aircraft.values()) {
      if (!aircraft.service || aircraft.service.stage !== 'preparation' || !aircraft.location) {
        continue;
      }
      const key = aerodromeKey(aircraft.location);
      groups.set(key, [...(groups.get(key) ?? []), aircraft]);
    }
    for (const key of [...groups.keys()].sort()) {
      const capability = aerodromeCapability(
        (groups.get(key) as AircraftState[])[0]?.location ?? null,
      );
      for (const kind of RESOURCE_KINDS) {
        const here = (groups.get(key) as AircraftState[]).map(
          (each) => this.aircraft.get(each.id) as AircraftState,
        );
        const task = (each: AircraftState) => taskOf(each.service as GroundService, kind);
        let held = here.filter((each) => holdsPoint(task(each))).length;
        const queue = here
          .filter((each) => awaitsPoint(task(each)))
          .sort(
            (a, b) =>
              (task(a)?.queuedTick ?? 0) - (task(b)?.queuedTick ?? 0) || a.id.localeCompare(b.id),
          );
        for (const aircraft of queue) {
          if (held >= resourcePoints(capability, kind)) break;
          const service = aircraft.service as GroundService;
          const waiting = task(aircraft) as ServiceTask;
          const aboardKg = kind === 'fuel' ? aircraft.fuelKg : aircraft.payloadKg;
          const transfer = transferFor(
            kind,
            capability,
            aircraft.performance?.fuelCapacityKg ?? 0,
            tick,
            aboardKg,
            waiting.targetKg,
          );
          const started: ServiceTask = {
            ...waiting,
            transfer,
            startedTick: waiting.startedTick ?? tick,
          };
          this.aircraft.set(aircraft.id, {
            ...aircraft,
            service:
              kind === 'fuel' ? { ...service, fuel: started } : { ...service, payload: started },
          });
          held += 1;
          emit(
            kind === 'fuel' ? 'refuellingStarted' : 'loadingStarted',
            { aircraftId: aircraft.id, missionId: service.missionId },
            {
              fromKg: aboardKg,
              toKg: waiting.targetKg,
              durationS: transfer.completeTick - tick,
              ...(tick > (waiting.queuedTick ?? tick) && {
                waitedS: tick - (waiting.queuedTick ?? tick),
              }),
            },
          );
        }
      }
    }
    if (announce.size === 0) return;
    const forecasts = forecastGroundServices([...this.aircraft.values()], tick);
    for (const id of [...announce].sort()) {
      const aircraft = this.aircraft.get(id);
      const forecast = forecasts.get(id);
      if (!aircraft?.service || !forecast) continue;
      for (const waiting of [forecast.fuel, forecast.payload]) {
        if (waiting?.state !== 'waiting') continue;
        emit(
          'serviceQueued',
          { aircraftId: id, missionId: aircraft.service.missionId },
          {
            kind: waiting.kind,
            position: waiting.position,
            behind: waiting.behind,
            startTick: waiting.startTick,
            at: aircraft.location?.code ?? aircraft.location?.name ?? '',
          },
        );
      }
    }
  }

  /** True when a service in its preparation has nothing left to do. */
  private static finished(service: GroundService): boolean {
    return (
      service.stage === 'preparation' &&
      [service.fuel, service.payload].every((task) => task === null || task.completedTick !== null)
    );
  }

  /**
   * Brings a grounded aircraft's fuel, and its payload if one is given, to a target over time,
   * exactly as the `serviceAircraft` command does. Returns true if anything changed; throws
   * {@link CommandRejected}, changing nothing, if the aircraft cannot be serviced.
   */
  service(
    aircraftId: string,
    fuelKg: number,
    tick: number,
    missionId: string | null,
    emit: EmitEvent,
    payloadKg?: number,
  ): boolean {
    const aircraft = this.require(aircraftId);
    const location = this.onGround(aircraft, 'be serviced');
    const model = aircraft.performance;
    if (!model) {
      throw new CommandRejected(
        `${aircraft.id} has no performance model, so it cannot be fuelled.`,
      );
    }
    if (!Number.isFinite(fuelKg) || fuelKg < 0) {
      throw new CommandRejected('Fuel must be zero or more.');
    }
    if (fuelKg > model.fuelCapacityKg + 0.5) {
      throw new CommandRejected(
        `That is more fuel than ${aircraft.id} can hold (${Math.round(model.fuelCapacityKg)} kg).`,
      );
    }
    if (payloadKg !== undefined) {
      if (!Number.isFinite(payloadKg) || payloadKg < 0) {
        throw new CommandRejected('Payload must be zero or more.');
      }
      if (payloadKg > model.maxPayloadKg + 0.5) {
        throw new CommandRejected(
          `That is more payload than ${aircraft.id} can carry (${Math.round(model.maxPayloadKg)} kg).`,
        );
      }
    }
    if (aircraft.status === 'maintenance_due' || aircraft.status === 'in_maintenance') {
      throw new CommandRejected(
        `${aircraft.id} is ${aircraft.status === 'in_maintenance' ? 'in maintenance' : 'due maintenance'}; it is fuelled for a flight once that is done.`,
      );
    }
    if (aircraft.status === 'unserviceable') {
      throw new CommandRejected(`${aircraft.id} is unserviceable and cannot be serviced.`);
    }
    if (!aerodromeCapability(location).servicing) {
      throw new CommandRejected(
        `${aircraft.id} is at ${location.name}, which is not an aerodrome: nothing can be serviced there.`,
      );
    }

    const existing = aircraft.service;
    const stage = existing?.stage ?? 'preparation';
    /** The task a target comes to, given the task there is and what is aboard. */
    const retask = (
      task: ServiceTask | null,
      aboardKg: number,
      targetKg: number | undefined,
    ): ServiceTask | null => {
      if (targetKg === undefined) return task;
      if (task && holdsPoint(task)) {
        return task.targetKg === targetKg
          ? task
          : {
              ...task,
              targetKg,
              transfer: retargetTransfer(task.transfer as Transfer, tick, aboardKg, targetKg),
            };
      }
      // Done already, waiting, or behind the checks: what matters is what is still to move.
      if (!fuelDiffers(aboardKg, targetKg)) return task?.completedTick != null ? task : null;
      if (task && task.completedTick === null) return { ...task, targetKg };
      return {
        targetKg,
        queuedTick: stage === 'preparation' ? tick : null,
        transfer: null,
        startedTick: null,
        completedTick: null,
      };
    };
    const fuel = retask(existing?.fuel ?? null, aircraft.fuelKg, fuelKg);
    const payload = retask(existing?.payload ?? null, aircraft.payloadKg, payloadKg);
    const labelled = missionId ?? existing?.missionId ?? null;

    if (!existing) {
      if (!fuel && !payload) return false;
      this.aircraft.set(aircraft.id, {
        ...aircraft,
        status: 'servicing',
        service: {
          reason: 'preparation',
          startedTick: tick,
          stage: 'preparation',
          checksCompleteTick: tick,
          fuelAtStartKg: aircraft.fuelKg,
          payloadAtStartKg: aircraft.payloadKg,
          fuel,
          payload,
          missionId,
        },
      });
      // What follows from the grant is recorded after the start of the service itself.
      const caused: Parameters<EmitEvent>[] = [];
      this.grant(tick, (...event) => caused.push(event), new Set([aircraft.id]));
      const begun = this.aircraft.get(aircraft.id) as AircraftState;
      emit(
        'servicingStarted',
        { aircraftId: aircraft.id, missionId },
        {
          reason: 'preparation',
          ...(fuel && { targetFuelKg: fuel.targetKg }),
          ...(payload && { targetPayloadKg: payload.targetKg }),
          completeTick: this.forecastOf(begun, tick)?.completeTick ?? tick,
        },
      );
      for (const event of caused) emit(...event);
      return true;
    }

    const same = (a: ServiceTask | null, b: ServiceTask | null) =>
      JSON.stringify(a) === JSON.stringify(b);
    if (same(fuel, existing.fuel) && same(payload, existing.payload)) {
      if (labelled === existing.missionId) return false;
    }
    let next: AircraftState = {
      ...aircraft,
      service: { ...existing, fuel, payload, missionId: labelled },
    };
    this.aircraft.set(aircraft.id, next);
    if (stage === 'checks') return true;
    // A running transfer asked for what is already aboard has nothing left to move.
    for (const kind of RESOURCE_KINDS) {
      const task = taskOf(next.service as GroundService, kind);
      const aboardKg = kind === 'fuel' ? next.fuelKg : next.payloadKg;
      if (task && holdsPoint(task) && !fuelDiffers(aboardKg, task.targetKg)) {
        next = this.finishTask(next, kind, tick, emit);
      }
    }
    this.grant(tick, emit, new Set([aircraft.id]));
    const settled = this.aircraft.get(aircraft.id);
    if (settled?.service && Fleet.finished(settled.service)) {
      this.completeService(aircraft.id, tick, emit);
      this.grant(tick, emit);
    }
    return true;
  }

  /**
   * Ends running transfers where they are and gives up anything still waiting, exactly as the
   * `stopServicing` command does. Returns false if the aircraft is not being serviced.
   */
  stopService(aircraftId: string, tick: number, emit: EmitEvent): boolean {
    const aircraft = this.require(aircraftId);
    const service = aircraft.service;
    if (!service) return false;
    if (service.stage === 'preparation') {
      this.completeService(aircraft.id, tick, emit);
      // The points it held go to whoever is next.
      this.grant(tick, emit);
      return true;
    }
    if (!service.fuel && !service.payload) {
      throw new CommandRejected(
        `${aircraft.id} is in its post-flight checks, which cannot be skipped. It will be available in ${this.availableIn(aircraft, tick)}.`,
      );
    }
    // What was asked for after the checks is withdrawn; the checks go on.
    this.aircraft.set(aircraft.id, {
      ...aircraft,
      service: { ...service, fuel: null, payload: null, missionId: null },
    });
    return true;
  }

  /** Why an aircraft could not launch a load from a place now; `null` when it could. */
  launchIssue(
    aircraftId: string,
    load: FlightLoad,
    origin: RoutePoint | null,
    tick: number,
  ): string | null {
    const aircraft = this.aircraft.get(aircraftId);
    if (!aircraft) return `There is no aircraft ${aircraftId}.`;
    const readiness = launchReadiness(
      aircraft,
      { fuelKg: load.fuelKg, payloadKg: load.payloadKg, origin },
      tick,
      this.forecastOf(aircraft, tick),
    );
    return readiness.issues[0]?.message ?? null;
  }

  /**
   * Withdraws the work a mission asked for that has not begun, when the mission is released or
   * cancelled (ADR 0028). A transfer already running goes on to its end.
   */
  withdraw(missionId: string, tick: number, emit: EmitEvent): void {
    const prepared = [...this.aircraft.values()]
      .filter((aircraft) => aircraft.service?.missionId === missionId)
      .sort((a, b) => a.id.localeCompare(b.id));
    for (const aircraft of prepared) {
      const service = aircraft.service as GroundService;
      const kept = (task: ServiceTask | null) => (task && task.startedTick !== null ? task : null);
      const withdrawn = RESOURCE_KINDS.filter((kind) => {
        const task = taskOf(service, kind);
        return task !== null && task.startedTick === null;
      });
      const next: GroundService = {
        ...service,
        fuel: kept(service.fuel),
        payload: kept(service.payload),
        missionId: null,
      };
      this.aircraft.set(aircraft.id, { ...aircraft, service: next });
      if (withdrawn.length > 0) {
        emit('serviceWithdrawn', { aircraftId: aircraft.id, missionId }, { kinds: withdrawn });
      }
      if (Fleet.finished(next)) this.completeService(aircraft.id, tick, emit);
    }
    if (prepared.length > 0) this.grant(tick, emit);
  }

  /** Advances every ground service by a step. Returns true if anything changed. */
  private stepServices(tick: number, emit: EmitEvent): boolean {
    // Identifier order, so that the events are logged in the same order every time.
    const ids = [...this.aircraft.values()]
      .filter((aircraft) => aircraft.service !== null)
      .map((aircraft) => aircraft.id)
      .sort((a, b) => a.localeCompare(b));
    if (ids.length === 0) return false;
    let changed = false;
    const joined = new Set<string>();

    for (const id of ids) {
      let aircraft = this.aircraft.get(id) as AircraftState;
      const service = aircraft.service as GroundService;
      if (service.stage === 'checks') {
        if (tick < service.checksCompleteTick) continue;
        // The checks are over: what was asked for joins the queue for its point.
        const queued = (task: ServiceTask | null, aboardKg: number): ServiceTask | null =>
          task && fuelDiffers(aboardKg, task.targetKg) ? { ...task, queuedTick: tick } : null;
        this.aircraft.set(id, {
          ...aircraft,
          service: {
            ...service,
            stage: 'preparation',
            fuel: queued(service.fuel, aircraft.fuelKg),
            payload: queued(service.payload, aircraft.payloadKg),
          },
        });
        joined.add(id);
        changed = true;
        continue;
      }
      for (const kind of RESOURCE_KINDS) {
        const task = taskOf(aircraft.service as GroundService, kind);
        if (!task?.transfer || task.completedTick !== null) continue;
        // Computed from the transfer and the tick, never added to: the same at any speed, and
        // after any number of saves (ADR 0027).
        const aboardKg = fuelDuringTransfer(task.transfer, tick);
        const before = kind === 'fuel' ? aircraft.fuelKg : aircraft.payloadKg;
        if (aboardKg !== before) {
          aircraft =
            kind === 'fuel'
              ? { ...aircraft, fuelKg: aboardKg }
              : { ...aircraft, payloadKg: aboardKg };
          this.aircraft.set(id, aircraft);
          changed = true;
        }
        if (tick >= task.transfer.completeTick) {
          aircraft = this.finishTask(aircraft, kind, tick, emit);
          changed = true;
        }
      }
    }
    // Points given up in this step are taken in it, by the head of each queue.
    this.grant(tick, emit, joined);
    for (const id of ids) {
      const service = this.aircraft.get(id)?.service;
      if (service && Fleet.finished(service)) {
        this.completeService(id, tick, emit);
        changed = true;
      }
    }
    return changed;
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

  /**
   * Has a delivered payload taken off by the turnaround the aircraft has just begun (ADR 0029):
   * after its checks, at the aerodrome's payload handling, in its turn. Returns false, changing
   * nothing, when there is no turnaround to do it (maintenance is due instead) or nothing aboard:
   * the payload then stays aboard until the aircraft is next prepared.
   */
  unload(aircraftId: string): boolean {
    const aircraft = this.aircraft.get(aircraftId);
    const service = aircraft?.service;
    if (!aircraft || !service || service.stage !== 'checks' || service.payload) return false;
    if (!fuelDiffers(aircraft.payloadKg, 0)) return false;
    this.aircraft.set(aircraftId, {
      ...aircraft,
      service: {
        ...service,
        payload: {
          targetKg: 0,
          queuedTick: null,
          transfer: null,
          startedTick: null,
          completedTick: null,
        },
      },
    });
    return true;
  }

  /**
   * Gives aerodromes that lack a size class the one the reference data holds (ADR 0029): where
   * aircraft are based, where they are, and where flights in the air are going. Returns true if
   * anything changed.
   */
  classify(sizes: Readonly<Record<string, AerodromeSize>>): boolean {
    // Counts the points given a class, so that finding none changes nothing.
    let classified = 0;
    const point = (given: RoutePoint): RoutePoint => {
      const result = classifiedPoint(given, sizes);
      if (result !== given) classified += 1;
      return result;
    };
    for (const aircraft of [...this.aircraft.values()]) {
      const home = point(aircraft.home);
      const location = aircraft.location ? point(aircraft.location) : null;
      if (home !== aircraft.home || location !== aircraft.location) {
        this.aircraft.set(aircraft.id, { ...aircraft, home, location });
      }
    }
    for (const flight of [...this.flights.values()]) {
      if (flight.status !== 'active') continue;
      const before = classified;
      const plan = { ...flight.plan, points: flight.plan.points.map(point) };
      const plannedPlan = { ...flight.plannedPlan, points: flight.plannedPlan.points.map(point) };
      if (classified > before) this.flights.set(flight.id, { ...flight, plan, plannedPlan });
    }
    return classified > 0;
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
    /** Where the command reports what it caused, beyond itself (ADR 0027). */
    emit: EmitEvent = NO_EVENTS,
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

      case 'serviceAircraft':
        return this.service(command.aircraftId, command.fuelKg, tick, null, emit, command.payloadKg)
          ? { aircraftId: command.aircraftId }
          : null;

      case 'stopServicing':
        return this.stopService(command.aircraftId, tick, emit)
          ? { aircraftId: command.aircraftId }
          : null;

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
        if (aircraft.service) {
          throw new CommandRejected(
            `${aircraft.id} is being serviced; it takes a new performance model once that is done.`,
          );
        }
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
        if (aircraft.service) {
          throw new CommandRejected(
            `${aircraft.id} is being serviced. Maintenance can start when it is available, in ${this.availableIn(aircraft, tick)}.`,
          );
        }
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
        // A healthy aircraft is turned round before it is available again (ADR 0027). One due
        // maintenance is not: maintenance is what it waits for.
        const checksS = postFlightChecksS(progress.elapsedS);
        const turnaround: GroundService = {
          reason: 'turnaround',
          startedTick: tick,
          stage: 'checks',
          checksCompleteTick: tick + checksS / STEP_S,
          fuelAtStartKg: progress.fuelKg,
          payloadAtStartKg: landed.payloadKg,
          fuel: null,
          payload: null,
          missionId: null,
        };
        this.aircraft.set(
          aircraft.id,
          due
            ? { ...landed, status: 'maintenance_due' }
            : { ...landed, status: 'servicing', service: turnaround },
        );
        this.finish({ ...flight, progress, status: 'completed', arrivedTick: tick });
        emit(
          'flightCompleted',
          { aircraftId: aircraft.id, flightId, missionId: flight.missionId },
          {
            destination: destination.code ?? destination.name,
            durationS: progress.elapsedS,
            fuelRemainingKg: progress.fuelKg,
            wearPct: wear,
            // The post-flight checks that follow; absent when maintenance is due instead.
            ...(!due && { turnaroundS: checksS }),
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
        } else {
          emit(
            'servicingStarted',
            { aircraftId: aircraft.id },
            { reason: 'turnaround', checksS, completeTick: turnaround.checksCompleteTick },
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

    if (this.stepServices(tick, emit)) changed = true;

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

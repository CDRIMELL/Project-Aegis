import {
  advanceFlight,
  evaluatePlan,
  flightProfile,
  greatCircleDistance,
  grossMassKg,
  initialProgress,
  positionAlong,
  routeGeometry,
  type FlightLoad,
  type FlightPlan,
  type FlightProfile,
  type FlightProgress,
  type PerformanceModel,
  type Rng,
  type RouteGeometry,
  type RoutePoint,
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

/** Simulation assumptions for wear and maintenance. Not reference data. */
export const MAINTENANCE = {
  wearPctPerFlightHour: 0.4,
  wearPctPerFlight: 0.5,
  /** Wear varies by this fraction either way, from the world's seeded random stream. */
  wearVariation: 0.1,
  dueAfterFlightSeconds: 50 * 3600,
  dueBelowConditionPct: 60,
  durationSeconds: 6 * 3600,
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
  readonly plan: FlightPlan;
  readonly payloadKg: number;
  readonly fuelAtDepartureKg: number;
  readonly departedTick: number;
  readonly arrivedTick: number | null;
  /** The planner's estimate at launch, kept for comparison with the outcome. */
  readonly estimatedDurationS: number;
  readonly estimatedFuelUsedKg: number;
  readonly progress: FlightProgress;
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

export class Fleet {
  private readonly aircraft = new Map<string, AircraftState>();
  private readonly flights = new Map<string, FlightState>();
  private readonly counters = new Map<string, number>();
  private starterFleetSeeded: boolean;
  /** Route geometry and profile of each active flight. Derived from the plan; never persisted. */
  private readonly active = new Map<string, { profile: FlightProfile; route: RouteGeometry }>();

  constructor(snapshot: FleetSnapshot = EMPTY_FLEET) {
    for (const aircraft of snapshot.aircraft) this.aircraft.set(aircraft.id, aircraft);
    for (const flight of snapshot.flights) this.flights.set(flight.id, flight);
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
   * Applies a command. Returns what it touched, or `null` if it had no effect (so nothing needs
   * saving or logging); throws {@link CommandRejected} if it cannot be carried out, leaving the
   * fleet exactly as it was.
   */
  apply(command: FleetCommand, tick: number): CommandEffect | null {
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
        const aircraft = this.require(command.aircraftId);
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
        const origin = command.plan.points[0];
        if (!origin || !samePlace(origin, location)) {
          throw new CommandRejected(
            `${aircraft.id} is at ${location.name}; the flight must start there.`,
          );
        }
        const evaluation = evaluatePlan(model, command.plan, command.load);
        const blocked = evaluation.constraints.find(
          (constraint) => constraint.severity === 'block',
        );
        if (blocked || !evaluation.estimate) {
          throw new CommandRejected(blocked?.message ?? 'The flight plan cannot be flown.');
        }
        const profile = flightProfile(model, command.plan, command.load.payloadKg);
        const flight: FlightState = {
          id: this.nextId('FLT', 6),
          aircraftId: aircraft.id,
          status: 'active',
          plan: command.plan,
          payloadKg: command.load.payloadKg,
          fuelAtDepartureKg: command.load.fuelKg,
          departedTick: tick,
          arrivedTick: null,
          estimatedDurationS: evaluation.estimate.durationS,
          estimatedFuelUsedKg: evaluation.estimate.fuelUsedKg,
          progress: initialProgress(profile, command.load.fuelKg),
        };
        this.flights.set(flight.id, flight);
        this.activate(flight, model);
        this.aircraft.set(aircraft.id, {
          ...aircraft,
          status: 'in_flight',
          location: null,
          fuelKg: command.load.fuelKg,
          payloadKg: command.load.payloadKg,
          activeFlightId: flight.id,
        });
        return { aircraftId: aircraft.id, flightId: flight.id };
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
  step(tick: number, rng: (stream: string) => Rng, emit: EmitEvent): boolean {
    let changed = false;

    for (const [flightId, { profile, route }] of [...this.active].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const flight = this.flights.get(flightId) as FlightState;
      const aircraft = this.aircraft.get(flight.aircraftId) as AircraftState;
      const progress = advanceFlight(profile, flight.progress, STEP_S);
      changed = true;

      if (progress.phase === 'landed') {
        const destination = flight.plan.points.at(-1) as RoutePoint;
        const hours = progress.elapsedS / 3600;
        const variation = 1 + MAINTENANCE.wearVariation * (rng(WEAR_STREAM).nextFloat() * 2 - 1);
        const wear =
          (MAINTENANCE.wearPctPerFlightHour * hours + MAINTENANCE.wearPctPerFlight) * variation;
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
        const due = maintenanceDue(landed);
        this.aircraft.set(aircraft.id, {
          ...landed,
          status: due ? 'maintenance_due' : 'available',
        });
        this.finish({ ...flight, progress, status: 'completed', arrivedTick: tick });
        emit(
          'flightCompleted',
          { aircraftId: aircraft.id, flightId },
          {
            destination: destination.code ?? destination.name,
            durationS: progress.elapsedS,
            fuelRemainingKg: progress.fuelKg,
            wearPct: wear,
          },
        );
        if (due) emit('maintenanceDue', { aircraftId: aircraft.id });
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
          { aircraftId: aircraft.id, flightId },
          { distanceM: progress.distanceM, lat: position.lat, lon: position.lon },
        );
      } else {
        this.flights.set(flightId, { ...flight, progress });
        this.aircraft.set(aircraft.id, { ...aircraft, fuelKg: progress.fuelKg });
      }
    }

    for (const aircraft of [...this.aircraft.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      if (
        aircraft.status === 'in_maintenance' &&
        aircraft.maintenanceCompleteTick !== null &&
        tick >= aircraft.maintenanceCompleteTick
      ) {
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
        etaTick: flight.departedTick + flight.estimatedDurationS / STEP_S,
        estimatedFuelAtDestinationKg: flight.fuelAtDepartureKg - flight.estimatedFuelUsedKg,
        points: flight.plan.points,
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

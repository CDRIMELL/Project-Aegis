import {
  GENERATION,
  MISSION_PRIORITIES,
  MISSION_TEMPLATES,
  MISSION_TYPES,
  canTransition,
  defaultObjectives,
  evaluateMission,
  evaluateObjective,
  generateOpportunity,
  greatCircleDistance,
  isFinished,
  isValidLatLon,
  missionAssessment,
  missionRoute,
  newObjectives,
  objectiveProblem,
  objectivesMet,
  resetObjectives,
  routeProblems,
  offeredFuelKg,
  type FlightLoad,
  type FlightPlan,
  type Hazards,
  type LatLon,
  type MaintenancePolicy,
  type Mission,
  type MissionBrief,
  type MissionOutcome,
  type MissionPriority,
  type MissionStatus,
  type MissionType,
  type Objective,
  type ObjectiveContext,
  type ObjectiveInput,
  type PlanContext,
  type RevisionIntent,
  type Rng,
  type RoutePoint,
  type WeatherModel,
  type WorldEvent,
} from '@aegis/domain';
import {
  CommandRejected,
  MAINTENANCE,
  type AircraftState,
  type CommandEffect,
  type FlightState,
} from './fleet';
import type { AffectableMission } from './events';
import type { EmitEvent } from './log';

/*
 * Missions (ADR 0017): operational intent over the fleet.
 *
 * A mission never moves an aircraft. Launching one launches a flight through the fleet, which
 * validates it like any other; each step the mission reads that flight and judges its objectives.
 * Everything here is fictional simulation state.
 */

/** Seconds of simulated time in one engine step. */
const STEP_S = 1;

/** How many finished missions the engine keeps in memory. Older ones remain in the database. */
export const RECENT_MISSIONS = 100;

/** The most aerodromes an operating area may hold. */
export const MAX_OPERATING_AREA = 200;

const GENERATION_STREAM = 'missions.generation';

/** The fleet's wear and maintenance rules, in the form the mission layer evaluates against. */
export const MAINTENANCE_POLICY: MaintenancePolicy = {
  dueAfterFlightSeconds: MAINTENANCE.dueAfterFlightSeconds,
  dueBelowConditionPct: MAINTENANCE.dueBelowConditionPct,
  expectedWearPct: (durationS) =>
    (MAINTENANCE.wearPctPerFlightHour * durationS) / 3600 + MAINTENANCE.wearPctPerFlight,
};

export interface MissionsSnapshot {
  /** Every unfinished mission and the most recent finished ones. */
  readonly missions: readonly Mission[];
  /** The operating area: public aerodromes copied into the world for generation. */
  readonly places: readonly RoutePoint[];
  /** Number the next mission will take. */
  readonly nextNumber: number;
  /** How many opportunities the world has generated. */
  readonly generated: number;
  /** The point the operating area was chosen around; `null` until it has one. */
  readonly areaCentre: LatLon | null;
}

export const EMPTY_MISSIONS: MissionsSnapshot = {
  missions: [],
  places: [],
  nextNumber: 1,
  generated: 0,
  areaCentre: null,
};

/** The player's configuration of a mission. The application builds it from a template. */
export interface MissionConfiguration {
  readonly title: string;
  readonly description: string;
  readonly priority: MissionPriority;
  readonly brief: MissionBrief;
  readonly aircraftId: string | null;
  readonly plan: FlightPlan | null;
  readonly load: FlightLoad | null;
  readonly objectives: readonly ObjectiveInput[];
  readonly plannedStartTick: number | null;
  readonly completeByTick: number | null;
}

export interface ConfigurationOptions {
  readonly title?: string;
  readonly description?: string;
  readonly priority?: MissionPriority;
  readonly plannedStartTick?: number | null;
  readonly completeByTick?: number | null;
  /** The world the mission would be flown in, so that the fuel offered allows for the weather. */
  readonly context?: PlanContext | null;
}

/**
 * The configuration a template gives a brief and an aircraft: the default route from where the
 * aircraft is, fuel to arrive on reserve with a contingency, and the template's objectives. The player may then
 * change any of it. Without an aircraft that can fly, or with an incomplete brief, the result has
 * no route and the mission stays a draft.
 */
export function defaultConfiguration(
  type: MissionType,
  brief: MissionBrief,
  aircraft: AircraftState | null,
  options: ConfigurationOptions = {},
): MissionConfiguration {
  const template = MISSION_TEMPLATES[type];
  const completeByTick = options.completeByTick ?? null;
  const model = aircraft?.performance ?? null;
  const origin = aircraft?.location ?? null;
  const plan = model && origin ? missionRoute(model, origin, brief) : null;
  let load: FlightLoad | null = null;
  if (model && plan) {
    const fuelKg =
      offeredFuelKg(model, plan, brief.payloadKg, options.context ?? null) ??
      // The route is beyond the aircraft: offer the most it can carry and let validation say so.
      Math.max(
        Math.min(
          model.fuelCapacityKg,
          model.maxTakeoffMassKg - model.emptyMassKg - brief.payloadKg,
        ),
        0,
      );
    load = { fuelKg, payloadKg: brief.payloadKg };
  }
  const where = brief.destination?.name ?? brief.target?.name;
  return {
    title: options.title ?? (where ? `${template.label}: ${where}` : template.label),
    description: options.description ?? template.description,
    priority: options.priority ?? template.priority,
    brief,
    aircraftId: aircraft?.id ?? null,
    plan,
    load: plan ? load : null,
    objectives: defaultObjectives(
      template,
      brief,
      completeByTick,
      MAINTENANCE.dueBelowConditionPct,
    ),
    plannedStartTick: options.plannedStartTick ?? null,
    completeByTick,
  };
}

export type MissionCommand =
  /**
   * Copies the operating area into the world, or replaces it when the fleet has moved (ADR 0022).
   * `centre` is the point it was chosen around. Has no effect if the area is unchanged.
   */
  | {
      readonly type: 'setOperatingArea';
      readonly places: readonly RoutePoint[];
      readonly centre?: LatLon;
    }
  | ({ readonly type: 'createMission'; readonly missionType: MissionType } & MissionConfiguration)
  /** Replaces the configuration of a mission that has not been accepted. */
  | ({ readonly type: 'updateMission'; readonly missionId: string } & MissionConfiguration)
  /** Takes up a world-generated opportunity; it becomes a draft to configure. */
  | { readonly type: 'acceptOffer'; readonly missionId: string }
  | { readonly type: 'rejectOffer'; readonly missionId: string }
  /** Commits a planned mission: its aircraft is assigned to it. */
  | { readonly type: 'acceptMission'; readonly missionId: string }
  /** Withdraws acceptance: the aircraft is released and the mission can be edited again. */
  | { readonly type: 'releaseMission'; readonly missionId: string }
  | { readonly type: 'cancelMission'; readonly missionId: string }
  | { readonly type: 'launchMission'; readonly missionId: string }
  /**
   * Gives up a mission whose flight is airborne (ADR 0026). The mission ends at once; the flight
   * goes on as an ordinary flight to land where `landing` says, which the operator must choose.
   */
  | {
      readonly type: 'abortMission';
      readonly missionId: string;
      readonly landing: AbortLanding;
    };

/** Where an aborted mission's flight is to land. */
export type AbortLanding =
  /** On to the destination it is already bound for. */
  | { readonly intent: 'continue' }
  /** Back to where it took off, or to another aerodrome, by the route given. */
  | { readonly intent: 'return' | 'divert'; readonly points: readonly RoutePoint[] };

/** The reason recorded on every objective an abort leaves undone. */
export const ABORTED_REMARK = 'Mission aborted.';

export const MISSION_COMMAND_TYPES: ReadonlySet<string> = new Set<MissionCommand['type']>([
  'setOperatingArea',
  'createMission',
  'updateMission',
  'acceptOffer',
  'rejectOffer',
  'acceptMission',
  'releaseMission',
  'cancelMission',
  'launchMission',
  'abortMission',
]);

/** What missions need from the fleet. The fleet implements it; missions never reach past it. */
export interface FleetPort {
  aircraftById(id: string): AircraftState | undefined;
  groundedAircraft(): readonly AircraftState[];
  flightById(id: string): FlightState | undefined;
  /** Where a flight is now, or where it ended, and the length of its route. */
  flightTrack(flight: FlightState): { readonly position: LatLon; readonly totalM: number };
  /** Launches a flight exactly as the `launchFlight` command does. Returns the flight's id. */
  launch(
    aircraftId: string,
    plan: FlightPlan,
    load: FlightLoad,
    tick: number,
    missionId: string | null,
    context: PlanContext | null,
  ): string;
  /**
   * Changes the rest of an airborne flight's route exactly as the `reviseFlight` command does.
   * Returns `null` when the route asked for is the one already being flown.
   */
  revise(
    aircraftId: string,
    intent: RevisionIntent,
    points: readonly RoutePoint[],
    tick: number,
    hazards: Hazards,
  ): string | null;
  /**
   * Brings a grounded aircraft's fuel to a target over time, exactly as the `serviceAircraft`
   * command does (ADR 0027). Returns true if anything changed.
   */
  service(
    aircraftId: string,
    fuelKg: number,
    tick: number,
    missionId: string | null,
    emit: EmitEvent,
    payloadKg?: number,
  ): boolean;
  /** Withdraws the work a mission asked for that has not begun (ADR 0028). */
  withdraw(missionId: string, tick: number, emit: EmitEvent): void;
  /** Why an aircraft could not launch a load from a place now; `null` when it could. */
  launchIssue(
    aircraftId: string,
    load: FlightLoad,
    origin: RoutePoint | null,
    tick: number,
  ): string | null;
  /** Removes the payload from an aircraft on the ground. */
  unload(aircraftId: string): void;
  rebase(aircraftId: string, home: RoutePoint): void;
}

const NO_EVENTS: EmitEvent = () => undefined;

export interface MissionsView {
  /** Newest first. */
  readonly missions: readonly Mission[];
  readonly operatingAreaSize: number;
  /** The point the operating area was chosen around. */
  readonly areaCentre: LatLon | null;
}

/** The world a mission is planned and flown in: its weather and its open events. */
export interface MissionWorld {
  readonly weather: WeatherModel | null;
  readonly hazards: Hazards;
}

const isTick = (value: number | null) =>
  value === null || (Number.isSafeInteger(value) && value >= 0);

function assertConfiguration(configuration: MissionConfiguration): void {
  const { title, priority, brief, plan, load, objectives } = configuration;
  if (title.trim().length === 0) throw new CommandRejected('A mission needs a title.');
  if (!MISSION_PRIORITIES.includes(priority)) {
    throw new CommandRejected('The mission priority is not valid.');
  }
  if (!Number.isFinite(brief.payloadKg) || brief.payloadKg < 0) {
    throw new CommandRejected('The mission payload cannot be negative.');
  }
  if (plan) {
    const problems = routeProblems(plan.points);
    if (problems[0]) throw new CommandRejected(problems[0]);
  }
  if (load && !(load.fuelKg >= 0 && load.payloadKg >= 0)) {
    throw new CommandRejected('Fuel and payload must be zero or more.');
  }
  if ((plan === null) !== (load === null)) {
    throw new CommandRejected('A mission route and its load are set together.');
  }
  for (const objective of objectives) {
    if (objective.label.trim().length === 0) {
      throw new CommandRejected('Every objective needs a label.');
    }
    const problem = objectiveProblem(objective.spec);
    if (problem) throw new CommandRejected(problem);
  }
  if (!isTick(configuration.plannedStartTick) || !isTick(configuration.completeByTick)) {
    throw new CommandRejected('The mission timing is not valid.');
  }
}

/** A configured mission is `planned` once it has an aircraft, a route, a load and objectives. */
function configuredStatus(configuration: MissionConfiguration): 'draft' | 'planned' {
  return configuration.aircraftId !== null &&
    configuration.plan !== null &&
    configuration.load !== null &&
    configuration.objectives.length > 0
    ? 'planned'
    : 'draft';
}

export class Missions {
  private readonly missions = new Map<string, Mission>();
  private places: readonly RoutePoint[];
  private nextNumber: number;
  private generated: number;
  private areaCentre: LatLon | null;

  constructor(snapshot: MissionsSnapshot = EMPTY_MISSIONS) {
    if (!Number.isSafeInteger(snapshot.nextNumber) || snapshot.nextNumber < 1) {
      throw new Error('Saved mission counter is invalid');
    }
    for (const mission of snapshot.missions) {
      if ((mission.status === 'active') !== (mission.flightId !== null && !mission.outcome)) {
        throw new Error(`Saved mission ${mission.id} does not match its flight`);
      }
      // A mission saved before acceptance figures were kept has none: not recorded.
      this.missions.set(mission.id, {
        ...mission,
        acceptance: (mission as Partial<Mission>).acceptance ?? null,
      });
    }
    this.places = snapshot.places;
    this.nextNumber = snapshot.nextNumber;
    this.generated = snapshot.generated;
    this.areaCentre = snapshot.areaCentre ?? null;
  }

  /** The operating area. */
  operatingArea(): readonly RoutePoint[] {
    return this.places;
  }

  /** Missions that are accepted or flying, which an event may bear on. */
  affectable(): AffectableMission[] {
    const out: AffectableMission[] = [];
    for (const mission of this.missions.values()) {
      if ((mission.status === 'accepted' || mission.status === 'active') && mission.plan) {
        out.push({
          missionId: mission.id,
          aircraftId: mission.aircraftId,
          flightId: mission.flightId,
          active: mission.status === 'active',
          plan: mission.plan,
        });
      }
    }
    return out;
  }

  /** Checks saved missions against the fleet they refer to. */
  assertConsistentWith(fleet: FleetPort): void {
    for (const mission of this.missions.values()) {
      if (mission.status !== 'active') continue;
      const flight = mission.flightId ? fleet.flightById(mission.flightId) : undefined;
      if (!flight || flight.missionId !== mission.id) {
        throw new Error(`Saved mission ${mission.id} refers to a flight that is not its own`);
      }
    }
  }

  private require(missionId: string): Mission {
    const mission = this.missions.get(missionId);
    if (!mission) throw new CommandRejected(`There is no mission ${missionId}.`);
    return mission;
  }

  private move(mission: Mission, to: MissionStatus, action: string): void {
    if (!canTransition(mission.status, to)) {
      throw new CommandRejected(`${mission.id} is ${mission.status}; it cannot be ${action}.`);
    }
  }

  private nextId(): string {
    const id = `MSN-${String(this.nextNumber).padStart(6, '0')}`;
    this.nextNumber += 1;
    return id;
  }

  /** The accepted or active mission an aircraft is committed to, if any. */
  reservation(aircraftId: string): Mission | undefined {
    for (const mission of this.missions.values()) {
      if (
        mission.aircraftId === aircraftId &&
        (mission.status === 'accepted' || mission.status === 'active')
      ) {
        return mission;
      }
    }
    return undefined;
  }

  private evaluate(mission: Mission, fleet: FleetPort, tick: number, world: MissionWorld) {
    const aircraft = mission.aircraftId ? fleet.aircraftById(mission.aircraftId) : undefined;
    return evaluateMission({
      type: mission.type,
      aircraft: aircraft ?? null,
      plan: mission.plan,
      load: mission.load,
      objectives: mission.objectives,
      departureTick: tick,
      completeByTick: mission.completeByTick,
      maintenance: MAINTENANCE_POLICY,
      stepS: STEP_S,
      weather: world.weather,
      hazards: world.hazards,
    });
  }

  /**
   * Applies a command. Returns what it touched, or `null` if it had no effect; throws
   * {@link CommandRejected} if it cannot be carried out, leaving everything exactly as it was.
   */
  apply(
    command: MissionCommand,
    tick: number,
    fleet: FleetPort,
    world: MissionWorld = { weather: null, hazards: { closures: [], disruptions: [] } },
    /** Where the command reports what it caused, beyond itself (ADR 0027). */
    emit: EmitEvent = NO_EVENTS,
  ): CommandEffect | null {
    const context: PlanContext | null = world.weather
      ? { weather: world.weather, departureTick: tick, hazards: world.hazards }
      : null;
    switch (command.type) {
      case 'setOperatingArea': {
        if (command.places.length === 0 || command.places.length > MAX_OPERATING_AREA) {
          throw new CommandRejected(
            `An operating area holds between 1 and ${MAX_OPERATING_AREA} aerodromes.`,
          );
        }
        for (const place of command.places) {
          if (
            place.kind !== 'aerodrome' ||
            place.name.length === 0 ||
            !isValidLatLon(place.lat, place.lon) ||
            !Number.isFinite(place.elevationM)
          ) {
            throw new CommandRejected('An operating area holds valid aerodromes only.');
          }
        }
        const centre = command.centre ?? null;
        if (
          JSON.stringify(command.places) === JSON.stringify(this.places) &&
          JSON.stringify(centre) === JSON.stringify(this.areaCentre)
        ) {
          return null;
        }
        this.places = [...command.places];
        this.areaCentre = centre;
        return {};
      }

      case 'createMission': {
        if (!MISSION_TYPES.includes(command.missionType)) {
          throw new CommandRejected('That is not a mission type.');
        }
        assertConfiguration(command);
        if (command.aircraftId !== null && !fleet.aircraftById(command.aircraftId)) {
          throw new CommandRejected(`There is no aircraft ${command.aircraftId}.`);
        }
        const id = this.nextId();
        this.missions.set(id, {
          id,
          type: command.missionType,
          source: 'manual',
          status: configuredStatus(command),
          priority: command.priority,
          title: command.title.trim(),
          description: command.description,
          brief: command.brief,
          aircraftId: command.aircraftId,
          flightId: null,
          plan: command.plan,
          load: command.load,
          objectives: newObjectives(command.objectives),
          acceptance: null,
          assessment: null,
          outcome: null,
          createdTick: tick,
          acceptedTick: null,
          plannedStartTick: command.plannedStartTick,
          actualStartTick: null,
          completedTick: null,
          expiresTick: null,
          completeByTick: command.completeByTick,
        });
        return { missionId: id, aircraftId: command.aircraftId };
      }

      case 'updateMission': {
        const mission = this.require(command.missionId);
        if (mission.status !== 'draft' && mission.status !== 'planned') {
          throw new CommandRejected(
            `${mission.id} is ${mission.status}; release it before changing it.`,
          );
        }
        assertConfiguration(command);
        if (command.aircraftId !== null && !fleet.aircraftById(command.aircraftId)) {
          throw new CommandRejected(`There is no aircraft ${command.aircraftId}.`);
        }
        this.missions.set(mission.id, {
          ...mission,
          status: configuredStatus(command),
          priority: command.priority,
          title: command.title.trim(),
          description: command.description,
          brief: command.brief,
          aircraftId: command.aircraftId,
          plan: command.plan,
          load: command.load,
          objectives: newObjectives(command.objectives),
          plannedStartTick: command.plannedStartTick,
          completeByTick: command.completeByTick,
        });
        return { missionId: mission.id, aircraftId: command.aircraftId };
      }

      case 'acceptOffer': {
        const mission = this.require(command.missionId);
        this.move(mission, 'draft', 'taken up');
        this.missions.set(mission.id, { ...mission, status: 'draft' });
        return { missionId: mission.id };
      }

      case 'rejectOffer': {
        const mission = this.require(command.missionId);
        this.move(mission, 'rejected', 'rejected');
        this.finish({ ...mission, status: 'rejected', completedTick: tick });
        return { missionId: mission.id };
      }

      case 'acceptMission': {
        const mission = this.require(command.missionId);
        this.move(mission, 'accepted', 'accepted');
        const aircraft = mission.aircraftId ? fleet.aircraftById(mission.aircraftId) : undefined;
        if (!aircraft) throw new CommandRejected(`${mission.id} has no aircraft assigned.`);
        const other = this.reservation(aircraft.id);
        if (other) {
          throw new CommandRejected(`${aircraft.id} is already committed to ${other.id}.`);
        }
        const evaluation = this.evaluate(mission, fleet, tick, world);
        const assessment = missionAssessment(evaluation, tick);
        if (!assessment) {
          const blocked = evaluation.constraints.find((c) => c.severity === 'block');
          throw new CommandRejected(blocked?.message ?? `${mission.id} cannot be accepted.`);
        }
        const origin = mission.plan?.points[0];
        if (
          aircraft.location === null ||
          !origin ||
          greatCircleDistance(aircraft.location, origin) >= 1000
        ) {
          throw new CommandRejected(
            `${aircraft.id} is ${aircraft.location ? `at ${aircraft.location.name}` : 'airborne'}; the mission starts at ${origin?.name ?? 'its origin'}.`,
          );
        }
        this.missions.set(mission.id, {
          ...mission,
          status: 'accepted',
          acceptedTick: tick,
          // What the operator accepted. Kept as it is; launch records its own figures beside it.
          acceptance: assessment,
          assessment,
        });
        // Committing the aircraft begins loading the mission's fuel (ADR 0027). An aircraft that
        // cannot be fuelled yet, because maintenance comes first, is prepared by the operator
        // when it can be.
        if (mission.load && (aircraft.status === 'available' || aircraft.status === 'servicing')) {
          fleet.service(
            aircraft.id,
            mission.load.fuelKg,
            tick,
            mission.id,
            emit,
            mission.load.payloadKg,
          );
        }
        return { missionId: mission.id, aircraftId: aircraft.id };
      }

      case 'releaseMission': {
        const mission = this.require(command.missionId);
        if (mission.status !== 'accepted') {
          throw new CommandRejected(`${mission.id} is ${mission.status}; it cannot be released.`);
        }
        this.missions.set(mission.id, {
          ...mission,
          status: 'planned',
          acceptedTick: null,
          acceptance: null,
          assessment: null,
        });
        // What was asked of the aerodrome for it and has not begun is given up (ADR 0028).
        fleet.withdraw(mission.id, tick, emit);
        return { missionId: mission.id, aircraftId: mission.aircraftId };
      }

      case 'cancelMission': {
        const mission = this.require(command.missionId);
        this.move(mission, 'cancelled', 'cancelled');
        this.finish({ ...mission, status: 'cancelled', completedTick: tick });
        fleet.withdraw(mission.id, tick, emit);
        return { missionId: mission.id, aircraftId: mission.aircraftId };
      }

      case 'launchMission': {
        const mission = this.require(command.missionId);
        this.move(mission, 'active', 'launched');
        const { aircraftId, plan, load } = mission;
        if (!aircraftId || !plan || !load) {
          throw new CommandRejected(`${mission.id} is not fully planned.`);
        }
        // The fleet validates the flight as it would any other, and throws if it cannot be flown.
        const flightId = fleet.launch(aircraftId, plan, load, tick, mission.id, context);
        // The estimate depends on when the flight leaves (ADR 0021), so the figures are evaluated
        // again for the actual departure: they are what the flight will do. What was accepted
        // stays in `acceptance`, untouched.
        const assessment =
          missionAssessment(this.evaluate(mission, fleet, tick, world), tick) ?? mission.assessment;
        this.missions.set(mission.id, {
          ...mission,
          assessment,
          status: 'active',
          flightId,
          actualStartTick: tick,
          objectives: resetObjectives(mission.objectives),
        });
        return { missionId: mission.id, aircraftId, flightId };
      }

      case 'abortMission': {
        const mission = this.require(command.missionId);
        if (mission.status !== 'active') {
          throw new CommandRejected(
            isFinished(mission.status)
              ? `${mission.id} is ${mission.status}; there is nothing to abort.`
              : `${mission.id} has not launched. Cancel it instead; abort is for a mission in flight.`,
          );
        }
        const flight = mission.flightId ? fleet.flightById(mission.flightId) : undefined;
        const { aircraftId } = mission;
        if (!flight || !aircraftId) {
          throw new Error(`Active mission ${mission.id} has lost its flight`);
        }
        const { landing } = command;
        // The route is changed first: if it cannot be flown the command is refused whole, and
        // the mission is still as it was.
        if (landing.intent !== 'continue') {
          fleet.revise(aircraftId, landing.intent, landing.points, tick, world.hazards);
        }
        const objectives = mission.objectives.map((objective) =>
          objective.status === 'pending'
            ? { ...objective, status: 'failed' as const, remark: ABORTED_REMARK }
            : objective,
        );
        const required = objectives.filter((objective) => objective.required);
        const complete = required.filter((objective) => objective.status === 'complete').length;
        const destination = fleet.flightById(flight.id)?.plan.points.at(-1);
        const outcome: MissionOutcome = {
          result: 'aborted',
          decidedTick: tick,
          summary: `Aborted in flight with ${complete} of ${required.length} required objectives met. The aircraft goes on to land at ${destination?.name ?? 'its destination'}.`,
          objectivesComplete: complete,
          objectivesRequired: required.length,
          // As they stood at the abort. The flight is not over; its totals are the flight's own.
          flightDurationS: flight.progress.elapsedS,
          fuelUsedKg: flight.fuelAtDepartureKg - flight.progress.fuelKg,
        };
        this.finish({ ...mission, status: 'aborted', objectives, outcome, completedTick: tick });
        return { missionId: mission.id, aircraftId, flightId: flight.id };
      }
    }
  }

  /** Judges active missions, expires what has run out of time, and may generate an opportunity. */
  step(tick: number, fleet: FleetPort, rng: (stream: string) => Rng, emit: EmitEvent): void {
    // Missions are held in the order they were created, which is identifier order, so iterating
    // the map is deterministic. A map may be changed while it is iterated: replacing a mission
    // keeps its place, and a removed one is simply not visited.
    for (const mission of this.missions.values()) {
      // A scheduled launch is an intention, not an order (ADR 0028). When its time passes with
      // the mission still on the ground, the world records that once, with the reason.
      if (
        mission.plannedStartTick === tick &&
        (mission.status === 'accepted' || mission.status === 'planned')
      ) {
        const issue =
          mission.status === 'planned'
            ? 'The mission had not been accepted.'
            : mission.aircraftId && mission.load
              ? fleet.launchIssue(
                  mission.aircraftId,
                  mission.load,
                  mission.plan?.points[0] ?? null,
                  tick,
                )
              : null;
        emit(
          'launchDelayed',
          { missionId: mission.id, aircraftId: mission.aircraftId },
          { scheduledTick: tick, reason: issue ?? 'Ready, and not yet launched.' },
        );
      }
      if (mission.status === 'active') {
        this.stepActive(mission, tick, fleet, emit);
      } else if (mission.status === 'offered') {
        if (mission.expiresTick !== null && tick >= mission.expiresTick) {
          this.finish({ ...mission, status: 'expired', completedTick: tick });
          emit('opportunityExpired', { missionId: mission.id }, { title: mission.title });
        }
      } else if (
        !isFinished(mission.status) &&
        mission.completeByTick !== null &&
        tick > mission.completeByTick
      ) {
        const outcome: MissionOutcome = {
          result: 'failed',
          decidedTick: tick,
          summary: 'Not launched before its deadline.',
          objectivesComplete: 0,
          objectivesRequired: mission.objectives.filter((o) => o.required).length,
          flightDurationS: null,
          fuelUsedKg: null,
        };
        this.finish({ ...mission, status: 'failed', completedTick: tick, outcome });
        emit(
          'missionFailed',
          { missionId: mission.id, aircraftId: mission.aircraftId },
          { summary: outcome.summary },
        );
      }
    }

    if (tick % GENERATION.intervalTicks === 0 && this.places.length > 0) {
      this.generate(tick, fleet, rng(GENERATION_STREAM), emit);
    }
  }

  private stepActive(mission: Mission, tick: number, fleet: FleetPort, emit: EmitEvent): void {
    const flight = mission.flightId ? fleet.flightById(mission.flightId) : undefined;
    const aircraft = mission.aircraftId ? fleet.aircraftById(mission.aircraftId) : undefined;
    const plan = mission.plan;
    if (!flight || !aircraft || !plan) {
      throw new Error(`Active mission ${mission.id} has lost its flight`);
    }
    const subject = { missionId: mission.id, aircraftId: aircraft.id, flightId: flight.id };
    const ended = flight.status !== 'active';
    const landed = flight.status === 'completed';
    const track = fleet.flightTrack(flight);
    const ctx: ObjectiveContext = {
      tick,
      stepS: STEP_S,
      position: track.position,
      distanceM: flight.progress.distanceM,
      totalM: track.totalM,
      ended,
      landed,
      fuelKg: flight.progress.fuelKg,
      reserveFuelKg: aircraft.performance?.reserveFuelKg ?? 0,
      payloadKg: flight.payloadKg,
      origin: plan.points[0] as RoutePoint,
      // The mission's plan is what was intended; the flight's is what was flown. An objective
      // about the destination is judged against the first, by where the second ended.
      destination: plan.points.at(-1) as RoutePoint,
      landedAt: landed ? (flight.plan.points.at(-1) as RoutePoint) : null,
      // The fleet steps first, so a flight that ended this step has already worn the aircraft.
      conditionPct: aircraft.conditionPct,
    };

    const objectives = mission.objectives.map((objective): Objective => {
      const next = evaluateObjective(objective, ctx);
      if (next === objective) return objective;
      if (next.status !== objective.status) {
        emit(next.status === 'complete' ? 'objectiveCompleted' : 'objectiveFailed', subject, {
          objectiveId: next.id,
          label: next.label,
          ...(next.remark ? { remark: next.remark } : {}),
        });
      }
      return next;
    });

    if (!ended) {
      const changed = objectives.some(
        (objective, index) => objective !== mission.objectives[index],
      );
      if (changed) this.missions.set(mission.id, { ...mission, objectives });
      return;
    }

    const required = objectives.filter((objective) => objective.required);
    const complete = required.filter((objective) => objective.status === 'complete').length;
    const succeeded = objectivesMet(objectives);
    const firstFailure = required.find((objective) => objective.status === 'failed');
    const outcome: MissionOutcome = {
      result: succeeded ? 'completed' : 'failed',
      decidedTick: tick,
      summary: succeeded
        ? `All ${required.length} required objective${required.length === 1 ? '' : 's'} met.`
        : `${complete} of ${required.length} required objectives met. ${firstFailure?.remark ?? ''}`.trim(),
      objectivesComplete: complete,
      objectivesRequired: required.length,
      flightDurationS: flight.progress.elapsedS,
      fuelUsedKg: flight.fuelAtDepartureKg - flight.progress.fuelKg,
    };

    // Consequences. A payload that reached its destination is unloaded there.
    const delivered = objectives.some(
      (objective) => objective.spec.kind === 'deliver_payload' && objective.status === 'complete',
    );
    if (delivered) fleet.unload(aircraft.id);
    if (succeeded && MISSION_TEMPLATES[mission.type].rebases) {
      fleet.rebase(aircraft.id, ctx.destination);
    }

    this.finish({
      ...mission,
      status: outcome.result,
      objectives,
      outcome,
      completedTick: tick,
    });
    emit(succeeded ? 'missionCompleted' : 'missionFailed', subject, { summary: outcome.summary });
  }

  private generate(tick: number, fleet: FleetPort, rng: Rng, emit: EmitEvent): void {
    const openOffers = [...this.missions.values()].filter((m) => m.status === 'offered').length;
    const opportunity = generateOpportunity({
      rng,
      tick,
      places: this.places,
      aircraft: fleet.groundedAircraft(),
      openOffers,
      ordinal: this.generated + 1,
    });
    if (!opportunity) return;
    this.generated += 1;
    const id = this.nextId();
    this.missions.set(id, {
      id,
      type: opportunity.type,
      source: 'generated',
      status: 'offered',
      priority: opportunity.priority,
      title: opportunity.title,
      description: opportunity.description,
      brief: opportunity.brief,
      aircraftId: null,
      flightId: null,
      plan: null,
      load: null,
      objectives: newObjectives(
        defaultObjectives(
          MISSION_TEMPLATES[opportunity.type],
          opportunity.brief,
          opportunity.completeByTick,
          MAINTENANCE.dueBelowConditionPct,
        ),
      ),
      acceptance: null,
      assessment: null,
      outcome: null,
      createdTick: tick,
      acceptedTick: null,
      plannedStartTick: null,
      actualStartTick: null,
      completedTick: null,
      expiresTick: opportunity.expiresTick,
      completeByTick: opportunity.completeByTick,
    });
    emit(
      'opportunityGenerated',
      { missionId: id },
      {
        missionType: opportunity.type,
        title: opportunity.title,
        expiresTick: opportunity.expiresTick,
      },
    );
  }

  /**
   * Offers an urgent delivery to the place of a logistics disruption (ADR 0022), if an aircraft
   * in the fleet could fly it from where it is. Nothing is rolled: the first suitable aircraft, in
   * identifier order, sizes the request. Returns the opportunity's id, or `null`.
   */
  offerUrgentDelivery(
    event: WorldEvent,
    tick: number,
    fleet: FleetPort,
    emit: EmitEvent,
  ): string | null {
    const place = event.place;
    if (!place) return null;
    const template = MISSION_TEMPLATES.emergency_response;
    const anchor = fleet.groundedAircraft().find((aircraft) => {
      if (!aircraft.performance || !aircraft.location) return false;
      if (!template.suitableCategories.includes(aircraft.category)) return false;
      const distanceM = greatCircleDistance(aircraft.location, place);
      return (
        distanceM >= GENERATION.minDistanceM &&
        distanceM <= aircraft.performance.referenceRangeKm * 1000 * GENERATION.oneWayRangeShare
      );
    });
    if (!anchor?.performance || !anchor.location) return null;

    const payloadKg = Math.max(
      Math.round((anchor.performance.maxPayloadKg * 0.15) / 100) * 100,
      100,
    );
    const flyingS =
      (greatCircleDistance(anchor.location, place) / 1000 / anchor.performance.cruiseSpeedKmh) *
      3600;
    const completeByTick =
      Math.max(event.endTick, tick) + Math.round((flyingS * 1.5 + 3600) / 60) * 60;
    const brief: MissionBrief = {
      shape: 'point_to_point',
      destination: place,
      target: null,
      orbitRadiusM: 0,
      holdS: 0,
      payloadKg,
    };
    this.generated += 1;
    const id = this.nextId();
    const title = `${template.label}: ${place.code ? `${place.name} (${place.code})` : place.name}`;
    this.missions.set(id, {
      id,
      type: 'emergency_response',
      source: 'generated',
      status: 'offered',
      priority: template.priority,
      title,
      description: `Simulated requirement, raised by ${event.id}. ${template.description}`,
      brief,
      aircraftId: null,
      flightId: null,
      plan: null,
      load: null,
      objectives: newObjectives(
        defaultObjectives(template, brief, completeByTick, MAINTENANCE.dueBelowConditionPct),
      ),
      acceptance: null,
      assessment: null,
      outcome: null,
      createdTick: tick,
      acceptedTick: null,
      plannedStartTick: null,
      actualStartTick: null,
      completedTick: null,
      expiresTick: Math.max(event.endTick, tick + 3600),
      completeByTick,
    });
    emit(
      'opportunityGenerated',
      { missionId: id },
      { missionType: 'emergency_response', title, eventId: event.id },
    );
    return id;
  }

  /** Stores a finished mission and forgets the oldest finished ones beyond the in-memory limit. */
  private finish(mission: Mission): void {
    this.missions.set(mission.id, mission);
    const finished = [...this.missions.values()].filter((m) => isFinished(m.status));
    if (finished.length > RECENT_MISSIONS) {
      finished
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, finished.length - RECENT_MISSIONS)
        .forEach((old) => this.missions.delete(old.id));
    }
  }

  snapshot(): MissionsSnapshot {
    return {
      missions: [...this.missions.values()].sort((a, b) => a.id.localeCompare(b.id)),
      places: this.places,
      nextNumber: this.nextNumber,
      generated: this.generated,
      areaCentre: this.areaCentre,
    };
  }

  view(): MissionsView {
    return {
      missions: [...this.snapshot().missions].reverse(),
      operatingAreaSize: this.places.length,
      areaCentre: this.areaCentre,
    };
  }
}

import {
  DIGEST_SEED,
  RngStreams,
  addMs,
  foldUint32,
  isSpeedMultiplier,
  weatherModel,
  type PlanContext,
  type SimInstant,
  type SpeedMultiplier,
  type WeatherModel,
} from '@aegis/domain';
import { EMPTY_EVENTS, Events, type EventsView, type EventsWorld } from './events';
import { CommandRejected, EMPTY_FLEET, Fleet, type FleetCommand, type FleetView } from './fleet';
import {
  EMPTY_MISSIONS,
  MISSION_COMMAND_TYPES,
  Missions,
  type MissionCommand,
  type MissionsView,
} from './missions';
import {
  EMPTY_LOG,
  SimLog,
  type EmitEvent,
  type LogPayload,
  type LogSnapshot,
  type LogSubject,
} from './log';
import {
  OLDEST_LOADABLE_MODEL_VERSION,
  SIM_MODEL_VERSION,
  SIM_STEP_MS,
  type ClockState,
  type NewWorldOptions,
  type WorldSnapshot,
} from './world';

/** Commands the application issues itself, not the player (ADR 0018). */
const SYSTEM_COMMANDS: ReadonlySet<string> = new Set([
  'seedStarterFleet',
  'updatePerformance',
  'setOperatingArea',
  'classifyAerodromes',
]);

/** The first simulation model that kept a log. */
const FIRST_LOGGED_MODEL_VERSION = 3;

/** Every command that changes the world. Each effective one is logged (ADR 0018). */
export type WorldCommand = FleetCommand | MissionCommand;

function isMissionCommand(command: WorldCommand): command is MissionCommand {
  return MISSION_COMMAND_TYPES.has(command.type);
}

/** RNG stream consumed by the integrity probe. Persisted name: do not rename (ADR 0006). */
const INTEGRITY_STREAM = 'core.integrity';

export class WorldRestoreError extends Error {
  override readonly name = 'WorldRestoreError';
}

/**
 * The simulation itself: world state plus the rules that advance it one fixed step at a time.
 *
 * It never reads a clock, a timer or a global random source. Time moves only through
 * {@link runSteps}, so the same seed and the same calls always produce the same world.
 */
export class SimulationEngine {
  private tick: number;
  private speed: SpeedMultiplier;
  private running: boolean;
  private integrityDigest: number;
  /** The world's weather: a function of its seed and epoch, with no state of its own. */
  readonly weather: WeatherModel;

  private constructor(
    private readonly seed: string,
    private readonly epoch: SimInstant,
    private readonly rng: RngStreams,
    clock: Pick<ClockState, 'tick' | 'speed' | 'running'>,
    integrityDigest: number,
    private readonly fleet: Fleet,
    private readonly missions: Missions,
    private readonly events: Events,
    private readonly log: SimLog,
  ) {
    this.weather = weatherModel(seed, epoch);
    this.eventsWorld = {
      weather: this.weather,
      places: () => this.missions.operatingArea(),
      groundedAircraft: () => this.fleet.groundedAircraft(),
      airborneWithoutCaution: () => this.fleet.airborneWithoutCaution(),
      flagCaution: (aircraftId, eventId, tick) => this.fleet.flagCaution(aircraftId, eventId, tick),
      aircraftById: (id) => this.fleet.aircraftById(id),
      flagMaintenanceDue: (aircraftId) =>
        // An aircraft committed to a mission is left alone: the finding would strand the mission.
        this.missions.reservation(aircraftId) === undefined &&
        this.fleet.flagMaintenanceDue(aircraftId),
      offerUrgentDelivery: (event, tick) =>
        this.missions.offerUrgentDelivery(event, tick, this.fleet, this.emit),
      // A mission in flight is affected along the route its flight is now on, which a
      // diversion may have changed; one still on the ground, along the route it plans.
      affectableMissions: () =>
        this.missions.affectable().map((mission) => {
          const flight = mission.flightId ? this.fleet.flightById(mission.flightId) : undefined;
          return flight?.status === 'active' ? { ...mission, plan: flight.plan } : mission;
        }),
    };
    this.tick = clock.tick;
    this.speed = clock.speed;
    this.running = clock.running;
    this.integrityDigest = integrityDigest;
  }

  static create(options: NewWorldOptions): SimulationEngine {
    if (options.seed.length === 0) {
      throw new RangeError('World seed must not be empty');
    }
    return new SimulationEngine(
      options.seed,
      options.epoch,
      new RngStreams(options.seed),
      { tick: 0, speed: 1, running: true },
      DIGEST_SEED,
      new Fleet(EMPTY_FLEET, weatherModel(options.seed, options.epoch)),
      new Missions(),
      new Events(),
      new SimLog(),
    );
  }

  /** Rebuilds an engine from a snapshot, refusing anything internally inconsistent. */
  static restore(snapshot: WorldSnapshot): SimulationEngine {
    const { clock } = snapshot;
    if (
      snapshot.modelVersion > SIM_MODEL_VERSION ||
      snapshot.modelVersion < OLDEST_LOADABLE_MODEL_VERSION
    ) {
      throw new WorldRestoreError(
        `World was saved by simulation model ${snapshot.modelVersion}; this build runs model ${SIM_MODEL_VERSION}`,
      );
    }
    if (snapshot.seed.length === 0) {
      throw new WorldRestoreError('Saved world has an empty seed');
    }
    if (!Number.isSafeInteger(clock.tick) || clock.tick < 0) {
      throw new WorldRestoreError(`Saved tick is invalid: ${clock.tick}`);
    }
    if (!isSpeedMultiplier(clock.speed)) {
      throw new WorldRestoreError(
        `Saved speed is not a supported multiplier: ${String(clock.speed)}`,
      );
    }
    if (clock.simTime !== snapshot.epoch + clock.tick * SIM_STEP_MS) {
      throw new WorldRestoreError('Saved simulation time does not match epoch and tick');
    }
    if (!Number.isInteger(snapshot.integrityDigest) || snapshot.integrityDigest < 0) {
      throw new WorldRestoreError('Saved integrity digest is invalid');
    }
    let rng: RngStreams;
    try {
      rng = new RngStreams(snapshot.seed, snapshot.rngStreams);
    } catch (cause) {
      throw new WorldRestoreError('Saved RNG state is invalid', { cause });
    }
    let fleet: Fleet;
    try {
      // A model-1 world has no fleet; it is upgraded to an empty one.
      fleet = new Fleet(
        (snapshot as Partial<WorldSnapshot>).fleet ?? EMPTY_FLEET,
        weatherModel(snapshot.seed, snapshot.epoch),
      );
    } catch (cause) {
      throw new WorldRestoreError('Saved fleet state is invalid', { cause });
    }
    let missions: Missions;
    try {
      // A world saved before missions existed has none.
      missions = new Missions((snapshot as Partial<WorldSnapshot>).missions ?? EMPTY_MISSIONS);
      missions.assertConsistentWith(fleet);
    } catch (cause) {
      throw new WorldRestoreError('Saved mission state is invalid', { cause });
    }
    let events: Events;
    try {
      // A world saved before events existed has none.
      events = new Events((snapshot as Partial<WorldSnapshot>).events ?? EMPTY_EVENTS);
    } catch (cause) {
      throw new WorldRestoreError('Saved event state is invalid', { cause });
    }
    let log: SimLog;
    try {
      log = new SimLog(restoredLog(snapshot));
    } catch (cause) {
      throw new WorldRestoreError('Saved log is invalid', { cause });
    }
    return new SimulationEngine(
      snapshot.seed,
      snapshot.epoch,
      rng,
      clock,
      snapshot.integrityDigest,
      fleet,
      missions,
      events,
      log,
    );
  }

  get clock(): ClockState {
    return {
      simTime: addMs(this.epoch, this.tick * SIM_STEP_MS),
      tick: this.tick,
      speed: this.speed,
      running: this.running,
    };
  }

  /** Advances the world by exactly `count` steps, regardless of run state or speed. */
  runSteps(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError(`Step count must be a non-negative integer, got ${count}`);
    }
    for (let i = 0; i < count; i++) {
      this.step();
    }
  }

  setSpeed(speed: SpeedMultiplier): void {
    if (!isSpeedMultiplier(speed)) {
      throw new RangeError(`Unsupported speed multiplier: ${String(speed)}`);
    }
    this.speed = speed;
  }

  setRunning(running: boolean): void {
    this.running = running;
  }

  snapshot(): WorldSnapshot {
    return {
      modelVersion: SIM_MODEL_VERSION,
      seed: this.seed,
      epoch: this.epoch,
      clock: this.clock,
      rngStreams: this.rng.states(),
      integrityDigest: this.integrityDigest,
      fleet: this.fleet.snapshot(),
      missions: this.missions.snapshot(),
      events: this.events.snapshot(),
      log: this.log.snapshot(),
    };
  }

  /** Tells the engine that every log entry up to `seq` is on disk. */
  acknowledgeLogSaved(seq: number): void {
    this.log.acknowledgeSaved(seq);
  }

  /**
   * Applies a command at the current step boundary and records it in the log. Returns false if it
   * changed nothing; throws `CommandRejected` if it cannot be carried out, leaving the world
   * untouched and the log without an entry.
   */
  applyCommand(command: WorldCommand): boolean {
    let effect;
    const context = this.planContext();
    const hazards = this.events.hazards();
    // What the command caused beyond itself (ADR 0027). Recorded after the command's own entry,
    // and never if the command is refused.
    const caused: { type: string; subject: LogSubject; payload?: LogPayload }[] = [];
    const report: EmitEvent = (type, subject, payload) => {
      caused.push({ type, subject, ...(payload && { payload }) });
    };
    if (isMissionCommand(command)) {
      effect = this.missions.apply(
        command,
        this.tick,
        this.fleet,
        { weather: this.weather, hazards },
        report,
      );
    } else {
      if (command.type === 'launchFlight') {
        // An aircraft committed to a mission flies that mission, or is released from it first.
        const mission = this.missions.reservation(command.aircraftId);
        if (mission) {
          throw new CommandRejected(
            `${command.aircraftId} is committed to ${mission.id}. Launch the mission, or release the aircraft from it.`,
          );
        }
      }
      effect = this.fleet.apply(command, this.tick, context, report);
    }
    if (effect === null) return false;
    this.log.append(
      this.tick,
      'command',
      command.type,
      SYSTEM_COMMANDS.has(command.type) ? 'system' : 'player',
      effect,
      { ...command },
    );
    for (const event of caused) this.emit(event.type, event.subject, event.payload);
    return true;
  }

  fleetView(): FleetView {
    return this.fleet.view();
  }

  /**
   * The world a plan would be flown in if it departed now: the weather, the tick and the open
   * events. The planner evaluates against exactly what a launch would be checked against.
   */
  planContext(): PlanContext {
    return {
      weather: this.weather,
      departureTick: this.tick,
      hazards: this.events.hazards(),
    };
  }

  missionsView(): MissionsView {
    return this.missions.view();
  }

  eventsView(): EventsView {
    return this.events.view();
  }

  /**
   * One fixed step. Subsystems are called here in a fixed, documented order as they are added
   * (flight, environment, events, ...).
   */
  private step(): void {
    this.tick += 1;
    // Fixed order: aircraft move, then missions read where they are, then events.
    this.fleet.step(this.tick, this.stream, this.emit, this.events.hazards());
    this.missions.step(this.tick, this.fleet, this.stream, this.emit);
    this.events.step(this.tick, this.eventsWorld, this.stream, this.emit);
    this.updateIntegrityDigest();
  }

  /** Records something the world did, at the step it happened. */
  private readonly emit: EmitEvent = (type, subject, payload) => {
    this.log.append(this.tick, 'event', type, 'world', subject, payload);
  };

  private readonly stream = (name: string) => this.rng.stream(name);

  /** What the events subsystem may see and do in the rest of the world. */
  private readonly eventsWorld: EventsWorld;

  /**
   * Folds the tick number and one random draw into a rolling digest.
   *
   * Two worlds with the same digest have executed the same number of steps with the same random
   * sequence. A skipped or repeated step, or an RNG state that was not restored exactly, changes it.
   * This is what lets tests and the diagnostics screen prove continuity across a restart.
   */
  private updateIntegrityDigest(): void {
    const draw = this.rng.stream(INTEGRITY_STREAM).nextUint32();
    this.integrityDigest = foldUint32(foldUint32(this.integrityDigest, this.tick >>> 0), draw);
  }
}

/**
 * The log of a saved world. A world saved before the log existed (model 2 or earlier) gets an
 * empty one that is complete only from the moment of the upgrade.
 */
function restoredLog(snapshot: WorldSnapshot): LogSnapshot {
  const saved = (snapshot as Partial<WorldSnapshot>).log;
  if (!saved || snapshot.modelVersion < FIRST_LOGGED_MODEL_VERSION) {
    return { ...EMPTY_LOG, completeFromTick: snapshot.clock.tick };
  }
  // The rules changed since this world was saved, so what it logged under the old rules cannot be
  // replayed under the new ones. The log itself is kept; replay starts from here.
  if (snapshot.modelVersion < SIM_MODEL_VERSION) {
    return { ...saved, completeFromTick: Math.max(saved.completeFromTick, snapshot.clock.tick) };
  }
  return saved;
}

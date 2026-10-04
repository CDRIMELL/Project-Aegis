import {
  decodeRngState,
  encodeRngState,
  isSpeedMultiplier,
  simInstant,
  type FlightPlan,
  type PerformanceModel,
  type RngState,
  type RoutePoint,
} from '@aegis/domain';
import {
  RECENT_FLIGHTS,
  type AircraftState,
  type Checkpoint,
  type FlightState,
  type WorldStore,
} from '@aegis/sim';
import { desc, eq, ne, notInArray } from 'drizzle-orm';
import { z } from 'zod';
import type { AegisDb } from './client';
import {
  AIRCRAFT_STATUSES,
  FLIGHT_STATUSES,
  simAircraft,
  simCheckpoint,
  simClock,
  simCounter,
  simFlight,
  simRngStream,
  simWorld,
} from './schema';

const SINGLETON_ID = 1;

/** Raised when the database holds a world that cannot be trusted as a checkpoint. */
export class WorldStorageError extends Error {
  override readonly name = 'WorldStorageError';
}

const count = z.int().nonnegative();
const quantity = z.number().nonnegative();

// Everything read back from disk is validated before the simulation sees it (ADR 0010).
const worldRow = z.object({
  seed: z.string().min(1),
  modelVersion: count,
  epochMs: count,
  starterFleetSeeded: z.boolean(),
});
const clockRow = z.object({
  simTimeMs: count,
  tick: count,
  speed: z.number().refine(isSpeedMultiplier, 'unsupported speed multiplier'),
  running: z.boolean(),
});
const checkpointRow = z.object({
  seq: z.int().positive(),
  wallMs: count,
  integrityDigest: count,
});
const rngRow = z.object({
  name: z.string().min(1),
  state: z.string(),
});

const routePoint = z.object({
  kind: z.enum(['aerodrome', 'waypoint']),
  name: z.string().min(1),
  code: z.string().optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  elevationM: z.number(),
  refId: z.string().optional(),
});
const planJson = z.object({
  points: z.array(routePoint).min(2),
  cruiseAltitudeM: z.number(),
  cruiseSpeedKmh: z.number().positive(),
});
const progressJson = z.object({
  phase: z.enum(['takeoff', 'climb', 'cruise', 'descent', 'landed']),
  distanceM: quantity,
  altitudeM: z.number(),
  speedKmh: quantity,
  fuelKg: quantity,
  elapsedS: quantity,
  burnRateKgH: quantity,
  topAltitudeM: z.number(),
  fuelExhausted: z.boolean(),
});
const performanceJson = z.object({
  modelVersion: z.int().positive(),
  emptyMassKg: z.number().positive(),
  maxTakeoffMassKg: z.number().positive(),
  serviceCeilingM: z.number().positive().nullable(),
  maxSpeedKmh: z.number().positive().nullable(),
  referenceRangeKm: z.number().positive(),
  referenceRangeKind: z.enum(['range', 'ferry_range']),
  cruiseSpeedKmh: z.number().positive(),
  fuelCapacityKg: quantity,
  maxPayloadKg: quantity,
  reserveFuelKg: quantity,
  cruiseAltitudeM: z.number().positive(),
  climbRateMs: z.number().positive(),
  accelerationMs2: z.number().positive(),
  rangeFactorKm: z.number().positive(),
  hovers: z.boolean(),
  assumptions: z.array(z.string()),
});

const aircraftRow = z.object({
  id: z.string().min(1),
  typeId: z.string().min(1),
  typeName: z.string().min(1),
  category: z.string().min(1),
  status: z.enum(AIRCRAFT_STATUSES),
  home: z.string(),
  location: z.string().nullable(),
  fuelKg: quantity,
  payloadKg: quantity,
  conditionPct: z.number().min(0).max(100),
  flightSecondsTotal: quantity,
  flights: count,
  flightSecondsSinceMaintenance: quantity,
  maintenanceCompleteTick: count.nullable(),
  activeFlightId: z.string().nullable(),
  acquiredTick: count,
  performance: z.string().nullable(),
  performanceMissing: z.string(),
});
const flightRow = z.object({
  id: z.string().min(1),
  aircraftId: z.string().min(1),
  status: z.enum(FLIGHT_STATUSES),
  departedTick: count,
  arrivedTick: count.nullable(),
  payloadKg: quantity,
  fuelAtDepartureKg: quantity,
  estimatedDurationS: quantity,
  estimatedFuelUsedKg: z.number(),
  plan: z.string(),
  progress: z.string(),
});
const counterRow = z.object({ name: z.string().min(1), value: z.int().positive() });

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new WorldStorageError(`Invalid ${what}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/** Parses a JSON column and checks its shape. */
function json<T>(schema: z.ZodType<T>, text: string, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WorldStorageError(`Invalid ${what}: not valid JSON`);
  }
  return parse(schema, value, what);
}

function toAircraft(row: unknown): AircraftState {
  const a = parse(aircraftRow, row, 'sim_aircraft row');
  const what = `sim_aircraft ${a.id}`;
  return {
    id: a.id,
    typeId: a.typeId,
    typeName: a.typeName,
    category: a.category,
    status: a.status,
    // JSON never yields an explicit `undefined`, so validated objects satisfy the exact types.
    home: json(routePoint, a.home, `${what} home`) as RoutePoint,
    location:
      a.location === null ? null : (json(routePoint, a.location, `${what} location`) as RoutePoint),
    fuelKg: a.fuelKg,
    payloadKg: a.payloadKg,
    conditionPct: a.conditionPct,
    flightSecondsTotal: a.flightSecondsTotal,
    flights: a.flights,
    flightSecondsSinceMaintenance: a.flightSecondsSinceMaintenance,
    maintenanceCompleteTick: a.maintenanceCompleteTick,
    activeFlightId: a.activeFlightId,
    acquiredTick: a.acquiredTick,
    performance:
      a.performance === null
        ? null
        : (json(performanceJson, a.performance, `${what} performance`) as PerformanceModel),
    performanceMissing: json(
      z.array(z.string()),
      a.performanceMissing,
      `${what} performance_missing`,
    ),
  };
}

function toFlight(row: unknown): FlightState {
  const f = parse(flightRow, row, 'sim_flight row');
  return {
    id: f.id,
    aircraftId: f.aircraftId,
    status: f.status,
    departedTick: f.departedTick,
    arrivedTick: f.arrivedTick,
    payloadKg: f.payloadKg,
    fuelAtDepartureKg: f.fuelAtDepartureKg,
    estimatedDurationS: f.estimatedDurationS,
    estimatedFuelUsedKg: f.estimatedFuelUsedKg,
    plan: json(planJson, f.plan, `sim_flight ${f.id} plan`) as FlightPlan,
    progress: json(progressJson, f.progress, `sim_flight ${f.id} progress`),
  };
}

/** {@link WorldStore} over SQLite. Reads and writes a whole checkpoint in one transaction. */
export class SqliteWorldStore implements WorldStore {
  constructor(private readonly db: AegisDb) {}

  async load(): Promise<Checkpoint | null> {
    const [worlds, clocks, checkpoints, streams, aircraftRows, activeRows, finishedRows, counters] =
      await this.db.batch([
        this.db.select().from(simWorld),
        this.db.select().from(simClock),
        this.db.select().from(simCheckpoint),
        this.db.select().from(simRngStream),
        this.db.select().from(simAircraft),
        this.db.select().from(simFlight).where(eq(simFlight.status, 'active')),
        // Only recent history is held in memory; older flights stay in the table.
        this.db
          .select()
          .from(simFlight)
          .where(ne(simFlight.status, 'active'))
          .orderBy(desc(simFlight.id))
          .limit(RECENT_FLIGHTS),
        this.db.select().from(simCounter),
      ]);

    if (worlds.length + clocks.length + checkpoints.length + streams.length === 0) {
      return null;
    }
    if (worlds.length !== 1 || clocks.length !== 1 || checkpoints.length !== 1) {
      throw new WorldStorageError('Saved world is incomplete: a singleton row is missing');
    }

    const world = parse(worldRow, worlds[0], 'sim_world row');
    const clock = parse(clockRow, clocks[0], 'sim_clock row');
    const checkpoint = parse(checkpointRow, checkpoints[0], 'sim_checkpoint row');

    const rngStreams: Record<string, RngState> = {};
    for (const row of streams) {
      const { name, state } = parse(rngRow, row, 'sim_rng_stream row');
      try {
        rngStreams[name] = decodeRngState(state);
      } catch (cause) {
        throw new WorldStorageError(`Invalid state for RNG stream "${name}"`, { cause });
      }
    }

    const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
    return {
      seq: checkpoint.seq,
      wallTimeMs: checkpoint.wallMs,
      snapshot: {
        modelVersion: world.modelVersion,
        seed: world.seed,
        epoch: simInstant(world.epochMs),
        clock: {
          simTime: simInstant(clock.simTimeMs),
          tick: clock.tick,
          speed: clock.speed,
          running: clock.running,
        },
        rngStreams,
        integrityDigest: checkpoint.integrityDigest,
        fleet: {
          aircraft: aircraftRows.map(toAircraft).sort(byId),
          flights: [...activeRows, ...finishedRows].map(toFlight).sort(byId),
          counters: Object.fromEntries(
            counters
              .map((row) => parse(counterRow, row, 'sim_counter row'))
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((row) => [row.name, row.value]),
          ),
          starterFleetSeeded: world.starterFleetSeeded,
        },
      },
    };
  }

  async save(checkpoint: Checkpoint): Promise<void> {
    const { snapshot } = checkpoint;
    const { fleet } = snapshot;
    const world = {
      seed: snapshot.seed,
      modelVersion: snapshot.modelVersion,
      epochMs: snapshot.epoch,
      starterFleetSeeded: fleet.starterFleetSeeded,
    };
    const clock = {
      simTimeMs: snapshot.clock.simTime,
      tick: snapshot.clock.tick,
      speed: snapshot.clock.speed,
      running: snapshot.clock.running,
    };
    const meta = {
      seq: checkpoint.seq,
      wallMs: checkpoint.wallTimeMs,
      integrityDigest: snapshot.integrityDigest,
    };
    const streams = Object.entries(snapshot.rngStreams).map(([name, state]) => ({
      name,
      state: encodeRngState(state),
    }));
    const streamNames = streams.map((stream) => stream.name);

    const aircraftRows = fleet.aircraft.map((aircraft) => {
      const { id, home, location, performance, performanceMissing, ...columns } = aircraft;
      return {
        id,
        ...columns,
        home: JSON.stringify(home),
        location: location === null ? null : JSON.stringify(location),
        performance: performance === null ? null : JSON.stringify(performance),
        performanceMissing: JSON.stringify(performanceMissing),
      };
    });
    const flightRows = fleet.flights.map((flight) => {
      const { id, plan, progress, ...columns } = flight;
      return { id, ...columns, plan: JSON.stringify(plan), progress: JSON.stringify(progress) };
    });

    await this.db.batch([
      this.db
        .insert(simWorld)
        .values({ id: SINGLETON_ID, ...world, createdWallMs: checkpoint.wallTimeMs })
        .onConflictDoUpdate({ target: simWorld.id, set: world }),
      this.db
        .insert(simClock)
        .values({ id: SINGLETON_ID, ...clock })
        .onConflictDoUpdate({ target: simClock.id, set: clock }),
      this.db
        .insert(simCheckpoint)
        .values({ id: SINGLETON_ID, ...meta })
        .onConflictDoUpdate({ target: simCheckpoint.id, set: meta }),
      streamNames.length > 0
        ? this.db.delete(simRngStream).where(notInArray(simRngStream.name, streamNames))
        : this.db.delete(simRngStream),
      ...streams.map((stream) =>
        this.db
          .insert(simRngStream)
          .values(stream)
          .onConflictDoUpdate({ target: simRngStream.name, set: { state: stream.state } }),
      ),
      // Aircraft before flights: a flight row refers to its aircraft.
      ...aircraftRows.map(({ id, ...columns }) =>
        this.db
          .insert(simAircraft)
          .values({ id, ...columns })
          .onConflictDoUpdate({ target: simAircraft.id, set: columns }),
      ),
      // Flights no longer in memory are left untouched: they are history.
      ...flightRows.map(({ id, ...columns }) =>
        this.db
          .insert(simFlight)
          .values({ id, ...columns })
          .onConflictDoUpdate({ target: simFlight.id, set: columns }),
      ),
      ...Object.entries(fleet.counters).map(([name, value]) =>
        this.db
          .insert(simCounter)
          .values({ name, value })
          .onConflictDoUpdate({ target: simCounter.name, set: { value } }),
      ),
    ]);
  }
}

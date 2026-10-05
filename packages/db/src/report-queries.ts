import {
  STATUS_LOG_TYPES,
  type AircraftRecord,
  type EventRecord,
  type FlightRecord,
  type InProgressFlight,
  type InProgressMission,
  type LogRecord,
  type MissionRecord,
  type ReportData,
} from '@aegis/domain';
import { and, asc, eq, gte, inArray, isNotNull, like, lt, lte, max, ne, or } from 'drizzle-orm';
import { z } from 'zod';
import type { AegisDb } from './client';
import {
  simAircraft,
  simCheckpoint,
  simClock,
  simEvent,
  simFlight,
  simLog,
  simMission,
  simWorld,
} from './schema';
import { WorldStorageError } from './world-store';

/*
 * Reads for reports (ADR 0024). Read-only, and nothing here is stored: a report is the history
 * the world already keeps, selected for a window of simulation time.
 *
 * Everything is read in one batch, which the native side runs in one transaction, so a report
 * describes a single checkpoint even while the simulation goes on saving.
 */

const point = z.object({ name: z.string(), code: z.string().nullish() });
const progress = z.object({
  elapsedS: z.number(),
  distanceM: z.number(),
  fuelKg: z.number(),
  // Absent on a flight from before in-flight control: it did not hold.
  hold: z.object({ reason: z.enum(['operator', 'closure']) }).nullish(),
  heldS: z.number().default(0),
  closureLanding: z.boolean().default(false),
  // Absent on a flight that finished before the environment existed.
  exposure: z.object({ worstSeverity: z.number() }).optional(),
});
const plan = z.object({ points: z.array(point).min(2) });
const revisions = z.array(z.object({ intent: z.enum(['reroute', 'divert', 'return']) }));
const objectives = z.array(z.object({ required: z.boolean(), status: z.string() }));
const assessment = z.object({ risk: z.object({ index: z.number() }) });
const outcome = z.object({ summary: z.string() });
const area = z.object({ name: z.string() });
const payload = z.record(z.string(), z.unknown());

function read<T>(schema: z.ZodType<T>, text: string, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WorldStorageError(`${what} is not valid JSON`);
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new WorldStorageError(`${what} cannot be read for a report`);
  return result.data;
}

const label = (place: z.infer<typeof point>) => place.code ?? place.name;

export interface LoadedReportData extends ReportData {
  /** The checkpoint the data was read at. Changes exactly when the data may have. */
  readonly checkpointSeq: number;
}

/**
 * Everything needed to report on `[fromTick, toTick)`, as of the last checkpoint. `null` when
 * there is no world yet.
 */
export async function loadReportData(
  db: AegisDb,
  fromTick: number,
  toTick: number,
): Promise<LoadedReportData | null> {
  // A log entry that can change an aircraft's status. Events name an aircraft only when they
  // concern one, which today is an inspection finding.
  // An event names an aircraft when it concerns one, but only an inspection finding changes the
  // aircraft's status when it starts; a technical caution shows on an aircraft that stays in flight.
  const statusEntry = and(
    isNotNull(simLog.aircraftId),
    or(
      inArray(
        simLog.type,
        STATUS_LOG_TYPES.filter((type) => type !== 'eventStarted'),
      ),
      and(
        eq(simLog.type, 'eventStarted'),
        like(simLog.payload, '%"eventType":"maintenance_finding"%'),
      ),
    ),
  );

  const [
    worlds,
    clocks,
    checkpoints,
    aircraftRows,
    flightRows,
    missionRows,
    eventRows,
    windowLog,
    priorLog,
    activeFlightRows,
    activeMissionRows,
  ] = await db.batch([
    db.select().from(simWorld),
    db.select().from(simClock),
    db.select().from(simCheckpoint),
    db.select().from(simAircraft).orderBy(asc(simAircraft.id)),
    db
      .select()
      .from(simFlight)
      .where(
        and(
          ne(simFlight.status, 'active'),
          gte(simFlight.arrivedTick, fromTick),
          lt(simFlight.arrivedTick, toTick),
        ),
      )
      .orderBy(asc(simFlight.arrivedTick), asc(simFlight.id)),
    db
      .select()
      .from(simMission)
      .where(and(gte(simMission.completedTick, fromTick), lt(simMission.completedTick, toTick)))
      .orderBy(asc(simMission.completedTick), asc(simMission.id)),
    // Every event that could have been open in the window: started before its end, and either
    // not over or over only after its start.
    db
      .select()
      .from(simEvent)
      .where(
        and(
          lt(simEvent.startTick, toTick),
          or(gte(simEvent.endTick, fromTick), inArray(simEvent.status, ['scheduled', 'active'])),
        ),
      )
      .orderBy(asc(simEvent.startTick), asc(simEvent.id)),
    // Status history: the transitions in the window...
    db
      .select()
      .from(simLog)
      .where(and(gte(simLog.tick, fromTick), lt(simLog.tick, toTick), statusEntry))
      .orderBy(asc(simLog.seq)),
    // ...and, for each aircraft, the last one before it, which settles what the aircraft was
    // when the window opened. The database finds it; the history before the window is never
    // read into the application, however long it is.
    db
      .select()
      .from(simLog)
      .where(
        inArray(
          simLog.seq,
          db
            .select({ seq: max(simLog.seq) })
            .from(simLog)
            .where(and(lt(simLog.tick, fromTick), statusEntry))
            .groupBy(simLog.aircraftId),
        ),
      )
      .orderBy(asc(simLog.seq)),
    // What is in the air at this checkpoint, to be shown apart from what has finished.
    db.select().from(simFlight).where(eq(simFlight.status, 'active')).orderBy(asc(simFlight.id)),
    db.select().from(simMission).where(eq(simMission.status, 'active')).orderBy(asc(simMission.id)),
  ]);

  const world = worlds[0];
  const clock = clocks[0];
  const checkpoint = checkpoints[0];
  if (!world || !clock || !checkpoint) return null;

  // Which missions each event affected. The log is append-only, so entries up to the checkpoint's
  // tick read the same now as they did in the batch; and nothing can have happened to an event
  // before it was created. When an event ended is in the events table itself (ADR 0026).
  const earliestEvent = eventRows.reduce(
    (earliest, row) => Math.min(earliest, row.createdTick),
    Number.POSITIVE_INFINITY,
  );
  const eventLog =
    eventRows.length === 0
      ? []
      : await db
          .select()
          .from(simLog)
          .where(
            and(
              eq(simLog.type, 'missionAffected'),
              gte(simLog.tick, earliestEvent),
              lte(simLog.tick, clock.tick),
              lt(simLog.tick, toTick),
            ),
          )
          .orderBy(asc(simLog.seq));

  const aircraft: AircraftRecord[] = aircraftRows.map((row) => ({
    id: row.id,
    typeName: row.typeName,
    category: row.category,
    status: row.status,
    conditionPct: row.conditionPct,
    flightSecondsTotal: row.flightSecondsTotal,
    flightSecondsSinceMaintenance: row.flightSecondsSinceMaintenance,
    acquiredTick: row.acquiredTick,
    home: label(read(point, row.home, `${row.id} home`)),
  }));

  const flights: FlightRecord[] = flightRows.map((row) => {
    const flown = read(progress, row.progress, `${row.id} progress`);
    const route = routeOf(row);
    return {
      id: row.id,
      aircraftId: row.aircraftId,
      missionId: row.missionId,
      status: row.status === 'fuel_exhausted' ? 'fuel_exhausted' : 'completed',
      ...route,
      heldS: flown.heldS,
      landedDuringClosure: flown.closureLanding,
      caution: row.caution !== null,
      departedTick: row.departedTick,
      arrivedTick: row.arrivedTick as number,
      durationS: flown.elapsedS,
      distanceM: flown.distanceM,
      fuelUsedKg: row.fuelAtDepartureKg - flown.fuelKg,
      estimatedDurationS: row.estimatedDurationS,
      estimatedFuelUsedKg: row.estimatedFuelUsedKg,
      stillAirDurationS: row.stillAirDurationS,
      stillAirFuelUsedKg: row.stillAirFuelUsedKg,
      worstSeverity: flown.exposure?.worstSeverity ?? null,
    };
  });

  const inProgressFlights: InProgressFlight[] = activeFlightRows.map((row) => {
    const flown = read(progress, row.progress, `${row.id} progress`);
    return {
      id: row.id,
      aircraftId: row.aircraftId,
      missionId: row.missionId,
      ...routeOf(row),
      departedTick: row.departedTick,
      elapsedS: flown.elapsedS,
      distanceM: flown.distanceM,
      fuelUsedKg: row.fuelAtDepartureKg - flown.fuelKg,
      holding: flown.hold?.reason ?? null,
    };
  });
  const inProgressMissions: InProgressMission[] = activeMissionRows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    aircraftId: row.aircraftId,
    flightId: row.flightId,
    launchedTick: row.actualStartTick,
  }));

  const missions: MissionRecord[] = missionRows.map((row) => {
    const list = read(objectives, row.objectives, `${row.id} objectives`);
    const required = list.filter((objective) => objective.required);
    const risk = (text: string | null, what: string) =>
      text === null ? null : read(assessment, text, `${row.id} ${what}`).risk.index;
    return {
      id: row.id,
      type: row.type,
      source: row.source,
      status: row.status,
      priority: row.priority,
      title: row.title,
      aircraftId: row.aircraftId,
      flightId: row.flightId,
      createdTick: row.createdTick,
      acceptedTick: row.acceptedTick,
      plannedStartTick: row.plannedStartTick,
      actualStartTick: row.actualStartTick,
      completedTick: row.completedTick as number,
      completeByTick: row.completeByTick,
      acceptanceRisk: risk(row.acceptance, 'acceptance'),
      // Until launch the stored figures are those accepted; they are the launch record only once
      // the mission has launched (ADR 0024).
      launchRisk: row.actualStartTick === null ? null : risk(row.assessment, 'assessment'),
      objectives: list.length,
      objectivesComplete: list.filter((objective) => objective.status === 'complete').length,
      objectivesFailed: list.filter((objective) => objective.status === 'failed').length,
      requiredObjectives: required.length,
      requiredComplete: required.filter((objective) => objective.status === 'complete').length,
      summary:
        row.outcome === null ? null : read(outcome, row.outcome, `${row.id} outcome`).summary,
    };
  });

  const statusLog: LogRecord[] = [...priorLog, ...windowLog].map((row) => ({
    seq: row.seq,
    tick: row.tick,
    kind: row.kind,
    type: row.type,
    aircraftId: row.aircraftId,
    missionId: row.missionId,
    payload: read(payload, row.payload, `log entry ${row.seq}`),
  }));
  const affected = new Map<string, string[]>();
  for (const row of eventLog) {
    const { eventId } = read(payload, row.payload, `log entry ${row.seq}`);
    if (typeof eventId !== 'string' || row.missionId === null) continue;
    const list = affected.get(eventId) ?? [];
    if (!list.includes(row.missionId)) list.push(row.missionId);
    affected.set(eventId, list);
  }

  const events: EventRecord[] = eventRows.map((row) => {
    const place = row.place === null ? null : read(point, row.place, `${row.id} place`);
    const centre = row.centre === null ? null : read(area, row.centre, `${row.id} centre`);
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      source: row.source,
      severity: row.severity,
      title: row.title,
      where: place
        ? place.code
          ? `${place.name} (${place.code})`
          : place.name
        : centre && row.radiusM !== null
          ? `${centre.name}, within ${Math.round(row.radiusM / 1000)} km`
          : null,
      createdTick: row.createdTick,
      startTick: row.startTick,
      endTick: row.endTick,
      aircraftId: row.aircraftId,
      raisedMissionId: row.missionId,
      affectedMissionIds: affected.get(row.id) ?? [],
    };
  });

  return {
    checkpointSeq: checkpoint.seq,
    asOfTick: clock.tick,
    epochMs: world.epochMs,
    modelVersion: world.modelVersion,
    logCompleteFromTick: world.logCompleteFromTick,
    aircraft,
    flights,
    inProgressFlights,
    inProgressMissions,
    missions,
    events,
    statusLog,
  };
}

/** Where a flight went from and to, as flown and as launched, and how its route was changed. */
function routeOf(row: { id: string; plan: string; plannedPlan: string | null; revisions: string }) {
  const { points } = read(plan, row.plan, `${row.id} plan`);
  const destination = label(points.at(-1) as z.infer<typeof point>);
  // Stored only when it differs: a flight that was never revised was launched as it was flown.
  const planned =
    row.plannedPlan === null
      ? destination
      : label(
          read(plan, row.plannedPlan, `${row.id} planned_plan`).points.at(-1) as z.infer<
            typeof point
          >,
        );
  return {
    origin: label(points[0] as z.infer<typeof point>),
    destination,
    plannedDestination: planned,
    revisions: read(revisions, row.revisions, `${row.id} revisions`).map(
      (revision) => revision.intent,
    ),
  };
}

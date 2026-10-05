import {
  STATUS_LOG_TYPES,
  type AircraftRecord,
  type EventRecord,
  type FlightRecord,
  type LogRecord,
  type MissionRecord,
  type ReportData,
} from '@aegis/domain';
import { and, asc, eq, gte, inArray, isNotNull, lt, lte, max, ne, or } from 'drizzle-orm';
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
  // Absent on a flight that finished before the environment existed.
  exposure: z.object({ worstSeverity: z.number() }).optional(),
});
const plan = z.object({ points: z.array(point).min(2) });
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
  const statusEntry = and(
    inArray(simLog.type, [...STATUS_LOG_TYPES]),
    isNotNull(simLog.aircraftId),
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
  ]);

  const world = worlds[0];
  const clock = clocks[0];
  const checkpoint = checkpoints[0];
  if (!world || !clock || !checkpoint) return null;

  // Which missions each event affected, and when each event was actually resolved. The events
  // table keeps the end an event was given when it was created; a maintenance finding has no end
  // of its own and lasts until the aircraft is maintained, so the log is where its end is.
  // The log is append-only, so entries up to the checkpoint's tick read the same now as they did
  // in the batch; and nothing can have happened to an event before it was created.
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
              gte(simLog.tick, earliestEvent),
              lte(simLog.tick, clock.tick),
              or(
                and(eq(simLog.type, 'missionAffected'), lt(simLog.tick, toTick)),
                eq(simLog.type, 'eventResolved'),
              ),
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
    const { points } = read(plan, row.plan, `${row.id} plan`);
    return {
      id: row.id,
      aircraftId: row.aircraftId,
      missionId: row.missionId,
      status: row.status === 'fuel_exhausted' ? 'fuel_exhausted' : 'completed',
      origin: label(points[0] as z.infer<typeof point>),
      destination: label(points.at(-1) as z.infer<typeof point>),
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
  const resolvedAt = new Map<string, number>();
  for (const row of eventLog) {
    const { eventId } = read(payload, row.payload, `log entry ${row.seq}`);
    if (typeof eventId !== 'string') continue;
    if (row.type === 'eventResolved') {
      resolvedAt.set(eventId, row.tick);
      continue;
    }
    if (row.missionId === null) continue;
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
      // When it actually ended, where the log says; otherwise the end it was given.
      endTick: (row.status === 'resolved' ? resolvedAt.get(row.id) : undefined) ?? row.endTick,
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
    missions,
    events,
    statusLog,
  };
}

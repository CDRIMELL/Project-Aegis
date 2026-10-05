import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MISSION_TEMPLATES,
  TICKS_PER_DAY,
  buildReport,
  defaultBrief,
  presetPeriod,
  reportTable,
  toCsv,
  toJson,
  type MissionBrief,
  type MissionType,
  type Report,
  type ReportPeriod,
} from '@aegis/domain';
import {
  MAINTENANCE,
  SimulationEngine,
  defaultConfiguration,
  replayWorld,
  type Checkpoint,
  type WorldCommand,
} from '@aegis/sim';
import { FIXTURES, fixtureLaunch, fixtureOrder } from '@aegis/sim/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNodeDatabase, type NodeDatabase } from './node';
import { loadReportData } from './report-queries';
import { SqliteWorldStore } from './world-store';

const { places, models } = FIXTURES;
const TRANSPORT = 'AEGIS-TR-001';
const JET = 'AEGIS-FT-001';
const AREA = { name: 'Area 1', lat: 49.4, lon: -7.2 };
const HOUR = 3600;
const ALL: ReportPeriod = { fromTick: 0, toTick: 100 * TICKS_PER_DAY };

const briefFor = (type: MissionType, overrides: Partial<MissionBrief>): MissionBrief => ({
  ...defaultBrief(MISSION_TEMPLATES[type]),
  ...overrides,
});

function training(engine: SimulationEngine): string {
  const aircraft = engine.snapshot().fleet.aircraft.find((each) => each.id === TRANSPORT);
  if (!aircraft) throw new Error('no transport');
  const before = engine.snapshot().missions.nextNumber;
  engine.applyCommand({
    type: 'createMission',
    missionType: 'training',
    ...defaultConfiguration('training', briefFor('training', { target: AREA }), aircraft, {
      context: engine.planContext(),
    }),
  });
  return `MSN-${String(before).padStart(6, '0')}`;
}

const missionOf = (engine: SimulationEngine, id: string) =>
  engine.snapshot().missions.missions.find((mission) => mission.id === id);

/**
 * Makes the transport fit to fly. The world may have found it due maintenance in the meantime
 * (ADR 0022): that is part of the history being reported, not something to avoid.
 */
function serviceable(engine: SimulationEngine): void {
  const transport = engine.snapshot().fleet.aircraft.find((each) => each.id === TRANSPORT);
  if (transport?.status === 'maintenance_due') {
    engine.applyCommand({ type: 'startMaintenance', aircraftId: TRANSPORT });
    engine.runSteps(MAINTENANCE.durationSeconds + 1);
  }
}

function fly(engine: SimulationEngine, missionId: string): void {
  engine.applyCommand({ type: 'acceptMission', missionId });
  engine.applyCommand({ type: 'launchMission', missionId });
  for (let i = 0; i < 400 && missionOf(engine, missionId)?.status === 'active'; i++) {
    engine.runSteps(60);
  }
  if (missionOf(engine, missionId)?.status === 'active') throw new Error('mission did not end');
}

/**
 * A day and a half of operations: two missions flown, one cancelled, one accepted hours before
 * it launches, a flight on its own, and a maintenance visit.
 */
function operations(seed = 'reported-world'): SimulationEngine {
  const engine = SimulationEngine.create({ seed, epoch: FIXTURES.epoch });
  const apply = (command: WorldCommand) => engine.applyCommand(command);
  apply({
    type: 'seedStarterFleet',
    aircraft: [
      fixtureOrder('fastJet', places.prestwick),
      fixtureOrder('transport', places.newquay),
    ],
  });
  apply({
    type: 'setOperatingArea',
    places: [places.prestwick, places.newquay, places.exeter, places.akrotiri],
  });
  engine.runSteps(600);
  fly(engine, training(engine));
  apply(fixtureLaunch(JET, models.fastJet, places.prestwick, places.newquay));
  engine.runSteps(2 * HOUR);
  apply({ type: 'startMaintenance', aircraftId: TRANSPORT });
  engine.runSteps(MAINTENANCE.durationSeconds + HOUR);
  apply({ type: 'cancelMission', missionId: training(engine) });
  // Accepted in one weather, launched five hours later in another.
  const late = training(engine);
  apply({ type: 'acceptMission', missionId: late });
  engine.runSteps(5 * HOUR);
  apply({ type: 'launchMission', missionId: late });
  for (let i = 0; i < 400 && missionOf(engine, late)?.status === 'active'; i++) engine.runSteps(60);
  engine.runSteps(12 * HOUR);
  return engine;
}

const checkpoint = (engine: SimulationEngine, seq = 1): Checkpoint => ({
  seq,
  wallTimeMs: 1_800_000_000_000 + seq,
  snapshot: engine.snapshot(),
});

async function reportFrom(database: NodeDatabase, period: ReportPeriod = ALL): Promise<Report> {
  const data = await loadReportData(database.db, period.fromTick, period.toTick);
  if (!data) throw new Error('no world');
  return buildReport(data, period, MAINTENANCE);
}

/** Every table of a report, as the bytes an export would write. */
const exported = (report: Report) =>
  (['summary', 'missions', 'fleet', 'fuel', 'maintenance', 'events'] as const)
    .map((name) => toCsv(reportTable(name, report)) + toJson(reportTable(name, report), report))
    .join('\n');

/**
 * The part of a report that is history: what finished in the period. The rest of a report says
 * how things stand at the moment it is as of, and rightly moves on.
 */
const history = (report: Report) =>
  [
    toCsv(reportTable('missions', report)),
    toCsv(reportTable('fuel', report)),
    toCsv(reportTable('maintenance', report)),
    JSON.stringify([report.totals, report.series, report.missionTypes]),
  ].join('|');

describe('reports from a saved world', () => {
  let database: NodeDatabase;
  let store: SqliteWorldStore;

  beforeEach(() => {
    database = openNodeDatabase(':memory:');
    store = new SqliteWorldStore(database.db);
  });
  afterEach(() => {
    database.close();
  });

  it('reports nothing before there is a world', async () => {
    expect(await loadReportData(database.db, 0, 1000)).toBeNull();
  });

  it('derives totals that agree with what the engine itself recorded', async () => {
    const engine = operations();
    await store.save(checkpoint(engine));
    const report = await reportFrom(database);
    const snapshot = engine.snapshot();

    const finished = snapshot.fleet.flights.filter((flight) => flight.status !== 'active');
    expect(finished.length).toBe(3);
    expect(report.totals.flights).toBe(3);
    expect(report.totals.flightSeconds).toBe(
      finished.reduce((sum, flight) => sum + flight.progress.elapsedS, 0),
    );
    expect(report.totals.distanceM).toBeCloseTo(
      finished.reduce((sum, flight) => sum + flight.progress.distanceM, 0),
      6,
    );
    expect(report.totals.fuelUsedKg).toBeCloseTo(
      finished.reduce((sum, flight) => sum + flight.fuelAtDepartureKg - flight.progress.fuelKg, 0),
      6,
    );

    // The engine keeps its own running total of each aircraft's flying time. The report never
    // reads it for a period: it adds up the flights, and must arrive at the same figure.
    for (const row of report.aircraft) {
      const aircraft = snapshot.fleet.aircraft.find((each) => each.id === row.aircraft.id);
      expect(row.flightSeconds).toBe(aircraft?.flightSecondsTotal);
      expect(row.flights).toBe(aircraft?.flights);
      expect(row.time.byStatus.in_flight).toBe(aircraft?.flightSecondsTotal);
      expect(row.time.notRecordedS).toBe(0);
    }

    expect(report.totals).toMatchObject({
      missionsCompleted: 2,
      missionsFailed: 0,
      missionsCancelled: 1,
      maintenanceVisits: 1,
      maintenanceSeconds: MAINTENANCE.durationSeconds,
    });
    expect(report.asOfTick).toBe(snapshot.clock.tick);
    expect(report.modelVersion).toBe(snapshot.modelVersion);
  });

  it('accounts for every aircraft second since the world began', async () => {
    const engine = operations();
    await store.save(checkpoint(engine));
    const report = await reportFrom(database);
    const until = engine.clock.tick + 1;
    for (const row of report.aircraft) {
      expect(row.time.recordedS).toBe(until - row.aircraft.acquiredTick);
    }
    const transport = report.aircraft.find((row) => row.aircraft.id === TRANSPORT);
    expect(transport?.time.byStatus.in_maintenance).toBe(MAINTENANCE.durationSeconds);
    // Time due maintenance comes from the log; the events table says independently when an
    // inspection finding made each aircraft due.
    for (const row of report.aircraft) {
      const finding = engine
        .snapshot()
        .events.events.find(
          (event) => event.type === 'maintenance_finding' && event.aircraftId === row.aircraft.id,
        );
      const due = finding ? until - finding.startTick : 0;
      expect(row.time.byStatus.maintenance_due).toBe(due);
      expect(row.aircraft.status).toBe(finding ? 'maintenance_due' : 'available');
      expect(row.availability).toBeCloseTo(
        1 - (row.time.byStatus.in_maintenance + due) / (until - row.aircraft.acquiredTick),
        12,
      );
    }
    expect(report.fleet.availability).toBeLessThan(1);
    expect(report.fleet.availability).toBeGreaterThan(0.5);
  });

  it('knows what each aircraft was when a period opened, from the last transition before it', async () => {
    const engine = operations();
    await store.save(checkpoint(engine));
    const whole = await reportFrom(database);
    const visit = whole.maintenance[0];
    if (!visit?.completedTick) throw new Error('no maintenance visit');
    // A period that opens an hour into the visit, and one that opens while the jet is airborne.
    const midVisit = await reportFrom(database, {
      fromTick: visit.startedTick + HOUR,
      toTick: visit.completedTick + HOUR,
    });
    const transport = midVisit.aircraft.find((row) => row.aircraft.id === TRANSPORT);
    expect(transport?.time.byStatus).toMatchObject({
      in_maintenance: MAINTENANCE.durationSeconds - HOUR,
      available: HOUR,
    });
    expect(transport?.time.notRecordedS).toBe(0);
    // The visit finished in this period and is reported with its true start, before the period.
    expect(midVisit.maintenance).toEqual([visit]);

    const jetFlight = whole.flights.find((flight) => flight.aircraftId === JET);
    if (!jetFlight) throw new Error('no jet flight');
    const midFlight = await reportFrom(database, {
      fromTick: jetFlight.departedTick + 600,
      toTick: jetFlight.arrivedTick + 600,
    });
    expect(midFlight.aircraft.find((row) => row.aircraft.id === JET)?.time.byStatus).toMatchObject({
      in_flight: jetFlight.durationS - 600,
      available: 600,
    });
    // Any way a stretch of time is divided, the parts add up to the whole.
    const cut = visit.startedTick + HOUR;
    const [first, second] = [
      await reportFrom(database, { fromTick: 0, toTick: cut }),
      await reportFrom(database, { fromTick: cut, toTick: ALL.toTick }),
    ];
    for (const row of whole.aircraft) {
      const parts = [first, second].map(
        (part) => part.aircraft.find((each) => each.aircraft.id === row.aircraft.id)?.time,
      );
      for (const status of Object.keys(row.time.byStatus) as (keyof typeof row.time.byStatus)[]) {
        expect((parts[0]?.byStatus[status] ?? 0) + (parts[1]?.byStatus[status] ?? 0)).toBe(
          row.time.byStatus[status],
        );
      }
    }
  });

  it('reports the risk accepted and the risk at launch as two figures', async () => {
    const engine = operations();
    await store.save(checkpoint(engine));
    const report = await reportFrom(database);
    const stored = engine.snapshot().missions.missions;
    const flown = report.missions.filter((mission) => mission.status === 'completed');
    expect(flown).toHaveLength(2);
    for (const mission of flown) {
      const source = stored.find((each) => each.id === mission.id);
      expect(mission.acceptanceRisk).toBe(source?.acceptance?.risk.index);
      expect(mission.launchRisk).toBe(source?.assessment?.risk.index);
    }
    // The late launch was assessed twice, five hours apart.
    const late = stored.find((each) => each.id === flown[1]?.id);
    expect((late?.assessment?.assessedTick ?? 0) - (late?.acceptance?.assessedTick ?? 0)).toBe(
      5 * HOUR,
    );
    // A cancelled mission was never accepted or launched: neither figure exists.
    expect(report.missions.find((mission) => mission.status === 'cancelled')).toMatchObject({
      acceptanceRisk: null,
      launchRisk: null,
    });
  });

  it('shows acceptance risk as not recorded for missions saved before it was kept', async () => {
    await store.save(checkpoint(operations()));
    database.transport.connection.exec('UPDATE sim_mission SET acceptance = NULL');
    const report = await reportFrom(database);
    const flown = report.missions.filter((mission) => mission.status === 'completed');
    expect(flown.every((mission) => mission.acceptanceRisk === null)).toBe(true);
    expect(flown.every((mission) => mission.launchRisk !== null)).toBe(true);
    expect(reportTable('missions', report).rows[0]?.risk_accepted).toBeNull();
  });

  it('selects by simulation time: each record in exactly one of two adjacent periods', async () => {
    const engine = operations();
    await store.save(checkpoint(engine));
    const whole = await reportFrom(database);
    const split = whole.flights[1]?.arrivedTick ?? 0;
    const first = await reportFrom(database, { fromTick: 0, toTick: split });
    const second = await reportFrom(database, { fromTick: split, toTick: ALL.toTick });
    expect(first.flights.map((flight) => flight.id)).toEqual([whole.flights[0]?.id]);
    expect(second.flights.map((flight) => flight.id)).toEqual(
      whole.flights.slice(1).map((flight) => flight.id),
    );
    expect(first.totals.fuelUsedKg + second.totals.fuelUsedKg).toBeCloseTo(
      whole.totals.fuelUsedKg,
      6,
    );
    expect(first.totals.missionsCompleted + second.totals.missionsCompleted).toBe(2);
    // The named periods are measured from the saved world's clock.
    const data = await loadReportData(database.db, 0, ALL.toTick);
    const day = presetPeriod('last24h', data?.asOfTick ?? 0, data?.epochMs ?? 0);
    const lastDay = await reportFrom(database, day);
    expect(lastDay.flights.every((flight) => flight.arrivedTick >= day.fromTick)).toBe(true);
    expect(lastDay.totals.flights).toBe(1);
  });

  it('does not rewrite a past period when aircraft are changed and go on flying', async () => {
    const engine = operations();
    await store.save(checkpoint(engine, 1));
    const past: ReportPeriod = { fromTick: 0, toTick: engine.clock.tick + 1 };
    const before = await reportFrom(database, past);

    // The period includes its last tick, and a command given while the clock still reads that
    // tick belongs to it. So time moves on first; then the aircraft is re-modelled, rebased and
    // flown again, and the world runs another day.
    engine.runSteps(1);
    const transport = engine.snapshot().fleet.aircraft.find((each) => each.id === TRANSPORT);
    engine.applyCommand({
      type: 'updatePerformance',
      aircraftId: TRANSPORT,
      performance: { ...models.transport, cruiseSpeedKmh: models.transport.cruiseSpeedKmh * 0.8 },
      performanceMissing: [],
    });
    engine.applyCommand({ type: 'setHome', aircraftId: TRANSPORT, home: places.exeter });
    expect(transport?.home).not.toEqual(places.exeter);
    serviceable(engine);
    fly(engine, training(engine));
    engine.runSteps(TICKS_PER_DAY);
    await store.save(checkpoint(engine, 2));

    const after = await reportFrom(database, past);
    expect(after.totals).toEqual(before.totals);
    expect(after.flights).toEqual(before.flights);
    expect(after.missions).toEqual(before.missions);
    expect(after.maintenance).toEqual(before.maintenance);
    expect(after.series).toEqual(before.series);
    expect(after.aircraft.map((row) => [row.flightSeconds, row.fuelUsedKg, row.time])).toEqual(
      before.aircraft.map((row) => [row.flightSeconds, row.fuelUsedKg, row.time]),
    );
    expect(toCsv(reportTable('missions', after))).toBe(toCsv(reportTable('missions', before)));
    expect(toCsv(reportTable('fuel', after))).toBe(toCsv(reportTable('fuel', before)));
    // And the new flight is in the later period, with the aircraft as it now is.
    const later = await reportFrom(database, { fromTick: past.toTick, toTick: ALL.toTick });
    expect(later.totals.flights).toBe(1);
    expect(later.aircraft.find((row) => row.aircraft.id === TRANSPORT)?.aircraft.home).toBe('EGTE');
  });

  it('gives the same report from a world replayed from its seed and log', async () => {
    const engine = operations();
    await store.save(checkpoint(engine));
    const original = await reportFrom(database);

    const snapshot = engine.snapshot();
    const replayed = replayWorld(
      { seed: 'reported-world', epoch: FIXTURES.epoch },
      snapshot.log.entries,
      snapshot.clock.tick,
    );
    const other = openNodeDatabase(':memory:');
    try {
      await new SqliteWorldStore(other.db).save(checkpoint(replayed));
      expect(exported(await reportFrom(other))).toBe(exported(original));
    } finally {
      other.close();
    }
  });

  it('includes events and the missions they affected, by simulation time', async () => {
    // Run until the world has produced and resolved at least one event.
    const engine = operations('eventful-reports');
    for (let i = 0; i < 400; i++) {
      if (engine.snapshot().events.events.some((event) => event.status === 'resolved')) break;
      engine.runSteps(2 * HOUR);
    }
    await store.save(checkpoint(engine));
    const report = await reportFrom(database);
    const saved = engine.snapshot().events.events;
    expect(saved.some((event) => event.status === 'resolved')).toBe(true);
    expect(report.events.map((event) => event.id).sort()).toEqual(
      saved
        .filter((event) => event.status !== 'scheduled' || event.startTick <= engine.clock.tick)
        .filter((event) => event.startTick < ALL.toTick)
        .map((event) => event.id)
        .sort(),
    );
    expect(report.totals.eventsStarted).toBe(
      saved.filter((event) => event.startTick <= engine.clock.tick).length,
    );
    const types = report.eventTypes.reduce((sum, type) => sum + type.events, 0);
    expect(types).toBe(report.events.length);
    for (const event of report.events) expect(event.where ?? event.aircraftId).toBeTruthy();
  });
});

describe('reports across a restart', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-reports-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('is identical, byte for byte, after the application is closed and reopened', async () => {
    const path = join(directory, 'aegis.db');
    const engine = operations();
    let database = openNodeDatabase(path);
    await new SqliteWorldStore(database.db).save(checkpoint(engine));
    const before = exported(await reportFrom(database));
    database.close();

    database = openNodeDatabase(path);
    try {
      expect(exported(await reportFrom(database))).toBe(before);
      // The restored world carries on, and the earlier period still reads the same.
      const loaded = await new SqliteWorldStore(database.db).load();
      const restored = SimulationEngine.restore(loaded?.snapshot as never);
      const past: ReportPeriod = { fromTick: 0, toTick: restored.clock.tick + 1 };
      const pastBefore = history(await reportFrom(database, past));
      restored.runSteps(1);
      serviceable(restored);
      fly(restored, training(restored));
      restored.runSteps(HOUR);
      await new SqliteWorldStore(database.db).save(checkpoint(restored, 2));
      expect(history(await reportFrom(database, past))).toBe(pastBefore);
      expect((await reportFrom(database)).totals.flights).toBe(4);
    } finally {
      database.close();
    }
  });

  it('reports the last checkpoint after a crash, and nothing that was not saved', async () => {
    const path = join(directory, 'aegis.db');
    const engine = operations();
    let database = openNodeDatabase(path);
    await new SqliteWorldStore(database.db).save(checkpoint(engine));
    const saved = exported(await reportFrom(database));
    // More happens, and the process dies before the next checkpoint.
    try {
      serviceable(engine);
      fly(engine, training(engine));
    } finally {
      database.close();
    }

    database = openNodeDatabase(path);
    try {
      const report = await reportFrom(database);
      expect(exported(report)).toBe(saved);
      expect(report.totals.flights).toBe(3);
    } finally {
      database.close();
    }
  });
});

describe('report volume', () => {
  it('reads a month from a long history quickly, without any stored summary', async () => {
    const database = openNodeDatabase(':memory:');
    try {
      await new SqliteWorldStore(database.db).save(checkpoint(operations()));
      const connection = database.transport.connection;
      const template = connection
        .prepare(`SELECT * FROM sim_flight WHERE status = 'completed' LIMIT 1`)
        .get() as Record<string, unknown>;
      const columns = Object.keys(template);
      const insertFlight = connection.prepare(
        `INSERT INTO sim_flight (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      );
      const insertLog = connection.prepare(
        `INSERT INTO sim_log (seq, tick, kind, type, actor, aircraft_id, payload) VALUES (?,?,?,?,?,?,'{}')`,
      );
      const FLIGHTS = 10_000;
      let seq = 1_000_000;
      connection.exec('BEGIN');
      for (let i = 0; i < FLIGHTS; i++) {
        // One flight every two hours for more than two simulated years.
        const departed = 200_000 + i * 7200;
        const row: Record<string, unknown> = {
          ...template,
          id: `FLT-9${String(i).padStart(5, '0')}`,
          mission_id: null,
          departed_tick: departed,
          arrived_tick: departed + 3600,
        };
        insertFlight.run(...(columns.map((column) => row[column]) as never[]));
        insertLog.run(++seq, departed, 'command', 'launchFlight', 'player', TRANSPORT);
        insertLog.run(++seq, departed + 3600, 'event', 'flightCompleted', 'world', TRANSPORT);
        // Log entries reports do not read, as a real world has many of.
        for (let n = 0; n < 8; n++) {
          insertLog.run(++seq, departed + n, 'event', 'objectiveCompleted', 'world', TRANSPORT);
        }
      }
      connection.exec(`UPDATE sim_clock SET tick = ${200_000 + FLIGHTS * 7200}`);
      connection.exec('COMMIT');

      const asOf = 200_000 + FLIGHTS * 7200;
      const month = presetPeriod('last30d', asOf, FIXTURES.epoch);
      const started = performance.now();
      const data = await loadReportData(database.db, month.fromTick, month.toTick);
      if (!data) throw new Error('no world');
      const report = buildReport(data, month, MAINTENANCE);
      const elapsedMs = performance.now() - started;

      expect(report.totals.flights).toBe(360);
      // Two transitions a flight in the window, and one per aircraft from before it: the twenty
      // thousand earlier ones are never read.
      expect(data.statusLog.length).toBeLessThan(2 * 360 + 10);
      const transport = report.aircraft.find((row) => row.aircraft.id === TRANSPORT);
      // Half of every two hours airborne. The window opens one tick into a flight.
      expect(Math.abs((transport?.time.byStatus.in_flight ?? 0) - 360 * 3600)).toBeLessThanOrEqual(
        1,
      );
      expect(transport?.utilisation).toBeCloseTo(0.5, 6);
      // Generous for a loaded machine; the figure itself is in the phase report.
      expect(elapsedMs).toBeLessThan(1500);
      console.info(
        `report over 30 days of ${FLIGHTS} flights, ${seq - 1_000_000} log rows: ${elapsedMs.toFixed(0)} ms`,
      );
    } finally {
      database.close();
    }
  }, 60_000);
});

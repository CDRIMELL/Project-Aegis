import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorldStore } from '@aegis/db';
import { openNodeDatabase } from '@aegis/db/node';
import {
  MISSION_TEMPLATES,
  NO_FILTER,
  TICKS_PER_DAY,
  defaultBrief,
  presetPeriod,
  reportTable,
  simInstant,
  toCsv,
  type Mission,
  type ReportPeriod,
} from '@aegis/domain';
import { importReferenceData } from '@aegis/ingest';
import {
  MAINTENANCE,
  SimulationRunner,
  defaultConfiguration,
  planContextOf,
  replayComparable,
  replayWorld,
  type Checkpoint,
  type ConfigurationOptions,
  type LogEntry,
  type SimCommand,
} from '@aegis/sim';
import { ManualHostClock } from '@aegis/sim/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCatalogue, starterOrders, type AerodromeRow } from '../fleet/catalogue';
import { chooseOperatingArea, fleetCentre } from '../missions/operating-area';
import {
  bindReferenceDb,
  loadAerodrome,
  loadAircraftTypes,
  loadLargeAerodromes,
} from '../reference/queries';
import { bindSimDb, loadMissionLog, loadRecentLog } from '../sim/log-queries';
import { FLIGHT_REFERENCE_INPUTS } from '../testing/flight-fixtures';
import { currentPicture, describePeriod, reportSeries, resolvePeriod } from './report-logic';
import { bindReportDb, exportReport, loadReports, type LoadedReports } from './report-service';

/*
 * Reports end to end, through the code the application runs: a world in which missions are flown
 * to different ends, events come and go and an aircraft needs maintenance; the reports read from
 * what that world recorded; an export; the application closed and reopened; and the world
 * re-derived from its seed and its log. Only the window is absent, and the native command that
 * writes the export, which is tested in Rust.
 */

/** Stands in for the native export command: keeps what it was asked to write. */
const written: { fileName: string; contents: string }[] = [];
vi.mock('../platform/tauri', () => ({
  writeExport: (fileName: string, contents: string) => {
    written.push({ fileName, contents });
    return Promise.resolve({ fileName, path: `exports/${fileName}`, bytes: contents.length });
  },
}));

const EPOCH = simInstant(Date.UTC(2026, 9, 4, 12, 0, 0));
const newWorld = () => ({ seed: 'reports-scenario', epoch: EPOCH });
/** The A400M at Newquay. */
const AIRCRAFT = 'AEGIS-TR-001';
const AREA = { name: 'Area 1', lat: 49.4, lon: -7.2 };
const HOUR = 3600;
const ALL: ReportPeriod = { fromTick: 0, toTick: 400 * TICKS_PER_DAY };

describe('reports: end-to-end scenario', () => {
  let directory: string;
  let path: string;

  async function openSession() {
    const database = openNodeDatabase(path);
    bindReferenceDb(database.db);
    bindSimDb(database.db);
    bindReportDb(database.db);
    const host = new ManualHostClock();
    const runner = await SimulationRunner.open({
      store: new SqliteWorldStore(database.db),
      host,
      newWorld,
      // The world runs for days here; a checkpoint every simulated 100 minutes is plenty.
      checkpointIntervalMs: 60_000,
    });
    const execute = (command: SimCommand) => {
      runner.execute(command);
    };
    /** Runs for a stretch of simulated time, at 100x. */
    const runSim = (simSeconds: number) => {
      for (let elapsed = 0; elapsed < simSeconds * 10; elapsed += 1000) {
        host.elapse(1000);
        runner.advance();
      }
    };
    const view = () => runner.view();
    const aircraft = (id = AIRCRAFT) => {
      const found = view().fleet.aircraft.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`no aircraft ${id}`);
      return found;
    };
    const mission = (id: string): Mission => {
      const found = view().missions.missions.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`no mission ${id}`);
      return found;
    };
    /** Creates a training mission for the A400M, planned in the world as it is now. */
    const create = (options: ConfigurationOptions = {}): string => {
      const before = new Set(view().missions.missions.map((each) => each.id));
      execute({
        type: 'createMission',
        missionType: 'training',
        ...defaultConfiguration(
          'training',
          { ...defaultBrief(MISSION_TEMPLATES.training), target: AREA },
          aircraft(),
          { context: planContextOf(view()), ...options },
        ),
      });
      const created = view().missions.missions.find(
        (each) => !before.has(each.id) && each.source === 'manual',
      );
      if (!created) throw new Error('the mission was not created');
      return created.id;
    };
    const flyOut = (id: string) => {
      for (let i = 0; i < 60 && mission(id).status === 'active'; i++) runSim(600);
      if (mission(id).status === 'active') throw new Error(`${id} did not end`);
    };
    /** The reports as the screen reads them: as of the last checkpoint. */
    const reports = async (period?: ReportPeriod): Promise<LoadedReports> => {
      await runner.flush();
      const { checkpoint, epoch } = view();
      const chosen = period ?? presetPeriod('last30d', checkpoint.persistedTick ?? 0, epoch);
      const loaded = await loadReports(chosen, checkpoint.persistedSeq);
      if (!loaded) throw new Error('no world to report on');
      return loaded;
    };
    return { database, runner, execute, runSim, view, aircraft, mission, create, flyOut, reports };
  }

  let session: Awaited<ReturnType<typeof openSession>>;
  const ids = { completed: '', failed: '', cancelled: '', late: '' };
  /** The aircraft the world found due maintenance. */
  let due = '';

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-reports-scenario-'));
    path = join(directory, 'aegis.db');
    const setup = openNodeDatabase(path);
    let now = 1_800_000_000_000;
    await importReferenceData(setup.db, FLIGHT_REFERENCE_INPUTS, { now: () => (now += 1000) });
    setup.close();
    session = await openSession();
  });
  afterAll(() => {
    session.database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('1-4. runs missions to different ends, accumulating flying and fuel', async () => {
    const { types, attributes } = await loadAircraftTypes();
    const homes = (
      await Promise.all(['EGPK', 'EGHQ'].map((icao) => loadAerodrome({ icao })))
    ).filter((row): row is NonNullable<typeof row> => row !== null) as AerodromeRow[];
    const { orders } = starterOrders(buildCatalogue(types, attributes), homes);
    session.execute({ type: 'setSpeed', speed: 100 });
    session.execute({ type: 'seedStarterFleet', aircraft: orders });
    const fleetHomes = session.view().fleet.aircraft.map((aircraft) => aircraft.home);
    const centre = fleetCentre(fleetHomes);
    if (!centre) throw new Error('the fleet should have a centre');
    session.execute({
      type: 'setOperatingArea',
      places: chooseOperatingArea(await loadLargeAerodromes(), fleetHomes),
      centre,
    });
    session.runSim(600);

    // Completed.
    ids.completed = session.create();
    session.execute({ type: 'acceptMission', missionId: ids.completed });
    session.execute({ type: 'launchMission', missionId: ids.completed });
    session.flyOut(ids.completed);
    expect(session.mission(ids.completed).status).toBe('completed');

    // Failed: accepted, and never launched before its deadline.
    ids.failed = session.create({ completeByTick: session.view().clock.tick + 2 * HOUR });
    session.execute({ type: 'acceptMission', missionId: ids.failed });
    session.runSim(2 * HOUR + 600);
    expect(session.mission(ids.failed)).toMatchObject({
      status: 'failed',
      outcome: { summary: 'Not launched before its deadline.' },
    });

    // Cancelled.
    ids.cancelled = session.create();
    session.execute({ type: 'cancelMission', missionId: ids.cancelled });
    expect(session.mission(ids.cancelled).status).toBe('cancelled');

    expect(session.aircraft().flightSecondsTotal).toBeGreaterThan(0);
    expect(session.aircraft().flights).toBe(1);
  });

  it('6-8. accepts a mission in one risk state, launches it in another, and keeps both', () => {
    ids.late = session.create();
    session.execute({ type: 'acceptMission', missionId: ids.late });
    const accepted = session.mission(ids.late);
    expect(accepted.acceptance).toEqual(accepted.assessment);

    // Six hours pass before it launches: the weather on the route has moved on.
    session.runSim(6 * HOUR);
    session.execute({ type: 'launchMission', missionId: ids.late });
    const launched = session.mission(ids.late);
    expect(launched.acceptance).toEqual(accepted.acceptance);
    expect(
      (launched.assessment?.assessedTick ?? 0) - (launched.acceptance?.assessedTick ?? 0),
    ).toBeGreaterThanOrEqual(6 * HOUR);
    expect(launched.assessment?.durationS).not.toBe(launched.acceptance?.durationS);
    // The two are distinct records, each with its own reasons from the one risk model.
    expect(launched.assessment?.risk.contributors).not.toEqual(
      launched.acceptance?.risk.contributors,
    );
    expect(launched.assessment?.risk.contributors.map((c) => c.id).sort()).toEqual(
      launched.acceptance?.risk.contributors.map((c) => c.id).sort(),
    );

    session.flyOut(ids.late);
    const finished = session.mission(ids.late);
    expect(finished.status).toBe('completed');
    expect(finished.acceptance).toEqual(accepted.acceptance);
    expect(finished.assessment).toEqual(launched.assessment);
  });

  it('3, 5. the world produces and resolves events, and finds an aircraft due maintenance', () => {
    const isDue = () =>
      session.view().fleet.aircraft.find((aircraft) => aircraft.status === 'maintenance_due');
    for (let i = 0; i < 12 * 60 && !isDue(); i++) session.runSim(2 * HOUR);
    const found = isDue();
    if (!found) throw new Error('no aircraft became due maintenance in sixty simulated days');
    due = found.id;

    const events = session.view().events.events;
    expect(events.some((event) => event.status === 'resolved')).toBe(true);
    expect(
      events.find((event) => event.type === 'maintenance_finding' && event.aircraftId === due),
    ).toMatchObject({ status: 'active' });
    expect(currentPicture(session.view())).toMatchObject({ awaitingMaintenance: 1 });
  }, 120_000);

  it('9-10. opens Reports: the overview agrees with the world it describes', async () => {
    const { current } = await session.reports(ALL);
    const view = session.view();

    expect(current.totals).toMatchObject({
      missionsCompleted: 2,
      missionsFailed: 1,
      missionsCancelled: 1,
      flights: 2,
    });
    // Everything flown, from the flights; the engine's own counter agrees.
    const flown = view.fleet.aircraft.reduce((sum, each) => sum + each.flightSecondsTotal, 0);
    expect(current.totals.flightSeconds).toBe(flown);
    expect(current.totals.fuelUsedKg).toBeGreaterThan(1000);
    expect(current.totals.distanceM).toBeGreaterThan(500_000);
    // Estimate and outcome agree to within a kilogram: the planner flew the same weather.
    expect(Math.abs(current.totals.fuelUsedKg - current.totals.estimatedFuelUsedKg)).toBeLessThan(
      2,
    );

    const now = currentPicture(view);
    expect(now.aircraft).toBe(4);
    expect(now.available + now.airborne + now.unavailable).toBe(4);
    expect(now.unavailable).toBe(1);
    expect(now.activeMissions).toBe(0);
    expect(
      current.outlook.filter((row) => row.group === 'due').map((row) => row.aircraft.id),
    ).toEqual([due]);
    expect(current.fleet.aircraft).toBe(4);
    expect(current.fleet.availability).toBeLessThan(1);
    expect(current.fleet.notRecordedS).toBe(0);
    expect(current.asOfTick).toBe(view.clock.tick);
  });

  it('11. filters by simulated period: each record falls in the period it finished in', async () => {
    const { current: all } = await session.reports(ALL);
    const first = all.missions.find((mission) => mission.id === ids.completed);
    const late = all.missions.find((mission) => mission.id === ids.late);
    if (!first || !late) throw new Error('missions missing from the report');

    // A custom period, typed as simulation time, that holds the first mission and not the last.
    const epoch = session.view().epoch;
    const tick = session.view().clock.tick;
    const custom = resolvePeriod(
      { kind: 'custom', from: '2026-10-04 12:00', to: '2026-10-04 14:00' },
      tick,
      epoch,
    );
    expect(custom.problem).toBeNull();
    const { current: morning } = await session.reports(custom.period ?? ALL);
    expect(morning.missions.map((mission) => mission.id)).toEqual([ids.completed]);
    expect(morning.totals.flights).toBe(1);
    expect(describePeriod(morning.period, morning.asOfTick, morning.epochMs)).toBe(
      '2026-10-04 12:00 to 2026-10-04 13:59 UTC · 2 h of simulation time',
    );

    // The named periods are measured back from the simulation clock, not from this computer's.
    const { current: day, previous } = await session.reports(presetPeriod('last24h', tick, epoch));
    expect(day.period.toTick - day.period.fromTick).toBe(TICKS_PER_DAY);
    expect(day.missions.every((mission) => mission.completedTick >= day.period.fromTick)).toBe(
      true,
    );
    expect(previous?.period.toTick).toBe(day.period.fromTick);

    // Splitting the world's life in two loses nothing and counts nothing twice.
    const cut = late.completedTick;
    const [a, b] = [
      (await session.reports({ fromTick: 0, toTick: cut })).current,
      (await session.reports({ fromTick: cut, toTick: ALL.toTick })).current,
    ];
    expect(a.totals.flights + b.totals.flights).toBe(all.totals.flights);
    expect(a.totals.missionsCompleted + b.totals.missionsCompleted).toBe(2);
    expect(b.missions.map((mission) => mission.id)).toContain(ids.late);
    expect(a.missions.map((mission) => mission.id)).not.toContain(ids.late);
    expect(a.totals.fuelUsedKg + b.totals.fuelUsedKg).toBeCloseTo(all.totals.fuelUsedKg, 6);

    // The series a chart draws adds up to the totals beside it.
    const series = reportSeries(all);
    expect(series.categories.length).toBe(all.series.length);
    expect(series.outcomes[0]?.values.reduce<number>((sum, value) => sum + (value ?? 0), 0)).toBe(
      2,
    );
  });

  it('12-13. drills from a report into the mission and the aircraft it names', async () => {
    const { current } = await session.reports(ALL);
    const row = current.missions.find((mission) => mission.id === ids.late);
    if (!row) throw new Error('the late mission is missing');

    // The report row is a projection of the mission's own record, not a copy with a life of its own.
    const record = session.mission(row.id);
    expect(row).toMatchObject({
      status: record.status,
      aircraftId: record.aircraftId,
      flightId: record.flightId,
      acceptanceRisk: record.acceptance?.risk.index,
      launchRisk: record.assessment?.risk.index,
      objectives: record.objectives.length,
      objectivesComplete: record.objectives.filter((o) => o.status === 'complete').length,
      summary: record.outcome?.summary,
    });
    expect(row.acceptanceRisk).not.toBeNull();
    // The mission's history is where the mission screen reads it from.
    const history = await loadMissionLog(row.id);
    expect(history.map((entry) => entry.type)).toEqual(
      expect.arrayContaining([
        'createMission',
        'acceptMission',
        'launchMission',
        'missionCompleted',
      ]),
    );
    // The mission that failed never launched: it has an acceptance record and no launch record.
    expect(current.missions.find((mission) => mission.id === ids.failed)).toMatchObject({
      status: 'failed',
      launchRisk: null,
      flightId: null,
    });
    expect(
      current.missions.find((mission) => mission.id === ids.failed)?.acceptanceRisk,
    ).not.toBeNull();

    // Every aircraft and flight a report names exists.
    const fleet = new Set(session.view().fleet.aircraft.map((aircraft) => aircraft.id));
    for (const flight of current.flights) {
      expect(fleet.has(flight.aircraftId)).toBe(true);
      expect(
        flight.missionId === null || current.missions.some((m) => m.id === flight.missionId),
      ).toBe(true);
    }
    expect(current.aircraft.map((each) => each.aircraft.id).sort()).toEqual([...fleet].sort());
  });

  it('14-15. reviews utilisation, availability and maintenance, before and after a visit', async () => {
    const before = (await session.reports(ALL)).current;
    const flown = before.aircraft.find((row) => row.aircraft.id === AIRCRAFT);
    // Two flown and completed; the one that missed its deadline was this aircraft's too.
    expect(flown).toMatchObject({ flights: 2, missionsCompleted: 2, missionsFailed: 1 });
    expect(flown?.time.byStatus.in_flight).toBe(session.aircraft().flightSecondsTotal);
    expect(flown?.utilisation).toBeGreaterThan(0);
    const dueRow = before.aircraft.find((row) => row.aircraft.id === due);
    expect(dueRow?.time.byStatus.maintenance_due).toBeGreaterThan(0);
    expect(dueRow?.availability).toBeLessThan(1);
    // Aircraft that did nothing were available throughout, and are not ranked for it.
    const idle = before.aircraft.filter((row) => row.flights === 0 && row.aircraft.id !== due);
    expect(idle.every((row) => row.availability === 1 && row.utilisation === 0)).toBe(true);
    expect(before.maintenance).toEqual([]);

    session.execute({ type: 'startMaintenance', aircraftId: due });
    session.runSim(HOUR);
    const during = (await session.reports(ALL)).current;
    expect(during.maintenanceUnderWay).toEqual([
      expect.objectContaining({ aircraftId: due, completedTick: null }),
    ]);
    expect(during.outlook.find((row) => row.aircraft.id === due)?.group).toBe('unavailable');

    session.runSim(MAINTENANCE.durationSeconds);
    const after = (await session.reports(ALL)).current;
    expect(after.maintenance).toHaveLength(1);
    expect(after.maintenance[0]).toMatchObject({ aircraftId: due });
    expect(after.totals.maintenanceSeconds).toBe(MAINTENANCE.durationSeconds);
    expect(after.outlook.find((row) => row.aircraft.id === due)?.group).toBe('healthy');
    expect(
      after.aircraft.find((row) => row.aircraft.id === due)?.time.byStatus.in_maintenance,
    ).toBe(MAINTENANCE.durationSeconds);
    expect(session.aircraft(due).status).toBe('available');
  });

  it('16. reviews events and what the weather did to the flights', async () => {
    const { current } = await session.reports(ALL);
    expect(current.events.length).toBeGreaterThan(0);
    expect(current.totals.eventsStarted).toBe(current.events.length);
    expect(current.events.some((event) => event.status === 'resolved')).toBe(true);
    // The finding that made the aircraft due ended when the aircraft was maintained.
    const finding = current.events.find(
      (event) => event.type === 'maintenance_finding' && event.aircraftId === due,
    );
    expect(finding).toMatchObject({ aircraftId: due, status: 'resolved' });
    expect(current.eventTypes.reduce((sum, type) => sum + type.events, 0)).toBe(
      current.events.length,
    );
    for (const type of current.eventTypes) expect(type.activeSeconds).toBeGreaterThan(0);

    // Both flights recorded what the weather cost against still air.
    expect(current.flights.every((flight) => flight.stillAirFuelUsedKg !== null)).toBe(true);
    expect(current.totals.weatherFuelKg).not.toBeNull();
    expect(current.flights.every((flight) => flight.worstSeverity !== null)).toBe(true);
  });

  it('17-18. exports CSV and JSON of what is on screen, and nothing else', async () => {
    const { current } = await session.reports(ALL);
    written.length = 0;

    const csv = await exportReport('missions', current, NO_FILTER, 'csv');
    expect(csv.fileName).toMatch(/^aegis-missions-20261004T1200Z-\d{8}T\d{4}Z\.csv$/);
    expect(written[0]?.contents).toBe(toCsv(reportTable('missions', current)));
    const lines = (written[0]?.contents ?? '').trimEnd().split('\r\n');
    expect(lines).toHaveLength(1 + current.missions.length);
    expect(lines.some((line) => line.startsWith(`${ids.late},`))).toBe(true);

    // Filtered on screen, filtered in the file.
    const failed = { ...NO_FILTER, missionStatus: 'failed' as const };
    await exportReport('missions', current, failed, 'json');
    const json = JSON.parse(written[1]?.contents ?? '{}') as {
      meta: { filter: unknown; rowCount: number; content: string; period: { fromUtc: string } };
      rows: { mission: string; outcome: string; risk_accepted: number | null }[];
    };
    expect(written[1]?.fileName.endsWith('.json')).toBe(true);
    expect(json.meta.filter).toEqual(failed);
    expect(json.meta.rowCount).toBe(1);
    expect(json.meta.content).toMatch(/Simulated data/);
    expect(json.meta.period.fromUtc).toBe('2026-10-04T12:00:00Z');
    expect(json.rows).toEqual([
      expect.objectContaining({ mission: ids.failed, outcome: 'failed' }),
    ]);
    expect(json.rows[0]?.risk_accepted).not.toBeNull();

    // A period narrows the export too.
    const { current: morning } = await session.reports({ fromTick: 0, toTick: 2 * HOUR });
    await exportReport('fuel', morning, NO_FILTER, 'csv');
    expect((written[2]?.contents ?? '').trimEnd().split('\r\n')).toHaveLength(2);

    // Every section exports, under a name the native side accepts, and holds no secrets or paths.
    for (const name of ['summary', 'fleet', 'fuel', 'maintenance', 'events'] as const) {
      await exportReport(name, current, NO_FILTER, 'csv');
      await exportReport(name, current, NO_FILTER, 'json');
    }
    for (const file of written) {
      expect(file.fileName).toMatch(/^[A-Za-z0-9._-]{1,120}$/);
      expect(file.contents.length).toBeGreaterThan(20);
      expect(file.contents).not.toMatch(
        /reports-scenario|aegis\.db|AppData|password|token|secret/i,
      );
    }
  });

  it('19-20. closes and reopens: the reports are exactly as they were', async () => {
    const before = await session.reports(ALL);
    const dayBefore = await session.reports(
      presetPeriod('last24h', session.view().clock.tick, session.view().epoch),
    );
    await session.runner.flush();
    session.database.close();

    session = await openSession();
    const after = await session.reports(ALL);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    const dayAfter = await session.reports(
      presetPeriod('last24h', session.view().clock.tick, session.view().epoch),
    );
    expect(JSON.stringify(dayAfter)).toBe(JSON.stringify(dayBefore));
    for (const name of ['summary', 'missions', 'fleet', 'fuel', 'maintenance', 'events'] as const) {
      expect(toCsv(reportTable(name, after.current))).toBe(
        toCsv(reportTable(name, before.current)),
      );
    }

    // The world carries on, and what was reported for the past stays as it was.
    const past: ReportPeriod = { fromTick: 0, toTick: session.view().clock.tick + 1 };
    const pastBefore = (await session.reports(past)).current;
    session.runSim(60);
    const again = session.create();
    session.execute({ type: 'acceptMission', missionId: again });
    session.execute({ type: 'launchMission', missionId: again });
    session.flyOut(again);
    const pastAfter = (await session.reports(past)).current;
    expect(pastAfter.totals).toEqual(pastBefore.totals);
    expect(toCsv(reportTable('missions', pastAfter))).toBe(
      toCsv(reportTable('missions', pastBefore)),
    );
    expect(toCsv(reportTable('fuel', pastAfter))).toBe(toCsv(reportTable('fuel', pastBefore)));
    expect((await session.reports(ALL)).current.totals.missionsCompleted).toBe(3);
  });

  it('21. the whole world is exactly what its seed and its log produce', async () => {
    await session.runner.flush();
    const saved = (await new SqliteWorldStore(session.database.db).load()) as Checkpoint;
    const log: LogEntry[] = (await loadRecentLog(1_000_000)).reverse();
    expect(log.map((entry) => entry.seq)).toEqual(log.map((_, index) => index + 1));
    expect(saved.snapshot.log.completeFromTick).toBe(0);

    const replayed = replayWorld(newWorld(), log, saved.snapshot.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(saved.snapshot));
    // Reading reports wrote nothing: the log holds only what the world and the player did.
    expect(log.some((entry) => /report|export/i.test(entry.type))).toBe(false);
  }, 120_000);
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorldStore } from '@aegis/db';
import { openNodeDatabase } from '@aegis/db/node';
import {
  MISSION_TEMPLATES,
  TICKS_PER_DAY,
  defaultBrief,
  fuelDuringTransfer,
  postFlightChecksS,
  reportTable,
  simInstant,
  toCsv,
  transferDurationS,
  type FuelTransfer,
  type Mission,
  type ReportPeriod,
} from '@aegis/domain';
import { importReferenceData } from '@aegis/ingest';
import {
  SimulationRunner,
  defaultConfiguration,
  planContextOf,
  replayComparable,
  replayWorld,
  type Checkpoint,
  type LogEntry,
  type SimCommand,
} from '@aegis/sim';
import { ManualHostClock } from '@aegis/sim/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalogue, starterOrders, type AerodromeRow } from '../fleet/catalogue';
import { fuelRequest, groundActivity, groundServiceView, launchState } from '../fleet/ground-logic';
import { readiness } from '../missions/mission-logic';
import { bindReferenceDb, loadAerodrome, loadAircraftTypes } from '../reference/queries';
import { currentPicture } from '../reports/report-logic';
import { bindReportDb, loadReports } from '../reports/report-service';
import { bindSimDb, loadMissionLog, loadRecentLog } from '../sim/log-queries';
import { FLIGHT_REFERENCE_INPUTS } from '../testing/flight-fixtures';

/*
 * Turnaround and refuelling end to end (ADR 0027), through the code the application runs: an
 * aircraft completes a mission and lands; it is not available; it is checked and then fuelled
 * for its next mission over simulated time; the application is closed in the middle of the
 * refuelling and reopened; the mission launches when the aircraft is ready and not a tick
 * before; the reports and the history say what happened; and the world is re-derived from its
 * seed and its log. Only the window is absent.
 */

const EPOCH = simInstant(Date.UTC(2026, 9, 4, 12, 0, 0));
const newWorld = () => ({ seed: 'turnaround-scenario', epoch: EPOCH });
/** The A400M at Newquay. */
const ATLAS = 'AEGIS-TR-001';
const ALL: ReportPeriod = { fromTick: 0, toTick: 400 * TICKS_PER_DAY };

describe('turnaround and refuelling: end-to-end scenario', { timeout: 120_000 }, () => {
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
      checkpointIntervalMs: 60_000,
    });
    const execute = (command: SimCommand) => {
      runner.execute(command);
    };
    const view = () => runner.view();
    const tick = () => view().clock.tick;
    /** Runs until the simulation clock reads `until`, at whatever speed is set. */
    const runTo = (until: number) => {
      for (let guard = 0; tick() < until; guard++) {
        if (guard > 1_000_000) throw new Error('the clock did not get there');
        host.elapse(100);
        runner.advance();
      }
    };
    const aircraft = () => {
      const found = view().fleet.aircraft.find((candidate) => candidate.id === ATLAS);
      if (!found) throw new Error('no aircraft');
      return found;
    };
    const mission = (id: string): Mission => {
      const found = view().missions.missions.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`no mission ${id}`);
      return found;
    };
    const create = (target: { name: string; lat: number; lon: number }): string => {
      const before = new Set(view().missions.missions.map((each) => each.id));
      execute({
        type: 'createMission',
        missionType: 'training',
        ...defaultConfiguration(
          'training',
          { ...defaultBrief(MISSION_TEMPLATES.training), target },
          aircraft(),
          { context: planContextOf(view()) },
        ),
      });
      const created = view().missions.missions.find((each) => !before.has(each.id));
      if (!created) throw new Error('the mission was not created');
      return created.id;
    };
    const reports = async () => {
      await runner.flush();
      const loaded = await loadReports(ALL, view().checkpoint.persistedSeq);
      if (!loaded) throw new Error('no world to report on');
      return loaded.current;
    };
    return {
      database,
      runner,
      host,
      execute,
      view,
      tick,
      runTo,
      aircraft,
      mission,
      create,
      reports,
    };
  }

  let session: Awaited<ReturnType<typeof openSession>>;
  const ids = { first: '', second: '' };
  /** What was known when the second mission was accepted, to hold the rest of the run to. */
  const expected = { landedTick: 0, checksEnd: 0, readyTick: 0, landedWithKg: 0, fuelKg: 0 };

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-turnaround-scenario-'));
    path = join(directory, 'aegis.db');
    const setup = openNodeDatabase(path);
    let now = 1_800_000_000_000;
    await importReferenceData(setup.db, FLIGHT_REFERENCE_INPUTS, { now: () => (now += 1000) });
    setup.close();
    session = await openSession();
    const { types, attributes } = await loadAircraftTypes();
    const homes = (
      await Promise.all(['EGPK', 'EGHQ'].map((icao) => loadAerodrome({ icao })))
    ).filter((row): row is NonNullable<typeof row> => row !== null) as AerodromeRow[];
    const { orders } = starterOrders(buildCatalogue(types, attributes), homes);
    session.execute({ type: 'setSpeed', speed: 100 });
    session.execute({ type: 'seedStarterFleet', aircraft: orders });
  });
  afterAll(() => {
    session.database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('1. an aircraft completes a mission', () => {
    ids.first = session.create({ name: 'Area 1', lat: 49.4, lon: -7.2 });
    session.execute({ type: 'acceptMission', missionId: ids.first });
    // A new aircraft has full tanks; the mission wants less. That takes time too.
    expect(session.aircraft().status).toBe('servicing');
    expect(groundActivity(session.aircraft())).toBe('Taking fuel off');
    const readyTick = session.aircraft().service?.transfer?.completeTick as number;
    session.runTo(readyTick);
    session.execute({ type: 'launchMission', missionId: ids.first });
    for (let i = 0; i < 400 && session.mission(ids.first).status === 'active'; i++) {
      session.runTo(session.tick() + 100);
    }
    expect(session.mission(ids.first)).toMatchObject({
      status: 'completed',
      outcome: { result: 'completed' },
    });
  });

  it('2-4. it lands, and is not available: a turnaround has begun', () => {
    const aircraft = session.aircraft();
    const flight = session.view().fleet.recentFlights[0];
    if (!flight || flight.arrivedTick === null) throw new Error('the flight should have landed');
    expected.landedTick = flight.arrivedTick;
    expected.landedWithKg = flight.progress.fuelKg;
    expected.checksEnd = flight.arrivedTick + postFlightChecksS(flight.progress.elapsedS);

    expect(aircraft).toMatchObject({
      status: 'servicing',
      fuelKg: expected.landedWithKg,
      service: {
        reason: 'turnaround',
        stage: 'checks',
        startedTick: expected.landedTick,
        checksCompleteTick: expected.checksEnd,
        targetFuelKg: null,
      },
    });
    expect(session.tick()).toBeLessThan(expected.checksEnd);
    // What the screens say, from the same record.
    expect(currentPicture(session.view())).toMatchObject({ available: 3, servicing: 1 });
    const shown = groundServiceView(aircraft, session.tick());
    expect(shown?.activity).toBe('Post-flight checks');
    expect(shown?.progress.completeTick).toBe(expected.checksEnd);
    expect(shown?.stop).toBeNull();
    expect(shown?.detail).toMatch(/Available in \d+ min, with the fuel it landed with\./);
    // The planner would be told the same thing the simulation says.
    const state = launchState(
      aircraft,
      { fuelKg: aircraft.fuelKg, origin: aircraft.location },
      session.tick(),
    );
    expect(state?.readiness.ready).toBe(false);
    expect(state?.readyTick).toBe(expected.checksEnd);
    expect(state?.issues[0]).toMatch(/is in its post-flight checks/);
  });

  it('5-7. its next mission is accepted: the fuel follows the checks, and loads over time', () => {
    // A long way out over the Atlantic and back: far more fuel than it landed with.
    ids.second = session.create({ name: 'Area 2', lat: 38, lon: -15 });
    expected.fuelKg = session.mission(ids.second).load?.fuelKg as number;
    expect(expected.fuelKg).toBeGreaterThan(expected.landedWithKg + 20_000);
    session.execute({ type: 'acceptMission', missionId: ids.second });

    const capacity = session.aircraft().performance?.fuelCapacityKg as number;
    expected.readyTick =
      expected.checksEnd + transferDurationS(capacity, expected.landedWithKg, expected.fuelKg);
    expect(session.aircraft().service).toMatchObject({
      reason: 'turnaround',
      stage: 'checks',
      targetFuelKg: expected.fuelKg,
      missionId: ids.second,
    });
    // The mission page: not ready, nothing for the operator to do, and when it will be.
    const waiting = readiness(session.mission(ids.second), session.aircraft(), session.tick());
    expect(waiting).toMatchObject({
      ready: false,
      readyTick: expected.readyTick,
      prepareFuelKg: null,
    });
    expect(() => {
      session.execute({ type: 'launchMission', missionId: ids.second });
    }).toThrow(/post-flight checks/);

    // Into the refuelling. Fuel rises toward what the mission departs with, and is exactly what
    // the transfer says it is at every tick looked at.
    session.runTo(expected.checksEnd + 400);
    const transfer = session.aircraft().service?.transfer as FuelTransfer;
    expect(session.aircraft().service?.stage).toBe('refuelling');
    expect(transfer).toMatchObject({
      startTick: expected.checksEnd,
      fromKg: expected.landedWithKg,
      toKg: expected.fuelKg,
      completeTick: expected.readyTick,
    });
    let last = expected.landedWithKg;
    for (let i = 0; i < 3; i++) {
      session.runTo(session.tick() + 100);
      const now = session.aircraft();
      expect(now.status).toBe('servicing');
      expect(now.fuelKg).toBeGreaterThan(last);
      expect(now.fuelKg).toBeLessThan(expected.fuelKg);
      expect(now.fuelKg).toBe(fuelDuringTransfer(transfer, session.tick()));
      last = now.fuelKg;
    }
    const shown = groundServiceView(session.aircraft(), session.tick());
    expect(shown?.activity).toBe('Refuelling');
    expect(shown?.progress).toMatchObject({
      targetFuelKg: expected.fuelKg,
      fuelRemainingKg: expected.fuelKg - last,
      remainingS: expected.readyTick - session.tick(),
      missionId: ids.second,
    });
    expect(shown?.stop?.label).toBe('Stop refuelling');
    // Asking for the fuel it is already being brought to is not offered.
    expect(fuelRequest(session.aircraft(), expected.fuelKg).allowed).toBe(false);
  });

  it('8. progress is the same at 1x: a second of real time is a tick, and a tick of fuel', () => {
    session.execute({ type: 'setSpeed', speed: 1 });
    const transfer = session.aircraft().service?.transfer as FuelTransfer;
    const from = session.tick();
    const fuelFrom = session.aircraft().fuelKg;
    for (let second = 1; second <= 5; second++) {
      for (let slice = 0; slice < 10; slice++) {
        session.host.elapse(100);
        session.runner.advance();
      }
      expect(session.tick()).toBe(from + second);
      expect(session.aircraft().fuelKg).toBe(fuelDuringTransfer(transfer, from + second));
    }
    expect(session.aircraft().fuelKg).toBe(fuelFrom + 5 * transfer.rateKgS);
    session.execute({ type: 'setSpeed', speed: 100 });
  });

  it('9-11. the application closes part-way through and reopens to exactly where it was', async () => {
    await session.runner.flush();
    const atClose = session.view();
    const closed = session.aircraft();
    expect(closed.status).toBe('servicing');
    expect(closed.fuelKg).toBeGreaterThan(expected.landedWithKg);
    expect(closed.fuelKg).toBeLessThan(expected.fuelKg);
    session.database.close();

    session = await openSession();
    const reopened = session.view();
    expect(reopened.clock).toEqual(atClose.clock);
    expect(reopened.fleet).toEqual(atClose.fleet);
    expect(reopened.missions).toEqual(atClose.missions);
    expect(reopened.integrityDigest).toBe(atClose.integrityDigest);
    // Not restarted, and not completed by being reopened: the same fuel, the same time to go.
    const resumed = session.aircraft();
    expect(resumed.fuelKg).toBe(closed.fuelKg);
    expect(resumed.service).toEqual(closed.service);
    expect(groundServiceView(resumed, session.tick())?.progress.remainingS).toBe(
      expected.readyTick - atClose.clock.tick,
    );
    expect(readiness(session.mission(ids.second), resumed, session.tick()).readyTick).toBe(
      expected.readyTick,
    );
  });

  it('12-16. it is ready at the tick it said, and the mission launches then and not before', () => {
    // To within a hundred seconds at 100x, then a second at a time.
    session.runTo(expected.readyTick - 100);
    session.execute({ type: 'setSpeed', speed: 1 });
    const launch = () => {
      session.execute({ type: 'launchMission', missionId: ids.second });
    };
    session.runTo(expected.readyTick - 1);
    expect(session.tick()).toBe(expected.readyTick - 1);
    expect(session.aircraft().status).toBe('servicing');
    expect(session.aircraft().fuelKg).toBeLessThan(expected.fuelKg);
    expect(readiness(session.mission(ids.second), session.aircraft(), session.tick()).ready).toBe(
      false,
    );
    expect(launch).toThrow(/AEGIS-TR-001 is being refuelled\. It will be available in 1 min\./);
    expect(session.mission(ids.second).status).toBe('accepted');

    session.runTo(expected.readyTick);
    expect(session.tick()).toBe(expected.readyTick);
    expect(session.aircraft()).toMatchObject({
      status: 'available',
      fuelKg: expected.fuelKg,
      service: null,
    });
    expect(
      readiness(session.mission(ids.second), session.aircraft(), session.tick()),
    ).toMatchObject({ ready: true, issues: [] });
    launch();
    expect(session.mission(ids.second)).toMatchObject({
      status: 'active',
      actualStartTick: expected.readyTick,
    });
    const flight = session.view().fleet.activeFlights[0];
    expect(flight).toMatchObject({ aircraftId: ATLAS, missionId: ids.second });
    expect(session.aircraft()).toMatchObject({ status: 'in_flight', fuelKg: expected.fuelKg });
    session.execute({ type: 'setSpeed', speed: 100 });
  });

  it('17. the reports show the delay and the fuel', async () => {
    const report = await session.reports();
    const turnaround = report.services.find((service) => service.reason === 'turnaround');
    expect(turnaround).toEqual({
      aircraftId: ATLAS,
      missionId: ids.second,
      reason: 'turnaround',
      startedTick: expected.landedTick,
      completedTick: expected.readyTick,
      durationS: expected.readyTick - expected.landedTick,
      checksS: expected.checksEnd - expected.landedTick,
      refuelS: expected.readyTick - expected.checksEnd,
      loadedKg: expected.fuelKg - expected.landedWithKg,
      fuelKg: expected.fuelKg,
    });
    const first = report.services.find((service) => service.reason === 'preparation');
    expect(first).toMatchObject({ missionId: ids.first, aircraftId: ATLAS });
    expect(first?.loadedKg).toBeLessThan(0);
    expect(report.totals).toMatchObject({
      services: 2,
      turnarounds: 1,
      turnaroundSeconds: expected.readyTick - expected.landedTick,
      refuellings: 2,
      fuelLoadedKg: expected.fuelKg - expected.landedWithKg,
      fuelRemovedKg: -(first?.loadedKg ?? 0),
      // Both missions waited for their aircraft.
      missionPreparations: 2,
      missionPreparationSeconds:
        (first?.durationS ?? 0) + (expected.readyTick - expected.checksEnd),
    });
    // Planned and actual are kept apart: the second mission is under way, and in no total.
    expect(report.totals.missionsCompleted).toBe(1);
    expect(report.inProgress.missions.map((mission) => mission.id)).toEqual([ids.second]);

    const row = report.aircraft.find((each) => each.aircraft.id === ATLAS);
    expect(row?.time.byStatus.servicing).toBe(report.totals.serviceSeconds);
    expect(row?.time.notRecordedS).toBe(0);
    expect(row).toMatchObject({
      services: 2,
      fuelLoadedKg: expected.fuelKg - expected.landedWithKg,
    });
    // Time on the ground being serviced is time it could not have been launched.
    expect(row?.availability).toBeLessThan(1);
    const csv = toCsv(reportTable('fleet', report));
    expect(csv).toContain('Being serviced (h)');
    expect(toCsv(reportTable('summary', report))).toContain('turnarounds');
  });

  it('18. the history holds the transitions that matter, and nothing per tick', async () => {
    const history = (await loadMissionLog(ids.second)).map((entry) => entry.type);
    expect(history).toEqual([
      'createMission',
      'acceptMission',
      'refuellingStarted',
      'refuellingCompleted',
      'servicingCompleted',
      'launchMission',
    ]);
    const log: LogEntry[] = (await loadRecentLog(1000)).reverse();
    const own = log.filter((entry) => entry.aircraftId === ATLAS).map((entry) => entry.type);
    const landed = own.indexOf('flightCompleted');
    expect(own.slice(landed, landed + 2)).toEqual(['flightCompleted', 'servicingStarted']);
    // Two services and two flights' worth of entries: progress is derived, not logged.
    expect(log.length).toBeLessThan(40);
    expect(
      log.find((entry) => entry.type === 'servicingStarted' && entry.tick === expected.landedTick),
    ).toMatchObject({ actor: 'world', payload: { reason: 'turnaround' } });
  });

  it('19. the whole world is exactly what its seed and its log produce', async () => {
    for (let i = 0; i < 400 && session.mission(ids.second).status === 'active'; i++) {
      session.runTo(session.tick() + 100);
    }
    await session.runner.flush();
    const saved = (await new SqliteWorldStore(session.database.db).load()) as Checkpoint;
    const log: LogEntry[] = (await loadRecentLog(1_000_000)).reverse();
    expect(log.map((entry) => entry.seq)).toEqual(log.map((_, index) => index + 1));
    const replayed = replayWorld(newWorld(), log, saved.snapshot.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(saved.snapshot));
  });
});

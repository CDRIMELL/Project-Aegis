import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorldStore } from '@aegis/db';
import { openNodeDatabase } from '@aegis/db/node';
import {
  MISSION_TEMPLATES,
  TICKS_PER_DAY,
  defaultBrief,
  generatePlan,
  reportTable,
  simInstant,
  toCsv,
  type Mission,
  type ReportPeriod,
  type RoutePoint,
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
import {
  aerodromePoint,
  buildCatalogue,
  starterOrders,
  type AerodromeRow,
} from '../fleet/catalogue';
import { aerodromeView, groundForecasts, groundServiceView } from '../fleet/ground-logic';
import { readiness } from '../missions/mission-logic';
import { bindReferenceDb, loadAerodrome, loadAircraftTypes } from '../reference/queries';
import { bindReportDb, loadReports } from '../reports/report-service';
import { bindSimDb, loadMissionLog, loadRecentLog } from '../sim/log-queries';
import { FLIGHT_REFERENCE_INPUTS } from '../testing/flight-fixtures';

/*
 * Finite ground resources end to end (ADR 0028), through the code the application runs: two
 * aircraft arrive at an aerodrome that can fuel one at a time; each is given a mission; one gets
 * the points and the other really waits, and is told why and for how long; payload and fuel go
 * aboard over simulated time; the application is closed in the middle and reopened; neither
 * launches before it is ready; the operator launches both; the reports and the history say what
 * happened; and the world is re-derived from its seed and its log. Only the window is absent.
 */

const EPOCH = simInstant(Date.UTC(2026, 9, 4, 12, 0, 0));
const newWorld = () => ({ seed: 'ground-resources-scenario', epoch: EPOCH });
const ATLAS = 'AEGIS-TR-001';
const HEAVY = 'AEGIS-TR-002';
const ALL: ReportPeriod = { fromTick: 0, toTick: 400 * TICKS_PER_DAY };

describe('finite ground resources: end-to-end scenario', { timeout: 180_000 }, () => {
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
    const fleet = () => view().fleet.aircraft;
    const runTo = (until: number) => {
      for (let guard = 0; tick() < until; guard++) {
        if (guard > 2_000_000) throw new Error('the clock did not get there');
        host.elapse(100);
        runner.advance();
      }
    };
    const aircraft = (id: string) => {
      const found = fleet().find((candidate) => candidate.id === id);
      if (!found) throw new Error(`no aircraft ${id}`);
      return found;
    };
    const mission = (id: string): Mission => {
      const found = view().missions.missions.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`no mission ${id}`);
      return found;
    };
    const forecast = (id: string) => {
      const found = groundForecasts(fleet(), tick()).get(id);
      if (!found) throw new Error(`${id} is not being serviced`);
      return found;
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
      fleet,
      runTo,
      aircraft,
      mission,
      forecast,
      reports,
    };
  }

  let session: Awaited<ReturnType<typeof openSession>>;
  let newquay: RoutePoint;
  let akrotiri: RoutePoint;
  /** The aircraft that landed first, and the one that landed second. */
  let first = '';
  let second = '';
  const missions = { first: '', second: '' };
  /** What the aerodrome said when both had been asked for, to hold the rest of the run to. */
  const said = { firstReady: 0, secondFuelTurn: 0, secondReady: 0, scheduled: 0 };

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-ground-resources-'));
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
    const [eghq, lcra] = await Promise.all(['EGHQ', 'LCRA'].map((icao) => loadAerodrome({ icao })));
    if (!eghq || !lcra) throw new Error('setup');
    newquay = aerodromePoint(eghq);
    akrotiri = aerodromePoint(lcra);
  });
  afterAll(() => {
    session.database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  /** A transport mission home from where the aircraft is, carrying a payload. */
  function homeward(id: string, payloadKg: number, plannedStartTick: number | null): string {
    const before = new Set(session.view().missions.missions.map((each) => each.id));
    session.execute({
      type: 'createMission',
      missionType: 'transport',
      ...defaultConfiguration(
        'transport',
        { ...defaultBrief(MISSION_TEMPLATES.transport), destination: newquay, payloadKg },
        session.aircraft(id),
        { context: planContextOf(session.view()), plannedStartTick },
      ),
    });
    const created = session.view().missions.missions.find((each) => !before.has(each.id));
    if (!created) throw new Error('the mission was not created');
    return created.id;
  }

  it('the aerodromes carry their sourced size class, and what is assumed from it', () => {
    // From the reference data, and only that: Newquay and Akrotiri are medium airports.
    expect(newquay.size).toBe('medium');
    expect(akrotiri.size).toBe('medium');
    expect(session.aircraft(ATLAS).location).toEqual(newquay);
    const view = aerodromeView(akrotiri, session.fleet(), session.tick());
    expect(view).toMatchObject({
      sizeLabel: 'Medium airport',
      capability: { servicing: true, fuelPoints: 1, handlingPoints: 1 },
      aircraft: [],
    });
    expect(view.statement).toMatch(/assumed from its size class alone/);
  });

  it('1-2. two aircraft arrive at the same aerodrome, and both are turned round', () => {
    for (const id of [ATLAS, HEAVY]) {
      const aircraft = session.aircraft(id);
      if (!aircraft.performance) throw new Error('setup');
      // With the fuel they have: nothing to load, so both leave at once.
      session.execute({
        type: 'launchFlight',
        aircraftId: id,
        plan: generatePlan(aircraft.performance, newquay, akrotiri),
        load: { fuelKg: aircraft.fuelKg, payloadKg: 0 },
      });
    }
    for (let i = 0; i < 400 && session.view().fleet.activeFlights.length > 0; i++) {
      session.runTo(session.tick() + 100);
    }
    const landed = [...session.view().fleet.recentFlights].sort(
      (a, b) => (a.arrivedTick ?? 0) - (b.arrivedTick ?? 0),
    );
    first = landed[0]?.aircraftId ?? '';
    second = landed[1]?.aircraftId ?? '';
    expect(new Set([first, second])).toEqual(new Set([ATLAS, HEAVY]));
    expect(session.aircraft(first).location).toEqual(akrotiri);
    expect(session.aircraft(second)).toMatchObject({ status: 'servicing', location: akrotiri });
    expect(
      aerodromeView(akrotiri, session.fleet(), session.tick()).aircraft.map((each) => each.id),
    ).toEqual([ATLAS, HEAVY]);
  });

  it('3-6. one gets the points, and the other really waits and is told why', () => {
    // Out of their checks, so that what follows is about the aerodrome and nothing else.
    for (let i = 0; i < 400 && session.fleet().some((each) => each.status === 'servicing'); i++) {
      session.runTo(session.tick() + 100);
    }
    said.scheduled = session.tick() + 900;
    missions.first = homeward(first, 9000, null);
    // Scheduled for a quarter of an hour from now: sooner than it can be ready.
    missions.second = homeward(second, 6000, said.scheduled);
    session.execute({ type: 'acceptMission', missionId: missions.first });
    session.execute({ type: 'acceptMission', missionId: missions.second });
    const asked = session.tick();

    const leading = session.forecast(first);
    const waiting = session.forecast(second);
    said.firstReady = leading.completeTick;
    said.secondFuelTurn = waiting.fuel?.startTick ?? 0;
    said.secondReady = waiting.completeTick;
    expect(leading.fuel).toMatchObject({ state: 'connecting', startTick: asked, position: null });
    expect(leading.payload).toMatchObject({ state: 'connecting', startTick: asked });
    // A real queue: second for fuel behind the first, and for payload handling too.
    expect(waiting.fuel).toMatchObject({
      state: 'waiting',
      position: 1,
      behind: first,
      startTick: leading.fuel?.completeTick,
    });
    expect(waiting.payload).toMatchObject({
      state: 'waiting',
      position: 1,
      behind: first,
      startTick: leading.payload?.completeTick,
    });
    expect(said.secondReady).toBeGreaterThan(said.firstReady);

    // What the screens say, from the same records.
    const shown = groundServiceView(session.aircraft(second), session.fleet(), session.tick());
    expect(shown?.activity).toBe(`Waiting for a fuel point, behind ${first}`);
    expect(shown?.tasks).toMatchObject([
      { label: 'Fuel', state: 'Waiting, next in the queue' },
      { label: 'Payload', state: 'Waiting, next in the queue' },
    ]);
    expect(shown?.tasks[0]?.detail).toContain(`The fuel point is in use by ${first}.`);
    const aerodrome = aerodromeView(akrotiri, session.fleet(), session.tick());
    expect(aerodrome.resources).toMatchObject([
      { kind: 'fuel', points: 1, inUseBy: [first], waiting: [second] },
      { kind: 'handling', points: 1, inUseBy: [first], waiting: [second] },
    ]);
    const page = readiness(
      session.mission(missions.second),
      session.aircraft(second),
      session.tick(),
      session.fleet(),
    );
    expect(page).toMatchObject({ ready: false, readyTick: said.secondReady, prepare: null });
    expect(page.lines.at(-1)).toEqual({
      label: 'Ground resource',
      value: `Fuel point in use by ${first}`,
      ok: false,
    });
    expect(() => {
      session.execute({ type: 'launchMission', missionId: missions.second });
    }).toThrow(new RegExp(`waiting for a fuel point, behind ${first}`));

    // No fake progress: while it waits, nothing aboard it changes.
    const fuelBefore = session.aircraft(second).fuelKg;
    session.runTo(asked + 400);
    expect(session.aircraft(second)).toMatchObject({ fuelKg: fuelBefore, payloadKg: 0 });
    expect(session.aircraft(first).payloadKg).toBeGreaterThan(0);
  });

  it('13-15. the application closes in the middle and reopens to the same queue', async () => {
    await session.runner.flush();
    const atClose = session.view();
    const forecasts = groundForecasts(atClose.fleet.aircraft, atClose.clock.tick);
    session.database.close();

    session = await openSession();
    const reopened = session.view();
    expect(reopened.clock).toEqual(atClose.clock);
    expect(reopened.fleet).toEqual(atClose.fleet);
    expect(reopened.missions).toEqual(atClose.missions);
    // Who holds each point, who waits, and every time to go: as they were.
    expect(groundForecasts(reopened.fleet.aircraft, reopened.clock.tick)).toEqual(forecasts);
    expect(session.forecast(second)).toMatchObject({ completeTick: said.secondReady });
    expect(aerodromeView(akrotiri, session.fleet(), session.tick()).resources[0]).toMatchObject({
      inUseBy: [first],
      waiting: [second],
    });
  });

  it('7-12. the first finishes, the point passes on at that tick, and the second proceeds', () => {
    session.runTo(said.secondFuelTurn - 100);
    session.execute({ type: 'setSpeed', speed: 1 });
    session.runTo(said.secondFuelTurn - 1);
    expect(session.aircraft(second).service?.fuel?.transfer).toBeNull();
    session.runTo(said.secondFuelTurn);
    expect(session.tick()).toBe(said.secondFuelTurn);
    expect(session.aircraft(second).service?.fuel?.transfer).toMatchObject({
      startTick: said.secondFuelTurn,
    });
    session.execute({ type: 'setSpeed', speed: 100 });

    // Fuel and payload go aboard over simulated time.
    const before = session.aircraft(second);
    session.runTo(Math.max(session.tick() + 600, said.scheduled + 10));
    const after = session.aircraft(second);
    // The scheduled time of the second mission has passed on the ground: recorded, not acted on.
    expect(session.tick()).toBeGreaterThan(said.scheduled);
    expect(session.tick()).toBeLessThan(said.secondReady);
    expect(session.mission(missions.second)).toMatchObject({
      status: 'accepted',
      actualStartTick: null,
    });
    expect(after.fuelKg).not.toBe(before.fuelKg);
    expect(after.payloadKg).toBeGreaterThan(before.payloadKg);
    expect(after.payloadKg).toBeLessThanOrEqual(6000);
  });

  it('16-18. both become ready when they were said to, and launch then and not before', () => {
    session.runTo(said.secondReady - 100);
    session.execute({ type: 'setSpeed', speed: 1 });
    session.runTo(said.secondReady - 1);
    const launch = (missionId: string) => () => {
      session.execute({ type: 'launchMission', missionId });
    };
    expect(session.aircraft(second).status).toBe('servicing');
    expect(launch(missions.second)).toThrow(/It will be available in 1 min/);
    session.runTo(said.secondReady);
    expect(session.tick()).toBe(said.secondReady);
    for (const [id, missionId] of [
      [first, missions.first],
      [second, missions.second],
    ] as const) {
      const load = session.mission(missionId).load;
      expect(session.aircraft(id)).toMatchObject({
        status: 'available',
        service: null,
        fuelKg: load?.fuelKg,
        payloadKg: load?.payloadKg,
      });
      // Ready, and still on the ground: nothing launches by itself.
      expect(session.mission(missionId).status).toBe('accepted');
      expect(
        readiness(session.mission(missionId), session.aircraft(id), session.tick(), session.fleet())
          .ready,
      ).toBe(true);
    }
    launch(missions.first)();
    launch(missions.second)();
    expect(session.mission(missions.second)).toMatchObject({
      status: 'active',
      plannedStartTick: said.scheduled,
      actualStartTick: said.secondReady,
    });
    expect(
      session
        .view()
        .fleet.activeFlights.map((flight) => flight.payloadKg)
        .sort(),
    ).toEqual([6000, 9000]);
    session.execute({ type: 'setSpeed', speed: 100 });
  });

  it('19. the reports record the preparation, the wait and the delay', async () => {
    for (
      let i = 0;
      i < 600 &&
      [missions.first, missions.second].some((id) => session.mission(id).status === 'active');
      i++
    ) {
      session.runTo(session.tick() + 100);
    }
    const report = await session.reports();
    const forSecond = report.services.find((service) => service.missionId === missions.second);
    const forFirst = report.services.find((service) => service.missionId === missions.first);
    expect(forFirst).toMatchObject({
      reason: 'preparation',
      waitS: 0,
      payloadLoadedKg: 9000,
      at: 'LCRA',
    });
    expect(forSecond).toMatchObject({
      reason: 'preparation',
      aircraftId: second,
      payloadLoadedKg: 6000,
      completedTick: said.secondReady,
      at: 'LCRA',
    });
    // It waited for both points; the time is what the queue said it would be.
    expect(forSecond?.waitS).toBeGreaterThan(0);
    expect(report.totals).toMatchObject({
      servicesQueued: 1,
      resourceWaitSeconds: forSecond?.waitS,
      payloadLoadedKg: 15_000,
      launchesScheduled: 1,
      launchesLate: 1,
      launchDelaySeconds: said.secondReady - said.scheduled,
    });
    expect(report.totals.payloadSeconds).toBeGreaterThan(0);
    const here = report.aerodromes.find((each) => each.at === 'LCRA');
    expect(here).toMatchObject({ servicesQueued: 1, payloadLoadedKg: 15_000 });
    expect(here?.services).toBeGreaterThanOrEqual(4);
    const summary = toCsv(reportTable('summary', report));
    expect(summary).toContain('resource_wait_hours');
    expect(summary).toContain('launches_late');
  });

  it('20. the history holds each transition, in order, and nothing per tick', async () => {
    const history = (await loadMissionLog(missions.second)).map((entry) => entry.type);
    expect(history.slice(0, 2)).toEqual(['createMission', 'acceptMission']);
    const order = [
      'servicingStarted',
      'serviceQueued',
      'refuellingStarted',
      'servicingCompleted',
      'launchMission',
    ].map((type) => history.indexOf(type));
    expect(order.every((index) => index > 1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The scheduled time passed while it was being prepared, before it was ready.
    expect(history.indexOf('launchDelayed')).toBeGreaterThan(history.indexOf('serviceQueued'));
    expect(history.indexOf('launchDelayed')).toBeLessThan(history.indexOf('servicingCompleted'));
    expect(history.filter((type) => type === 'serviceQueued')).toHaveLength(2);
    expect(history.filter((type) => type === 'launchDelayed')).toHaveLength(1);
    expect(history).toEqual(expect.arrayContaining(['loadingStarted', 'loadingCompleted']));
    const delayed = (await loadMissionLog(missions.second)).find(
      (entry) => entry.type === 'launchDelayed',
    );
    expect(delayed).toMatchObject({ tick: said.scheduled, actor: 'world' });
    expect(delayed?.payload.reason).toMatch(
      /waiting for|being refuelled|having fuel taken off|being loaded/,
    );
    // The first mission waited for nothing.
    expect((await loadMissionLog(missions.first)).map((entry) => entry.type)).not.toContain(
      'serviceQueued',
    );
    expect((await loadRecentLog(10_000)).length).toBeLessThan(120);
  });

  it('21. the whole world is exactly what its seed and its log produce', async () => {
    await session.runner.flush();
    const saved = (await new SqliteWorldStore(session.database.db).load()) as Checkpoint;
    const log: LogEntry[] = (await loadRecentLog(1_000_000)).reverse();
    expect(log.map((entry) => entry.seq)).toEqual(log.map((_, index) => index + 1));
    const replayed = replayWorld(newWorld(), log, saved.snapshot.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(saved.snapshot));
  });
});

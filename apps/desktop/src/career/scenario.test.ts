import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorldStore } from '@aegis/db';
import { openNodeDatabase } from '@aegis/db/node';
import { careerTotals, simInstant, type CareerDay } from '@aegis/domain';
import { importReferenceData } from '@aegis/ingest';
import {
  SimulationRunner,
  replayComparable,
  replayWorld,
  type Checkpoint,
  type LogEntry,
  type SimCommand,
} from '@aegis/sim';
import { ManualHostClock } from '@aegis/sim/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CAREER_FLEET, buildCatalogue, starterOrders } from '../fleet/catalogue';
import { chooseOperatingArea, fleetCentre } from '../missions/operating-area';
import {
  bindReferenceDb,
  loadAerodrome,
  loadAircraftTypes,
  loadLargeAerodromes,
} from '../reference/queries';
import { bindSimDb, loadLogBetween, loadRecentLog } from '../sim/log-queries';
import { FLIGHT_REFERENCE_INPUTS } from '../testing/flight-fixtures';
import { careerEpochMs, dailyBrief, preludeSteps } from './brief-logic';
import {
  DAY_LOG_TYPES,
  careerRecord,
  dayEntries,
  notableEntries,
  recordChanges,
  totalsBefore,
} from './career-logic';

/*
 * A career end to end (ADR 0030, ADR 0031), through the code the application runs: no world
 * until one is asked for; a new career with the fleet and area the application gives it; the
 * hours before command; the briefing read from the world; command taken; days ended and summed;
 * the application closed and reopened; and the whole re-derived from its seed and its log. Only
 * the window and the worker's message passing are absent.
 */

const HOUR = 3600;
const SEED = 'career-scenario';
const EPOCH = careerEpochMs(Date.UTC(2026, 9, 7, 14, 23, 5));
const PRELUDE = preludeSteps(SEED);
const newWorld = () => ({ seed: SEED, epoch: simInstant(EPOCH) });

describe('a career: end-to-end scenario', { timeout: 300_000 }, () => {
  let directory: string;
  let path: string;

  function openDatabase() {
    const database = openNodeDatabase(path);
    bindReferenceDb(database.db);
    bindSimDb(database.db);
    return database;
  }
  function drive(runner: SimulationRunner, host: ManualHostClock) {
    const execute = (command: SimCommand) => {
      runner.execute(command);
    };
    const view = () => runner.view();
    /** Runs the world as the player would, in command at 100x. */
    const run = (simSeconds: number) => {
      const until = view().clock.tick + simSeconds;
      for (let guard = 0; view().clock.tick < until; guard++) {
        if (guard > 2_000_000) throw new Error('the clock did not get there');
        host.elapse(100);
        runner.advance();
      }
    };
    return { runner, execute, view, run };
  }

  let database: ReturnType<typeof openDatabase>;
  let session: ReturnType<typeof drive>;
  const host = new ManualHostClock();

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-career-scenario-'));
    path = join(directory, 'aegis.db');
    const setup = openNodeDatabase(path);
    let now = 1_800_000_000_000;
    await importReferenceData(setup.db, FLIGHT_REFERENCE_INPUTS, { now: () => (now += 1000) });
    setup.close();
    database = openDatabase();
  });
  afterAll(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('opens at the menu with nothing saved, and creates nothing by looking', async () => {
    const store = new SqliteWorldStore(database.db);
    expect(await SimulationRunner.load({ store, host })).toBeNull();
    expect(
      database.transport.connection.prepare('SELECT count(*) AS n FROM sim_world').get(),
    ).toEqual({ n: 0 });
  });

  it('a new career is a new world, given its fleet and its operating area', async () => {
    const store = new SqliteWorldStore(database.db);
    session = drive(await SimulationRunner.create({ store, host, newWorld }), host);
    expect(session.view()).toMatchObject({
      seed: SEED,
      epoch: Date.UTC(2026, 9, 7),
      clock: { tick: 0 },
      career: { establishedTick: null, day: null },
    });

    // The fleet service: the career fleet, from the reference data, less what it lacks.
    const { types, attributes } = await loadAircraftTypes();
    const codes = [...new Set(CAREER_FLEET.map((entry) => entry.homeIcao))];
    const homes = (await Promise.all(codes.map((icao) => loadAerodrome({ icao })))).filter(
      (row): row is NonNullable<typeof row> => row !== null,
    );
    const { orders, missing } = starterOrders(
      buildCatalogue(types, attributes),
      homes,
      CAREER_FLEET,
    );
    // This test's reference data is small: what it lacks is reported, never substituted.
    expect(missing).toEqual(
      expect.arrayContaining([
        'aerodrome EGNT',
        'aircraft type "hawk-t2"',
        'aircraft type "chinook"',
      ]),
    );
    expect(orders.map((order) => `${order.typeName} @ ${order.home.code ?? ''}`)).toEqual([
      'Eurofighter Typhoon @ EGPK',
      'Eurofighter Typhoon @ EGPK',
      'Airbus A400M Atlas @ EGHQ',
      'Airbus A400M Atlas @ EGHQ',
      'Boeing C-17 Globemaster III @ EGHQ',
    ]);
    session.execute({ type: 'seedStarterFleet', aircraft: orders });

    // The mission service: the operating area, around the fleet's homes.
    const fleetHomes = session.view().fleet.aircraft.map((aircraft) => aircraft.home);
    const centre = fleetCentre(fleetHomes);
    if (!centre) throw new Error('setup');
    const places = chooseOperatingArea(await loadLargeAerodromes(), fleetHomes);
    expect(places.length).toBeGreaterThan(2);
    session.execute({ type: 'setOperatingArea', places, centre });
    // Every aerodrome arrives with the size class the reference data holds.
    expect(
      session.view().fleet.aircraft.every((aircraft) => aircraft.home.size !== undefined),
    ).toBe(true);
  });

  it('runs the hours before command, and has a past when the commander arrives', async () => {
    session.execute({ type: 'pause' });
    session.execute({ type: 'beginCareer' });
    session.runner.fastForward(PRELUDE);
    await session.runner.flush();
    const view = session.view();
    expect(view.clock).toMatchObject({ tick: PRELUDE, running: false });
    expect(view.missions.routineEnabled).toBe(true);
    expect(view.career).toMatchObject({ establishedTick: 0, day: null, closedDays: 0 });
    // The world has been operating: flights have been flown and missions have ended.
    expect(view.fleet.recentFlights.length + view.fleet.activeFlights.length).toBeGreaterThan(0);
    const routine = view.missions.missions.filter((mission) => mission.routine);
    expect(routine.length).toBeGreaterThan(1);
    expect(routine.some((mission) => mission.status === 'completed')).toBe(true);
    // None of it is yet the commander's record.
    expect(view.career.totals).toMatchObject({ days: 0, counters: {} });
  });

  it('the daily brief is the world at that moment, and nothing else', () => {
    const view = session.view();
    const brief = dailyBrief(view);
    const expected = new Date(EPOCH + PRELUDE * 1000);
    expect(brief).toMatchObject({
      day: null,
      resuming: false,
      weekday: 'Wednesday',
      date: '2026-10-07',
      time: expected.toISOString().slice(11, 16),
    });
    expect(brief.time >= '06:00' && brief.time < '06:45').toBe(true);
    const aircraft = view.fleet.aircraft;
    const count = (status: string) => aircraft.filter((each) => each.status === status).length;
    expect(brief.air).toMatchObject({
      owned: 5,
      available: count('available'),
      airborne: count('in_flight'),
      servicing: count('servicing'),
      ready: count('available') + count('in_flight'),
      activeMissions: view.missions.missions.filter((mission) => mission.status === 'active')
        .length,
    });
    expect(brief.air.airborne).toBe(view.fleet.activeFlights.length);
    expect(
      brief.air.available + brief.air.airborne + brief.air.servicing + brief.air.unavailable,
    ).toBe(5);
    expect(['Benign', 'Unsettled', 'Poor', 'Severe']).toContain(brief.air.weather);
    // Every priority and watch item points at something that exists.
    for (const item of [...brief.priorities, ...brief.watch]) {
      expect(item.title.length).toBeGreaterThan(0);
      const id = item.route?.split('/')[2];
      if (item.route?.startsWith('/missions/')) {
        expect(view.missions.missions.some((mission) => mission.id === id)).toBe(true);
      }
      if (item.route?.startsWith('/fleet/')) {
        expect(aircraft.some((each) => each.id === id)).toBe(true);
      }
    }
    expect(brief.note).toMatch(/intervention|decision|waiting/);
    // The same world gives the same brief.
    expect(dailyBrief(session.view())).toEqual(brief);
  });

  it('command is taken: Day 1 opens, the clock starts, and the world goes on without turns', () => {
    session.execute({ type: 'takeCommand' });
    session.runner.resync();
    session.execute({ type: 'setSpeed', speed: 100 });
    session.execute({ type: 'resume' });
    expect(session.view().career.day).toMatchObject({ number: 1, startedTick: PRELUDE });
    expect(dailyBrief(session.view())).toMatchObject({ day: 1, resuming: false });
    // An odd length of time, not a turn: the clock is continuous.
    session.run(5 * HOUR + 1234);
    const view = session.view();
    expect(view.clock.tick).toBeGreaterThanOrEqual(PRELUDE + 5 * HOUR + 1234);
    expect(dailyBrief(view)).toMatchObject({ day: 1, resuming: true });
    expect(view.career.day?.counters['flights.completed']).toBeGreaterThan(0);
    expect(view.career.totals.days).toBe(1);
  });

  let firstDay: CareerDay;

  it('the day is ended: it is summed up, and the next opens at the same tick', async () => {
    // An order of the commander's, so that the day holds one.
    const spare = session.view().fleet.aircraft.find((aircraft) => aircraft.status === 'available');
    if (spare) {
      session.execute({ type: 'serviceAircraft', aircraftId: spare.id, fuelKg: spare.fuelKg / 2 });
    }
    session.execute({ type: 'endCommandDay' });
    session.execute({ type: 'pause' });
    await session.runner.flush();
    const view = session.view();
    const closed = view.career.recentDays.at(-1);
    if (!closed) throw new Error('no day closed');
    firstDay = closed;
    expect(closed).toMatchObject({ number: 1, startedTick: PRELUDE, endedTick: view.clock.tick });
    expect(view.career.day).toMatchObject({
      number: 2,
      startedTick: view.clock.tick,
      counters: {},
    });

    // The summary: what stood out, read from the log between the day's own bounds.
    const entries = dayEntries(
      await loadLogBetween(closed.startedTick, closed.endedTick ?? 0, DAY_LOG_TYPES),
      closed,
    );
    expect(entries.every((entry) => entry.tick >= PRELUDE)).toBe(true);
    expect(entries.some((entry) => entry.type === 'endCommandDay')).toBe(false);
    const notable = notableEntries(entries);
    if (spare) {
      expect(notable.filter((entry) => entry.kind === 'order')).toHaveLength(0);
      expect(closed.counters['orders.servicing']).toBe(1);
    }
    // The career totals, before the day and after it.
    const totals = view.career.closedTotals;
    expect(totals.counters).toEqual(closed.counters);
    const changes = recordChanges(totalsBefore(totals, closed.counters), totals.counters);
    expect(changes.length).toBeGreaterThan(2);
    expect(changes.every((change) => change.before === 0 && change.after > 0)).toBe(true);
    expect(changes.map((change) => change.label)).toContain('Flights completed');
  });

  it('the application closes between days and reopens to the same career', async () => {
    await session.runner.flush();
    const atClose = session.view();
    database.close();
    database = openDatabase();
    const reopened = await SimulationRunner.load({
      store: new SqliteWorldStore(database.db),
      host,
    });
    if (!reopened) throw new Error('the career was not found');
    session = drive(reopened, host);
    // Nothing runs behind the menu, however long the application sat there.
    host.elapse(7_200_000);
    session.runner.resync();
    session.runner.advance();
    const view = session.view();
    expect(view.clock).toEqual(atClose.clock);
    expect(view.career).toEqual(atClose.career);
    expect(view.fleet).toEqual(atClose.fleet);
    expect(view.missions).toEqual(atClose.missions);
    // The brief of the new day is of the world where the last one ended.
    expect(dailyBrief(view)).toMatchObject({ day: 2, resuming: false });
  });

  it('a second day adds to the record, and resets nothing in it', async () => {
    session.execute({ type: 'resume' });
    session.run(4 * HOUR);
    // Closed and reopened in the middle of a day, too.
    await session.runner.flush();
    const mid = session.view();
    database.close();
    database = openDatabase();
    const reopened = await SimulationRunner.load({
      store: new SqliteWorldStore(database.db),
      host,
    });
    if (!reopened) throw new Error('the career was not found');
    session = drive(reopened, host);
    session.runner.resync();
    expect(session.view().career).toEqual(mid.career);
    expect(dailyBrief(session.view())).toMatchObject({ day: 2, resuming: true });

    session.run(3 * HOUR);
    session.execute({ type: 'endCommandDay' });
    await session.runner.flush();
    const view = session.view();
    expect(view.career.recentDays.map((day) => day.number)).toEqual([1, 2]);
    expect(view.career.recentDays[0]).toEqual(firstDay);
    expect(view.career.day?.number).toBe(3);
    const [first, second] = view.career.recentDays;
    if (!first || !second) throw new Error('setup');
    expect(view.career.closedTotals).toEqual(careerTotals([first, second], view.clock.tick));
    expect(view.career.closedTotals.counters['flights.completed']).toBe(
      (first.counters['flights.completed'] ?? 0) + (second.counters['flights.completed'] ?? 0),
    );
    // Every figure of the record is at least what it was after the first day.
    const before = careerRecord(first.counters).flatMap((group) => group.rows);
    const after = careerRecord(view.career.closedTotals.counters).flatMap((group) => group.rows);
    after.forEach((row, index) => {
      expect(row.value, row.label).toBeGreaterThanOrEqual(before[index]?.value ?? 0);
    });
    // And what is on disk is the same record.
    const rows = database.transport.connection
      .prepare('SELECT number, ended_tick, counters FROM sim_career_day ORDER BY number')
      .all() as { number: number; ended_tick: number | null; counters: string }[];
    expect(rows.map((row) => [row.number, row.ended_tick === null])).toEqual([
      [1, false],
      [2, false],
      [3, true],
    ]);
    expect(JSON.parse(rows[0]?.counters ?? '')).toEqual(first.counters);
  });

  it('the whole career is exactly what its seed and its log produce', async () => {
    await session.runner.flush();
    const saved = (await new SqliteWorldStore(database.db).load()) as Checkpoint;
    const log: LogEntry[] = (await loadRecentLog(1_000_000)).reverse();
    expect(log.map((entry) => entry.seq)).toEqual(log.map((_, index) => index + 1));
    expect(log.map((entry) => entry.type)).toEqual(
      expect.arrayContaining([
        'beginCareer',
        'routineTasked',
        'missionLaunched',
        'takeCommand',
        'endCommandDay',
      ]),
    );
    const replayed = replayWorld(newWorld(), log, saved.snapshot.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(saved.snapshot));
    expect(replayed.snapshot().career).toEqual(saved.snapshot.career);
  });

  it('a new career replaces it whole, and reference data is untouched', async () => {
    const reference = database.transport.connection
      .prepare('SELECT count(*) AS n FROM ref_location')
      .get();
    const store = new SqliteWorldStore(database.db);
    const next = await SimulationRunner.create({
      store,
      host,
      newWorld: () => ({ seed: 'the-next-career', epoch: simInstant(EPOCH) }),
    });
    expect(next.view()).toMatchObject({
      seed: 'the-next-career',
      clock: { tick: 0 },
      logLength: 0,
      career: { establishedTick: null, day: null, closedDays: 0 },
    });
    expect(next.view().fleet.aircraft).toEqual([]);
    const connection = database.transport.connection;
    expect(connection.prepare('SELECT count(*) AS n FROM sim_career_day').get()).toEqual({ n: 0 });
    expect(connection.prepare('SELECT count(*) AS n FROM sim_log').get()).toEqual({ n: 0 });
    expect(connection.prepare('SELECT count(*) AS n FROM ref_location').get()).toEqual(reference);
  });
});

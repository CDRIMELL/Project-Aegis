import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorldStore } from '@aegis/db';
import { openNodeDatabase } from '@aegis/db/node';
import {
  MISSION_TEMPLATES,
  NO_FILTER,
  TICKS_PER_DAY,
  aerodromeCapability,
  defaultBrief,
  fuelDuringTransfer,
  payloadDurationS,
  reportTable,
  simInstant,
  toCsv,
  type Mission,
  type ReportPeriod,
  type RoutePoint,
  type Transfer,
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
import {
  aerodromeView,
  groundForecasts,
  groundServiceView,
  knownAerodromes,
  unclassifiedAerodromes,
} from '../fleet/ground-logic';
import {
  bindReferenceDb,
  loadAerodrome,
  loadAerodromeSizes,
  loadAircraftTypes,
} from '../reference/queries';
import { bindReportDb, loadReports } from '../reports/report-service';
import { bindSimDb, loadMissionLog, loadRecentLog } from '../sim/log-queries';
import { FLIGHT_REFERENCE_INPUTS } from '../testing/flight-fixtures';

/*
 * Phase 8D end to end (ADR 0029), through the code the application runs: a world whose
 * aerodromes carry no size class is given the classes the reference data holds; a delivery is
 * flown, and its payload is taken off by the turnaround over simulated time; the application is
 * closed in the middle of the unloading and reopened; the services are exported; and the world
 * is re-derived from its seed and its log. Only the window is absent.
 */

const EPOCH = simInstant(Date.UTC(2026, 9, 4, 12, 0, 0));
const newWorld = () => ({ seed: 'delivery-scenario', epoch: EPOCH });
const ATLAS = 'AEGIS-TR-001';
const ALL: ReportPeriod = { fromTick: 0, toTick: 400 * TICKS_PER_DAY };
/** A point as a world from before the class was kept holds it. */
const unclassed = (point: RoutePoint): RoutePoint =>
  Object.fromEntries(Object.entries(point).filter(([key]) => key !== 'size')) as RoutePoint;

describe('aerodrome classes and timed unloading: end-to-end scenario', { timeout: 180_000 }, () => {
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
    const runTo = (until: number) => {
      for (let guard = 0; tick() < until; guard++) {
        if (guard > 2_000_000) throw new Error('the clock did not get there');
        host.elapse(100);
        runner.advance();
      }
    };
    const aircraft = (id = ATLAS) => {
      const found = view().fleet.aircraft.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`no aircraft ${id}`);
      return found;
    };
    const mission = (id: string): Mission => {
      const found = view().missions.missions.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`no mission ${id}`);
      return found;
    };
    const reports = async () => {
      await runner.flush();
      const loaded = await loadReports(ALL, view().checkpoint.persistedSeq);
      if (!loaded) throw new Error('no world to report on');
      return loaded.current;
    };
    return { database, runner, host, execute, view, tick, runTo, aircraft, mission, reports };
  }

  let session: Awaited<ReturnType<typeof openSession>>;
  let newquay: RoutePoint;
  let akrotiri: RoutePoint;
  let delivery = '';
  const said = { landed: 0, checksEnd: 0, ready: 0 };

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-delivery-scenario-'));
    path = join(directory, 'aegis.db');
    const setup = openNodeDatabase(path);
    let now = 1_800_000_000_000;
    await importReferenceData(setup.db, FLIGHT_REFERENCE_INPUTS, { now: () => (now += 1000) });
    setup.close();
    session = await openSession();
    const [eghq, lcra] = await Promise.all(['EGHQ', 'LCRA'].map((icao) => loadAerodrome({ icao })));
    if (!eghq || !lcra) throw new Error('setup');
    newquay = aerodromePoint(eghq);
    akrotiri = aerodromePoint(lcra);
  });
  afterAll(() => {
    session.database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('a world from before the class was kept holds aerodromes with none', async () => {
    const { types, attributes } = await loadAircraftTypes();
    const homes = (
      await Promise.all(['EGPK', 'EGHQ'].map((icao) => loadAerodrome({ icao })))
    ).filter((row): row is NonNullable<typeof row> => row !== null) as AerodromeRow[];
    const { orders } = starterOrders(buildCatalogue(types, attributes), homes);
    session.execute({ type: 'setSpeed', speed: 100 });
    // As such a world was: bases and operating area copied without their class, and one place
    // the reference data does not hold at all.
    session.execute({
      type: 'seedStarterFleet',
      aircraft: orders.map((order) => ({ ...order, home: unclassed(order.home) })),
    });
    session.execute({
      type: 'setOperatingArea',
      places: [
        unclassed(newquay),
        unclassed(akrotiri),
        { ...unclassed(akrotiri), refId: 'elsewhere:1', name: 'A private strip', code: 'ZZZZ' },
      ],
    });
    expect(unclassifiedAerodromes(session.view())).toEqual(
      [newquay.refId, akrotiri.refId, session.aircraft('AEGIS-FT-001').home.refId, 'elsewhere:1']
        .map(String)
        .sort(),
    );
    // Until it is told otherwise, the simulation treats each as medium.
    expect(aerodromeCapability(session.aircraft('AEGIS-FT-001').location)).toMatchObject({
      size: null,
      fuelPoints: 1,
    });
  });

  it('is given the classes the packaged reference data holds, and no others', async () => {
    const pending = unclassifiedAerodromes(session.view());
    const sizes = await loadAerodromeSizes(pending);
    // What the reference data says of each: Prestwick large, Newquay and Akrotiri medium.
    expect(sizes).toEqual({
      [String(session.aircraft('AEGIS-FT-001').home.refId)]: 'large',
      [String(newquay.refId)]: 'medium',
      [String(akrotiri.refId)]: 'medium',
    });
    const lengthBefore = session.view().logLength;
    session.execute({ type: 'classifyAerodromes', sizes });
    expect(session.view().logLength).toBe(lengthBefore + 1);

    expect(session.aircraft().home).toEqual(newquay);
    expect(session.aircraft().location).toEqual(newquay);
    expect(session.aircraft('AEGIS-FT-001').location?.size).toBe('large');
    expect(aerodromeCapability(session.aircraft('AEGIS-FT-001').location)).toMatchObject({
      size: 'large',
      fuelPoints: 2,
    });
    expect(session.view().missions.places.map((place) => [place.code, place.size])).toEqual([
      ['EGHQ', 'medium'],
      ['LCRA', 'medium'],
      // Not in the reference data: no class is invented for it.
      ['ZZZZ', undefined],
    ]);
    expect(unclassifiedAerodromes(session.view())).toEqual(['elsewhere:1']);
    // Asked again, there is nothing to do, and nothing is logged.
    const logLength = session.view().logLength;
    session.execute({ type: 'classifyAerodromes', sizes });
    session.execute({
      type: 'classifyAerodromes',
      sizes: await loadAerodromeSizes(['elsewhere:1']),
    });
    expect(session.view().logLength).toBe(logLength);

    // Kept through a close and a reopen, column and JSON both.
    await session.runner.flush();
    const atClose = session.view();
    session.database.close();
    session = await openSession();
    expect(session.view().fleet).toEqual(atClose.fleet);
    expect(session.view().missions.places).toEqual(atClose.missions.places);
    expect(
      session.database.transport.connection
        .prepare('SELECT code, size FROM sim_place ORDER BY ordinal')
        .all(),
    ).toEqual([
      { code: 'EGHQ', size: 'medium' },
      { code: 'LCRA', size: 'medium' },
      { code: 'ZZZZ', size: null },
    ]);
    const recorded = (await loadRecentLog(10)).find((entry) => entry.type === 'classifyAerodromes');
    expect(recorded).toMatchObject({ kind: 'command', actor: 'system', payload: { sizes } });
  });

  it('a delivery lands, the mission completes, and the payload is still to come off', () => {
    const before = new Set(session.view().missions.missions.map((each) => each.id));
    session.execute({
      type: 'createMission',
      missionType: 'logistics',
      ...defaultConfiguration(
        'logistics',
        { ...defaultBrief(MISSION_TEMPLATES.logistics), destination: akrotiri, payloadKg: 8000 },
        session.aircraft(),
        { context: planContextOf(session.view()) },
      ),
    });
    delivery = session.view().missions.missions.find((each) => !before.has(each.id))?.id ?? '';
    session.execute({ type: 'acceptMission', missionId: delivery });
    session.runTo(
      groundForecasts(session.view().fleet.aircraft, session.tick()).get(ATLAS)?.completeTick ?? 0,
    );
    expect(session.aircraft()).toMatchObject({ status: 'available', payloadKg: 8000 });
    session.execute({ type: 'launchMission', missionId: delivery });
    for (let i = 0; i < 600 && session.aircraft().activeFlightId !== null; i++) {
      session.runTo(session.tick() + 100);
    }

    const flight = session.view().fleet.recentFlights[0];
    said.landed = flight?.arrivedTick ?? 0;
    expect(session.mission(delivery)).toMatchObject({
      status: 'completed',
      completedTick: said.landed,
    });
    const aircraft = session.aircraft();
    said.checksEnd = aircraft.service?.checksCompleteTick ?? 0;
    said.ready = said.checksEnd + payloadDurationS(30, 8000, 0);
    // Not available at once, and the payload has not vanished: it is aboard, to be taken off.
    expect(aircraft).toMatchObject({
      status: 'servicing',
      location: akrotiri,
      payloadKg: 8000,
      service: { reason: 'turnaround', payload: { targetKg: 0 } },
    });
    expect(groundForecasts(session.view().fleet.aircraft, session.tick()).get(ATLAS)).toMatchObject(
      {
        completeTick: said.ready,
      },
    );
    const shown = groundServiceView(aircraft, session.view().fleet.aircraft, session.tick());
    expect(shown?.tasks).toMatchObject([{ label: 'Payload', state: 'After the checks' }]);
    expect(shown?.tasks[0]?.detail).toMatch(/8,000 kg to take off/);
    expect(shown?.detail).toMatch(/^Checked after its flight, then its payload is taken off\./);
    expect(shown?.stop?.label).toBe('Leave the payload aboard');
  });

  it('the application closes during the unloading and reopens to the same payload and time', async () => {
    session.runTo(said.checksEnd + 400);
    const transfer = session.aircraft().service?.payload?.transfer as Transfer;
    expect(transfer).toMatchObject({
      startTick: said.checksEnd,
      toKg: 0,
      completeTick: said.ready,
    });
    expect(session.aircraft().payloadKg).toBe(fuelDuringTransfer(transfer, session.tick()));
    expect(session.aircraft().payloadKg).toBeLessThan(8000);
    expect(session.aircraft().payloadKg).toBeGreaterThan(0);
    expect(
      aerodromeView(akrotiri, session.view().fleet.aircraft, session.tick()).resources[1],
    ).toMatchObject({ kind: 'handling', inUseBy: [ATLAS], waiting: [] });

    await session.runner.flush();
    const atClose = session.view();
    const closed = session.aircraft();
    session.database.close();
    session = await openSession();
    expect(session.view().clock).toEqual(atClose.clock);
    expect(session.view().fleet).toEqual(atClose.fleet);
    expect(session.aircraft().payloadKg).toBe(closed.payloadKg);
    expect(session.aircraft().service).toEqual(closed.service);
    expect(session.mission(delivery).status).toBe('completed');
  });

  it('it is available at the tick it said, with nothing aboard, and not a tick before', () => {
    session.runTo(said.ready - 100);
    session.execute({ type: 'setSpeed', speed: 1 });
    session.runTo(said.ready - 1);
    expect(session.aircraft()).toMatchObject({ status: 'servicing' });
    expect(session.aircraft().payloadKg).toBeGreaterThan(0);
    session.runTo(said.ready);
    expect(session.tick()).toBe(said.ready);
    expect(session.aircraft()).toMatchObject({ status: 'available', payloadKg: 0, service: null });
    session.execute({ type: 'setSpeed', speed: 100 });
    session.runTo(said.ready + 600);
  });

  it('the services are exported, and each aerodrome has its report', async () => {
    const report = await session.reports();
    const csv = toCsv(reportTable('services', report));
    const rows = reportTable('services', report).rows;
    expect(rows.map((row) => [row.aerodrome, row.service, row.payload_moved_kg])).toEqual([
      ['EGHQ', 'preparation', 8000],
      ['LCRA', 'turnaround', -8000],
    ]);
    expect(rows[1]).toMatchObject({
      aircraft: ATLAS,
      mission: null,
      status: 'completed',
      resources: 'payload handling',
      started_tick: said.landed,
      completed_tick: said.ready,
      payload_requested_kg: 0,
      queue_min: 0,
    });
    // A header and a row for each service.
    expect(csv.trimEnd().split('\r\n')).toHaveLength(3);
    // Narrowed to one aerodrome, as the screen narrows it.
    expect(reportTable('services', report, { ...NO_FILTER, aerodrome: 'LCRA' }).rows).toHaveLength(
      1,
    );

    expect(report.aerodromes.find((each) => each.at === 'LCRA')).toMatchObject({
      services: 1,
      payloadRemovedKg: 8000,
      payloadLoadedKg: 0,
      arrivals: 1,
      departures: 0,
    });
    expect(report.aerodromes.find((each) => each.at === 'EGHQ')).toMatchObject({
      services: 1,
      payloadLoadedKg: 8000,
      departures: 1,
      arrivals: 0,
    });
    // The aerodrome report's identity and capability come from the world's own point.
    const known = knownAerodromes(session.view());
    expect(known.get('LCRA')).toEqual(akrotiri);
    expect(aerodromeView(akrotiri, session.view().fleet.aircraft, session.tick())).toMatchObject({
      sizeLabel: 'Medium airport',
      capability: { fuelPoints: 1, handlingPoints: 1, payloadRateKgS: 30 },
      aircraft: [{ id: ATLAS }],
      resources: [{ inUseBy: [] }, { inUseBy: [] }],
    });
  });

  it('the history says the payload was delivered and then taken off', async () => {
    const history = await loadMissionLog(delivery);
    const unloading = history.find((entry) => entry.type === 'payloadUnloading');
    expect(unloading).toMatchObject({
      tick: said.landed,
      aircraftId: ATLAS,
      payload: { payloadKg: 8000, at: 'LCRA' },
    });
    expect(history.at(-1)?.type).toBe('missionCompleted');
  });

  it('the whole world is exactly what its seed and its log produce', async () => {
    await session.runner.flush();
    const saved = (await new SqliteWorldStore(session.database.db).load()) as Checkpoint;
    const log: LogEntry[] = (await loadRecentLog(1_000_000)).reverse();
    expect(log.map((entry) => entry.seq)).toEqual(log.map((_, index) => index + 1));
    expect(log.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(['classifyAerodromes', 'payloadUnloading', 'loadingCompleted']),
    );
    const replayed = replayWorld(newWorld(), log, saved.snapshot.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(saved.snapshot));
  });
});

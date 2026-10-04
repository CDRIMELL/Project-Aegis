import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorldStore } from '@aegis/db';
import { openNodeDatabase } from '@aegis/db/node';
import { greatCircleDistance, simInstant, type PlanEstimate, type RoutePoint } from '@aegis/domain';
import { importReferenceData } from '@aegis/ingest';
import { SimulationEngine, SimulationRunner, planContextOf, type SimCommand } from '@aegis/sim';
import { ManualHostClock } from '@aegis/sim/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bindReferenceDb, loadAerodrome, loadAircraftTypes } from '../reference/queries';
import { FLIGHT_REFERENCE_INPUTS } from '../testing/flight-fixtures';
import { aerodromePoint, buildCatalogue, starterOrders, type AerodromeRow } from './catalogue';
import {
  evaluateDraft,
  generateDraft,
  insertWaypoint,
  moveWaypoint,
  refuelForRoute,
  type PlanDraft,
} from './plan-edit';

/*
 * The whole operational loop, end to end, through the same code the application runs: reference
 * data imported by the pipeline, read by the application's queries, turned into a starter fleet,
 * planned, edited, launched, flown, checkpointed to SQLite, reloaded and landed.
 * Only the window and the map renderer are absent.
 */

const EPOCH = simInstant(Date.UTC(2026, 9, 4, 12, 0, 0));
const newWorld = () => ({ seed: 'scenario-world', epoch: EPOCH });
const AIRCRAFT = 'AEGIS-TR-002';

describe('fleet and flight: end-to-end scenario', () => {
  let directory: string;
  let path: string;
  /** Every command issued, with the tick it was issued at, for the uninterrupted comparison. */
  const issued: { tick: number; command: SimCommand }[] = [];

  async function openSession() {
    const database = openNodeDatabase(path);
    bindReferenceDb(database.db);
    const host = new ManualHostClock();
    const runner = await SimulationRunner.open({
      store: new SqliteWorldStore(database.db),
      host,
      newWorld,
    });
    const execute = (command: SimCommand) => {
      issued.push({ tick: runner.view().clock.tick, command });
      runner.execute(command);
    };
    const run = (realMs: number) => {
      for (let elapsed = 0; elapsed < realMs; elapsed += 100) {
        host.elapse(100);
        runner.advance();
      }
    };
    const aircraft = (id = AIRCRAFT) => {
      const found = runner.view().fleet.aircraft.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`no aircraft ${id}`);
      return found;
    };
    /** The world a plan would be flown in if it left now: what the planner on screen uses. */
    const context = () => planContextOf(runner.view());
    return { database, runner, execute, run, aircraft, context };
  }

  let session: Awaited<ReturnType<typeof openSession>>;
  let draft: PlanDraft;
  /** The planner's estimate at the moment of launch. */
  let launchEstimate: PlanEstimate | null = null;
  let newquay: RoutePoint;
  let akrotiri: RoutePoint;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-scenario-'));
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

  it('1. starts with a starter fleet of real types at real aerodromes', async () => {
    const { types, attributes } = await loadAircraftTypes();
    const catalogue = buildCatalogue(types, attributes);
    const homes = (
      await Promise.all(['EGPK', 'EGHQ'].map((icao) => loadAerodrome({ icao })))
    ).filter((row): row is NonNullable<typeof row> => row !== null) as AerodromeRow[];
    const { orders, missing } = starterOrders(catalogue, homes);
    expect(missing).toEqual([]);

    session.execute({ type: 'setSpeed', speed: 100 });
    session.execute({ type: 'seedStarterFleet', aircraft: orders });

    const fleet = session.runner.view().fleet.aircraft;
    expect(fleet.map((a) => [a.id, a.typeName, a.home.code])).toEqual([
      ['AEGIS-FT-001', 'Eurofighter Typhoon', 'EGPK'],
      ['AEGIS-FT-002', 'Eurofighter Typhoon', 'EGPK'],
      ['AEGIS-TR-001', 'Airbus A400M Atlas', 'EGHQ'],
      ['AEGIS-TR-002', 'Boeing C-17 Globemaster III', 'EGHQ'],
    ]);
    // Types differ because their sourced characteristics differ.
    const capacities = fleet.map((a) => a.performance?.fuelCapacityKg ?? 0);
    expect(new Set(capacities).size).toBe(3);
  });

  it('2-4. selects an aircraft and generates a flight plan to a destination', async () => {
    const aircraft = session.aircraft();
    expect(aircraft).toMatchObject({
      status: 'available',
      typeName: 'Boeing C-17 Globemaster III',
    });
    const destination = await loadAerodrome({ icao: 'LCRA' });
    if (!aircraft.performance || !aircraft.location || !destination) throw new Error('setup');
    newquay = aircraft.location;
    akrotiri = aerodromePoint(destination);

    draft = generateDraft(
      AIRCRAFT,
      aircraft.performance,
      newquay,
      akrotiri,
      15_000,
      session.context(),
    );
    const evaluation = evaluateDraft(draft, aircraft.performance, session.context());

    expect(draft.plan.points[0]).toMatchObject({ code: 'EGHQ', kind: 'aerodrome' });
    expect(draft.plan.points.at(-1)).toMatchObject({
      code: 'LCRA',
      name: 'RAF Akrotiri',
      refId: 'ourairports:4175',
    });
    expect(draft.plan.points.slice(1, -1).every((point) => point.kind === 'waypoint')).toBe(true);
    expect(draft.plan).toMatchObject({ cruiseAltitudeM: 10973, cruiseSpeedKmh: 833 });
    expect(evaluation.flyable).toBe(true);
    expect(evaluation.estimate?.distanceM).toBeCloseTo(greatCircleDistance(newquay, akrotiri), 0);
    expect(evaluation.constraints.filter((c) => c.severity !== 'note')).toEqual([]);
    expect(evaluation.estimate?.fuelAtDestinationKg).toBeGreaterThanOrEqual(
      aircraft.performance.reserveFuelKg,
    );
  });

  it('5-6. recalculates when a waypoint is added and moved', () => {
    const model = session.aircraft().performance;
    if (!model) throw new Error('setup');
    const before = evaluateDraft(draft, model, session.context()).estimate;

    // Add a waypoint on the first leg, then drag it well off the direct route (over Sicily).
    const edited = moveWaypoint(insertWaypoint(draft, 0), 1, 37.5, 14.0);
    expect(edited.plan.points).toHaveLength(draft.plan.points.length + 1);
    expect(edited.plan.points[1]).toMatchObject({
      kind: 'waypoint',
      name: 'WP1',
      lat: 37.5,
      lon: 14.0,
    });

    const after = evaluateDraft(edited, model, session.context()).estimate;
    expect(after?.distanceM).toBeGreaterThan(before?.distanceM ?? 0);
    expect(after?.durationS).toBeGreaterThan(before?.durationS ?? 0);
    expect(after?.fuelUsedKg).toBeGreaterThan(before?.fuelUsedKg ?? 0);
    expect(after?.legs).toHaveLength((before?.legs.length ?? 0) + 1);

    draft = refuelForRoute(edited, model, session.context());
    expect(draft.load.fuelKg).toBeGreaterThan(edited.load.fuelKg);
    expect(evaluateDraft(draft, model, session.context()).flyable).toBe(true);
  });

  it('7-10. launches, and the aircraft moves and its telemetry changes', () => {
    const model = session.aircraft().performance;
    if (!model) throw new Error('setup');
    // Estimated in the world as it is at the moment of launch: this is what will be flown.
    const estimate = evaluateDraft(draft, model, session.context()).estimate;
    launchEstimate = estimate;

    session.execute({
      type: 'launchFlight',
      aircraftId: AIRCRAFT,
      plan: draft.plan,
      load: draft.load,
    });
    expect(session.aircraft()).toMatchObject({
      status: 'in_flight',
      location: null,
      fuelKg: draft.load.fuelKg,
    });

    session.run(10_000);
    const early = session.runner.view().fleet.activeFlights[0];
    session.run(40_000);
    const later = session.runner.view().fleet.activeFlights[0];
    if (!early || !later) throw new Error('flight should be active');

    expect(early.phase).toBe('climb');
    expect(later.phase).toBe('cruise');
    expect(later.distanceM).toBeGreaterThan(early.distanceM + 500_000);
    expect(greatCircleDistance(later, newquay)).toBeGreaterThan(
      greatCircleDistance(early, newquay),
    );
    expect(later.altitudeM).toBeGreaterThan(early.altitudeM);
    expect(later.speedKmh).toBeGreaterThan(early.speedKmh);
    expect(later.fuelKg).toBeLessThan(early.fuelKg);
    expect(later.etaTick).toBe(estimate?.durationS);
    expect(later.totalM).toBeCloseTo(estimate?.distanceM ?? 0, 3);
    expect(session.aircraft().fuelKg).toBe(later.fuelKg);
  });

  it('11-13. checkpoints mid-flight, reloads from SQLite and continues deterministically', async () => {
    await session.runner.flush();
    const atClose = session.runner.view();
    expect(atClose.fleet.activeFlights).toHaveLength(1);
    session.database.close();

    session = await openSession();
    const reopened = session.runner.view();
    expect(reopened.clock).toEqual(atClose.clock);
    expect(reopened.fleet).toEqual(atClose.fleet);
    expect(reopened.integrityDigest).toBe(atClose.integrityDigest);

    session.run(20_000);

    // The same commands at the same ticks in a world that was never saved or reloaded.
    const uninterrupted = SimulationEngine.create(newWorld());
    for (const { tick, command } of issued) {
      uninterrupted.runSteps(tick - uninterrupted.clock.tick);
      if (command.type === 'setSpeed') uninterrupted.setSpeed(command.speed);
      else if (command.type !== 'pause' && command.type !== 'resume')
        uninterrupted.applyCommand(command);
    }
    uninterrupted.runSteps(session.runner.view().clock.tick - uninterrupted.clock.tick);

    expect(session.runner.view().fleet).toEqual(uninterrupted.fleetView());
    expect(session.runner.view().integrityDigest).toBe(uninterrupted.snapshot().integrityDigest);
  });

  it('14-15. completes the flight and updates the aircraft', async () => {
    const estimate = launchEstimate;

    let guard = 0;
    while (session.aircraft().activeFlightId !== null) {
      session.run(1000);
      if (++guard > 1000) throw new Error('flight did not finish');
    }

    const landed = session.aircraft();
    expect(landed).toMatchObject({
      status: 'available',
      location: akrotiri,
      flights: 1,
      payloadKg: 15_000,
    });
    expect(landed.fuelKg).toBe(estimate?.fuelAtDestinationKg);
    expect(landed.flightSecondsTotal).toBe(estimate?.durationS);
    expect(landed.conditionPct).toBeLessThan(100);
    expect(landed.conditionPct).toBeGreaterThan(95);

    const flight = session.runner.view().fleet.recentFlights[0];
    expect(flight).toMatchObject({
      aircraftId: AIRCRAFT,
      status: 'completed',
      progress: { phase: 'landed' },
    });
    expect((flight?.arrivedTick ?? 0) - (flight?.departedTick ?? 0)).toBe(estimate?.durationS);

    // Persisted: the database agrees, and reference tables were not touched by the simulation.
    await session.runner.flush();
    const sql = (text: string) => session.database.transport.connection.prepare(text).all();
    expect(sql(`SELECT status, flights FROM sim_aircraft WHERE id = '${AIRCRAFT}'`)).toEqual([
      { status: 'available', flights: 1 },
    ]);
    expect(sql('SELECT status FROM sim_flight')).toEqual([{ status: 'completed' }]);
    expect(sql('SELECT count(*) AS n FROM ref_aircraft_type')).toEqual([{ n: 4 }]);
    expect(sql('PRAGMA foreign_key_check')).toEqual([]);

    // The others never moved.
    expect(session.aircraft('AEGIS-FT-001')).toMatchObject({
      flights: 0,
      conditionPct: 100,
      status: 'available',
    });
  });
});

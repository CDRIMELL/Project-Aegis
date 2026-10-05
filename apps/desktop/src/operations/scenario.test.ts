import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorldStore } from '@aegis/db';
import { openNodeDatabase } from '@aegis/db/node';
import {
  MISSION_TEMPLATES,
  TICKS_PER_DAY,
  defaultBrief,
  reportTable,
  simInstant,
  type Mission,
  type MissionBrief,
  type MissionType,
  type ReportPeriod,
  type RevisionContext,
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
  type FlightView,
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
import { insertWaypoint, moveWaypoint } from '../fleet/plan-edit';
import { activeRouteFeatures } from '../map/flight-features';
import { chooseOperatingArea, fleetCentre } from '../missions/operating-area';
import {
  bindReferenceDb,
  loadAerodrome,
  loadAerodromesNear,
  loadAircraftTypes,
  loadLargeAerodromes,
} from '../reference/queries';
import { bindReportDb, loadReports } from '../reports/report-service';
import { bindSimDb, loadMissionLog, loadRecentLog } from '../sim/log-queries';
import { FLIGHT_REFERENCE_INPUTS } from '../testing/flight-fixtures';
import {
  abortLanding,
  currentEstimate,
  draftRemainder,
  objectivesAffected,
  operationsFor,
  proposalEstimate,
  rankCandidates,
  remainderOf,
  revisionDraft,
} from './inflight-logic';

/*
 * In-flight control end to end, through the code the application runs: an operator diverts a
 * delivery, reroutes a second flight, and aborts a third mission after its first objective; the
 * application is closed and reopened in the middle; the reports say what was planned and what
 * happened; and the world is re-derived from its seed and its log. Only the window is absent.
 * A destination closing is exercised in the simulation's own tests, where the world's events can
 * be set; here the events are whatever this seed's world produces.
 */

const EPOCH = simInstant(Date.UTC(2026, 9, 4, 12, 0, 0));
const newWorld = () => ({ seed: 'operations-scenario', epoch: EPOCH });
/** The C-17 at Newquay: range for the Atlantic. */
const HEAVY = 'AEGIS-TR-002';
/** The A400M at Newquay. */
const ATLAS = 'AEGIS-TR-001';
const AREA = { name: 'Area 1', lat: 49.4, lon: -7.2 };
const HOUR = 3600;
const ALL: ReportPeriod = { fromTick: 0, toTick: 400 * TICKS_PER_DAY };

describe('in-flight control: end-to-end scenario', { timeout: 60_000 }, () => {
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
    /** Runs for a stretch of simulated time, at 100x. */
    const runSim = (simSeconds: number) => {
      for (let elapsed = 0; elapsed < simSeconds * 10; elapsed += 100) {
        host.elapse(100);
        runner.advance();
      }
    };
    const view = () => runner.view();
    const aircraft = (id: string) => {
      const found = view().fleet.aircraft.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`no aircraft ${id}`);
      return found;
    };
    const flight = (id: string): FlightView => {
      const found = view().fleet.activeFlights.find((candidate) => candidate.aircraftId === id);
      if (!found) throw new Error(`${id} should be in the air`);
      return found;
    };
    const flying = (id: string) => view().fleet.activeFlights.some((f) => f.aircraftId === id);
    const mission = (id: string): Mission => {
      const found = view().missions.missions.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`no mission ${id}`);
      return found;
    };
    const context = (): RevisionContext => {
      const plan = planContextOf(view());
      return { weather: plan.weather, ...(plan.hazards && { hazards: plan.hazards }) };
    };
    const create = (
      type: MissionType,
      aircraftId: string,
      brief: Partial<MissionBrief>,
      extraFuelKg = 0,
    ): string => {
      const before = new Set(view().missions.missions.map((each) => each.id));
      const config = defaultConfiguration(
        type,
        { ...defaultBrief(MISSION_TEMPLATES[type]), ...brief },
        aircraft(aircraftId),
        { context: planContextOf(view()) },
      );
      execute({
        type: 'createMission',
        missionType: type,
        ...config,
        ...(config.load && {
          // Extra fuel for a decision in flight, as far as the tanks allow.
          load: {
            ...config.load,
            fuelKg: Math.min(
              config.load.fuelKg + extraFuelKg,
              aircraft(aircraftId).performance?.fuelCapacityKg ?? config.load.fuelKg,
            ),
          },
        }),
      });
      const created = view().missions.missions.find(
        (each) => !before.has(each.id) && each.source === 'manual',
      );
      if (!created) throw new Error('the mission was not created');
      execute({ type: 'acceptMission', missionId: created.id });
      // Accepting begins loading the mission's fuel; it launches when that is done (ADR 0027).
      for (let i = 0; i < 400 && aircraft(aircraftId).status === 'servicing'; i++) runSim(60);
      execute({ type: 'launchMission', missionId: created.id });
      return created.id;
    };
    const land = (id: string) => {
      for (let i = 0; i < 400 && flying(id); i++) runSim(120);
      if (flying(id)) throw new Error(`${id} did not land`);
      runSim(2);
    };
    const reports = async (period: ReportPeriod = ALL) => {
      await runner.flush();
      const loaded = await loadReports(period, view().checkpoint.persistedSeq);
      if (!loaded) throw new Error('no world to report on');
      return loaded.current;
    };
    return {
      database,
      runner,
      execute,
      runSim,
      view,
      aircraft,
      flight,
      flying,
      mission,
      context,
      create,
      land,
      reports,
    };
  }

  let session: Awaited<ReturnType<typeof openSession>>;
  const ids = { delivery: '', reroute: '', aborted: '' };
  let kennedy: RoutePoint;
  let akrotiri: RoutePoint;
  let alternate: RoutePoint;
  /** What the diversion was estimated to come to, the moment before it was ordered. */
  let estimated = { arrivalTick: 0, landingFuelKg: 0 };

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-operations-scenario-'));
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
    const fleetHomes = session.view().fleet.aircraft.map((each) => each.home);
    const centre = fleetCentre(fleetHomes);
    if (!centre) throw new Error('the fleet should have a centre');
    session.execute({
      type: 'setOperatingArea',
      places: chooseOperatingArea(await loadLargeAerodromes(), fleetHomes),
      centre,
    });
    const jfk = await loadAerodrome({ icao: 'KJFK' });
    const lcra = await loadAerodrome({ icao: 'LCRA' });
    if (!jfk || !lcra) throw new Error('setup');
    kennedy = aerodromePoint(jfk);
    akrotiri = aerodromePoint(lcra);
  });
  afterAll(() => {
    session.database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('1-4. creates a delivery to a distant aerodrome, launches it, and lets it fly', () => {
    ids.delivery = session.create(
      'logistics',
      HEAVY,
      { destination: kennedy, payloadKg: 20_000 },
      15_000,
    );
    const mission = session.mission(ids.delivery);
    expect(mission.status).toBe('active');
    expect(mission.plan?.points.at(-1)?.code).toBe('KJFK');
    // On the take-off roll the route cannot be changed yet, and each action says why. The
    // mission can be aborted at any time: going on to land needs no change of route.
    const rolling = operationsFor(session.flight(HEAVY), session.aircraft(HEAVY), mission);
    for (const each of rolling.filter((operation) => operation.operation !== 'abort')) {
      expect(each.available).toBe(false);
      expect(each.reason).toMatch(/take-off roll/);
    }
    expect(rolling.find((each) => each.operation === 'abort')?.available).toBe(true);

    session.runSim(1.5 * HOUR);
    const flight = session.flight(HEAVY);
    expect(flight.phase).toBe('cruise');
    expect(flight.intent).toBeNull();
    expect(
      operationsFor(flight, session.aircraft(HEAVY), mission)
        .filter((each) => each.available)
        .map((each) => each.operation),
    ).toEqual(['reroute', 'divert', 'return', 'hold', 'abort']);
  });

  it('6-8. compares going on with diverting, from real aerodromes, and diverts', async () => {
    const flight = session.flight(HEAVY);
    const model = session.aircraft(HEAVY).performance;
    if (!model) throw new Error('no model');
    const context = session.context();

    // Candidates come from the reference data around the aircraft, ranked by landing fuel.
    const near = (await loadAerodromesNear(flight.lat, flight.lon)) as AerodromeRow[];
    expect(near.length).toBeGreaterThan(3);
    const ranked = rankCandidates(model, flight, near.map(aerodromePoint), context);
    expect(ranked.map((candidate) => candidate.place.code)).not.toContain('KJFK');
    const usable = ranked.filter((candidate) => candidate.flyable);
    expect(usable.length).toBeGreaterThan(2);
    for (const candidate of usable) {
      expect(candidate.place.kind).toBe('aerodrome');
      expect(candidate.place.refId).toBeTruthy();
      expect(candidate.estimate?.projection.completes).toBe(true);
    }
    const dublin = usable.find((candidate) => candidate.place.code === 'EIDW');
    if (!dublin?.estimate) throw new Error('Dublin should be reachable');
    alternate = dublin.place;

    // Before and after, with the simulation's own flight model.
    const before = currentEstimate(model, flight, context);
    const after = proposalEstimate(model, flight, [alternate], context);
    expect(after.blocks).toEqual([]);
    expect(before.projection.destination.code).toBe('KJFK');
    expect(after.estimate?.projection.destination.code).toBe('EIDW');
    expect(after.estimate?.projection.remainingM).toBeLessThan(before.projection.remainingM);
    expect(after.estimate?.projection.arrivalTick).toBeLessThan(before.projection.arrivalTick);
    expect(after.estimate?.projection.landingFuelKg).toBeGreaterThan(
      before.projection.landingFuelKg,
    );
    expect(after.estimate?.risk.index).toBeLessThanOrEqual(100);
    // The delivery will fail if the aircraft lands in Dublin, and the operator is told so first.
    const affected = objectivesAffected(session.mission(ids.delivery), alternate, false);
    expect(affected.map((each) => each.effect)).toContain(
      'Fails: lands at Dublin Airport, not at John F Kennedy International Airport.',
    );

    estimated = {
      arrivalTick: after.estimate?.projection.arrivalTick ?? 0,
      landingFuelKg: after.estimate?.projection.landingFuelKg ?? 0,
    };
    session.execute({
      type: 'reviseFlight',
      aircraftId: HEAVY,
      intent: 'divert',
      points: [alternate],
    });
    const diverted = session.flight(HEAVY);
    expect(diverted.intent).toBe('divert');
    expect(diverted.plannedDestination.code).toBe('KJFK');
    expect(diverted.points.at(-1)?.code).toBe('EIDW');
    expect(diverted.revisions).toHaveLength(1);
    // The estimate shown before confirming is the flight's projection after it.
    expect(diverted.etaTick).toBe(estimated.arrivalTick);
    expect(diverted.estimatedFuelAtDestinationKg).toBe(estimated.landingFuelKg);
    // Diverting does not abort the mission, and does not change what it meant to do.
    expect(session.mission(ids.delivery).status).toBe('active');
    expect(session.mission(ids.delivery).plan?.points.at(-1)?.code).toBe('KJFK');

    // The map draws the flown part and the new route; nothing leads to New York any more.
    const features = activeRouteFeatures([diverted], HEAVY).features;
    expect(features.map((feature) => feature.properties.flown)).toEqual([true, false]);
    const end = features[1]?.geometry.coordinates.at(-1) ?? [0, 0];
    expect(end[1]).toBeCloseTo(alternate.lat, 6);
  });

  it('9-10. closes during the diversion and reopens to the same route, fuel and history', async () => {
    session.runSim(900);
    await session.runner.flush();
    const atClose = session.view();
    const heldAtClose = session.flight(HEAVY);
    session.database.close();

    session = await openSession();
    const reopened = session.view();
    expect(reopened.clock).toEqual(atClose.clock);
    expect(reopened.fleet).toEqual(atClose.fleet);
    expect(reopened.missions).toEqual(atClose.missions);
    expect(reopened.integrityDigest).toBe(atClose.integrityDigest);
    const flight = session.flight(HEAVY);
    expect(flight).toEqual(heldAtClose);
    expect(flight.revisions[0]).toMatchObject({ intent: 'divert' });
    expect(flight.revisions[0]?.replaced.at(-1)?.code).toBe('KJFK');
    expect(flight.etaTick).toBe(estimated.arrivalTick);
  });

  it('11-12. lands at the alternate, exactly as estimated, and the delivery fails for that reason', async () => {
    session.land(HEAVY);
    const aircraft = session.aircraft(HEAVY);
    expect(aircraft.location?.code).toBe('EIDW');
    const flown = session.view().fleet.recentFlights.find((f) => f.aircraftId === HEAVY);
    expect(flown?.arrivedTick).toBe(estimated.arrivalTick);
    expect(flown?.progress.fuelKg).toBe(estimated.landingFuelKg);

    const mission = session.mission(ids.delivery);
    expect(mission.status).toBe('failed');
    const delivery = mission.objectives.find((o) => o.spec.kind === 'deliver_payload');
    expect(delivery).toMatchObject({
      status: 'failed',
      remark: 'Landed at Dublin Airport, not at John F Kennedy International Airport.',
    });
    expect(mission.outcome?.summary).toMatch(/Landed at Dublin Airport, not at John F Kennedy/);
    // The payload was not delivered, so it is still aboard.
    expect(aircraft.payloadKg).toBe(20_000);

    await session.runner.flush();
    const history = await loadMissionLog(ids.delivery);
    expect(history.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(['launchMission', 'reviseFlight', 'flightCompleted', 'missionFailed']),
    );
    expect(history.find((entry) => entry.type === 'reviseFlight')?.payload).toMatchObject({
      intent: 'divert',
      points: [expect.objectContaining({ code: 'EIDW' })],
    });
  });

  it('13-15. reroutes a second flight through an added waypoint and lands where it planned to', () => {
    // The A400M is ferried from Newquay to Akrotiri, with fuel for a longer way round.
    ids.reroute = session.create('ferry', ATLAS, { destination: akrotiri }, 4000);
    const planned = session.mission(ids.reroute).plan?.points.at(-1);
    if (!planned) throw new Error('the ferry has no destination');
    expect(planned.code).toBe('LCRA');
    session.runSim(1200);
    const flight = session.flight(ATLAS);
    const model = session.aircraft(ATLAS).performance;
    if (!model) throw new Error('no model');

    // The planner's own editing, on the rest of the route: add a waypoint and pull it aside.
    const draft = revisionDraft(flight, remainderOf(flight));
    const edited = moveWaypoint(insertWaypoint(draft, 0), 1, flight.lat + 1.5, flight.lon + 1.5);
    const remainder = draftRemainder(edited);
    expect(remainder.at(-1)).toEqual(planned);
    const before = currentEstimate(model, flight, session.context());
    const after = proposalEstimate(model, flight, remainder, session.context());
    expect(after.blocks).toEqual([]);
    expect(after.estimate?.projection.remainingM).toBeGreaterThan(before.projection.remainingM);
    expect(objectivesAffected(session.mission(ids.reroute), planned, false)).toEqual([]);

    session.execute({
      type: 'reviseFlight',
      aircraftId: ATLAS,
      intent: 'reroute',
      points: remainder,
    });
    expect(session.flight(ATLAS)).toMatchObject({ intent: 'reroute' });
    expect(session.flight(ATLAS).plannedDestination).toEqual(planned);
    const eta = session.flight(ATLAS).etaTick;
    expect(eta).toBe(after.estimate?.projection.arrivalTick);
    session.land(ATLAS);
    expect(session.aircraft(ATLAS).location?.refId).toBe(planned.refId);
    const flown = session.view().fleet.recentFlights.find((f) => f.aircraftId === ATLAS);
    expect(flown?.arrivedTick).toBe(eta);
    expect(session.mission(ids.reroute).status).toBe('completed');
  });

  it('16-19. completes one objective of a third mission, aborts it, and returns to land', () => {
    // From wherever the A400M now is: out to a point and back.
    const here = session.aircraft(ATLAS).location;
    if (!here) throw new Error('the A400M should be on the ground');
    ids.aborted = session.create('training', ATLAS, {
      target: { name: AREA.name, lat: here.lat - 1.2, lon: here.lon - 2 },
    });
    for (let i = 0; i < 200; i++) {
      if (session.mission(ids.aborted).objectives[0]?.status === 'complete') break;
      session.runSim(60);
    }
    const flying = session.mission(ids.aborted);
    expect(flying.objectives[0]?.status).toBe('complete');
    expect(flying.status).toBe('active');
    const flight = session.flight(ATLAS);
    const origin = flight.points[0];
    if (!origin) throw new Error('no origin');

    // Told first what the abort will decide.
    const effects = objectivesAffected(flying, origin, true);
    expect(effects.length).toBe(flying.objectives.length - 1);
    session.execute({
      type: 'abortMission',
      missionId: ids.aborted,
      landing: abortLanding('continue', remainderOf(flight)),
    });
    const aborted = session.mission(ids.aborted);
    expect(aborted.status).toBe('aborted');
    expect(aborted.objectives[0]?.status).toBe('complete');
    expect(aborted.objectives.slice(1).every((o) => o.remark === 'Mission aborted.')).toBe(true);
    // The aircraft is still flying, and is no longer offered an abort.
    expect(session.flying(ATLAS)).toBe(true);
    expect(
      operationsFor(session.flight(ATLAS), session.aircraft(ATLAS), aborted).map(
        (each) => each.operation,
      ),
    ).not.toContain('abort');
    session.land(ATLAS);
    expect(session.aircraft(ATLAS).location?.refId).toBe(origin.refId);
    expect(session.mission(ids.aborted)).toEqual(aborted);
  });

  it('holds and resumes on the operator’s order, at 100x as at any speed', () => {
    // The C-17 is ferried on from Dublin to Akrotiri, with fuel to hold for a while on the way.
    const id = session.create('ferry', HEAVY, { destination: akrotiri }, 8000);
    session.runSim(1.5 * HOUR);
    session.execute({ type: 'holdFlight', aircraftId: HEAVY });
    const at = session.flight(HEAVY);
    expect(at.hold).toBe('operator');
    session.runSim(600);
    const held = session.flight(HEAVY);
    expect(held.distanceM).toBe(at.distanceM);
    expect(held.heldS).toBe(600);
    expect(held.fuelKg).toBeLessThan(at.fuelKg);
    session.execute({ type: 'resumeFlight', aircraftId: HEAVY });
    const eta = session.flight(HEAVY).etaTick;
    session.land(HEAVY);
    const flown = session.view().fleet.recentFlights.find((f) => f.aircraftId === HEAVY);
    expect(flown?.arrivedTick).toBe(eta);
    expect(flown?.progress.heldS).toBe(600);
    expect(session.mission(id).status).toBe('completed');
  });

  it('22-23. reports say what was planned, what happened, and what is still in the air', async () => {
    const report = await session.reports();
    const fuel = reportTable('fuel', report).rows;
    const diverted = fuel.find((row) => row.planned_to === 'KJFK');
    expect(diverted).toMatchObject({ to: 'EIDW', planned_to: 'KJFK', revisions: 'divert' });
    const rerouted = fuel.find((row) => row.revisions === 'reroute');
    expect(rerouted?.to).toBe(rerouted?.planned_to);
    expect(fuel.find((row) => row.held_h === 0.167)).toBeTruthy();

    const missions = reportTable('missions', report).rows;
    expect(missions.find((row) => row.mission === ids.delivery)).toMatchObject({
      outcome: 'failed',
      landed_at: 'EIDW',
      planned_to: 'KJFK',
    });
    expect(missions.find((row) => row.mission === ids.aborted)).toMatchObject({
      outcome: 'aborted',
    });
    expect(report.totals).toMatchObject({
      missionsAborted: 1,
      missionsFailed: 1,
      flightsDiverted: 1,
      routeRevisions: 2,
      heldSeconds: 600,
    });
    expect(report.inProgress).toEqual({ flights: [], missions: [] });

    // With a flight in the air, it is shown apart and the totals do not move.
    const origin = session.aircraft(ATLAS).location;
    if (!origin) throw new Error('on the ground');
    session.create('training', ATLAS, {
      target: { name: 'Area 2', lat: origin.lat + 1, lon: origin.lon },
    });
    session.runSim(600);
    const during = await session.reports();
    expect(during.inProgress.flights).toHaveLength(1);
    expect(during.inProgress.flights[0]).toMatchObject({ aircraftId: ATLAS, elapsedS: 600 });
    expect(during.inProgress.flights[0]?.fuelUsedKg).toBeGreaterThan(0);
    // The flight and its mission are in no total. The preparation of its aircraft has finished,
    // and a finished ground service is counted like anything else that has finished.
    const GROUND: readonly string[] = [
      'services',
      'serviceSeconds',
      'refuellings',
      'refuellingSeconds',
      'fuelLoadedKg',
      'fuelRemovedKg',
      'missionPreparations',
      'missionPreparationSeconds',
    ];
    const flown = (totals: object) =>
      Object.fromEntries(Object.entries(totals).filter(([key]) => !GROUND.includes(key)));
    expect(flown(during.totals)).toEqual(flown(report.totals));
    expect(during.totals.missionPreparations).toBe(report.totals.missionPreparations + 1);
    expect(during.totals.services).toBe(report.totals.services + 1);
    expect(during.totals.turnarounds).toBe(report.totals.turnarounds);
    session.land(ATLAS);
  });

  it('24. the whole world is exactly what its seed and its log produce', async () => {
    await session.runner.flush();
    const saved = (await new SqliteWorldStore(session.database.db).load()) as Checkpoint;
    const log: LogEntry[] = (await loadRecentLog(1_000_000)).reverse();
    expect(log.map((entry) => entry.seq)).toEqual(log.map((_, index) => index + 1));
    const commands = log.filter((entry) => entry.kind === 'command').map((entry) => entry.type);
    expect(commands).toEqual(
      expect.arrayContaining(['reviseFlight', 'holdFlight', 'resumeFlight', 'abortMission']),
    );
    const replayed = replayWorld(newWorld(), log, saved.snapshot.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(saved.snapshot));
  }, 120_000);
});

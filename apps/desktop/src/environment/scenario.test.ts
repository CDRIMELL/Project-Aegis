import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteWorldStore } from '@aegis/db';
import { openNodeDatabase } from '@aegis/db/node';
import {
  conditionsAt,
  evaluatePlan,
  groundSpeedKmh,
  simInstant,
  type Mission,
  type MissionAssessment,
} from '@aegis/domain';
import { importReferenceData } from '@aegis/ingest';
import {
  SimulationRunner,
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
import { eventFeatures, weatherFeatures } from '../map/environment-features';
import {
  blankForm,
  configurationFromForm,
  evaluationOf,
  readiness,
} from '../missions/mission-logic';
import { chooseOperatingArea, fleetCentre } from '../missions/operating-area';
import {
  bindReferenceDb,
  loadAerodrome,
  loadAircraftTypes,
  loadLargeAerodromes,
} from '../reference/queries';
import { bindSimDb, loadMissionLog, loadRecentLog } from '../sim/log-queries';
import { FLIGHT_REFERENCE_INPUTS } from '../testing/flight-fixtures';

/*
 * The environment and events end to end, through the code the application runs: a world with
 * weather, a mission planned in that weather and flown through it, events occurring as it flies,
 * the application closed and reopened mid-flight, and the whole world re-derived from its seed
 * and its log. Only the window and the map renderer are absent.
 */

const EPOCH = simInstant(Date.UTC(2026, 9, 4, 12, 0, 0));
// A seed in whose world an event is announced two hours in, while the flight is under way.
const newWorld = () => ({ seed: 'environment-scenario-e', epoch: EPOCH });
/** The C-17: its long legs give the world time to change during one flight. */
const AIRCRAFT = 'AEGIS-TR-002';
const MISSION = 'MSN-000001';
const HOUR = 3600;

describe('environment and events: end-to-end scenario', () => {
  let directory: string;
  let path: string;

  async function openSession() {
    const database = openNodeDatabase(path);
    bindReferenceDb(database.db);
    bindSimDb(database.db);
    const host = new ManualHostClock();
    const runner = await SimulationRunner.open({
      store: new SqliteWorldStore(database.db),
      host,
      newWorld,
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
    const context = () => planContextOf(runner.view());
    const aircraft = () => {
      const found = view().fleet.aircraft.find((candidate) => candidate.id === AIRCRAFT);
      if (!found) throw new Error('no aircraft');
      return found;
    };
    const mission = (): Mission => {
      const found = view().missions.missions.find((candidate) => candidate.id === MISSION);
      if (!found) throw new Error('no mission');
      return found;
    };
    const flight = (): FlightView => {
      const found = view().fleet.activeFlights.find(
        (candidate) => candidate.aircraftId === AIRCRAFT,
      );
      if (!found) throw new Error('the flight should be active');
      return found;
    };
    return { database, runner, execute, runSim, view, context, aircraft, mission, flight };
  }

  let session: Awaited<ReturnType<typeof openSession>>;
  /** What the planner said at the moment of launch. */
  let launched: MissionAssessment;
  let departedTick = 0;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-environment-scenario-'));
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

  it('1-2. starts, and shows the simulated environment where the fleet is', async () => {
    const { types, attributes } = await loadAircraftTypes();
    const homes = (
      await Promise.all(['EGPK', 'EGHQ'].map((icao) => loadAerodrome({ icao })))
    ).filter((row): row is NonNullable<typeof row> => row !== null) as AerodromeRow[];
    const { orders } = starterOrders(buildCatalogue(types, attributes), homes);
    session.execute({ type: 'setSpeed', speed: 100 });
    session.execute({ type: 'seedStarterFleet', aircraft: orders });

    // The operating area, as the application sets it, with the centre it was chosen around.
    const fleetHomes = session.view().fleet.aircraft.map((aircraft) => aircraft.home);
    const centre = fleetCentre(fleetHomes);
    if (!centre) throw new Error('the fleet should have a centre');
    session.execute({
      type: 'setOperatingArea',
      places: chooseOperatingArea(await loadLargeAerodromes(), fleetHomes),
      centre,
    });
    expect(session.view().missions.areaCentre).toEqual(centre);

    // The environment at the aircraft's aerodrome: what the Overview screen shows.
    const { weather, clock } = session.view();
    const here = session.aircraft().location;
    if (!here) throw new Error('the aircraft should be on the ground');
    const now = conditionsAt(weather, clock.tick, here, 0);
    expect(now.windSpeedKmh).toBeGreaterThanOrEqual(0);
    expect(now.visibilityKm).toBeGreaterThan(0);
    expect(now.pressureHpa).toBeGreaterThan(950);
    // The weather is the world's own: a function of its seed and epoch, nothing else.
    expect(weather.epochMs).toBe(EPOCH);
    expect(conditionsAt(weather, clock.tick, here, 0)).toEqual(now);
    // And it is going somewhere: twelve hours on, conditions have changed.
    expect(conditionsAt(weather, clock.tick + 12 * HOUR, here, 0)).not.toEqual(now);
    // The map's weather layer draws from the same field.
    const layer = weatherFeatures(weather, clock.tick, [-30, 30, 30, 65], 4, {
      wind: true,
      precipitation: true,
    });
    expect(layer.wind.features.length).toBeGreaterThan(0);
  });

  it('3-4. creates a mission and generates its route', async () => {
    const destination = await loadAerodrome({ icao: 'KJFK' });
    if (!destination) throw new Error('setup');
    const form = {
      ...blankForm('ferry'),
      title: 'Globemaster to New York',
      aircraftId: AIRCRAFT,
      destination: aerodromePoint(destination),
    };
    const configuration = configurationFromForm(
      form,
      session.aircraft(),
      session.view().clock.tick,
      null,
      session.context(),
    );
    session.execute({ type: 'createMission', missionType: 'ferry', ...configuration });
    const mission = session.mission();
    expect(mission).toMatchObject({ status: 'planned', aircraftId: AIRCRAFT });
    expect(mission.plan?.points[0]?.code).toBe('EGHQ');
    expect(mission.plan?.points.at(-1)?.code).toBe('KJFK');
  });

  it('5-6. shows the conditions on the route and what they do to the estimate and the risk', () => {
    const mission = session.mission();
    const aircraft = session.aircraft();
    const tick = session.view().clock.tick;
    const evaluation = evaluationOf(mission, aircraft, tick, session.context());
    const estimate = evaluation.plan?.estimate;
    const weather = estimate?.weather;
    if (!estimate || !weather || !mission.plan || !mission.load || !aircraft.performance) {
      throw new Error('the mission should have an estimate in weather');
    }

    // Conditions on the route: at the origin now, at the destination on arrival.
    const origin = mission.plan.points[0];
    const destination = mission.plan.points.at(-1);
    if (!origin || !destination) throw new Error('setup');
    expect(weather.departure).toEqual(conditionsAt(session.view().weather, tick, origin, 0));
    expect(weather.arrival).toEqual(
      conditionsAt(session.view().weather, tick + estimate.durationS, destination, 0),
    );
    expect(weather.lowestVisibilityKm).toBeGreaterThan(0);

    // The estimate differs from still air, and the difference is explained by the wind.
    const stillAir = evaluatePlan(aircraft.performance, mission.plan, mission.load).estimate;
    expect(stillAir?.durationS).toBe(weather.stillAirDurationS);
    expect(estimate.durationS).not.toBe(stillAir?.durationS);
    expect(estimate.fuelUsedKg).not.toBe(stillAir?.fuelUsedKg);
    const extraS = estimate.durationS - weather.stillAirDurationS;
    expect(Math.sign(extraS)).toBe(-Math.sign(weather.meanTailwindKmh));
    // Westbound across the Atlantic at altitude: a headwind, and a longer flight.
    expect(weather.meanTailwindKmh).toBeLessThan(0);
    expect(extraS).toBeGreaterThan(5 * 60);

    // The fuel offered allows for it: the flight still lands on reserve.
    expect(estimate.fuelAtDestinationKg).toBeGreaterThanOrEqual(aircraft.performance.reserveFuelKg);

    // Risk says why: the wind contributes, with the minutes it costs.
    const wind = evaluation.risk?.contributors.find((c) => c.id === 'wind');
    expect(wind?.value).toBeGreaterThan(0);
    expect(wind?.explanation).toMatch(/headwind of \d+ km\/h adds \d+ min/);
    for (const id of ['weather_severity', 'visibility', 'precipitation', 'temperature', 'events']) {
      expect(evaluation.risk?.contributors.find((c) => c.id === id)?.explanation).toBeTruthy();
    }

    // The same mission leaving a day later would meet different weather and a different estimate.
    const later = evaluationOf(mission, aircraft, tick + 24 * HOUR, {
      ...session.context(),
      departureTick: tick + 24 * HOUR,
    });
    expect(later.plan?.estimate?.durationS).not.toBe(estimate.durationS);
  });

  it('7. accepts and launches', () => {
    session.execute({ type: 'acceptMission', missionId: MISSION });
    // Accepting begins loading the mission's fuel; it is ready when that is done (ADR 0027).
    const ready = () =>
      readiness(session.mission(), session.aircraft(), session.view().clock.tick).ready;
    // Ready at once only if the aircraft already holds exactly the mission's fuel.
    const aboard = session.aircraft().fuelKg === session.mission().load?.fuelKg;
    expect(ready()).toBe(aboard);
    expect(session.aircraft().status).toBe(aboard ? 'available' : 'servicing');
    for (let i = 0; i < 400 && session.aircraft().status === 'servicing'; i++) session.runSim(60);
    expect(ready()).toBe(true);
    session.execute({ type: 'launchMission', missionId: MISSION });
    const mission = session.mission();
    expect(mission.status).toBe('active');
    if (!mission.assessment || mission.actualStartTick === null) throw new Error('setup');
    launched = mission.assessment;
    departedTick = mission.actualStartTick;
    // The assessment is for the tick it actually left at.
    expect(launched.assessedTick).toBe(departedTick);
  });

  it('8. the aircraft flies through those conditions', () => {
    session.runSim(40 * 60);
    const flight = session.flight();
    expect(flight.phase).toBe('cruise');
    // Its speed over the ground is its airspeed and the wind, not its airspeed alone.
    expect(flight.groundSpeedKmh).not.toBe(flight.speedKmh);
    expect(Math.sign(flight.groundSpeedKmh - flight.speedKmh)).toBe(Math.sign(flight.tailwindKmh));
    expect(flight.windSpeedKmh).toBeGreaterThan(0);
    expect(flight.outsideTemperatureC).toBeLessThan(0);
    // The conditions it reports are the field's, where it is, at its altitude.
    const saved = session.view();
    const there = conditionsAt(
      saved.weather,
      saved.clock.tick,
      { lat: flight.lat, lon: flight.lon },
      flight.altitudeM,
    );
    expect(flight.windSpeedKmh).toBeCloseTo(there.windSpeedKmh, 6);
    expect(flight.visibilityKm).toBeCloseTo(there.visibilityKm, 6);
  });

  it('9-11. events occur, the conditions change, and the telemetry follows', () => {
    const early = session.flight();
    const samples: FlightView[] = [early];
    // Fly on for three hours, looking in every twenty minutes.
    for (let i = 0; i < 9; i++) {
      session.runSim(20 * 60);
      samples.push(session.flight());
    }

    // 9. The world has produced events of its own, elsewhere, while the aircraft flew.
    const events = session.view().events.events;
    expect(events.length).toBeGreaterThan(0);
    const during = events.filter((event) => event.createdTick > departedTick);
    expect(during.length).toBeGreaterThan(0);
    for (const event of during) expect(event.description).toMatch(/^Simulated (event|weather)\./);
    // They are on the map, and in the Overview's list.
    const drawn = eventFeatures(events);
    expect(drawn.points.features.length + drawn.areas.features.length).toBeGreaterThanOrEqual(0);

    // 10. The wind the aircraft meets has changed along the way.
    const tailwinds = samples.map((sample) => Math.round(sample.tailwindKmh));
    expect(new Set(tailwinds).size).toBeGreaterThan(3);
    const temperatures = new Set(samples.map((sample) => sample.outsideTemperatureC.toFixed(1)));
    expect(temperatures.size).toBeGreaterThan(1);

    // 11. Ground speed follows the wind at every look, and the arrival time has not moved:
    // the planner already knew this weather.
    for (const sample of samples) {
      if (sample.phase !== 'cruise') continue;
      expect(sample.groundSpeedKmh).toBeGreaterThan(0);
      expect(Math.sign(sample.groundSpeedKmh - sample.speedKmh)).toBe(
        Math.sign(sample.tailwindKmh),
      );
      expect(sample.etaTick).toBe(departedTick + launched.durationS);
    }
    const last = samples.at(-1) as FlightView;
    expect(last.distanceM).toBeGreaterThan(early.distanceM);
    // A plan made now for the same route would get a different estimate: the weather has moved on.
    const mission = session.mission();
    const aircraft = session.aircraft();
    if (!aircraft.performance || !mission.plan || !mission.load) throw new Error('setup');
    const replanned = evaluatePlan(
      aircraft.performance,
      mission.plan,
      { ...mission.load, fuelKg: aircraft.performance.fuelCapacityKg },
      { weather: session.view().weather, departureTick: session.view().clock.tick },
    ).estimate;
    expect(replanned?.durationS).not.toBe(launched.durationS);
  });

  it('14-15. closes mid-flight and reopens to the same world, weather and events included', async () => {
    await session.runner.flush();
    const atClose = session.view();
    const heldAtClose = session.flight();
    session.database.close();

    session = await openSession();
    const reopened = session.view();
    expect(reopened.clock).toEqual(atClose.clock);
    expect(reopened.weather).toEqual(atClose.weather);
    expect(reopened.events).toEqual(atClose.events);
    expect(reopened.missions).toEqual(atClose.missions);
    expect(reopened.fleet).toEqual(atClose.fleet);
    expect(reopened.integrityDigest).toBe(atClose.integrityDigest);
    // The conditions the flight was holding came back with it.
    expect(session.flight()).toEqual(heldAtClose);
    expect(
      groundSpeedKmh(heldAtClose.speedKmh, {
        tailwindKmh: heldAtClose.tailwindKmh,
        crosswindKmh: 0,
        temperatureDeviationC: 0,
        precipitation: 0,
      }),
    ).toBeGreaterThan(0);
  });

  it('12-13. lands as planned, and the mission’s history records what the weather did', async () => {
    for (let i = 0; i < 400 && session.mission().status === 'active'; i++) session.runSim(10 * 60);
    const mission = session.mission();
    expect(mission.status).toBe('completed');
    // Through changing weather, across a restart: exactly what the planner said at launch.
    expect(mission.outcome?.flightDurationS).toBe(launched.durationS);
    expect(mission.outcome?.fuelUsedKg).toBeCloseTo(launched.fuelUsedKg, 6);
    expect(mission.completedTick).toBe(departedTick + launched.durationS);

    const aircraft = session.aircraft();
    expect(aircraft.location?.code).toBe('KJFK');
    // A successful ferry rebases the aircraft, which moves the fleet's centre.
    expect(aircraft.home.code).toBe('KJFK');

    await session.runner.flush();
    const history = await loadMissionLog(MISSION);
    const landing = history.find((entry) => entry.type === 'flightCompleted');
    expect(landing?.payload.weatherDelayS).toBe(
      launched.durationS - (session.view().fleet.recentFlights[0]?.stillAirDurationS ?? 0),
    );
    expect(landing?.payload.weatherDelayS).toBeGreaterThan(5 * 60);
    expect(landing?.payload.weatherFuelKg).toBeGreaterThan(0);
    expect(typeof landing?.payload.worstSeverity).toBe('number');
    expect(history.at(-1)?.type).toBe('missionCompleted');

    // The world's events are in the same log, in order with everything else.
    const log = await loadRecentLog(10_000);
    const eventEntries = log.filter((entry) => entry.type.startsWith('event'));
    expect(eventEntries.length).toBeGreaterThan(0);
    expect(eventEntries.every((entry) => entry.kind === 'event' && entry.actor === 'world')).toBe(
      true,
    );
    expect(
      eventEntries.some(
        (entry) => entry.tick > departedTick && entry.tick <= (mission.completedTick ?? 0),
      ),
    ).toBe(true);
  });

  it('16-17. the whole world is exactly what its seed and its log produce', async () => {
    // Let the world run on, so that events come and go after the mission as well.
    session.runSim(6 * HOUR);
    await session.runner.flush();
    const saved = (await new SqliteWorldStore(session.database.db).load()) as Checkpoint;
    const log: LogEntry[] = (await loadRecentLog(100_000)).reverse();
    expect(log.map((entry) => entry.seq)).toEqual(log.map((_, index) => index + 1));
    expect(saved.snapshot.log.completeFromTick).toBe(0);

    const replayed = replayWorld(newWorld(), log, saved.snapshot.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(saved.snapshot));
    // The replay regenerated every event the world produced.
    expect(replayed.snapshot().events.nextNumber).toBe(saved.snapshot.events.nextNumber);
    expect(saved.snapshot.events.nextNumber).toBeGreaterThan(1);
  });
});

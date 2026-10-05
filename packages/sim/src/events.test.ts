import {
  EVENT_GENERATION,
  SEVERE_WEATHER,
  RngStreams,
  conditionsAt,
  generatePlan,
  weatherModel,
  type Rng,
  type RoutePoint,
  type WorldEvent,
} from '@aegis/domain';
import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine';
import { Events, type AffectableMission, type EventsWorld } from './events';
import { CommandRejected, type AircraftState } from './fleet';
import type { LogEntry } from './log';
import { defaultConfiguration } from './missions';
import { replayComparable, replayWorld } from './replay';
import { FIXTURES, fixtureLaunch, fixtureOrder } from './testing';
import { SIM_MODEL_VERSION } from './world';

const { places, models } = FIXTURES;
const WEATHER = weatherModel('events-unit', FIXTURES.epoch);
const TRANSPORT = 'AEGIS-TR-001';
const JET = 'AEGIS-FT-001';
const HOUR = 3600;

const event = (overrides: Partial<WorldEvent>): WorldEvent => ({
  id: 'EVT-000001',
  type: 'aerodrome_closure',
  status: 'scheduled',
  source: 'generated',
  severity: 0.6,
  createdTick: 0,
  startTick: 100,
  endTick: 500,
  place: places.exeter,
  centre: null,
  radiusM: null,
  aircraftId: null,
  missionId: null,
  title: 'Aerodrome closure: Exeter (EGTE)',
  description: 'Simulated event.',
  ...overrides,
});

/** Runs an `Events` subsystem against a stand-in world, recording what it emits and asks for. */
function harness(
  initial: readonly WorldEvent[],
  overrides: Partial<EventsWorld> = {},
  /** Lets event generation run, for tests that step across its ticks. */
  streams: RngStreams | null = null,
) {
  const events = new Events({ events: initial, nextNumber: initial.length + 1 });
  const emitted: { type: string; subject: object; payload: Record<string, unknown> }[] = [];
  const asked: string[] = [];
  const world: EventsWorld = {
    weather: WEATHER,
    places: () => [],
    groundedAircraft: () => [],
    aircraftById: () => undefined,
    flagMaintenanceDue: () => false,
    offerUrgentDelivery: (e) => {
      asked.push(`delivery:${e.id}`);
      return 'MSN-000009';
    },
    affectableMissions: () => [],
    ...overrides,
  };
  const neverRolls = (() => {
    throw new Error('no random stream should be used');
  }) as unknown as (stream: string) => Rng;
  const step = (tick: number) => {
    events.step(
      tick,
      world,
      streams ? (name) => streams.stream(name) : neverRolls,
      (type, subject, payload) => emitted.push({ type, subject, payload: { ...payload } }),
    );
  };
  const only = () => events.snapshot().events[0] as WorldEvent;
  return { events, emitted, asked, step, only };
}

/** Ticks that are not a generation or weather-check boundary, so only the lifecycle runs. */
const quiet = (tick: number) => tick + 1;

describe('event lifecycle in the simulation', () => {
  it('starts a scheduled event at its start tick and resolves it at its end tick', () => {
    const h = harness([event({})]);
    h.step(quiet(98));
    expect(h.only().status).toBe('scheduled');
    h.step(quiet(99));
    expect(h.only().status).toBe('active');
    h.step(quiet(498));
    expect(h.only().status).toBe('active');
    h.step(quiet(499));
    expect(h.only().status).toBe('resolved');
    expect(h.emitted.map((e) => [e.type, e.payload.eventId])).toEqual([
      ['eventStarted', 'EVT-000001'],
      ['eventResolved', 'EVT-000001'],
    ]);
  });

  it('lists only announced and active events as open', () => {
    const h = harness([
      event({ id: 'EVT-000001', status: 'resolved' }),
      event({ id: 'EVT-000002', status: 'scheduled' }),
      event({ id: 'EVT-000003', status: 'active' }),
    ]);
    expect(h.events.open().map((e) => e.id)).toEqual(['EVT-000002', 'EVT-000003']);
    expect(h.events.view().events.map((e) => e.id)).toEqual([
      'EVT-000003',
      'EVT-000002',
      'EVT-000001',
    ]);
  });

  it('refuses saved events that make no sense', () => {
    expect(() => new Events({ events: [event({ endTick: 50 })], nextNumber: 2 })).toThrow(
      /EVT-000001 is invalid/,
    );
    expect(() => new Events({ events: [event({ severity: 1.5 })], nextNumber: 2 })).toThrow();
    expect(() => new Events({ events: [], nextNumber: 0 })).toThrow(/counter/);
  });

  it('asks for an urgent delivery when a logistics disruption starts, and remembers it', () => {
    const h = harness([event({ type: 'logistics_disruption', title: 'Logistics disruption' })]);
    h.step(quiet(99));
    expect(h.asked).toEqual(['delivery:EVT-000001']);
    expect(h.only()).toMatchObject({ status: 'active', missionId: 'MSN-000009' });
    expect(h.emitted[0]).toMatchObject({
      type: 'eventStarted',
      subject: { missionId: 'MSN-000009' },
    });
  });

  it('keeps a maintenance finding open until the aircraft has been maintained', () => {
    let status: AircraftState['status'] = 'maintenance_due';
    const h = harness(
      [
        event({
          type: 'maintenance_finding',
          status: 'active',
          place: null,
          aircraftId: TRANSPORT,
          startTick: 10,
          endTick: 10,
        }),
      ],
      { aircraftById: () => ({ status }) as AircraftState },
    );
    h.step(quiet(5000));
    expect(h.only().status).toBe('active');
    status = 'in_maintenance';
    h.step(quiet(6000));
    expect(h.only().status).toBe('active');
    status = 'available';
    h.step(quiet(30_000));
    expect(h.only().status).toBe('resolved');
    expect(h.emitted.at(-1)).toMatchObject({
      type: 'eventResolved',
      subject: { aircraftId: TRANSPORT },
    });
  });
});

describe('events and missions already committed', () => {
  const toExeter = generatePlan(models.transport, places.newquay, places.exeter);
  const mission = (overrides: Partial<AffectableMission>): AffectableMission => ({
    missionId: 'MSN-000001',
    aircraftId: TRANSPORT,
    flightId: 'FLT-000001',
    active: true,
    plan: toExeter,
    ...overrides,
  });
  const affected = (h: ReturnType<typeof harness>) =>
    h.emitted.filter((e) => e.type === 'missionAffected');

  it('records on a flying mission that its destination is closing, and lets it land', () => {
    const h = harness([event({})], { affectableMissions: () => [mission({})] });
    h.step(quiet(99));
    expect(affected(h)).toHaveLength(1);
    expect(affected(h)[0]).toMatchObject({
      subject: { missionId: 'MSN-000001', aircraftId: TRANSPORT, flightId: 'FLT-000001' },
      payload: {
        eventId: 'EVT-000001',
        summary: 'Exeter is closing; the flight is already airborne and will be accepted.',
      },
    });
  });

  it('records a disrupted area on a flying mission’s route, and not on a route elsewhere', () => {
    const disruption = event({
      type: 'navigation_disruption',
      title: 'Navigation disruption near Exeter',
      place: null,
      centre: { name: 'Area', lat: 50.6, lon: -4.2 },
      radiusM: 60_000,
    });
    const elsewhere = generatePlan(models.fastJet, places.prestwick, places.prestwick);
    const h = harness([disruption], {
      affectableMissions: () => [
        mission({}),
        mission({
          missionId: 'MSN-000002',
          plan: { ...elsewhere, points: [places.prestwick, { ...places.prestwick, lat: 57 }] },
        }),
      ],
    });
    h.step(quiet(99));
    expect(affected(h).map((e) => e.subject)).toEqual([
      { missionId: 'MSN-000001', aircraftId: TRANSPORT, flightId: 'FLT-000001' },
    ]);
    expect(affected(h)[0]?.payload.summary).toMatch(/route passes through the area/);
  });

  it('does not record a start against a mission that is accepted but not flying', () => {
    const h = harness([event({})], { affectableMissions: () => [mission({ active: false })] });
    h.step(quiet(99));
    expect(affected(h)).toEqual([]);
  });
});

describe('severe weather read from the field', () => {
  /** A place and tick where the field really is severe, found by reading the field. */
  function findSevere(): { place: RoutePoint; tick: number } {
    for (let hour = 0; hour < 24 * 400; hour += 1) {
      for (let lat = 35; lat <= 60; lat += 5) {
        for (let lon = -30; lon <= 30; lon += 5) {
          const tick = hour * SEVERE_WEATHER.checkIntervalTicks;
          // Not an event-generation tick, so that nothing but the weather is read.
          if (tick % EVENT_GENERATION.intervalTicks === 0) continue;
          if (
            conditionsAt(WEATHER, tick, { lat, lon }, 0).severity >=
            SEVERE_WEATHER.threshold + 0.05
          ) {
            return {
              tick,
              place: { kind: 'aerodrome', name: 'Stormy Field', lat, lon, elevationM: 0 },
            };
          }
        }
      }
    }
    throw new Error('the field was never severe');
  }
  const severe = findSevere();
  const calm: RoutePoint = {
    kind: 'aerodrome',
    name: 'Calm Field',
    lat: -5,
    lon: 100,
    elevationM: 0,
  };

  it('raises an advisory where the field is severe, with no dice involved', () => {
    const h = harness([], { places: () => [calm, severe.place] });
    h.step(severe.tick);
    const advisory = h.only();
    expect(advisory).toMatchObject({
      id: 'EVT-000001',
      type: 'severe_weather',
      status: 'active',
      source: 'derived',
      startTick: severe.tick,
      endTick: severe.tick + SEVERE_WEATHER.holdS,
      radiusM: SEVERE_WEATHER.radiusM,
      title: 'Severe weather near Stormy Field',
    });
    expect(advisory.centre).toMatchObject({ lat: severe.place.lat, lon: severe.place.lon });
    expect(advisory.severity).toBeGreaterThanOrEqual(SEVERE_WEATHER.threshold);
    expect(h.emitted[0]).toMatchObject({ type: 'eventStarted' });
  });

  it('raises nothing where the field is not severe', () => {
    const h = harness([], { places: () => [calm] }, new RngStreams('calm'));
    for (let i = 0; i < 200; i++) h.step(i * SEVERE_WEATHER.checkIntervalTicks);
    expect(h.events.snapshot().events.filter((e) => e.type === 'severe_weather')).toEqual([]);
  });

  it('does not raise a second advisory for the same weather, and ends it when the weather passes', () => {
    const h = harness([], { places: () => [severe.place] }, new RngStreams('follow'));
    h.step(severe.tick);
    const advisory = () =>
      h.events.snapshot().events.find((e) => e.id === 'EVT-000001') as WorldEvent;
    const advisories = () => h.events.snapshot().events.filter((e) => e.type === 'severe_weather');
    // Follow it check by check until it has resolved.
    let tick = severe.tick;
    for (let i = 0; i < 2000 && advisory().status === 'active'; i++) {
      tick += SEVERE_WEATHER.checkIntervalTicks;
      h.step(tick);
      expect(advisories().filter((e) => e.status === 'active').length).toBeLessThanOrEqual(1);
    }
    expect(advisory().status).toBe('resolved');
    expect(advisories()).toHaveLength(1);
    // It lasted at least its hold period.
    expect(tick - severe.tick).toBeGreaterThanOrEqual(SEVERE_WEATHER.holdS);
    // By then the field there is no longer severe.
    expect(conditionsAt(WEATHER, tick, severe.place, 0).severity).toBeLessThan(
      SEVERE_WEATHER.threshold,
    );
  });
});

describe('events in the running world', () => {
  const newWorld = (seed: string) => ({ seed, epoch: FIXTURES.epoch });
  /** A world whose operating area is the two aerodromes its aircraft are at. */
  function world(seed = 'event-world'): SimulationEngine {
    const engine = SimulationEngine.create(newWorld(seed));
    engine.applyCommand({
      type: 'seedStarterFleet',
      aircraft: [
        fixtureOrder('fastJet', places.prestwick),
        fixtureOrder('transport', places.newquay),
      ],
    });
    engine.applyCommand({
      type: 'setOperatingArea',
      places: [places.newquay, places.prestwick, places.exeter],
    });
    return engine;
  }
  const eventsOf = (engine: SimulationEngine) => engine.snapshot().events.events;
  const log = (engine: SimulationEngine): readonly LogEntry[] => engine.snapshot().log.entries;
  const aircraftOf = (engine: SimulationEngine, id: string) =>
    engine.snapshot().fleet.aircraft.find((a) => a.id === id) as AircraftState;
  /** Steps until an event satisfying `wanted` exists, in ten-minute steps. */
  function runUntil(
    engine: SimulationEngine,
    wanted: (event: WorldEvent) => boolean,
    limitHours = 4000,
  ): WorldEvent {
    for (let i = 0; i < limitHours * 6; i++) {
      const found = eventsOf(engine).find(wanted);
      if (found) return found;
      engine.runSteps(600);
    }
    throw new Error('no such event occurred');
  }

  it('generates nothing in a world with no operating area', () => {
    const engine = SimulationEngine.create(newWorld('empty'));
    engine.runSteps(EVENT_GENERATION.intervalTicks * 100);
    expect(eventsOf(engine)).toEqual([]);
    expect(engine.snapshot().rngStreams['events.generation']).toBeUndefined();
  });

  it('announces a generated event, starts it and resolves it, logging each step', () => {
    const engine = world();
    const scheduled = runUntil(engine, (e) => e.source === 'generated' && e.status === 'scheduled');
    expect(scheduled.createdTick % EVENT_GENERATION.intervalTicks).toBe(0);
    expect(scheduled.startTick).toBeGreaterThan(scheduled.createdTick);

    engine.runSteps(scheduled.endTick - engine.clock.tick);
    expect(eventsOf(engine).find((e) => e.id === scheduled.id)?.status).toBe('resolved');
    const history = log(engine).filter(
      (entry) => entry.type.startsWith('event') && entry.payload.eventId === scheduled.id,
    );
    expect(history.map((entry) => [entry.type, entry.tick])).toEqual([
      ['eventScheduled', scheduled.createdTick],
      ['eventStarted', scheduled.startTick],
      ['eventResolved', scheduled.endTick],
    ]);
    expect(history.every((entry) => entry.kind === 'event' && entry.actor === 'world')).toBe(true);
  });

  it('never has more than three generated events open, however long the world runs', () => {
    const engine = world('crowd');
    let most = 0;
    // Six simulated days: a couple of dozen events, without being slow on a busy machine.
    for (let i = 0; i < 24 * 6; i++) {
      engine.runSteps(HOUR);
      most = Math.max(
        most,
        engine
          .eventsView()
          .events.filter(
            (e) => e.source === 'generated' && (e.status === 'scheduled' || e.status === 'active'),
          ).length,
      );
    }
    expect(most).toBeLessThanOrEqual(EVENT_GENERATION.maxOpen);
    expect(most).toBeGreaterThan(0);
    expect(engine.snapshot().events.nextNumber).toBeGreaterThan(10);
    expect(engine.snapshot().events.nextNumber).toBeLessThan(200);
  }, 30_000);

  it('refuses a launch from a closed aerodrome, leaves the world untouched, and allows it after', () => {
    const engine = world('closure');
    const closure = runUntil(
      engine,
      (e) => e.type === 'aerodrome_closure' && e.status === 'active' && e.place?.code === 'EGHQ',
    );
    const launch = () =>
      engine.applyCommand(
        fixtureLaunch(TRANSPORT, models.transport, places.newquay, places.exeter),
      );
    const before = engine.snapshot();
    expect(launch).toThrow(CommandRejected);
    expect(launch).toThrow(/Newquay is closed to departures \(EVT-\d+\)/);
    expect(engine.snapshot()).toEqual(before);
    expect(aircraftOf(engine, TRANSPORT).status).toBe('available');

    // The other aerodrome is unaffected, and Newquay reopens when the closure ends.
    engine.runSteps(closure.endTick - engine.clock.tick);
    expect(eventsOf(engine).find((e) => e.id === closure.id)?.status).toBe('resolved');
    const stillClosed = eventsOf(engine).some(
      (e) => e.type === 'aerodrome_closure' && e.status === 'active' && e.place?.code === 'EGHQ',
    );
    if (!stillClosed) expect(launch()).toBe(true);
  });

  it('refuses to accept a mission that departs from a closed aerodrome', () => {
    const engine = world('closure');
    runUntil(
      engine,
      (e) => e.type === 'aerodrome_closure' && e.status === 'active' && e.place?.code === 'EGHQ',
    );
    engine.applyCommand({
      type: 'createMission',
      missionType: 'training',
      ...defaultConfiguration(
        'training',
        {
          shape: 'out_and_back',
          destination: null,
          target: { name: 'Area', lat: 49.4, lon: -7.2 },
          orbitRadiusM: 25_000,
          holdS: 0,
          payloadKg: 0,
        },
        aircraftOf(engine, TRANSPORT),
        { context: engine.planContext() },
      ),
    });
    const created = engine.snapshot().missions.missions.at(-1)?.id as string;
    expect(() => engine.applyCommand({ type: 'acceptMission', missionId: created })).toThrow(
      /closed to departures/,
    );
    expect(engine.snapshot().missions.missions.at(-1)?.status).toBe('planned');
  });

  it('does not touch an aircraft that is already airborne when its destination closes', () => {
    // A long way round to Exeter, flown slowly, so the flight outlasts any notice period.
    const longWay = {
      points: [
        places.newquay,
        { kind: 'waypoint' as const, name: 'WP1', lat: 46.5, lon: -10, elevationM: 0 },
        places.exeter,
      ],
      cruiseAltitudeM: models.transport.cruiseAltitudeM,
      cruiseSpeedKmh: 420,
    };
    let checked = false;
    for (const seed of ['inbound-a', 'inbound-b', 'inbound-c', 'inbound-d', 'inbound-e']) {
      // Learn, from a world left alone, when a closure of Exeter will be announced.
      const future = runUntil(
        world(seed),
        (e) => e.type === 'aerodrome_closure' && e.place?.code === 'EGTE',
      );
      // In the same world, send the transport there before the closure is known.
      const engine = world(seed);
      engine.runSteps(future.createdTick - 600 - engine.clock.tick);
      if (aircraftOf(engine, TRANSPORT).status !== 'available') continue;
      engine.applyCommand({
        type: 'launchFlight',
        aircraftId: TRANSPORT,
        plan: longWay,
        load: { fuelKg: 40_000, payloadKg: 0 },
      });
      const closure = runUntil(
        engine,
        (e) => e.type === 'aerodrome_closure' && e.place?.code === 'EGTE',
      );
      // The launch did not change what the world went on to do.
      expect(closure).toMatchObject({ id: future.id, startTick: future.startTick });

      engine.runSteps(closure.startTick - engine.clock.tick);
      expect(aircraftOf(engine, TRANSPORT).status).toBe('in_flight');
      for (let i = 0; i < 4000 && aircraftOf(engine, TRANSPORT).status === 'in_flight'; i++) {
        engine.runSteps(60);
      }
      // The closure began while it was airborne; it landed there all the same.
      expect(aircraftOf(engine, TRANSPORT)).toMatchObject({
        status: 'available',
        location: places.exeter,
      });
      const flight = engine.snapshot().fleet.flights[0];
      expect(flight?.status).toBe('completed');
      expect(flight?.arrivedTick).toBeGreaterThan(closure.startTick);
      checked = true;
      break;
    }
    expect(checked).toBe(true);
  }, 60_000);

  it('grounds an aircraft on a maintenance finding until it has been maintained', () => {
    const engine = world('finding');
    const finding = runUntil(engine, (e) => e.type === 'maintenance_finding');
    const id = finding.aircraftId as string;
    expect(finding.status).toBe('active');
    expect(aircraftOf(engine, id).status).toBe('maintenance_due');
    expect(() =>
      engine.applyCommand(
        id === TRANSPORT
          ? fixtureLaunch(TRANSPORT, models.transport, places.newquay, places.exeter)
          : fixtureLaunch(JET, models.fastJet, places.prestwick, places.newquay),
      ),
    ).toThrow(/not available \(maintenance due\)/);

    engine.applyCommand({ type: 'startMaintenance', aircraftId: id });
    engine.runSteps(7 * HOUR);
    expect(aircraftOf(engine, id).status).toBe('available');
    expect(eventsOf(engine).find((e) => e.id === finding.id)?.status).toBe('resolved');
  });

  it('turns a logistics disruption into an urgent opportunity that names the event', () => {
    const engine = world('logistics');
    const disruption = runUntil(
      engine,
      (e) => e.type === 'logistics_disruption' && e.status === 'active' && e.missionId !== null,
    );
    const offer = engine
      .snapshot()
      .missions.missions.find((mission) => mission.id === disruption.missionId);
    expect(offer).toMatchObject({
      type: 'emergency_response',
      source: 'generated',
      priority: 'urgent',
      brief: { shape: 'point_to_point', destination: disruption.place },
    });
    expect(offer?.description).toContain(disruption.id);
    expect(offer?.brief.payloadKg).toBeGreaterThan(0);
    expect(offer?.completeByTick).toBeGreaterThan(disruption.endTick);
  });

  it('produces the same events at the same ticks from the same seed and commands', () => {
    const run = () => {
      const engine = world('same-events');
      engine.runSteps(HOUR * 24 * 6);
      return engine.snapshot();
    };
    const first = run();
    expect(first.events.events.length).toBeGreaterThan(3);
    expect(run()).toEqual(first);
    const other = world('other-events');
    other.runSteps(HOUR * 24 * 6);
    expect(other.snapshot().events.events).not.toEqual(first.events.events);
  }, 30_000);

  it('gives the same world whether steps run one at a time or in large batches', () => {
    const run = (batch: number) => {
      const engine = world('batched-events');
      const end = HOUR * 30;
      while (engine.clock.tick < end) engine.runSteps(Math.min(batch, end - engine.clock.tick));
      return engine.snapshot();
    };
    expect(run(1)).toEqual(run(4321));
  }, 30_000);

  it('re-derives events, their consequences and the weather from the seed and the log', () => {
    const engine = world('replayed-events');
    engine.runSteps(HOUR * 5);
    // A flight through the weather, launched part way through.
    engine.applyCommand(
      fixtureLaunch(JET, models.fastJet, places.prestwick, places.newquay, 0, engine.planContext()),
    );
    engine.runSteps(HOUR * 24 * 3);
    expect(eventsOf(engine).length).toBeGreaterThan(0);

    const replayed = replayWorld(newWorld('replayed-events'), log(engine), engine.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(engine.snapshot()));
    expect(log(replayed)).toEqual(log(engine));
  }, 30_000);

  it('restores events and carries on identically', () => {
    const run = (interrupt: boolean) => {
      let engine = world('restored-events');
      engine.runSteps(HOUR * 40);
      if (interrupt) {
        engine = SimulationEngine.restore(
          JSON.parse(JSON.stringify(engine.snapshot())) as ReturnType<SimulationEngine['snapshot']>,
        );
      }
      engine.runSteps(HOUR * 40);
      return engine.snapshot();
    };
    expect(run(true)).toEqual(run(false));
  }, 30_000);

  it('gives a world saved before events existed none, and starts its replay at the upgrade', () => {
    const engine = world('old');
    engine.runSteps(900);
    const old = Object.fromEntries(
      Object.entries(engine.snapshot()).filter(([key]) => key !== 'events'),
    );
    const upgraded = SimulationEngine.restore({ ...old, modelVersion: 3 } as never);
    expect(upgraded.snapshot().events).toEqual({ events: [], nextNumber: 1 });
    expect(upgraded.snapshot().modelVersion).toBe(SIM_MODEL_VERSION);
    // What was logged under the old rules is kept, but replay starts here.
    expect(upgraded.snapshot().log.completeFromTick).toBe(900);
    expect(upgraded.snapshot().log.entries.length).toBe(engine.snapshot().log.entries.length);
  });
});

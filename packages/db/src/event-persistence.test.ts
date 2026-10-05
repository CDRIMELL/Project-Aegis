import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RECENT_EVENTS,
  SimulationEngine,
  SimulationRunner,
  replayComparable,
  replayWorld,
  type Checkpoint,
  type LogEntry,
  type WorldCommand,
} from '@aegis/sim';
import type { WorldEvent } from '@aegis/domain';
import {
  FIXTURES,
  ManualHostClock,
  fixtureLaunch,
  fixtureLaunchFull,
  fixtureOrder,
  launchFuelled,
} from '@aegis/sim/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNodeDatabase, type NodeDatabase } from './node';
import { SqliteWorldStore, WorldStorageError } from './world-store';

const { places, models } = FIXTURES;
const newWorld = () => ({ seed: 'persisted-events', epoch: FIXTURES.epoch });
const HOUR = 3600;
const AREA = [places.newquay, places.prestwick, places.exeter];
const SEED_FLEET: WorldCommand = {
  type: 'seedStarterFleet',
  aircraft: [fixtureOrder('fastJet', places.prestwick), fixtureOrder('transport', places.newquay)],
};
const SET_AREA: WorldCommand = {
  type: 'setOperatingArea',
  places: AREA,
  centre: { lat: 53, lon: -4.8 },
};

/** A world that has run for some days, with events in several states and a flight in the air. */
function eventfulWorld(): SimulationEngine {
  const engine = SimulationEngine.create(newWorld());
  engine.applyCommand(SEED_FLEET);
  engine.applyCommand(SET_AREA);
  engine.runSteps(HOUR * 24 * 3);
  const jet = engine.snapshot().fleet.aircraft.find((a) => a.id === 'AEGIS-FT-001');
  if (jet?.status === 'available') {
    try {
      launchFuelled(
        engine,
        fixtureLaunch(
          'AEGIS-FT-001',
          models.fastJet,
          places.prestwick,
          places.newquay,
          0,
          engine.planContext(),
        ),
      );
    } catch {
      // A closure at that moment refuses the launch; the world is as eventful without it.
    }
  }
  engine.runSteps(900);
  return engine;
}
const checkpoint = (engine: SimulationEngine, seq = 1): Checkpoint => ({
  seq,
  wallTimeMs: 1_800_000_000_000 + seq,
  snapshot: engine.snapshot(),
});

describe('event and environment persistence', () => {
  let database: NodeDatabase;
  let store: SqliteWorldStore;
  const all = (sql: string) => database.transport.connection.prepare(sql).all();
  const exec = (sql: string) => () => {
    database.transport.connection.exec(sql);
  };

  beforeEach(() => {
    database = openNodeDatabase(':memory:');
    store = new SqliteWorldStore(database.db);
  });
  afterEach(() => {
    database.close();
  });

  it('round-trips events, the area centre and a flight’s weather exactly', async () => {
    const engine = eventfulWorld();
    const saved = checkpoint(engine);
    expect(saved.snapshot.events.events.length).toBeGreaterThan(2);
    await store.save(saved);
    const loaded = await store.load();
    expect(loaded).toEqual(saved);
    expect(loaded?.snapshot.missions.areaCentre).toEqual({ lat: 53, lon: -4.8 });
    expect(loaded?.snapshot.events.nextNumber).toBe(saved.snapshot.events.nextNumber);
  });

  it('stores an event as columns that can be queried', async () => {
    const engine = eventfulWorld();
    await store.save(checkpoint(engine));
    const rows = all(
      'SELECT id, type, status, source, start_tick, end_tick FROM sim_event ORDER BY id',
    );
    expect(rows).toEqual(
      engine.snapshot().events.events.map((event) => ({
        id: event.id,
        type: event.type,
        status: event.status,
        source: event.source,
        start_tick: event.startTick,
        end_tick: event.endTick,
      })),
    );
    expect(all('SELECT area_centre_lat AS lat, next_event_number AS n FROM sim_world')).toEqual([
      { lat: 53, n: engine.snapshot().events.nextNumber },
    ]);
  });

  it('keeps the held conditions of a flight in the air, so it resumes in the same weather', async () => {
    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand(SEED_FLEET);
    launchFuelled(
      engine,
      fixtureLaunch(
        'AEGIS-TR-001',
        models.transport,
        places.newquay,
        places.akrotiri,
        0,
        engine.planContext(),
      ),
    );
    // Mid-minute, so the held sample matters.
    engine.runSteps(4030);
    await store.save(checkpoint(engine));
    const loaded = (await store.load()) as Checkpoint;
    const flight = loaded.snapshot.fleet.flights[0];
    expect(flight?.progress.environment).toEqual(
      engine.snapshot().fleet.flights[0]?.progress.environment,
    );
    expect(flight?.stillAirDurationS).toBeGreaterThan(0);
    expect(all('SELECT still_air_duration_s AS s FROM sim_flight')).toEqual([
      { s: flight?.stillAirDurationS },
    ]);

    const restored = SimulationEngine.restore(loaded.snapshot);
    engine.runSteps(20_000);
    restored.runSteps(20_000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(restored.snapshot().fleet.flights[0]?.status).toBe('completed');
  });

  it('loads a flight saved before the environment existed as one in still air', async () => {
    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand(SEED_FLEET);
    launchFuelled(
      engine,
      fixtureLaunch('AEGIS-TR-001', models.transport, places.newquay, places.akrotiri),
    );
    engine.runSteps(100);
    await store.save(checkpoint(engine));
    // As a model-3 database held it: no conditions in the progress, no still-air estimate.
    exec(`UPDATE sim_flight SET still_air_duration_s = NULL, still_air_fuel_used_kg = NULL,
          progress = json_remove(progress, '$.environment', '$.exposure')`)();
    const flight = (await store.load())?.snapshot.fleet.flights[0];
    expect(flight?.progress.environment).toEqual({
      tailwindKmh: 0,
      crosswindKmh: 0,
      temperatureDeviationC: 0,
      precipitation: 0,
    });
    expect(flight?.progress.exposure.lowestVisibilityKm).toBeNull();
    expect(flight?.stillAirDurationS).toBeNull();
  });

  it('replaces the operating area whole when it changes, and leaves it alone when it does not', async () => {
    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand(SEED_FLEET);
    engine.applyCommand(SET_AREA);
    await store.save(checkpoint(engine, 1));
    exec(`UPDATE sim_place SET name = 'marker' WHERE ordinal = 0`)();
    // An unchanged area is not rewritten: the marker survives.
    await store.save(checkpoint(engine, 2));
    expect(all('SELECT name FROM sim_place WHERE ordinal = 0')).toEqual([{ name: 'marker' }]);

    engine.applyCommand({
      type: 'setOperatingArea',
      places: [places.akrotiri, places.exeter],
      centre: { lat: 40, lon: 15 },
    });
    await store.save(checkpoint(engine, 3));
    expect(all('SELECT ordinal, code FROM sim_place ORDER BY ordinal')).toEqual([
      { ordinal: 0, code: 'LCRA' },
      { ordinal: 1, code: 'EGTE' },
    ]);
    expect((await store.load())?.snapshot.missions).toMatchObject({
      places: [places.akrotiri, places.exeter],
      areaCentre: { lat: 40, lon: 15 },
    });
  });

  it('enforces event rules in the database', async () => {
    await store.save(checkpoint(eventfulWorld()));
    expect(exec(`UPDATE sim_event SET status = 'pending'`)).toThrow(/sim_event_status_known/);
    expect(exec(`UPDATE sim_event SET type = 'air_raid'`)).toThrow(/sim_event_type_known/);
    expect(exec(`UPDATE sim_event SET severity = 1.2`)).toThrow(/sim_event_severity_range/);
    expect(exec(`UPDATE sim_event SET end_tick = start_tick - 1`)).toThrow(
      /sim_event_ends_after_start/,
    );
    expect(exec(`UPDATE sim_event SET radius_m = 5 WHERE centre IS NULL`)).toThrow(
      /sim_event_area_complete/,
    );
  });

  it('refuses to load an event whose stored place is not a place', async () => {
    await store.save(checkpoint(eventfulWorld()));
    exec(`UPDATE sim_event SET place = '{"kind":"harbour"}' WHERE place IS NOT NULL`)();
    await expect(store.load()).rejects.toThrow(WorldStorageError);
  });

  it('keeps every event on disk and loads only recent history', async () => {
    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand(SEED_FLEET);
    const base = engine.snapshot();
    const total = RECENT_EVENTS + 25;
    // A long history of finished closures, and one still open, as the engine would hand them over.
    const history: WorldEvent[] = Array.from({ length: total }, (_, index) => ({
      id: 'EVT-' + String(index + 1).padStart(6, '0'),
      type: 'aerodrome_closure',
      status: index === total - 1 ? 'active' : 'resolved',
      source: 'generated',
      severity: 0.5,
      createdTick: index * 100,
      startTick: index * 100 + 10,
      endTick: index * 100 + 60,
      place: places.exeter,
      centre: null,
      radiusM: null,
      aircraftId: null,
      missionId: null,
      title: 'Aerodrome closure: Exeter (EGTE)',
      description: 'Simulated event.',
    }));
    await store.save({
      seq: 1,
      wallTimeMs: 1_800_000_000_000,
      snapshot: { ...base, events: { events: history, nextNumber: total + 1 } },
    });

    expect(all('SELECT count(*) AS n FROM sim_event')).toEqual([{ n: total }]);
    const loaded = (await store.load())?.snapshot.events;
    expect(loaded?.nextNumber).toBe(total + 1);
    expect(loaded?.events.filter((event) => event.status === 'resolved')).toHaveLength(
      RECENT_EVENTS,
    );
    expect(loaded?.events.filter((event) => event.status === 'active')).toHaveLength(1);
    // The oldest finished events stay on disk and out of memory; the engine restores without them.
    expect(loaded?.events[0]?.id).toBe('EVT-000025');
    expect(() => SimulationEngine.restore({ ...base, events: loaded as never })).not.toThrow();
  });
});

describe('environment and events across application restarts', () => {
  let directory: string;
  let path: string;
  const open: NodeDatabase[] = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-events-'));
    path = join(directory, 'aegis.db');
  });
  afterEach(() => {
    for (const database of open.splice(0)) {
      if (database.transport.connection.isOpen) database.close();
    }
    rmSync(directory, { recursive: true, force: true });
  });

  async function launchApp() {
    const database = openNodeDatabase(path);
    open.push(database);
    const host = new ManualHostClock();
    const runner = await SimulationRunner.open({
      store: new SqliteWorldStore(database.db),
      host,
      newWorld,
    });
    return { database, host, runner };
  }
  type Session = Awaited<ReturnType<typeof launchApp>>;
  function run(session: Session, realMs: number): void {
    for (let elapsed = 0; elapsed < realMs; elapsed += 100) {
      session.host.elapse(100);
      session.runner.advance();
    }
  }
  function wholeLog(session: Session): LogEntry[] {
    return session.database.transport.connection
      .prepare('SELECT * FROM sim_log ORDER BY seq')
      .all()
      .map((row) => ({
        seq: row.seq as number,
        tick: row.tick as number,
        kind: row.kind as LogEntry['kind'],
        type: row.type as string,
        actor: row.actor as LogEntry['actor'],
        missionId: row.mission_id as string | null,
        aircraftId: row.aircraft_id as string | null,
        flightId: row.flight_id as string | null,
        payload: JSON.parse(row.payload as string) as LogEntry['payload'],
      }));
  }

  it('closes mid-flight under weather and reopens to the same world, events and all', async () => {
    const first = await launchApp();
    first.runner.execute({ type: 'setSpeed', speed: 100 });
    first.runner.execute(SEED_FLEET);
    first.runner.execute(SET_AREA);
    // Twelve simulated hours, so that events exist.
    run(first, (12 * HOUR * 1000) / 100);
    // With the fuel it was acquired with: nothing has to be loaded first (ADR 0027).
    first.runner.execute(
      fixtureLaunchFull('AEGIS-TR-001', models.transport, places.newquay, places.akrotiri),
    );
    run(first, 60_000);
    await first.runner.flush();
    const atClose = first.runner.view();
    expect(atClose.fleet.activeFlights).toHaveLength(1);
    first.database.close();

    const second = await launchApp();
    const reopened = second.runner.view();
    expect(reopened.clock).toEqual(atClose.clock);
    expect(reopened.events).toEqual(atClose.events);
    expect(reopened.fleet).toEqual(atClose.fleet);
    expect(reopened.weather).toEqual(atClose.weather);

    run(second, 150_000);
    await second.runner.flush();
    const flight = second.runner.view().fleet.recentFlights[0];
    expect(flight?.status).toBe('completed');
    // It landed exactly as the planner said it would, through the weather, across the restart.
    expect(flight?.progress.elapsedS).toBe(flight?.estimatedDurationS);

    const saved = (await new SqliteWorldStore(second.database.db).load()) as Checkpoint;
    const replayed = replayWorld(newWorld(), wholeLog(second), saved.snapshot.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(saved.snapshot));
  }, 60_000);
});

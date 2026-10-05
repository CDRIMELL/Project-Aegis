import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MISSION_TEMPLATES,
  defaultBrief,
  generatePlan,
  type RoutePoint,
  type WorldEvent,
} from '@aegis/domain';
import {
  SIM_MODEL_VERSION,
  SimulationEngine,
  defaultConfiguration,
  type Checkpoint,
} from '@aegis/sim';
import { FIXTURES, fixtureOrder } from '@aegis/sim/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_FOLDER, NodeSqliteTransport, migrate, openNodeDatabase } from './node';
import { SqliteWorldStore, WorldStorageError } from './world-store';

/*
 * In-flight control on disk (ADR 0026): revisions, holds, cautions and aborted missions survive a
 * restart exactly, and migration 0008 carries an existing world across without loss.
 */

const { places, models } = FIXTURES;
const TRANSPORT = 'AEGIS-TR-001';
const HOUR = 3600;
const ROME: RoutePoint = {
  kind: 'aerodrome',
  refId: 'fixture:lirf',
  name: 'Rome',
  code: 'LIRF',
  lat: 41.8003,
  lon: 12.2389,
  elevationM: 5,
};

function world(seed = 'inflight-persisted'): SimulationEngine {
  const engine = SimulationEngine.create({ seed, epoch: FIXTURES.epoch });
  engine.applyCommand({
    type: 'seedStarterFleet',
    aircraft: [
      fixtureOrder('fastJet', places.prestwick),
      fixtureOrder('transport', places.newquay),
    ],
  });
  return engine;
}
/** A delivery to Akrotiri, launched with fuel to spare, an hour and a half out. */
function delivering(seed?: string): SimulationEngine {
  const engine = world(seed);
  engine.runSteps(100);
  const aircraft = engine.snapshot().fleet.aircraft.find((each) => each.id === TRANSPORT);
  if (!aircraft) throw new Error('no transport');
  engine.applyCommand({
    type: 'createMission',
    missionType: 'logistics',
    ...defaultConfiguration(
      'logistics',
      {
        ...defaultBrief(MISSION_TEMPLATES.logistics),
        destination: places.akrotiri,
        payloadKg: 3000,
      },
      aircraft,
      { context: engine.planContext() },
    ),
    load: { fuelKg: 60_000, payloadKg: 3000 },
  });
  engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
  engine.applyCommand({ type: 'launchMission', missionId: 'MSN-000001' });
  engine.runSteps(5400);
  return engine;
}
const flightOf = (engine: SimulationEngine) => {
  const flight = engine.snapshot().fleet.flights[0];
  if (!flight) throw new Error('no flight');
  return flight;
};
const landed = (engine: SimulationEngine) => flightOf(engine).status !== 'active';
function runUntil(engine: SimulationEngine, done: (engine: SimulationEngine) => boolean): void {
  for (let i = 0; i < 400_000 && !done(engine); i += 20) engine.runSteps(20);
  if (!done(engine)) throw new Error('the condition was never met');
}
const checkpoint = (engine: SimulationEngine, seq = 1): Checkpoint => ({
  seq,
  wallTimeMs: 1_800_000_000_000 + seq,
  snapshot: engine.snapshot(),
});
/** The world with a closure of Akrotiri that lasts past any arrival. */
function withClosure(engine: SimulationEngine): SimulationEngine {
  const snapshot = engine.snapshot();
  const closure: WorldEvent = {
    id: `EVT-${String(snapshot.events.nextNumber).padStart(6, '0')}`,
    type: 'aerodrome_closure',
    status: 'active',
    source: 'generated',
    severity: 0.6,
    createdTick: snapshot.clock.tick,
    startTick: snapshot.clock.tick,
    endTick: snapshot.clock.tick + 6 * HOUR,
    place: places.akrotiri,
    centre: null,
    radiusM: null,
    aircraftId: null,
    missionId: null,
    title: 'Aerodrome closure: Akrotiri',
    description: 'Simulated event.',
  };
  return SimulationEngine.restore({
    ...snapshot,
    events: {
      events: [...snapshot.events.events, closure],
      nextNumber: snapshot.events.nextNumber + 1,
    },
  });
}

describe('in-flight control on disk', { timeout: 60_000 }, () => {
  let directory: string;
  let path: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-inflight-'));
    path = join(directory, 'aegis.db');
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** Saves a world, closes the database, opens it again and restores the world from it. */
  async function reopened(engine: SimulationEngine): Promise<SimulationEngine> {
    let database = openNodeDatabase(path);
    await new SqliteWorldStore(database.db).save(checkpoint(engine));
    database.close();
    database = openNodeDatabase(path);
    try {
      const loaded = await new SqliteWorldStore(database.db).load();
      expect(loaded?.snapshot).toEqual(engine.snapshot());
      return SimulationEngine.restore(loaded?.snapshot as never);
    } finally {
      database.close();
    }
  }

  it('closes after a diversion and reopens to the same flight, route and history', async () => {
    const engine = delivering();
    engine.applyCommand({
      type: 'reviseFlight',
      aircraftId: TRANSPORT,
      intent: 'divert',
      points: [ROME],
    });
    engine.runSteps(900);
    const restored = await reopened(engine);
    const flight = flightOf(restored);
    expect(flight.revisions).toHaveLength(1);
    expect(flight.revisions[0]).toMatchObject({ intent: 'divert' });
    expect(flight.plannedPlan.points.at(-1)).toEqual(places.akrotiri);
    expect(flight.plan.points.at(-1)).toEqual(ROME);
    // It goes on exactly as the world that was never closed does.
    runUntil(restored, landed);
    runUntil(engine, landed);
    restored.runSteps(5);
    engine.runSteps(5);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(restored.snapshot().missions.missions[0]?.outcome?.summary).toMatch(
      /Landed at Rome, not at Akrotiri/,
    );
  });

  it('stores the route as launched only when it differs, and the history as it happened', async () => {
    const engine = delivering();
    const database = openNodeDatabase(path);
    try {
      const store = new SqliteWorldStore(database.db);
      const row = () =>
        database.transport.connection
          .prepare(
            `SELECT planned_plan, revisions, caution, projected_duration_s,
                    json_extract(progress, '$.hold') AS hold FROM sim_flight`,
          )
          .get() as Record<string, unknown>;
      await store.save(checkpoint(engine, 1));
      expect(row()).toMatchObject({
        planned_plan: null,
        revisions: '[]',
        caution: null,
        hold: null,
      });

      engine.applyCommand({ type: 'holdFlight', aircraftId: TRANSPORT });
      engine.applyCommand({
        type: 'reviseFlight',
        aircraftId: TRANSPORT,
        intent: 'return',
        points: [places.newquay],
      });
      await store.save(checkpoint(engine, 2));
      const saved = row();
      const planned = JSON.parse(String(saved.planned_plan)) as { points: RoutePoint[] };
      expect(planned.points.at(-1)?.code).toBe('LCRA');
      const revisions = JSON.parse(String(saved.revisions)) as { intent: string; tick: number }[];
      expect(revisions).toEqual([
        expect.objectContaining({ intent: 'return', tick: engine.clock.tick }),
      ]);
      expect(Number(saved.projected_duration_s)).toBeGreaterThan(5400);
      expect((await store.load())?.snapshot).toEqual(engine.snapshot());
    } finally {
      database.close();
    }
  });

  it('closes while holding, by order and for a closure, and reopens still holding', async () => {
    const ordered = delivering();
    ordered.applyCommand({ type: 'holdFlight', aircraftId: TRANSPORT });
    ordered.runSteps(700);
    const restored = await reopened(ordered);
    expect(flightOf(restored).progress).toMatchObject({ hold: { reason: 'operator' }, heldS: 700 });
    restored.runSteps(300);
    ordered.runSteps(300);
    expect(flightOf(restored).progress).toEqual(flightOf(ordered).progress);
    expect(flightOf(restored).progress.heldS).toBe(1000);

    rmSync(path, { force: true });
    const closed = withClosure(delivering('closure-persisted'));
    runUntil(closed, (e) => flightOf(e).progress.hold !== null);
    closed.runSteps(400);
    const again = await reopened(closed);
    expect(flightOf(again).progress.hold?.reason).toBe('closure');
    // Reopening does not release it, and the aerodrome reopening does.
    runUntil(again, landed);
    runUntil(closed, landed);
    expect(again.snapshot()).toEqual(closed.snapshot());
    expect(again.snapshot().fleet.aircraft.find((a) => a.id === TRANSPORT)?.location).toEqual(
      places.akrotiri,
    );
  });

  it('closes after an abort and reopens to an aborted mission and a flight still in the air', async () => {
    const engine = delivering();
    engine.applyCommand({
      type: 'abortMission',
      missionId: 'MSN-000001',
      landing: { intent: 'return', points: [places.newquay] },
    });
    engine.runSteps(600);
    const restored = await reopened(engine);
    const mission = restored.snapshot().missions.missions[0];
    expect(mission).toMatchObject({ status: 'aborted', outcome: { result: 'aborted' } });
    expect(
      mission?.objectives.every((o) => o.status === 'failed' && o.remark === 'Mission aborted.'),
    ).toBe(true);
    expect(flightOf(restored).status).toBe('active');
    runUntil(restored, landed);
    runUntil(engine, landed);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(restored.snapshot().fleet.aircraft.find((a) => a.id === TRANSPORT)?.location).toEqual(
      places.newquay,
    );
  });

  it('keeps a technical caution with its flight', async () => {
    const engine = delivering();
    const snapshot = engine.snapshot();
    const cautioned = SimulationEngine.restore({
      ...snapshot,
      fleet: {
        ...snapshot.fleet,
        flights: snapshot.fleet.flights.map((flight) => ({
          ...flight,
          caution: { eventId: 'EVT-000001', sinceTick: snapshot.clock.tick },
        })),
      },
    });
    const restored = await reopened(cautioned);
    expect(flightOf(restored).caution).toEqual({
      eventId: 'EVT-000001',
      sinceTick: snapshot.clock.tick,
    });
    runUntil(restored, landed);
    expect(restored.snapshot().fleet.aircraft.find((a) => a.id === TRANSPORT)?.status).toBe(
      'maintenance_due',
    );
  });

  it('refuses to load a flight whose stored history is not a history', async () => {
    const database = openNodeDatabase(path);
    try {
      const store = new SqliteWorldStore(database.db);
      const engine = delivering();
      engine.applyCommand({
        type: 'reviseFlight',
        aircraftId: TRANSPORT,
        intent: 'divert',
        points: [ROME],
      });
      await store.save(checkpoint(engine));
      database.transport.connection.exec(
        `UPDATE sim_flight SET revisions = '[{"intent":"teleport"}]'`,
      );
      await expect(store.load()).rejects.toThrow(WorldStorageError);
      database.transport.connection.exec(
        `UPDATE sim_flight SET revisions = '[]', caution = '{"eventId":""}'`,
      );
      await expect(store.load()).rejects.toThrow(WorldStorageError);
    } finally {
      database.close();
    }
  });

  it('accepts the new mission status and event type, and still refuses unknown ones', () => {
    const database = openNodeDatabase(path);
    try {
      const { connection } = database.transport;
      const constraints = (table: string) =>
        (
          connection.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(table) as {
            sql: string;
          }
        ).sql;
      expect(constraints('sim_mission')).toContain(`'aborted'`);
      expect(constraints('sim_event')).toContain(`'technical_caution'`);
      expect(() => {
        connection.exec(
          `INSERT INTO sim_event (id, type, status, source, severity, created_tick, start_tick, end_tick, title, description)
           VALUES ('EVT-9', 'meteor_strike', 'active', 'generated', 0.5, 0, 0, 0, 't', 'd')`,
        );
      }).toThrow(/CHECK constraint failed/);
    } finally {
      database.close();
    }
  });
});

describe('migration 0008 on an existing world', { timeout: 60_000 }, () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-migration-'));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** The migrations up to and including 0007, as a database before this phase had them. */
  function migrationsBefore0008(): string {
    const folder = join(directory, 'migrations-0007');
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 7);
    writeFileSync(journalPath, JSON.stringify(journal));
    return folder;
  }

  /**
   * A world as model 5 left it on disk: a mission whose flight has landed, a second flight in the
   * air, a maintenance finding that was resolved, and the log that says when.
   */
  async function oldWorld(path: string) {
    // The world is built by today's engine and written by today's store into a scratch database,
    // then copied column by column into a database that has only the old schema.
    const engine = delivering('before-0008');
    runUntil(engine, landed);
    engine.runSteps(10);
    // A second mission, in flight when the world was saved.
    const aircraft = engine.snapshot().fleet.aircraft.find((each) => each.id === TRANSPORT);
    if (!aircraft?.location) throw new Error('the transport should have landed');
    engine.applyCommand({
      type: 'launchFlight',
      aircraftId: TRANSPORT,
      plan: generatePlan(models.transport, aircraft.location, places.newquay),
      load: { fuelKg: 60_000, payloadKg: 0 },
    });
    engine.runSteps(3000);
    const snapshot = engine.snapshot();
    const finding: WorldEvent = {
      id: 'EVT-000900',
      type: 'maintenance_finding',
      status: 'resolved',
      source: 'generated',
      severity: 0.5,
      createdTick: 1000,
      startTick: 1000,
      // As model 5 left it: a finding kept the end it was created with.
      endTick: 1000,
      place: null,
      centre: null,
      radiusM: null,
      aircraftId: 'AEGIS-FT-001',
      missionId: null,
      title: 'Maintenance finding: AEGIS-FT-001',
      description: 'Simulated event.',
    };
    const resolvedTick = snapshot.clock.tick - 100;
    const scratch = openNodeDatabase(join(directory, 'scratch.db'));
    const old = new NodeSqliteTransport(path);
    try {
      await new SqliteWorldStore(scratch.db).save({
        seq: 1,
        wallTimeMs: 1_800_000_000_001,
        snapshot: {
          ...snapshot,
          events: { events: [finding], nextNumber: 901 },
        },
      });
      migrate(old.connection, migrationsBefore0008());
      const tables = [
        'sim_world',
        'sim_clock',
        'sim_checkpoint',
        'sim_rng_stream',
        'sim_counter',
        'sim_place',
        'sim_aircraft',
        'sim_mission',
        'sim_flight',
        'sim_event',
        'sim_log',
      ];
      for (const table of tables) {
        const columns = (
          old.connection.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as {
            name: string;
          }[]
        ).map((column) => column.name);
        const rows = scratch.transport.connection
          .prepare(`SELECT ${columns.join(', ')} FROM ${table}`)
          .all() as Record<string, string | number | null>[];
        const insert = old.connection.prepare(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        );
        for (const row of rows) insert.run(...columns.map((column) => row[column] ?? null));
      }
      old.connection.exec(`UPDATE sim_world SET model_version = 5`);
      old.connection
        .prepare(
          `INSERT INTO sim_log (seq, tick, kind, type, actor, aircraft_id, payload)
           VALUES (?, ?, 'event', 'eventResolved', 'world', 'AEGIS-FT-001', ?)`,
        )
        .run(snapshot.log.nextSeq, resolvedTick, JSON.stringify({ eventId: 'EVT-000900' }));
    } finally {
      scratch.close();
      old.close();
    }
    return { snapshot, resolvedTick };
  }

  it('is refused by nothing: the rebuilt tables keep every row and every link', async () => {
    const path = join(directory, 'aegis.db');
    const { snapshot: before, resolvedTick } = await oldWorld(path);
    const peek = new NodeSqliteTransport(path);
    const count = (connection: NodeSqliteTransport['connection'], table: string) =>
      (connection.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    const missionsBefore = count(peek.connection, 'sim_mission');
    const linksBefore = peek.connection
      .prepare(`SELECT id, mission_id FROM sim_flight ORDER BY id`)
      .all();
    expect(missionsBefore).toBeGreaterThan(0);
    expect(linksBefore.some((row) => row.mission_id !== null)).toBe(true);
    expect(
      peek.connection
        .prepare(
          `SELECT count(*) AS n FROM pragma_table_info('sim_flight') WHERE name = 'revisions'`,
        )
        .get(),
    ).toEqual({ n: 0 });
    peek.close();

    // Opening it with this build applies 0008, with foreign keys on, in one transaction.
    const database = openNodeDatabase(path);
    try {
      const { connection } = database.transport;
      expect(count(connection, 'sim_mission')).toBe(missionsBefore);
      expect(connection.prepare(`SELECT id, mission_id FROM sim_flight ORDER BY id`).all()).toEqual(
        linksBefore,
      );
      expect(connection.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(connection.prepare('PRAGMA integrity_check').all()).toEqual([
        { integrity_check: 'ok' },
      ]);
      expect(
        connection
          .prepare(`SELECT name FROM sqlite_master WHERE name LIKE '\\_\\_%flight%' ESCAPE '\\'`)
          .all(),
      ).toEqual([]);
      // The link is still enforced after the rebuild.
      expect(() => {
        connection.exec(`UPDATE sim_flight SET mission_id = 'MSN-999999'`);
      }).toThrow(/FOREIGN KEY constraint failed/);
      expect(
        connection
          .prepare(
            `SELECT planned_plan, revisions, caution, projected_duration_s FROM sim_flight LIMIT 1`,
          )
          .get(),
      ).toEqual({ planned_plan: null, revisions: '[]', caution: null, projected_duration_s: null });
      expect(
        connection
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('sim_mission', 'sim_event') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
          )
          .all(),
      ).toEqual([
        { name: 'sim_event_status_idx' },
        { name: 'sim_mission_aircraft_idx' },
        { name: 'sim_mission_status_idx' },
      ]);

      // The resolved finding now records when it actually ended, taken from the log.
      expect(
        connection
          .prepare(`SELECT start_tick, end_tick FROM sim_event WHERE id = 'EVT-000900'`)
          .get(),
      ).toEqual({ start_tick: 1000, end_tick: resolvedTick });

      // And the world loads, upgrades, and flies on under the new rules.
      const loaded = await new SqliteWorldStore(database.db).load();
      expect(loaded?.snapshot.modelVersion).toBe(5);
      const upgraded = SimulationEngine.restore(loaded?.snapshot as never);
      expect(upgraded.snapshot().modelVersion).toBe(SIM_MODEL_VERSION);
      expect(upgraded.snapshot().log.completeFromTick).toBe(before.clock.tick);
      const flights = upgraded.snapshot().fleet.flights;
      expect(flights).toHaveLength(2);
      for (const flight of flights) {
        expect(flight.revisions).toEqual([]);
        expect(flight.plannedPlan).toEqual(flight.plan);
        expect(flight.projectedDurationS).toBe(flight.estimatedDurationS);
      }
      const airborne = flights.find((flight) => flight.status === 'active');
      expect(airborne?.progress).toMatchObject({ hold: null, heldS: 0, closureLanding: false });
      // The flight that was in the air at the upgrade can be given the new commands.
      expect(upgraded.applyCommand({ type: 'holdFlight', aircraftId: TRANSPORT })).toBe(true);
      upgraded.runSteps(600);
      expect(upgraded.applyCommand({ type: 'resumeFlight', aircraftId: TRANSPORT })).toBe(true);
      for (
        let i = 0;
        i < 4000 && upgraded.snapshot().fleet.flights.some((f) => f.status === 'active');
        i++
      ) {
        upgraded.runSteps(20);
      }
      expect(upgraded.snapshot().fleet.aircraft.find((a) => a.id === TRANSPORT)?.location).toEqual(
        places.newquay,
      );
      await new SqliteWorldStore(database.db).save({
        seq: 2,
        wallTimeMs: 1_800_000_000_002,
        snapshot: upgraded.snapshot(),
      });
      expect((await new SqliteWorldStore(database.db).load())?.snapshot).toEqual(
        upgraded.snapshot(),
      );
    } finally {
      database.close();
    }
  }, 60_000);

  it('leaves an event the log says nothing about as it was', async () => {
    const path = join(directory, 'aegis.db');
    await oldWorld(path);
    const old = new NodeSqliteTransport(path);
    old.connection.exec(`DELETE FROM sim_log WHERE type = 'eventResolved'`);
    old.close();
    const database = openNodeDatabase(path);
    try {
      expect(
        database.transport.connection
          .prepare(`SELECT end_tick FROM sim_event WHERE id = 'EVT-000900'`)
          .get(),
      ).toEqual({ end_tick: 1000 });
    } finally {
      database.close();
    }
  });
});

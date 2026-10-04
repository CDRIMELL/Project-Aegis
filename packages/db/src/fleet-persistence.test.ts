import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  derivePerformance,
  generatePlan,
  simInstant,
  suggestedFuelKg,
  type PerformanceModel,
  type RoutePoint,
} from '@aegis/domain';
import {
  RECENT_FLIGHTS,
  SimulationEngine,
  SimulationRunner,
  type AircraftOrder,
  type Checkpoint,
  type FlightState,
} from '@aegis/sim';
import { ManualHostClock } from '@aegis/sim/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openNodeDatabase, type NodeDatabase } from './node';
import type { SqlStatement } from './transport';
import { SqliteWorldStore, WorldStorageError } from './world-store';

const EPOCH = simInstant(Date.UTC(2026, 9, 4, 12, 0, 0));
const newWorld = () => ({ seed: 'persisted-fleet', epoch: EPOCH });

function model(
  category: string,
  values: [number, number, number | null, number | null, number, number],
): PerformanceModel {
  const [emptyMassKg, maxTakeoffMassKg, cruiseSpeedKmh, maxSpeedKmh, rangeKm, serviceCeilingM] =
    values;
  const result = derivePerformance({
    category,
    engineType: 'turbofan',
    emptyMassKg,
    maxTakeoffMassKg,
    cruiseSpeedKmh,
    maxSpeedKmh,
    rangeKm,
    ferryRangeKm: null,
    serviceCeilingM,
  });
  if (!result.available) throw new Error('unavailable');
  return result.model;
}
const C17 = model('transport', [128140, 265352, 833, null, 4482, 13716]);
const TYPHOON = model('fast_jet', [11000, 23500, null, 2495, 2900, 16764]);

const aerodrome = (
  refId: string,
  name: string,
  lat: number,
  lon: number,
  elevationM: number,
): RoutePoint => ({
  kind: 'aerodrome',
  refId,
  name,
  code: refId.toUpperCase(),
  lat,
  lon,
  elevationM,
});
const PRESTWICK = aerodrome('egpk', 'Glasgow Prestwick', 55.5094, -4.5867, 20);
const NEWQUAY = aerodrome('eghq', 'Newquay', 50.4406, -4.9954, 119);
const AKROTIRI = aerodrome('lcra', 'Akrotiri', 34.5904, 32.9879, 23);

const ORDERS: AircraftOrder[] = [
  {
    typeId: 'aegis-curated:typhoon',
    typeName: 'Eurofighter Typhoon',
    category: 'fast_jet',
    performance: TYPHOON,
    performanceMissing: [],
    home: PRESTWICK,
  },
  {
    typeId: 'aegis-curated:c-17',
    typeName: 'Boeing C-17 Globemaster III',
    category: 'transport',
    performance: C17,
    performanceMissing: [],
    home: NEWQUAY,
  },
  {
    typeId: 'aegis-curated:voyager',
    typeName: 'Airbus A330 MRTT',
    category: 'tanker',
    performance: null,
    performanceMissing: ['empty mass', 'range'],
    home: NEWQUAY,
  },
];

function launchC17(
  apply: (command: Parameters<SimulationEngine['applyCommand']>[0]) => void,
): void {
  const plan = generatePlan(C17, NEWQUAY, AKROTIRI);
  apply({
    type: 'launchFlight',
    aircraftId: 'AEGIS-TR-001',
    plan,
    load: { fuelKg: suggestedFuelKg(C17, plan, 12000) as number, payloadKg: 12000 },
  });
}

/** A world with the starter fleet and a C-17 some way into a flight. */
function midFlight(steps = 5000): SimulationEngine {
  const engine = SimulationEngine.create(newWorld());
  engine.applyCommand({ type: 'seedStarterFleet', aircraft: ORDERS });
  launchC17((command) => engine.applyCommand(command));
  engine.runSteps(steps);
  return engine;
}

const checkpoint = (engine: SimulationEngine, seq = 1): Checkpoint => ({
  seq,
  wallTimeMs: 1_800_000_000_000 + seq,
  snapshot: engine.snapshot(),
});

describe('fleet persistence', () => {
  let database: NodeDatabase;
  let store: SqliteWorldStore;
  const all = (sql: string) => database.transport.connection.prepare(sql).all();

  beforeEach(() => {
    database = openNodeDatabase(':memory:');
    store = new SqliteWorldStore(database.db);
  });
  afterEach(() => {
    database.close();
  });

  it('round-trips aircraft, an active flight and counters exactly', async () => {
    const engine = midFlight();
    const saved = checkpoint(engine);
    await store.save(saved);
    const loaded = await store.load();

    expect(loaded).toEqual(saved);
    expect(loaded?.snapshot.fleet.aircraft.map((aircraft) => aircraft.id)).toEqual([
      'AEGIS-FT-001',
      'AEGIS-TK-001',
      'AEGIS-TR-001',
    ]);
    expect(loaded?.snapshot.fleet.flights[0]?.progress.phase).toBe('cruise');
    expect(loaded?.snapshot.fleet.counters).toEqual({
      'AEGIS-FT': 2,
      'AEGIS-TK': 2,
      'AEGIS-TR': 2,
      FLT: 2,
    });
    expect(loaded?.snapshot.fleet.starterFleetSeeded).toBe(true);
  });

  it('restores an engine that continues exactly as the original would have', async () => {
    const engine = midFlight();
    await store.save(checkpoint(engine));
    const loaded = await store.load();
    if (!loaded) throw new Error('expected a saved world');

    const restored = SimulationEngine.restore(loaded.snapshot);
    engine.runSteps(20_000);
    restored.runSteps(20_000);
    expect(restored.snapshot()).toEqual(engine.snapshot());
    expect(
      restored.snapshot().fleet.aircraft.find((a) => a.id === 'AEGIS-TR-001')?.location,
    ).toEqual(AKROTIRI);
  });

  it('stores an aircraft with no performance model and the reason', async () => {
    await store.save(checkpoint(midFlight(0)));
    expect(
      all(
        "SELECT performance, performance_missing, fuel_kg FROM sim_aircraft WHERE id = 'AEGIS-TK-001'",
      ),
    ).toEqual([{ performance: null, performance_missing: '["empty mass","range"]', fuel_kg: 0 }]);
  });

  it('keeps simulated rows out of the reference tables', async () => {
    await store.save(checkpoint(midFlight()));
    expect(all('SELECT count(*) AS n FROM ref_aircraft_type')).toEqual([{ n: 0 }]);
    expect(all('SELECT count(*) AS n FROM ref_location')).toEqual([{ n: 0 }]);
    expect(all('SELECT type_id FROM sim_aircraft ORDER BY id')[0]).toEqual({
      type_id: 'aegis-curated:typhoon',
    });
  });

  it('writes the fleet atomically with the clock', async () => {
    const before = midFlight(1000);
    await store.save(checkpoint(before, 1));
    const original = await store.load();

    const transport = database.transport;
    const realBatch = transport.batch.bind(transport);
    transport.batch = (statements: readonly SqlStatement[]) =>
      realBatch([
        ...statements,
        {
          sql: "INSERT INTO sim_flight (id, aircraft_id, status, departed_tick, payload_kg, fuel_at_departure_kg, estimated_duration_s, estimated_fuel_used_kg, plan, progress) VALUES ('X', 'no-such-aircraft', 'active', 0, 0, 0, 0, 0, '{}', '{}')",
          params: [],
          method: 'run',
        },
      ]);
    const later = midFlight(9000);
    await expect(store.save(checkpoint(later, 2))).rejects.toThrow(/FOREIGN KEY/i);

    transport.batch = realBatch;
    expect(await store.load()).toEqual(original);
  });

  it('enforces fleet invariants in the database itself', () => {
    const exec = (sql: string) => () => {
      database.transport.connection.exec(sql);
    };
    const aircraft = (id: string, status: string, location: string, fuel = 10, condition = 90) =>
      `INSERT INTO sim_aircraft (id, type_id, type_name, category, status, home, location, fuel_kg, payload_kg, condition_pct, flight_seconds_total, flights, flight_seconds_since_maintenance, acquired_tick, performance_missing) VALUES ('${id}', 't', 'T', 'transport', '${status}', '{}', ${location}, ${fuel}, 0, ${condition}, 0, 0, 0, 0, '[]')`;

    expect(exec(aircraft('A1', 'available', "'{}'"))).not.toThrow();
    expect(exec(aircraft('A2', 'in_flight', "'{}'"))).toThrow(/CHECK constraint/i);
    expect(exec(aircraft('A3', 'available', 'NULL'))).toThrow(/CHECK constraint/i);
    expect(exec(aircraft('A4', 'available', "'{}'", -1))).toThrow(/CHECK constraint/i);
    expect(exec(aircraft('A5', 'available', "'{}'", 10, 101))).toThrow(/CHECK constraint/i);
    expect(
      exec(
        "INSERT INTO sim_flight (id, aircraft_id, status, departed_tick, arrived_tick, payload_kg, fuel_at_departure_kg, estimated_duration_s, estimated_fuel_used_kg, plan, progress) VALUES ('F1', 'A1', 'active', 0, 5, 0, 0, 0, 0, '{}', '{}')",
      ),
    ).toThrow(/CHECK constraint/i);
  });

  it('refuses to load fleet rows whose stored structure is damaged', async () => {
    await store.save(checkpoint(midFlight()));
    database.transport.connection.exec('UPDATE sim_flight SET progress = \'{"phase":"orbit"}\'');
    await expect(store.load()).rejects.toThrow(WorldStorageError);
    database.transport.connection.exec("UPDATE sim_flight SET progress = 'not json'");
    await expect(store.load()).rejects.toThrow(/not valid JSON/);
  });

  it('keeps finished flights as history after the engine has forgotten them', async () => {
    const engine = midFlight();
    const snapshot = engine.snapshot();
    const template = snapshot.fleet.flights[0] as FlightState;
    const finished = (n: number): FlightState => ({
      ...template,
      id: `FLT-${String(n).padStart(6, '0')}`,
      status: 'completed',
      arrivedTick: 10 + n,
      progress: { ...template.progress, phase: 'landed' },
    });
    const many = Array.from({ length: RECENT_FLIGHTS + 20 }, (_, i) => finished(i + 2));

    await store.save({
      ...checkpoint(engine, 1),
      snapshot: { ...snapshot, fleet: { ...snapshot.fleet, flights: [template, ...many] } },
    });
    // A later checkpoint that no longer mentions the old flights must not delete them.
    await store.save(checkpoint(engine, 2));

    expect(all('SELECT count(*) AS n FROM sim_flight')).toEqual([{ n: RECENT_FLIGHTS + 21 }]);
    const loaded = await store.load();
    const flights = loaded?.snapshot.fleet.flights ?? [];
    expect(flights.filter((flight) => flight.status === 'active')).toHaveLength(1);
    expect(flights.filter((flight) => flight.status !== 'active')).toHaveLength(RECENT_FLIGHTS);
    expect(flights.at(-1)?.id).toBe(`FLT-${String(RECENT_FLIGHTS + 21).padStart(6, '0')}`);
  });
});

describe('flight continuity across application restarts', () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aegis-fleet-'));
    path = join(directory, 'aegis.db');
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  async function launchApp() {
    const database = openNodeDatabase(path);
    const host = new ManualHostClock();
    const runner = await SimulationRunner.open({
      store: new SqliteWorldStore(database.db),
      host,
      newWorld,
    });
    return { database, host, runner };
  }
  function run(session: Awaited<ReturnType<typeof launchApp>>, realMs: number): void {
    for (let elapsed = 0; elapsed < realMs; elapsed += 100) {
      session.host.elapse(100);
      session.runner.advance();
    }
  }
  const c17 = (session: Awaited<ReturnType<typeof launchApp>>) =>
    session.runner.view().fleet.aircraft.find((aircraft) => aircraft.id === 'AEGIS-TR-001');

  it('closes during a flight and reopens to the same flight, then lands as an uninterrupted run would', async () => {
    const first = await launchApp();
    first.runner.execute({ type: 'setSpeed', speed: 100 });
    first.runner.execute({ type: 'seedStarterFleet', aircraft: ORDERS });
    launchC17((command) => {
      first.runner.execute(command);
    });
    run(first, 60_000);
    await first.runner.flush();
    const atClose = first.runner.view();
    expect(atClose.fleet.activeFlights).toHaveLength(1);
    first.database.close();

    // A day passes with the application closed. Nothing moves.
    const second = await launchApp();
    const reopened = second.runner.view();
    expect(reopened.clock).toEqual(atClose.clock);
    expect(reopened.fleet).toEqual(atClose.fleet);
    expect(reopened.fleet.activeFlights[0]).toMatchObject({
      aircraftId: 'AEGIS-TR-001',
      phase: 'cruise',
    });

    run(second, 200_000);
    const reference = SimulationEngine.create(newWorld());
    reference.applyCommand({ type: 'seedStarterFleet', aircraft: ORDERS });
    launchC17((command) => reference.applyCommand(command));
    reference.runSteps(second.runner.view().clock.tick);

    expect(c17(second)).toEqual(
      reference.snapshot().fleet.aircraft.find((a) => a.id === 'AEGIS-TR-001'),
    );
    expect(c17(second)).toMatchObject({ status: 'available', location: AKROTIRI, flights: 1 });
    expect(second.runner.view().integrityDigest).toBe(reference.snapshot().integrityDigest);
    second.database.close();
  });

  it('recovers a consistent mid-flight world when the process dies without a final checkpoint', async () => {
    const first = await launchApp();
    first.runner.execute({ type: 'setSpeed', speed: 100 });
    first.runner.execute({ type: 'seedStarterFleet', aircraft: ORDERS });
    launchC17((command) => {
      first.runner.execute(command);
    });
    run(first, 9500);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const lostTick = first.runner.view().clock.tick;
    first.database.close();

    const second = await launchApp();
    const recovered = second.runner.view();
    expect(recovered.clock.tick).toBeLessThan(lostTick);
    expect(lostTick - recovered.clock.tick).toBeLessThanOrEqual(200);

    const reference = SimulationEngine.create(newWorld());
    reference.applyCommand({ type: 'seedStarterFleet', aircraft: ORDERS });
    launchC17((command) => reference.applyCommand(command));
    reference.runSteps(recovered.clock.tick);
    expect(recovered.fleet).toEqual(reference.fleetView());
    second.database.close();
  });

  it('loads a world saved before the fleet existed', async () => {
    const database = openNodeDatabase(path);
    database.transport.connection.exec(`
      INSERT INTO sim_world (id, seed, model_version, epoch_ms, created_wall_ms) VALUES (1, 'old-world', 1, ${EPOCH}, 0);
      INSERT INTO sim_clock (id, sim_time_ms, tick, speed, running) VALUES (1, ${EPOCH + 5000}, 5, 1, 1);
      INSERT INTO sim_checkpoint (id, seq, wall_ms, integrity_digest) VALUES (1, 3, 0, 123);
    `);
    database.close();

    const session = await launchApp();
    expect(session.runner.view()).toMatchObject({
      seed: 'old-world',
      clock: { tick: 5 },
      fleet: { aircraft: [] },
    });
    session.runner.execute({ type: 'seedStarterFleet', aircraft: ORDERS });
    await session.runner.flush();
    expect(
      session.database.transport.connection.prepare('SELECT model_version FROM sim_world').get(),
    ).toEqual({
      model_version: 2,
    });
    session.database.close();
  });
});

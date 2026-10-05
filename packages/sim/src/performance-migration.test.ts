import { FLIGHT_MODEL_VERSION, type PerformanceModel } from '@aegis/domain';
import { describe, expect, it } from 'vitest';
import { SimulationEngine } from './engine';
import { CommandRejected } from './fleet';
import { replayComparable, replayWorld } from './replay';
import { FIXTURES, fixtureLaunch, fixtureOrder, launchFuelled, untilServiced } from './testing';

const { places, models } = FIXTURES;
const newWorld = () => ({ seed: 'model-migration', epoch: FIXTURES.epoch });

/** The transport as an aircraft acquired under flight model 1 would hold it. */
const VERSION_1: PerformanceModel = {
  ...Object.fromEntries(
    Object.entries(models.transport).filter(([key]) => key !== 'fuelCapacityBasis'),
  ),
  ...{ modelVersion: 1, fuelCapacityKg: 68_606, reserveFuelKg: 6861 },
} as PerformanceModel;
const VERSION_2: PerformanceModel = {
  ...models.transport,
  modelVersion: FLIGHT_MODEL_VERSION,
  fuelCapacityKg: 107_645,
  fuelCapacityBasis: 'sourced_volume',
  reserveFuelKg: 10_765,
};

function worldWithVersion1Transport(): SimulationEngine {
  const engine = SimulationEngine.create(newWorld());
  engine.applyCommand({
    type: 'acquireAircraft',
    ...fixtureOrder('transport', places.newquay),
    performance: VERSION_1,
  });
  return engine;
}
const transport = (engine: SimulationEngine) => {
  const found = engine.snapshot().fleet.aircraft.find((a) => a.id === 'AEGIS-TR-001');
  if (!found) throw new Error('no transport');
  return found;
};
const migrate = {
  type: 'updatePerformance',
  aircraftId: 'AEGIS-TR-001',
  performance: VERSION_2,
  performanceMissing: [],
} as const;

describe('migrating an aircraft to a new performance model', () => {
  it('replaces the model of a grounded aircraft and logs it as a system command', () => {
    const engine = worldWithVersion1Transport();
    expect(engine.applyCommand(migrate)).toBe(true);
    expect(transport(engine).performance).toEqual(VERSION_2);
    // Fuel on board is not invented: the aircraft keeps what it had.
    expect(transport(engine).fuelKg).toBe(68_606);
    expect(engine.snapshot().log.entries.at(-1)).toMatchObject({
      kind: 'command',
      type: 'updatePerformance',
      actor: 'system',
      aircraftId: 'AEGIS-TR-001',
    });
  });

  it('does nothing, and logs nothing, when the model is already the same', () => {
    const engine = worldWithVersion1Transport();
    engine.applyCommand(migrate);
    expect(engine.applyCommand(migrate)).toBe(false);
    expect(engine.snapshot().log.entries).toHaveLength(2);
  });

  it('refuses to migrate an airborne aircraft, which finishes under the model it departed with', () => {
    const migrated = worldWithVersion1Transport();
    const untouched = worldWithVersion1Transport();
    const launch = fixtureLaunch('AEGIS-TR-001', VERSION_1, places.newquay, places.akrotiri);
    for (const engine of [migrated, untouched]) {
      launchFuelled(engine, launch);
      engine.runSteps(5000);
    }
    expect(() => migrated.applyCommand(migrate)).toThrow(CommandRejected);
    expect(transport(migrated).performance).toEqual(VERSION_1);

    // The refused command changed nothing: both worlds land identically.
    migrated.runSteps(15_000);
    untouched.runSteps(15_000);
    expect(migrated.snapshot()).toEqual(untouched.snapshot());
    expect(transport(migrated).location).toEqual(places.akrotiri);

    // Once landed and turned round it can be migrated; not while it is being serviced.
    if (transport(migrated).status === 'servicing') {
      expect(() => migrated.applyCommand(migrate)).toThrow(/being serviced/);
    }
    untilServiced(migrated, 'AEGIS-TR-001');
    expect(transport(migrated).status).toBe('available');
    expect(migrated.applyCommand(migrate)).toBe(true);
    expect(transport(migrated).performance?.modelVersion).toBe(FLIGHT_MODEL_VERSION);
  });

  it('reduces fuel that the new model cannot hold', () => {
    const engine = worldWithVersion1Transport();
    expect(transport(engine).fuelKg).toBeGreaterThan(50_000);
    const smaller: PerformanceModel = { ...VERSION_2, fuelCapacityKg: 50_000 };
    engine.applyCommand({ ...migrate, performance: smaller });
    expect(transport(engine).fuelKg).toBe(50_000);
  });

  it('gives a model to an aircraft that had none', () => {
    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand({
      type: 'acquireAircraft',
      ...fixtureOrder('transport', places.newquay),
      performance: null,
      performanceMissing: ['maximum take-off mass'],
    });
    engine.applyCommand(migrate);
    expect(transport(engine)).toMatchObject({ performance: VERSION_2, performanceMissing: [] });
  });

  it('replays: a world with a migration is re-derived from its seed and log', () => {
    const engine = worldWithVersion1Transport();
    engine.runSteps(100);
    engine.applyCommand(migrate);
    launchFuelled(
      engine,
      fixtureLaunch('AEGIS-TR-001', VERSION_2, places.newquay, places.akrotiri, 20_000),
    );
    engine.runSteps(20_000);
    const replayed = replayWorld(newWorld(), engine.snapshot().log.entries, engine.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(engine.snapshot()));
  });
});

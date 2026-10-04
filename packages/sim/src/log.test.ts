import { describe, expect, it } from 'vitest';
import { SimulationEngine, WorldRestoreError } from './engine';
import { CommandRejected, MAINTENANCE } from './fleet';
import { RECENT_LOG, SimLog, type LogEntry } from './log';
import { replayComparable, replayWorld } from './replay';
import { SimulationRunner } from './runner';
import {
  FIXTURES,
  ManualHostClock,
  MemoryWorldStore,
  fixtureLaunch,
  fixtureOrder,
} from './testing';
import { SIM_MODEL_VERSION, type WorldSnapshot } from './world';

const { places, models } = FIXTURES;
const newWorld = () => ({ seed: 'logged-world', epoch: FIXTURES.epoch });
const copyOf = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const entries = (engine: SimulationEngine) => engine.snapshot().log.entries;

/** Two aircraft; the fast jet flies Prestwick to Newquay and is then maintained. */
function scriptedWorld(): SimulationEngine {
  const engine = SimulationEngine.create(newWorld());
  engine.applyCommand({
    type: 'seedStarterFleet',
    aircraft: [
      fixtureOrder('fastJet', places.prestwick),
      fixtureOrder('transport', places.newquay),
    ],
  });
  engine.runSteps(30);
  engine.applyCommand(
    fixtureLaunch('AEGIS-FT-001', models.fastJet, places.prestwick, places.newquay),
  );
  engine.runSteps(4000);
  engine.applyCommand({ type: 'startMaintenance', aircraftId: 'AEGIS-FT-001' });
  engine.runSteps(MAINTENANCE.durationSeconds + 10);
  return engine;
}

describe('command and event log', () => {
  it('starts empty and complete from tick 0', () => {
    const engine = SimulationEngine.create(newWorld());
    engine.runSteps(500);
    expect(engine.snapshot().log).toEqual({ nextSeq: 1, completeFromTick: 0, entries: [] });
  });

  it('records each effective command with its whole payload, in order', () => {
    const engine = SimulationEngine.create(newWorld());
    const order = fixtureOrder('fastJet', places.prestwick);
    engine.applyCommand({ type: 'acquireAircraft', ...order });
    engine.runSteps(7);
    const launch = fixtureLaunch('AEGIS-FT-001', models.fastJet, places.prestwick, places.newquay);
    engine.applyCommand(launch);

    expect(entries(engine)).toEqual([
      {
        seq: 1,
        tick: 0,
        kind: 'command',
        type: 'acquireAircraft',
        actor: 'player',
        missionId: null,
        aircraftId: 'AEGIS-FT-001',
        flightId: null,
        payload: { type: 'acquireAircraft', ...order },
      },
      {
        seq: 2,
        tick: 7,
        kind: 'command',
        type: 'launchFlight',
        actor: 'player',
        missionId: null,
        aircraftId: 'AEGIS-FT-001',
        flightId: 'FLT-000001',
        payload: launch,
      },
    ]);
  });

  it('attributes commands the application issues itself to the system', () => {
    const engine = SimulationEngine.create(newWorld());
    engine.applyCommand({
      type: 'seedStarterFleet',
      aircraft: [fixtureOrder('fastJet', places.prestwick)],
    });
    expect(entries(engine)[0]).toMatchObject({ type: 'seedStarterFleet', actor: 'system' });
  });

  it('records what the world did as events, at the tick it happened', () => {
    const log = entries(scriptedWorld());
    expect(log.map((entry) => `${entry.kind}:${entry.type}`)).toEqual([
      'command:seedStarterFleet',
      'command:launchFlight',
      'event:flightCompleted',
      'command:startMaintenance',
      'event:maintenanceCompleted',
    ]);
    const landed = log[2] as LogEntry;
    expect(landed).toMatchObject({
      actor: 'world',
      aircraftId: 'AEGIS-FT-001',
      flightId: 'FLT-000001',
      payload: { destination: 'EGHQ' },
    });
    expect(landed.tick).toBeGreaterThan(30);
    expect(landed.tick).toBeLessThan(4030);
    expect((log[4] as LogEntry).tick).toBe(4030 + MAINTENANCE.durationSeconds);
    expect(log.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('does not record a rejected command or one that had no effect', () => {
    const engine = SimulationEngine.create(newWorld());
    const seed = {
      type: 'seedStarterFleet',
      aircraft: [fixtureOrder('fastJet', places.prestwick)],
    } as const;
    engine.applyCommand(seed);
    expect(engine.applyCommand(seed)).toBe(false);
    expect(() =>
      engine.applyCommand({ type: 'startMaintenance', aircraftId: 'AEGIS-XX-404' }),
    ).toThrow(CommandRejected);
    expect(entries(engine)).toHaveLength(1);
  });

  it('leaves the world untouched when one order of a starter fleet is invalid', () => {
    const engine = SimulationEngine.create(newWorld());
    const before = engine.snapshot();
    expect(() =>
      engine.applyCommand({
        type: 'seedStarterFleet',
        aircraft: [
          fixtureOrder('fastJet', places.prestwick),
          fixtureOrder('transport', { ...places.newquay, lat: 400 }),
        ],
      }),
    ).toThrow(CommandRejected);
    expect(engine.snapshot()).toEqual(before);
  });

  it('produces the same log for the same seed and commands, however the steps are batched', () => {
    const whole = scriptedWorld();

    const batched = SimulationEngine.create(newWorld());
    const stepTo = (tick: number) => {
      while (batched.clock.tick < tick) {
        batched.runSteps(Math.min(137, tick - batched.clock.tick));
      }
    };
    for (const entry of entries(whole)) {
      if (entry.kind !== 'command') continue;
      stepTo(entry.tick);
      batched.applyCommand(entry.payload as never);
    }
    stepTo(whole.clock.tick);
    expect(batched.snapshot()).toEqual(whole.snapshot());
  });

  it('re-derives the whole world from its seed and its logged commands', () => {
    const original = scriptedWorld();
    const replayed = replayWorld(newWorld(), entries(original), original.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(original.snapshot()));
    // The replay regenerates every event as well.
    expect(entries(replayed)).toEqual(entries(original));
  });

  it('detects a log that does not match the world', () => {
    const original = scriptedWorld();
    const tampered = entries(original).filter((entry) => entry.type !== 'startMaintenance');
    const replayed = replayWorld(newWorld(), tampered, original.clock.tick);
    expect(replayComparable(replayed.snapshot())).not.toEqual(
      replayComparable(original.snapshot()),
    );
  });

  it('restores the log and continues the sequence', () => {
    const engine = scriptedWorld();
    const restored = SimulationEngine.restore(copyOf(engine.snapshot()));
    restored.applyCommand({ type: 'setHome', aircraftId: 'AEGIS-TR-001', home: places.exeter });
    expect(entries(restored).at(-1)).toMatchObject({ seq: 6, type: 'setHome' });
  });

  it('refuses a saved log with a gap', () => {
    const snapshot = copyOf(scriptedWorld().snapshot());
    const broken: WorldSnapshot = {
      ...snapshot,
      log: { ...snapshot.log, entries: snapshot.log.entries.filter((entry) => entry.seq !== 3) },
    };
    expect(() => SimulationEngine.restore(broken)).toThrow(WorldRestoreError);
  });

  it('gives a world saved before the log existed a log that starts at the upgrade', () => {
    const engine = SimulationEngine.create(newWorld());
    engine.runSteps(900);
    // What the store returns for a model-2 database: no log rows, and the column's default.
    const old: WorldSnapshot = {
      ...engine.snapshot(),
      modelVersion: 2,
      log: { nextSeq: 1, completeFromTick: 0, entries: [] },
    };
    const upgraded = SimulationEngine.restore(old);
    expect(upgraded.snapshot().log).toEqual({ nextSeq: 1, completeFromTick: 900, entries: [] });
    expect(upgraded.snapshot().modelVersion).toBe(SIM_MODEL_VERSION);
  });
});

describe('log retention in memory', () => {
  const entry = (log: SimLog, tick: number) => log.append(tick, 'event', 'probe', 'world', {});

  it('never drops an entry that has not been saved', () => {
    const log = new SimLog();
    for (let i = 0; i < RECENT_LOG + 50; i++) entry(log, i);
    expect(log.snapshot().entries).toHaveLength(RECENT_LOG + 50);
    expect(log.snapshot().entries[0]?.seq).toBe(1);
  });

  it('keeps only a recent tail once entries are saved', () => {
    const log = new SimLog();
    for (let i = 0; i < RECENT_LOG + 50; i++) entry(log, i);
    log.acknowledgeSaved(RECENT_LOG + 50);
    const kept = log.snapshot().entries;
    expect(kept).toHaveLength(RECENT_LOG);
    expect(kept[0]?.seq).toBe(51);
    expect(log.snapshot().nextSeq).toBe(RECENT_LOG + 51);
  });

  it('keeps unsaved entries when a save fails, and writes them with the next one', async () => {
    const store = new MemoryWorldStore();
    const host = new ManualHostClock();
    const runner = await SimulationRunner.open({ store, host, newWorld });

    store.failNext = new Error('disk full');
    runner.execute({ type: 'acquireAircraft', ...fixtureOrder('fastJet', places.prestwick) });
    await runner.flush();
    expect(runner.view().checkpoint.lastError).toBe('disk full');
    expect(store.latest?.snapshot.log.entries).toEqual([]);

    runner.execute({ type: 'acquireAircraft', ...fixtureOrder('transport', places.newquay) });
    await runner.flush();
    expect(runner.view().checkpoint.lastError).toBeNull();
    expect(store.latest?.snapshot.log.entries.map((saved) => saved.seq)).toEqual([1, 2]);
    expect(runner.view().logLength).toBe(2);
  });
});

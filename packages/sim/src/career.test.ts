import {
  CAREER,
  ROUTINE,
  careerTotals,
  contributions,
  routineReserve,
  withContributions,
  type CareerCounters,
  type CareerMission,
  type MissionType,
  type RoutePoint,
} from '@aegis/domain';
import { describe, expect, it } from 'vitest';
import { EMPTY_CAREER } from './career';
import { SimulationEngine } from './engine';
import { CommandRejected } from './fleet';
import type { LogEntry } from './log';
import { NO_ROUTINE } from './missions';
import { replayComparable, replayWorld } from './replay';
import { FIXTURES, fixtureOrder } from './testing';
import { SIM_MODEL_VERSION, type WorldSnapshot } from './world';

/*
 * V2 foundation (ADR 0030, ADR 0031): a career world operates by itself, with ordinary missions
 * the world tasks and launches; command days accumulate a record that is a fold over the log;
 * and all of it is deterministic, reloads exactly and replays from the seed.
 */

const { places } = FIXTURES;
const HOUR = 3600;
const CARDIFF: RoutePoint = {
  kind: 'aerodrome',
  refId: 'fixture:egff',
  name: 'Cardiff',
  code: 'EGFF',
  lat: 51.3967,
  lon: -3.3433,
  elevationM: 67,
};
const copyOf = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const newWorld = (seed = 'career') => ({ seed, epoch: FIXTURES.epoch });

/** Three transports and three fast jets at two bases, and somewhere to fly to. */
function world(seed?: string): SimulationEngine {
  const engine = SimulationEngine.create(newWorld(seed));
  engine.applyCommand({
    type: 'seedStarterFleet',
    aircraft: [
      fixtureOrder('transport', places.newquay),
      fixtureOrder('transport', places.newquay),
      fixtureOrder('transport', places.newquay),
      fixtureOrder('fastJet', places.prestwick),
      fixtureOrder('fastJet', places.prestwick),
      fixtureOrder('fastJet', places.prestwick),
    ],
  });
  engine.applyCommand({
    type: 'setOperatingArea',
    places: [places.newquay, places.exeter, places.prestwick, CARDIFF],
  });
  return engine;
}
/** A career that has run for six hours before command is taken. */
function career(seed?: string, preludeS = 6 * HOUR): SimulationEngine {
  const engine = world(seed);
  engine.applyCommand({ type: 'beginCareer' });
  engine.runSteps(preludeS);
  engine.applyCommand({ type: 'takeCommand' });
  return engine;
}
const log = (engine: SimulationEngine): readonly LogEntry[] => engine.snapshot().log.entries;
const count = (entries: readonly LogEntry[], type: string) =>
  entries.filter((entry) => entry.type === type).length;
const missionsOf = (engine: SimulationEngine) => engine.snapshot().missions.missions;
const rejection = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof CommandRejected) return error.message;
    throw error;
  }
  throw new Error('expected the command to be refused');
};

describe('a world that is not a career', () => {
  it('is exactly as it was: nothing is tasked, nothing launches, and there is no record', () => {
    const engine = world();
    engine.runSteps(12 * HOUR);
    expect(count(log(engine), 'routineTasked')).toBe(0);
    expect(count(log(engine), 'missionLaunched')).toBe(0);
    expect(missionsOf(engine).every((mission) => mission.routine === undefined)).toBe(true);
    expect(engine.snapshot().fleet.flights).toEqual([]);
    expect(engine.snapshot().career).toEqual(EMPTY_CAREER);
    expect(engine.snapshot().missions.routine).toEqual(NO_ROUTINE);
    expect(engine.missionsView().routineEnabled).toBe(false);
    expect(engine.careerView()).toMatchObject({ establishedTick: null, day: null, closedDays: 0 });
  });

  it('cannot have command taken or a day ended', () => {
    const engine = world();
    expect(rejection(() => engine.applyCommand({ type: 'takeCommand' }))).toMatch(/not a career/);
    expect(rejection(() => engine.applyCommand({ type: 'endCommandDay' }))).toMatch(
      /no command day/,
    );
    // A refused command leaves no entry.
    expect(log(engine).map((entry) => entry.type)).toEqual([
      'seedStarterFleet',
      'setOperatingArea',
    ]);
  });
});

describe('beginning a career', () => {
  it('is one logged command by the application, and happens once', () => {
    const engine = world();
    engine.runSteps(100);
    expect(engine.applyCommand({ type: 'beginCareer' })).toBe(true);
    expect(log(engine).at(-1)).toMatchObject({
      tick: 100,
      kind: 'command',
      type: 'beginCareer',
      actor: 'system',
    });
    expect(engine.snapshot().career).toEqual({ establishedTick: 100, day: null, days: [] });
    expect(engine.missionsView().routineEnabled).toBe(true);
    const length = log(engine).length;
    expect(engine.applyCommand({ type: 'beginCareer' })).toBe(false);
    expect(log(engine)).toHaveLength(length);
  });

  it('records nothing until command is taken', () => {
    const engine = world();
    engine.applyCommand({ type: 'beginCareer' });
    engine.runSteps(6 * HOUR);
    // The world has been busy, and none of it is the commander's record.
    expect(count(log(engine), 'missionLaunched')).toBeGreaterThan(0);
    expect(engine.careerView()).toMatchObject({ day: null, closedDays: 0 });
    expect(engine.careerView().totals).toMatchObject({ days: 0, commandSeconds: 0, counters: {} });
  });
});

describe('a world that operates by itself', { timeout: 120_000 }, () => {
  it('has a past when command is taken: flights flown, aircraft in the air or being turned round', () => {
    const engine = career();
    const entries = log(engine);
    expect(count(entries, 'routineTasked')).toBeGreaterThanOrEqual(4);
    expect(count(entries, 'missionLaunched')).toBeGreaterThanOrEqual(3);
    expect(count(entries, 'missionCompleted')).toBeGreaterThanOrEqual(1);
    expect(count(entries, 'flightFuelExhausted')).toBe(0);
    const fleet = engine.snapshot().fleet.aircraft;
    const busy = fleet.filter((aircraft) => aircraft.status !== 'available');
    expect(busy.length).toBeGreaterThan(0);
  });

  it('flies ordinary missions: planned, accepted, prepared, launched by the world, and judged', () => {
    const engine = career();
    const routine = missionsOf(engine).filter((mission) => mission.routine);
    expect(routine.length).toBeGreaterThan(0);
    for (const mission of routine) {
      expect(mission).toMatchObject({ source: 'generated', priority: 'routine', routine: true });
      expect(mission.plan).not.toBeNull();
      expect(mission.acceptance).not.toBeNull();
      expect(mission.description).toMatch(/^Routine tasking, flown by the simulated world\./);
    }
    const done = routine.find((mission) => mission.status === 'completed');
    if (!done) throw new Error('no routine mission has completed');
    const history = log(engine).filter((entry) => entry.missionId === done.id);
    expect(history.map((entry) => entry.type)).toEqual(
      expect.arrayContaining([
        'routineTasked',
        'servicingStarted',
        'servicingCompleted',
        'missionLaunched',
        'flightCompleted',
        'missionCompleted',
      ]),
    );
    // Everything the world did is an event of the world's, never a command.
    expect(history.every((entry) => entry.kind === 'event' && entry.actor === 'world')).toBe(true);
    // It left when its aircraft was ready, and not before.
    const ready = history.find((entry) => entry.type === 'servicingCompleted');
    const launched = history.find((entry) => entry.type === 'missionLaunched');
    expect(launched?.tick).toBeGreaterThanOrEqual(ready?.tick ?? Infinity);
    expect(launched?.tick).toBe(done.actualStartTick);
    expect(launched).toMatchObject({ flightId: done.flightId, payload: { routine: true } });
    expect(log(engine).find((entry) => entry.type === 'missionCompleted')?.payload).toMatchObject({
      missionType: expect.any(String) as string,
      routine: true,
    });
  });

  it('keeps a reserve of each category untasked, for the commander', () => {
    expect([0, 1, 2, 3, 4, 6, 7].map(routineReserve)).toEqual([0, 0, 1, 1, 2, 2, 3]);
    const engine = world();
    engine.applyCommand({ type: 'beginCareer' });
    // Through a whole day, of the three aircraft of each category at least one is committed
    // to nothing the world has tasked.
    for (let step = 0; step < 24 * HOUR; step += 60) {
      engine.runSteps(60);
      const committed = new Set(
        missionsOf(engine)
          .filter((mission) => mission.status === 'accepted' || mission.status === 'active')
          .map((mission) => mission.aircraftId),
      );
      for (const category of ['transport', 'fast_jet']) {
        const held = engine
          .snapshot()
          .fleet.aircraft.filter(
            (aircraft) => aircraft.category === category && !committed.has(aircraft.id),
          );
        expect(held.length, `${category} at ${engine.clock.tick}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('brings an aircraft that ended away from its base home again', () => {
    const engine = career('homing', 20 * HOUR);
    const returns = missionsOf(engine).filter((mission) =>
      mission.title.startsWith('Return to base'),
    );
    expect(returns.length).toBeGreaterThan(0);
    for (const mission of returns.filter((each) => each.status === 'completed')) {
      const home = engine
        .snapshot()
        .fleet.aircraft.find((aircraft) => aircraft.id === mission.aircraftId)?.home;
      expect(mission.plan?.points.at(-1)?.code).toBe(home?.code);
    }
  });

  it('leaves every existing control with the commander', () => {
    const engine = world('controls');
    engine.applyCommand({ type: 'beginCareer' });
    engine.applyCommand({ type: 'takeCommand' });
    const waiting = () =>
      missionsOf(engine).find((mission) => mission.routine && mission.status === 'accepted');
    while (!waiting()) engine.runSteps(1);
    const mission = waiting();
    if (!mission?.aircraftId) throw new Error('setup');
    engine.applyCommand({ type: 'cancelMission', missionId: mission.id });
    expect(missionsOf(engine).find((each) => each.id === mission.id)?.status).toBe('cancelled');
    // Its aircraft is the commander's again, and the order is in the record.
    engine.runSteps(1);
    expect(engine.careerView().day?.counters).toMatchObject({
      'orders.total': 1,
      'orders.missionsCancelled': 1,
    });
    // The world does not start maintenance, and does not answer offers.
    engine.runSteps(12 * HOUR);
    expect(count(log(engine), 'startMaintenance')).toBe(0);
    expect(count(log(engine), 'acceptOffer')).toBe(0);
  });

  it('stands a routine mission down when it still cannot leave after four hours', () => {
    const engine = world('stood-down');
    engine.applyCommand({ type: 'beginCareer' });
    const waiting = () =>
      missionsOf(engine).find((mission) => mission.routine && mission.status === 'accepted');
    while (!waiting()) engine.runSteps(1);
    const mission = waiting();
    if (!mission?.aircraftId) throw new Error('setup');
    // The commander stops its preparation, so it never has its fuel and payload aboard.
    for (let elapsed = 0; elapsed <= ROUTINE.standDownAfterS + 60; elapsed += 30) {
      const aircraft = engine
        .snapshot()
        .fleet.aircraft.find((each) => each.id === mission.aircraftId);
      const still = missionsOf(engine).find((each) => each.id === mission.id);
      if (still?.status === 'accepted' && aircraft?.service?.stage === 'preparation') {
        try {
          engine.applyCommand({ type: 'stopServicing', aircraftId: aircraft.id });
        } catch {
          // Nothing running to stop at this moment.
        }
      }
      engine.runSteps(30);
    }
    const after = missionsOf(engine).find((each) => each.id === mission.id);
    if (after?.status === 'cancelled') {
      const stood = log(engine).find(
        (entry) => entry.type === 'routineStoodDown' && entry.missionId === mission.id,
      );
      expect(stood).toMatchObject({
        kind: 'event',
        actor: 'world',
        aircraftId: mission.aircraftId,
      });
      expect(stood?.tick).toBeGreaterThanOrEqual(
        (mission.acceptedTick ?? 0) + ROUTINE.standDownAfterS,
      );
    } else {
      // Its preparation finished between two stops: then it flew, which is as it should be.
      expect(['active', 'completed', 'failed']).toContain(after?.status);
    }
  });
});

describe('command days', { timeout: 120_000 }, () => {
  it('opens Day 1 when command is taken, once', () => {
    const engine = career();
    const tick = engine.clock.tick;
    expect(log(engine).at(-1)).toMatchObject({ type: 'takeCommand', actor: 'player', tick });
    expect(engine.careerView()).toMatchObject({
      day: { number: 1, startedTick: tick, endedTick: null, counters: {} },
      closedDays: 0,
      dayMayEndTick: tick + CAREER.minDayS,
    });
    expect(rejection(() => engine.applyCommand({ type: 'takeCommand' }))).toMatch(/already/);
  });

  it('cannot be ended before a simulated hour, and is never forced to end', () => {
    const engine = career();
    engine.runSteps(CAREER.minDayS - 1);
    expect(rejection(() => engine.applyCommand({ type: 'endCommandDay' }))).toMatch(
      /only just begun.*1 min/,
    );
    // Left alone, the day goes on: nothing ends it but the commander.
    engine.runSteps(30 * HOUR);
    expect(engine.careerView()).toMatchObject({ day: { number: 1 }, closedDays: 0 });
    expect(engine.careerView().totals.commandSeconds).toBe(30 * HOUR + CAREER.minDayS - 1);
  });

  it('closes a day and opens the next at the same tick, with no gap and no jump in time', () => {
    const engine = career();
    const start = engine.clock.tick;
    engine.runSteps(8 * HOUR);
    const end = engine.clock.tick;
    const first = engine.careerView().day;
    engine.applyCommand({ type: 'endCommandDay' });
    expect(engine.clock.tick).toBe(end);
    const view = engine.careerView();
    expect(view.recentDays).toEqual([{ ...first, endedTick: end }]);
    expect(view.day).toMatchObject({ number: 2, startedTick: end, endedTick: null, counters: {} });
    expect(view.recentDays[0]).toMatchObject({ number: 1, startedTick: start });
    expect(view.closedTotals).toMatchObject({ days: 1, commandSeconds: 8 * HOUR });
  });

  it('counts only what the log holds: each day is the fold of its own entries', () => {
    const engine = career('fold');
    const boundaries = [engine.clock.tick];
    for (const hours of [5, 9, 3]) {
      engine.runSteps(hours * HOUR);
      engine.applyCommand({ type: 'endCommandDay' });
      boundaries.push(engine.clock.tick);
    }
    engine.runSteps(2 * HOUR);
    const entries = log(engine);
    const fold = (from: number, to: number, firstSeq: number): CareerCounters =>
      entries
        .filter((entry) => entry.tick >= from && entry.tick <= to && entry.seq > firstSeq)
        .reduce<CareerCounters>((counters, entry) => {
          const type = entry.payload.missionType;
          const mission: CareerMission | null =
            typeof type === 'string'
              ? {
                  type: type as MissionType,
                  routine: entry.payload.routine === true,
                  destinationCode: typeof entry.payload.to === 'string' ? entry.payload.to : null,
                }
              : null;
          return withContributions(counters, contributions({ ...entry, mission }));
        }, {});
    // The log is complete in memory only for its recent tail, so the fold is of the last day.
    const view = engine.careerView();
    const lastStart = boundaries.at(-1) as number;
    const opening = entries.find(
      (entry) => entry.type === 'endCommandDay' && entry.tick === lastStart,
    );
    if (!opening) throw new Error('the day boundary is not in the recent log');
    expect(view.day?.counters).toEqual(fold(lastStart, engine.clock.tick, opening.seq));
    expect(Object.keys(view.day?.counters ?? {}).length).toBeGreaterThan(3);
  });

  it('keeps totals that are the sum of the days, to the unit', () => {
    const engine = career('totals');
    for (const hours of [6, 4, 10, 2]) {
      engine.runSteps(hours * HOUR);
      engine.applyCommand({ type: 'endCommandDay' });
    }
    engine.runSteps(3 * HOUR);
    const view = engine.careerView();
    const { days, day } = engine.snapshot().career;
    if (!day) throw new Error('no open day');
    expect(days.map((each) => each.number)).toEqual([1, 2, 3, 4]);
    expect(view.closedTotals).toEqual(careerTotals(days, engine.clock.tick));
    expect(view.totals).toEqual(careerTotals([...days, day], engine.clock.tick));
    expect(view.totals.days).toBe(5);
    expect(view.totals.commandSeconds).toBe(25 * HOUR);
    // A new day does not reset anything: every counter only ever grows.
    for (const [name, value] of Object.entries(view.closedTotals.counters)) {
      expect(view.totals.counters[name], name).toBeGreaterThanOrEqual(value);
    }
    expect(view.totals.counters['missions.completed']).toBeGreaterThan(0);
    expect(view.totals.counters['flights.completed']).toBe(
      days.concat(day).reduce((sum, each) => sum + (each.counters['flights.completed'] ?? 0), 0),
    );
  });

  it('measures readiness as the share of aircraft available or flying, step by step', () => {
    const engine = career('readiness');
    engine.runSteps(5 * HOUR);
    const { readiness } = engine.careerView().day ?? {};
    if (!readiness) throw new Error('no open day');
    expect(readiness.aircraftSeconds).toBe(6 * 5 * HOUR);
    expect(readiness.readySeconds).toBeLessThan(readiness.aircraftSeconds);
    expect(readiness.readySeconds).toBeGreaterThan(0);
    expect(readiness.low).toBeLessThanOrEqual(readiness.readySeconds / readiness.aircraftSeconds);
    expect(readiness.high).toBeGreaterThanOrEqual(
      readiness.readySeconds / readiness.aircraftSeconds,
    );
    expect(readiness.high).toBeLessThanOrEqual(1);
  });

  it("records the commander's orders by what they were", () => {
    const engine = world('orders');
    engine.applyCommand({ type: 'beginCareer' });
    engine.applyCommand({ type: 'takeCommand' });
    const jet = engine.snapshot().fleet.aircraft.find((each) => each.category === 'fast_jet');
    if (!jet) throw new Error('setup');
    engine.applyCommand({ type: 'serviceAircraft', aircraftId: jet.id, fuelKg: 2000 });
    engine.applyCommand({ type: 'stopServicing', aircraftId: jet.id });
    expect(engine.careerView().day?.counters).toEqual({
      'orders.total': 2,
      'orders.servicing': 1,
      'orders.servicingStopped': 1,
      'services.completed': 1,
    });
    // Taking command and ending a day are not orders, and the application's commands are not.
    engine.applyCommand({ type: 'setOperatingArea', places: [places.newquay, places.exeter] });
    expect(engine.careerView().day?.counters['orders.total']).toBe(2);
  });
});

describe('determinism, continuity and upgrade', { timeout: 180_000 }, () => {
  const script = (engine: SimulationEngine) => {
    engine.applyCommand({ type: 'beginCareer' });
    engine.runSteps(6 * HOUR + 720);
    engine.applyCommand({ type: 'takeCommand' });
    engine.runSteps(7 * HOUR);
    engine.applyCommand({ type: 'endCommandDay' });
    engine.runSteps(5 * HOUR + 17);
  };

  it('gives the same world and the same record from the same seed, and another from another', () => {
    const [a, b, other] = [world('same'), world('same'), world('different')];
    [a, b, other].forEach(script);
    expect(a.snapshot()).toEqual(b.snapshot());
    expect(other.snapshot().missions.missions).not.toEqual(a.snapshot().missions.missions);
  });

  it('is the same world stepped one tick at a time or in batches', () => {
    const batched = world('batches');
    const single = world('batches');
    for (const engine of [batched, single]) engine.applyCommand({ type: 'beginCareer' });
    batched.runSteps(9 * HOUR);
    for (let tick = 0; tick < 9 * HOUR; tick++) single.runSteps(1);
    expect(single.snapshot()).toEqual(batched.snapshot());
  });

  it('goes on to the same world and record however often it is saved and restored', () => {
    const uninterrupted = world('restored');
    script(uninterrupted);
    let engine = world('restored');
    engine.applyCommand({ type: 'beginCareer' });
    const stops: [number, (() => void) | null][] = [
      [6 * HOUR + 720, () => engine.applyCommand({ type: 'takeCommand' })],
      [7 * HOUR, () => engine.applyCommand({ type: 'endCommandDay' })],
      [5 * HOUR + 17, null],
    ];
    for (const [steps, then] of stops) {
      for (let done = 0; done < steps;) {
        const slice = Math.min(977, steps - done);
        engine.runSteps(slice);
        done += slice;
        engine = SimulationEngine.restore(copyOf(engine.snapshot()));
      }
      then?.();
    }
    // The log in memory is a tail that depends on what was saved, so it is compared by length.
    expect(replayComparable(engine.snapshot())).toEqual(replayComparable(uninterrupted.snapshot()));
    expect(engine.careerView()).toEqual(uninterrupted.careerView());
  });

  it('is re-derived from its seed and its log, record and all', () => {
    const engine = world('replayed');
    const entries: LogEntry[] = [];
    const collect = () => {
      const seen = entries.at(-1)?.seq ?? 0;
      entries.push(...log(engine).filter((entry) => entry.seq > seen));
      engine.acknowledgeLogSaved(entries.at(-1)?.seq ?? 0);
    };
    collect();
    engine.applyCommand({ type: 'beginCareer' });
    for (let hour = 0; hour < 20; hour++) {
      engine.runSteps(HOUR);
      if (hour === 6) engine.applyCommand({ type: 'takeCommand' });
      if (hour === 13) engine.applyCommand({ type: 'endCommandDay' });
      collect();
    }
    expect(entries.map((entry) => entry.seq)).toEqual(entries.map((_, index) => index + 1));
    const replayed = replayWorld(newWorld('replayed'), entries, engine.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(engine.snapshot()));
    expect(replayed.snapshot().career).toEqual(engine.snapshot().career);
    expect(replayed.snapshot().career.days).toHaveLength(1);
  });

  it('upgrades a model-9 world: it is not a career, and nothing in it changes', () => {
    expect(SIM_MODEL_VERSION).toBe(10);
    const engine = world('upgrade');
    engine.runSteps(2 * HOUR);
    const without = <T extends object>(value: T, key: keyof T) =>
      Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
    const saved = without(engine.snapshot(), 'career');
    const old = {
      ...saved,
      missions: without(engine.snapshot().missions, 'routine'),
      modelVersion: 9,
    } as unknown as WorldSnapshot;
    const upgraded = SimulationEngine.restore(copyOf(old));
    expect(upgraded.snapshot().modelVersion).toBe(SIM_MODEL_VERSION);
    expect(upgraded.snapshot().career).toEqual(EMPTY_CAREER);
    expect(upgraded.snapshot().missions.routine).toEqual(NO_ROUTINE);
    expect(upgraded.snapshot().fleet).toEqual(engine.snapshot().fleet);
    // Left alone it stays as a world of its kind was: nothing flies by itself.
    upgraded.runSteps(12 * HOUR);
    engine.runSteps(12 * HOUR);
    expect(count(log(upgraded), 'routineTasked')).toBe(0);
    expect(upgraded.snapshot().fleet).toEqual(engine.snapshot().fleet);
    expect(upgraded.snapshot().missions).toEqual(engine.snapshot().missions);
    // A career can be begun in it, and then it operates.
    upgraded.applyCommand({ type: 'beginCareer' });
    upgraded.applyCommand({ type: 'takeCommand' });
    upgraded.runSteps(6 * HOUR);
    expect(count(log(upgraded), 'missionLaunched')).toBeGreaterThan(0);
    expect(upgraded.careerView().day?.number).toBe(1);
  });

  it('refuses a saved career that does not hold together', () => {
    const engine = career('broken');
    engine.runSteps(2 * HOUR);
    engine.applyCommand({ type: 'endCommandDay' });
    const saved = engine.snapshot();
    const day = saved.career.days[0];
    if (!day) throw new Error('setup');
    const broken = (change: Partial<WorldSnapshot['career']>) => () =>
      SimulationEngine.restore({ ...saved, career: { ...saved.career, ...change } });
    expect(broken({ days: [{ ...day, number: 2 }] })).toThrow(/career/);
    expect(broken({ days: [{ ...day, endedTick: null }] })).toThrow(/career/);
    expect(broken({ establishedTick: null })).toThrow(/career/);
    expect(broken({ days: [{ ...day, endedTick: day.startedTick + 1 }] })).toThrow(/career/);
  });
});

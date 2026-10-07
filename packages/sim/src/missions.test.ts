import {
  GENERATION,
  MISSION_TEMPLATES,
  defaultBrief,
  type Mission,
  type MissionBrief,
  type MissionType,
  type RoutePoint,
} from '@aegis/domain';
import { describe, expect, it } from 'vitest';
import { SimulationEngine, WorldRestoreError, type WorldCommand } from './engine';
import { CommandRejected, type AircraftState } from './fleet';
import type { LogEntry } from './log';
import { defaultConfiguration, type ConfigurationOptions } from './missions';
import { replayComparable, replayWorld } from './replay';
import { SimulationRunner } from './runner';
import {
  FIXTURES,
  ManualHostClock,
  MemoryWorldStore,
  fixtureLaunch,
  fixtureOrder,
  launchFuelled,
  launchMissionWhenReady,
  untilServiced,
} from './testing';
import { SIM_MODEL_VERSION, type WorldSnapshot } from './world';

const { places, models } = FIXTURES;
const newWorld = (seed = 'mission-world') => ({ seed, epoch: FIXTURES.epoch });
const AREA = { name: 'Area 1', lat: 49.4, lon: -7.2 };
const JET = 'AEGIS-FT-001';
const TRANSPORT = 'AEGIS-TR-001';
const copyOf = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A fast jet at Prestwick and a transport at Newquay. */
function world(seed?: string): SimulationEngine {
  const engine = SimulationEngine.create(newWorld(seed));
  engine.applyCommand({
    type: 'seedStarterFleet',
    aircraft: [
      fixtureOrder('fastJet', places.prestwick),
      fixtureOrder('transport', places.newquay),
    ],
  });
  return engine;
}
const aircraftOf = (engine: SimulationEngine, id: string): AircraftState => {
  const found = engine.snapshot().fleet.aircraft.find((aircraft) => aircraft.id === id);
  if (!found) throw new Error(`no aircraft ${id}`);
  return found;
};
const missionOf = (engine: SimulationEngine, id = 'MSN-000001'): Mission => {
  const found = engine.snapshot().missions.missions.find((mission) => mission.id === id);
  if (!found) throw new Error(`no mission ${id}`);
  return found;
};
const log = (engine: SimulationEngine): readonly LogEntry[] => engine.snapshot().log.entries;
const logTypes = (engine: SimulationEngine) => log(engine).map((entry) => entry.type);
const briefFor = (type: MissionType, overrides: Partial<MissionBrief>): MissionBrief => ({
  ...defaultBrief(MISSION_TEMPLATES[type]),
  ...overrides,
});

function create(
  engine: SimulationEngine,
  type: MissionType,
  brief: MissionBrief,
  aircraftId: string | null,
  options: ConfigurationOptions = {},
): WorldCommand {
  const command: WorldCommand = {
    type: 'createMission',
    missionType: type,
    ...defaultConfiguration(type, brief, aircraftId ? aircraftOf(engine, aircraftId) : null, {
      ...options,
      context: engine.planContext(),
    }),
  };
  engine.applyCommand(command);
  return command;
}
const training = (engine: SimulationEngine) =>
  create(engine, 'training', briefFor('training', { target: AREA }), TRANSPORT);
function runUntilFinished(engine: SimulationEngine, id = 'MSN-000001', limit = 60_000): void {
  for (let i = 0; i < limit && missionOf(engine, id).status === 'active'; i += 50) {
    engine.runSteps(50);
  }
}

describe('creating and configuring a mission', () => {
  it('creates a planned mission from a template, an aircraft and a brief', () => {
    const engine = world();
    engine.runSteps(10);
    training(engine);
    const mission = missionOf(engine);
    expect(mission).toMatchObject({
      id: 'MSN-000001',
      type: 'training',
      source: 'manual',
      status: 'planned',
      priority: 'routine',
      title: 'Training: Area 1',
      aircraftId: TRANSPORT,
      flightId: null,
      createdTick: 10,
      acceptedTick: null,
      outcome: null,
    });
    expect(mission.plan?.points.map((point) => point.name)).toEqual([
      'Newquay',
      'Area 1',
      'Newquay',
    ]);
    expect(mission.objectives.map((objective) => [objective.id, objective.status])).toEqual([
      ['O1', 'pending'],
      ['O2', 'pending'],
      ['O3', 'pending'],
      ['O4', 'pending'],
    ]);
  });

  it('keeps a mission a draft until it has an aircraft and a route', () => {
    const engine = world();
    create(engine, 'logistics', briefFor('logistics', {}), null);
    expect(missionOf(engine)).toMatchObject({ status: 'draft', aircraftId: null, plan: null });

    const brief = briefFor('logistics', { destination: places.exeter, payloadKg: 8000 });
    engine.applyCommand({
      type: 'updateMission',
      missionId: 'MSN-000001',
      ...defaultConfiguration('logistics', brief, aircraftOf(engine, TRANSPORT)),
    });
    expect(missionOf(engine)).toMatchObject({
      status: 'planned',
      aircraftId: TRANSPORT,
      load: { payloadKg: 8000 },
    });
  });

  it('numbers missions in sequence and never reuses a number', () => {
    const engine = world();
    training(engine);
    engine.applyCommand({ type: 'cancelMission', missionId: 'MSN-000001' });
    training(engine);
    expect(engine.snapshot().missions.missions.map((mission) => mission.id)).toEqual([
      'MSN-000001',
      'MSN-000002',
    ]);
  });

  it('lets the player change the route of a planned mission', () => {
    const engine = world();
    training(engine);
    const mission = missionOf(engine);
    const plan = mission.plan as NonNullable<Mission['plan']>;
    const extra: RoutePoint = {
      kind: 'waypoint',
      name: 'WP1',
      lat: 49.9,
      lon: -6.4,
      elevationM: 0,
    };
    const edited = { ...plan, points: [plan.points[0], extra, ...plan.points.slice(1)] };
    engine.applyCommand({
      type: 'updateMission',
      missionId: mission.id,
      ...defaultConfiguration('training', mission.brief, aircraftOf(engine, TRANSPORT)),
      plan: edited as NonNullable<Mission['plan']>,
    });
    expect(missionOf(engine).plan?.points.map((point) => point.name)).toEqual([
      'Newquay',
      'WP1',
      'Area 1',
      'Newquay',
    ]);
    expect(log(engine).at(-1)).toMatchObject({ type: 'updateMission', missionId: 'MSN-000001' });
    expect((log(engine).at(-1)?.payload as { plan: unknown }).plan).toEqual(edited);
  });

  it('rejects an invalid configuration and leaves the world untouched', () => {
    const engine = world();
    const before = engine.snapshot();
    const valid = defaultConfiguration(
      'training',
      briefFor('training', { target: AREA }),
      aircraftOf(engine, TRANSPORT),
    );
    const attempt = (overrides: object) => () =>
      engine.applyCommand({
        type: 'createMission',
        missionType: 'training',
        ...valid,
        ...overrides,
      });
    expect(attempt({ title: '  ' })).toThrow(/needs a title/);
    expect(attempt({ aircraftId: 'AEGIS-XX-404' })).toThrow(/no aircraft/);
    expect(attempt({ load: null })).toThrow(/set together/);
    expect(attempt({ missionType: 'bombing' })).toThrow(/not a mission type/);
    expect(
      attempt({
        objectives: [{ label: 'x', spec: { kind: 'deliver_payload', massKg: -1 }, required: true }],
      }),
    ).toThrow(CommandRejected);
    expect(engine.snapshot()).toEqual(before);
  });
});

describe('mission lifecycle', () => {
  it('accepts a planned mission, recording the estimate and the risk', () => {
    const engine = world();
    training(engine);
    engine.runSteps(5);
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    const mission = missionOf(engine);
    expect(mission).toMatchObject({ status: 'accepted', acceptedTick: 5 });
    expect(mission.assessment?.assessedTick).toBe(5);
    expect(mission.assessment?.durationS).toBeGreaterThan(0);
    expect(mission.assessment?.risk.contributors.length).toBeGreaterThan(0);
    const entries = log(engine);
    const accepted = entries.findIndex((entry) => entry.type === 'acceptMission');
    expect(entries[accepted]).toMatchObject({
      type: 'acceptMission',
      actor: 'player',
      missionId: 'MSN-000001',
      aircraftId: TRANSPORT,
    });
    // Committing the aircraft began loading the mission's fuel, and the log says so (ADR 0027).
    expect(entries.slice(accepted + 1).map((entry) => entry.type)).toEqual([
      'servicingStarted',
      'refuellingStarted',
    ]);
    expect(entries[accepted + 1]).toMatchObject({
      kind: 'event',
      actor: 'world',
      tick: 5,
      missionId: 'MSN-000001',
      aircraftId: TRANSPORT,
      payload: { reason: 'preparation', targetFuelKg: mission.load?.fuelKg },
    });
    expect(aircraftOf(engine, TRANSPORT)).toMatchObject({
      status: 'servicing',
      service: { reason: 'preparation', stage: 'preparation', missionId: 'MSN-000001' },
    });
  });

  it('keeps what was accepted apart from what held at launch, and changes neither afterwards', () => {
    const engine = world();
    training(engine);
    engine.runSteps(5);
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    const accepted = missionOf(engine);
    expect(accepted.acceptance?.assessedTick).toBe(5);
    // Until launch, the figures for the departure are the ones accepted.
    expect(accepted.assessment).toEqual(accepted.acceptance);

    // Six hours later the weather on the route is not what it was.
    engine.runSteps(6 * 3600);
    expect(missionOf(engine).acceptance).toEqual(accepted.acceptance);
    launchMissionWhenReady(engine, 'MSN-000001');
    const atLaunch = missionOf(engine);
    expect(atLaunch.acceptance).toEqual(accepted.acceptance);
    expect(atLaunch.assessment?.assessedTick).toBe(5 + 6 * 3600);
    expect(atLaunch.assessment?.durationS).not.toBe(accepted.acceptance?.durationS);
    // Both use the one risk model: the same named contributors, each with its own reasons.
    const ids = (assessment: typeof atLaunch.assessment) =>
      assessment?.risk.contributors.map((contributor) => contributor.id).sort();
    expect(ids(atLaunch.assessment)).toEqual(ids(accepted.acceptance));

    // Flying the mission, and the weather it meets, change neither record.
    runUntilFinished(engine);
    const finished = missionOf(engine);
    expect(finished.status).toBe('completed');
    expect(finished.acceptance).toEqual(accepted.acceptance);
    expect(finished.assessment).toEqual(atLaunch.assessment);
  });

  it('treats a mission saved before acceptance figures were kept as not recorded', () => {
    const engine = world();
    training(engine);
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    const snapshot = engine.snapshot();
    const old = {
      ...snapshot,
      modelVersion: 4,
      missions: {
        ...snapshot.missions,
        missions: snapshot.missions.missions.map((mission) =>
          Object.fromEntries(Object.entries(mission).filter(([key]) => key !== 'acceptance')),
        ),
      },
    };
    const upgraded = SimulationEngine.restore(old as never);
    const mission = missionOf(upgraded);
    // Nothing is made up for it: the figures at acceptance are simply absent.
    expect(mission.acceptance).toBeNull();
    expect(mission.assessment).toEqual(missionOf(engine).assessment);
    expect(upgraded.snapshot().modelVersion).toBe(SIM_MODEL_VERSION);
    // It can still be launched and flown.
    launchMissionWhenReady(upgraded, 'MSN-000001');
    runUntilFinished(upgraded);
    expect(missionOf(upgraded)).toMatchObject({ status: 'completed', acceptance: null });
  });

  it('refuses to accept what cannot be flown, with the reason', () => {
    const engine = world();
    create(engine, 'logistics', briefFor('logistics', {}), null);
    expect(() => engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' })).toThrow(
      /cannot be accepted/,
    );

    // A fast jet asked to carry far more than it can lift: the flight planner blocks it.
    const heavy = briefFor('logistics', { destination: places.newquay, payloadKg: 40_000 });
    create(engine, 'logistics', heavy, JET);
    expect(missionOf(engine, 'MSN-000002').status).toBe('planned');
    expect(() => engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000002' })).toThrow(
      /exceeds the maximum/,
    );
    expect(missionOf(engine, 'MSN-000002').status).toBe('planned');
  });

  it('commits an aircraft to one mission at a time', () => {
    const engine = world();
    training(engine);
    training(engine);
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    expect(() => engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000002' })).toThrow(
      /already committed to MSN-000001/,
    );
  });

  it('will not let a committed aircraft be flown on anything else', () => {
    const engine = world();
    training(engine);
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    const flight = fixtureLaunch(TRANSPORT, models.transport, places.newquay, places.exeter);
    expect(() => engine.applyCommand(flight)).toThrow(/committed to MSN-000001/);

    engine.applyCommand({ type: 'releaseMission', missionId: 'MSN-000001' });
    expect(missionOf(engine)).toMatchObject({
      status: 'planned',
      acceptance: null,
      assessment: null,
    });
    expect(launchFuelled(engine, flight)).toBe(true);
  });

  it('only lets an accepted mission be edited after it is released', () => {
    const engine = world();
    training(engine);
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    const update: WorldCommand = {
      type: 'updateMission',
      missionId: 'MSN-000001',
      ...defaultConfiguration(
        'training',
        briefFor('training', { target: AREA }),
        aircraftOf(engine, TRANSPORT),
      ),
    };
    expect(() => engine.applyCommand(update)).toThrow(/release it before changing it/);
  });

  it('cancels before launch, and not after', () => {
    const engine = world();
    training(engine);
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    engine.applyCommand({ type: 'cancelMission', missionId: 'MSN-000001' });
    expect(missionOf(engine)).toMatchObject({ status: 'cancelled', completedTick: 0 });
    // The aircraft is free again.
    expect(
      launchFuelled(
        engine,
        fixtureLaunch(TRANSPORT, models.transport, places.newquay, places.exeter),
      ),
    ).toBe(true);

    const second = world();
    training(second);
    second.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    launchMissionWhenReady(second, 'MSN-000001');
    expect(() => second.applyCommand({ type: 'cancelMission', missionId: 'MSN-000001' })).toThrow(
      /is active; it cannot be cancelled/,
    );
  });

  it('cannot launch a mission that has not been accepted', () => {
    const engine = world();
    training(engine);
    expect(() => engine.applyCommand({ type: 'launchMission', missionId: 'MSN-000001' })).toThrow(
      /is planned; it cannot be launched/,
    );
  });

  it('fails a mission that is not launched before its deadline', () => {
    const engine = world();
    create(engine, 'training', briefFor('training', { target: AREA }), TRANSPORT, {
      completeByTick: 20_000,
    });
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    engine.runSteps(20_000);
    expect(missionOf(engine).status).toBe('accepted');
    engine.runSteps(1);
    expect(missionOf(engine)).toMatchObject({
      status: 'failed',
      completedTick: 20_001,
      outcome: { result: 'failed', summary: 'Not launched before its deadline.' },
    });
    expect(log(engine).at(-1)).toMatchObject({ type: 'missionFailed', tick: 20_001 });
    // A failed mission no longer holds its aircraft.
    expect(
      launchFuelled(
        engine,
        fixtureLaunch(TRANSPORT, models.transport, places.newquay, places.exeter),
      ),
    ).toBe(true);
  });
});

describe('mission and flight', () => {
  function launched(): SimulationEngine {
    const engine = world();
    training(engine);
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    engine.runSteps(30);
    launchMissionWhenReady(engine, 'MSN-000001');
    return engine;
  }

  it('launches an ordinary flight that carries the mission’s plan and load', () => {
    const engine = launched();
    const mission = missionOf(engine);
    const flight = engine.snapshot().fleet.flights[0];
    expect(mission).toMatchObject({
      status: 'active',
      flightId: 'FLT-000001',
      actualStartTick: engine.clock.tick,
    });
    expect(flight).toMatchObject({
      id: 'FLT-000001',
      missionId: 'MSN-000001',
      aircraftId: TRANSPORT,
      status: 'active',
      plan: mission.plan,
      fuelAtDepartureKg: mission.load?.fuelKg,
    });
    expect(aircraftOf(engine, TRANSPORT).status).toBe('in_flight');
    expect(log(engine).at(-1)).toMatchObject({
      type: 'launchMission',
      missionId: 'MSN-000001',
      aircraftId: TRANSPORT,
      flightId: 'FLT-000001',
      payload: { type: 'launchMission', missionId: 'MSN-000001' },
    });
  });

  it('is refused by the fleet when the aircraft cannot fly, and stays accepted', () => {
    const engine = world();
    training(engine);
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    untilServiced(engine, TRANSPORT);
    engine.applyCommand({ type: 'startMaintenance', aircraftId: TRANSPORT });
    const before = engine.snapshot();
    expect(() => engine.applyCommand({ type: 'launchMission', missionId: 'MSN-000001' })).toThrow(
      /AEGIS-TR-001 is in maintenance/,
    );
    expect(engine.snapshot()).toEqual(before);
  });

  it('updates objectives as the flight progresses and completes when it lands', () => {
    const engine = launched();
    const visit = () => missionOf(engine).objectives[0] as Mission['objectives'][number];
    const back = () => missionOf(engine).objectives[1] as Mission['objectives'][number];

    engine.runSteps(300);
    expect(visit().status).toBe('pending');
    expect(back().progress).toBeGreaterThan(0);

    // Step until the turning point is reached: the first objective completes mid-flight.
    while (visit().status === 'pending') engine.runSteps(10);
    expect(visit().status).toBe('complete');
    expect(missionOf(engine).status).toBe('active');
    expect(back().status).toBe('pending');
    const halfway = back().progress;
    expect(halfway).toBeGreaterThan(0.4);
    expect(halfway).toBeLessThan(0.6);

    runUntilFinished(engine);
    const mission = missionOf(engine);
    expect(mission.status).toBe('completed');
    expect(mission.objectives.map((objective) => objective.status)).toEqual([
      'complete',
      'complete',
      'complete',
      'complete',
    ]);
    expect(mission.outcome).toMatchObject({
      result: 'completed',
      summary: 'All 2 required objectives met.',
      objectivesComplete: 2,
      objectivesRequired: 2,
    });
    expect(mission.completedTick).toBe(mission.outcome?.decidedTick);
  });

  it('matches the estimate recorded at acceptance', () => {
    const engine = launched();
    runUntilFinished(engine);
    const mission = missionOf(engine);
    expect(mission.outcome?.flightDurationS).toBe(mission.assessment?.durationS);
    expect(mission.outcome?.fuelUsedKg).toBeCloseTo(mission.assessment?.fuelUsedKg as number, 6);
  });

  it('applies the consequences of the flight to the aircraft', () => {
    const engine = launched();
    runUntilFinished(engine);
    const aircraft = aircraftOf(engine, TRANSPORT);
    expect(aircraft).toMatchObject({
      status: 'servicing',
      location: places.newquay,
      flights: 1,
      activeFlightId: null,
    });
    expect(aircraft.conditionPct).toBeLessThan(100);
    expect(aircraft.fuelKg).toBeLessThan(missionOf(engine).load?.fuelKg as number);
  });

  it('logs the mission from creation to completion, in order', () => {
    const engine = launched();
    runUntilFinished(engine);
    expect(logTypes(engine)).toEqual([
      'seedStarterFleet',
      'createMission',
      'acceptMission',
      'servicingStarted',
      'refuellingStarted',
      'refuellingCompleted',
      'servicingCompleted',
      'launchMission',
      'objectiveCompleted',
      'flightCompleted',
      'servicingStarted',
      'objectiveCompleted',
      'objectiveCompleted',
      'objectiveCompleted',
      'missionCompleted',
    ]);
    const missionEntries = log(engine).filter((entry) => entry.missionId === 'MSN-000001');
    // The mission's own entries, and the preparation of its aircraft, which names it.
    expect(missionEntries).toHaveLength(13);
    expect(log(engine).map((entry) => entry.seq)).toEqual(log(engine).map((_, i) => i + 1));
    expect(log(engine).at(-1)).toMatchObject({
      kind: 'event',
      actor: 'world',
      payload: { summary: 'All 2 required objectives met.' },
    });
  });

  it('delivers a payload at the destination, where the turnaround takes it off', () => {
    const engine = world();
    create(
      engine,
      'logistics',
      briefFor('logistics', { destination: places.exeter, payloadKg: 9000 }),
      TRANSPORT,
    );
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    launchMissionWhenReady(engine, 'MSN-000001');
    engine.runSteps(60);
    expect(aircraftOf(engine, TRANSPORT).payloadKg).toBe(9000);
    runUntilFinished(engine);
    expect(missionOf(engine).status).toBe('completed');
    // Delivered, and the mission is complete; the payload is still aboard until the ground work
    // is done (ADR 0029). The detail is in delivery.test.ts.
    expect(aircraftOf(engine, TRANSPORT)).toMatchObject({
      status: 'servicing',
      payloadKg: 9000,
      location: places.exeter,
      service: { reason: 'turnaround', payload: { targetKg: 0 } },
    });
    untilServiced(engine, TRANSPORT);
    expect(aircraftOf(engine, TRANSPORT)).toMatchObject({ status: 'available', payloadKg: 0 });
    // Home is unchanged: a logistics mission does not rebase the aircraft.
    expect(aircraftOf(engine, TRANSPORT).home).toEqual(places.newquay);
  });

  it('rebases the aircraft when a ferry mission succeeds', () => {
    const engine = world();
    create(engine, 'ferry', briefFor('ferry', { destination: places.exeter }), TRANSPORT);
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    launchMissionWhenReady(engine, 'MSN-000001');
    runUntilFinished(engine);
    expect(aircraftOf(engine, TRANSPORT).home).toEqual(places.exeter);
  });

  it('fails a mission whose required objective is not met, while the flight still lands', () => {
    const engine = world();
    // An emergency mission with a deadline no flight could meet.
    create(
      engine,
      'emergency_response',
      briefFor('emergency_response', { destination: places.exeter, payloadKg: 5000 }),
      TRANSPORT,
      { completeByTick: 2400 },
    );
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    launchMissionWhenReady(engine, 'MSN-000001');
    expect(engine.clock.tick).toBeLessThan(2400);
    engine.runSteps(2401 - engine.clock.tick);
    // The deadline has passed: the objective has failed, the mission is still flying.
    const late = missionOf(engine);
    expect(late.status).toBe('active');
    expect(late.objectives.find((o) => o.spec.kind === 'arrive_by')).toMatchObject({
      status: 'failed',
      remark: 'Did not land before the deadline.',
    });
    runUntilFinished(engine);
    const mission = missionOf(engine);
    expect(mission).toMatchObject({
      status: 'failed',
      outcome: {
        result: 'failed',
        objectivesComplete: 2,
        objectivesRequired: 3,
        summary: '2 of 3 required objectives met. Did not land before the deadline.',
      },
    });
    expect(aircraftOf(engine, TRANSPORT)).toMatchObject({
      status: 'servicing',
      location: places.exeter,
    });
    expect(logTypes(engine)).toContain('objectiveFailed');
    expect(logTypes(engine).at(-1)).toBe('missionFailed');
  });

  it('completes a patrol by holding in the area for the required time', () => {
    const engine = world();
    create(engine, 'patrol', briefFor('patrol', { target: AREA }), JET);
    expect(missionOf(engine).status).toBe('planned');
    // A patrol from Prestwick to an area off Cornwall is a long way for the jet: plan nearer.
    const near = { name: 'Area 2', lat: 55.0, lon: -6.5 };
    engine.applyCommand({
      type: 'updateMission',
      missionId: 'MSN-000001',
      ...defaultConfiguration(
        'patrol',
        briefFor('patrol', { target: near }),
        aircraftOf(engine, JET),
      ),
    });
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    launchMissionWhenReady(engine, 'MSN-000001');
    runUntilFinished(engine);
    const mission = missionOf(engine);
    expect(mission.status).toBe('completed');
    expect(mission.objectives[0]).toMatchObject({
      spec: { kind: 'remain_in_area' },
      status: 'complete',
      accumulatedS: 30 * 60,
    });
  });
});

describe('determinism', () => {
  function scripted(batch: number): WorldSnapshot {
    const engine = world('deterministic');
    const stepTo = (tick: number) => {
      while (engine.clock.tick < tick) {
        engine.runSteps(Math.min(batch, tick - engine.clock.tick));
      }
    };
    stepTo(40);
    training(engine);
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    stepTo(100);
    launchMissionWhenReady(engine, 'MSN-000001');
    stepTo(9000);
    return engine.snapshot();
  }

  it('gives the same world whether steps run one at a time or in large batches', () => {
    expect(scripted(1)).toEqual(scripted(5000));
  });

  it('re-derives missions, objectives and outcomes from the seed and the log', () => {
    const engine = world('replayed');
    training(engine);
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    engine.runSteps(25);
    launchMissionWhenReady(engine, 'MSN-000001');
    runUntilFinished(engine);
    create(engine, 'ferry', briefFor('ferry', { destination: places.exeter }), TRANSPORT);
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000002' });
    launchMissionWhenReady(engine, 'MSN-000002');
    engine.runSteps(400);

    const replayed = replayWorld(newWorld('replayed'), log(engine), engine.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(engine.snapshot()));
    expect(log(replayed)).toEqual(log(engine));
  });
});

describe('world-generated opportunities', () => {
  const AREA_PLACES = [places.prestwick, places.newquay, places.exeter, places.akrotiri];
  function withArea(seed = 'opportunities'): SimulationEngine {
    const engine = world(seed);
    engine.applyCommand({ type: 'setOperatingArea', places: AREA_PLACES });
    return engine;
  }
  const offers = (engine: SimulationEngine) =>
    engine.snapshot().missions.missions.filter((mission) => mission.source === 'generated');
  /** Runs until the world has generated an opportunity of one of the given types. */
  function runUntilOffer(engine: SimulationEngine, types?: readonly MissionType[]): Mission {
    for (let hour = 0; hour < 5000; hour++) {
      engine.runSteps(GENERATION.intervalTicks);
      const open = offers(engine).find(
        (mission) => mission.status === 'offered' && (!types || types.includes(mission.type)),
      );
      if (open) return open;
      // Clear the queue so that generation is not held up by offers of other types.
      for (const waiting of offers(engine).filter((mission) => mission.status === 'offered')) {
        engine.applyCommand({ type: 'rejectOffer', missionId: waiting.id });
      }
    }
    throw new Error('no opportunity was generated');
  }

  it('copies the operating area into the world once, as a system command', () => {
    const engine = world();
    expect(engine.applyCommand({ type: 'setOperatingArea', places: AREA_PLACES })).toBe(true);
    // Setting the same area again changes nothing and is not logged.
    expect(engine.applyCommand({ type: 'setOperatingArea', places: AREA_PLACES })).toBe(false);
    expect(engine.snapshot().missions.places).toEqual(AREA_PLACES);
    expect(log(engine).at(-1)).toMatchObject({ type: 'setOperatingArea', actor: 'system' });
    expect(log(engine).filter((entry) => entry.type === 'setOperatingArea')).toHaveLength(1);
    expect(() => world().applyCommand({ type: 'setOperatingArea', places: [] })).toThrow(
      CommandRejected,
    );
  });

  it('replaces the operating area when the fleet has moved, keeping what was already offered', () => {
    const engine = withArea('recentre');
    const offer = runUntilOffer(engine);
    const moved = [places.akrotiri, places.exeter];
    expect(
      engine.applyCommand({
        type: 'setOperatingArea',
        places: moved,
        centre: { lat: 40, lon: 15 },
      }),
    ).toBe(true);
    expect(engine.snapshot().missions).toMatchObject({
      places: moved,
      areaCentre: { lat: 40, lon: 15 },
    });
    // The opportunity offered from the old area is still there to be taken up.
    expect(missionOf(engine, offer.id).status).toBe('offered');
    expect(log(engine).at(-1)).toMatchObject({
      type: 'setOperatingArea',
      actor: 'system',
      payload: { places: moved, centre: { lat: 40, lon: 15 } },
    });

    // From now on the world draws its places from the new area, and still replays.
    engine.runSteps(GENERATION.intervalTicks * 40);
    const later = offers(engine).filter((mission) => mission.createdTick > offer.createdTick);
    for (const mission of later) {
      if (mission.brief.destination) expect(moved).toContainEqual(mission.brief.destination);
    }
    const replayed = replayWorld(newWorld('recentre'), log(engine), engine.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(engine.snapshot()));
  });

  it('generates nothing in a world with no operating area', () => {
    const engine = world();
    engine.runSteps(GENERATION.intervalTicks * 200);
    expect(offers(engine)).toEqual([]);
    expect(engine.snapshot().rngStreams['missions.generation']).toBeUndefined();
  });

  it('generates opportunities as simulated offers with an expiry and a deadline', () => {
    const engine = withArea();
    const offer = runUntilOffer(engine);
    expect(offer).toMatchObject({
      source: 'generated',
      status: 'offered',
      aircraftId: null,
      plan: null,
      flightId: null,
    });
    expect(offer.description).toMatch(/^Simulated requirement\./);
    expect(offer.createdTick % GENERATION.intervalTicks).toBe(0);
    expect(offer.expiresTick).toBeGreaterThan(offer.createdTick);
    expect(offer.completeByTick).toBeGreaterThan(offer.expiresTick as number);
    expect(offer.objectives.length).toBeGreaterThan(0);
    expect(log(engine).find((entry) => entry.type === 'opportunityGenerated')).toMatchObject({
      kind: 'event',
      actor: 'world',
      missionId: offer.id,
      tick: offer.createdTick,
    });
  });

  it('never has more than three offers waiting, however long the world runs', () => {
    const engine = withArea('flood');
    let most = 0;
    for (let hour = 0; hour < 150; hour++) {
      engine.runSteps(GENERATION.intervalTicks);
      const open = offers(engine).filter((mission) => mission.status === 'offered').length;
      most = Math.max(most, open);
    }
    expect(most).toBeLessThanOrEqual(GENERATION.maxOpenOffers);
    expect(most).toBeGreaterThan(0);
    // Over 150 hours offers came and went; they did not pile up.
    expect(engine.snapshot().missions.generated).toBeGreaterThan(8);
    expect(engine.snapshot().missions.generated).toBeLessThan(75);
  }, 20_000);

  it('expires an offer nobody answers', () => {
    const engine = withArea();
    const offer = runUntilOffer(engine);
    engine.runSteps((offer.expiresTick as number) - engine.clock.tick - 1);
    expect(missionOf(engine, offer.id).status).toBe('offered');
    engine.runSteps(1);
    expect(missionOf(engine, offer.id)).toMatchObject({
      status: 'expired',
      completedTick: offer.expiresTick,
    });
    expect(
      log(engine).some(
        (entry) => entry.type === 'opportunityExpired' && entry.missionId === offer.id,
      ),
    ).toBe(true);
    expect(() => engine.applyCommand({ type: 'acceptOffer', missionId: offer.id })).toThrow(
      /is expired/,
    );
  });

  it('lets the player reject an offer', () => {
    const engine = withArea();
    const offer = runUntilOffer(engine);
    engine.applyCommand({ type: 'rejectOffer', missionId: offer.id });
    expect(missionOf(engine, offer.id).status).toBe('rejected');
    expect(log(engine).at(-1)).toMatchObject({ type: 'rejectOffer', actor: 'player' });
  });

  it('runs an accepted offer through the same framework as a manual mission', () => {
    const engine = withArea('accepted-offer-b');
    const offer = runUntilOffer(engine, ['logistics', 'transport', 'ferry']);
    engine.applyCommand({ type: 'acceptOffer', missionId: offer.id });
    expect(missionOf(engine, offer.id)).toMatchObject({ status: 'draft', source: 'generated' });

    // The player assigns the transport; the template routes it from where it is.
    engine.applyCommand({
      type: 'updateMission',
      missionId: offer.id,
      ...defaultConfiguration(offer.type, offer.brief, aircraftOf(engine, TRANSPORT), {
        title: offer.title,
        description: offer.description,
        priority: offer.priority,
        completeByTick: offer.completeByTick,
      }),
    });
    expect(missionOf(engine, offer.id).status).toBe('planned');
    engine.applyCommand({ type: 'acceptMission', missionId: offer.id });
    launchMissionWhenReady(engine, offer.id);
    runUntilFinished(engine, offer.id);

    const mission = missionOf(engine, offer.id);
    expect(mission).toMatchObject({
      status: 'completed',
      source: 'generated',
      aircraftId: TRANSPORT,
      outcome: { result: 'completed' },
    });
    expect(aircraftOf(engine, TRANSPORT).location).toEqual(offer.brief.destination);
  });

  it('generates the same opportunities at the same ticks from the same seed and commands', () => {
    const run = () => {
      const engine = withArea('same-offers');
      engine.runSteps(GENERATION.intervalTicks * 60);
      return engine.snapshot();
    };
    const first = run();
    expect(first.missions.generated).toBeGreaterThan(3);
    expect(run()).toEqual(first);

    const other = withArea('other-offers');
    other.runSteps(GENERATION.intervalTicks * 60);
    expect(other.snapshot().missions.missions).not.toEqual(first.missions.missions);
    // Three runs of sixty simulated hours: allow for a busy machine.
  }, 30_000);

  it('replays a world with generated and accepted opportunities from its log', () => {
    const engine = withArea('replay-offers');
    const offer = runUntilOffer(engine, ['logistics', 'transport', 'ferry']);
    engine.applyCommand({ type: 'acceptOffer', missionId: offer.id });
    engine.applyCommand({
      type: 'updateMission',
      missionId: offer.id,
      ...defaultConfiguration(offer.type, offer.brief, aircraftOf(engine, TRANSPORT), {
        completeByTick: offer.completeByTick,
      }),
    });
    engine.applyCommand({ type: 'acceptMission', missionId: offer.id });
    launchMissionWhenReady(engine, offer.id);
    engine.runSteps(GENERATION.intervalTicks * 3);

    // More than the in-memory tail may have accumulated; rebuild the whole log by replaying.
    const all = engine.snapshot().log;
    expect(all.entries[0]?.seq).toBe(1);
    const replayed = replayWorld(newWorld('replay-offers'), all.entries, engine.clock.tick);
    expect(replayComparable(replayed.snapshot())).toEqual(replayComparable(engine.snapshot()));
  });
});

describe('missions across save and restore', () => {
  it('restores an active mission and finishes it exactly as an uninterrupted run would', () => {
    const run = (interrupt: boolean) => {
      let engine = world('restore');
      training(engine);
      engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
      launchMissionWhenReady(engine, 'MSN-000001');
      engine.runSteps(1500);
      if (interrupt) engine = SimulationEngine.restore(copyOf(engine.snapshot()));
      engine.runSteps(9000);
      return engine.snapshot();
    };
    const interrupted = run(true);
    expect(interrupted).toEqual(run(false));
    expect(interrupted.missions.missions[0]?.status).toBe('completed');
  });

  it('refuses a saved active mission whose flight is not its own', () => {
    const engine = world();
    training(engine);
    engine.applyCommand({ type: 'acceptMission', missionId: 'MSN-000001' });
    launchMissionWhenReady(engine, 'MSN-000001');
    const snapshot = copyOf(engine.snapshot());
    const broken: WorldSnapshot = {
      ...snapshot,
      fleet: {
        ...snapshot.fleet,
        flights: snapshot.fleet.flights.map((flight) => ({ ...flight, missionId: null })),
      },
    };
    expect(() => SimulationEngine.restore(broken)).toThrow(WorldRestoreError);
  });

  it('gives a world saved before missions existed an empty mission state', () => {
    const old = Object.fromEntries(
      Object.entries(world().snapshot()).filter(([key]) => key !== 'missions'),
    );
    const upgraded = SimulationEngine.restore({ ...old, modelVersion: 2 } as WorldSnapshot);
    expect(upgraded.snapshot().missions).toEqual({
      missions: [],
      places: [],
      nextNumber: 1,
      generated: 0,
      areaCentre: null,
      routine: { enabled: false, tasked: 0 },
    });
  });

  it('checkpoints every mission command through the runner and shows missions in the view', async () => {
    const store = new MemoryWorldStore();
    const runner = await SimulationRunner.open({
      store,
      host: new ManualHostClock(),
      newWorld: () => newWorld('runner'),
    });
    runner.execute({
      type: 'seedStarterFleet',
      aircraft: [fixtureOrder('transport', places.newquay)],
    });
    const aircraft = runner.view().fleet.aircraft[0] as AircraftState;
    runner.execute({
      type: 'createMission',
      missionType: 'training',
      ...defaultConfiguration('training', briefFor('training', { target: AREA }), aircraft),
    });
    runner.execute({ type: 'acceptMission', missionId: 'MSN-000001' });
    await runner.flush();

    expect(runner.view().missions.missions[0]).toMatchObject({
      id: 'MSN-000001',
      status: 'accepted',
    });
    expect(store.latest?.snapshot.missions.missions[0]?.status).toBe('accepted');
    expect(store.latest?.snapshot.log.entries.map((entry) => entry.type)).toEqual([
      'seedStarterFleet',
      'createMission',
      'acceptMission',
      'servicingStarted',
      'refuellingStarted',
    ]);
    expect(() => {
      runner.execute({ type: 'launchMission', missionId: 'MSN-000404' });
    }).toThrow(CommandRejected);
  });
});

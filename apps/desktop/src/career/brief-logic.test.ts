import { MISSION_TEMPLATES, defaultBrief, type Mission, type WorldEvent } from '@aegis/domain';
import {
  SimulationEngine,
  SimulationRunner,
  defaultConfiguration,
  type SimView,
  type WorldSnapshot,
} from '@aegis/sim';
import { FIXTURES, ManualHostClock, MemoryWorldStore, fixtureOrder } from '@aegis/sim/testing';
import { describe, expect, it } from 'vitest';
import { dailyBrief } from './brief-logic';

/*
 * The briefing is read from the world (ADR 0031). Each test puts the world in a state with the
 * simulation's own commands, or by editing a saved world the engine then accepts, and checks
 * that the brief says exactly that.
 */

const { places } = FIXTURES;
const T1 = 'AEGIS-TR-001';
const T2 = 'AEGIS-TR-002';
const T3 = 'AEGIS-TR-003';

function world(): SimulationEngine {
  const engine = SimulationEngine.create({ seed: 'brief', epoch: FIXTURES.epoch });
  engine.applyCommand({
    type: 'seedStarterFleet',
    aircraft: [
      fixtureOrder('transport', places.newquay),
      fixtureOrder('transport', places.newquay),
      fixtureOrder('transport', places.newquay),
      fixtureOrder('fastJet', places.prestwick),
    ],
  });
  engine.applyCommand({
    type: 'setOperatingArea',
    places: [places.newquay, places.exeter, places.akrotiri],
  });
  return engine;
}
/** The view the interface is given of a world, edited first if asked. */
async function viewOf(
  engine: SimulationEngine,
  edit: (snapshot: WorldSnapshot) => WorldSnapshot = (snapshot) => snapshot,
): Promise<SimView> {
  const store = new MemoryWorldStore({
    seq: 1,
    wallTimeMs: 1,
    snapshot: edit(engine.snapshot()),
  });
  const runner = await SimulationRunner.load({ store, host: new ManualHostClock() });
  if (!runner) throw new Error('no world');
  return runner.view();
}
function accepted(engine: SimulationEngine, aircraftId: string, to = places.exeter): string {
  const before = new Set(engine.snapshot().missions.missions.map((each) => each.id));
  const aircraft = engine.snapshot().fleet.aircraft.find((each) => each.id === aircraftId);
  if (!aircraft) throw new Error('setup');
  engine.applyCommand({
    type: 'createMission',
    missionType: 'logistics',
    ...defaultConfiguration(
      'logistics',
      { ...defaultBrief(MISSION_TEMPLATES.logistics), destination: to, payloadKg: 2000 },
      aircraft,
      { context: engine.planContext() },
    ),
  });
  const id = engine.snapshot().missions.missions.find((each) => !before.has(each.id))?.id;
  if (!id) throw new Error('setup');
  engine.applyCommand({ type: 'acceptMission', missionId: id });
  return id;
}

describe('the daily brief', () => {
  it('says a quiet world is quiet', async () => {
    const brief = dailyBrief(await viewOf(world()));
    // The fixture epoch is noon on Sunday 4 October 2026.
    expect(brief).toMatchObject({
      day: null,
      resuming: false,
      time: '12:00',
      weekday: 'Sunday',
      date: '2026-10-04',
      priorities: [],
      air: {
        ready: 4,
        owned: 4,
        available: 4,
        airborne: 0,
        servicing: 0,
        unavailable: 0,
        activeMissions: 0,
        routineMissions: 0,
        overseas: 0,
        eventsActive: 0,
        eventsAnnounced: 0,
      },
    });
    expect(brief.note).toBe(
      'Nothing currently requires intervention, and nothing is flying. The operation is quiet.',
    );
  });

  it('counts the fleet as it stands, and what is flying overseas', async () => {
    const engine = world();
    const id = accepted(engine, T1, places.akrotiri);
    accepted(engine, T2);
    while (
      engine.snapshot().fleet.aircraft.find((each) => each.id === T1)?.status !== 'available'
    ) {
      engine.runSteps(1);
    }
    engine.applyCommand({ type: 'launchMission', missionId: id });
    engine.runSteps(60);
    const view = await viewOf(engine);
    const brief = dailyBrief(view);
    const status = (aircraftId: string) =>
      view.fleet.aircraft.find((each) => each.id === aircraftId)?.status;
    expect(status(T1)).toBe('in_flight');
    expect(brief.air).toMatchObject({
      owned: 4,
      airborne: 1,
      activeMissions: 1,
      routineMissions: 0,
      overseas: 1,
    });
    expect(brief.air.ready).toBe(brief.air.available + brief.air.airborne);
    expect(brief.air.available + brief.air.airborne + brief.air.servicing).toBe(4);
    // The second mission is accepted, not launched: it waits for the commander.
    expect(brief.priorities).toContainEqual(
      expect.objectContaining({
        tone: 'info',
        title: expect.stringMatching(/^MSN-000002 accepted and not yet launched/) as string,
        route: '/missions/MSN-000002',
      }),
    );
    expect(brief.note).toMatch(
      /1 matter is waiting for you\. Routine operations are already underway\./,
    );
  });

  it('puts what needs a decision first, and says how many', async () => {
    const engine = world();
    const offer = (snapshot: WorldSnapshot): Mission => {
      const configured = defaultConfiguration(
        'emergency_response',
        {
          ...defaultBrief(MISSION_TEMPLATES.emergency_response),
          destination: places.exeter,
          payloadKg: 500,
        },
        null,
      );
      return {
        id: 'MSN-000001',
        type: 'emergency_response',
        source: 'generated',
        status: 'offered',
        priority: 'urgent',
        title: 'Emergency response: Exeter (EGTE)',
        description: 'Simulated requirement.',
        brief: configured.brief,
        aircraftId: null,
        flightId: null,
        plan: null,
        load: null,
        objectives: [],
        acceptance: null,
        assessment: null,
        outcome: null,
        createdTick: snapshot.clock.tick,
        acceptedTick: null,
        plannedStartTick: null,
        actualStartTick: null,
        completedTick: null,
        expiresTick: snapshot.clock.tick + 5400,
        completeByTick: snapshot.clock.tick + 20_000,
      };
    };
    const view = await viewOf(engine, (snapshot) => ({
      ...snapshot,
      fleet: {
        ...snapshot.fleet,
        aircraft: snapshot.fleet.aircraft.map((aircraft) =>
          aircraft.id === T3 ? { ...aircraft, status: 'maintenance_due' as const } : aircraft,
        ),
      },
      missions: { ...snapshot.missions, missions: [offer(snapshot)], nextNumber: 2 },
    }));
    const brief = dailyBrief(view);
    expect(brief.priorities.map((item) => [item.tone, item.title, item.route])).toEqual([
      ['critical', 'Urgent requirement: Emergency response: Exeter (EGTE)', '/missions/MSN-000001'],
      ['warn', `${T3} is due maintenance`, `/fleet/${T3}`],
    ]);
    expect(brief.priorities[0]?.detail).toBe(
      'Awaiting your answer. It lapses at 13:30, in 1 h 30 min.',
    );
    expect(brief.priorities[1]?.detail).toMatch(/does not fly until you order maintenance/);
    expect(brief.air).toMatchObject({ unavailable: 1, ready: 3, available: 3 });
    expect(brief.note).toBe('1 matter needs your decision now.');
  });

  it('watches the reserve, open events and aircraft nearing maintenance', async () => {
    const engine = world();
    accepted(engine, T1);
    accepted(engine, T2);
    accepted(engine, T3);
    const closure: WorldEvent = {
      id: 'EVT-000001',
      type: 'aerodrome_closure',
      status: 'scheduled',
      source: 'generated',
      severity: 0.6,
      createdTick: 0,
      startTick: 3600,
      endTick: 9000,
      place: places.exeter,
      centre: null,
      radiusM: null,
      aircraftId: null,
      missionId: null,
      title: 'Exeter closed',
      description: 'Simulated closure.',
    };
    const view = await viewOf(engine, (snapshot) => ({
      ...snapshot,
      events: { events: [closure], nextNumber: 2 },
      fleet: {
        ...snapshot.fleet,
        aircraft: snapshot.fleet.aircraft.map((aircraft) =>
          aircraft.category === 'fast_jet'
            ? { ...aircraft, flightSecondsSinceMaintenance: 49 * 3600 }
            : aircraft,
        ),
      },
    }));
    const brief = dailyBrief(view);
    const titles = brief.watch.map((item) => item.title);
    expect(titles).toContain('Aerodrome closure: Exeter (EGTE)');
    expect(titles).toContain('Reduced reserve: transports');
    expect(titles).toContain('1 aircraft approaching maintenance');
    const reserve = brief.watch.find((item) => item.title.startsWith('Reduced reserve'));
    expect(reserve).toMatchObject({ tone: 'warn', route: '/fleet' });
    expect(reserve?.detail).toMatch(/^0 of 3 available and uncommitted\./);
    expect(brief.watch.find((item) => item.title.startsWith('Aerodrome closure'))).toMatchObject({
      tone: 'info',
      detail: 'Announced. From 13:00 to 14:30.',
      route: '/overview/EVT-000001',
    });
    expect(brief.air).toMatchObject({ eventsActive: 0, eventsAnnounced: 1 });
    // Warnings come before notes.
    expect(brief.watch[0]?.tone).toBe('warn');
  });

  it('opens a day, and says when the commander is coming back to one', async () => {
    const engine = world();
    engine.applyCommand({ type: 'beginCareer' });
    engine.applyCommand({ type: 'takeCommand' });
    expect(dailyBrief(await viewOf(engine))).toMatchObject({ day: 1, resuming: false });
    engine.runSteps(1);
    expect(dailyBrief(await viewOf(engine))).toMatchObject({ day: 1, resuming: true });
  });
});

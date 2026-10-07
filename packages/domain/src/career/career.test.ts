import { describe, expect, it } from 'vitest';
import type { PerformanceModel } from '../flight/performance';
import type { RoutePoint } from '../flight/route';
import { greatCircleDistance } from '../geo';
import { GENERATION } from '../mission/generate';
import {
  ROUTINE,
  generateRoutineTask,
  routineCandidates,
  routineReserve,
  type RoutineAircraft,
} from '../mission/routine';
import { MISSION_TEMPLATES } from '../mission/templates';
import { RngStreams } from '../rng';
import {
  NO_READINESS,
  NO_TOTALS,
  careerTotals,
  contributions,
  counter,
  dayHeadline,
  isUkAerodrome,
  meanReadiness,
  withContributions,
  withDay,
  withReadinessStep,
  type CareerDay,
  type CareerEntry,
} from './career';

const entry = (type: string, overrides: Partial<CareerEntry> = {}): CareerEntry => ({
  kind: 'event',
  type,
  actor: 'world',
  payload: {},
  mission: null,
  ...overrides,
});
const order = (type: string, payload: CareerEntry['payload'] = {}): CareerEntry =>
  entry(type, { kind: 'command', actor: 'player', payload });
const day = (number: number, counters: CareerDay['counters'] = {}, hours = 8): CareerDay => ({
  number,
  startedTick: (number - 1) * 10 * 3600,
  endedTick: (number - 1) * 10 * 3600 + hours * 3600,
  counters,
  readiness: NO_READINESS,
});

describe('what moves the career record', () => {
  it('counts a mission that ended by how, by whose it was, and by what it answered', () => {
    const routine = { type: 'logistics', routine: true, destinationCode: 'EGTE' } as const;
    expect(contributions(entry('missionCompleted', { mission: routine }))).toEqual([
      ['missions.completed', 1],
      ['missions.completed.routine', 1],
      ['commitments.logistics', 1],
      ['commitments.uk', 1],
    ]);
    const urgent = { type: 'emergency_response', routine: false, destinationCode: 'LCRA' } as const;
    expect(contributions(entry('missionCompleted', { mission: urgent }))).toEqual([
      ['missions.completed', 1],
      ['missions.completed.commander', 1],
      ['commitments.emergency', 1],
      ['commitments.overseas', 1],
    ]);
    // Out and back to an area: no aerodrome it went to, so neither at home nor overseas.
    const training = { type: 'training', routine: true, destinationCode: null } as const;
    expect(contributions(entry('missionCompleted', { mission: training }))).toEqual([
      ['missions.completed', 1],
      ['missions.completed.routine', 1],
      ['commitments.training', 1],
    ]);
    // A failure is a failure, and meets no commitment.
    expect(contributions(entry('missionFailed', { mission: urgent }))).toEqual([
      ['missions.failed', 1],
      ['missions.failed.commander', 1],
    ]);
    // Without knowing the mission, it is still counted.
    expect(contributions(entry('missionCompleted'))).toEqual([['missions.completed', 1]]);
  });

  it("counts the commander's orders by kind, and nobody else's commands", () => {
    expect(contributions(order('acceptMission'))).toEqual([
      ['orders.total', 1],
      ['orders.missionsAccepted', 1],
    ]);
    expect(contributions(order('launchMission'))).toEqual([
      ['orders.total', 1],
      ['orders.launches', 1],
      ['missions.launched', 1],
    ]);
    expect(contributions(order('abortMission'))).toEqual([
      ['orders.total', 1],
      ['orders.aborts', 1],
      ['missions.aborted', 1],
    ]);
    expect(contributions(order('reviseFlight', { intent: 'divert' }))).toEqual([
      ['orders.total', 1],
      ['orders.diversions', 1],
    ]);
    expect(contributions(order('reviseFlight', { intent: 'return' }))).toContainEqual([
      'orders.returns',
      1,
    ]);
    // Drafting, taking command and ending a day are not orders.
    for (const type of ['createMission', 'updateMission', 'takeCommand', 'endCommandDay']) {
      expect(contributions(order(type)), type).toEqual([]);
    }
    // What the application does for itself is not the commander's.
    expect(contributions(entry('setOperatingArea', { kind: 'command', actor: 'system' }))).toEqual(
      [],
    );
    expect(contributions(entry('acceptMission', { kind: 'command', actor: 'system' }))).toEqual([]);
  });

  it('counts what the world did, with quantities where the log holds them', () => {
    expect(contributions(entry('flightCompleted', { payload: { durationS: 5400 } }))).toEqual([
      ['flights.completed', 1],
      ['flights.seconds', 5400],
    ]);
    expect(
      contributions(entry('eventStarted', { payload: { eventType: 'aerodrome_closure' } })),
    ).toEqual([
      ['events.total', 1],
      ['events.aerodrome_closure', 1],
    ]);
    expect(contributions(entry('missionLaunched'))).toEqual([['missions.launched', 1]]);
    expect(contributions(entry('routineTasked'))).toEqual([['routine.tasked', 1]]);
    expect(contributions(entry('maintenanceDue'))).toEqual([['aircraft.maintenanceDue', 1]]);
    expect(contributions(entry('flightFuelExhausted'))).toEqual([['aircraft.fuelExhausted', 1]]);
    // An entry the record does not read moves nothing.
    expect(contributions(entry('refuellingStarted'))).toEqual([]);
    expect(contributions(entry('objectiveCompleted'))).toEqual([]);
  });

  it('adds contributions without touching what it was given', () => {
    const before = { 'missions.completed': 2 };
    const after = withContributions(before, [
      ['missions.completed', 1],
      ['flights.seconds', 900],
      ['flights.held', 0],
    ]);
    expect(after).toEqual({ 'missions.completed': 3, 'flights.seconds': 900 });
    expect(before).toEqual({ 'missions.completed': 2 });
    expect(withContributions(before, [])).toBe(before);
    expect(counter(after, 'never.moved')).toBe(0);
  });

  it('knows a United Kingdom aerodrome by its public prefix', () => {
    expect(['EGHQ', 'egpk', 'EGLL'].every(isUkAerodrome)).toBe(true);
    expect(['LCRA', 'EIDW', 'KJFK', '', null, undefined].some(isUkAerodrome)).toBe(false);
  });
});

describe('totals and readiness', () => {
  it('sums days, counting an open day up to now', () => {
    const closed = day(1, { 'missions.completed': 4, 'orders.total': 2 }, 8);
    const open: CareerDay = {
      ...day(2, { 'missions.completed': 1, 'missions.failed': 1 }),
      endedTick: null,
    };
    const totals = careerTotals([closed, open], open.startedTick + 1800);
    expect(totals).toMatchObject({
      days: 2,
      commandSeconds: 8 * 3600 + 1800,
      counters: { 'missions.completed': 5, 'missions.failed': 1, 'orders.total': 2 },
    });
    expect(withDay(NO_TOTALS, closed, 0)).toEqual(careerTotals([closed], 0));
    expect(careerTotals([], 99)).toEqual(NO_TOTALS);
  });

  it('measures readiness step by step, and keeps its lowest and highest', () => {
    let readiness = NO_READINESS;
    for (const ready of [10, 10, 7, 4, 9]) readiness = withReadinessStep(readiness, ready, 10);
    expect(readiness).toEqual({ aircraftSeconds: 50, readySeconds: 40, low: 0.4, high: 1 });
    expect(meanReadiness(readiness)).toBe(0.8);
    // A world with no aircraft records nothing, and has no mean.
    expect(withReadinessStep(NO_READINESS, 0, 0)).toBe(NO_READINESS);
    expect(meanReadiness(NO_READINESS)).toBeNull();
    // Across days the lowest is the lowest of any, and the mean is weighted by time.
    const totals = careerTotals(
      [
        { ...day(1), readiness: { aircraftSeconds: 100, readySeconds: 90, low: 0.7, high: 1 } },
        { ...day(2), readiness: { aircraftSeconds: 300, readySeconds: 150, low: 0.2, high: 0.8 } },
      ],
      0,
    );
    expect(totals.readiness).toEqual({
      aircraftSeconds: 400,
      readySeconds: 240,
      low: 0.2,
      high: 1,
    });
    expect(meanReadiness(totals.readiness)).toBe(0.6);
  });
});

describe('what a day was, in a line', () => {
  it('says only what the day’s counters say, worst first', () => {
    expect(dayHeadline(day(3, { 'aircraft.fuelExhausted': 1, 'missions.completed': 9 }))).toMatch(
      /ran out of fuel/,
    );
    expect(dayHeadline(day(3, { 'events.severe_weather': 1, 'orders.diversions': 2 }))).toBe(
      'Severe weather. Several diversions ordered.',
    );
    expect(dayHeadline(day(3, { 'events.aerodrome_closure': 1, 'flights.held': 1 }))).toBe(
      'Aerodrome closure. Flights held or diverted.',
    );
    expect(dayHeadline(day(3, { 'commitments.emergency': 1 }))).toBe('Emergency requirement met.');
    expect(dayHeadline(day(3, { 'aircraft.maintenanceDue': 3 }))).toMatch(/availability/);
    expect(dayHeadline(day(3, { 'missions.completed': 6, 'missions.failed': 1 }))).toBe(
      '6 missions completed, 1 failed.',
    );
    expect(dayHeadline(day(3, { 'missions.completed': 1 }))).toBe('1 mission completed.');
    expect(dayHeadline(day(1, { 'missions.completed': 12 }))).toBe(
      'Took command during stable operations. 12 missions completed.',
    );
    expect(dayHeadline(day(1))).toBe('Took command. Nothing yet completed.');
    expect(dayHeadline(day(4))).toBe('A quiet day.');
  });
});

describe('routine tasking', () => {
  const model = (rangeKm: number, category: string): PerformanceModel =>
    ({
      referenceRangeKm: rangeKm,
      cruiseSpeedKmh: 700,
      maxPayloadKg: 20_000,
      category,
    }) as unknown as PerformanceModel;
  const point = (code: string, lat: number, lon: number): RoutePoint => ({
    kind: 'aerodrome',
    refId: `fixture:${code}`,
    name: code,
    code,
    lat,
    lon,
    elevationM: 10,
  });
  const NEWQUAY = point('EGHQ', 50.44, -4.995);
  const EXETER = point('EGTE', 50.734, -3.414);
  const PRESTWICK = point('EGPK', 55.509, -4.587);
  const aircraft = (
    id: string,
    category: string,
    overrides: Partial<RoutineAircraft> = {},
  ): RoutineAircraft => ({
    id,
    category,
    performance: model(4000, category),
    location: NEWQUAY,
    home: NEWQUAY,
    free: true,
    ...overrides,
  });
  const rng = (seed = 'routine') => new RngStreams(seed).stream('missions.routine');
  const places = [NEWQUAY, EXETER, PRESTWICK];

  it('keeps a third of each category back, and at least one of two', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(routineReserve)).toEqual([0, 0, 1, 1, 2, 2, 2, 3]);
  });

  it('may task an aircraft only while more of its kind are free than the reserve asks', () => {
    const three = [
      aircraft('T1', 'transport'),
      aircraft('T2', 'transport'),
      aircraft('T3', 'transport'),
    ];
    expect(routineCandidates(three).map((each) => each.id)).toEqual(['T1', 'T2', 'T3']);
    // One away on a task: two free, one of them the reserve, so one more may still go.
    const busy = [{ ...three[0], free: false }, three[1], three[2]] as RoutineAircraft[];
    expect(routineCandidates(busy).map((each) => each.id)).toEqual(['T2', 'T3']);
    // Two away: the last is the reserve, and stays.
    const stretched = [
      { ...three[0], free: false },
      { ...three[1], free: false },
      three[2],
    ] as RoutineAircraft[];
    expect(routineCandidates(stretched)).toEqual([]);
    // The only aircraft of its kind has no reserve to be.
    expect(routineCandidates([aircraft('P1', 'maritime_patrol')])).toHaveLength(1);
    // One that cannot fly, or is in the air, is never a candidate.
    expect(
      routineCandidates([
        aircraft('X1', 'isr', { performance: null }),
        aircraft('X2', 'tanker', { location: null }),
      ]),
    ).toEqual([]);
  });

  it('is deterministic: the same generator state and fleet give the same task', () => {
    const fleet = [
      aircraft('T1', 'transport'),
      aircraft('T2', 'transport'),
      aircraft('F1', 'fast_jet'),
    ];
    const run = (seed: string) => {
      const stream = rng(seed);
      return Array.from({ length: 40 }, (_, index) =>
        generateRoutineTask({ rng: stream, places, aircraft: fleet, ordinal: index + 1 }),
      );
    };
    expect(run('a')).toEqual(run('a'));
    expect(run('a')).not.toEqual(run('b'));
    const tasks = run('a').filter((task) => task !== null);
    // The dice say no often enough that the world is not always tasking.
    expect(tasks.length).toBeGreaterThan(5);
    expect(tasks.length).toBeLessThan(30);
    expect(tasks.length / 40).toBeCloseTo(ROUTINE.chancePerInterval, 0);
  });

  it('asks only for what the aircraft suits, somewhere it can reach', () => {
    const fleet = [
      aircraft('T1', 'transport'),
      aircraft('T2', 'transport'),
      aircraft('F1', 'fast_jet'),
    ];
    const stream = rng('suits');
    for (let index = 0; index < 200; index++) {
      const task = generateRoutineTask({ rng: stream, places, aircraft: fleet, ordinal: index });
      if (!task) continue;
      const flown = fleet.find((each) => each.id === task.aircraftId) as RoutineAircraft;
      const template = MISSION_TEMPLATES[task.type];
      expect(template.suitableCategories).toContain(flown.category);
      expect(['training', 'patrol', 'logistics', 'transport']).toContain(task.type);
      expect(task.description).toMatch(/^Routine tasking, flown by the simulated world\./);
      if (task.brief.destination) {
        const distanceM = greatCircleDistance(NEWQUAY, task.brief.destination);
        expect(distanceM).toBeGreaterThanOrEqual(GENERATION.minDistanceM);
        expect(distanceM).toBeLessThanOrEqual(4000 * 1000 * GENERATION.oneWayRangeShare);
        expect(task.brief.payloadKg).toBeGreaterThan(0);
      } else {
        expect(task.brief.target).not.toBeNull();
        expect(task.brief.payloadKg).toBe(0);
      }
    }
  });

  it('brings an aircraft away from its base home, carrying freight if it is a type that does', () => {
    const away = [
      aircraft('T1', 'transport', { location: EXETER }),
      aircraft('T2', 'transport'),
      aircraft('T3', 'transport', { free: false }),
    ];
    const stream = rng('home');
    const seen = new Set<string>();
    for (let index = 0; index < 120; index++) {
      const task = generateRoutineTask({ rng: stream, places, aircraft: away, ordinal: index });
      if (task?.aircraftId !== 'T1') continue;
      seen.add(task.type);
      expect(task.title).toBe('Return to base: EGHQ (EGHQ)');
      expect(task.brief).toMatchObject({ shape: 'point_to_point', destination: NEWQUAY });
      expect(task.brief.payloadKg).toBeGreaterThan(0);
    }
    expect([...seen]).toEqual(['logistics']);
    // A type that carries nothing is simply flown home.
    const jet = [aircraft('F1', 'fast_jet', { location: PRESTWICK })];
    const jetStream = rng('jet');
    let ferry = null;
    for (let index = 0; index < 40 && !ferry; index++) {
      ferry = generateRoutineTask({ rng: jetStream, places, aircraft: jet, ordinal: index });
    }
    expect(ferry).toMatchObject({ type: 'ferry', brief: { destination: NEWQUAY, payloadKg: 0 } });
  });
});

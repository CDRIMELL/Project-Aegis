import { describe, expect, it } from 'vitest';
import {
  NO_FILTER,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  availability,
  buildReport,
  dayStartTick,
  exportFileName,
  filterFlights,
  filterMissions,
  inPeriod,
  maintenanceOutlook,
  maintenanceVisits,
  periodBetween,
  periodBuckets,
  presetPeriod,
  previousPeriod,
  reportTable,
  statusChanges,
  statusTime,
  tickToIso,
  toCsv,
  toJson,
  utilisation,
  type AircraftRecord,
  type EventRecord,
  type FlightRecord,
  type LogRecord,
  type MissionRecord,
  type ReportData,
  type ReportPeriod,
} from './index';

/** The world begins at noon, so the first simulated midnight is tick 43,200. */
const EPOCH = Date.UTC(2026, 9, 4, 12);
const MIDNIGHT = 12 * TICKS_PER_HOUR;
const THRESHOLDS = { dueAfterFlightSeconds: 50 * 3600, dueBelowConditionPct: 60 };

const aircraft = (id: string, overrides: Partial<AircraftRecord> = {}): AircraftRecord => ({
  id,
  typeName: 'Airbus A400M Atlas',
  category: 'transport',
  status: 'available',
  conditionPct: 95,
  flightSecondsTotal: 3700,
  flightSecondsSinceMaintenance: 0,
  acquiredTick: 0,
  home: 'EGHQ',
  ...overrides,
});

const flight = (
  id: string,
  aircraftId: string,
  departedTick: number,
  arrivedTick: number,
  overrides: Partial<FlightRecord> = {},
): FlightRecord => ({
  id,
  aircraftId,
  missionId: null,
  status: 'completed',
  origin: 'EGHQ',
  destination: 'EGHQ',
  plannedDestination: 'EGHQ',
  revisions: [],
  heldS: 0,
  landedDuringClosure: false,
  caution: false,
  departedTick,
  arrivedTick,
  durationS: arrivedTick - departedTick,
  distanceM: (arrivedTick - departedTick) * 200,
  fuelUsedKg: (arrivedTick - departedTick) * 1.5,
  estimatedDurationS: arrivedTick - departedTick,
  estimatedFuelUsedKg: (arrivedTick - departedTick) * 1.5,
  stillAirDurationS: arrivedTick - departedTick - 60,
  stillAirFuelUsedKg: (arrivedTick - departedTick) * 1.5 - 100,
  worstSeverity: 0.3,
  ...overrides,
});

const mission = (
  id: string,
  status: MissionRecord['status'],
  completedTick: number,
  overrides: Partial<MissionRecord> = {},
): MissionRecord => ({
  id,
  type: 'training',
  source: 'manual',
  status,
  priority: 'routine',
  title: `Mission ${id}`,
  aircraftId: 'A',
  flightId: null,
  createdTick: 0,
  acceptedTick: null,
  plannedStartTick: null,
  actualStartTick: null,
  completedTick,
  completeByTick: null,
  acceptanceRisk: null,
  launchRisk: null,
  objectives: 4,
  objectivesComplete: 0,
  objectivesFailed: 0,
  requiredObjectives: 2,
  requiredComplete: 0,
  summary: null,
  ...overrides,
});

const event = (
  id: string,
  type: EventRecord['type'],
  startTick: number,
  endTick: number,
  overrides: Partial<EventRecord> = {},
): EventRecord => ({
  id,
  type,
  status: 'resolved',
  source: 'generated',
  severity: 0.5,
  title: `Event ${id}`,
  where: 'Exeter (EGTE)',
  createdTick: startTick,
  startTick,
  endTick,
  aircraftId: null,
  raisedMissionId: null,
  affectedMissionIds: [],
  ...overrides,
});

let seq = 0;
const entry = (
  tick: number,
  kind: LogRecord['kind'],
  type: string,
  aircraftId: string | null,
  payload: LogRecord['payload'] = {},
): LogRecord => ({ seq: ++seq, tick, kind, type, aircraftId, missionId: null, payload });

/*
 * A flies an hour on the first day, and a short flight that lands exactly at midnight, after which
 * it is due maintenance, is maintained, and is available again. B runs out of fuel, is recovered
 * by maintenance, and is available again. C is bought later and has an inspection finding.
 */
const LOG: LogRecord[] = [
  entry(100, 'command', 'launchMission', 'A'),
  entry(3700, 'event', 'flightCompleted', 'A'),
  entry(5000, 'command', 'launchFlight', 'B'),
  entry(9000, 'event', 'flightFuelExhausted', 'B'),
  entry(10_000, 'command', 'startMaintenance', 'B'),
  entry(31_600, 'event', 'maintenanceCompleted', 'B'),
  entry(43_100, 'command', 'launchMission', 'A'),
  entry(MIDNIGHT, 'event', 'flightCompleted', 'A'),
  entry(MIDNIGHT, 'event', 'maintenanceDue', 'A'),
  entry(50_000, 'command', 'startMaintenance', 'A'),
  entry(71_600, 'event', 'maintenanceCompleted', 'A'),
  entry(120_000, 'event', 'eventStarted', 'C', { eventType: 'maintenance_finding' }),
  // Entries the timeline must ignore.
  entry(121_000, 'event', 'eventStarted', null, { eventType: 'aerodrome_closure' }),
  entry(121_500, 'event', 'eventStarted', 'A', { eventType: 'navigation_disruption' }),
];

const DATA: ReportData = {
  asOfTick: 130_000,
  epochMs: EPOCH,
  modelVersion: 5,
  logCompleteFromTick: 0,
  aircraft: [
    aircraft('A'),
    aircraft('B', { typeName: 'Eurofighter Typhoon', category: 'fast_jet' }),
    aircraft('C', { acquiredTick: 100_000, status: 'maintenance_due' }),
  ],
  flights: [
    flight('FLT-000001', 'A', 100, 3700, { missionId: 'MSN-000001' }),
    flight('FLT-000002', 'B', 5000, 9000, { missionId: 'MSN-000002', status: 'fuel_exhausted' }),
    flight('FLT-000003', 'A', 43_100, MIDNIGHT, {
      missionId: 'MSN-000003',
      stillAirDurationS: null,
      stillAirFuelUsedKg: null,
    }),
  ],
  inProgressFlights: [],
  inProgressMissions: [],
  missions: [
    mission('MSN-000001', 'completed', 3700, {
      flightId: 'FLT-000001',
      acceptanceRisk: 12,
      launchRisk: 18,
      actualStartTick: 100,
      plannedStartTick: 0,
      objectivesComplete: 4,
      requiredComplete: 2,
    }),
    mission('MSN-000002', 'failed', 9000, {
      type: 'logistics',
      aircraftId: 'B',
      flightId: 'FLT-000002',
      launchRisk: 40,
      actualStartTick: 5000,
      objectivesFailed: 2,
    }),
    mission('MSN-000003', 'completed', MIDNIGHT, {
      flightId: 'FLT-000003',
      actualStartTick: 43_100,
    }),
    mission('MSN-000004', 'cancelled', 20_000),
    mission('MSN-000005', 'expired', 30_000, { source: 'generated', aircraftId: null }),
  ],
  events: [
    event('EVT-000001', 'aerodrome_closure', 10_000, 20_000, {
      affectedMissionIds: ['MSN-000004'],
    }),
    event('EVT-000002', 'navigation_disruption', 40_000, 50_000, { severity: 0.9 }),
    event('EVT-000003', 'maintenance_finding', 120_000, 120_000, {
      status: 'active',
      aircraftId: 'C',
      where: null,
    }),
  ],
  statusLog: LOG,
};

const DAY_ONE: ReportPeriod = { fromTick: 0, toTick: MIDNIGHT };
const DAY_TWO: ReportPeriod = { fromTick: MIDNIGHT, toTick: MIDNIGHT + TICKS_PER_DAY };
const BOTH: ReportPeriod = { fromTick: 0, toTick: MIDNIGHT + TICKS_PER_DAY };
const report = (period: ReportPeriod, data = DATA) => buildReport(data, period, THRESHOLDS);

describe('reporting periods', () => {
  it('measures the named periods back from the moment of the report, in simulation time', () => {
    expect(presetPeriod('last24h', 200_000, EPOCH)).toEqual({
      fromTick: 200_001 - TICKS_PER_DAY,
      toTick: 200_001,
    });
    expect(presetPeriod('last7d', 700_000, EPOCH).fromTick).toBe(700_001 - 7 * TICKS_PER_DAY);
    expect(presetPeriod('last30d', 3_000_000, EPOCH).fromTick).toBe(3_000_001 - 30 * TICKS_PER_DAY);
    // A young world: the period starts when the world did.
    expect(presetPeriod('last30d', 500, EPOCH)).toEqual({ fromTick: 0, toTick: 501 });
  });

  it('takes "today" as the simulated UTC day, wherever in it the world began', () => {
    expect(dayStartTick(50_000, EPOCH)).toBe(MIDNIGHT);
    expect(dayStartTick(MIDNIGHT, EPOCH)).toBe(MIDNIGHT);
    expect(dayStartTick(MIDNIGHT - 1, EPOCH)).toBe(0);
    expect(presetPeriod('today', 50_000, EPOCH)).toEqual({ fromTick: MIDNIGHT, toTick: 50_001 });
    expect(tickToIso(dayStartTick(200_000, EPOCH), EPOCH)).toBe('2026-10-06T00:00:00Z');
  });

  it('includes its first tick and the moment of the report, and excludes its end', () => {
    const period = presetPeriod('last24h', 100_000, EPOCH);
    expect(inPeriod(period.fromTick, period)).toBe(true);
    expect(inPeriod(period.fromTick - 1, period)).toBe(false);
    expect(inPeriod(100_000, period)).toBe(true);
    expect(inPeriod(period.toTick, period)).toBe(false);
    expect(inPeriod(null, period)).toBe(false);
  });

  it('finds the period before, and none where the world is not that old', () => {
    expect(previousPeriod({ fromTick: 100_000, toTick: 150_000 })).toEqual({
      fromTick: 50_000,
      toTick: 100_000,
    });
    expect(previousPeriod({ fromTick: 20_000, toTick: 70_000 })).toEqual({
      fromTick: 0,
      toTick: 20_000,
    });
    expect(previousPeriod({ fromTick: 0, toTick: 500 })).toBeNull();
  });

  it('makes a custom period from two simulation instants, or none', () => {
    const day = Date.UTC(2026, 9, 5);
    expect(periodBetween(day, day + 86_400_000, EPOCH)).toEqual(DAY_TWO);
    // Before the world began: clipped to its start.
    expect(periodBetween(EPOCH - 3_600_000, day, EPOCH)).toEqual(DAY_ONE);
    expect(periodBetween(day, day, EPOCH)).toBeNull();
    expect(periodBetween(day, day - 1000, EPOCH)).toBeNull();
    expect(periodBetween(Number.NaN, day, EPOCH)).toBeNull();
  });

  it('divides a period into hours or simulated days that cover it exactly', () => {
    const hourly = periodBuckets({ fromTick: 1000, toTick: 9000 }, EPOCH);
    expect(hourly.map((b) => [b.fromTick, b.toTick])).toEqual([
      [1000, 3600],
      [3600, 7200],
      [7200, 9000],
    ]);
    const daily = periodBuckets({ fromTick: 0, toTick: 5 * TICKS_PER_DAY }, EPOCH);
    // The world began at noon: the first and last days are half days.
    expect(daily).toHaveLength(6);
    expect(daily[0]).toEqual({ fromTick: 0, toTick: MIDNIGHT });
    expect(daily[1]).toEqual({ fromTick: MIDNIGHT, toTick: MIDNIGHT + TICKS_PER_DAY });
    for (const buckets of [hourly, daily]) {
      for (let i = 1; i < buckets.length; i++) {
        expect(buckets[i]?.fromTick).toBe(buckets[i - 1]?.toTick);
      }
    }
    expect(periodBuckets({ fromTick: 0, toTick: 400 * TICKS_PER_DAY }, EPOCH).length).toBeLessThan(
      64,
    );
    expect(periodBuckets({ fromTick: 500, toTick: 500 }, EPOCH)).toEqual([]);
  });
});

describe('aircraft status from the log', () => {
  const changes = statusChanges(LOG);
  const of = (id: string) => changes.filter((change) => change.aircraftId === id);
  const [a, b, c] = DATA.aircraft as [AircraftRecord, AircraftRecord, AircraftRecord];

  it('reads the transitions and nothing else', () => {
    expect(of('A').map((change) => [change.tick, change.status])).toEqual([
      [100, 'in_flight'],
      [3700, 'available'],
      [43_100, 'in_flight'],
      [MIDNIGHT, 'available'],
      [MIDNIGHT, 'maintenance_due'],
      [50_000, 'in_maintenance'],
      [71_600, 'available'],
    ]);
    expect(of('C')).toEqual([
      { tick: 120_000, aircraftId: 'C', status: 'maintenance_due', before: 'available' },
    ]);
  });

  it('accounts for every second of a period, by status', () => {
    const time = statusTime(a, of('A'), 0, 0, TICKS_PER_DAY);
    expect(time.byStatus).toEqual({
      available: 100 + 39_400 + 14_800,
      in_flight: 3600 + 100,
      maintenance_due: 6800,
      in_maintenance: 21_600,
      unserviceable: 0,
    });
    expect(time.recordedS).toBe(TICKS_PER_DAY);
    expect(time.notRecordedS).toBe(0);
    expect(availability(time)).toBeCloseTo((TICKS_PER_DAY - 6800 - 21_600) / TICKS_PER_DAY, 12);
    expect(utilisation(time)).toBeCloseTo(3700 / TICKS_PER_DAY, 12);
  });

  it('counts a forced landing as unserviceable until the aircraft is maintained', () => {
    const time = statusTime(b, of('B'), 0, 0, 40_000);
    expect(time.byStatus).toMatchObject({
      available: 5000 + 8400,
      in_flight: 4000,
      unserviceable: 1000,
      in_maintenance: 21_600,
    });
  });

  it('adds up over adjacent windows', () => {
    const whole = statusTime(a, of('A'), 0, 0, 100_000).byStatus;
    const first = statusTime(a, of('A'), 0, 0, 45_000).byStatus;
    const second = statusTime(a, of('A'), 0, 45_000, 100_000).byStatus;
    for (const status of Object.keys(whole) as (keyof typeof whole)[]) {
      expect(first[status] + second[status]).toBe(whole[status]);
    }
  });

  it('starts when the aircraft was acquired', () => {
    const time = statusTime(c, of('C'), 0, 90_000, 130_000);
    expect(time.byStatus).toMatchObject({ available: 20_000, maintenance_due: 10_000 });
    expect(time.recordedS).toBe(30_000);
    expect(statusTime(c, of('C'), 0, 0, 100_000)).toMatchObject({ recordedS: 0, notRecordedS: 0 });
    expect(availability(statusTime(c, of('C'), 0, 0, 100_000))).toBeNull();
  });

  it('reports time before the log began as not recorded, and deduces only what a transition settles', () => {
    // The log is complete from tick 20,000. A's next transition is a launch, so it was available.
    const time = statusTime(a, of('A'), 20_000, 0, TICKS_PER_DAY);
    expect(time.notRecordedS).toBe(20_000);
    expect(time.byStatus.available).toBe(23_100 + 14_800);
    expect(time.byStatus.in_flight).toBe(100);

    // B's first transition after tick 9,500 is the start of maintenance, which could follow more
    // than one status: the time before it stays unrecorded.
    const unsettled = statusTime(b, of('B'), 9500, 9000, 40_000);
    expect(unsettled.notRecordedS).toBe(500 + 500);
    expect(unsettled.byStatus.unserviceable).toBe(0);
    expect(unsettled.byStatus.in_maintenance).toBe(21_600);
  });

  it('takes an aircraft with no transitions to have been as it is now', () => {
    const idle = aircraft('D', { status: 'in_maintenance' });
    const time = statusTime(idle, [], 0, 1000, 5000);
    expect(time.byStatus.in_maintenance).toBe(4000);
    expect(availability(time)).toBe(0);
  });

  it('pairs each maintenance start with its completion', () => {
    expect(maintenanceVisits(LOG)).toEqual([
      { aircraftId: 'B', startedTick: 10_000, completedTick: 31_600 },
      { aircraftId: 'A', startedTick: 50_000, completedTick: 71_600 },
    ]);
    const open = [...LOG, entry(125_000, 'command', 'startMaintenance', 'C')];
    expect(maintenanceVisits(open).at(-1)).toEqual({
      aircraftId: 'C',
      startedTick: 125_000,
      completedTick: null,
    });
  });
});

describe('a report for a period', () => {
  it('totals what finished in the period, from the recorded values', () => {
    const { totals } = report(DAY_ONE);
    expect(totals).toMatchObject({
      flights: 2,
      flightSeconds: 3600 + 4000,
      distanceM: 7600 * 200,
      fuelUsedKg: 7600 * 1.5,
      estimatedFuelUsedKg: 7600 * 1.5,
      weatherFuelKg: 200,
      weatherDelayS: 120,
      missionsCompleted: 1,
      missionsFailed: 1,
      missionsCancelled: 1,
      offersLapsed: 1,
      maintenanceVisits: 1,
      maintenanceSeconds: 21_600,
      eventsStarted: 2,
    });
  });

  it('puts what finishes exactly on a boundary in the later period, once', () => {
    const one = report(DAY_ONE);
    const two = report(DAY_TWO);
    expect(one.flights.map((f) => f.id)).toEqual(['FLT-000001', 'FLT-000002']);
    expect(two.flights.map((f) => f.id)).toEqual(['FLT-000003']);
    expect(one.missions.map((m) => m.id)).not.toContain('MSN-000003');
    expect(two.missions.map((m) => m.id)).toEqual(['MSN-000003']);
    // A flight with no still-air record contributes no weather figure, and there is no other.
    expect(two.totals.weatherFuelKg).toBeNull();
  });

  it('adds up across adjacent periods', () => {
    const [one, two, both] = [report(DAY_ONE), report(DAY_TWO), report(BOTH)];
    for (const key of [
      'flights',
      'flightSeconds',
      'distanceM',
      'fuelUsedKg',
      'missionsCompleted',
      'missionsFailed',
      'missionsCancelled',
      'offersLapsed',
      'maintenanceVisits',
      'eventsStarted',
    ] as const) {
      expect(one.totals[key] + two.totals[key]).toBe(both.totals[key]);
    }
    expect(one.fleet.recordedS + two.fleet.recordedS).toBe(both.fleet.recordedS);
  });

  it('reports each aircraft: activity, missions, maintenance, availability and utilisation', () => {
    const rows = report(BOTH).aircraft;
    expect(rows.map((row) => row.aircraft.id)).toEqual(['A', 'B', 'C']);
    expect(rows[0]).toMatchObject({
      flights: 2,
      flightSeconds: 3700,
      meanFlightSeconds: 1850,
      missionsCompleted: 2,
      missionsFailed: 0,
      maintenanceVisits: 1,
    });
    expect(rows[1]).toMatchObject({ flights: 1, missionsFailed: 1, maintenanceVisits: 1 });
    expect(rows[2]).toMatchObject({ flights: 0, meanFlightSeconds: null, utilisation: 0 });
    expect(rows[0]?.utilisation).toBeCloseTo(3700 / BOTH.toTick, 12);
    // C has only been owned for part of the period: its rates are over that part.
    expect(rows[2]?.time.recordedS).toBe(BOTH.toTick - 100_000);
    expect(rows[2]?.availability).toBeCloseTo(20_000 / (BOTH.toTick - 100_000), 12);
  });

  it('pools the fleet by time owned, and never counts time after the report', () => {
    const { fleet, aircraft: rows } = report({ fromTick: 0, toTick: 10_000_000 });
    const until = DATA.asOfTick + 1;
    expect(fleet.recordedS).toBe(until * 2 + (until - 100_000));
    const down = 6800 + 21_600 + 1000 + 21_600 + (until - 120_000);
    expect(fleet.availability).toBeCloseTo((fleet.recordedS - down) / fleet.recordedS, 12);
    expect(fleet.utilisation).toBeCloseTo((3700 + 4000) / fleet.recordedS, 12);
    expect(fleet.aircraftFlown).toBe(2);
    expect(rows.every((row) => row.time.notRecordedS === 0)).toBe(true);
  });

  it('gives an empty report for an empty period, with rates absent and not zero', () => {
    const later = report({ fromTick: 200_000, toTick: 300_000 });
    expect(later.totals).toMatchObject({ flights: 0, fuelUsedKg: 0, missionsCompleted: 0 });
    expect(later.totals.weatherFuelKg).toBeNull();
    expect(later.fleet).toMatchObject({ availability: null, utilisation: null, recordedS: 0 });
    expect(later.series).toEqual([]);
    expect(later.flights).toEqual([]);
    expect(later.missionTypes).toEqual([]);

    // A quiet stretch inside the world's life: nothing finished, but the fleet was there.
    const quiet = report({ fromTick: 80_000, toTick: 90_000 });
    expect(quiet.totals.flights).toBe(0);
    expect(quiet.fleet.availability).toBe(1);
    expect(quiet.fleet.utilisation).toBe(0);
  });

  it('counts missions by type and outcome, with the fuel their flights used', () => {
    expect(report(BOTH).missionTypes).toEqual([
      {
        type: 'logistics',
        completed: 0,
        failed: 1,
        cancelled: 0,
        aborted: 0,
        lapsed: 0,
        fuelUsedKg: 6000,
        flightSeconds: 4000,
      },
      {
        type: 'training',
        completed: 2,
        failed: 0,
        cancelled: 1,
        aborted: 0,
        lapsed: 1,
        fuelUsedKg: 3700 * 1.5,
        flightSeconds: 3700,
      },
    ]);
  });

  it('includes an event in every period it was open in, and measures only its time in the period', () => {
    expect(report(DAY_ONE).events.map((e) => e.id)).toEqual(['EVT-000001', 'EVT-000002']);
    // The disruption ran from 40,000 to 50,000: 3,200 s of it on the first day.
    const nav = (period: ReportPeriod) =>
      report(period).eventTypes.find((t) => t.type === 'navigation_disruption');
    expect(nav(DAY_ONE)?.activeSeconds).toBe(3200);
    expect(nav(DAY_TWO)?.activeSeconds).toBe(6800);
    expect(nav(DAY_ONE)?.meanSeverity).toBe(0.9);
    // It started on the first day, so it is counted as starting there only.
    expect(report(DAY_TWO).totals.eventsStarted).toBe(1);

    const closure = report(DAY_ONE).eventTypes.find((t) => t.type === 'aerodrome_closure');
    expect(closure).toMatchObject({ events: 1, activeSeconds: 10_000, missionsAffected: 1 });
    expect(report({ fromTick: 20_000, toTick: 30_000 }).events).toEqual([]);
  });

  it('keeps an open finding open until the report, however its end tick reads', () => {
    const finding = report(BOTH).eventTypes.find((t) => t.type === 'maintenance_finding');
    expect(finding).toMatchObject({ events: 1, activeSeconds: 129_600 - 120_000 });
    const cancelled = {
      ...DATA,
      events: DATA.events.map((e) => ({ ...e, status: 'cancelled' as const })),
    };
    expect(report(BOTH, cancelled).events).toEqual([]);
  });

  it('leaves out an event that is announced but has not started, however far the period runs', () => {
    const announced: ReportData = {
      ...DATA,
      events: [
        ...DATA.events,
        event('EVT-000004', 'aerodrome_closure', 140_000, 150_000, {
          status: 'scheduled',
          createdTick: 129_000,
        }),
      ],
    };
    const open = report({ fromTick: 0, toTick: 10_000_000 }, announced);
    expect(open.events.map((e) => e.id)).not.toContain('EVT-000004');
    expect(open.totals.eventsStarted).toBe(3);
    expect(open.eventTypes.every((type) => type.activeSeconds > 0)).toBe(true);
    // Once the world reaches its start, it is there.
    const later = report({ fromTick: 0, toTick: 10_000_000 }, { ...announced, asOfTick: 141_000 });
    expect(later.events.map((e) => e.id)).toContain('EVT-000004');
    expect(later.totals.eventsStarted).toBe(4);
  });

  it('builds a series whose buckets add up to the totals', () => {
    const { series, totals } = report(BOTH);
    expect(series.length).toBe(36);
    const add = (key: 'flights' | 'fuelUsedKg' | 'flightSeconds' | 'missionsCompleted') =>
      series.reduce((sum, point) => sum + point[key], 0);
    expect(add('flights')).toBe(totals.flights);
    expect(add('fuelUsedKg')).toBe(totals.fuelUsedKg);
    expect(add('flightSeconds')).toBe(totals.flightSeconds);
    expect(add('missionsCompleted')).toBe(totals.missionsCompleted);
    // The first hour: both aircraft available or flying throughout.
    expect(series[0]).toMatchObject({ fromTick: 0, toTick: 3600, availability: 1 });
    // Hour 3 (10,800 to 14,400): B is in maintenance, A is not.
    expect(series[3]?.availability).toBe(0.5);
  });

  it('groups aircraft by how near maintenance is, most pressing first', () => {
    const fleet = [
      aircraft('H'),
      aircraft('N', { flightSecondsSinceMaintenance: 41 * 3600 }),
      aircraft('W', { conditionPct: 66 }),
      aircraft('D', { status: 'maintenance_due', conditionPct: 55 }),
      aircraft('M', { status: 'in_maintenance' }),
      aircraft('U', { status: 'unserviceable', conditionPct: 0 }),
    ];
    const outlook = maintenanceOutlook(fleet, THRESHOLDS);
    expect(outlook.map((row) => [row.aircraft.id, row.group])).toEqual([
      ['M', 'unavailable'],
      ['U', 'unavailable'],
      ['D', 'due'],
      ['N', 'approaching'],
      ['W', 'approaching'],
      ['H', 'healthy'],
    ]);
    expect(outlook.find((row) => row.aircraft.id === 'N')).toMatchObject({
      secondsRemaining: 9 * 3600,
      reason: 'Has flown 82 % of the hours allowed between maintenance.',
    });
    expect(outlook.find((row) => row.aircraft.id === 'D')?.conditionMarginPct).toBe(0);
  });
});

describe('what was done in flight', () => {
  /** A is diverted and holds; B's mission is aborted and it turns back; C is still in the air. */
  const operated: ReportData = {
    ...DATA,
    flights: [
      flight('FLT-000001', 'A', 100, 3700, {
        missionId: 'MSN-000001',
        destination: 'LIRF',
        plannedDestination: 'LCRA',
        revisions: ['reroute', 'divert'],
        heldS: 900,
        stillAirDurationS: null,
        stillAirFuelUsedKg: null,
      }),
      flight('FLT-000002', 'B', 5000, 9000, {
        missionId: 'MSN-000002',
        destination: 'EGHQ',
        plannedDestination: 'LCRA',
        revisions: ['return'],
        landedDuringClosure: true,
        caution: true,
      }),
    ],
    missions: [
      mission('MSN-000001', 'failed', 3700, { flightId: 'FLT-000001' }),
      mission('MSN-000002', 'aborted', 7000, { aircraftId: 'B', flightId: 'FLT-000002' }),
    ],
    inProgressFlights: [
      {
        id: 'FLT-000009',
        aircraftId: 'C',
        missionId: 'MSN-000009',
        origin: 'EGHQ',
        destination: 'LCRA',
        plannedDestination: 'LCRA',
        departedTick: 128_000,
        elapsedS: 2000,
        distanceM: 400_000,
        fuelUsedKg: 3000,
        holding: 'closure',
        revisions: [],
      },
    ],
    inProgressMissions: [
      {
        id: 'MSN-000009',
        type: 'logistics',
        title: 'Delivery',
        aircraftId: 'C',
        flightId: 'FLT-000009',
        launchedTick: 128_000,
      },
    ],
  };

  it('counts aborted missions, diversions, changes of route and time held', () => {
    const { totals, missionTypes } = report(BOTH, operated);
    expect(totals).toMatchObject({
      missionsCompleted: 0,
      missionsFailed: 1,
      missionsAborted: 1,
      missionsCancelled: 0,
      flightsDiverted: 2,
      routeRevisions: 3,
      heldSeconds: 900,
      // Neither flight was flown as launched, so neither is compared with its launch estimate.
      flightsAsLaunched: 0,
      fuelUsedAsLaunchedKg: 0,
      estimatedFuelUsedKg: 0,
    });
    expect(report(BOTH).totals).toMatchObject({
      flightsAsLaunched: 3,
      fuelUsedAsLaunchedKg: report(BOTH).totals.fuelUsedKg,
    });
    expect(missionTypes).toEqual([
      expect.objectContaining({ type: 'training', failed: 1, aborted: 1, completed: 0 }),
    ]);
    // Neither flight has a plan flown in still air to be compared with.
    expect(totals.weatherFuelKg).toBe(100);
  });

  it('reports where a flight was launched to beside where it landed, and never overwrites one with the other', () => {
    const fuel = reportTable('fuel', report(BOTH, operated)).rows;
    expect(fuel[0]).toMatchObject({
      flight: 'FLT-000001',
      to: 'LIRF',
      planned_to: 'LCRA',
      revisions: 'reroute divert',
      held_h: 0.25,
      landed_during_closure: 'no',
      caution: 'no',
    });
    expect(fuel[1]).toMatchObject({
      to: 'EGHQ',
      planned_to: 'LCRA',
      revisions: 'return',
      landed_during_closure: 'yes',
      caution: 'yes',
    });
    const missions = reportTable('missions', report(BOTH, operated)).rows;
    expect(missions[0]).toMatchObject({
      mission: 'MSN-000001',
      outcome: 'failed',
      landed_at: 'LIRF',
      planned_to: 'LCRA',
    });
    // The aborted mission ended at the abort; its flight landed later, and is the flight's row.
    expect(missions[1]).toMatchObject({
      mission: 'MSN-000002',
      outcome: 'aborted',
      landed_at: 'EGHQ',
      planned_to: 'LCRA',
    });
    // An undiverted flight reports the same place twice, and no changes.
    expect(reportTable('fuel', report(BOTH)).rows[0]).toMatchObject({
      to: 'EGHQ',
      planned_to: 'EGHQ',
      revisions: '',
      held_h: 0,
    });
    const summary = reportTable('summary', report(BOTH, operated)).rows;
    expect(summary.find((row) => row.metric === 'missions_aborted')?.value).toBe(1);
    expect(summary.find((row) => row.metric === 'flights_diverted')?.value).toBe(2);
    expect(summary.find((row) => row.metric === 'held_hours')?.value).toBe(0.25);
  });

  it('shows what is still in the air apart, and counts none of it', () => {
    const current = report({ fromTick: 0, toTick: 10_000_000 }, operated);
    expect(current.inProgress.flights).toHaveLength(1);
    expect(current.inProgress.flights[0]).toMatchObject({
      id: 'FLT-000009',
      elapsedS: 2000,
      fuelUsedKg: 3000,
      holding: 'closure',
    });
    expect(current.inProgress.missions.map((each) => each.id)).toEqual(['MSN-000009']);
    // Totals, lists and series hold only what has finished.
    const without = report(
      { fromTick: 0, toTick: 10_000_000 },
      { ...operated, inProgressFlights: [], inProgressMissions: [] },
    );
    expect(current.totals).toEqual(without.totals);
    expect(current.flights).toEqual(without.flights);
    expect(current.missions).toEqual(without.missions);
    expect(current.series).toEqual(without.series);
    expect(current.aircraft).toEqual(without.aircraft);
    expect(current.totals.flights).toBe(2);
    expect(current.totals.fuelUsedKg).toBe(7600 * 1.5);
    for (const name of ['summary', 'missions', 'fleet', 'fuel'] as const) {
      expect(toCsv(reportTable(name, current))).toBe(toCsv(reportTable(name, without)));
      expect(toCsv(reportTable(name, current))).not.toContain('FLT-000009');
    }
  });

  it('shows nothing in progress for a period that is already over', () => {
    expect(report(DAY_ONE, operated).inProgress).toEqual({ flights: [], missions: [] });
    // A period that reaches the present does.
    const today = report({ fromTick: MIDNIGHT, toTick: operated.asOfTick + 1 }, operated);
    expect(today.inProgress.flights).toHaveLength(1);
  });
});

describe('historical correctness', () => {
  it('does not change a past period when the aircraft changes afterwards', () => {
    const before = report(DAY_ONE);
    // Later: A is re-modelled, rebased, worn and in maintenance; B has gone on flying.
    const later: ReportData = {
      ...DATA,
      asOfTick: 500_000,
      aircraft: [
        aircraft('A', {
          typeName: 'Something else entirely',
          home: 'EGPK',
          conditionPct: 61,
          status: 'in_maintenance',
          flightSecondsTotal: 900_000,
        }),
        aircraft('B', { flightSecondsTotal: 400_000 }),
        aircraft('C', { acquiredTick: 100_000 }),
      ],
      flights: [...DATA.flights, flight('FLT-000009', 'B', 300_000, 310_000)],
      statusLog: [
        ...LOG,
        entry(300_000, 'command', 'launchFlight', 'B'),
        entry(310_000, 'event', 'flightCompleted', 'B'),
        entry(400_000, 'command', 'startMaintenance', 'A'),
      ],
    };
    const after = report(DAY_ONE, later);
    expect(after.totals).toEqual(before.totals);
    expect(after.flights).toEqual(before.flights);
    expect(after.missions).toEqual(before.missions);
    expect(after.missionTypes).toEqual(before.missionTypes);
    expect(after.series).toEqual(before.series);
    expect(after.aircraft.map((row) => [row.flightSeconds, row.fuelUsedKg, row.time])).toEqual(
      before.aircraft.map((row) => [row.flightSeconds, row.fuelUsedKg, row.time]),
    );
  });

  it('carries both risk records, and leaves an unrecorded one absent', () => {
    const [first, second, third] = report(BOTH).missions;
    expect(first).toMatchObject({ id: 'MSN-000001', acceptanceRisk: 12, launchRisk: 18 });
    expect(second).toMatchObject({ id: 'MSN-000002', acceptanceRisk: null, launchRisk: 40 });
    expect(third?.acceptanceRisk).toBeNull();
    const row = reportTable('missions', report(BOTH)).rows[1];
    expect(row).toMatchObject({ mission: 'MSN-000002', risk_accepted: null, risk_launch: 40 });
  });
});

describe('determinism', () => {
  it('gives the same report whatever order the records were read in', () => {
    const shuffled: ReportData = {
      ...DATA,
      aircraft: [...DATA.aircraft].reverse(),
      flights: [...DATA.flights].reverse(),
      missions: [...DATA.missions].reverse(),
      events: [...DATA.events].reverse(),
    };
    const expected = report(BOTH);
    const actual = report(BOTH, shuffled);
    // The outlook orders by urgency then identifier, so it is unaffected too.
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  });

  it('orders by simulation time, then identifier', () => {
    const tied: ReportData = {
      ...DATA,
      flights: [flight('FLT-000020', 'A', 0, 500), flight('FLT-000003', 'B', 0, 500)],
      missions: [mission('MSN-000020', 'completed', 500), mission('MSN-000003', 'failed', 500)],
    };
    const tiedReport = report(DAY_ONE, tied);
    expect(tiedReport.flights.map((f) => f.id)).toEqual(['FLT-000003', 'FLT-000020']);
    expect(tiedReport.missions.map((m) => m.id)).toEqual(['MSN-000003', 'MSN-000020']);
  });
});

describe('export', () => {
  const full = report(BOTH);

  it('writes CSV with a header, CRLF line ends and empty cells for what is not recorded', () => {
    const csv = toCsv(reportTable('missions', full));
    const lines = csv.split('\r\n');
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(lines).toHaveLength(1 + 5 + 1);
    expect(
      lines[0]?.startsWith('Mission,Title,Type,Origin,Outcome,Priority,Aircraft,Flight,'),
    ).toBe(true);
    const cells = (lines[1] ?? '').split(',');
    expect(cells.slice(0, 8)).toEqual([
      'MSN-000001',
      'Mission MSN-000001',
      'Training',
      'manual',
      'completed',
      'routine',
      'A',
      'FLT-000001',
    ]);
    expect(cells).toContain('2026-10-04T13:01:40Z');
    // Flight time 1 h, 720 km, 5,400 kg used.
    expect(cells).toContain('5400');
    expect(cells).toContain('720');
    // The cancelled mission never flew: its flight columns are empty, not zero.
    expect(lines[3]).toContain(
      'MSN-000004,Mission MSN-000004,Training,manual,cancelled,routine,A,,',
    );
  });

  it('quotes what must be quoted and disarms text that a spreadsheet would run', () => {
    const awkward = report(BOTH, {
      ...DATA,
      missions: [
        mission('MSN-000001', 'completed', 500, { title: 'Supply run, "urgent"\nsecond line' }),
        mission('MSN-000002', 'completed', 600, { title: '=HYPERLINK("http://x")' }),
        mission('MSN-000003', 'completed', 700, { title: '-5 degrees', summary: '@home' }),
      ],
    });
    const csv = toCsv(reportTable('missions', awkward));
    expect(csv).toContain('"Supply run, ""urgent""\nsecond line"');
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain("'-5 degrees");
    expect(csv).toContain("'@home");
  });

  it('writes numbers plainly, and negative numbers as numbers', () => {
    const csv = toCsv(reportTable('summary', full));
    expect(csv).toContain('flight_hours,Flight time,2.139,h\r\n');
    expect(csv).toContain('fuel_used,Fuel used,11550,kg\r\n');
    expect(csv).toContain('fuel_weather,Fuel against still air,200,kg\r\n');
    const tailwind = report(BOTH, {
      ...DATA,
      flights: [flight('FLT-000001', 'A', 100, 3700, { stillAirFuelUsedKg: 6000.5 })],
    });
    expect(toCsv(reportTable('summary', tailwind))).toContain(
      'fuel_weather,Fuel against still air,-600.5,kg\r\n',
    );
  });

  it('writes JSON that says what it is and carries the same rows as the CSV', () => {
    const table = reportTable('fleet', full);
    const parsed = JSON.parse(toJson(table, full)) as {
      meta: Record<string, unknown>;
      rows: Record<string, unknown>[];
    };
    expect(parsed.meta).toMatchObject({
      application: 'AEGIS',
      report: 'fleet',
      title: 'Fleet utilisation',
      period: {
        fromTick: 0,
        toTick: 129_600,
        fromUtc: '2026-10-04T12:00:00Z',
        toUtc: '2026-10-06T00:00:00Z',
      },
      asOf: { tick: 130_000, utc: '2026-10-06T00:06:40Z' },
      simulationModel: 5,
      filter: NO_FILTER,
      rowCount: 3,
    });
    expect(String(parsed.meta.content)).toMatch(/Simulated data/);
    expect(parsed.rows).toEqual(table.rows);
    expect(parsed.rows[0]).toMatchObject({ aircraft: 'A', flights: 2, flight_h: 1.028 });
    expect(Object.keys(parsed.rows[0] ?? {})).toEqual(table.columns.map((column) => column.key));
  });

  it('exports every table, each with as many cells in a row as it has columns', () => {
    for (const name of ['summary', 'missions', 'fleet', 'fuel', 'maintenance', 'events'] as const) {
      const table = reportTable(name, full);
      expect(table.rows.length).toBeGreaterThan(0);
      for (const row of table.rows) {
        expect(Object.keys(row)).toEqual(table.columns.map((column) => column.key));
      }
      expect(new Set(table.columns.map((column) => column.key)).size).toBe(table.columns.length);
    }
    expect(reportTable('events', full).rows[0]).toMatchObject({
      event: 'EVT-000001',
      type: 'Aerodrome closure',
      severity: 50,
      duration_h: 2.778,
      missions_affected: 'MSN-000004',
    });
    expect(reportTable('maintenance', full).rows).toEqual([
      expect.objectContaining({ aircraft: 'B', duration_h: 6, state: 'completed' }),
      expect.objectContaining({ aircraft: 'A', duration_h: 6, state: 'completed' }),
    ]);
  });

  it('exports only what the period and the filter leave', () => {
    expect(reportTable('missions', report(DAY_TWO)).rows.map((row) => row.mission)).toEqual([
      'MSN-000003',
    ]);
    const failed = { ...NO_FILTER, missionStatus: 'failed' as const };
    expect(reportTable('missions', full, failed).rows.map((row) => row.mission)).toEqual([
      'MSN-000002',
    ]);
    const onlyB = { ...NO_FILTER, aircraftId: 'B' };
    expect(reportTable('fuel', full, onlyB).rows.map((row) => row.flight)).toEqual(['FLT-000002']);
    expect(reportTable('fleet', full, onlyB).rows).toHaveLength(1);
    expect(reportTable('maintenance', full, onlyB).rows).toHaveLength(1);
    const training = { ...NO_FILTER, missionType: 'training' as const };
    expect(filterMissions(full, training)).toHaveLength(4);
    expect(filterFlights(full, training).map((f) => f.id)).toEqual(['FLT-000001', 'FLT-000003']);
    const closures = { ...NO_FILTER, eventType: 'aerodrome_closure' as const };
    expect(reportTable('events', full, closures).rows).toHaveLength(1);
    const exported = JSON.parse(toJson(reportTable('fuel', full, onlyB), full, onlyB)) as {
      meta: { filter: unknown };
    };
    expect(exported.meta.filter).toEqual(onlyB);
  });

  it('is byte-identical for the same report, and named from simulation time', () => {
    const again = report(BOTH);
    for (const name of ['summary', 'missions', 'fleet', 'fuel', 'maintenance', 'events'] as const) {
      expect(toCsv(reportTable(name, again))).toBe(toCsv(reportTable(name, full)));
      expect(toJson(reportTable(name, again), again)).toBe(toJson(reportTable(name, full), full));
    }
    expect(exportFileName('missions', full, 'csv')).toBe(
      'aegis-missions-20261004T1200Z-20261006T0000Z.csv',
    );
    // A period that runs past the report is named for the report's moment.
    expect(exportFileName('fleet', report({ fromTick: 0, toTick: 10_000_000 }), 'json')).toBe(
      'aegis-fleet-20261004T1200Z-20261006T0006Z.json',
    );
  });
});

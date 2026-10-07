import { NO_READINESS, NO_TOTALS } from '@aegis/domain';
import type { LogEntry } from '@aegis/sim';
import { describe, expect, it } from 'vitest';
import {
  DAY_LOG_TYPES,
  careerRecord,
  commandTime,
  dayEntries,
  notableEntries,
  readinessText,
  recordChanges,
  recordValue,
  totalsBefore,
} from './career-logic';
import { careerEpochMs, preludeSteps } from './brief-logic';

let seq = 0;
const entry = (tick: number, type: string, overrides: Partial<LogEntry> = {}): LogEntry => ({
  seq: ++seq,
  tick,
  kind: 'event',
  type,
  actor: 'world',
  missionId: null,
  aircraftId: null,
  flightId: null,
  payload: {},
  ...overrides,
});
const order = (tick: number, type: string, overrides: Partial<LogEntry> = {}) =>
  entry(tick, type, { kind: 'command', actor: 'player', ...overrides });

describe('the record, set out', () => {
  it('shows every row, at zero where nothing has happened', () => {
    const record = careerRecord({});
    expect(record.map((group) => group.title)).toEqual([
      'Missions',
      'Commitments met',
      'Aircraft',
      'Events faced',
      'Orders given',
      'Routine operations',
    ]);
    expect(record.flatMap((group) => group.rows).every((row) => row.value === 0)).toBe(true);
    // The one thing the record cannot say is said, not shown as a number.
    expect(record.find((group) => group.title === 'Orders given')?.note).toMatch(
      /does not judge decisions/,
    );
  });

  it('reads each row from the counter the simulation moved', () => {
    const record = careerRecord({
      'missions.completed': 184,
      'missions.failed': 7,
      'missions.completed.routine': 150,
      'commitments.overseas': 12,
      'flights.seconds': 5400,
      'orders.reroutes': 2,
      'orders.holds': 3,
      'orders.missionsCancelled': 1,
      'orders.missionsReleased': 4,
      'events.aerodrome_closure': 2,
    });
    const row = (group: string, label: string) =>
      record.find((each) => each.title === group)?.rows.find((each) => each.label === label);
    expect(row('Missions', 'Completed')?.value).toBe(184);
    expect(row('Missions', 'Completed by routine tasking')?.value).toBe(150);
    expect(row('Commitments met', 'Ending overseas')?.value).toBe(12);
    expect(row('Aircraft', 'Hours flown')).toEqual({ label: 'Hours flown', value: 1.5, unit: 'h' });
    expect(row('Orders given', 'Reroutes and holds ordered')?.value).toBe(5);
    expect(row('Orders given', 'Missions cancelled or released')?.value).toBe(5);
    expect(row('Events faced', 'Aerodrome closure')?.value).toBe(2);
    expect(recordValue(1.5, 'h')).toBe('1.5 h');
    expect(recordValue(12_345)).toBe('12,345');
  });

  it('lists what a day moved, with the career total before it and after it', () => {
    const day = { 'missions.completed': 1, 'orders.total': 3, 'orders.launches': 3 };
    const after = {
      'missions.completed': 184,
      'missions.failed': 7,
      'orders.total': 40,
      'orders.launches': 9,
    };
    const before = totalsBefore({ ...NO_TOTALS, counters: after }, day);
    expect(before).toEqual({
      'missions.completed': 183,
      'missions.failed': 7,
      'orders.total': 37,
      'orders.launches': 6,
    });
    expect(recordChanges(before, after)).toEqual([
      { group: 'Missions', label: 'Completed', before: 183, after: 184 },
      { group: 'Orders given', label: 'Orders in all', before: 37, after: 40 },
      { group: 'Orders given', label: 'Launches ordered', before: 6, after: 9 },
    ]);
    // A day in which nothing moved changes nothing.
    expect(recordChanges(after, after)).toEqual([]);
  });

  it('writes command time and readiness as text, and says nothing where nothing is recorded', () => {
    expect(commandTime(41 * 3600 + 32 * 60 + 59)).toBe('41 h 32 min');
    expect(commandTime(0)).toBe('0 h 00 min');
    expect(readinessText({ aircraftSeconds: 400, readySeconds: 332, low: 0.5, high: 1 })).toEqual({
      mean: '83 %',
      low: '50 %',
      high: '100 %',
    });
    expect(readinessText(NO_READINESS)).toEqual({ mean: null, low: null, high: null });
  });
});

describe('what stood out in a day', () => {
  it('names what the world did and what was ordered, and leaves routine sorties to the totals', () => {
    seq = 0;
    const notable = notableEntries([
      entry(100, 'missionCompleted', { missionId: 'MSN-000001', payload: { routine: true } }),
      entry(200, 'missionCompleted', { missionId: 'MSN-000002', aircraftId: 'AEGIS-TR-001' }),
      entry(300, 'eventStarted', {
        payload: { eventType: 'aerodrome_closure', title: 'Exeter closed' },
      }),
      entry(310, 'eventStarted', { payload: { eventType: 'severe_weather' } }),
      entry(400, 'missionFailed', {
        missionId: 'MSN-000003',
        payload: { summary: 'Not launched before its deadline.' },
      }),
      order(500, 'reviseFlight', { aircraftId: 'AEGIS-FT-001', payload: { intent: 'divert' } }),
      order(510, 'launchMission', { missionId: 'MSN-000004' }),
      entry(520, 'setOperatingArea', { kind: 'command', actor: 'system' }),
      entry(600, 'flightFuelExhausted', { aircraftId: 'AEGIS-FT-002' }),
      entry(700, 'refuellingStarted'),
    ]);
    expect(notable.map((each) => [each.kind, each.tone, each.text])).toEqual([
      ['event', 'ok', 'Mission completed · MSN-000002 · AEGIS-TR-001'],
      ['event', 'warn', 'Exeter closed'],
      ['event', 'warn', 'Severe weather began'],
      ['event', 'critical', 'Mission failed · MSN-000003. Not launched before its deadline.'],
      ['order', 'info', 'Diversion ordered · AEGIS-FT-001'],
      ['order', 'info', 'Mission launched · MSN-000004'],
      ['event', 'critical', 'Out of fuel in flight · AEGIS-FT-002'],
    ]);
  });

  it('gives a day exactly its own entries, where two days share a tick', () => {
    seq = 0;
    const log = [
      entry(1000, 'maintenanceDue'), // 1: before command
      order(1000, 'takeCommand'), // 2
      entry(1000, 'eventStarted'), // 3: day 1
      order(4000, 'acceptMission'), // 4: day 1
      entry(9000, 'missionFailed'), // 5: day 1, at the closing tick
      order(9000, 'endCommandDay'), // 6
      entry(9000, 'maintenanceDue'), // 7: day 2, same tick
      order(9500, 'launchMission'), // 8: day 2
      order(20_000, 'endCommandDay'), // 9
    ];
    const seqs = (day: { startedTick: number; endedTick: number | null }) =>
      dayEntries(
        log.filter(
          (each) => each.tick >= day.startedTick && each.tick <= (day.endedTick ?? Infinity),
        ),
        day,
      ).map((each) => each.seq);
    expect(seqs({ startedTick: 1000, endedTick: 9000 })).toEqual([3, 4, 5]);
    expect(seqs({ startedTick: 9000, endedTick: 20_000 })).toEqual([7, 8]);
    // An open day runs to the end of what there is.
    expect(seqs({ startedTick: 20_000, endedTick: null })).toEqual([]);
    expect(DAY_LOG_TYPES).toEqual(expect.arrayContaining(['takeCommand', 'endCommandDay']));
  });
});

describe('the hours before command', () => {
  it('begins a career at midnight UTC of the day it is started', () => {
    expect(careerEpochMs(Date.UTC(2026, 9, 7, 14, 23, 5, 300))).toBe(Date.UTC(2026, 9, 7));
    expect(careerEpochMs(Date.UTC(2026, 9, 7))).toBe(Date.UTC(2026, 9, 7));
  });

  it('runs it to a minute between 06:00 and 06:44 that the seed picks', () => {
    const steps = ['a', 'b', 'career', '06139e4c8a47629dc5740077bb4e0659'].map(preludeSteps);
    for (const each of steps) {
      expect(each % 60).toBe(0);
      expect(each).toBeGreaterThanOrEqual(6 * 3600);
      expect(each).toBeLessThan(6 * 3600 + 45 * 60);
    }
    expect(new Set(steps).size).toBeGreaterThan(1);
    expect(preludeSteps('career')).toBe(preludeSteps('career'));
  });
});

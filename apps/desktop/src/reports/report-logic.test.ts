import { TICKS_PER_DAY, type Report } from '@aegis/domain';
import { describe, expect, it } from 'vitest';
import {
  againstEstimate,
  bucketLabel,
  changeText,
  defaultCustom,
  describePeriod,
  formatSimTime,
  nextSort,
  parseSimTime,
  percentText,
  reportSeries,
  resolvePeriod,
  sortRows,
} from './report-logic';

/** The world begins at noon on 4 October 2026. */
const EPOCH = Date.UTC(2026, 9, 4, 12);

describe('simulation times typed by hand', () => {
  it('reads YYYY-MM-DD HH:MM as simulation UTC, and writes it back the same', () => {
    expect(parseSimTime('2026-10-04 13:30')).toBe(Date.UTC(2026, 9, 4, 13, 30));
    expect(parseSimTime(' 2026-10-04T13:30 ')).toBe(Date.UTC(2026, 9, 4, 13, 30));
    expect(formatSimTime(Date.UTC(2026, 9, 4, 13, 30))).toBe('2026-10-04 13:30');
  });

  it('refuses anything that is not a real date and time', () => {
    for (const text of [
      '',
      'yesterday',
      '2026-10-04',
      '2026-10-04 25:00',
      '2026-10-04 12:60',
      '2026-02-31 12:00',
      '2026-13-01 00:00',
      '04/10/2026 12:00',
      '2026-10-04 12:00:00',
    ]) {
      expect(parseSimTime(text)).toBeNull();
    }
  });
});

describe('choosing a period', () => {
  const custom = (from: string, to: string) =>
    resolvePeriod({ kind: 'custom', from, to }, 200_000, EPOCH);

  it('measures a named period from the moment of the report', () => {
    expect(resolvePeriod({ kind: 'last24h', from: '', to: '' }, 200_000, EPOCH)).toEqual({
      period: { fromTick: 200_001 - TICKS_PER_DAY, toTick: 200_001 },
      problem: null,
    });
    // What is typed in the custom fields is ignored unless the period is custom.
    expect(
      resolvePeriod({ kind: 'today', from: 'nonsense', to: '' }, 200_000, EPOCH).period,
    ).toEqual({ fromTick: 129_600, toTick: 200_001 });
  });

  it('turns a custom period into ticks', () => {
    expect(custom('2026-10-05 00:00', '2026-10-06 00:00')).toEqual({
      period: { fromTick: 43_200, toTick: 129_600 },
      problem: null,
    });
  });

  it('says what is wrong with a custom period it cannot use', () => {
    expect(custom('2026-10-05', '2026-10-06 00:00').problem).toMatch(/YYYY-MM-DD HH:MM/);
    expect(custom('2026-10-06 00:00', '2026-10-05 00:00').problem).toMatch(/end after it begins/);
    expect(custom('2026-10-06 00:00', '2026-10-06 00:00').problem).toMatch(/end after it begins/);
    expect(custom('2027-01-01 00:00', '2027-01-02 00:00').problem).toMatch(/after the present/);
    expect(custom('2026-10-06 00:00', '2026-10-05 00:00').period).toBeNull();
  });

  it('offers the last 24 hours, to the minute, as a custom period to start from', () => {
    const start = defaultCustom(200_000, EPOCH);
    expect(start).toEqual({ from: '2026-10-05 19:33', to: '2026-10-06 19:34' });
    const period = custom(start.from, start.to).period;
    expect(period?.fromTick).toBeLessThanOrEqual(200_001 - TICKS_PER_DAY);
    expect(period?.toTick).toBeGreaterThanOrEqual(200_001);
  });

  it('describes a period in simulation time, up to the moment of the report', () => {
    expect(describePeriod({ fromTick: 0, toTick: 43_200 }, 500_000, EPOCH)).toBe(
      '2026-10-04 12:00 to 2026-10-04 23:59 UTC · 12 h of simulation time',
    );
    // A period that runs past the report is described as far as the report goes.
    expect(describePeriod({ fromTick: 0, toTick: 10_000_000 }, 5 * TICKS_PER_DAY, EPOCH)).toBe(
      '2026-10-04 12:00 to 2026-10-09 12:00 UTC · 5 days of simulation time',
    );
    expect(describePeriod({ fromTick: 0, toTick: 601 }, 600, EPOCH)).toMatch(/· 10 min of/);
  });
});

describe('series for charts', () => {
  const point = (fromTick: number, toTick: number, flightSeconds: number) => ({
    fromTick,
    toTick,
    flights: flightSeconds > 0 ? 1 : 0,
    flightSeconds,
    distanceM: 0,
    fuelUsedKg: flightSeconds * 1.5,
    missionsCompleted: flightSeconds > 0 ? 1 : 0,
    missionsFailed: 0,
    eventsStarted: 0,
    availability: flightSeconds > 0 ? 0.5 : null,
  });
  const report = (series: Report['series']) => ({ series, epochMs: EPOCH }) as Report;

  it('labels hourly buckets by the hour and daily ones by the simulated day', () => {
    expect(bucketLabel({ fromTick: 7200, toTick: 10_800 }, EPOCH, true)).toBe('14:00');
    expect(bucketLabel({ fromTick: 43_200, toTick: 129_600 }, EPOCH, false)).toBe('05 Oct');
    expect(bucketLabel({ fromTick: 0, toTick: 43_200 }, EPOCH, false)).toBe('04 Oct');
  });

  it('keeps the buckets in order and carries a gap as a gap', () => {
    const hourly = reportSeries(report([point(0, 3600, 1800), point(3600, 7200, 0)]));
    expect(hourly.hourly).toBe(true);
    expect(hourly.categories).toEqual(['12:00', '13:00']);
    expect(hourly.flightHours[0]?.values).toEqual([0.5, 0]);
    expect(hourly.fuel[0]?.values).toEqual([2700, 0]);
    expect(hourly.availability[0]?.values).toEqual([50, null]);
    expect(hourly.outcomes.map((series) => series.name)).toEqual(['Completed', 'Failed']);

    const daily = reportSeries(report([point(0, 43_200, 3600), point(43_200, 129_600, 7200)]));
    expect(daily.hourly).toBe(false);
    expect(daily.categories).toEqual(['04 Oct', '05 Oct']);
  });

  it('gives an empty period empty series', () => {
    const empty = reportSeries(report([]));
    expect(empty.categories).toEqual([]);
    expect(empty.flightHours[0]?.values).toEqual([]);
  });
});

describe('figures in words', () => {
  it('compares with the period before, and says when there is none', () => {
    expect(changeText(5, 3)).toBe('+2 on the period before');
    expect(changeText(1, 4)).toBe('−3 on the period before');
    expect(changeText(4, 4)).toBe('Same as the period before');
    expect(changeText(4, null)).toBe('No earlier period to compare');
    expect(changeText(12.34, 10, (value) => `${value.toFixed(1)} h`)).toBe(
      '+2.3 h on the period before',
    );
    // A difference too small to show is not reported as a difference.
    expect(changeText(10.01, 10, (value) => `${value.toFixed(1)} h`)).toBe(
      'Same as the period before',
    );
  });

  it('gives a share as a percentage, and nothing where there is no share', () => {
    expect(percentText(0.4625)).toBe('46.3');
    expect(percentText(1)).toBe('100.0');
    expect(percentText(null)).toBeNull();
  });

  it('gives the difference from an estimate, signed', () => {
    expect(againstEstimate(1012, 1000)).toBe('+1.2 %');
    expect(againstEstimate(950, 1000)).toBe('−5.0 %');
    expect(againstEstimate(1000, 1000)).toBe('+0.0 %');
    expect(againstEstimate(1000, 0)).toBeNull();
    expect(againstEstimate(1000, null)).toBeNull();
  });
});

describe('sorting a table', () => {
  const rows = [
    { id: 'A', hours: 4, type: 'Typhoon' },
    { id: 'B', hours: null, type: 'Atlas' },
    { id: 'C', hours: 9, type: 'Atlas' },
    { id: 'D', hours: 4, type: 'Globemaster' },
  ];
  const values = {
    hours: (row: (typeof rows)[number]) => row.hours,
    type: (row: (typeof rows)[number]) => row.type,
  };
  const ids = (sorted: typeof rows) => sorted.map((row) => row.id).join('');

  it('leaves the report in its own order until a column is chosen', () => {
    expect(ids(sortRows(rows, values, null))).toBe('ABCD');
    expect(ids(sortRows(rows, values, { key: 'unknown', descending: true }))).toBe('ABCD');
  });

  it('sorts either way, keeps ties in the report’s order, and puts missing values last', () => {
    expect(ids(sortRows(rows, values, { key: 'hours', descending: true }))).toBe('CADB');
    expect(ids(sortRows(rows, values, { key: 'hours', descending: false }))).toBe('ADCB');
    expect(ids(sortRows(rows, values, { key: 'type', descending: false }))).toBe('BCDA');
  });

  it('does not change the rows it was given', () => {
    sortRows(rows, values, { key: 'hours', descending: true });
    expect(ids(rows)).toBe('ABCD');
  });

  it('starts a new column descending and flips the same one', () => {
    expect(nextSort(null, 'hours')).toEqual({ key: 'hours', descending: true });
    expect(nextSort({ key: 'hours', descending: true }, 'hours')).toEqual({
      key: 'hours',
      descending: false,
    });
    expect(nextSort({ key: 'hours', descending: false }, 'type')).toEqual({
      key: 'type',
      descending: true,
    });
  });
});

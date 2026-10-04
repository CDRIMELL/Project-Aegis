import { describe, expect, it } from 'vitest';
import type { AircraftAttributeRecord, NormalisedDataset } from '../model';
import {
  UNKNOWN_CONDITIONS,
  applyRangeConditions,
  rangeConditionsRevisedAt,
  variantFromHeading,
  type RangeConditions,
} from './range-conditions';

const row = (
  type: string,
  key: AircraftAttributeRecord['key'],
  value: number,
): AircraftAttributeRecord => ({
  sourceKey: `${type}/${key}`,
  confidence: 'medium',
  verification: 'source_asserted',
  typeId: `aegis-curated:${type}`,
  key,
  value,
  sourceText: `${key}=${value}`,
  sourceUrl: 'https://example.org/page',
  note: null,
  variant: null,
});
const dataset = (rows: AircraftAttributeRecord[]): NormalisedDataset<AircraftAttributeRecord> => ({
  dataset: 'aircraft-attributes',
  sourceId: 'wikipedia',
  raw: { url: 'file', sha256: 'x', retrievedAt: '2026-10-04T00:00:00.000Z' },
  rowsRead: rows.length,
  rowsSkipped: 0,
  rows,
  issues: [],
});
const SOURCE = {
  source: 'wikipedia',
  sourceName: 'Example encyclopaedia, "Example aircraft", revision 1',
  sourceUrl: 'https://example.org/w/index.php?oldid=1',
  retrievedAt: '2026-10-04',
};
const file = (entries: object[]) => JSON.stringify({ revisedAt: '2026-10-04', entries });
const conditionsOf = (record: AircraftAttributeRecord | undefined) =>
  JSON.parse(record?.conditions ?? 'null') as RangeConditions | null;

const ROWS = [
  row('transport', 'range_km', 4482),
  row('transport', 'ferry_range_km', 11538),
  row('transport', 'length_m', 53),
  row('fighter', 'ferry_range_km', 3790),
];

describe('range conditions', () => {
  it('records what the source states, converting a payload from the source’s unit', () => {
    const result = applyRangeConditions(
      dataset(ROWS),
      file([
        {
          type: 'transport',
          key: 'range_km',
          sourceText: 'range note = with 157,000 lb payload',
          payload: { sourceValue: 157000, sourceUnit: 'lb' },
          externalFuel: 'unknown',
          fuel: 'unknown',
          speedAltitude: 'unknown',
          ...SOURCE,
        },
      ]),
      'wikipedia',
    );
    expect(conditionsOf(result.rows[0])).toEqual({
      payloadKg: 71214,
      externalFuel: 'unknown',
      fuel: 'unknown',
      speedAltitude: 'unknown',
      sourceText: 'range note = with 157,000 lb payload',
      sourceName: SOURCE.sourceName,
      sourceUrl: SOURCE.sourceUrl,
      note: null,
    });
    expect(result.issues).toEqual([]);
  });

  it('marks every condition unknown where no source states one, and never guesses', () => {
    const result = applyRangeConditions(dataset(ROWS), file([]), 'wikipedia');
    expect(conditionsOf(result.rows[0])).toEqual(UNKNOWN_CONDITIONS);
    expect(conditionsOf(result.rows[1])).toEqual(UNKNOWN_CONDITIONS);
    expect(UNKNOWN_CONDITIONS).toMatchObject({
      payloadKg: 'unknown',
      externalFuel: 'unknown',
      fuel: 'unknown',
      speedAltitude: 'unknown',
      sourceText: null,
    });
    // With no curated file at all, the result is the same.
    expect(applyRangeConditions(dataset(ROWS), null, 'wikipedia').rows).toEqual(result.rows);
  });

  it('gives conditions only to range figures', () => {
    const result = applyRangeConditions(dataset(ROWS), file([]), 'wikipedia');
    expect(result.rows[2]?.conditions).toBeUndefined();
    expect(result.rows[2]).toEqual(ROWS[2]);
  });

  it('records external fuel as stated', () => {
    const result = applyRangeConditions(
      dataset(ROWS),
      file([
        {
          type: 'fighter',
          key: 'ferry_range_km',
          sourceText: 'ferry range note = with 3 drop tanks',
          payload: 'unknown',
          externalFuel: true,
          fuel: 'With three external fuel tanks.',
          speedAltitude: 'unknown',
          ...SOURCE,
        },
      ]),
      'wikipedia',
    );
    expect(conditionsOf(result.rows[3])).toMatchObject({
      externalFuel: true,
      payloadKg: 'unknown',
      fuel: 'With three external fuel tanks.',
    });
  });

  it('keeps a loading it does not hold as "not recorded", without the source’s words for it', () => {
    const result = applyRangeConditions(
      dataset(ROWS),
      file([
        {
          type: 'fighter',
          key: 'ferry_range_km',
          sourceText: 'range note present',
          payload: 'not_recorded',
          externalFuel: 'unknown',
          fuel: 'unknown',
          speedAltitude: 'unknown',
          note: 'The source states a loading for this figure. AEGIS does not hold such data.',
          ...SOURCE,
        },
      ]),
      'wikipedia',
    );
    expect(conditionsOf(result.rows[3])).toMatchObject({
      payloadKg: 'not_recorded',
      sourceText: 'range note present',
    });
  });

  it('names a second source when the payload’s mass comes from one', () => {
    const result = applyRangeConditions(
      dataset(ROWS),
      file([
        {
          type: 'transport',
          key: 'range_km',
          sourceText: 'range note = at max payload',
          payload: { sourceValue: 37, sourceUnit: 't' },
          payloadSource: {
            sourceText: '37 tonnes maximum payload',
            sourceName: 'Example manufacturer',
            sourceUrl: 'https://example.org/maker',
          },
          externalFuel: 'unknown',
          fuel: 'unknown',
          speedAltitude: 'unknown',
          ...SOURCE,
        },
      ]),
      'wikipedia',
    );
    expect(conditionsOf(result.rows[0])).toMatchObject({
      payloadKg: 37000,
      sourceText: 'range note = at max payload; Example manufacturer: 37 tonnes maximum payload',
    });
  });

  it('applies an entry only to the source it belongs to', () => {
    const entry = {
      type: 'transport',
      key: 'range_km',
      sourceText: 'x',
      payload: 'unknown',
      externalFuel: false,
      fuel: 'unknown',
      speedAltitude: 'unknown',
      ...SOURCE,
      source: 'aegis-curated',
    };
    const fromWikipedia = applyRangeConditions(dataset(ROWS), file([entry]), 'wikipedia');
    expect(conditionsOf(fromWikipedia.rows[0])).toEqual(UNKNOWN_CONDITIONS);
    expect(fromWikipedia.issues).toEqual([]);
    const fromCurated = applyRangeConditions(dataset(ROWS), file([entry]), 'aegis-curated');
    expect(conditionsOf(fromCurated.rows[0])?.externalFuel).toBe(false);
  });

  it('reports conditions recorded for a range the source does not give, and duplicates', () => {
    const entry = (type: string) => ({
      type,
      key: 'range_km',
      sourceText: 'x',
      payload: 'unknown',
      externalFuel: 'unknown',
      fuel: 'unknown',
      speedAltitude: 'unknown',
      ...SOURCE,
    });
    const result = applyRangeConditions(
      dataset(ROWS),
      file([entry('absent'), entry('transport'), entry('transport')]),
      'wikipedia',
    );
    expect(result.issues.map((issue) => [issue.severity, issue.code, issue.recordKey])).toEqual([
      ['error', 'duplicate_range_conditions', 'transport/range_km'],
      ['warning', 'range_conditions_unused', 'absent/range_km'],
    ]);
  });

  it('rejects an entry that carries anything beyond the agreed fields', () => {
    const extra = file([
      {
        type: 'fighter',
        key: 'ferry_range_km',
        sourceText: 'x',
        payload: 'unknown',
        externalFuel: 'unknown',
        fuel: 'unknown',
        speedAltitude: 'unknown',
        armament: 'two missiles',
        ...SOURCE,
      },
    ]);
    expect(() => applyRangeConditions(dataset(ROWS), extra, 'wikipedia')).toThrow();
  });

  it('is deterministic', () => {
    const conditions = file([]);
    expect(applyRangeConditions(dataset(ROWS), conditions, 'wikipedia')).toEqual(
      applyRangeConditions(dataset(ROWS), conditions, 'wikipedia'),
    );
    expect(rangeConditionsRevisedAt(conditions)).toBe('2026-10-04');
  });
});

describe('variant from a section heading', () => {
  it('takes the variant a heading names in brackets', () => {
    expect(variantFromHeading('Specifications (C-17A)')).toBe('C-17A');
    expect(variantFromHeading('Specifications (A350-941, with Trent XWB-84 engines)')).toBe(
      'A350-941, with Trent XWB-84 engines',
    );
    expect(variantFromHeading('JAS 39C/D')).toBe('JAS 39C/D');
  });

  it('gives none where the heading names none', () => {
    expect(variantFromHeading('Specifications')).toBeNull();
    expect(variantFromHeading('Specification')).toBeNull();
    expect(variantFromHeading(null)).toBeNull();
    expect(variantFromHeading('Specifications ()')).toBeNull();
  });
});

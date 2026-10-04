import { describe, expect, it } from 'vitest';
import { CsvError, parseCsv } from './csv';

describe('parseCsv', () => {
  it('maps rows onto the header', () => {
    const { header, records } = parseCsv('id,name\n1,Alpha\n2,Bravo\n');
    expect(header).toEqual(['id', 'name']);
    expect(records.map((record) => record.values)).toEqual([
      { id: '1', name: 'Alpha' },
      { id: '2', name: 'Bravo' },
    ]);
  });

  it('handles quotes, doubled quotes, commas and line breaks inside quoted fields', () => {
    const { records } = parseCsv('id,name,note\n1,"Smith, ""Jo""","two\nlines"\n2,plain,\n');
    expect(records[0]?.values).toEqual({ id: '1', name: 'Smith, "Jo"', note: 'two\nlines' });
    expect(records[1]?.values).toEqual({ id: '2', name: 'plain', note: '' });
  });

  it('accepts CRLF line endings, a byte-order mark and a missing final newline', () => {
    const { header, records } = parseCsv('﻿id,name\r\n1,Alpha\r\n2,Bravo');
    expect(header).toEqual(['id', 'name']);
    expect(records).toHaveLength(2);
    expect(records[1]?.values.name).toBe('Bravo');
  });

  it('reports the line each record starts on, counting lines inside quoted fields', () => {
    const { records } = parseCsv('id,note\n1,"a\nb\nc"\n2,x\n');
    expect(records.map((record) => record.line)).toEqual([2, 5]);
  });

  it('ignores blank lines', () => {
    expect(parseCsv('id\n\n1\n\n\n2\n').records).toHaveLength(2);
  });

  it('reports rows with the wrong number of fields instead of guessing', () => {
    const { records, malformed } = parseCsv('id,name\n1,Alpha\n2\n3,Charlie,extra\n4,Delta\n');
    expect(records.map((record) => record.values.id)).toEqual(['1', '4']);
    expect(malformed).toEqual([
      { line: 3, reason: 'expected 2 fields, found 1' },
      { line: 4, reason: 'expected 2 fields, found 3' },
    ]);
  });

  it('rejects input it cannot interpret at all', () => {
    expect(() => parseCsv('')).toThrow(CsvError);
    expect(() => parseCsv('id,id\n1,2\n')).toThrow(/duplicate column/);
    expect(() => parseCsv('id,name\n1,"unterminated\n')).toThrow(/Unterminated/);
  });
});

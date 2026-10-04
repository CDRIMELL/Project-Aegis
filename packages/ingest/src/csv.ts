/** One data row of a CSV file, keyed by header name. */
export interface CsvRecord {
  /** 1-based line on which the record starts, for error reports. */
  readonly line: number;
  readonly values: Readonly<Record<string, string>>;
}

export interface CsvMalformed {
  readonly line: number;
  readonly reason: string;
}

export interface CsvParseResult {
  readonly header: readonly string[];
  readonly records: CsvRecord[];
  /** Rows that could not be mapped onto the header. They are reported, never guessed at. */
  readonly malformed: CsvMalformed[];
}

export class CsvError extends Error {
  override readonly name = 'CsvError';
}

/**
 * Parses RFC 4180 CSV: quoted fields, doubled quotes, commas and line breaks inside quotes,
 * LF or CRLF line endings, optional byte-order mark. The first row is the header.
 */
export function parseCsv(text: string): CsvParseResult {
  const rows: { line: number; fields: string[] }[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  let rowHasContent = false;

  const endRow = () => {
    if (rowHasContent || fields.length > 0) {
      fields.push(field);
      rows.push({ line: rowLine, fields });
    }
    fields = [];
    field = '';
    rowHasContent = false;
  };

  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (let i = start; i < text.length; i++) {
    const char = text.charAt(i);
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line++;
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      rowHasContent = true;
    } else if (char === ',') {
      fields.push(field);
      field = '';
      rowHasContent = true;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      endRow();
      line++;
      rowLine = line;
    } else {
      field += char;
      rowHasContent = true;
    }
  }
  if (inQuotes) {
    throw new CsvError(`Unterminated quoted field starting in the record at line ${rowLine}`);
  }
  endRow();

  const headerRow = rows.shift();
  if (!headerRow) {
    throw new CsvError('CSV input is empty');
  }
  const header = headerRow.fields;
  if (new Set(header).size !== header.length) {
    throw new CsvError('CSV header contains duplicate column names');
  }

  const records: CsvRecord[] = [];
  const malformed: CsvMalformed[] = [];
  for (const row of rows) {
    if (row.fields.length !== header.length) {
      malformed.push({
        line: row.line,
        reason: `expected ${header.length} fields, found ${row.fields.length}`,
      });
      continue;
    }
    const values: Record<string, string> = {};
    header.forEach((name, index) => {
      values[name] = row.fields[index] ?? '';
    });
    records.push({ line: row.line, values });
  }
  return { header, records, malformed };
}

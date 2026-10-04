import type { schema } from '@aegis/db';

/** Bumped when normalisation rules change in a way that alters output for the same input. */
export const PIPELINE_VERSION = 4;

/** The bytes a dataset was built from, and where and when they were obtained. */
export interface RawInput {
  readonly url: string;
  readonly sha256: string;
  /** ISO 8601 timestamp of retrieval. */
  readonly retrievedAt: string;
  readonly text: string;
}

export interface Issue {
  /** `error`: the record was rejected. `warning`: it was imported with a stated caveat. */
  readonly severity: schema.IssueSeverity;
  /** Stable machine-readable reason, for example `invalid_coordinates`. */
  readonly code: string;
  /** The source's key for the record, when one could be read. */
  readonly recordKey: string | null;
  readonly message: string;
}

/** Fields the pipeline fills in; normalisers never set them. */
type PipelineColumns = 'id' | 'dataset' | 'sourceId' | 'jobId' | 'contentHash';

/** A validated record ready to load: the table's columns minus those the pipeline owns. */
export type Normalised<Insert> = Omit<Insert, PipelineColumns>;

export type CountryRecord = Normalised<typeof schema.refCountry.$inferInsert>;
export type LocationRecord = Normalised<typeof schema.refLocation.$inferInsert>;
export type RunwayRecord = Normalised<typeof schema.refRunway.$inferInsert>;
export type AircraftTypeRecord = Normalised<typeof schema.refAircraftType.$inferInsert>;
export type AircraftAttributeRecord = Normalised<typeof schema.refAircraftAttribute.$inferInsert>;

/** Output of a normaliser: pure data, with every problem accounted for. */
export interface NormalisedDataset<Row> {
  /** Stable dataset name, for example `ourairports-airports`. */
  readonly dataset: string;
  readonly sourceId: string;
  readonly raw: Omit<RawInput, 'text'>;
  /** Records present in the input, including skipped and rejected ones. */
  readonly rowsRead: number;
  /** Records deliberately out of scope. Not defects, so not issues. */
  readonly rowsSkipped: number;
  readonly rows: Row[];
  readonly issues: Issue[];
}

/** Collects issues while normalising. */
export class IssueLog {
  readonly issues: Issue[] = [];

  error(code: string, recordKey: string | null, message: string): void {
    this.issues.push({ severity: 'error', code, recordKey, message });
  }

  warning(code: string, recordKey: string | null, message: string): void {
    this.issues.push({ severity: 'warning', code, recordKey, message });
  }
}

export function sourceId(id: string, key: string): string {
  return `${id}:${key}`;
}

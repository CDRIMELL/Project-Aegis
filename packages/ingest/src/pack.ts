import { schema, type AegisDb } from '@aegis/db';
import { desc } from 'drizzle-orm';
import { z } from 'zod';
import {
  REFERENCE_TABLES,
  loadReferenceData,
  type LoadReferenceOptions,
  type PreparedDataset,
  type ReferenceTableName,
} from './import';
import type { JobReport } from './load';
import { PIPELINE_VERSION } from './model';

/*
 * Reference data pack (ADR 0013).
 *
 * A pack is the output of the normalise step, frozen: one file per dataset plus a manifest that
 * names each file and its SHA-256. It is built at release time from the pinned raw sources and
 * shipped inside the application. Installing a pack runs the same loader as a command-line import,
 * so jobs, provenance, issues and idempotency behave identically; only where the normalised records
 * come from differs.
 */

/** Bumped when the layout of the manifest or dataset files changes. */
export const PACK_FORMAT_VERSION = 1;
export const PACK_MANIFEST_FILE = 'manifest.json';

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

const manifestSchema = z
  .object({
    formatVersion: z.int().positive(),
    /** The normalisation rules that produced the pack. Must match the installing build. */
    pipelineVersion: z.int().positive(),
    datasets: z
      .array(
        z
          .object({
            dataset: z.string().min(1),
            table: z.enum(Object.keys(REFERENCE_TABLES) as [ReferenceTableName]),
            file: z.string().regex(/^[a-z0-9-]+\.json$/),
            sha256: sha256Hex,
            rows: z.int().nonnegative(),
            issues: z.int().nonnegative(),
            /** The raw input this dataset was normalised from. Carried into the job record. */
            raw: z
              .object({ url: z.string().min(1), sha256: sha256Hex, retrievedAt: z.string().min(1) })
              .strict(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type PackManifest = z.infer<typeof manifestSchema>;

const issueSchema = z
  .object({
    severity: z.enum(schema.ISSUE_SEVERITIES),
    code: z.string().min(1),
    recordKey: z.string().nullable(),
    message: z.string(),
  })
  .strict();

/** Rows are stored column-wise: one list of column names, then one array of values per row. */
const datasetFileSchema = z
  .object({
    dataset: z.string().min(1),
    sourceId: z.string().min(1),
    rowsRead: z.int().nonnegative(),
    rowsSkipped: z.int().nonnegative(),
    columns: z.array(z.string().min(1)),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
    issues: z.array(issueSchema),
  })
  .strict();

export class PackError extends Error {
  override readonly name = 'PackError';
}

export async function sha256Text(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface BuiltPack {
  /** File name to exact file content. Includes the manifest. */
  readonly files: Readonly<Record<string, string>>;
  readonly manifestSha256: string;
}

/**
 * Serialises prepared datasets into pack files. Deterministic: the same prepared datasets always
 * produce byte-identical files, and therefore the same manifest hash.
 */
export async function buildPack(prepared: readonly PreparedDataset[]): Promise<BuiltPack> {
  const files: Record<string, string> = {};
  const datasets: PackManifest['datasets'] = [];

  for (const { table, data } of prepared) {
    const columns = [...new Set(data.rows.flatMap((row) => Object.keys(row)))].sort();
    const rows = data.rows.map((row) => {
      const record = row as Readonly<Record<string, unknown>>;
      return columns.map((column) => record[column] ?? null);
    });
    const file = `${data.dataset}.json`;
    const text = JSON.stringify({
      dataset: data.dataset,
      sourceId: data.sourceId,
      rowsRead: data.rowsRead,
      rowsSkipped: data.rowsSkipped,
      columns,
      rows,
      issues: data.issues,
    });
    files[file] = text;
    datasets.push({
      dataset: data.dataset,
      table,
      file,
      sha256: await sha256Text(text),
      rows: data.rows.length,
      issues: data.issues.length,
      raw: data.raw,
    });
  }

  const manifest: PackManifest = {
    formatVersion: PACK_FORMAT_VERSION,
    pipelineVersion: PIPELINE_VERSION,
    datasets,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  files[PACK_MANIFEST_FILE] = manifestText;
  return { files, manifestSha256: await sha256Text(manifestText) };
}

/** Where pack files are read from: the application bundle, or a directory on disk. */
export interface PackReader {
  readText(file: string): Promise<string>;
}

export interface OpenedPack {
  readonly manifest: PackManifest;
  readonly manifestSha256: string;
}

/** Reads and checks the manifest only. Cheap: used to decide whether an install is needed. */
export async function openPack(reader: PackReader): Promise<OpenedPack> {
  const text = await reader.readText(PACK_MANIFEST_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PackError('The reference data pack manifest is not valid JSON');
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new PackError(
      `The reference data pack manifest is invalid: ${z.prettifyError(result.error)}`,
    );
  }
  const manifest = result.data;
  if (manifest.formatVersion !== PACK_FORMAT_VERSION) {
    throw new PackError(
      `Reference data pack format ${manifest.formatVersion} is not supported by this build (expects ${PACK_FORMAT_VERSION})`,
    );
  }
  if (manifest.pipelineVersion !== PIPELINE_VERSION) {
    throw new PackError(
      `Reference data pack was built by pipeline ${manifest.pipelineVersion}; this build uses pipeline ${PIPELINE_VERSION}`,
    );
  }
  return { manifest, manifestSha256: await sha256Text(text) };
}

/** Reads every dataset file, verifying each against the hash in the manifest. */
export async function readPackDatasets(
  reader: PackReader,
  manifest: PackManifest,
): Promise<PreparedDataset[]> {
  const prepared: PreparedDataset[] = [];
  for (const entry of manifest.datasets) {
    const text = await reader.readText(entry.file);
    const actual = await sha256Text(text);
    if (actual !== entry.sha256) {
      throw new PackError(
        `Reference data pack file ${entry.file} is corrupt: expected SHA-256 ${entry.sha256}, found ${actual}`,
      );
    }
    const file = datasetFileSchema.parse(JSON.parse(text));
    if (file.dataset !== entry.dataset || file.rows.length !== entry.rows) {
      throw new PackError(
        `Reference data pack file ${entry.file} does not match its manifest entry`,
      );
    }
    const rows = file.rows.map((values) => {
      const row: Record<string, unknown> = {};
      file.columns.forEach((column, index) => {
        row[column] = values[index] ?? null;
      });
      return row as { sourceKey: string };
    });
    prepared.push({
      table: entry.table,
      data: {
        dataset: file.dataset,
        sourceId: file.sourceId,
        raw: entry.raw,
        rowsRead: file.rowsRead,
        rowsSkipped: file.rowsSkipped,
        rows,
        issues: file.issues,
      },
    });
  }
  return prepared;
}

export type InstalledPack = typeof schema.refPackInstall.$inferSelect;

/** The pack the reference tables currently reflect, or `null` if none was ever installed. */
export async function installedPack(db: AegisDb): Promise<InstalledPack | null> {
  const rows = await db
    .select()
    .from(schema.refPackInstall)
    .orderBy(desc(schema.refPackInstall.id))
    .limit(1);
  return rows[0] ?? null;
}

export type PackInstallResult =
  | { readonly status: 'already_installed'; readonly manifestSha256: string }
  | {
      readonly status: 'installed';
      readonly manifestSha256: string;
      readonly reports: JobReport[];
    }
  | {
      readonly status: 'failed';
      readonly manifestSha256: string;
      readonly reports: JobReport[];
      readonly error: string;
    };

/**
 * Brings the reference tables in line with a pack.
 *
 * 1. If this exact pack (by manifest hash) is already installed, nothing happens.
 * 2. Every file is read and hash-checked before anything is written.
 * 3. Datasets are loaded in order, each in its own transaction, through the normal loader.
 * 4. Only when all have succeeded is the pack recorded as installed.
 *
 * If the process stops part-way, the pack is not recorded, so the next launch runs the install
 * again. Loads are idempotent: datasets already written are simply found unchanged.
 */
export async function installPack(
  db: AegisDb,
  reader: PackReader,
  options: LoadReferenceOptions,
): Promise<PackInstallResult> {
  const { manifest, manifestSha256 } = await openPack(reader);
  const current = await installedPack(db);
  if (current?.manifestSha256 === manifestSha256) {
    return { status: 'already_installed', manifestSha256 };
  }

  const prepared = await readPackDatasets(reader, manifest);
  const reports = await loadReferenceData(db, prepared, options);
  const failed = reports.find((report) => report.status !== 'succeeded');
  if (failed || reports.length !== prepared.length) {
    return {
      status: 'failed',
      manifestSha256,
      reports,
      error: failed?.error ?? 'The install stopped before every dataset was loaded',
    };
  }

  await db.insert(schema.refPackInstall).values({
    manifestSha256,
    formatVersion: manifest.formatVersion,
    pipelineVersion: manifest.pipelineVersion,
    datasetCount: manifest.datasets.length,
    rowCount: manifest.datasets.reduce((total, entry) => total + entry.rows, 0),
    installedWallMs: options.now(),
  });
  return { status: 'installed', manifestSha256, reports };
}

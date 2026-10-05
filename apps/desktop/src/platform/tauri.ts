import type { SqlResult, SqlTransport } from '@aegis/db';
import { invoke, isTauri } from '@tauri-apps/api/core';

/** True when running inside the desktop shell, false in a plain browser tab. */
export const isDesktop = isTauri;

/** The native core rejects with `{ code, message }`; turn that into a normal Error. */
function toError(reason: unknown): Error {
  if (typeof reason === 'object' && reason !== null && 'message' in reason) {
    if (typeof reason.message === 'string') return new Error(reason.message);
  }
  return new Error(
    typeof reason === 'string' ? reason : 'The native core returned an unknown error',
  );
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (reason) {
    throw toError(reason);
  }
}

/** SQL transport backed by the Rust-owned SQLite connection (ADR 0003). */
export const tauriTransport: SqlTransport = {
  query: (statement) => call<SqlResult>('db_query', { statement }),
  batch: (statements) => call<SqlResult[]>('db_batch', { statements }),
};

export interface AppInfo {
  readonly version: string;
  readonly databasePath: string | null;
  readonly schemaMigrations: number;
  readonly sqliteVersion: string;
  readonly encryption: string;
  readonly sessionUnlocked: boolean;
}

export function fetchAppInfo(): Promise<AppInfo> {
  return call<AppInfo>('app_info');
}

export interface ExportResult {
  /** The name the file was written under, which differs from the one asked for if that existed. */
  readonly fileName: string;
  readonly path: string;
  readonly bytes: number;
}

/** Writes text to the application's exports folder (ADR 0025). The native side picks the folder. */
export function writeExport(fileName: string, contents: string): Promise<ExportResult> {
  return call<ExportResult>('export_report', { fileName, contents });
}

import { NO_FILTER, type ReportFilter, type ReportTableName } from '@aegis/domain';
import type { TableSort } from '@aegis/ui';
import { create } from 'zustand';
import type { ExportResult } from '../platform/tauri';
import type { PeriodChoice } from '../reports/report-logic';

/*
 * UI state of the Reports area: which period is chosen, how its lists are narrowed and ordered.
 * It holds no report. A report is read from the database when it is shown (ADR 0024).
 */

export type ExportState =
  | { readonly status: 'idle' }
  | { readonly status: 'writing' }
  | { readonly status: 'written'; readonly result: ExportResult }
  | { readonly status: 'failed'; readonly error: string };

interface ReportState {
  readonly choice: PeriodChoice;
  readonly filter: ReportFilter;
  /** The order of each section's table; absent means the report's own order. */
  readonly sort: Readonly<Partial<Record<ReportTableName, TableSort>>>;
  readonly exported: ExportState;
}

export const useReportStore = create<ReportState>(() => ({
  choice: { kind: 'last24h', from: '', to: '' },
  filter: NO_FILTER,
  sort: {},
  exported: { status: 'idle' },
}));

export function setPeriodChoice(choice: Partial<PeriodChoice>): void {
  useReportStore.setState((state) => ({ choice: { ...state.choice, ...choice } }));
}

export function setReportFilter(filter: Partial<ReportFilter>): void {
  useReportStore.setState((state) => ({ filter: { ...state.filter, ...filter } }));
}

export function clearReportFilter(): void {
  useReportStore.setState({ filter: NO_FILTER });
}

export function setReportSort(section: ReportTableName, sort: TableSort): void {
  useReportStore.setState((state) => ({ sort: { ...state.sort, [section]: sort } }));
}

export function setExportState(exported: ExportState): void {
  useReportStore.setState({ exported });
}

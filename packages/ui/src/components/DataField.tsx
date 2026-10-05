import type { ReactNode } from 'react';
import { cn } from './cn';

export interface DataListProps {
  readonly columns?: 1 | 2 | 3 | 4;
  readonly children: ReactNode;
}

const COLUMNS = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  3: 'grid-cols-3',
  4: 'grid-cols-4',
} as const;

/** Grid of labelled values. Children should be {@link DataField}s. */
export function DataList({ columns = 2, children }: DataListProps) {
  return <dl className={cn('grid gap-x-6 gap-y-3', COLUMNS[columns])}>{children}</dl>;
}

export interface DataFieldProps {
  readonly label: string;
  /** `null` renders the standard "no value" placeholder. */
  readonly value: ReactNode | null;
  readonly unit?: string;
  /** Explains what the value means or how it is derived; shown on hover. */
  readonly hint?: string;
  /** Set for prose values; telemetry and identifiers use the default monospaced style. */
  readonly prose?: boolean;
}

/** One labelled value. Values are selectable so they can be copied. */
export function DataField({ label, value, unit, hint, prose = false }: DataFieldProps) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" title={hint}>
      <dt className="text-2xs tracking-label text-ink-muted uppercase">{label}</dt>
      <dd
        className={cn(
          'cursor-text truncate text-base select-text',
          value === null ? 'text-ink-disabled' : 'text-ink',
          !prose && 'telemetry',
        )}
      >
        {value ?? '—'}
        {unit && value !== null && <span className="ml-1 text-xs text-ink-muted">{unit}</span>}
      </dd>
    </div>
  );
}

export interface StatTileProps {
  readonly label: string;
  /** `null` renders the standard "no value" placeholder. */
  readonly value: string | null;
  readonly unit?: string;
  /** A second line: what the figure is compared with, or what it is made of. */
  readonly detail?: string;
  /** Explains what the value means or how it is derived; shown on hover. */
  readonly hint?: string;
}

/** One headline figure with its unit and a line of context. */
export function StatTile({ label, value, unit, detail, hint }: StatTileProps) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" title={hint}>
      <dt className="text-2xs tracking-label text-ink-muted uppercase">{label}</dt>
      <dd
        className={cn(
          'telemetry cursor-text text-xl leading-tight whitespace-nowrap select-text',
          value === null ? 'text-ink-disabled' : 'text-ink',
        )}
      >
        {value ?? '—'}
        {unit && value !== null && <span className="ml-1 text-xs text-ink-muted">{unit}</span>}
      </dd>
      {detail && <dd className="text-2xs text-ink-muted">{detail}</dd>}
    </div>
  );
}

import { ChevronDown, ChevronRight, ChevronUp, X, type LucideIcon } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { cn } from './cn';
import { IconButton } from './controls';
import { Icon } from './Icon';

export interface FloatingPanelProps {
  readonly className?: string | undefined;
  readonly children: ReactNode;
}

/** A surface that floats above another, such as a tool panel over the map. */
export function FloatingPanel({ className, children }: FloatingPanelProps) {
  return (
    <div
      className={cn('rounded-lg border border-line-strong bg-surface shadow-overlay', className)}
    >
      {children}
    </div>
  );
}

export interface SectionLabelProps {
  readonly children: ReactNode;
  readonly className?: string | undefined;
}

/** Heading for a group inside a panel. */
export function SectionLabel({ children, className }: SectionLabelProps) {
  return (
    <h3 className={cn('text-2xs font-semibold tracking-label text-ink-muted uppercase', className)}>
      {children}
    </h3>
  );
}

/** Scrolling list region beneath a panel's header controls, such as search results. */
export function ResultList({ children }: { readonly children: ReactNode }) {
  return (
    <div className="max-h-80 overflow-y-auto border-t border-line-subtle py-1">{children}</div>
  );
}

/** Secondary explanatory text. */
export function Hint({ children }: { readonly children: ReactNode }) {
  return <p className="text-xs text-ink-muted">{children}</p>;
}

/**
 * One line of small technical readouts, such as the strip along the bottom of the map.
 * Children are {@link ReadoutItem}s.
 */
export function ReadoutStrip({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex h-7 items-center gap-4 rounded-md border border-line-strong bg-surface px-2.5 shadow-overlay">
      {children}
    </div>
  );
}

export interface ReadoutItemProps {
  readonly label: string;
  /** Fixed width in `ch`, so a changing value does not shift its neighbours. */
  readonly widthCh?: number;
  /**
   * Ref to the value element. High-frequency readouts (pointer position, zoom) write their text
   * through this instead of re-rendering.
   */
  readonly valueRef?: Ref<HTMLSpanElement>;
  readonly children?: ReactNode;
}

export function ReadoutItem({ label, widthCh, valueRef, children }: ReadoutItemProps) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-2xs tracking-label text-ink-muted uppercase">{label}</span>
      <span
        ref={valueRef}
        className="telemetry text-xs whitespace-pre text-ink-secondary"
        style={widthCh === undefined ? undefined : { minWidth: `${widthCh}ch` }}
      >
        {children}
      </span>
    </span>
  );
}

export interface ScaleRuleProps {
  /** Ref to the rule; its width in pixels is set by the owner as the map scale changes. */
  readonly ruleRef: Ref<HTMLSpanElement>;
  /** Ref to the distance label, written by the owner. */
  readonly labelRef: Ref<HTMLSpanElement>;
}

/** A distance scale: a rule of a set on-screen length and the ground distance it represents. */
export function ScaleRule({ ruleRef, labelRef }: ScaleRuleProps) {
  return (
    <span className="flex items-center gap-2">
      <span ref={ruleRef} className="h-1.5 shrink-0 border-x border-b border-ink-secondary" />
      <span ref={labelRef} className="telemetry text-xs whitespace-nowrap text-ink-secondary" />
    </span>
  );
}

export interface DetailPanelProps {
  /** Small line above the title saying what kind of thing is shown. */
  readonly kicker: string;
  readonly title: string;
  /** Status badges shown under the title. */
  readonly badges?: ReactNode;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/** Side panel describing the selected entity. Scrolls independently of what it sits beside. */
export function DetailPanel({ kicker, title, badges, onClose, children }: DetailPanelProps) {
  return (
    <aside className="flex h-full w-88 shrink-0 flex-col border-l border-line bg-surface">
      <header className="flex items-start justify-between gap-3 border-b border-line-subtle px-4 py-3">
        <div className="min-w-0">
          <p className="text-2xs tracking-label text-ink-muted uppercase">{kicker}</p>
          <h2 className="mt-0.5 cursor-text text-lg leading-tight font-medium text-ink select-text">
            {title}
          </h2>
          {badges && <div className="mt-2 flex flex-wrap gap-1.5">{badges}</div>}
        </div>
        <IconButton icon={X} label="Close details" onClick={onClose} />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 py-4">{children}</div>
    </aside>
  );
}

export interface BreadcrumbItem {
  readonly label: string;
  /** Omit for the current, non-navigable level. */
  readonly onSelect?: (() => void) | undefined;
}

/** Path from the widest containing level down to the current one. */
export function Breadcrumb({ items }: { readonly items: readonly BreadcrumbItem[] }) {
  return (
    <nav aria-label="Location hierarchy" className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
      {items.map((item, index) => (
        <span key={`${index}:${item.label}`} className="flex items-center gap-1">
          {index > 0 && <Icon icon={ChevronRight} size="sm" className="text-ink-disabled" />}
          {item.onSelect ? (
            <button
              type="button"
              onClick={item.onSelect}
              className="rounded-sm text-xs text-ink-secondary underline-offset-2 transition-colors hover:text-ink hover:underline"
            >
              {item.label}
            </button>
          ) : (
            <span className="text-xs text-ink">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export interface EmptyStateProps {
  readonly icon: LucideIcon;
  readonly title: string;
  /** What the user can do next. */
  readonly children?: ReactNode;
}

export function EmptyState({ icon, title, children }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <Icon icon={icon} size="lg" className="text-ink-disabled" />
      <p className="font-medium text-ink-secondary">{title}</p>
      {children && <p className="max-w-sm text-xs text-ink-muted">{children}</p>}
    </div>
  );
}

export interface ListRowProps {
  readonly icon?: LucideIcon;
  readonly primary: string;
  readonly secondary?: string | undefined;
  /** Short identifier shown at the right in the telemetry face. */
  readonly code?: string | undefined;
  readonly active?: boolean;
  readonly onSelect: () => void;
}

/** One selectable line in a result list. */
export function ListRow({
  icon,
  primary,
  secondary,
  code,
  active = false,
  onSelect,
}: ListRowProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex h-9 w-full items-center gap-2.5 px-2.5 text-left transition-colors',
        active ? 'bg-surface-hover' : 'hover:bg-surface-raised',
      )}
    >
      {icon && <Icon icon={icon} size="sm" className="shrink-0 text-ink-muted" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-ink">{primary}</span>
        {secondary && <span className="block truncate text-2xs text-ink-muted">{secondary}</span>}
      </span>
      {code && <span className="telemetry shrink-0 text-2xs text-ink-secondary">{code}</span>}
    </button>
  );
}

export interface DataTableColumn<Row> {
  readonly header: string;
  readonly cell: (row: Row) => ReactNode;
  readonly align?: 'left' | 'right';
  /** Render values in the telemetry face. */
  readonly numeric?: boolean;
  /** Names the order this column sorts by. A column without one cannot be sorted. */
  readonly sortKey?: string;
}

export interface TableSort {
  readonly key: string;
  readonly descending: boolean;
}

export interface DataTableProps<Row> {
  readonly columns: readonly DataTableColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly caption: string;
  /** The order the rows are already in. The table shows it; the caller does the sorting. */
  readonly sort?: TableSort;
  readonly onSort?: (key: string) => void;
}

/** Compact read-only table for short lists. Long lists need the virtualised table (not built yet). */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  sort,
  onSort,
}: DataTableProps<Row>) {
  return (
    <table className="w-full border-collapse text-xs">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b border-line">
          {columns.map((column) => (
            <th
              key={column.header}
              scope="col"
              aria-sort={
                column.sortKey !== undefined && sort?.key === column.sortKey
                  ? sort.descending
                    ? 'descending'
                    : 'ascending'
                  : undefined
              }
              className={cn(
                'h-7 px-2 text-2xs font-semibold tracking-label whitespace-nowrap text-ink-muted uppercase',
                column.align === 'right' ? 'text-right' : 'text-left',
              )}
            >
              {column.sortKey !== undefined && onSort ? (
                <button
                  type="button"
                  className={cn(
                    'inline-flex items-center gap-1 tracking-label uppercase hover:text-ink',
                    sort?.key === column.sortKey && 'text-ink',
                  )}
                  onClick={() => {
                    onSort(column.sortKey as string);
                  }}
                >
                  {column.header}
                  {sort?.key === column.sortKey && (
                    <Icon icon={sort.descending ? ChevronDown : ChevronUp} size="sm" />
                  )}
                </button>
              ) : (
                column.header
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)} className="border-b border-line-subtle last:border-b-0">
            {columns.map((column) => (
              <td
                key={column.header}
                className={cn(
                  'h-7 cursor-text px-2 text-ink select-text',
                  column.align === 'right' ? 'text-right' : 'text-left',
                  // A reading is one thing: it never breaks across lines.
                  column.numeric && 'telemetry whitespace-nowrap',
                )}
              >
                {column.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

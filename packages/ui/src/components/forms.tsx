import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { cn } from './cn';
import { Icon } from './Icon';

const FIELD =
  'h-8 w-full rounded-md border border-line-strong bg-surface-raised px-2 text-sm text-ink outline-none transition-colors focus:border-focus disabled:cursor-not-allowed disabled:text-ink-disabled';

interface FieldFrameProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly children: ReactNode;
}

function FieldFrame({ id, label, hint, children }: FieldFrameProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1" title={hint}>
      <label htmlFor={id} className="text-2xs tracking-label text-ink-muted uppercase">
        {label}
      </label>
      {children}
    </div>
  );
}

export interface NumberFieldProps {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly hint?: string;
  readonly disabled?: boolean;
}

/** A labelled number with its unit. Reports every valid number typed; ignores anything else. */
export function NumberField({
  label,
  value,
  onChange,
  unit,
  min,
  max,
  step,
  hint,
  disabled = false,
}: NumberFieldProps) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint}>
      <div className="relative">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          className={cn(FIELD, 'telemetry cursor-text select-text', unit && 'pr-12')}
          value={Number.isFinite(value) ? value : ''}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.valueAsNumber;
            if (Number.isFinite(next)) onChange(next);
          }}
        />
        {unit && (
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-xs text-ink-muted">
            {unit}
          </span>
        )}
      </div>
    </FieldFrame>
  );
}

export interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly hint?: string;
}

/** A labelled single line of text. */
export function TextField({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  hint,
}: TextFieldProps) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint}>
      <input
        id={id}
        type="text"
        className={cn(FIELD, 'cursor-text select-text')}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </FieldFrame>
  );
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectFieldProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  /** Shown as the first, unselectable entry when nothing is chosen. */
  readonly placeholder?: string;
  readonly hint?: string;
}

/** A labelled choice from a list. */
export function SelectField({
  label,
  value,
  options,
  onChange,
  placeholder,
  hint,
}: SelectFieldProps) {
  const id = useId();
  return (
    <FieldFrame id={id} label={label} hint={hint}>
      <select
        id={id}
        className={FIELD}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldFrame>
  );
}

const METER_TONE = {
  ok: 'bg-ok',
  info: 'bg-info',
  warn: 'bg-warn',
  critical: 'bg-critical',
} as const;

export interface MeterProps {
  readonly label: string;
  /** Fraction within [0, 1]. */
  readonly value: number;
  /** The reading in words, shown at the right: "4,200 of 6,250 kg". */
  readonly reading: string;
  /** Semantic state of the quantity. Choose from meaning: low fuel is a warning, not a colour. */
  readonly tone?: keyof typeof METER_TONE;
}

/** A quantity against its capacity. A thin bar, not a gauge. */
export function Meter({ label, value, reading, tone = 'info' }: MeterProps) {
  const fraction = Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), 1);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-2xs tracking-label text-ink-muted uppercase">{label}</span>
        <span className="telemetry cursor-text text-xs text-ink select-text">{reading}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuetext={reading}
        className="h-1.5 w-full overflow-hidden rounded-sm bg-surface-hover"
      >
        <div
          // Eased between readings, so that a quantity that moves is seen to move.
          className={cn(
            'h-full origin-left transition-transform duration-300 ease-linear motion-reduce:transition-none',
            METER_TONE[tone],
          )}
          style={{ transform: `scaleX(${fraction})` }}
        />
      </div>
    </div>
  );
}

const SEVERITY = {
  block: { icon: CircleAlert, mark: 'text-critical', word: 'Cannot fly' },
  warning: { icon: TriangleAlert, mark: 'text-warn', word: 'Warning' },
  note: { icon: Info, mark: 'text-info', word: 'Note' },
} as const;

export interface ConstraintItem {
  readonly severity: keyof typeof SEVERITY;
  readonly code: string;
  readonly message: string;
}

/** Findings about a plan, most severe first. Each says in words how serious it is. */
export function ConstraintList({ items }: { readonly items: readonly ConstraintItem[] }) {
  const order = { block: 0, warning: 1, note: 2 } as const;
  const sorted = [...items].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <ul className="flex flex-col gap-1.5">
      {sorted.map((item) => {
        const style = SEVERITY[item.severity];
        return (
          <li
            key={`${item.code}:${item.message}`}
            className="flex gap-2 text-xs text-ink-secondary"
          >
            <Icon icon={style.icon} size="sm" className={cn('mt-0.5 shrink-0', style.mark)} />
            <span className="cursor-text select-text">
              <span className={cn('font-semibold', style.mark)}>{style.word}.</span> {item.message}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export interface PageHeaderProps {
  /** Small line above the title saying what kind of thing this is. */
  readonly kicker: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly badges?: ReactNode;
  readonly actions?: ReactNode;
}

/** Heading of a detail view: identity at the left, actions at the right. */
export function PageHeader({ kicker, title, subtitle, badges, actions }: PageHeaderProps) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-2xs tracking-label text-ink-muted uppercase">{kicker}</p>
        <h2 className="telemetry mt-0.5 cursor-text text-2xl leading-tight font-medium text-ink select-text">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-0.5 cursor-text text-base text-ink-secondary select-text">{subtitle}</p>
        )}
        {badges && <div className="mt-2 flex flex-wrap gap-1.5">{badges}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap justify-end gap-2">{actions}</div>}
    </header>
  );
}

export interface ListPaneProps {
  readonly title: string;
  /** Control at the right of the heading, such as an "add" button. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
}

/** The list half of a list-and-detail screen. Scrolls independently. */
export function ListPane({ title, action, children }: ListPaneProps) {
  return (
    <aside className="flex h-full w-80 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-line-subtle px-3">
        <h2 className="text-2xs font-semibold tracking-label text-ink-muted uppercase">{title}</h2>
        {action}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">{children}</div>
    </aside>
  );
}

export interface EntityRowProps {
  /** Identifier, in the telemetry face. */
  readonly code: string;
  readonly primary: string;
  readonly secondary?: string;
  readonly badge?: ReactNode;
  readonly active?: boolean;
  readonly onSelect: () => void;
}

/** One entity in a {@link ListPane}: identifier and state on the first line, detail below. */
export function EntityRow({
  code,
  primary,
  secondary,
  badge,
  active = false,
  onSelect,
}: EntityRowProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'relative flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors',
        active ? 'bg-surface-hover' : 'hover:bg-surface-raised',
      )}
    >
      {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />}
      <span className="flex items-center justify-between gap-2">
        <span className="telemetry text-sm font-medium text-ink">{code}</span>
        {badge}
      </span>
      <span className="truncate text-xs text-ink-secondary">{primary}</span>
      {secondary && <span className="truncate text-2xs text-ink-muted">{secondary}</span>}
    </button>
  );
}

import type { LucideIcon } from 'lucide-react';
import { Search, X } from 'lucide-react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { cn } from './cn';
import { Icon } from './Icon';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly icon: LucideIcon;
  /** Required: an icon-only button has no visible text, so this is its accessible name. */
  readonly label: string;
}

/** Square button showing only an icon. */
export function IconButton({ icon, label, className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-transparent text-ink-secondary transition-colors',
        'enabled:hover:bg-surface-hover enabled:hover:text-ink',
        'disabled:cursor-not-allowed disabled:text-ink-disabled',
        className,
      )}
      {...rest}
    >
      <Icon icon={icon} />
    </button>
  );
}

export interface SwitchRowProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  /** Small text at the right, for example a count. */
  readonly detail?: string;
  readonly disabled?: boolean;
}

/** A labelled on/off setting on one line. The whole row is the control. */
export function SwitchRow({ label, checked, onChange, detail, disabled = false }: SwitchRowProps) {
  return (
    <label
      className={cn(
        'flex h-7 items-center gap-2.5 rounded-sm px-1.5 text-xs transition-colors',
        disabled ? 'cursor-not-allowed text-ink-disabled' : 'text-ink-secondary hover:text-ink',
      )}
    >
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span
        aria-hidden
        className={cn(
          'relative h-3.5 w-6 shrink-0 rounded-sm border transition-colors',
          'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-focus',
          checked ? 'border-accent bg-accent-surface' : 'border-line-strong bg-surface-raised',
        )}
      >
        <span
          className={cn(
            'absolute top-px size-2.5 rounded-sm transition-transform',
            checked ? 'translate-x-2.5 bg-accent-strong' : 'translate-x-px bg-ink-muted',
          )}
        />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && <span className="telemetry text-2xs text-ink-muted">{detail}</span>}
    </label>
  );
}

export interface SearchFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'value' | 'type'
> {
  /** Accessible name; the field has no visible label. */
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}

export function SearchField({ label, value, onChange, className, ...rest }: SearchFieldProps) {
  return (
    <div
      className={cn(
        'flex h-8 items-center gap-2 rounded-md border border-line-strong bg-surface-raised px-2 text-ink-muted',
        'focus-within:border-focus',
        className,
      )}
    >
      <Icon icon={Search} size="sm" className="shrink-0" />
      <input
        type="text"
        aria-label={label}
        value={value}
        spellCheck={false}
        autoComplete="off"
        className="min-w-0 flex-1 cursor-text bg-transparent text-sm text-ink outline-none select-text placeholder:text-ink-muted"
        onChange={(event) => {
          onChange(event.target.value);
        }}
        {...rest}
      />
      {value.length > 0 && (
        <button
          type="button"
          aria-label="Clear search"
          className="shrink-0 rounded-sm text-ink-muted transition-colors hover:text-ink"
          onClick={() => {
            onChange('');
          }}
        >
          <Icon icon={X} size="sm" />
        </button>
      )}
    </div>
  );
}

export interface ProgressBarProps {
  readonly label: string;
  /** Completed fraction within [0, 1]. */
  readonly value: number;
}

export function ProgressBar({ label, value }: ProgressBarProps) {
  const percent = Math.round(Math.min(Math.max(value, 0), 1) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1 w-full overflow-hidden rounded-sm bg-surface-hover"
    >
      <div
        className="h-full origin-left bg-accent transition-transform motion-medium"
        style={{ transform: `scaleX(${percent / 100})` }}
      />
    </div>
  );
}

export interface TextLinkProps {
  readonly onSelect: () => void;
  /** Identifiers are shown in the telemetry face. */
  readonly code?: boolean;
  readonly children: ReactNode;
}

/** A reference to another record, inside text or a table cell. Opens that record. */
export function TextLink({ onSelect, code = false, children }: TextLinkProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'rounded-sm text-accent-strong underline-offset-2 hover:underline',
        code && 'telemetry whitespace-nowrap',
      )}
    >
      {children}
    </button>
  );
}

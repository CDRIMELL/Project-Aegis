import * as ToggleGroup from '@radix-ui/react-toggle-group';

export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: string;
}

export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group. */
  readonly label: string;
  readonly value: T;
  readonly options: readonly SegmentedOption<T>[];
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
}

/** Mutually exclusive choice among a few short options. Arrow keys move between segments. */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      aria-label={label}
      value={value}
      disabled={disabled}
      // Radix reports '' when the active segment is pressed again; one option must stay selected.
      onValueChange={(next) => {
        if (next !== '') onChange(next as T);
      }}
      className="inline-flex h-7 shrink-0 items-stretch rounded-md border border-line-strong bg-surface-raised p-px"
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          className="telemetry min-w-9 rounded-sm px-2 text-xs text-ink-secondary transition-colors enabled:hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled data-[state=on]:bg-accent-surface data-[state=on]:text-accent-strong"
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

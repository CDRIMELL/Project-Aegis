export interface TimeReadoutProps {
  readonly label: string;
  /** `YYYY-MM-DD`, or `null` while unknown. */
  readonly date: string | null;
  /** `HH:MM:SS`, or `null` while unknown. */
  readonly time: string | null;
  readonly zone: string;
  readonly hint?: string;
}

/** Date and time on one line, with the time emphasised. Width is stable while values change. */
export function TimeReadout({ label, date, time, zone, hint }: TimeReadoutProps) {
  return (
    <div className="flex items-baseline gap-2" title={hint}>
      <span className="text-2xs tracking-label text-ink-muted uppercase">{label}</span>
      <span className="telemetry text-base text-ink-secondary">{date ?? '----------'}</span>
      <span className="telemetry text-lg font-medium text-ink">{time ?? '--:--:--'}</span>
      <span className="text-2xs tracking-label text-ink-muted uppercase">{zone}</span>
    </div>
  );
}

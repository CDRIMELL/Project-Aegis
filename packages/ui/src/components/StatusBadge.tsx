import type { ReactNode } from 'react';
import { cn } from './cn';

const TONE = {
  ok: 'bg-ok-surface text-ok',
  info: 'bg-info-surface text-info',
  warn: 'bg-warn-surface text-warn',
  critical: 'bg-critical-surface text-critical',
  neutral: 'bg-surface-hover text-ink-secondary',
} as const;

export type StatusTone = keyof typeof TONE;

export interface StatusBadgeProps {
  readonly tone: StatusTone;
  readonly children: ReactNode;
}

/** Compact state label. The tone is semantic: choose it from meaning, never for looks. */
export function StatusBadge({ tone, children }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-2xs font-semibold tracking-label whitespace-nowrap uppercase',
        TONE[tone],
      )}
    >
      <span className="size-1.5 rounded-sm bg-current" aria-hidden />
      {children}
    </span>
  );
}

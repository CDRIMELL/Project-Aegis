import { CircleAlert, Info, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';
import { Icon } from './Icon';

const TONE = {
  info: { frame: 'border-info-surface bg-info-surface', mark: 'text-info', icon: Info },
  warn: { frame: 'border-warn-surface bg-warn-surface', mark: 'text-warn', icon: TriangleAlert },
  critical: {
    frame: 'border-critical-surface bg-critical-surface',
    mark: 'text-critical',
    icon: CircleAlert,
  },
} as const;

export interface NoticeProps {
  readonly tone: keyof typeof TONE;
  readonly title: string;
  /** What happened and what the user can do next. */
  readonly children?: ReactNode;
}

/** Inline message for a condition the user should know about. */
export function Notice({ tone, title, children }: NoticeProps) {
  const style = TONE[tone];
  return (
    <div
      role={tone === 'critical' ? 'alert' : 'status'}
      className={cn('flex gap-2.5 rounded-lg border px-3 py-2.5', style.frame)}
    >
      <Icon icon={style.icon} className={cn('mt-0.5 shrink-0', style.mark)} />
      <div className="min-w-0">
        <p className="font-medium text-ink">{title}</p>
        {children && <div className="mt-0.5 text-ink-secondary select-text">{children}</div>}
      </div>
    </div>
  );
}

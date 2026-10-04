import type { ReactNode } from 'react';
import { cn } from './cn';

export interface PanelProps {
  readonly title: string;
  /** Controls or status shown at the right of the panel header. */
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}

/** The standard titled container for a group of related information. */
export function Panel({ title, actions, className, children }: PanelProps) {
  return (
    <section className={cn('flex flex-col rounded-lg border border-line bg-surface', className)}>
      <header className="flex h-9 shrink-0 items-center justify-between gap-3 border-b border-line-subtle px-3">
        <h2 className="text-2xs font-semibold tracking-label text-ink-muted uppercase">{title}</h2>
        {actions}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

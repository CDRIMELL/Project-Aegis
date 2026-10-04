import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';
import { Icon } from './Icon';

export interface AppFrameProps {
  /** Contents of the navigation rail: usually {@link NavItem}s. */
  readonly navigation: ReactNode;
  /** Small print at the foot of the rail, such as the build version. */
  readonly railFooter?: ReactNode;
  /** Title of the area currently shown. */
  readonly title: string;
  /** Persistent controls at the right of the top bar. */
  readonly topBar?: ReactNode;
  /**
   * Let the content fill the region edge to edge and manage its own scrolling. For full-surface
   * screens such as the map; ordinary screens keep the standard padding.
   */
  readonly bleed?: boolean;
  readonly children: ReactNode;
}

/** The application shell: navigation rail, top bar and the content region. */
export function AppFrame({
  navigation,
  railFooter,
  title,
  topBar,
  bleed = false,
  children,
}: AppFrameProps) {
  return (
    <div className="grid h-screen grid-cols-[13rem_minmax(0,1fr)] grid-rows-[3rem_minmax(0,1fr)] bg-canvas">
      <div className="flex items-center border-r border-b border-line bg-surface px-4">
        <Wordmark />
      </div>
      <header className="flex items-center justify-between gap-4 border-b border-line bg-surface px-4">
        <h1 className="text-xs font-semibold tracking-label text-ink-secondary uppercase">
          {title}
        </h1>
        {topBar}
      </header>
      <aside className="flex min-h-0 flex-col border-r border-line bg-surface">
        <nav
          aria-label="Primary"
          className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto py-2"
        >
          {navigation}
        </nav>
        {railFooter && (
          <div className="border-t border-line-subtle px-4 py-2 text-2xs text-ink-muted">
            {railFooter}
          </div>
        )}
      </aside>
      <main className={cn('relative min-h-0', bleed ? 'overflow-hidden' : 'overflow-y-auto p-4')}>
        {children}
      </main>
    </div>
  );
}

/** The AEGIS mark and name. */
export function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 16 16" className="size-4 text-accent" aria-hidden>
        <path d="M8 1.5 13.5 14 8 11.1 2.5 14Z" fill="currentColor" />
      </svg>
      <span className="text-base font-semibold tracking-wordmark text-ink">AEGIS</span>
    </div>
  );
}

export interface NavItemProps {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly active?: boolean;
  /** When set, the item is unavailable and this text explains why. */
  readonly unavailableReason?: string;
  readonly onSelect?: () => void;
}

export function NavItem({
  icon,
  label,
  active = false,
  unavailableReason,
  onSelect,
}: NavItemProps) {
  const unavailable = unavailableReason !== undefined;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={unavailable}
      title={unavailableReason}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex h-8 items-center gap-2.5 px-4 text-left text-xs font-medium tracking-label uppercase transition-colors',
        active
          ? 'bg-surface-hover text-ink'
          : 'text-ink-secondary enabled:hover:bg-surface-raised enabled:hover:text-ink',
        'disabled:cursor-not-allowed disabled:text-ink-disabled',
      )}
    >
      {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden />}
      <Icon icon={icon} className={active ? 'text-accent' : undefined} />
      {label}
    </button>
  );
}

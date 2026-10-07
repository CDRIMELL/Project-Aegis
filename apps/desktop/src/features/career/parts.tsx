import { StatusBadge, Wordmark, type StatusTone } from '@aegis/ui';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { BriefItem, BriefTone } from '../../career/brief-logic';

/*
 * Shared pieces of the front of the application (ADR 0031): the frame the menu, the
 * introduction, the briefing and the summary are shown in, and the lists a briefing is made of.
 * They use the same tokens as every other screen; nothing here has a colour of its own.
 */

/** The frame of every screen shown outside command: the mark, the content, and what it is. */
export function FrontFrame({
  children,
  wide = false,
}: {
  readonly children: ReactNode;
  /** A briefing or a summary, which is laid out in columns. */
  readonly wide?: boolean;
}) {
  return (
    <div className="flex h-screen flex-col bg-canvas text-ink">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line bg-surface px-6">
        <Wordmark />
        <span className="text-2xs tracking-label text-ink-muted uppercase">
          Aerospace operations and simulation platform
        </span>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={`mx-auto flex min-h-full flex-col justify-center px-6 py-10 ${wide ? 'max-w-5xl' : 'max-w-xl'}`}
        >
          {children}
        </div>
      </main>
      <footer className="flex h-8 shrink-0 items-center justify-between border-t border-line-subtle px-6 text-2xs text-ink-muted">
        <span>Build {__APP_VERSION__}</span>
        <span>
          A simulation. The operator, the fleet and everything that happens are fictional.
        </span>
      </footer>
    </div>
  );
}

/** The small label above a screen's title. */
export function Kicker({ children }: { readonly children: ReactNode }) {
  return <p className="text-2xs font-semibold tracking-label text-accent uppercase">{children}</p>;
}

/** The title of a front screen. */
export function FrontTitle({ children }: { readonly children: ReactNode }) {
  return <h1 className="mt-2 text-2xl leading-tight font-medium text-ink">{children}</h1>;
}

/** A paragraph of the introduction or the guide. */
export function Prose({ children }: { readonly children: ReactNode }) {
  return <p className="text-lg leading-relaxed text-ink-secondary">{children}</p>;
}

/** One entry of the main menu: what it is, and a line on what it does. */
export function MenuItem({
  label,
  detail,
  onSelect,
  disabled = false,
  primary = false,
}: {
  readonly label: string;
  readonly detail: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  /** The entry the player most likely wants. */
  readonly primary?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={`group flex w-full flex-col gap-0.5 border-l-2 px-4 py-3 text-left transition-colors enabled:hover:border-accent enabled:hover:bg-surface-hover disabled:cursor-not-allowed ${primary && !disabled ? 'border-accent bg-surface' : 'border-line'}`}
    >
      <span
        className={`text-lg font-semibold tracking-label uppercase ${disabled ? 'text-ink-disabled' : 'text-ink'}`}
      >
        {label}
      </span>
      <span className={`text-sm ${disabled ? 'text-ink-disabled' : 'text-ink-muted'}`}>
        {detail}
      </span>
    </button>
  );
}

const TONE: Readonly<Record<BriefTone, StatusTone>> = {
  critical: 'critical',
  warn: 'warn',
  info: 'info',
  neutral: 'neutral',
};
const TONE_WORD: Readonly<Record<BriefTone, string>> = {
  critical: 'Now',
  warn: 'Soon',
  info: 'Note',
  neutral: 'Note',
};

/**
 * A list of things a briefing draws attention to. Where the reader is in command, each opens
 * the thing itself; before command is taken there is nowhere to go, and they are read only.
 */
export function BriefItems({
  items,
  empty,
  linked = false,
}: {
  readonly items: readonly BriefItem[];
  /** What to say when there is nothing. */
  readonly empty: string;
  readonly linked?: boolean;
}) {
  const navigate = useNavigate();
  if (items.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;
  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item) => {
        const body = (
          <>
            <span className="mt-0.5">
              <StatusBadge tone={TONE[item.tone]}>{TONE_WORD[item.tone]}</StatusBadge>
            </span>
            <span className="min-w-0">
              <span className="block text-base text-ink">{item.title}</span>
              <span className="block text-sm text-ink-muted">{item.detail}</span>
            </span>
          </>
        );
        return (
          <li key={`${item.title}|${item.detail}`}>
            {linked && item.route ? (
              <button
                type="button"
                className="flex w-full items-start gap-2.5 rounded-md text-left transition-colors hover:bg-surface-hover"
                onClick={() => {
                  if (item.route) void navigate(item.route);
                }}
              >
                {body}
              </button>
            ) : (
              <div className="flex items-start gap-2.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

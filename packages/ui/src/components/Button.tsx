import type { LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from './cn';
import { Icon } from './Icon';

const VARIANT = {
  primary:
    'border-accent bg-accent text-ink-inverse enabled:hover:border-accent-strong enabled:hover:bg-accent-strong',
  secondary: 'border-line-strong bg-surface-raised text-ink enabled:hover:bg-surface-hover',
  ghost:
    'border-transparent bg-transparent text-ink-secondary enabled:hover:bg-surface-hover enabled:hover:text-ink',
} as const;

const SIZE = {
  sm: 'h-7 gap-1.5 px-2.5 text-xs',
  md: 'h-8 gap-2 px-3 text-sm',
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: keyof typeof VARIANT;
  readonly size?: keyof typeof SIZE;
  readonly icon?: LucideIcon;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md border font-medium whitespace-nowrap transition-colors',
        'disabled:cursor-not-allowed disabled:border-line disabled:bg-surface disabled:text-ink-disabled',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {icon && <Icon icon={icon} size="sm" />}
      {children}
    </button>
  );
}

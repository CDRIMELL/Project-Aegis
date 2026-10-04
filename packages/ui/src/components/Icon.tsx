import type { LucideIcon } from 'lucide-react';

const SIZE_PX = { sm: 14, md: 16, lg: 20 } as const;

export type IconSize = keyof typeof SIZE_PX;

export interface IconProps {
  readonly icon: LucideIcon;
  readonly size?: IconSize;
  readonly className?: string | undefined;
  /** Provide when the icon is the only content conveying meaning; otherwise it is decorative. */
  readonly label?: string;
}

/** The one way icons are rendered, so size and stroke stay consistent everywhere. */
export function Icon({ icon: Glyph, size = 'md', className, label }: IconProps) {
  return (
    <Glyph
      size={SIZE_PX[size]}
      strokeWidth={1.75}
      className={className}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    />
  );
}

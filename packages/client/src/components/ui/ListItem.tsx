import type { CSSProperties, ReactNode } from 'react';

type Variant = 'default' | 'selected' | 'interactive';

interface ListItemProps {
  as?: 'li' | 'div';
  variant?: Variant;
  leading?: ReactNode; // avatar / rank / swatch
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode; // tag + buttons
  delay?: number;
  className?: string;
  style?: CSSProperties;
}

const VARIANT: Record<Variant, string> = {
  default: 'border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01]',
  selected: 'border-gold bg-gradient-to-b from-gold/[.14] to-gold/[.04]',
  interactive:
    'border-white/10 bg-gradient-to-b from-white/[.04] to-white/[.01] hover:border-gold hover:translate-x-0.5 transition-all',
};

/** The universal list row shared by every list-style view. */
export function ListItem({
  as = 'li', variant = 'default', leading, title, subtitle, trailing, delay, className = '', style,
}: ListItemProps) {
  const Tag = as as 'li';
  return (
    <Tag
      className={`flex items-center gap-3 rounded-xl px-4 py-3 border ${VARIANT[variant]} animate-rise ${className}`}
      style={delay != null ? { animationDelay: `${delay}s`, ...style } : style}
    >
      {leading != null && <div className="shrink-0">{leading}</div>}
      <div className="min-w-0 flex-1">
        <div className="font-display font-semibold tracking-wide truncate">{title}</div>
        {subtitle != null && <div className="text-xs text-muted truncate">{subtitle}</div>}
      </div>
      {trailing != null && <div className="shrink-0 flex items-center gap-2">{trailing}</div>}
    </Tag>
  );
}

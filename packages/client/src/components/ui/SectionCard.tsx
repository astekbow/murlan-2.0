import type { ReactNode } from 'react';

interface SectionCardProps {
  title?: ReactNode;
  action?: ReactNode; // right-aligned button/link in the header row
  solid?: boolean; // panel-solid vs panel
  pad?: 'sm' | 'md' | 'lg';
  delay?: number; // stagger animationDelay (seconds)
  className?: string;
  children: ReactNode;
}

const PAD = { sm: 'p-4', md: 'p-5', lg: 'p-6' } as const;

/** A titled panel section with the standard rise-in stagger. */
export function SectionCard({ title, action, solid, pad = 'md', delay, className = '', children }: SectionCardProps) {
  return (
    <section
      className={`${solid ? 'panel-solid' : 'panel'} ${PAD[pad]} animate-rise ${className}`}
      style={delay != null ? { animationDelay: `${delay}s` } : undefined}
    >
      {(title || action) && (
        <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
          {title && <h2 className="font-display font-semibold tracking-wide text-gold-hi text-base">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

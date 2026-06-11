import type { CSSProperties, ReactNode } from 'react';

interface PageHeaderProps {
  eyebrow?: string;
  title: ReactNode;
  trailing?: ReactNode; // chip / emoji / balance on the right
  center?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** The standard page header used across every sub-view: an eyebrow + a gold
 *  fluid-sized title, with an optional trailing element. */
export function PageHeader({ eyebrow, title, trailing, center, className = '', style }: PageHeaderProps) {
  return (
    <section
      className={`panel p-5 animate-rise ${center ? 'text-center' : 'flex items-center justify-between gap-4'} ${className}`}
      style={style}
    >
      <div className={center ? '' : 'min-w-0'}>
        {eyebrow && <div className="font-serif text-fluid-2xs tracking-[0.4em] text-txt-lo mb-1 uppercase">{eyebrow}</div>}
        <h1 className="gold-text font-display font-bold text-fluid-2xl tracking-wide leading-none">{title}</h1>
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </section>
  );
}

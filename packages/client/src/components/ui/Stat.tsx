import type { ReactNode } from 'react';

interface StatProps {
  label: ReactNode;
  value: ReactNode;
  tone?: 'gold' | 'txt' | 'green' | 'red';
  align?: 'left' | 'right' | 'center';
  className?: string;
}

const TONE = { gold: 'text-gold-hi', txt: 'text-txt', green: 'text-emerald2', red: 'text-red-300' } as const;
const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

/** A label-over-value stat block (balance, volume, prize, etc.). */
export function Stat({ label, value, tone = 'gold', align = 'left', className = '' }: StatProps) {
  return (
    <div className={`${ALIGN[align]} ${className}`}>
      <div className="font-serif text-[10px] tracking-[0.2em] text-muted/80 uppercase">{label}</div>
      <div className={`font-display font-semibold tracking-wide ${TONE[tone]} text-lg leading-tight mt-0.5`}>{value}</div>
    </div>
  );
}

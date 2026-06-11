import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  message: ReactNode;
  hint?: ReactNode;
  tone?: 'muted' | 'error';
  size?: 'sm' | 'md' | 'lg';
  action?: ReactNode; // optional CTA (e.g. "Add a friend")
  className?: string;
}

const PY = { sm: 'py-6', md: 'py-8', lg: 'py-10' } as const;

/** Standard empty / error state: icon + message (+ hint + optional CTA). */
export function EmptyState({ icon, message, hint, tone = 'muted', size = 'md', action, className = '' }: EmptyStateProps) {
  return (
    <div className={`text-center ${PY[size]} ${className}`}>
      <div className="text-4xl mb-2 opacity-60">{icon ?? (tone === 'error' ? '⚠️' : '🃏')}</div>
      <p className={`text-sm ${tone === 'error' ? 'text-red-300' : 'text-muted'}`}>{message}</p>
      {hint && <p className="text-xs text-muted/70 mt-1">{hint}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}
